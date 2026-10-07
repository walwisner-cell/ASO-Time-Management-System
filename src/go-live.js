// Everything needed to move Trothen from "demo + test data" to real people
// and real accounts, in one place.
//
// Why this exists: the first time the app boots on an empty database it
// seeds demo accounts (fake providers, fake customers, fake admins, fake
// contracts and reviews) that all share one password written in the
// source code. The regular Data Cleanup tool deliberately never touches
// those demo accounts or anything with a contract, so after "clean
// everything" they were all still there: fake pros showing up in real
// customers' searches, and a super admin account anyone who reads the
// code could sign into. There was also no way at all to create a real
// super admin — the only one that existed was the demo one.

const { nanoid } = require('nanoid');
const db = require('./db');
const { hashPassword, verifyPassword } = require('./auth');

// Same value as DEMO_PASSWORD in src/seed.js (kept in sync by hand on
// purpose — seed.js runs its seeding code when required directly).
const DEMO_PASSWORD = 'trothen123';

// The fixed ids the seed file has always used, plus the demo email
// addresses (older demo data from the Taskora days had no isSeedAccount
// flag, so ids and emails are checked too). "example.com" is a domain
// reserved by internet standards for examples — no real person has an
// address there, so it is always demo data.
const SEED_IDS = new Set([
  'u_jordan', 'u_marcus', 'u_aisha', 'u_james', 'u_sofia', 'u_deshawn', 'u_priya', 'u_tom', 'u_keisha',
  'u_emeka', 'u_chioma', 'u_grace', 'u_ama', 'u_amara', 'u_ngozi', 'u_kwame', 'u_superadmin',
]);
const DEMO_EMAILS = new Set(['superadmin@trothen.io', 'superadmin@taskora.io']);

function isDemoAccount(u) {
  if (!u) return false;
  const email = String(u.email || '').trim().toLowerCase();
  return !!(u.isSeedAccount || SEED_IDS.has(u.id) || DEMO_EMAILS.has(email) || email.endsWith('@example.com'));
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

async function usesDemoPassword(user) {
  if (!user || !user.passwordHash) return false;
  try { return await verifyPassword(DEMO_PASSWORD, user.passwordHash); } catch (e) { return false; }
}

// Every collection that can hold a record belonging to a person. Audit
// logs (accessLogs, dataCleanupAuditLog, goLiveAuditLog) are deliberately
// NOT here — they are compliance records and are never deleted.
const PERSON_COLLECTIONS = [
  'contracts', 'escrowTransactions', 'payouts', 'disputes', 'disputeEvidence', 'disputeAuditLog',
  'reviews', 'jobs', 'matches', 'messages', 'notifications', 'verifications', 'paymentMethods',
  'portfolioPhotos', 'favoriteProviders', 'referrals', 'scopeChangeRequests', 'sessions',
  'pushSubscriptions', 'passwordResets', 'pendingLogins', 'phoneVerifications', 'fraudFlags',
  'promotions', 'organizationInvites',
  'storeGoods', 'proTools', 'proExpenses', 'proDocs', // v105: pro stores and business tools
];
const PERSON_FIELDS = ['userId', 'customerId', 'providerId', 'fromId', 'toId', 'referrerId', 'referredUserId', 'reviewerId', 'authorId', 'contactId'];

async function safeAll(collection) {
  try { return await db.all(collection); } catch (e) { return []; }
}

// Works out exactly what would be removed, without removing anything.
async function planDemoRemoval(keepUserIds = []) {
  const keep = new Set(keepUserIds);
  const users = await db.all('users');
  const demoUsers = users.filter(u => isDemoAccount(u) && !keep.has(u.id));
  const demoIds = new Set(demoUsers.map(u => u.id));

  const plan = { users: demoUsers, records: {} };
  // Contracts and jobs first, so records that only point at a contract or
  // job (escrow, disputes, matches, evidence) go with them.
  const contracts = (await safeAll('contracts')).filter(c => demoIds.has(c.customerId) || demoIds.has(c.providerId));
  const contractIds = new Set(contracts.map(c => c.id));
  const jobs = (await safeAll('jobs')).filter(j => demoIds.has(j.customerId) || demoIds.has(j.userId));
  const jobIds = new Set(jobs.map(j => j.id));
  const disputes = (await safeAll('disputes')).filter(d => contractIds.has(d.contractId) || PERSON_FIELDS.some(f => demoIds.has(d[f])));
  const disputeIds = new Set(disputes.map(d => d.id));

  for (const col of PERSON_COLLECTIONS) {
    let rows;
    if (col === 'contracts') rows = contracts;
    else if (col === 'jobs') rows = jobs;
    else if (col === 'disputes') rows = disputes;
    else {
      rows = (await safeAll(col)).filter(r =>
        PERSON_FIELDS.some(f => r[f] && demoIds.has(r[f])) ||
        (r.contractId && contractIds.has(r.contractId)) ||
        (r.jobId && jobIds.has(r.jobId)) ||
        (r.disputeId && disputeIds.has(r.disputeId)));
    }
    if (rows.length) plan.records[col] = rows;
  }
  plan.cities = (await safeAll('cities')).filter(c => c.adminId && demoIds.has(c.adminId));
  return plan;
}

async function executeDemoRemoval(keepUserIds, actor) {
  const plan = await planDemoRemoval(keepUserIds);
  const counts = { accounts: plan.users.length };
  for (const [col, rows] of Object.entries(plan.records)) {
    for (const r of rows) await db.remove(col, r.id);
    counts[col] = rows.length;
  }
  // A city stays (it's a real place real people may sign up in); it just
  // stops pointing at a demo admin who no longer exists.
  for (const c of plan.cities) await db.update('cities', c.id, { adminId: null });
  for (const u of plan.users) await db.remove('users', u.id);
  // Demo reviews were only ever attached to demo providers, so no real
  // provider's rating changes.
  await db.insert('goLiveAuditLog', {
    id: `gla_${nanoid(10)}`,
    action: 'remove_demo_data',
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.name : 'Unknown',
    accountsRemoved: plan.users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
    counts,
    createdAt: new Date().toISOString(),
  });
  return counts;
}

function initialsFor(name) {
  return String(name).trim().split(/\s+/).map(p => p[0]).slice(0, 2).join('').toUpperCase();
}

// A real super admin. The password given here is temporary: the account
// is forced to set its own on first sign-in (mustChangePassword), and
// two-factor is on from the start, same as every other admin.
async function createSuperAdmin({ name, email, password }) {
  const record = {
    id: `u_${nanoid(10)}`,
    name: name.trim(),
    email: email.trim(),
    role: 'admin',
    city: null, country: null, region: null,
    isSuperAdmin: true,
    adminDepartment: null,
    active: true,
    verified: true,
    initials: initialsFor(name),
    passwordHash: hashPassword(password),
    mustChangePassword: true,
    twoFactorEnabled: true,
    createdAt: new Date().toISOString(),
  };
  await db.insert('users', record);
  return record;
}

// First-boot on an empty PRODUCTION database: no demo people are created
// (see seed.js). If BOOTSTRAP_SUPERADMIN_EMAIL and BOOTSTRAP_SUPERADMIN_NAME
// are set and no admin exists yet, one real super admin is created with a
// random temporary password printed once to the server log.
async function bootstrapSuperAdminIfNeeded() {
  const email = (process.env.BOOTSTRAP_SUPERADMIN_EMAIL || '').trim();
  const name = (process.env.BOOTSTRAP_SUPERADMIN_NAME || '').trim();
  if (!email || !name) return null;
  const admins = await db.filter('users', u => u.role === 'admin');
  if (admins.length) return null;
  const temp = `Tr-${nanoid(14)}`;
  const admin = await createSuperAdmin({ name, email, password: temp });
  console.log('============================================================');
  console.log(`✅ Created the first real super admin: ${email}`);
  console.log(`   Temporary password (shown once): ${temp}`);
  console.log('   Sign in with it, then you will be required to set your own.');
  console.log('   Remove BOOTSTRAP_SUPERADMIN_* from Render once you are in.');
  console.log('============================================================');
  return admin;
}

// The Go-Live checklist: each item is read from the real running server.
async function readinessReport(requestingUser) {
  const delivery = require('./delivery');
  const users = await db.all('users');
  const demoUsers = users.filter(isDemoAccount);
  const realUsers = users.filter(u => !isDemoAccount(u));
  const realSuperAdmins = realUsers.filter(u => u.role === 'admin' && u.isSuperAdmin);
  const countries = await safeAll('countries');
  const liveCountries = countries.filter(c => c.status === 'live');
  let googleOk = false;
  try { googleOk = require('./google-auth').isGoogleSignInConfigured(); } catch (e) {}
  const usingPostgres = !!process.env.DATABASE_URL;

  // v96: facts for the newer checks.
  const ps = require('./platform-settings');
  const supportEmail = await ps.publicSupportEmail();
  const siteHost = process.env.APP_URL ? String(process.env.APP_URL).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
  const supportNotes = ps.supportEmailAdvice(supportEmail, siteHost);
  const supportOk = !!supportEmail && !supportNotes.some(n => n.level === 'problem');
  let backupLatest = null, backupFresh = false;
  try { const b = require('./backup-scheduler'); const list = b.backupsApply() ? b.listBackups() : []; backupLatest = list[0] ? list[0].day : null; backupFresh = !!backupLatest && (Date.now() - new Date(backupLatest + 'T00:00:00Z').getTime()) < 2.5 * 24 * 60 * 60 * 1000; } catch (e) { /* leave as not found */ }
  let idEncrypted = false; try { idEncrypted = require('./file-crypto').isEnabled(); } catch (e) {}
  let personaOk = false; try { personaOk = !!require('./persona-verification').isPersonaConfigured(); } catch (e) {}
  let planBilling = { active: false }; try { planBilling = await require('./plan-billing').getState(); } catch (e) {}
  const item = (key, label, ok, detail, severity = 'required') => ({ key, label, ok: !!ok, detail, severity });
  const items = [
    item('real_superadmin', 'A real super admin account exists (not the demo one)', realSuperAdmins.length > 0,
      realSuperAdmins.length ? `${realSuperAdmins.length} real super admin(s): ${realSuperAdmins.map(a => a.email).join(', ')}` : 'Only the demo super admin exists. Create yours below.'),
    item('signed_in_real', 'You are signed in with your real account', requestingUser && !isDemoAccount(requestingUser),
      requestingUser && isDemoAccount(requestingUser) ? `You are using the demo account ${requestingUser.email}. Sign out and sign in with your real super admin.` : 'Yes'),
    item('no_demo', 'No demo accounts or demo records remain', demoUsers.length === 0,
      demoUsers.length ? `${demoUsers.length} demo account(s) still present — they appear in search and some can sign in with a published password.` : 'None'),
    item('jwt', 'Sign-in secret is set', !!(process.env.TROTHEN_JWT_SECRET || process.env.TASKORA_JWT_SECRET),
      process.env.TROTHEN_JWT_SECRET ? 'Set' : 'Not set — everyone is signed out on every restart.'),
    item('production', 'Running in production mode', isProduction(), `NODE_ENV=${process.env.NODE_ENV || '(not set)'}`),
    item('datastore', 'Data is stored on a permanent disk or database', usingPostgres || !!process.env.DATA_DIR,
      usingPostgres ? 'Postgres (DATABASE_URL)' : (process.env.DATA_DIR ? `JSON files at ${process.env.DATA_DIR}` : 'DATA_DIR not set — data is lost on every deploy')),
    item('private_uploads', 'ID documents are saved on the permanent disk', !!process.env.PRIVATE_UPLOADS_DIR,
      process.env.PRIVATE_UPLOADS_DIR ? process.env.PRIVATE_UPLOADS_DIR : 'PRIVATE_UPLOADS_DIR not set — every uploaded ID document is erased on the next deploy'),
    item('uploads', 'Profile/portfolio photos are saved on the permanent disk', !!process.env.UPLOADS_DIR,
      process.env.UPLOADS_DIR || 'UPLOADS_DIR not set — photos are erased on the next deploy'),
    item('email', 'Email sending is connected (SendGrid)', delivery.isEmailConfigured(),
      delivery.isEmailConfigured() ? `Sending from ${process.env.SENDGRID_FROM_EMAIL}` : 'Not connected — sign-up and sign-in codes are shown on screen, so email ownership and admin two-factor are not really checked.'),
    item('app_url', 'Public web address is set for email links', !!process.env.APP_URL,
      process.env.APP_URL || 'APP_URL not set — links fall back to the address of each request (works, but set it to be sure).', 'recommended'),
    item('countries', 'Only the countries you actually serve are marked live', liveCountries.length > 0 && liveCountries.length <= 15,
      !liveCountries.length ? 'No country is live — nobody can sign up and the homepage shows none.'
        : liveCountries.length > 15 ? `${liveCountries.length} countries are marked live. The homepage says Trothen operates in all of them and anyone there can sign up. Use Step 3 below to keep only the countries you serve.`
        : liveCountries.map(c => c.name).join(', ')),
    item('sms', 'Text messages are connected (Twilio)', delivery.isSmsConfigured() || delivery.isVerifyConfigured(),
      'Optional — without it, phone-number codes are shown on screen.', 'optional'),
    item('google', 'Google Sign-In is connected', googleOk, 'Optional.', 'optional'),
    item('push', 'Background push notifications are set up', !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
      'Optional — in-app notifications work without it.', 'optional'),
    // v96: the newer safeguards, so this one page shows everything that
    // stands between today and launch.
    item('support_email', 'A working support email is set, on my own domain', supportOk,
      supportEmail ? (supportNotes.length ? `${supportEmail}: ${supportNotes.map(n => n.text).join(' ')}` : supportEmail) : 'Not set. Add it in Settings → Footer. The Terms and Privacy Policy show this address.'),
    item('privacy_policy', 'The Privacy Policy has been reviewed by an attorney', false,
      'A built-in policy is live at /privacy and editable in Settings. It was written to match the system and still needs a legal review.', 'business'),
    item('backups', 'A data backup was taken in the last two days', backupFresh,
      backupLatest ? `Latest copy: ${backupLatest}. Copies are on the same disk. Download one from Settings → Data backups every week or so and keep it somewhere else.` : 'No backup found yet. One is taken about a minute after the server starts, then daily.', 'recommended'),
    item('id_encryption', 'Extra encryption for ID files is switched on', idEncrypted,
      idEncrypted ? 'On' : 'Off. Set ID_FILE_ENCRYPTION_KEY on the server (see CHANGES_v82.md) and keep a copy of the key somewhere safe.', 'recommended'),
    item('id_checks', 'Automated ID and face checks are connected (Persona)', personaOk,
      personaOk ? 'Connected' : 'Optional. Without it, a person compares each ID with the face photo.', 'optional'),
    item('plan_fee', 'Monthly plan fee', true,
      planBilling.active ? 'Switched ON. Pros are invoiced monthly from their payouts.' : 'Switched off (as it should be until real payments are live).', 'optional'),
    item('payments', 'Real payments are connected', false,
      'Not yet — every payment and payout is simulated. Real people can sign up, verify and be found, but no real money can move through Trothen until payment processing is built and approved.', 'business'),
  ];
  return {
    items,
    counts: { totalAccounts: users.length, realAccounts: realUsers.length, demoAccounts: demoUsers.length },
    demoAccounts: demoUsers.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, isSuperAdmin: !!u.isSuperAdmin })),
  };
}

// Sets exactly this list of countries to "live" and every other one to
// "planned". Nothing is deleted and existing accounts keep working —
// "planned" only removes a country from the homepage line and from the
// signup country list.
async function setLiveCountries(names) {
  const wanted = new Set(names.map(n => String(n).trim().toLowerCase()).filter(Boolean));
  const all = await db.all('countries');
  const known = new Set(all.map(c => c.name.toLowerCase()));
  const unknown = [...wanted].filter(n => !known.has(n));
  if (unknown.length) return { error: `Not in the country list: ${unknown.join(', ')}` };
  let changed = 0;
  for (const c of all) {
    const status = wanted.has(c.name.toLowerCase()) ? 'live' : 'planned';
    if (c.status !== status) { await db.update('countries', c.id, { status }); changed++; }
  }
  return { live: all.filter(c => wanted.has(c.name.toLowerCase())).map(c => c.name), changed };
}

module.exports = {
  setLiveCountries,
  DEMO_PASSWORD, isDemoAccount, isProduction, usesDemoPassword,
  planDemoRemoval, executeDemoRemoval, createSuperAdmin, bootstrapSuperAdminIfNeeded, readinessReport,
};
