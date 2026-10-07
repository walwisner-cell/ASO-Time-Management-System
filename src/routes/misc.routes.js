const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { isNonEmptyString, validate } = require('../validators');
const { notify } = require('../notify');
const { currencyForCountry } = require('../currency-data');
const { generateUniqueReferralCode } = require('../referral-code');
const { UPLOADS_DIR, verifyPdfMagicBytes } = require('../uploads');

const router = express.Router();

// Messages between two real, identity-verified users had no rate limit at
// all — a frustrated or malicious user could flood the other party with
// unlimited messages in rapid succession. Generous enough not to get in
// the way of a genuine back-and-forth conversation (30/minute is well
// above any real typing pace), strict enough to stop an actual flood.
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Sending messages too quickly — please slow down a moment.' },
});

// The AI chat calls a real, metered external API per question — a
// genuine back-and-forth conversation needs room to breathe, but nothing
// should be able to hammer this endpoint the way it could a free,
// in-memory keyword match.
const supportChatLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many questions in a row — please wait a moment, or ask to talk to a real person.' },
});

// POST /api/contact — the public "Contact Us" form. No auth required (an
// anonymous visitor should be able to reach out), but genuinely stored and
// genuinely alerts the team — not just a toast that pretends to send
// something.
// v81: the four public forms (contact, careers, advertising, sales) had no
// limit, so a script could fill the admin inbox. 6 an hour per connection,
// shared across all four.
const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false,
  message: { error: 'You\'ve sent several messages in a short time. Please try again in an hour.' },
});
router.post('/contact', publicFormLimiter, async (req, res) => {
  const { name, email, subject, message, city } = req.body || {};
  const errors = validate([
    ['name', isNonEmptyString(name, { min: 2, max: 100 }), 'Enter your name'],
    ['email', isNonEmptyString(email, { min: 5, max: 254 }), 'Enter a valid email address'],
    ['subject', isNonEmptyString(subject, { min: 2, max: 200 }), 'Enter a subject'],
    ['message', isNonEmptyString(message, { min: 10, max: 3000 }), 'Message must be at least 10 characters'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const submission = {
    id: `contact_${nanoid(10)}`,
    name: name.trim(), email: email.trim(), subject: subject.trim(), message: message.trim(),
    city: isNonEmptyString(city) ? city.trim() : null,
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  await db.insert('contactSubmissions', submission);

  // Real fix for "contact us doesn't reach administrator / make sure
  // it's regional": this used to notify super admins only — a plain
  // regional admin never learned a contact message existed at all, even
  // one clearly about their own city. Now a regional admin whose city
  // matches what the visitor entered gets notified too, the same way
  // careers inquiries and disputes already reach the right regional
  // team — plus every super admin, always, as the guaranteed fallback
  // for anything unrouted or urgent.
  const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
  const regionalAdmins = submission.city ? await require('../admin-scope').regionalAdminsFor({ city: submission.city, country: submission.country }) : []; // v96: country-wide admins too
  const recipients = [...superAdmins, ...regionalAdmins];
  for (const admin of recipients) {
    await notify(admin.id, '✉️', `New contact form message from ${submission.name}${submission.city ? ` (${submission.city})` : ''}: "${submission.subject}"`, null, { section: 'contact-submissions' });
  }
  console.log(`[TEST MODE — no email provider connected] Would email support@trothen.io: new contact form submission from ${submission.email}`);

  res.status(201).json({ ok: true });
});

// POST /api/careers-inquiry — a real job application, not just a "get in
// touch" note. Previously this only collected a name, email, a free-text
// message, and fired a one-time notification with nowhere for anyone to
// actually go review it — no resume, no phone number, no admin screen to
// see submissions at all. Now accepts a resume (PDF only, verified by
// real file bytes — see verifyPdfMagicBytes — not just the filename or
// declared type), a phone number, and a proper cover letter, and routes
// to whichever HR-department admins exist, falling back to every super
// admin if no HR department admin has been set up yet (see
// GET /admin/careers-inquiries below for where these actually get
// reviewed).
const resumeStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `resume_${nanoid(16)}.pdf`),
});
const resumeFileFilter = (req, file, cb) => {
  if (file.mimetype !== 'application/pdf') return cb(new Error('Resume must be a PDF file'));
  cb(null, true);
};
const uploadResume = multer({ storage: resumeStorage, fileFilter: resumeFileFilter, limits: { fileSize: 8 * 1024 * 1024 } });

router.post('/careers-inquiry', publicFormLimiter, (req, res, next) => {
  uploadResume.single('resume')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message === 'Resume must be a PDF file' ? err.message : 'Resume upload failed — must be a PDF under 8MB' });
    next();
  });
}, async (req, res) => {
  const { name, email, phone, city, role, coverLetter } = req.body || {};
  const errors = validate([
    ['name', isNonEmptyString(name, { min: 2, max: 100 }), 'Enter your name'],
    ['email', isNonEmptyString(email, { min: 5, max: 254 }), 'Enter a valid email address'],
    ['phone', isNonEmptyString(phone, { min: 7, max: 30 }), 'Enter a real phone number we can reach you at'],
    ['role', isNonEmptyString(role, { min: 2, max: 200 }), 'Tell us what role or area interests you'],
    ['coverLetter', isNonEmptyString(coverLetter, { min: 10, max: 5000 }), 'Tell us a bit about yourself (at least 10 characters)'],
  ]);
  if (errors.length) {
    if (req.file) fs.unlink(req.file.path, () => {}); // don't leave an orphaned file if the rest of the form is invalid
    return res.status(400).json({ error: errors[0], errors });
  }

  let resumeUrl = null;
  if (req.file) {
    if (!verifyPdfMagicBytes(req.file.path)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'That file doesn\'t look like a real PDF — please upload an actual PDF resume' });
    }
    resumeUrl = `/uploads/${req.file.filename}`;
  }

  const submission = {
    id: `career_${nanoid(10)}`,
    name: name.trim(), email: email.trim(), phone: phone.trim(), city: (city || '').trim() || null, role: role.trim(), coverLetter: coverLetter.trim(),
    resumeUrl,
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  await db.insert('careersInquiries', submission);

  // Who actually sees this depends on whether the applicant gave a city.
  // With a city: the city's own regional manager (a plain regional
  // admin has a real, direct stake in who joins their own team — this is
  // the literal "let application be regional manager" request), plus any
  // HR admin specifically scoped to that same city, plus any HR admin
  // who's global. Without a city, or if genuinely nobody above exists:
  // every super admin, so an application never just goes nowhere.
  let recipients = [];
  if (submission.city) {
    const regionalManagers = await require('../admin-scope').regionalAdminsFor({ city: submission.city, country: submission.country }); // v96
    const cityHr = await db.filter('users', u => u.role === 'admin' && u.adminDepartment === 'hr' && u.regionScoped && u.city === submission.city);
    const globalHr = await db.filter('users', u => u.role === 'admin' && u.adminDepartment === 'hr' && !u.regionScoped);
    recipients = [...regionalManagers, ...cityHr, ...globalHr].filter(Boolean);
  } else {
    recipients = await db.filter('users', u => u.role === 'admin' && u.adminDepartment === 'hr');
  }
  if (!recipients.length) recipients = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);

  for (const admin of recipients) {
    await notify(admin.id, '💼', `New job application from ${submission.name}${submission.city ? ` (${submission.city})` : ''} — interested in: "${submission.role}"${resumeUrl ? ' (resume attached)' : ''}`, null, { section: 'careers' });
  }
  console.log(`[TEST MODE — no email provider connected] Would email ${recipients.length ? recipients.map(a => a.email).join(', ') : 'support@trothen.io'}: new job application from ${submission.email}`);

  res.status(201).json({ ok: true });
});

// POST /api/advertising-inquiry — the "Advertise Here" slide's real
// destination. Previously this button just opened a mailto: link, which
// silently does nothing on any device without a configured default mail
// client and leaves no record anywhere on the platform. This follows the
// same real-storage, real-notification pattern as /contact and
// /careers-inquiry: genuinely saved, genuinely alerts the super admin team.
// GET /api/ad-pricing?city=X — the real, current self-serve ad price,
// so a provider sees the actual cost before deciding to submit, not a
// surprise after the fact.
// GET /api/my-ad-status — lets a provider see the real, current status
// of their own self-serve ad, if they have one. Real ad platforms always
// give a seller this visibility rather than leaving them to wonder what
// happened after they paid.
router.get('/my-ad-status', requireAuth, requireRole('provider'), async (req, res) => {
  await require('../ads').endExpiredAds();
  const mine = (await db.filter('advertisingInquiries', a => a.providerId === req.user.sub)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const ad = mine.find(a => a.isLive === true || a.status === 'new');
  // v107: the last one that ended or was turned down, so the pro isn't left guessing.
  const last = !ad ? mine[0] : null;
  const shape = (a) => ({ id: a.id, isLive: a.isLive === true, status: a.status, price: a.price, displayHeadline: a.displayHeadline, displaySubtext: a.displaySubtext, targetCity: a.targetCity, createdAt: a.createdAt, liveUntil: a.liveUntil || null, views: a.views || 0, clicks: a.clicks || 0, declineReason: a.declineReason || null, endedReason: a.endedReason || null });
  res.json({ ad: ad ? shape(ad) : null, last: last ? shape(last) : null });
});

// v107: DELETE /api/my-ad — a pro takes their own ad down, or withdraws
// one that is still waiting. They used to be told to contact support.
router.delete('/my-ad', requireAuth, requireRole('provider'), async (req, res) => {
  const ad = await db.find('advertisingInquiries', a => a.providerId === req.user.sub && (a.isLive === true || a.status === 'new'));
  if (!ad) return res.status(404).json({ error: 'You have no ad running or waiting.' });
  await db.update('advertisingInquiries', ad.id, { isLive: false, status: 'closed', endedAt: new Date().toISOString(), endedReason: ad.isLive ? 'taken_down_by_pro' : 'withdrawn_by_pro' });
  res.json({ ok: true, wasLive: ad.isLive === true });
});

router.get('/ad-pricing', async (req, res) => {
  const { selfServeAdPriceForCity } = require('../ad-pricing');
  const price = await selfServeAdPriceForCity(req.query.city || null);
  res.json({ price });
});

// POST /api/advertising-inquiry/self-serve — an existing, already
// identity-verified provider promoting their own real profile, not an
// outside company. Skips the cold-inquiry contact form (we already know
// exactly who this is), captures the real, current price immediately
// (test-mode, same "genuinely happens, no real money yet" convention as
// every other payment in this app) — but still goes through the same
// quick admin content review before actually going live. The price
// isn't being negotiated at review time, just the content itself.
router.post('/advertising-inquiry/self-serve', requireAuth, requireRole('provider'), async (req, res) => {
  const { displayHeadline, displaySubtext, displayLink, targetCity } = req.body || {};
  const errors = validate([
    ['displayHeadline', isNonEmptyString(displayHeadline, { min: 2, max: 100 }), 'Enter a real headline for your ad'],
    ['displaySubtext', isNonEmptyString(displaySubtext, { min: 5, max: 200 }), 'Enter a short description (at least 5 characters)'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const provider = await db.find('users', u => u.id === req.user.sub);
  // Consistent with every other real-money action already gated by a
  // fraud hold (new bookings, accepting jobs, payouts) — an account
  // under active review shouldn't be able to pay for and submit a new
  // ad in the meantime either.
  if (provider.onHold) {
    return res.status(403).json({ error: 'Your account is temporarily paused pending a quick review — you\'ll be able to submit an ad again shortly.' });
  }
  // A provider paying for a second ad while their first is still pending
  // review or already live isn't a real, separate purchase — it's the
  // same promotion, and letting it happen would mean charging them
  // twice for essentially one thing. Real ad platforms (Etsy, Amazon
  // Seller) all cap this at one active promotion per seller for exactly
  // this reason.
  // v84: only ID-checked pros can advertise, and a link has to be a normal
  // web address. A link used to be stored as typed, including ones that
  // run code when clicked; the page already refused to open those, and the
  // admin approval step already checked, but it shouldn't be stored at all.
  if (provider.verified !== true) {
    return res.status(403).json({ code: 'VERIFY_IDENTITY', error: 'Please verify your identity first. Ads are only for pros whose ID has been reviewed.' });
  }
  const linkTyped = String(displayLink || '').trim();
  if (linkTyped && (!/^https?:\/\/[^\s<>"']+$/i.test(linkTyped) || linkTyped.length > 300)) {
    return res.status(400).json({ error: 'The link must be a web address starting with http:// or https://' });
  }
  const existingActive = await db.find('advertisingInquiries', a => a.providerId === provider.id && (a.isLive === true || a.status === 'new'));
  if (existingActive) {
    return res.status(409).json({ error: existingActive.isLive ? 'You already have a live ad running — take it down first if you want to submit a new one.' : 'You already have an ad pending review — please wait for that one before submitting another.' });
  }
  // A provider can only ever target their own city, or genuinely go
  // platform-wide — never claim to represent a city they're not
  // actually based in.
  const wantsOwnCity = !!targetCity && String(targetCity).trim().toLowerCase() === String(provider.city || '').trim().toLowerCase(); // v107: capital letters and spaces don't matter
  const wantsPlatformWide = !targetCity;
  if (!wantsOwnCity && !wantsPlatformWide) {
    return res.status(400).json({ error: 'You can only target your own city, or the whole platform' });
  }
  const city = wantsOwnCity ? provider.city : null;

  const { selfServeAdPriceForCity } = require('../ad-pricing');
  const price = await selfServeAdPriceForCity(city);

  const submission = {
    id: `ad_${nanoid(10)}`,
    providerId: provider.id,
    companyName: provider.businessName || provider.name,
    contactName: provider.name,
    email: provider.email,
    phone: provider.phone || null,
    message: `Self-serve submission from an existing provider (${provider.category || 'no category set'}).`,
    status: 'new',
    targetCity: city,
    isLive: false, // still requires the same quick admin content review — the price is fixed, but the content isn't approved yet
    price,
    currencyCode: currencyForCountry(provider.country || 'United States').code,
    displayHeadline: displayHeadline.trim(),
    displaySubtext: displaySubtext.trim(),
    displayLink: (displayLink || '').trim() || null,
    createdAt: new Date().toISOString(),
  };
  await db.insert('advertisingInquiries', submission);

  const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
  const regionalAdmins = city ? await require('../admin-scope').regionalAdminsFor({ city }) : []; // v96: country-wide admins too
  const toNotify = [...superAdmins, ...regionalAdmins];
  for (const admin of toNotify) {
    await notify(admin.id, '📣', `${provider.name} (an existing provider) submitted a self-serve ad, already paid ($${price}) — just needs a quick content review${city ? ` for ${city}` : ' (platform-wide)'}`, null, { section: 'advertising' });
  }

  res.json({ submission });
});

router.post('/advertising-inquiry', publicFormLimiter, async (req, res) => {
  const { companyName, contactName, email, phone, message, targetCity } = req.body || {};
  const errors = validate([
    ['companyName', isNonEmptyString(companyName, { min: 2, max: 150 }), 'Enter your company name'],
    ['contactName', isNonEmptyString(contactName, { min: 2, max: 100 }), 'Enter your name'],
    ['email', isNonEmptyString(email, { min: 5, max: 254 }), 'Enter a valid email address'],
    ['message', isNonEmptyString(message, { min: 10, max: 3000 }), 'Tell us a bit about what you have in mind (at least 10 characters)'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  // targetCity is optional — an empty/missing value means "platform-wide",
  // which only a super admin can approve (see admin.routes.js). Any
  // non-empty value is trusted as typed here; it doesn't need to match a
  // real city exactly for the inquiry to be stored, but it won't show up
  // in any regional admin's queue unless it matches their city exactly —
  // that's the same convention used for how a customer's own city already
  // scopes what a regional admin sees everywhere else in the app.
  const city = (targetCity || '').trim() || null;

  const submission = {
    id: `ad_${nanoid(10)}`,
    companyName: companyName.trim(),
    contactName: contactName.trim(),
    email: email.trim(),
    phone: (phone || '').trim() || null,
    message: message.trim(),
    status: 'new',
    targetCity: city,
    isLive: false,
    createdAt: new Date().toISOString(),
  };
  await db.insert('advertisingInquiries', submission);

  // Notify whoever can actually act on this: the regional admin for the
  // targeted city (if there is one), plus every super admin regardless —
  // a platform-wide (city: null) inquiry only reaches super admins, since
  // only they can approve one.
  const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
  const regionalAdmins = city ? await require('../admin-scope').regionalAdminsFor({ city }) : []; // v96: country-wide admins too
  const toNotify = [...superAdmins, ...regionalAdmins];
  for (const admin of toNotify) {
    await notify(admin.id, '📣', `New advertising inquiry from ${submission.companyName} (${submission.contactName})${city ? ` — targeting ${city}` : ' — platform-wide'}`, null, { section: 'advertising' });
  }
  console.log(`[TEST MODE — no email provider connected] Would email sales@trothen.io: new advertising inquiry from ${submission.companyName} <${submission.email}>`);

  res.status(201).json({ ok: true });
});

// POST /api/sales-inquiry — the Custom Plan pricing card's "Contact Sales"
// button. Same bug as "Advertise Here" had: previously a mailto: link,
// meaning it silently did nothing on any device without a configured
// default mail client, and no enterprise lead was ever actually recorded.
// Kept in its own table (not merged with advertisingInquiries) since this
// is a distinct funnel — organizations interested in the platform itself,
// not media partners — that a sales team would want to work separately.
router.post('/sales-inquiry', publicFormLimiter, async (req, res) => {
  const { companyName, contactName, email, teamSize, message } = req.body || {};
  const errors = validate([
    ['companyName', isNonEmptyString(companyName, { min: 2, max: 150 }), 'Enter your company name'],
    ['contactName', isNonEmptyString(contactName, { min: 2, max: 100 }), 'Enter your name'],
    ['email', isNonEmptyString(email, { min: 5, max: 254 }), 'Enter a valid email address'],
    ['message', isNonEmptyString(message, { min: 10, max: 3000 }), 'Tell us a bit about what you need (at least 10 characters)'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const submission = {
    id: `sales_${nanoid(10)}`,
    companyName: companyName.trim(),
    contactName: contactName.trim(),
    email: email.trim(),
    teamSize: (teamSize || '').trim() || null,
    message: message.trim(),
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  await db.insert('salesInquiries', submission);

  const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
  for (const admin of superAdmins) {
    await notify(admin.id, '💼', `New Custom plan sales inquiry from ${submission.companyName} (${submission.contactName})`, null, { section: 'sales' });
  }
  console.log(`[TEST MODE — no email provider connected] Would email sales@trothen.io: new Custom plan inquiry from ${submission.companyName} <${submission.email}>`);

  res.status(201).json({ ok: true });
});

// GET /api/notifications/mine — newest first, so a time-sensitive alert
// (e.g. "your provider has arrived" — item 1) always surfaces at the top
// of the list rather than wherever raw insertion order happened to leave
// it.
router.get('/notifications/mine', requireAuth, async (req, res) => {
  const notifications = (await db.filter('notifications', n => n.userId === req.user.sub))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ notifications });
});

// DELETE /api/notifications/:id — dismiss a single notification for good.
// Previously there was no way to ever actually remove one; marking it
// "read" only ever hid the unread indicator, it stayed in the list
// forever.
router.delete('/notifications/:id', requireAuth, async (req, res) => {
  const record = await db.find('notifications', n => n.id === req.params.id && n.userId === req.user.sub);
  if (!record) return res.status(404).json({ error: 'Notification not found' });
  await db.remove('notifications', record.id);
  res.json({ ok: true });
});

// DELETE /api/notifications — clear every notification for the current
// user at once.
router.delete('/notifications', requireAuth, async (req, res) => {
  const mine = await db.filter('notifications', n => n.userId === req.user.sub);
  for (const n of mine) await db.remove('notifications', n.id);
  res.json({ ok: true, cleared: mine.length });
});

// ── Push notifications (item 2's "background notifications") ───────────────
// GET /api/push/vapid-public-key — the frontend needs this specific value
// to actually create a subscription (PushManager.subscribe requires the
// public key as its applicationServerKey). Deliberately safe to expose
// publicly — a VAPID public key identifies the sender to the push
// service, the same way any public key does; it's the PRIVATE key that
// must never leave the server, and never does.
router.get('/push/vapid-public-key', (req, res) => {
  const { isPushConfigured } = require('../push-notifications');
  res.json({ configured: isPushConfigured(), publicKey: isPushConfigured() ? process.env.VAPID_PUBLIC_KEY : null });
});

// POST /api/push/subscribe — saves a real browser/device push
// subscription (created client-side by PushManager.subscribe(), not
// something the server can fabricate). Keyed by endpoint so the same
// device re-subscribing (e.g. after clearing site data) updates its own
// row instead of piling up duplicates.
router.post('/push/subscribe', requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!isNonEmptyString(endpoint) || !keys || !isNonEmptyString(keys.p256dh) || !isNonEmptyString(keys.auth)) {
    return res.status(400).json({ error: 'A valid push subscription (endpoint + keys.p256dh + keys.auth) is required' });
  }
  const existing = await db.find('pushSubscriptions', s => s.endpoint === endpoint);
  if (existing) {
    await db.update('pushSubscriptions', existing.id, { userId: req.user.sub, p256dh: keys.p256dh, auth: keys.auth });
  } else {
    await db.insert('pushSubscriptions', {
      id: `push_${nanoid(10)}`,
      userId: req.user.sub,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      createdAt: new Date().toISOString(),
    });
  }
  res.json({ ok: true });
});

// POST /api/push/unsubscribe — removes a subscription by endpoint (not
// by ID — the frontend only ever has the endpoint the browser gave it,
// the same value used to look it up when the subscription was created).
router.post('/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  const existing = await db.find('pushSubscriptions', s => s.endpoint === endpoint && s.userId === req.user.sub);
  if (existing) await db.remove('pushSubscriptions', existing.id);
  res.json({ ok: true });
});

// POST /api/notifications/:id/read
router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  const record = await db.find('notifications', n => n.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Notification not found' });
  if (record.userId !== req.user.sub) return res.status(403).json({ error: 'Forbidden' });
  const updated = await db.update('notifications', req.params.id, { read: true });
  res.json({ notification: updated });
});

// GET /api/verification/mine
router.get('/verification/mine', requireAuth, async (req, res) => {
  const records = await db.filter('verifications', v => v.userId === req.user.sub);
  res.json({ verifications: records.map(({ documentFilename, selfieFilename, backFilename, ...rest }) => rest) });
});

// GET /api/verification/doc-types — the real, country-aware list of
// accepted ID types for the signed-in user's own country (item 7), so the
// frontend never has to hardcode or guess which IDs are valid where.
router.get('/verification/doc-types', requireAuth, async (req, res) => {
  const { idDocTypesForCountry } = require('../geo-data');
  const user = await db.find('users', u => u.id === req.user.sub);
  res.json({ docTypes: idDocTypesForCountry(user ? user.country : null) });
});

const verificationDocStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, require('../uploads').PRIVATE_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = file.mimetype === 'application/pdf' ? '.pdf' : (path.extname(file.originalname).toLowerCase() || '.jpg');
    // v77: the face photo is stored beside the ID under its own prefix.
    cb(null, `${file.fieldname === 'selfie' ? 'versel' : file.fieldname === 'documentBack' ? 'verback' : 'verdoc'}_${req.user.sub}_${nanoid(16)}${ext}`);
  },
});
const verificationDocFileFilter = (req, file, cb) => {
  // v80: WEBP accepted too. HEIC (some phones' own format) can't be opened
  // in a reviewer's browser, so it's refused with a message that says what
  // to do instead of a bare "wrong type".
  const heic = /heic|heif/i.test(file.mimetype || '') || /\.hei[cf]$/i.test(file.originalname || '');
  const heicHelp = 'That photo is in HEIC format, which we can\'t open. Take the photo again from this page, or save it as JPEG first.';
  if (file.fieldname === 'selfie') {
    if (heic) return cb(new Error(heicHelp));
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return cb(new Error('The photo of your face must be a JPEG, PNG or WEBP image'));
    return cb(null, true);
  }
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (heic) return cb(new Error(heicHelp));
  if (!allowed.includes(file.mimetype)) return cb(new Error('Your ID must be a JPEG, PNG or WEBP photo, or a PDF'));
  cb(null, true);
};
// v80: 15MB per file. The page shrinks photos before sending, so this is
// only the ceiling for a browser that couldn't.
const uploadVerificationDoc = multer({ storage: verificationDocStorage, fileFilter: verificationDocFileFilter, limits: { fileSize: 15 * 1024 * 1024 } });

// POST /api/verification/submit — real document upload for manual review.
// Previously this only accepted a text label like "Government ID" with no
// actual file attached — admins had nothing to review when approving or
// rejecting. Now takes the real file (verified by its actual bytes, not
// the claimed content-type — see verifyImageMagicBytes/verifyPdfMagicBytes),
// the docType (validated against the submitter's own country's real
// accepted-ID list — item 7/8's country-aware requirement), and the legal
// name as printed on the ID for name matching (item 7).
router.post('/verification/submit', requireAuth, (req, res, next) => {
  uploadVerificationDoc.fields([{ name: 'document', maxCount: 1 }, { name: 'documentBack', maxCount: 1 }, { name: 'selfie', maxCount: 1 }])(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? 'One of those files is too big. Each file can be up to 15MB. Try taking the photo again, a little further back.' : (err.message || 'Document upload failed') });
    }
    // v77: two files now. The rest of this route reads the ID as req.file.
    // v80: an optional third, the back of the ID.
    req.backFile = (req.files && req.files.documentBack && req.files.documentBack[0]) || null;
    req.selfieFile = (req.files && req.files.selfie && req.files.selfie[0]) || null;
    req.file = (req.files && req.files.document && req.files.document[0]) || null;
    next();
  });
}, async (req, res) => {
  const { docType, idLegalName } = req.body || {};
  const { verifyImageMagicBytes, verifyPdfMagicBytes, PRIVATE_UPLOADS_DIR } = require('../uploads');
  const { idDocTypesForCountry } = require('../geo-data');
  const { namesLikelyMatch } = require('../validators');

  const cleanup = () => {
    for (const f of [req.file, req.selfieFile, req.backFile]) { if (f) { try { fs.unlinkSync(path.join(PRIVATE_UPLOADS_DIR, f.filename)); } catch (e) {} } }
  };
  if (!req.file) { cleanup(); return res.status(400).json({ error: 'A document file is required' }); }
  // v77: a photo of the person's face is required with every ID, so the
  // reviewer can check the person submitting is the person on the document.
  if (!req.selfieFile) { cleanup(); return res.status(400).json({ error: 'Please add a photo of your face as well. We compare it with the photo on your ID.' }); }
  if (!verifyImageMagicBytes(path.join(PRIVATE_UPLOADS_DIR, req.selfieFile.filename), req.selfieFile.mimetype)) {
    cleanup();
    return res.status(400).json({ error: 'The photo of your face doesn\'t look like a real photo file. Please take it again.' });
  }
  if (req.backFile) {
    const backOk = req.backFile.mimetype === 'application/pdf'
      ? verifyPdfMagicBytes(path.join(PRIVATE_UPLOADS_DIR, req.backFile.filename))
      : verifyImageMagicBytes(path.join(PRIVATE_UPLOADS_DIR, req.backFile.filename), req.backFile.mimetype);
    if (!backOk) { cleanup(); return res.status(400).json({ error: 'The back of your ID doesn\'t look like a real photo or PDF. Please add it again.' }); }
  }

  // At most 5 submissions a day per account. Real people rarely need more
  // than two tries; someone cycling through many different IDs is a
  // pattern reviewers should never have to wade through.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentSubmissions = await db.filter('verifications', v => v.userId === req.user.sub && v.createdAt >= dayAgo && v.source !== 'persona');
  if (recentSubmissions.length >= 5) {
    cleanup();
    return res.status(429).json({ error: 'You\'ve submitted several documents today. Please wait until tomorrow, or contact support if something isn\'t working.' });
  }

  if (!isNonEmptyString(idLegalName, { min: 2, max: 150 })) {
    cleanup();
    return res.status(400).json({ error: 'Enter the full legal name exactly as printed on the document' });
  }

  const user = await db.find('users', u => u.id === req.user.sub);
  const allowedTypes = idDocTypesForCountry(user ? user.country : null);
  if (!isNonEmptyString(docType) || !allowedTypes.includes(docType.trim())) {
    cleanup();
    return res.status(400).json({ error: `docType must be one of: ${allowedTypes.join(', ')}` });
  }

  const filePath = path.join(PRIVATE_UPLOADS_DIR, req.file.filename);
  const bytesValid = req.file.mimetype === 'application/pdf'
    ? verifyPdfMagicBytes(filePath)
    : verifyImageMagicBytes(filePath, req.file.mimetype);
  if (!bytesValid) {
    cleanup();
    return res.status(400).json({ error: 'That file doesn\'t look like a genuine document of the type it claims to be — please re-upload' });
  }

  // A previous rejected/review-required submission gets superseded, not
  // stacked — this IS the resubmission (item 12's "resubmission where
  // appropriate"), so the old record's file reference is cleared from
  // active review rather than leaving duplicate open records.
  const previousOpen = await db.filter('verifications', v => v.userId === req.user.sub && ['pending', 'review_required'].includes(v.status));
  for (const old of previousOpen) await db.update('verifications', old.id, { status: 'superseded' });

  const nameMatch = namesLikelyMatch(user ? user.name : '', idLegalName);
  const record = {
    id: `ver_${nanoid(10)}`,
    userId: req.user.sub,
    docType: docType.trim(),
    idLegalName: idLegalName.trim(),
    nameMatch,
    documentFilename: req.file.filename,
    selfieFilename: req.selfieFile.filename,
    backFilename: req.backFile ? req.backFile.filename : null,
    // v82: true when the three files were encrypted before being stored
    // (only happens when ID_FILE_ENCRYPTION_KEY is set on the server).
    encrypted: (() => {
      const fc = require('../file-crypto');
      if (!fc.isEnabled()) return false;
      for (const f of [req.file, req.selfieFile, req.backFile]) if (f) fc.encryptFileInPlace(path.join(PRIVATE_UPLOADS_DIR, f.filename));
      return true;
    })(),
    // item 12: a real Pending → Approved/Rejected/Review Required
    // pipeline, not a single vague "in review" bucket. A name that
    // doesn't clearly match gets routed to review_required automatically
    // rather than silently passing or silently blocking — a human makes
    // the actual call on legitimate differences (item 7).
    status: nameMatch ? 'pending' : 'review_required',
    source: 'upload',
    rejectionReason: null,
    // Item (best practice): a real review SLA, the same idea already
    // used for fraud flags (src/fraud-detection.js) — without this, a
    // submission could sit untouched indefinitely with nothing to
    // surface that it's overdue. 48 hours is standard practice for
    // manual identity review — enough time for a real human queue, not
    // so long that someone waiting to start work never hears back.
    reviewDeadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  await db.insert('verifications', record);

  // v107: the regional admins for this person, including an admin who
  // covers the whole country and cities typed with different capitals.
  // Before, only an admin whose city matched letter for letter was told.
  const regionalIds = new Set((await require('../admin-scope').regionalAdminsFor({ city: user.city, country: user.country })).map(a => a.id));
  const reviewers = await db.filter('users', u => u.role === 'admin' && u.active !== false && (u.isSuperAdmin || u.adminDepartment === 'verification' || regionalIds.has(u.id)));
  if (!nameMatch) {
    const admins = reviewers;
    for (const admin of admins) {
      await notify(admin.id, '⚠️', `${user.name}'s submitted ID name ("${idLegalName.trim()}") doesn't clearly match their account name — needs manual review.`, null, { section: 'verification' });
    }
  } else {
    // Item (best practice): a normal, clean submission — the common
    // case, not the exception — used to notify no one at all. It just
    // sat in the queue until an admin happened to check manually. A
    // real review queue tells reviewers when something new actually
    // needs them, not just the flagged exceptions.
    const admins = reviewers;
    for (const admin of admins) {
      await notify(admin.id, '🪪', `${user.name} (${user.role === 'customer' ? 'customer' : 'pro'}) submitted identity verification — ready for review.`, null, { section: 'verification' });
    }
  }

  // v77: file names stay on the server; the person only needs the status.
  const { documentFilename, selfieFilename, backFilename, ...safeRecord } = record;
  res.status(201).json({ verification: safeRecord });
});

// GET /api/verification/start — whether real, live ID verification
// (Persona) is actually connected. When it is, hands back the hosted
// flow URL to send the person to; the result comes back later via the
// Persona webhook below, not synchronously here. When it isn't
// configured, the frontend falls back to the existing manual
// document-upload + admin-review flow (POST /verification/submit above)
// — same honest "tell the truth about what's real" pattern used
// elsewhere in this app for payments and notifications.
router.get('/verification/start', requireAuth, async (req, res) => {
  const { isPersonaConfigured, isPersonaWebhookConfigured, buildHostedFlowUrl } = require('../persona-verification');
  if (!isPersonaConfigured() || !isPersonaWebhookConfigured()) {
    return res.json({ configured: false });
  }
  res.json({ configured: true, hostedFlowUrl: buildHostedFlowUrl(req.user.sub) });
});

// POST /api/webhooks/persona — real-time result from Persona once someone
// completes (or fails) hosted verification. Public — Persona calls this
// directly, not a signed-in user — so trust comes entirely from the
// signature check, not from auth middleware. Rejects anything that
// doesn't verify rather than trusting the payload's own claims about
// who it's for.
router.post('/webhooks/persona', async (req, res) => {
  const { verifyWebhookSignature } = require('../persona-verification');
  const signature = req.headers['persona-signature'];
  if (!req.rawBody || !verifyWebhookSignature(req.rawBody.toString('utf8'), signature)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const event = req.body;
  const eventId = event && event.data && event.data.id;
  const eventType = event && event.data && event.data.attributes && event.data.attributes.name;
  const inquiry = event && event.data && event.data.attributes && event.data.attributes.payload && event.data.attributes.payload.data;
  const userId = inquiry && inquiry.attributes && inquiry.attributes['reference-id'];
  if (!userId) return res.status(200).json({ ok: true }); // nothing to act on, but acknowledge receipt so Persona doesn't retry forever

  // Persona retries until it gets a 200, so the same event can arrive
  // more than once. Each one is acted on only the first time.
  if (eventId && await db.find('verifications', v => v.personaEventId === eventId)) return res.status(200).json({ ok: true, duplicate: true });

  const user = await db.find('users', u => u.id === userId);
  if (!user) return res.status(200).json({ ok: true });

  const { personaVerifiedName } = require('../persona-verification');
  const { namesLikelyMatch } = require('../validators');
  const idName = personaVerifiedName(inquiry);
  const base = {
    id: `ver_${nanoid(10)}`, userId: user.id, docType: 'ID + selfie (Persona, automated)', source: 'persona',
    personaEventId: eventId || null, personaInquiryId: inquiry.id || null, idLegalName: idName,
    createdAt: new Date().toISOString(),
  };
  const notifyReviewers = async (message) => {
    const admins = await db.filter('users', u => u.role === 'admin' && (u.isSuperAdmin || u.adminDepartment === 'verification' || (!u.adminDepartment && u.city === user.city)));
    for (const admin of admins) await notify(admin.id, '⚠️', message, null, { section: 'verification' });
  };

  if (eventType === 'inquiry.approved') {
    // Persona confirms the ID is genuine and the selfie matches it. It
    // doesn't know whose Trothen account this is meant to be, so the name
    // on the ID is compared with the account name before the badge goes
    // on. A mismatch goes to a person instead of approving automatically.
    const nameMatch = idName ? namesLikelyMatch(user.name, idName) : true;
    if (nameMatch) {
      await db.update('users', user.id, { verified: true });
      await db.insert('verifications', { ...base, nameMatch: idName ? true : null, status: 'approved', reviewedBy: 'persona', reviewedAt: new Date().toISOString() });
      await notify(user.id, '✅', 'Your identity was verified automatically.', null, { section: 'verification' });
    } else {
      await db.insert('verifications', { ...base, nameMatch: false, status: 'review_required', reviewDeadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() });
      await notifyReviewers(`${user.name}'s automated ID check passed, but the name on the ID ("${idName}") doesn't match the account name — needs manual review.`);
      await notify(user.id, '🪪', 'Your ID was checked. A member of our team is confirming a few details and will finish your verification shortly.', null, { section: 'verification' });
    }
  } else if (eventType === 'inquiry.declined' || eventType === 'inquiry.failed') {
    await db.insert('verifications', { ...base, nameMatch: null, status: 'review_required', reviewDeadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() });
    await notifyReviewers(`${user.name}'s automated ID verification didn't pass — needs manual review.`);
    await notify(user.id, '⚠️', 'Automated identity verification didn\'t go through — a real person will review it shortly.', null, { section: 'verification' });
  }
  res.status(200).json({ ok: true });
});

// GET /api/messages/:withUserId — simple thread between the logged-in user and another
router.get('/messages/:withUserId', requireAuth, async (req, res) => {
  const { jobId } = req.query;
  const all = (await db.filter('messages', m =>
    (m.fromId === req.user.sub && m.toId === req.params.withUserId) ||
    (m.toId === req.user.sub && m.fromId === req.params.withUserId)
  ))
    .filter(m => !jobId || m.jobId === jobId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ messages: all });
});

// POST /api/messages — send a message
// POST /api/support-chat/ask — real chat intelligence, not keyword
// matching. Anonymous visitors can use this too (the chat widget is
// visible on the public homepage), so no auth is required, but it's
// rate-limited since each real question costs a real API call. Fails
// honestly (a clear error, not a fabricated answer) if the API key
// isn't configured, so the frontend can fall back to the existing FAQ +
// human-handoff path rather than silently pretending to be smarter than
// it is.
router.post('/support-chat/ask', supportChatLimiter, async (req, res) => {
  const { message, history } = req.body || {};
  if (!isNonEmptyString(message, { min: 1, max: 1000 })) {
    return res.status(400).json({ error: 'Enter a real question (up to 1000 characters)' });
  }
  try {
    const { askSupportChat } = require('../support-chat');
    const answer = await askSupportChat(message, Array.isArray(history) ? history : []);
    res.json({ answer });
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') {
      return res.status(503).json({ error: 'not_configured' });
    }
    console.error('[support-chat] Real API call failed:', e.message);
    res.status(502).json({ error: 'Could not reach the assistant right now — try again, or talk to a real person.' });
  }
});

router.post('/messages', requireAuth, messageLimiter, async (req, res) => {
  const { toId, text, jobId } = req.body || {};
  const errors = validate([
    ['toId', isNonEmptyString(toId), 'Recipient is required'],
    ['text', isNonEmptyString(text, { min: 1, max: 2000 }), 'Message cannot be empty'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const recipient = await db.find('users', u => u.id === toId);
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

  let job = null;
  if (jobId) {
    job = await db.find('jobs', j => j.id === jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    // Whoever's sending this must actually be one of the two real parties
    // to that job — either the customer who posted it, or a provider
    // messaging that customer about it. Stops a jobId being attached to a
    // conversation neither side of the job is actually part of.
    const isJobCustomer = job.customerId === req.user.sub && recipient.id !== job.customerId;
    const isJobProvider = recipient.id === job.customerId && req.user.role === 'provider';
    if (!isJobCustomer && !isJobProvider) return res.status(403).json({ error: 'This job doesn\'t belong to either you or the person you\'re messaging' });
  }

  const message = { id: `msg_${nanoid(10)}`, fromId: req.user.sub, toId, text: text.trim(), jobId: jobId || null, createdAt: new Date().toISOString() };
  await db.insert('messages', message);

  const sender = await db.find('users', u => u.id === req.user.sub);
  await notify(toId, '💬', `New message from ${sender ? sender.name : 'someone'}: "${text.trim().slice(0, 50)}${text.length > 50 ? '…' : ''}"`, 'messages', { section: 'messages', contactId: req.user.sub, jobId: jobId || undefined });

  // A provider messaging a customer about their open job is a real
  // response, the same as clicking "I'm Interested" — this keeps the
  // job's candidate list honest even for a provider who jumped straight
  // to negotiating instead of clicking the button first. Only touches
  // the match if one already exists and is still just 'pending'; never
  // overwrites 'interested', 'accepted', or 'not_selected'.
  if (job && req.user.sub !== job.customerId) {
    const match = await db.find('matches', m => m.jobId === job.id && m.providerId === req.user.sub);
    if (match && match.status === 'pending') {
      await db.update('matches', match.id, { status: 'interested' });
    }
  }

  res.status(201).json({ message });
});

// GET /api/referrals/mine — a customer or provider's own referral code
// and who's actually joined through it so far. Every account gets a
// referral code at signup (see auth.routes.js), so this never 404s for a
// real signed-in user. Referred people are shown as first name + last
// initial only — enough to feel real without exposing a referred
// person's full identity to whoever referred them.
// GET /api/provider-score/mine — a provider's own real, live trust score
// and breakdown, the same numbers an admin sees, so there's nothing
// hidden about how it's calculated.
// GET /api/promotions/mine — active promotions actually meant for this
// person: matching their role (or posted to 'both'), and either
// platform-wide or specifically targeting their own city. Expired ones
// (past expiresAt) are filtered out here too, so nothing stale ever
// reaches a dashboard even if an admin forgets to deactivate it.
router.get('/promotions/mine', requireAuth, async (req, res) => {
  if (!['customer', 'provider'].includes(req.user.role)) return res.json({ promotions: [] });
  const me = await db.find('users', u => u.id === req.user.sub);
  const audienceKey = req.user.role === 'customer' ? 'customers' : 'providers';
  const now = new Date();
  const all = await db.filter('promotions', p =>
    p.active &&
    (p.audience === audienceKey || p.audience === 'both') &&
    (!p.region || p.region === (me && me.city) || p.region === (me && me.country)) && // v90: a promotion can target a city or a whole country
    (!p.expiresAt || new Date(p.expiresAt) > now)
  );
  res.json({ promotions: all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

router.get('/provider-score/mine', requireAuth, requireRole('provider'), async (req, res) => {
  const { computeProviderScore } = require('../provider-score');
  const result = await computeProviderScore(req.user.sub);
  if (!result) return res.status(404).json({ error: 'Account not found' });
  res.json(result);
});

// GET /api/favorites/mine — a customer's saved favorite providers, with
// real, current profile data (not a stale snapshot from when they
// favorited) so a rating or trust score change shows up correctly.
// GET /api/membership/tiers — Joseph's report: "membership subscription
// must be universal instead of USA only." The backend itself never
// restricted this to the US (any customer, any country, could already
// call /membership/subscribe) — what was actually missing is that the
// price shown was always a raw "$9.99", with no conversion, regardless
// of where the customer actually is. To someone outside the US that
// reasonably reads as "this is a US-only feature," even though it
// wasn't. This reuses the exact same currencyForCountry / convertFromUSD
// / resolveRate path every contract amount already goes through (see
// fundEscrowForContract in marketplace.routes.js) — one real conversion
// system, not a second one invented just for membership.
router.get('/membership/tiers', requireAuth, async (req, res) => {
  const { MEMBERSHIP_TIERS, resolveMembershipPrice } = require('../membership');
  const { currencyForCountry, convertFromUSD } = require('../currency-data');
  const { resolveRate } = require('../plan-pricing');
  const me = await db.find('users', u => u.id === req.user.sub);
  const currency = currencyForCountry(me ? me.country : 'United States');
  const rate = currency.code !== 'USD' ? resolveRate(currency.code, await db.all('exchangeRates')) : null;
  const baseRows = await db.all('membershipPricingBase');
  const tiers = {};
  for (const key of Object.keys(MEMBERSHIP_TIERS)) {
    const cfg = MEMBERSHIP_TIERS[key];
    const price = resolveMembershipPrice(key, baseRows);
    tiers[key] = {
      ...cfg,
      price,
      priceLocal: price != null && currency.code !== 'USD' ? convertFromUSD(price, currency.code, rate) : price,
      currencyCode: currency.code,
      currencySymbol: currency.symbol,
    };
  }
  res.json({ tiers, currency });
});

// POST /api/membership/subscribe — starts (or changes) a customer's paid
// membership tier. Simulated the same way every other payment in this
// app is right now (no real Stripe integration yet). VIP is deliberately
// rejected here even if requested — see src/membership.js for why it's
// never self-purchasable at any price.
router.post('/membership/subscribe', requireAuth, requireRole('customer'), async (req, res) => {
  const { MEMBERSHIP_TIERS, resolveMembershipPrice } = require('../membership');
  const { tier } = req.body || {};
  const config = MEMBERSHIP_TIERS[tier];
  if (!config || !config.selfServe) {
    return res.status(400).json({ error: 'tier must be plus, pro, or elite' });
  }
  const me = await db.find('users', u => u.id === req.user.sub);
  if (me.membershipTier === tier) return res.status(400).json({ error: `You're already on the ${config.label} tier` });
  const realPrice = resolveMembershipPrice(tier, await db.all('membershipPricingBase'));
  const updated = await db.update('users', me.id, {
    membershipTier: tier,
    membershipStartedAt: new Date().toISOString(),
    membershipPrice: realPrice,
  });
  await notify(me.id, '⭐', `Welcome to Trothen ${config.label}! $${realPrice}/month, cancel or change anytime.`, null, { section: 'settings' });
  res.json({ user: updated });
});

// POST /api/membership/cancel — drops back to Free, no dark patterns:
// takes effect immediately, one call, no retention flow in the way.
router.post('/membership/cancel', requireAuth, requireRole('customer'), async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!me.membershipTier || me.membershipTier === 'free') return res.status(400).json({ error: 'You\'re already on the Free tier' });
  const updated = await db.update('users', me.id, { membershipTier: 'free', membershipCancelledAt: new Date().toISOString(), membershipPrice: null });
  await notify(me.id, '👋', 'Your Trothen membership has been cancelled — no further charges. You\'re back on the Free tier.', null, { section: 'settings' });
  res.json({ user: updated });
});

// GET /api/loyalty/mine — a customer's real points balance, and how
// close they are to a free-booking credit (see src/loyalty.js for
// exactly how points are earned and redeemed).
router.get('/loyalty/mine', requireAuth, requireRole('customer'), async (req, res) => {
  const { POINTS_FOR_FREE_BOOKING } = require('../loyalty');
  const me = await db.find('users', u => u.id === req.user.sub);
  const points = (me && me.loyaltyPoints) || 0;
  res.json({
    points,
    pointsForFreeBooking: POINTS_FOR_FREE_BOOKING,
    freeBookingsAvailable: Math.floor(points / POINTS_FOR_FREE_BOOKING),
    pointsUntilNext: POINTS_FOR_FREE_BOOKING - (points % POINTS_FOR_FREE_BOOKING),
  });
});

// POST /api/provider/guarantors — a provider submits up to 3 real
// guarantors (see the Guarantors panel on the Verification screen for
// the full context: this exists for regions without real background-
// check infrastructure available yet). Always optional — this endpoint
// is never required to complete verification, and an empty array is a
// valid, accepted request (clearing previously-saved guarantors).
router.post('/provider/guarantors', requireAuth, requireRole('provider'), async (req, res) => {
  const { guarantors } = req.body || {};
  if (!Array.isArray(guarantors) || guarantors.length > 3) {
    return res.status(400).json({ error: 'guarantors must be a list of up to 3' });
  }
  for (const g of guarantors) {
    if (!isNonEmptyString(g.name, { min: 2, max: 100 }) || !isNonEmptyString(g.phone, { min: 7, max: 30 })) {
      return res.status(400).json({ error: 'Each guarantor needs at least a real name and phone number' });
    }
  }
  // v106: a guarantor is someone ELSE who vouches for the pro. One with the
  // pro's own phone number or name, or the same person listed twice, is
  // refused, because calling them proves nothing.
  const meForCheck = await db.find('users', u => u.id === req.user.sub);
  const { guarantorProblem } = require('../guarantor-check');
  const seenPhones = new Set();
  for (const g of guarantors) {
    const why = guarantorProblem(meForCheck, g);
    if (why === 'phone') return res.status(400).json({ error: `"${String(g.name).trim()}" has your own phone number. A guarantor must be another person, with their own number.` });
    if (why === 'name') return res.status(400).json({ error: 'You can\'t be your own guarantor. Name someone else who knows you and your work.' });
    const key = require('../guarantor-check').phoneKey(g.phone);
    if (seenPhones.has(key)) return res.status(400).json({ error: 'Two of your guarantors have the same phone number. Each one must be a different person.' });
    seenPhones.add(key);
  }
  const existing = meForCheck.guarantors || [];
  // Preserve any existing verification status when a provider re-saves
  // (e.g. edits guarantor #2's phone number) — matching by phone number,
  // since that's the one field the verification team actually uses to
  // reach them and the most stable identifier across an edit.
  const merged = guarantors.map(g => {
    const prior = existing.find(e => e.phone === g.phone);
    return {
      name: g.name.trim(),
      phone: g.phone.trim(),
      relationship: g.relationship ? g.relationship.trim() : null,
      status: prior ? prior.status : 'submitted',
      contactedAt: prior ? prior.contactedAt : null,
    };
  });
  const updated = await db.update('users', req.user.sub, { guarantors: merged });
  if (merged.length > 0) {
    const verificationAdmins = await db.filter('users', u => u.role === 'admin' && u.adminDepartment === 'verification');
    const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
    for (const admin of (verificationAdmins.length ? verificationAdmins : superAdmins)) {
      await notify(admin.id, '📋', `${updated.name} submitted ${merged.length} guarantor${merged.length === 1 ? '' : 's'} for review — a real person to call for background-check purposes.`, null, { section: 'verification' });
    }
  }
  res.json({ user: updated });
});

router.get('/favorites/mine', requireAuth, requireRole('customer'), async (req, res) => {
  const favorites = (await db.filter('favoriteProviders', f => f.customerId === req.user.sub))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const providers = (await Promise.all(favorites.map(async f => {
    const provider = await db.find('users', u => u.id === f.providerId && u.role === 'provider');
    if (!provider) return null;
    const { publicProvider } = require('./marketplace.routes');
    return { favoriteId: f.id, ...publicProvider(provider) };
  }))).filter(Boolean);
  res.json({ providers });
});

// GET /api/favorites/check/:providerId — whether this specific provider
// is already in the customer's favorites, for showing the right
// state (filled vs outline heart) on a profile or card.
router.get('/favorites/check/:providerId', requireAuth, requireRole('customer'), async (req, res) => {
  const favorite = await db.find('favoriteProviders', f => f.customerId === req.user.sub && f.providerId === req.params.providerId);
  res.json({ isFavorite: !!favorite, favoriteId: favorite ? favorite.id : null });
});

// POST /api/favorites — save a provider as a favorite.
router.post('/favorites', requireAuth, requireRole('customer'), async (req, res) => {
  const { providerId } = req.body || {};
  if (!isNonEmptyString(providerId)) return res.status(400).json({ error: 'providerId is required' });
  const provider = await db.find('users', u => u.id === providerId && u.role === 'provider');
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const existing = await db.find('favoriteProviders', f => f.customerId === req.user.sub && f.providerId === providerId);
  if (existing) return res.json({ favorite: existing }); // already favorited — not an error, just a no-op
  const favorite = { id: `fav_${nanoid(10)}`, customerId: req.user.sub, providerId, createdAt: new Date().toISOString() };
  await db.insert('favoriteProviders', favorite);
  res.status(201).json({ favorite });
});

// DELETE /api/favorites/:providerId — remove a provider from favorites.
router.delete('/favorites/:providerId', requireAuth, requireRole('customer'), async (req, res) => {
  const existing = await db.find('favoriteProviders', f => f.customerId === req.user.sub && f.providerId === req.params.providerId);
  if (!existing) return res.status(404).json({ error: 'Not in your favorites' });
  await db.remove('favoriteProviders', existing.id);
  res.json({ ok: true });
});

router.get('/referrals/mine', requireAuth, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!me) return res.status(404).json({ error: 'Account not found' });
  let code = me.referralCode;
  if (!code) {
    // An account created before referrals existed — give it a real code
    // now rather than leaving this feature permanently unavailable to
    // everyone who signed up before this shipped.
    code = await generateUniqueReferralCode();
    await db.update('users', me.id, { referralCode: code });
  }
  const records = (await db.filter('referrals', r => r.referrerId === me.id))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const referred = await Promise.all(records.map(async r => {
    const u = await db.find('users', u => u.id === r.referredUserId);
    if (!u) return null;
    const parts = u.name.split(' ');
    const displayName = parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : parts[0];
    return { name: displayName, role: r.referredRole, joinedAt: r.createdAt };
  }));
  res.json({
    code,
    totalReferred: records.length,
    referred: referred.filter(Boolean),
  });
});

module.exports = router;
