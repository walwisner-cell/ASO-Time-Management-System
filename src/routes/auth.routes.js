const express = require('express');
const { nanoid } = require('nanoid');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth, generateResetToken, hashResetToken } = require('../auth');
const { isValidEmail, isNonEmptyString, isValidPassword, isValidPhone, isValidPostalCode, isValidName, validate, postalCodeErrorMessage } = require('../validators');
const { notify } = require('../notify');
const { generateUniqueReferralCode } = require('../referral-code');
const { isValidStateForCountry, isPlausibleCityForCountry } = require('../geo-data');

const router = express.Router();

// The real public address of this app, for links inside emails. APP_URL
// wins when it's set; otherwise it's taken from the incoming request
// itself. Before this, an unset APP_URL produced a bare "/?resetToken=..."
// link in the password-reset email — a link with no website in it, which
// does nothing when clicked from an inbox.
function appBaseUrl(req) {
  const configured = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  if (req && typeof req.get === 'function' && req.get('host')) return `${req.protocol}://${req.get('host')}`;
  return 'https://trothenpro.com';
}

// Sent right when an account is created (regular and Google signup), next
// to the welcome email — asks for ID documents immediately instead of only
// through the 24-hour reminder. The link opens the real verification
// screen (?verify=1 is handled in initApp on the frontend).
async function sendVerificationInviteEmail(req, user) {
  try {
    const { sendEmail } = require('../delivery');
    const firstName = String(user.name || '').split(' ')[0] || 'there';
    const link = `${appBaseUrl(req)}/?verify=1`;
    const isPro = user.role === 'provider';
    const subject = isPro ? 'One last step to become a Trothen Pro' : 'Verify your identity on Trothen';
    const body = isPro
      ? `Hi ${firstName},\n\nBefore you can show up in customer searches, we need to verify your identity. It takes about two minutes: upload a clear photo of a government-issued ID and enter your full legal name.\n\nStart here: ${link}\n\nOur team reviews every submission, usually within 48 hours, and you'll get a notification the moment it's done.\n\n— The Trothen Team`
      : `Hi ${firstName},\n\nVerifying your identity helps keep everyone on Trothen safe, and it only takes about two minutes: upload a clear photo of a government-issued ID and enter your full legal name.\n\nStart here: ${link}\n\nOur team reviews every submission, usually within 48 hours.\n\n— The Trothen Team`;
    await sendEmail(user.email, subject, body);
  } catch (e) {
    // Never let a failed invite email break account creation itself.
    console.error('[auth] verification invite email failed:', e.message);
  }
}

// Rate limiting on every sensitive auth endpoint — this genuinely didn't
// exist anywhere in the app before. Without it, there was no limit at all
// on how many times someone could try a password against a known email
// (a real, practical brute-force path — unlike a randomly-generated,
// short-lived reset token, a person's password doesn't expire), or how
// many times a 6-digit OTP code could be guessed for signup/login
// verification or password reset. Keyed by IP, generous enough that a
// real person fumbling their password a few times never notices it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many signup attempts from this connection. Please try again in an hour.' },
});

// Same time-of-check-to-time-of-use pattern already fixed for payouts and
// organization seats: this endpoint checks the email is still free, then
// creates the account, with real time in between. Two people who both
// started signup with the same email (one might be retrying after a typo,
// or it's a genuine coincidence) could both complete verification at
// nearly the same moment and both pass the "still free" check before
// either had actually created their account. A per-email lock closes it
// the same way.
const signupVerifyLocks = new Set();

function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

// ── SIGNUP: real two-stage verification gate ────────────────────────────────
// Registration is no longer "submit a form, get an account instantly."
// Every new signup now requires proving both a real phone number AND a real
// email address before the account is actually created — two separate
// codes, two separate channels, both required. Same honest test-mode
// pattern as phone verification and password reset elsewhere: since no real
// SMS/email provider is connected yet, both codes are returned directly in
// the API response instead of being sent, clearly labeled as such. Wiring
// in real providers later means sending the codes instead of returning
// them — the verification gate itself doesn't change.
const REGISTRATION_TTL_MS = 15 * 60 * 1000; // 15 minutes to complete both codes

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// POST /api/auth/signup/start — validates everything and issues both codes,
// but does NOT create the account yet.
router.post('/signup/start', signupLimiter, async (req, res) => {
  const { name, email, password, role, country, state, city, phone, address, zipCode, category, skills, inviteCode, referralCode } = req.body || {};
  const errors = validate([
    ['name', isValidName(name), 'Enter a real name — letters, spaces, hyphens, and apostrophes only'],
    ['email', isValidEmail(email), 'Enter a valid email address'],
    ['password', isValidPassword(password), 'Choose a password of 8 to 72 characters that isn\'t a common one (like "password123")'],
    ['role', ['customer', 'provider'].includes(role), 'Role must be customer or provider — admin accounts are created by a super admin'],
    ['phone', isValidPhone(phone), 'Enter a valid phone number (7-15 digits)'],
    ['zipCode', isValidPostalCode(zipCode, country), postalCodeErrorMessage(country)],
    ['address', isNonEmptyString(address, { min: 3, max: 200 }), 'Enter a valid address'],
    ['country', isNonEmptyString(country, { min: 2, max: 100 }), 'Select your country'],
    ['state', isNonEmptyString(state, { min: 2, max: 100 }), 'Select your state/region'],
    ['city', isNonEmptyString(city, { min: 2, max: 100 }), 'Enter your city'],
    ['state', typeof country !== 'string' || typeof state !== 'string' || isValidStateForCountry(country.trim(), state.trim()), 'That state/region doesn\'t belong to the selected country — please re-select both'],
    ['city', typeof country !== 'string' || typeof city !== 'string' || isPlausibleCityForCountry(country.trim(), city.trim()), 'That city is a known city in a different country — please double check your country and city'],
  ]);
  if (role === 'provider') {
    errors.push(...validate([
      ['category', isNonEmptyString(category), 'Select your primary service category'],
      ['skills', isNonEmptyString(skills, { min: 2, max: 300 }), 'List at least one skill or specialty'],
    ]));
  }
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const existing = await db.find('users', u => u.email.toLowerCase() === email.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  // Org invite codes attach a brand-new provider to a Custom-plan
  // organization's seats. Validated up front so a bad code fails
  // immediately, rather than after the person's already gone through the
  // phone/email verification step.
  let inviteOrgId = null;
  const trimmedInviteCode = (inviteCode || '').trim().toUpperCase();
  if (trimmedInviteCode) {
    if (role !== 'provider') return res.status(400).json({ error: 'Organization invite links are for provider accounts' });
    const invite = await db.find('organizationInvites', i => i.code === trimmedInviteCode);
    if (!invite) return res.status(400).json({ error: 'This invite link is invalid' });
    if (invite.status !== 'active') return res.status(400).json({ error: 'This invite link has been revoked' });
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return res.status(400).json({ error: 'This invite link has expired' });
    if (invite.maxUses != null && invite.usesCount >= invite.maxUses) return res.status(400).json({ error: 'This invite link has reached its usage limit' });
    inviteOrgId = invite.organizationId;
  }

  // A referral link/code just credits whoever shared it — it doesn't gate
  // anything, unlike an org invite. A bad or missing code never blocks
  // signup; it just means no referral gets recorded. Self-referral (code
  // belongs to the email currently signing up — can't happen yet since
  // the account doesn't exist, but a code typed in manually could in
  // theory match an already-existing account with the same email) isn't
  // really reachable here, but a code matching no one at all is checked
  // now so the person gets an honest error immediately rather than the
  // referral silently not counting after they've already verified both
  // codes.
  let referrer = null;
  const trimmedReferralCode = (referralCode || '').trim().toUpperCase();
  if (trimmedReferralCode) {
    referrer = await db.find('users', u => u.referralCode === trimmedReferralCode);
    if (!referrer) return res.status(400).json({ error: 'This referral link isn\'t valid' });
  }

  const { isEmailConfigured, sendEmail } = require('../delivery');
  const emailCode = generateSixDigitCode();

  const pending = {
    id: `preg_${nanoid(12)}`,
    // v81: the password is hashed right here. It used to sit in this waiting
    // record as typed until the code was entered (and forever if it never was).
    payload: { name: name.trim(), email: email.trim(), passwordHash: hashPassword(password), role, country: country.trim(), state: state.trim(), city: city.trim(), phone: phone.trim(), address: address.trim(), zipCode: (zipCode || '').trim(), category, skills, inviteCode: trimmedInviteCode || null, referredByUserId: referrer ? referrer.id : null },
    emailCodeHash: hashResetToken(emailCode),
    phoneVerified: false,
    emailVerified: false,
    expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  };
  await db.insert('pendingRegistrations', pending);

  const emailDelivered = isEmailConfigured()
    ? (await sendEmail(email.trim(), 'Verify your Trothen email', `Your Trothen email verification code is ${emailCode}.`)).sent
    : false;

  if (emailDelivered) {
    return res.status(201).json({
      pendingId: pending.id,
      message: `Enter the code sent to ${email.trim()} to finish creating your account.`,
      testMode: false,
      joiningOrganization: inviteOrgId ? true : false,
    });
  }

  // Email IS set up but this one send failed: say so and stop. Showing the
  // code on screen here would let anyone "verify" an email address they
  // don't own — the whole point of the code. The on-screen fallback below
  // is only for a server that has no email provider connected at all.
  if (isEmailConfigured()) {
    await db.remove('pendingRegistrations', pending.id);
    return res.status(502).json({ error: "We couldn't send your code just now. Please wait a minute and try again." });
  }

  // No email provider connected at all — test-mode fallback so signup
  // still works while email is being set up.
  console.log(`[TEST MODE] Registration code for ${email.trim()}: ${emailCode}`);

  res.status(201).json({
    pendingId: pending.id,
    message: `Enter the code sent to ${email.trim()} to finish creating your account.`,
    testMode: true,
    testModeNote: 'No real email provider is configured yet — the code is returned directly instead of being sent. Do not do this in production.',
    emailCode,
    joiningOrganization: inviteOrgId ? true : false,
  });
});

// POST /api/auth/signup/verify — the email code must match before the
// account is actually created. Phone verification is not required to
// complete signup — see completeSignupVerify below for why.
router.post('/signup/verify', otpLimiter, async (req, res) => {
  const { pendingId, emailCode } = req.body || {};
  if (!isNonEmptyString(pendingId) || !isNonEmptyString(emailCode)) {
    return res.status(400).json({ error: 'pendingId and emailCode are required' });
  }
  const pending = await db.find('pendingRegistrations', p => p.id === pendingId);
  if (!pending) return res.status(400).json({ error: 'This registration has expired or was not found — please start again' });
  if (new Date(pending.expiresAt) < new Date()) {
    await db.remove('pendingRegistrations', pending.id);
    return res.status(400).json({ error: 'This registration has expired — please start again' });
  }

  // Locking on the email (not the pendingId) is what actually closes the
  // gap: two DIFFERENT pending registrations sharing the same email are
  // exactly the scenario that matters here, and they have different
  // pendingIds by definition.
  const emailKey = pending.payload.email.toLowerCase();
  if (signupVerifyLocks.has(emailKey)) {
    return res.status(409).json({ error: 'This email is already completing signup elsewhere — please wait a moment and try again.' });
  }
  signupVerifyLocks.add(emailKey);
  try {
    return await completeSignupVerify(req, res, pending);
  } finally {
    signupVerifyLocks.delete(emailKey);
  }
});

async function completeSignupVerify(req, res, pending) {
  const { emailCode } = req.body || {};
  // Phone verification is no longer required to complete signup — email is
  // the one channel that has to be confirmed here. A provider or customer
  // can still verify their phone later from Settings (see
  // /send-phone-otp and /verify-phone-otp below) once that's useful to
  // them, e.g. for 2FA.
  if (hashResetToken(emailCode.trim()) !== pending.emailCodeHash) {
    return res.status(400).json({ error: 'That email code is incorrect' });
  }

  // Re-check email uniqueness — someone else could have registered the same
  // email in the window between starting and finishing this one.
  const { payload } = pending;
  const stillFree = !(await db.find('users', u => u.email.toLowerCase() === payload.email.toLowerCase()));
  if (!stillFree) {
    await db.remove('pendingRegistrations', pending.id);
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const trimmedName = payload.name;
  // A provider who typed a category we don't currently list isn't blocked —
  // their account is created normally and they can start using the
  // platform right away. What happens instead: their category goes into a
  // real pending-approval state (visible to them and to admins), and every
  // super admin is notified immediately so a real person reviews it — the
  // same "don't block, but don't silently pretend it's approved either"
  // principle used for unlisted job categories.
  let categoryApprovalStatus = 'approved';
  if (payload.role === 'provider') {
    const activeCategories = (await db.filter('categories', c => c.active)).map(c => c.name);
    if (!activeCategories.includes(payload.category)) categoryApprovalStatus = 'pending';
  }

  const user = {
    id: `u_${nanoid(10)}`,
    name: trimmedName,
    email: payload.email,
    role: payload.role,
    country: payload.country,
    state: payload.state,
    city: payload.city,
    phone: payload.phone,
    address: payload.address,
    zipCode: payload.zipCode,
    phoneVerified: false, // phone is no longer verified as part of signup — see /send-phone-otp and /verify-phone-otp for how someone can verify it later, e.g. for 2FA
    initials: trimmedName.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase(),
    verified: false,
    passwordHash: payload.passwordHash || hashPassword(payload.password), // v81: already hashed at sign-up start
    referralCode: await generateUniqueReferralCode(),
    referredByUserId: payload.referredByUserId || null,
    createdAt: new Date().toISOString(),
    ...(payload.role === 'provider' ? {
      providerRole: 'New Provider',
      category: payload.category || 'Plumbing',
      categoryApprovalStatus,
      skills: payload.skills.trim(),
      tags: payload.skills.split(',').map(s => s.trim()).filter(Boolean).slice(0, 6),
      rating: 0, jobs: 0, price: 50, color: '#5A5F6C', since: String(new Date().getFullYear()),
    } : {}),
  };
  await db.insert('users', user);
  await db.remove('pendingRegistrations', pending.id);

  // Item: Joseph asked for a real welcome message when someone signs up,
  // introducing what Trothen is and how it works — there was nothing at
  // all here before. Two parts: a real welcome email (works the same
  // "test mode" way every other email in this app does — see sendEmail
  // in src/delivery.js — logged to the console until a real email
  // provider is connected, not silently skipped), and a real in-app
  // notification waiting the first time they open their dashboard. Kept
  // deliberately short and role-aware rather than a wall of text.
  const firstNameForWelcome = trimmedName.split(' ')[0];
  const welcomeSubject = `Welcome to Trothen, ${firstNameForWelcome}!`;
  const welcomeBody = user.role === 'provider'
    ? `Hi ${firstNameForWelcome},\n\nWelcome to Trothen — you're now set up as a ${user.category} provider.\n\nHere's how it works: customers post jobs or search for pros like you, you get matched based on your category and location, and every job runs on an auto-generated contract with the payment held safely in escrow until the work is confirmed done. You'll need a verified profile photo and ID before you start showing up in customer searches — you can take care of both from your dashboard.\n\nGlad to have you on board.\n\n— The Trothen Team`
    : `Hi ${firstNameForWelcome},\n\nWelcome to Trothen — real local pros, verified before they ever show up.\n\nHere's how it works: tell us what you need done, we match you with verified, ID-checked professionals nearby, and every booking runs on an auto-generated contract with your payment held safely in escrow until you're satisfied with the work. No guessing who's really coming to your door.\n\nReady when you are — just search for what you need on your dashboard.\n\n— The Trothen Team`;
  const { sendEmail } = require('../delivery');
  await sendEmail(user.email, welcomeSubject, welcomeBody);
  await sendVerificationInviteEmail(req, user);
  await notify(user.id, '👋', `Welcome to Trothen, ${firstNameForWelcome}! Here's how it works: ${user.role === 'provider' ? 'get matched to jobs in your category, and every payment is held safely in escrow until the work is confirmed done.' : 'tell us what you need, we match you with a verified local pro, and your payment stays safely in escrow until you\'re satisfied.'}`);

  if (payload.referredByUserId) {
    await db.insert('referrals', {
      id: `ref_${nanoid(10)}`,
      referrerId: payload.referredByUserId,
      referredUserId: user.id,
      referredRole: user.role,
      createdAt: new Date().toISOString(),
    });
    const firstName = trimmedName.split(' ')[0];
    const lastInitial = trimmedName.split(' ')[1] ? ` ${trimmedName.split(' ')[1][0]}.` : '';
    await notify(payload.referredByUserId, '🎉', `${firstName}${lastInitial} just joined Trothen as a ${user.role} using your referral link!`, null, { section: 'referrals' });
    const { awardLoyaltyPoint } = require('../loyalty');
    await awardLoyaltyPoint(payload.referredByUserId, 'referral');
  }

  // Consume the org invite (if any) now that the account genuinely exists
  // — re-validated here rather than trusting the check from /signup/start,
  // since the code could have been revoked or hit its limit during the
  // phone/email verification window. If it's no longer valid, the account
  // still gets created normally — it just isn't attached to the org. Same
  // "don't block, but don't silently pretend it worked" principle as the
  // unlisted-category flow below.
  let joinedOrganizationName = null;
  if (payload.role === 'provider' && payload.inviteCode) {
    const invite = await db.find('organizationInvites', i => i.code === payload.inviteCode);
    const stillValid = invite
      && invite.status === 'active'
      && (!invite.expiresAt || new Date(invite.expiresAt) >= new Date())
      && (invite.maxUses == null || invite.usesCount < invite.maxUses);
    if (stillValid) {
      const org = await db.find('organizations', o => o.id === invite.organizationId && o.status === 'active');
      if (org) {
        await db.update('users', user.id, { organizationId: org.id });
        await db.update('organizationInvites', invite.id, { usesCount: invite.usesCount + 1 });
        joinedOrganizationName = org.name;
      }
    }
  }

  if (categoryApprovalStatus === 'pending') {
    const request = {
      id: `catreq_${nanoid(10)}`,
      providerId: user.id,
      requestedCategory: user.category,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    await db.insert('categoryRequests', request);

    // Real, immediate alert to every super admin — the actual working
    // mechanism today (in-app notifications are live; there's no email
    // provider connected yet, so an email alert is logged clearly as
    // test-mode rather than silently not happening).
    const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
    for (const admin of superAdmins) {
      await notify(admin.id, '🆕', `${user.name} signed up wanting to offer "${user.category}" — not a current category. Review within 24 hours in Categories & Countries → Category Requests.`, null, { section: 'categories' });
      console.log(`[TEST MODE — no email provider connected] Would email ${admin.email}: New category request "${user.category}" from ${user.name} needs review within 24 hours.`);
    }
  }

  // Real fraud/safety check — the same phone number registering a second
  // account is a genuine, common signal worth a human review. The account
  // is never blocked over this alone; it just creates a real flag.
  const { checkDuplicateIdentity } = require('../fraud-detection');
  await checkDuplicateIdentity(user.phone, user.email, user.id);

  const token = await signToken(user, req.headers['user-agent']);
  res.status(201).json({ token, user: publicUser(user), categoryApprovalStatus, joinedOrganizationName });
}

// POST /api/auth/signup/resend — regenerate both codes for an in-progress
// registration (e.g. the 15-minute window is about to run out, or the codes
// were dismissed accidentally).
// v81: limited. Each call sends an email, and there was no limit at all, so
// one sign-up could be used to flood somebody's inbox and run up the email
// bill. Now: the shared code limiter, at least 30 seconds between sends,
// and 5 resends per sign-up.
router.post('/signup/resend', otpLimiter, async (req, res) => {
  const { pendingId } = req.body || {};
  if (!isNonEmptyString(pendingId)) return res.status(400).json({ error: 'pendingId is required' });
  const pending = await db.find('pendingRegistrations', p => p.id === pendingId);
  if (!pending) return res.status(400).json({ error: 'This registration has expired or was not found — please start again' });
  if ((pending.resendCount || 0) >= 5) return res.status(429).json({ error: 'That\'s the most codes we can send for one sign-up. Please start again.' });
  if (pending.lastResendAt && Date.now() - new Date(pending.lastResendAt).getTime() < 30 * 1000) {
    return res.status(429).json({ error: 'Please wait 30 seconds before asking for another code.' });
  }

  const { isEmailConfigured, sendEmail } = require('../delivery');
  const emailCode = generateSixDigitCode();

  await db.update('pendingRegistrations', pending.id, {
    emailCodeHash: hashResetToken(emailCode),
    expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS).toISOString(),
    resendCount: (pending.resendCount || 0) + 1,
    lastResendAt: new Date().toISOString(),
  });

  const emailDelivered = isEmailConfigured()
    ? (await sendEmail(pending.payload.email, 'Verify your Trothen email', `Your Trothen email verification code is ${emailCode}.`)).sent
    : false;

  if (emailDelivered) {
    return res.json({ testMode: false });
  }
  if (isEmailConfigured()) {
    // Same rule as /signup/start: a configured-but-failed send never falls
    // back to showing the code.
    return res.status(502).json({ error: "We couldn't send your code just now. Please wait a minute and try again." });
  }

  console.log(`[TEST MODE] Resent registration code for ${pending.payload.email}: ${emailCode}`);

  res.json({ testMode: true, emailCode });
});

// POST /api/auth/login
// Shared by POST /login and POST /google (Google Sign-In login) — the
// exact same suspension/rejection checks, the exact same "admin accounts
// require 2FA, backfilled silently the first time they reach this point"
// rule, and the exact same test-mode-aware 2FA delivery. Extracted here
// so Google Sign-In doesn't get a second, easier-to-drift-from copy of
// security-relevant logic — one real implementation, two entry points.
async function issueSessionOrRequire2FA(user, req, res) {
  if (user.active === false) {
    if (user.closedByOwner) return res.status(403).json({ error: 'This account was closed at its owner\'s request. Contact Trothen support if you\'d like it reopened.' });
    return res.status(403).json({ error: 'This account has been suspended. Contact a super admin for access.' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'This account application was not approved. Contact support if you believe this was a mistake.' });
  }
  if (user.role === 'admin' && !user.twoFactorEnabled) {
    await db.update('users', user.id, { twoFactorEnabled: true });
    user.twoFactorEnabled = true;
  }
  if (user.twoFactorEnabled) {
    const code = generateSixDigitCode();
    const pendingLogin = {
      id: `plogin_${nanoid(10)}`,
      userId: user.id,
      codeHash: hashResetToken(code),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    await db.insert('pendingLogins', pendingLogin);

    const { isSmsConfigured, isEmailConfigured, sendSms, sendEmail } = require('../delivery');
    let delivered = false;
    let sentVia = null;
    if (isSmsConfigured() && user.phone) {
      delivered = (await sendSms(user.phone, `Your Trothen sign-in code is ${code}. It expires in 10 minutes.`)).sent;
      if (delivered) sentVia = 'text';
    }
    if (!delivered && isEmailConfigured()) {
      delivered = (await sendEmail(user.email, 'Your Trothen sign-in code', `Your sign-in code is ${code}. It expires in 10 minutes.`)).sent;
      if (delivered) sentVia = 'email';
    }
    // v89: say where the code went (partly hidden), so someone signing in
    // for the first time knows which inbox or phone to look at.
    const maskEmail = (e) => String(e || '').replace(/^(.)[^@]*@/, (m, a) => a + '•••@');
    const maskPhone = (ph) => String(ph || '').replace(/.(?=.{3})/g, '•');
    if (delivered) {
      return res.json({ requires2FA: true, pendingLoginId: pendingLogin.id, testMode: false, sentVia, sentTo: sentVia === 'text' ? maskPhone(user.phone) : maskEmail(user.email) });
    }
    // A provider is connected but the send failed. Handing the code back
    // to whoever just typed the password would make two-factor protect
    // nothing, so the sign-in stops here instead.
    if (isEmailConfigured() || (isSmsConfigured() && user.phone)) {
      await db.remove('pendingLogins', pendingLogin.id);
      return res.status(502).json({ error: `We couldn't send your sign-in code to ${maskEmail(user.email)}. Check that this email address is real and can receive mail, then try again. If it still doesn't arrive, ask the super admin to check the email address on your account.` });
    }
    return res.json({
      requires2FA: true,
      pendingLoginId: pendingLogin.id,
      testMode: true,
      testModeNote: 'No real SMS or email provider is configured yet — the code is returned directly instead of being sent. Do not do this in production.',
      code,
    });
  }

  const token = await signToken(user, req.headers['user-agent']);
  return res.json({ token, user: publicUser(user) });
}

// v82: wrong-password counting per ACCOUNT, on top of the per-connection
// limit above. The old limit only counted tries from one connection, so
// someone guessing from many connections was never slowed. Now 8 wrong
// passwords for the same email inside 15 minutes pauses sign-in for that
// email for 15 minutes, whoever is trying and from wherever. It's counted
// the same way for emails that have no account, so the message doesn't
// reveal which emails exist. Kept in memory: a restart clears it.
const LOGIN_FAIL_LIMIT = 8;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // email -> { count, firstAt, lockedUntil }
// v83: a pause that's in force is also written to the data store (under a
// one-way hash of the email, never the email itself), so restarting the
// server doesn't quietly lift it.
const lockId = (emailKey) => 'lk_' + require('crypto').createHash('sha256').update(emailKey).digest('hex').slice(0, 32);
async function persistLock(emailKey, lockedUntil) {
  try {
    const id = lockId(emailKey);
    const existing = await db.find('loginLockouts', l => l.id === id);
    if (existing) await db.update('loginLockouts', id, { lockedUntil });
    else await db.insert('loginLockouts', { id, lockedUntil });
  } catch (e) { /* the in-memory pause still applies */ }
}
async function storedLock(emailKey) {
  try {
    const rec = await db.find('loginLockouts', l => l.id === lockId(emailKey));
    if (!rec) return null;
    if (rec.lockedUntil > Date.now()) return rec;
    await db.remove('loginLockouts', rec.id);
  } catch (e) { /* fall through */ }
  return null;
}
function loginLockState(emailKey) {
  const s = loginFailures.get(emailKey);
  if (!s) return null;
  const now = Date.now();
  if (s.lockedUntil && s.lockedUntil > now) return s;
  if (s.lockedUntil && s.lockedUntil <= now) { loginFailures.delete(emailKey); return null; }
  if (now - s.firstAt > LOGIN_FAIL_WINDOW_MS) { loginFailures.delete(emailKey); return null; }
  return s;
}
setInterval(() => { for (const k of loginFailures.keys()) loginLockState(k); }, 10 * 60 * 1000).unref();
const LOCKED_MESSAGE = 'Too many wrong passwords for this account. Sign-in is paused for 15 minutes. If you\'ve forgotten your password, use "Forgot password" or contact support.';

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const emailKey = String(email).trim().toLowerCase().slice(0, 254);
  const state = loginLockState(emailKey);
  if ((state && state.lockedUntil) || (!state && await storedLock(emailKey))) return res.status(429).json({ error: LOCKED_MESSAGE });
  const user = await db.find('users', u => u.email.toLowerCase() === emailKey);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const s = state || { count: 0, firstAt: Date.now(), lockedUntil: null };
    s.count += 1;
    if (s.count >= LOGIN_FAIL_LIMIT) {
      s.lockedUntil = Date.now() + LOGIN_FAIL_WINDOW_MS;
      loginFailures.set(emailKey, s);
      await persistLock(emailKey, s.lockedUntil);
      if (user) {
        // Tell the real owner, in the app and by email when email is connected.
        try { await require('../notify').notify(user.id, '🔐', 'Someone entered the wrong password for your account several times, so sign-in was paused for 15 minutes. If that wasn\'t you, change your password.', null, { section: 'settings' }); } catch (e) { /* never block sign-in handling on a notice */ }
      }
      return res.status(429).json({ error: LOCKED_MESSAGE });
    }
    loginFailures.set(emailKey, s);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  loginFailures.delete(emailKey);
  // The demo password is written in this app's source code. On the real
  // server, anyone signing in with it must set their own password before
  // they can do anything else (requireAuth enforces mustChangePassword).
  const { DEMO_PASSWORD, isProduction } = require('../go-live');
  if (isProduction() && password === DEMO_PASSWORD && !user.mustChangePassword) {
    await db.update('users', user.id, { mustChangePassword: true });
    user.mustChangePassword = true;
  }
  return issueSessionOrRequire2FA(user, req, res);
});

// POST /api/auth/logout — the real, server-side half of signing out.
// Deletes exactly one row from the sessions table — the one this specific
// token was issued with (see signToken in src/auth.js) — which makes this
// a real, immediate sign-out for THIS device, without touching any other
// device the same account is currently signed into. For "sign out of
// everywhere at once instead," see POST /auth/logout-all below.
router.post('/logout', requireAuth, async (req, res) => {
  if (req.user.sessionId) await db.remove('sessions', req.user.sessionId);
  res.json({ ok: true });
});

// POST /api/auth/logout-all — the explicit "sign out of every device"
// action. Deletes every session row for this account and also bumps
// tokenVersion as a second, independent guarantee — even a token from
// before the per-device session system existed still gets caught by the
// tokenVersion check in requireAuth.
router.post('/logout-all', requireAuth, async (req, res) => {
  const mySessions = await db.filter('sessions', s => s.userId === req.user.sub);
  for (const s of mySessions) await db.remove('sessions', s.id);
  const user = await db.find('users', u => u.id === req.user.sub);
  if (user) await db.update('users', user.id, { tokenVersion: (user.tokenVersion || 0) + 1 });
  res.json({ ok: true, signedOutDevices: mySessions.length });
});

// ── Google Sign-In ──────────────────────────────────────────────────────────
// GET /api/auth/google/config — tells the frontend whether Google Sign-In
// is actually usable right now (GOOGLE_CLIENT_ID set) and what client ID
// to render the button with. The frontend never hardcodes the client ID
// itself, and simply doesn't show the Google button at all when this
// comes back unconfigured, rather than showing a button that's guaranteed
// to fail.
router.get('/google/config', (req, res) => {
  const { isGoogleSignInConfigured } = require('../google-auth');
  res.json({
    configured: isGoogleSignInConfigured(),
    clientId: isGoogleSignInConfigured() ? process.env.GOOGLE_CLIENT_ID : null,
  });
});

// POST /api/auth/google — Google Sign-In LOGIN for an account that
// already exists. Two ways an existing account can match: it was already
// linked to this exact Google identity before (googleId matches), or it
// has the same email Google just verified and simply hasn't been linked
// yet (an account originally created with email/password, now signing in
// with Google for the first time) — that case gets linked automatically
// here, since Google has already done real work to confirm that email
// address belongs to whoever is signing in right now. If neither match
// is found, this deliberately does NOT create an account — it tells the
// frontend so, and the frontend routes to POST /google/signup instead,
// the same "check first, then a separate real signup step" shape as
// email/password already uses.
router.post('/google', async (req, res) => {
  const { idToken } = req.body || {};
  const { verifyGoogleIdToken } = require('../google-auth');
  const google = await verifyGoogleIdToken(idToken);
  if (!google) return res.status(401).json({ error: 'Could not verify that Google sign-in — please try again' });
  if (!google.emailVerified) return res.status(401).json({ error: 'That Google account\'s email isn\'t verified — please verify it with Google first' });

  let user = await db.find('users', u => u.googleId === google.googleId);
  if (!user) {
    const byEmail = await db.find('users', u => u.email.toLowerCase() === google.email.toLowerCase());
    if (byEmail) {
      await db.update('users', byEmail.id, { googleId: google.googleId });
      user = { ...byEmail, googleId: google.googleId };
    }
  }
  if (!user) {
    return res.status(404).json({ error: 'No Trothen account found for that Google account', needsSignup: true, googleName: google.name, googleEmail: google.email });
  }
  return issueSessionOrRequire2FA(user, req, res);
});

// POST /api/auth/google/signup — creates a brand-new account from a
// verified Google identity. No password (a random, never-shown hash is
// stored just to satisfy the column's NOT NULL constraint — this account
// can only ever sign in via Google unless a password is set later from
// Settings), and no email verification step (Google's email_verified
// claim, already checked above, is what email verification exists to
// establish in the first place — asking for a second proof of the same
// email would be pure friction with no real security benefit). Otherwise
// this mirrors completeSignupVerify below as closely as it reasonably
// can: same required fields, same category-approval-pending handling,
// same org invite / referral handling — a Google signup is a full,
// first-class account, not a lesser one.
router.post('/google/signup', signupLimiter, async (req, res) => {
  const { idToken, role, country, state, city, phone, address, zipCode, category, skills, inviteCode, referralCode } = req.body || {};
  const { verifyGoogleIdToken } = require('../google-auth');
  const google = await verifyGoogleIdToken(idToken);
  if (!google) return res.status(401).json({ error: 'Could not verify that Google sign-in — please try again' });
  if (!google.emailVerified) return res.status(401).json({ error: 'That Google account\'s email isn\'t verified — please verify it with Google first' });

  const errors = validate([
    ['role', ['customer', 'provider'].includes(role), 'Role must be customer or provider — admin accounts are created by a super admin'],
    ['phone', isValidPhone(phone), 'Enter a valid phone number (7-15 digits)'],
    ['zipCode', isValidPostalCode(zipCode, country), postalCodeErrorMessage(country)],
    ['address', isNonEmptyString(address, { min: 3, max: 200 }), 'Enter a valid address'],
    ['country', isNonEmptyString(country, { min: 2, max: 100 }), 'Select your country'],
    ['state', isNonEmptyString(state, { min: 2, max: 100 }), 'Select your state/region'],
    ['city', isNonEmptyString(city, { min: 2, max: 100 }), 'Enter your city'],
    ['state', typeof country !== 'string' || typeof state !== 'string' || isValidStateForCountry(country.trim(), state.trim()), 'That state/region doesn\'t belong to the selected country — please re-select both'],
    ['city', typeof country !== 'string' || typeof city !== 'string' || isPlausibleCityForCountry(country.trim(), city.trim()), 'That city is a known city in a different country — please double check your country and city'],
  ]);
  if (role === 'provider') {
    errors.push(...validate([
      ['category', isNonEmptyString(category), 'Select your primary service category'],
      ['skills', isNonEmptyString(skills, { min: 2, max: 300 }), 'List at least one skill or specialty'],
    ]));
  }
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const existingByEmail = await db.find('users', u => u.email.toLowerCase() === google.email.toLowerCase());
  if (existingByEmail) return res.status(409).json({ error: 'An account with that email already exists — try signing in with Google instead' });
  const existingByGoogleId = await db.find('users', u => u.googleId === google.googleId);
  if (existingByGoogleId) return res.status(409).json({ error: 'That Google account is already linked to a Trothen account — try signing in instead' });

  let inviteOrgId = null;
  const trimmedInviteCode = (inviteCode || '').trim().toUpperCase();
  if (trimmedInviteCode) {
    if (role !== 'provider') return res.status(400).json({ error: 'Organization invite links are for provider accounts' });
    const invite = await db.find('organizationInvites', i => i.code === trimmedInviteCode);
    if (!invite) return res.status(400).json({ error: 'This invite link is invalid' });
    if (invite.status !== 'active') return res.status(400).json({ error: 'This invite link has been revoked' });
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return res.status(400).json({ error: 'This invite link has expired' });
    if (invite.maxUses != null && invite.usesCount >= invite.maxUses) return res.status(400).json({ error: 'This invite link has reached its usage limit' });
    inviteOrgId = invite.organizationId;
  }

  let referrer = null;
  const trimmedReferralCode = (referralCode || '').trim().toUpperCase();
  if (trimmedReferralCode) {
    referrer = await db.find('users', u => u.referralCode === trimmedReferralCode);
    if (!referrer) return res.status(400).json({ error: 'This referral link isn\'t valid' });
  }

  let categoryApprovalStatus = 'approved';
  if (role === 'provider') {
    const activeCategories = (await db.filter('categories', c => c.active)).map(c => c.name);
    if (!activeCategories.includes(category)) categoryApprovalStatus = 'pending';
  }

  const trimmedName = google.name.trim();
  const user = {
    id: `u_${nanoid(10)}`,
    name: trimmedName,
    email: google.email,
    googleId: google.googleId,
    role,
    country: country.trim(),
    state: state.trim(),
    city: city.trim(),
    phone: phone.trim(),
    address: address.trim(),
    zipCode: (zipCode || '').trim(),
    phoneVerified: false,
    initials: trimmedName.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase(),
    verified: false,
    // Never used to sign in (there's no /login path that would accept it
    // without a real password being set later from Settings) — exists
    // purely because password_hash is NOT NULL in the schema. A real,
    // unguessable random value, not a placeholder string, so it's not a
    // usable credential even in theory.
    passwordHash: hashPassword(nanoid(32)),
    referralCode: await generateUniqueReferralCode(),
    referredByUserId: referrer ? referrer.id : null,
    createdAt: new Date().toISOString(),
    ...(role === 'provider' ? {
      providerRole: 'New Provider',
      category: category || 'Plumbing',
      categoryApprovalStatus,
      skills: skills.trim(),
      tags: skills.split(',').map(s => s.trim()).filter(Boolean).slice(0, 6),
      rating: 0, jobs: 0, price: 50, color: '#5A5F6C', since: String(new Date().getFullYear()),
    } : {}),
  };
  await db.insert('users', user);

  // Same real welcome email + in-app notification as the standard signup
  // path (see completeSignupVerify above) — a Google sign-up deserves the
  // same introduction, not a silently different (worse) experience.
  {
    const firstNameForWelcome = trimmedName.split(' ')[0];
    const welcomeSubject = `Welcome to Trothen, ${firstNameForWelcome}!`;
    const welcomeBody = user.role === 'provider'
      ? `Hi ${firstNameForWelcome},\n\nWelcome to Trothen — you're now set up as a ${user.category} provider.\n\nHere's how it works: customers post jobs or search for pros like you, you get matched based on your category and location, and every job runs on an auto-generated contract with the payment held safely in escrow until the work is confirmed done. You'll need a verified profile photo and ID before you start showing up in customer searches — you can take care of both from your dashboard.\n\nGlad to have you on board.\n\n— The Trothen Team`
      : `Hi ${firstNameForWelcome},\n\nWelcome to Trothen — real local pros, verified before they ever show up.\n\nHere's how it works: tell us what you need done, we match you with verified, ID-checked professionals nearby, and every booking runs on an auto-generated contract with your payment held safely in escrow until you're satisfied with the work. No guessing who's really coming to your door.\n\nReady when you are — just search for what you need on your dashboard.\n\n— The Trothen Team`;
    const { sendEmail } = require('../delivery');
    await sendEmail(user.email, welcomeSubject, welcomeBody);
    await sendVerificationInviteEmail(req, user);
    await notify(user.id, '👋', `Welcome to Trothen, ${firstNameForWelcome}! Here's how it works: ${user.role === 'provider' ? 'get matched to jobs in your category, and every payment is held safely in escrow until the work is confirmed done.' : 'tell us what you need, we match you with a verified local pro, and your payment stays safely in escrow until you\'re satisfied.'}`);
  }

  if (referrer) {
    await db.insert('referrals', {
      id: `ref_${nanoid(10)}`,
      referrerId: referrer.id,
      referredUserId: user.id,
      referredRole: user.role,
      createdAt: new Date().toISOString(),
    });
    const firstName = trimmedName.split(' ')[0];
    const lastInitial = trimmedName.split(' ')[1] ? ` ${trimmedName.split(' ')[1][0]}.` : '';
    await notify(referrer.id, '🎉', `${firstName}${lastInitial} just joined Trothen as a ${user.role} using your referral link!`, null, { section: 'referrals' });
    const { awardLoyaltyPoint } = require('../loyalty');
    await awardLoyaltyPoint(referrer.id, 'referral');
  }

  let joinedOrganizationName = null;
  if (role === 'provider' && trimmedInviteCode) {
    const invite = await db.find('organizationInvites', i => i.code === trimmedInviteCode);
    const stillValid = invite
      && invite.status === 'active'
      && (!invite.expiresAt || new Date(invite.expiresAt) >= new Date())
      && (invite.maxUses == null || invite.usesCount < invite.maxUses);
    if (stillValid) {
      const org = await db.find('organizations', o => o.id === invite.organizationId && o.status === 'active');
      if (org) {
        await db.update('users', user.id, { organizationId: org.id });
        await db.update('organizationInvites', invite.id, { usesCount: invite.usesCount + 1 });
        joinedOrganizationName = org.name;
      }
    }
  }

  const token = await signToken(user, req.headers['user-agent']);
  res.status(201).json({ token, user: publicUser(user), categoryApprovalStatus: role === 'provider' ? categoryApprovalStatus : undefined, joinedOrganizationName });
});

// POST /api/auth/login/verify-2fa — the second factor. Completes the
// session only if the code matches and hasn't expired; the pending login
// record is single-use either way, so a code can't be replayed.
router.post('/login/verify-2fa', otpLimiter, async (req, res) => {
  const { pendingLoginId, code } = req.body || {};
  if (!pendingLoginId || !code) return res.status(400).json({ error: 'pendingLoginId and code are required' });
  const pending = await db.find('pendingLogins', p => p.id === pendingLoginId);
  if (!pending) return res.status(400).json({ error: 'This login attempt has expired. Please sign in again.' });
  if (new Date(pending.expiresAt) < new Date()) {
    await db.remove('pendingLogins', pending.id);
    return res.status(400).json({ error: 'This code has expired. Please sign in again.' });
  }
  if (hashResetToken(code.trim()) !== pending.codeHash) {
    return res.status(400).json({ error: 'Incorrect code' });
  }
  await db.remove('pendingLogins', pending.id);
  const user = await db.find('users', u => u.id === pending.userId);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  const token = await signToken(user, req.headers['user-agent']);
  res.json({ token, user: publicUser(user) });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const user = await db.find('users', u => u.id === req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const result = publicUser(user);
  // Item 9: lets a provider actually see where they stand against their
  // own weekly job-access cap, rather than just quietly seeing fewer
  // matches with no visible explanation. Computed live rather than
  // stored, so it's never stale — cheap enough for one provider's own
  // profile load (unlike, say, an admin list of hundreds of providers).
  if (user.role === 'provider') {
    const { weeklyJobAccessCapForScore } = require('../provider-score');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const usedThisWeek = (await db.filter('matches', m => m.providerId === user.id && m.createdAt >= sevenDaysAgo)).length;
    result.weeklyJobAccess = { used: usedThisWeek, cap: weeklyJobAccessCapForScore(user.trustScore, user.trustScoreProvisional === true), isNew: user.trustScoreProvisional === true };
    // Item: the "Additional Trust Checks" panel used to hardcode
    // Automated Fraud Screening as always "completed" for every
    // provider, regardless of whether they actually had a real, open
    // flag against them — a false trust signal shown to the provider
    // and, indirectly, to anyone deciding whether to trust them. Live
    // check here (real fraudFlags records, see src/fraud-detection.js),
    // never stale, same reasoning as weeklyJobAccess just above it.
    const openFlags = await db.filter('fraudFlags', f => f.userId === user.id && f.status === 'open');
    result.hasOpenFraudFlags = openFlags.length > 0;
  }
  res.json({ user: result });
});

// PATCH /api/auth/me — update own profile / settings
// Current version string for the Community/Customer Standards agreement.
// Bump this any time the actual terms change — any user whose stored
// terms_version doesn't match this gets shown the agreement gate again on
// their next visit, rather than being grandfathered into terms they never
// actually saw. Keep this in sync with CURRENT_TERMS_VERSION on the
// frontend (public/index.html) — both must agree for the gate to work.
const { CURRENT_TERMS_VERSION } = require('../terms'); // v81: one shared definition, see src/terms.js

// POST /api/auth/accept-terms — records genuine, deliberate consent: a
// real timestamp and the exact version being agreed to, not an implied
// "they must have agreed since they're using the app" assumption. This is
// what actually lets the business prove consent happened, the same way a
// real company needs to be able to.
router.post('/accept-terms', requireAuth, async (req, res) => {
  const { version, viewedFullTerms, acknowledgedAll } = req.body || {};
  if (version !== CURRENT_TERMS_VERSION) {
    return res.status(400).json({ error: 'This isn\'t the current version of the agreement — please refresh and try again.' });
  }
  // v76: agreement is a tick box per promise plus one for the full Terms
  // of Service, which are linked right beside that box. The server refuses
  // to record acceptance unless the request says every box was ticked.
  // Opening the full terms is no longer forced; whether they did is still
  // recorded, honestly, alongside the time and version.
  if (acknowledgedAll !== true) {
    return res.status(400).json({ error: 'Please check every box before you continue.' });
  }
  await db.update('users', req.user.sub, { termsAcceptedAt: new Date().toISOString(), termsVersion: version, termsViewedFull: viewedFullTerms === true });
  res.json({ ok: true, termsVersion: version });
});

// ── v83: a person's own data, and leaving (see src/account-privacy.js) ──
const privacyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false,
  message: { error: 'You\'ve done that several times in the last hour. Please try again later.' },
});

// GET /api/auth/me/export — everything Trothen holds about me, as one file.
router.get('/me/export', requireAuth, privacyLimiter, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!me || me.role === 'admin') return res.status(400).json({ error: 'Data downloads are for customer and pro accounts' });
  const data = await require('../account-privacy').buildExport(me.id);
  res.set('Cache-Control', 'no-store, private');
  res.set('Content-Disposition', `attachment; filename="trothen-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
  res.type('application/json').send(JSON.stringify(data, null, 2));
});

// GET /api/auth/me/close-account/check — can I close right now, and if not, why.
router.get('/me/close-account/check', requireAuth, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!me || me.role === 'admin') return res.status(400).json({ error: 'Staff accounts are closed by a super admin' });
  res.json({ blockers: await require('../account-privacy').closureBlockers(me) });
});

// POST /api/auth/me/close-account { password, reason? } — closes my own
// account. Needs my password again. Refused while a booking, held payment,
// dispute, posted job or unpaid earnings is still open.
router.post('/me/close-account', requireAuth, privacyLimiter, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!me || me.role === 'admin') return res.status(400).json({ error: 'Staff accounts are closed by a super admin' });
  const { password, reason, confirm } = req.body || {};
  // People who only ever sign in with Google have no password to type, so
  // they confirm by typing CLOSE instead.
  const passwordOk = !!password && verifyPassword(String(password), me.passwordHash);
  const googleOk = !!me.googleId && String(confirm || '').trim().toUpperCase() === 'CLOSE';
  if (!passwordOk && !googleOk) return res.status(401).json({ error: me.googleId ? 'Enter your password, or type CLOSE to confirm' : 'That password isn\'t right' });
  const privacy = require('../account-privacy');
  const blockers = await privacy.closureBlockers(me);
  if (blockers.length) return res.status(409).json({ error: blockers[0], blockers });
  await privacy.closeAccount(me, reason);
  res.json({ ok: true });
});

router.patch('/me', requireAuth, async (req, res) => {
  const allowed = ['name', 'email', 'phone', 'country', 'state', 'city', 'address', 'zipCode', 'payPreference', 'payoutMethod', 'payoutPaypalEmail', 'payoutMethodIntl', 'payoutPaypalEmailIntl', 'notifPrefs', 'availability', 'pricingModel', 'price', 'twoFactorEnabled', 'businessName', 'businessRegistrationNumber', 'category', 'acceptingBookings', 'licenseExpiryDate', 'insuranceExpiryDate', 'latitude', 'longitude', 'serviceRadiusMiles'];
  const patch = {};
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  if ('acceptingBookings' in patch && typeof patch.acceptingBookings !== 'boolean') {
    return res.status(400).json({ error: 'acceptingBookings must be true or false' });
  }
  // Item 15 / Country → Region validation, applied here too, not just at
  // signup — someone could otherwise change their country afterward and
  // leave a now-mismatched state (or city) on file. Only checks when the
  // relevant fields end up set together on this update: whichever one
  // isn't being changed right now is read from the account's existing
  // value.
  if ('country' in patch || 'state' in patch || 'city' in patch) {
    const existingUser = await db.find('users', u => u.id === req.user.sub);
    const effectiveCountry = 'country' in patch ? patch.country : (existingUser && existingUser.country);
    const effectiveState = 'state' in patch ? patch.state : (existingUser && existingUser.state);
    const effectiveCity = 'city' in patch ? patch.city : (existingUser && existingUser.city);
    if (effectiveCountry && effectiveState && !isValidStateForCountry(effectiveCountry, effectiveState)) {
      return res.status(400).json({ error: 'That state/region doesn\'t belong to the selected country — please re-select both' });
    }
    if (effectiveCountry && effectiveCity && !isPlausibleCityForCountry(effectiveCountry, effectiveCity)) {
      return res.status(400).json({ error: 'That city is a known city in a different country — please double check your country and city' });
    }
  }
  for (const dateField of ['licenseExpiryDate', 'insuranceExpiryDate']) {
    if (dateField in patch && patch[dateField] !== null) {
      if (typeof patch[dateField] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(patch[dateField]) || isNaN(new Date(patch[dateField]).getTime())) {
        return res.status(400).json({ error: `${dateField === 'licenseExpiryDate' ? 'License' : 'Insurance'} expiry must be a real date` });
      }
    }
  }
  if (('latitude' in patch) !== ('longitude' in patch)) {
    return res.status(400).json({ error: 'latitude and longitude must be set together' });
  }
  if ('latitude' in patch && patch.latitude !== null) {
    const { isValidCoordinate } = require('../geo-distance');
    if (!isValidCoordinate(patch.latitude, patch.longitude)) {
      return res.status(400).json({ error: 'That doesn\'t look like a real GPS location' });
    }
  }
  if ('serviceRadiusMiles' in patch && patch.serviceRadiusMiles !== null) {
    if (typeof patch.serviceRadiusMiles !== 'number' || patch.serviceRadiusMiles <= 0 || patch.serviceRadiusMiles > 500) {
      return res.status(400).json({ error: 'Service radius must be a positive number of miles (500 max), or left blank to travel anywhere' });
    }
  }
  if ('payoutMethodIntl' in patch && patch.payoutMethodIntl !== null && !['PayPal', 'Bank Transfer'].includes(patch.payoutMethodIntl)) {
    return res.status(400).json({ error: 'payoutMethodIntl must be PayPal, Bank Transfer, or left blank' });
  }
  if ('name' in patch && !isValidName(patch.name)) {
    return res.status(400).json({ error: 'Enter a real name — letters, spaces, hyphens, and apostrophes only' });
  }
  // Once someone's ID has been checked, their name is tied to it: a
  // verified pro can't rename their account to someone else and keep the
  // "ID checked" badge. Small edits that still match the ID (adding a
  // middle name, fixing a typo) go through; anything else goes to support.
  if ('name' in patch && req.user.role !== 'admin') {
    const current = await db.find('users', u => u.id === req.user.sub);
    if (current && current.verified === true && String(patch.name).trim() !== String(current.name || '').trim()) {
      const { namesLikelyMatch } = require('../validators');
      const approved = (await db.filter('verifications', v => v.userId === current.id && v.status === 'approved' && v.idLegalName))
        .sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')))[0];
      const reference = approved ? approved.idLegalName : current.name;
      if (!namesLikelyMatch(patch.name, reference)) {
        return res.status(400).json({ error: 'Your name is tied to the ID we checked. To change it to something different, contact support so we can check your new ID.' });
      }
    }
  }
  if ('email' in patch) {
    if (!isValidEmail(patch.email)) return res.status(400).json({ error: 'Enter a valid email address' });
    patch.email = patch.email.trim();
    const conflict = await db.find('users', u => u.id !== req.user.sub && u.email.toLowerCase() === patch.email.toLowerCase());
    if (conflict) return res.status(409).json({ error: 'That email is already in use by another account' });
  }
  if ('phone' in patch && patch.phone && !isNonEmptyString(patch.phone, { min: 7, max: 30 })) {
    return res.status(400).json({ error: 'Enter a valid phone number' });
  }
  if ('country' in patch) {
    if (!isNonEmptyString(patch.country, { min: 2, max: 100 })) return res.status(400).json({ error: 'Select a valid country' });
    patch.country = patch.country.trim();
  }
  if ('state' in patch) {
    if (!isNonEmptyString(patch.state, { min: 1, max: 100 })) return res.status(400).json({ error: 'Select a valid state/region' });
    patch.state = patch.state.trim();
  }
  if ('city' in patch) {
    if (!isNonEmptyString(patch.city, { min: 2, max: 100 })) return res.status(400).json({ error: 'Enter a valid city' });
    patch.city = patch.city.trim();
  }
  if ('twoFactorEnabled' in patch && typeof patch.twoFactorEnabled !== 'boolean') {
    return res.status(400).json({ error: 'twoFactorEnabled must be true or false' });
  }
  if ('twoFactorEnabled' in patch && patch.twoFactorEnabled === false && req.user.role === 'admin') {
    return res.status(400).json({ error: 'Two-factor authentication is required for admin accounts and can\'t be turned off.' });
  }
  if ('businessName' in patch) {
    if (patch.businessName && !isNonEmptyString(patch.businessName, { max: 150 })) {
      return res.status(400).json({ error: 'Business name is too long' });
    }
    patch.businessName = patch.businessName ? patch.businessName.trim() : null;
  }
  if ('businessRegistrationNumber' in patch) {
    if (patch.businessRegistrationNumber && !isNonEmptyString(patch.businessRegistrationNumber, { max: 100 })) {
      return res.status(400).json({ error: 'Business registration number is too long' });
    }
    patch.businessRegistrationNumber = patch.businessRegistrationNumber ? patch.businessRegistrationNumber.trim() : null;
  }
  if ('availability' in patch) {
    if (!Array.isArray(patch.availability) || !patch.availability.every(a => typeof a === 'string' && a.trim().length > 0)) {
      return res.status(400).json({ error: 'Availability must be a list of time slots' });
    }
    if (patch.availability.length === 0) {
      return res.status(400).json({ error: 'You need at least one available time slot' });
    }
    patch.availability = patch.availability.map(a => a.trim()).slice(0, 15);
  }
  if ('pricingModel' in patch && !['hourly', 'negotiable'].includes(patch.pricingModel)) {
    return res.status(400).json({ error: 'Pricing model must be hourly or negotiable' });
  }
  if ('price' in patch && (typeof patch.price !== 'number' || patch.price <= 0)) {
    return res.status(400).json({ error: 'Hourly rate must be a positive number' });
  }
  if ('plan' in patch) {
    if (req.user.role !== 'provider') {
      return res.status(400).json({ error: 'Only provider accounts have a plan' });
    }
    if (!['starter', 'pro', 'superpro'].includes(patch.plan)) {
      return res.status(400).json({ error: 'Plan must be starter, pro, or superpro' });
    }
  }
  if ('notifPrefs' in patch) {
    if (typeof patch.notifPrefs !== 'object' || patch.notifPrefs === null || Array.isArray(patch.notifPrefs)) {
      return res.status(400).json({ error: 'notifPrefs must be an object of true/false toggles' });
    }
    if (!Object.values(patch.notifPrefs).every(v => typeof v === 'boolean')) {
      return res.status(400).json({ error: 'Every notifPrefs value must be true or false' });
    }
    // Merge, don't overwrite — toggling one preference (e.g. "Promotions")
    // shouldn't silently reset every other saved preference to defaults.
    const current = await db.find('users', u => u.id === req.user.sub);
    patch.notifPrefs = { ...(current && current.notifPrefs), ...patch.notifPrefs };
  }
  if ('category' in patch) {
    const current = await db.find('users', u => u.id === req.user.sub);
    if (!current || current.role !== 'provider') {
      return res.status(400).json({ error: 'Only provider accounts have a category' });
    }
    if (!isNonEmptyString(patch.category, { min: 2, max: 100 })) {
      return res.status(400).json({ error: 'Enter a valid category' });
    }
    patch.category = patch.category.trim();

    // Same real-category matching used at signup and at category-request
    // approval: strip punctuation/casing differences so "pick and drop"
    // correctly matches an existing "Pick & Drop" instead of creating a
    // near-duplicate, or incorrectly staying "pending" when it's really
    // already a listed category.
    const normalize = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const activeCategories = await db.filter('categories', c => c.active);
    const matchedCategory = activeCategories.find(c => normalize(c.name) === normalize(patch.category));

    if (matchedCategory) {
      patch.category = matchedCategory.name; // use the real, correctly-formatted name
      patch.categoryApprovalStatus = 'approved';
    } else {
      patch.categoryApprovalStatus = 'pending';
      const request = {
        id: `catreq_${nanoid(10)}`,
        providerId: req.user.sub,
        requestedCategory: patch.category,
        status: 'pending',
        createdAt: new Date().toISOString(),
        resolvedAt: null,
      };
      await db.insert('categoryRequests', request);
      const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
      for (const admin of superAdmins) {
        await notify(admin.id, '🆕', `${current.name} updated their category to "${patch.category}" — not a current category. Review within 24 hours in Categories & Countries → Category Requests.`, null, { section: 'categories' });
        console.log(`[TEST MODE — no email provider connected] Would email ${admin.email}: category update request "${patch.category}" from ${current.name} needs review within 24 hours.`);
      }
    }
  }
  const updated = await db.update('users', req.user.sub, patch);
  if (!updated) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(updated) });
});

// POST /api/auth/change-password — requires the current password, not just auth
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ error: 'New password must be 8-72 characters' });
  }
  const user = await db.find('users', u => u.id === req.user.sub);
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (verifyPassword(newPassword, user.passwordHash)) {
    return res.status(400).json({ error: 'New password must be different from your current password' });
  }
  const newTokenVersion = (user.tokenVersion || 0) + 1;
  await db.update('users', user.id, { passwordHash: hashPassword(newPassword), tokenVersion: newTokenVersion, mustChangePassword: false });
  const freshToken = await signToken({ ...user, tokenVersion: newTokenVersion }, req.headers['user-agent']);
  res.json({ ok: true, token: freshToken });
});

// ── FORGOT / RESET PASSWORD ──────────────────────────────────────────────────
// No real email service is wired up yet, so this runs in a clearly-labeled
// "test mode": the reset link is handed straight back in the API response
// instead of being emailed. Everything else here — hashed single-use
// expiring tokens, no account-enumeration, rate limiting — is the real
// production pattern. Swapping in a real provider (SendGrid, Postmark, SES,
// Resend, etc.) later means sending the link by email instead of returning
// it, not redesigning this flow.

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Simple in-memory rate limit: max 3 reset requests per email per 15 minutes.
// This is intentionally lightweight (no new dependency) and lives on a
// single instance — fine for now, but if this app ever runs across multiple
// server instances, this needs to move to a shared store (e.g. Redis)
// rather than each instance tracking its own counts.
const resetRequestLog = new Map(); // email -> array of request timestamps
function isRateLimited(email) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const attempts = (resetRequestLog.get(email) || []).filter(t => now - t < windowMs);
  attempts.push(now);
  resetRequestLog.set(email, attempts);
  return attempts.length > 3;
}

// POST /api/auth/forgot-password — always responds the same way whether or
// not the email exists, so this endpoint can't be used to discover which
// emails have accounts.
const RESET_BY_EMAIL_OFF = {
  testMode: false, emailUnavailable: true,
  message: 'Password reset by email isn\'t switched on yet. Please contact Trothen support and we\'ll help you get back in.',
};
router.post('/forgot-password', otpLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  const normalized = email.trim().toLowerCase();

  const genericResponse = { message: 'If an account with that email exists, a reset link has been sent.' };

  if (isRateLimited(normalized)) {
    // Still don't reveal whether the email exists — just stop generating
    // new tokens for it for a while.
    return res.json(genericResponse);
  }

  const user = await db.find('users', u => u.email.toLowerCase() === normalized);
  // Note: this closes the response-SHAPE leak (identical fields either
  // way). A response-TIME leak technically still exists — the real path
  // below does a few extra DB writes the decoy path doesn't — but that's
  // a much higher-effort attack (needs precise timing measurement over
  // many requests) than just reading the JSON, and full constant-time
  // handling is disproportionate for this app's threat model right now.
  // Worth revisiting if this ever needs to resist a genuinely determined
  // attacker rather than casual probing.
  if (!user) {
    // Previously this returned genericResponse alone — no testMode,
    // testModeNote, or resetToken fields. That made the response shape
    // itself distinguish a real account from a fake one (an attacker
    // doesn't need to read the message text, just check whether
    // resetToken is present), quietly defeating the whole point of
    // returning "the same" message either way. This generates a
    // realistic-looking token and returns it in the IDENTICAL shape as
    // the real path below — but it's never hashed, stored, or checked
    // against anything, so submitting it to /reset-password fails exactly
    // like any other wrong token would. Same UX, same test-mode
    // convenience, no distinguishable signal.
    const decoyToken = generateResetToken();
    // With real email connected, a real account's response is plain
    // { testMode:false } — so this one must be too, or the difference
    // itself reveals which emails have accounts.
    if (require('../delivery').isEmailConfigured()) {
      return res.json({ ...genericResponse, testMode: false });
    }
    if (require('../go-live').isProduction()) return res.json({ ...genericResponse, ...RESET_BY_EMAIL_OFF });
    console.log(`[TEST MODE] Password reset requested for an email with no account (${normalized}) — no token was actually issued.`);
    return res.json({
      ...genericResponse,
      testMode: true,
      testModeNote: 'No real email service is configured yet — this token is returned directly instead of being emailed. Do not do this in production.',
      resetToken: decoyToken,
    });
  }

  // Invalidate any previous outstanding reset tokens for this user before
  // issuing a new one, so only the most recent link works.
  // v81: on the live site with no email service connected, this route used
  // to send the working reset token back to whoever asked. That let anyone
  // take over any account, a super admin's included, just by typing its
  // email address. Now nothing is issued: the person is told to contact
  // support, and a super admin can set a temporary password from Admin.
  // (On a developer's own machine the on-screen token still works.)
  if (!require('../delivery').isEmailConfigured() && require('../go-live').isProduction()) {
    return res.json({ ...genericResponse, ...RESET_BY_EMAIL_OFF });
  }

  const outstanding = await db.filter('passwordResets', r => r.userId === user.id && !r.used);
  for (const r of outstanding) {
    await db.update('passwordResets', r.id, { used: true });
  }

  const rawToken = generateResetToken();
  const record = {
    id: `pr_${nanoid(10)}`,
    userId: user.id,
    tokenHash: hashResetToken(rawToken),
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
    used: false,
    createdAt: new Date().toISOString(),
  };
  await db.insert('passwordResets', record);

  const { isEmailConfigured, sendEmail } = require('../delivery');
  const resetLink = `${appBaseUrl(req)}/?resetToken=${rawToken}`;
  let delivered = false;
  if (isEmailConfigured()) {
    delivered = (await sendEmail(
      user.email, 'Reset your Trothen password',
      `Someone requested a password reset for your Trothen account. If this was you, use this link within 30 minutes: ${resetLink}\n\nIf you didn't request this, you can safely ignore this email — your password hasn't been changed.`
    )).sent;
  }
  if (delivered) {
    return res.json({ ...genericResponse, testMode: false });
  }
  if (isEmailConfigured()) {
    // Email is connected but this send failed. Returning the reset token
    // here would let ANYONE reset ANY account's password just by typing
    // its email while the mail service is having a bad minute. Give the
    // same generic answer as success; they can simply ask again.
    console.error(`[auth] password reset email failed to send for ${user.email}`);
    return res.json({ ...genericResponse, testMode: false });
  }

  console.log(`[TEST MODE] Password reset requested for ${user.email}. Reset token: ${rawToken} (expires in 30 min)`);

  res.json({
    ...genericResponse,
    testMode: true,
    testModeNote: 'No real email service is configured yet — this token is returned directly instead of being emailed. Do not do this in production.',
    resetToken: rawToken,
  });
});

// POST /api/auth/reset-password
router.post('/reset-password', otpLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!isNonEmptyString(token)) return res.status(400).json({ error: 'Reset token is required' });
  if (!isValidPassword(newPassword)) return res.status(400).json({ error: 'Choose a password of 8 to 72 characters that isn\'t a common one (like "password123")' });

  const tokenHash = hashResetToken(token);
  const record = await db.find('passwordResets', r => r.tokenHash === tokenHash);
  if (!record || record.used || new Date(record.expiresAt) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  const user = await db.find('users', u => u.id === record.userId);
  if (!user) return res.status(404).json({ error: 'Account not found' });

  await db.update('users', user.id, { passwordHash: hashPassword(newPassword), tokenVersion: (user.tokenVersion || 0) + 1 });
  await db.update('passwordResets', record.id, { used: true });

  res.json({ message: 'Password reset successfully — you can now sign in with your new password.' });
});

// ── PHONE VERIFICATION (test mode — same honest pattern as password reset) ──
// No real SMS provider (Twilio, etc.) is connected yet, so the OTP code is
// returned directly in the API response instead of being texted, clearly
// labeled as test mode. Everything else — a real one-time code, hashed
// before storage, short expiry, single use — is the production pattern.
// Wiring in a real SMS provider later means sending the code by text instead
// of returning it, not redesigning this flow.
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

// POST /api/auth/send-phone-otp — sends (in test mode: returns) a code to the
// phone number already on the requesting user's account.
router.post('/send-phone-otp', requireAuth, async (req, res) => {
  const user = await db.find('users', u => u.id === req.user.sub);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (!user.phone) return res.status(400).json({ error: 'Add a phone number to your account first' });

  // Invalidate any previous outstanding code before issuing a new one.
  const outstanding = await db.filter('phoneVerifications', v => v.userId === user.id && !v.used);
  for (const v of outstanding) {
    await db.update('phoneVerifications', v.id, { used: true });
  }

  const { isSmsConfigured, isVerifyConfigured, sendSms, startPhoneVerification } = require('../delivery');
  const usingVerify = isVerifyConfigured();
  let code = null;
  let codeHash = null;
  let verifyStarted = false;
  if (usingVerify) {
    verifyStarted = (await startPhoneVerification(user.phone)).started;
  }
  if (!usingVerify || !verifyStarted) {
    code = generateOtp();
    codeHash = hashResetToken(code); // same fast-hash helper as reset tokens — a short-lived numeric code, not a password
  }

  await db.insert('phoneVerifications', {
    id: `pv_${nanoid(10)}`,
    userId: user.id,
    codeHash,
    viaTwilioVerify: usingVerify && verifyStarted,
    expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    used: false,
    createdAt: new Date().toISOString(),
  });

  const delivered = usingVerify ? verifyStarted : (isSmsConfigured() ? (await sendSms(user.phone, `Your Trothen phone verification code is ${code}.`)).sent : false);
  if (delivered) {
    return res.json({ message: `A verification code was sent to ${user.phone}.`, testMode: false });
  }
  if (usingVerify || isSmsConfigured()) {
    // Text messaging is connected but this send failed — never fall back
    // to showing the code, or "verified phone" would mean nothing.
    return res.status(502).json({ error: "We couldn't send your code just now. Please wait a minute and try again." });
  }

  console.log(`[TEST MODE] Phone verification code for ${user.phone}: ${code || 'sent via Twilio Verify'} (expires in 10 min)`);

  res.json({
    message: `A verification code would be sent to ${user.phone}.`,
    testMode: true,
    testModeNote: 'No real SMS provider is configured yet — this code is returned directly instead of being texted. Do not do this in production.',
    code: code || undefined,
  });
});

// POST /api/auth/verify-phone-otp — confirms the code and marks the phone verified
router.post('/verify-phone-otp', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!isNonEmptyString(code)) return res.status(400).json({ error: 'Enter the code you received' });

  const outstanding = await db.filter('phoneVerifications', v => v.userId === req.user.sub && !v.used && new Date(v.expiresAt) > new Date());
  if (!outstanding.length) return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
  // Most recent outstanding request — matches how send-phone-otp already
  // invalidates anything older the moment a new one is requested.
  const record = outstanding.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  if (record.viaTwilioVerify) {
    const user = await db.find('users', u => u.id === req.user.sub);
    const { checkPhoneVerification } = require('../delivery');
    const result = await checkPhoneVerification(user.phone, code.trim());
    if (!result.approved) return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
  } else {
    const codeHash = hashResetToken(code.trim());
    if (record.codeHash !== codeHash) return res.status(400).json({ error: 'That code is invalid or has expired. Request a new one.' });
  }
  await db.update('phoneVerifications', record.id, { used: true });
  await db.update('users', req.user.sub, { phoneVerified: true });
  res.json({ message: 'Phone number verified.' });
});

module.exports = router;
