const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireRole, hashPassword } = require('../auth');
const { isValidEmail, isNonEmptyString, isValidPassword, isValidName, isValidLabel, validate } = require('../validators');
const { notify } = require('../notify');
const { effectiveCommissionRate } = require('../commission');
const { effectivePlanPricing, PLAN_KEYS, DEFAULT_USD_PRICES } = require('../plan-pricing');
const { currencyForCountry, APPROX_USD_RATE, CURRENCY_BY_COUNTRY } = require('../currency-data');
const { UPLOADS_DIR, verifyImageMagicBytes, verifyPdfMagicBytes } = require('../uploads');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// A suspended admin's existing token would otherwise keep working for up to
// 7 days (tokens aren't re-checked against the DB by requireAuth itself).
// This re-fetches the fresh record on every admin request so a suspension
// takes effect immediately, not whenever the token happens to expire.
router.use(async (req, res, next) => {
  const current = await db.find('users', u => u.id === req.user.sub);
  if (!current || current.active === false) {
    return res.status(403).json({ error: 'This account has been suspended. Contact a super admin for access.' });
  }
  next();
});

// Every route below runs as an admin (super admin or a location admin).
// `me` is the fresh DB record (not just the JWT payload) so a change to an
// admin's region or active status takes effect immediately, without needing
// a new token.
async function me(req) {
  return db.find('users', u => u.id === req.user.sub);
}

// null region = super admin = sees everything. A non-null region scopes
// every query below to that one city.
// A department admin (Verification, Disputes, Financial, HR, etc.) is
// global by default — but can now be scoped to their own city too, via
// the explicit regionScoped flag set at creation (see POST
// /admin/sub-admins). Defaults to false/unset, so every admin account
// created before this existed keeps behaving exactly as it does today —
// nothing silently changes for anyone already set up.
//
// 'sales' deliberately never regionalizes even if the flag is somehow
// set: sales leads are about custom multi-seat organization deals, which
// aren't really a per-city concept the way disputes or verification
// queues are.
// v90: a regional admin can now cover a WHOLE COUNTRY instead of one city.
//
// Why: city scope compares the admin's city with the exact city text each
// person typed when they signed up. "Monrovia", "monrovia", "Paynesville"
// and "Monrovia City" are all different strings, so an admin "for
// Monrovia" could open their dashboard and see almost nobody. Country
// comes from a fixed list, so country scope can't miss people that way.
//
// An admin record carries adminScope: 'country' or 'city' (missing means
// 'city', so every admin created before this behaves exactly as before).
// For a country-wide admin, myRegion() returns a CountryScope: it prints
// as the country's name wherever a label is needed, and inRegion() below
// knows to compare countries. For a city admin it still returns the plain
// city text. Every "is this person mine?" check goes through inRegion().
class CountryScope extends String {
  constructor(country) { super(country); this.country = country; }
}
const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
function inRegion(region, person) {
  if (!region) return true;           // super admin / global role: everyone
  if (!person) return false;
  if (region instanceof CountryScope) return sameText(person.country, region.country);
  return sameText(person.city, region); // v90: capital letters and stray spaces no longer make a city miss
}
// An ad belongs to a city admin when it targets their city, and to a
// country admin when the pro who placed it is in their country.
// v107: an ad from an outside company has no pro behind it, so a country
// admin never saw it. Now it is theirs when its city is in their country.
function adInRegion(region, ad, pro, citiesHere) {
  if (!region) return true;
  if (region instanceof CountryScope) return pro ? sameText(pro.country, region.country) : !!(ad.targetCity && citiesHere && citiesHere.has(String(ad.targetCity).trim().toLowerCase()));
  return sameText(ad.targetCity, region);
}
// For records that only carry a city typed by a member of the public
// (contact messages, job applications): a country-wide admin gets the
// ones with no city, the ones that name their country, and the ones whose
// city is a city known in their country. A city admin gets their city.
async function adminCovers(m, item) {
  if (!m || m.isSuperAdmin) return true;
  if (m.adminScope === 'country' && m.country) {
    if (item.country) return sameText(item.country, m.country);
    if (!item.city) return true;
    const known = new Set([
      ...(await db.filter('cities', c => sameText(c.country, m.country))).map(c => String(c.name || '').trim().toLowerCase()),
      ...(await db.filter('users', u => sameText(u.country, m.country) && u.city)).map(u => String(u.city).trim().toLowerCase()),
    ]);
    return known.has(String(item.city).trim().toLowerCase());
  }
  return sameText(item.city, m.city);
}
function regionWord(region) { return region instanceof CountryScope ? 'country' : 'city'; }

async function myRegion(req) {
  const m = await me(req);
  if (!m) return null;
  if (m.isSuperAdmin) return null;
  const scoped = () => (m.adminScope === 'country' && m.country) ? new CountryScope(m.country) : (m.region || m.city);
  if (!m.adminDepartment) return scoped(); // plain regional admin — always scoped
  if (m.adminDepartment !== 'sales' && m.regionScoped) return scoped();
  return null;
}

async function requireSuperAdmin(req, res, next) {
  const m = await me(req);
  if (!m || !m.isSuperAdmin) return res.status(403).json({ error: 'This action requires a super admin account' });
  next();
}

// Stricter than requireDepartment: gates a genuinely company-wide business
// function (Sales Inquiries, Organizations) that a plain regional admin
// should NOT see just because they have no department set — unlike
// requireDepartment, only a super admin or an admin explicitly scoped to
// this exact department passes. A dispute or verification request can come
// from any city, so those stay open to unscoped regional admins by
// default; a Custom-plan sales deal or a multi-seat organization account
// is a different kind of thing entirely, closer to Locations & Admins.
function requireSuperAdminOrDepartment(dept) {
  return async (req, res, next) => {
    const m = await me(req);
    if (!m) return res.status(403).json({ error: 'Not authorized' });
    if (m.isSuperAdmin) return next();
    if (m.adminDepartment === dept) return next();
    return res.status(403).json({ error: `This requires a super admin account or ${dept === 'sales' ? 'Sales team' : dept} access.` });
  };
}

// Gates access to one functional department's endpoints (verification,
// disputes, financial). A super admin always passes. A regular admin with
// no department set (a regional admin, the original role) also passes —
// they still have full access to their own city's data, unchanged. A
// department-scoped admin only passes for THEIR department; scoped admins
// see data across all regions for that one function, not just one city,
// since a dispute or a verification request can come from anywhere.
function requireDepartment(deptOrDepts) {
  const allowed = Array.isArray(deptOrDepts) ? deptOrDepts : [deptOrDepts];
  return async (req, res, next) => {
    const m = await me(req);
    if (!m) return res.status(403).json({ error: 'Not authorized' });
    if (m.isSuperAdmin) return next();
    if (!m.adminDepartment) return next(); // regular regional admin — unchanged access
    if (allowed.includes(m.adminDepartment)) return next();
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  };
}

// Item: Joseph asked for the customer service team to be able to access
// and edit legal/policy content (Terms of Service, About Us) — currently
// super-admin-only. Deliberately its own middleware rather than reusing
// requireDepartment() above: that helper also lets a plain regional admin
// (no department at all) through, which would open policy editing to
// every city's regional admin, not just customer service — a real,
// unintended widening for content this sensitive. This allows exactly
// two callers: a super admin, or specifically the customer_service
// department.
function requireSuperAdminOrCustomerService(req, res, next) {
  me(req).then(m => {
    if (!m) return res.status(403).json({ error: 'Not authorized' });
    if (m.isSuperAdmin || m.adminDepartment === 'customer_service') return next();
    return res.status(403).json({ error: 'Only a super admin or the customer service team can access this.' });
  });
}

// Resolve which city a dispute "belongs to" via its contract's customer.
// Resolves which city a dispute "belongs to" via its contract's customer.
// Accepts optional pre-built lookup maps (contractById, customerById) for
// callers checking many disputes at once — without them, falls back to
// individual queries exactly as before, so the single-dispute call site
// (POST /disputes/:id/resolve) needs no changes at all. With them, a
// caller looping over every dispute on the platform does one batch fetch
// up front instead of two individual database round-trips per dispute —
// harmless today on the small JSON-file store, but a real, meaningful
// difference once this runs against actual Postgres at scale.
async function disputeCustomer(dispute, contractById, customerById) {
  const contract = contractById ? contractById.get(dispute.contractId) : await db.find('contracts', c => c.id === dispute.contractId);
  if (!contract) return null;
  const customer = customerById ? customerById.get(contract.customerId) : await db.find('users', u => u.id === contract.customerId);
  return customer || null;
}

function publicAdmin(u, options = {}) {
  const { passwordHash, ...rest } = u;
  // Masked by default for any customer or provider record — this is the
  // one function nearly every admin endpoint in this file routes a user
  // record through, so fixing it here closes the gap everywhere at
  // once, not just in the one list view it was first caught in. Admin
  // accounts themselves aren't masked (their own contact info isn't the
  // "customer/provider sensitive data" concern here), and the explicit
  // `unmasked: true` passed only by GET /users/:id/contact below is the
  // one deliberate, logged exception.
  if (!options.unmasked && (rest.role === 'customer' || rest.role === 'provider')) {
    return {
      ...rest,
      email: maskEmail(rest.email),
      phone: maskPhone(rest.phone),
      address: rest.address ? '••••• (hidden — use Reveal Contact Info)' : rest.address,
    };
  }
  return rest;
}

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  const region = await myRegion(req);
  const users = (await db.all('users')).filter(u => !region || inRegion(region, u));
  const allContracts = await db.all('contracts');
  const allCustomersForStats = await db.filter('users', u => u.role === 'customer');
  const customerByIdForStats = new Map(allCustomersForStats.map(c => [c.id, c]));
  const contractByIdForStats = new Map(allContracts.map(c => [c.id, c]));
  const allDisputes = await db.all('disputes');
  const disputes = [];
  for (const d of allDisputes) {
    if (!region || inRegion(region, await disputeCustomer(d, contractByIdForStats, customerByIdForStats))) disputes.push(d);
  }
  const contracts = [];
  for (const c of allContracts) {
    if (!region) { contracts.push(c); continue; }
    const customer = customerByIdForStats.get(c.customerId);
    if (customer && inRegion(region, customer)) contracts.push(c);
  }
  const pendingUsers = users.filter(u => u.role !== 'admin' && u.verified === false).length;
  const gmv = contracts.reduce((s, c) => s + (c.amount || 0), 0);
  res.json({
    totalUsers: users.length,
    pendingApprovals: pendingUsers,
    openDisputes: disputes.filter(d => d.status !== 'resolved').length,
    gmv,
    region: region || 'All Locations',
  });
});

// GET /api/admin/reports/analytics — the real data behind Reports &
// Analytics. Everything here is computed from actual contracts, not
// stored counters — notably this replaces what the "Demand by Category"
// chart used to show (verified PROVIDER count per category — supply, not
// demand) with genuine booking counts, and computes each provider's
// "jobs completed" from real completed contracts rather than the static
// `jobs` field on their user record, which is seed data that nothing in
// this codebase ever increments (worth fixing on provider profile pages
// too — flagged separately, out of scope for this endpoint).
router.get('/reports/analytics', async (req, res) => {
  const region = await myRegion(req);
  const [allCategories, allProviders, allContracts, allCustomers] = await Promise.all([
    db.all('categories'),
    db.filter('users', u => u.role === 'provider'),
    db.all('contracts'),
    db.filter('users', u => u.role === 'customer'),
  ]);
  const customerById = new Map(allCustomers.map(c => [c.id, c]));
  const providerById = new Map(allProviders.map(p => [p.id, p]));

  // Scope contracts to this admin's city (via the CUSTOMER's city, same
  // convention as /stats and everywhere else a region is derived) — a
  // regional admin's reports should reflect their own city's activity,
  // not the whole platform's.
  const contracts = region
    ? allContracts.filter(c => { const cust = customerById.get(c.customerId); return cust && inRegion(region, cust); })
    : allContracts;
  const providers = region ? allProviders.filter(p => inRegion(region, p)) : allProviders;

  // ── Category performance: REAL demand (bookings), not provider supply ──
  const catStats = new Map(); // category -> { jobsBooked, gmv, ratings: [] }
  for (const c of contracts) {
    const provider = providerById.get(c.providerId);
    const category = provider ? (provider.category || 'Uncategorized') : 'Uncategorized';
    if (!catStats.has(category)) catStats.set(category, { jobsBooked: 0, gmv: 0 });
    const s = catStats.get(category);
    s.jobsBooked += 1;
    s.gmv += c.amount || 0;
  }
  const providerCountByCategory = new Map();
  const ratingsByCategory = new Map();
  for (const p of providers) {
    if (!p.category) continue;
    providerCountByCategory.set(p.category, (providerCountByCategory.get(p.category) || 0) + 1);
    if (p.rating) {
      if (!ratingsByCategory.has(p.category)) ratingsByCategory.set(p.category, []);
      ratingsByCategory.get(p.category).push(p.rating);
    }
  }
  const categoryPerformance = Array.from(catStats.entries()).map(([category, s]) => {
    const ratings = ratingsByCategory.get(category) || [];
    return {
      category,
      jobsBooked: s.jobsBooked,
      gmv: Math.round(s.gmv * 100) / 100,
      avgJobValue: s.jobsBooked ? Math.round((s.gmv / s.jobsBooked) * 100) / 100 : 0,
      providerCount: providerCountByCategory.get(category) || 0,
      avgRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
    };
  }).sort((a, b) => b.jobsBooked - a.jobsBooked);

  // ── Jobs over time: last 30 days, real daily counts, zero-filled so a
  // quiet day shows as a real zero rather than just being absent ──
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const countByDay = new Map(days.map(d => [d, 0]));
  for (const c of contracts) {
    const day = (c.createdAt || '').slice(0, 10);
    if (countByDay.has(day)) countByDay.set(day, countByDay.get(day) + 1);
  }
  const jobsOverTime = days.map(d => ({ date: d, count: countByDay.get(d) }));

  // ── Top providers by REAL completed jobs (not the static `jobs` field
  // on their profile, which is unmaintained seed data) ──
  const topProviders = providers.map(p => {
    const theirContracts = contracts.filter(c => c.providerId === p.id);
    const completed = theirContracts.filter(c => c.status === 'completed');
    return {
      id: p.id,
      name: p.name,
      category: p.category || null,
      city: p.city || null,
      jobsCompleted: completed.length,
      jobsBooked: theirContracts.length,
      gmv: Math.round(completed.reduce((s, c) => s + (c.amount || 0), 0) * 100) / 100,
      rating: p.rating || null,
    };
  }).sort((a, b) => b.jobsCompleted - a.jobsCompleted || b.jobsBooked - a.jobsBooked).slice(0, 10);

  res.json({
    region: region || 'All Locations',
    categoryPerformance,
    totalCategories: allCategories.length,
    jobsOverTime,
    topProviders,
  });
});

// v107: where a person's ID stands, in one word, for every admin list.
//   approved = an ID was reviewed and approved
//   waiting  = an ID is in the Verification Queue now
//   rejected = their last ID was turned down and they haven't sent another
//   none     = they have never sent one
// "Verified" on an account comes ONLY from an approved ID (v75). Approving
// the account in User Approvals lets the person in; it does not verify
// them. These lists now say which of the two steps is outstanding.
async function idStatusByUser() {
  const byUser = new Map();
  const rank = { approved: 4, waiting: 3, rejected: 2 };
  for (const v of await db.all('verifications')) {
    const s = v.status === 'approved' ? 'approved' : ['pending', 'review_required'].includes(v.status) ? 'waiting' : v.status === 'rejected' ? 'rejected' : null;
    if (!s) continue;
    if (!byUser.has(v.userId) || rank[s] > rank[byUser.get(v.userId)]) byUser.set(v.userId, s);
  }
  return (userId) => byUser.get(userId) || 'none';
}

// GET /api/admin/users/pending
router.get('/users/pending', async (req, res) => {
  const region = await myRegion(req);
  const idOf = await idStatusByUser(); // v107: show where each person's ID stands, next to the account
  const pending = (await db.filter('users', u => u.role !== 'admin' && u.verified === false && u.status !== 'approved' && u.status !== 'rejected' && (!region || inRegion(region, u))))
    .map(u => ({ ...publicAdmin(u), idStatus: idOf(u.id) }));
  res.json({ users: pending });
});

// GET /api/admin/users/all?role=customer|provider — the full customer/provider
// directory. A location admin only ever sees people in their own assigned
// city — that's the whole point of location admins existing. A super admin
// passes no region filter here, so they always see (and can act on)
// everyone, everywhere, regardless of what any location admin's scope is.
router.get('/users/all', async (req, res) => {
  const { logAccess } = require('../access-log');
  await logAccess(req, 'people_list');
  const region = await myRegion(req);
  const { role } = req.query;
  let users = await db.filter('users', u => u.role === 'customer' || u.role === 'provider');
  if (region) users = users.filter(u => inRegion(region, u));
  if (role && ['customer', 'provider'].includes(role)) users = users.filter(u => u.role === role);
  // publicAdmin() masks contact info by default for any customer/provider
  // record — see its definition above for the full reasoning. This was
  // the endpoint the original gap was caught in; the masking itself now
  // lives at the source so every other endpoint that returns a person's
  // record is covered too, not just this one.
  // v75: how each person came to be "Verified", so nobody has to guess.
  const approvedRecords = await db.filter('verifications', v => v.status === 'approved');
  const latestApproved = new Map();
  for (const v of approvedRecords) {
    const prev = latestApproved.get(v.userId);
    if (!prev || String(v.reviewedAt || '') > String(prev.reviewedAt || '')) latestApproved.set(v.userId, v);
  }
  const adminNames = new Map((await db.filter('users', u => u.role === 'admin')).map(a => [a.id, a.name]));
  const howVerified = (u) => {
    if (u.verified !== true) return {};
    const rec = latestApproved.get(u.id);
    if (rec && (rec.source === 'persona' || rec.reviewedBy === 'persona')) return { verifiedVia: 'persona', verifiedAt: rec.reviewedAt || null };
    if (rec) return { verifiedVia: 'id_review', verifiedByName: adminNames.get(rec.reviewedBy) || null, verifiedAt: rec.reviewedAt || null };
    if (u.approvedBy) return { verifiedVia: 'account_approval', verifiedByName: adminNames.get(u.approvedBy) || null, verifiedAt: u.approvedAt || null };
    return { verifiedVia: 'unknown' };
  };
  const idOf = await idStatusByUser(); // v107
  res.json({ users: users.map(u => ({ ...publicAdmin(u), ...howVerified(u), idStatus: idOf(u.id), accountStatus: u.status || 'pending' })) });
});

// Masks all but the first character of the local part and keeps the
// domain visible (e.g. "jordan@example.com" -> "j*****@example.com") —
// enough to visually distinguish rows in a list without exposing the
// real address.
function maskEmail(email) {
  if (!email || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  return `${local[0]}${'*'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
}
// Keeps only the last 2 digits visible.
function maskPhone(phone) {
  if (!phone || phone.length < 4) return phone;
  const digitsOnly = phone.replace(/\D/g, '');
  const last2 = digitsOnly.slice(-2);
  return `•••-•••-••${last2}`;
}

// GET /api/admin/users/:id/contact — the real, unmasked email and phone
// for one specific person, on demand. Every call is logged (see
// src/access-log.js) with who looked and when — this is the
// accountability half of masking-by-default: contact info stays
// reachable for a real reason, but browsing it casually no longer
// happens silently.
router.get('/users/:id/contact', async (req, res) => {
  const m = await me(req);
  // Customer service specifically should never need this — everything
  // they do (responding to a message, helping with a booking) already
  // works through the app's own messaging and booking systems without
  // knowing someone's personal phone or email. Sales and HR deal with
  // entirely different people (org leads, job applicants) and have no
  // legitimate reason to be looking up a marketplace customer or
  // provider's contact info at all.
  const blockedDepartments = ['customer_service', 'sales', 'hr'];
  if (m.adminDepartment && blockedDepartments.includes(m.adminDepartment)) {
    return res.status(403).json({ error: `The ${m.adminDepartment.replace('_', ' ')} team doesn't have access to personal contact info.` });
  }
  const region = await myRegion(req);
  const target = await db.find('users', u => u.id === req.params.id && (u.role === 'customer' || u.role === 'provider'));
  if (!target) return res.status(404).json({ error: 'Person not found' });
  if (region && !inRegion(region, target)) return res.status(403).json({ error: 'That person is outside the area you manage' });
  const { logAccess } = require('../access-log');
  await logAccess(req, 'contact_info_reveal', target.id);
  res.json({ email: target.email, phone: target.phone, address: [target.address, target.zipCode].filter(Boolean).join(', ') || null });
});

// POST /api/admin/customers/:id/vip — grant or revoke VIP membership.
// Super admin only, and deliberately the only way VIP is ever assigned —
// see src/membership.js for why it's not something a customer can buy
// at any price ("Invitation/eligibility" was explicit about this).
router.post('/customers/:id/vip', requireSuperAdmin, async (req, res) => {
  const target = await db.find('users', u => u.id === req.params.id && u.role === 'customer');
  if (!target) return res.status(404).json({ error: 'Customer not found' });
  const { grant } = req.body || {};
  if (typeof grant !== 'boolean') return res.status(400).json({ error: 'grant must be true or false' });
  const updated = await db.update('users', target.id, grant
    ? { membershipTier: 'vip', membershipStartedAt: new Date().toISOString(), membershipPrice: null }
    : { membershipTier: 'free', membershipCancelledAt: new Date().toISOString(), membershipPrice: null });
  await notify(target.id, grant ? '💎' : '👋', grant
    ? 'You\'ve been invited to Trothen VIP — our top membership tier, including concierge support.'
    : 'Your Trothen VIP membership has ended. You\'re now on the Free tier.', null, { section: 'settings' });
  res.json({ user: publicAdmin(updated) });
});

// GET /api/admin/providers/:id/score — a live, freshly-computed trust
// score for one provider (not just whatever was last saved by the daily
// sweep) — useful when reviewing a specific account right now rather
// than waiting for the next scheduled run.
router.get('/providers/:id/score', async (req, res) => {
  const region = await myRegion(req);
  const provider = await db.find('users', u => u.id === req.params.id && u.role === 'provider');
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (region && !inRegion(region, provider)) return res.status(403).json({ error: 'That provider is outside the area you manage' });
  const { computeProviderScore, recommendedActionForScore } = require('../provider-score');
  const result = await computeProviderScore(provider.id);
  res.json({ ...result, recommendedAction: recommendedActionForScore(result.total) });
});

// GET /api/admin/providers/leaderboard — every provider ranked by trust
// score, highest first. Uses whatever was last computed by the daily
// sweep (see src/provider-score-scheduler.js) rather than recomputing
// everyone live on every request — a ranked list doesn't need to be
// second-by-second fresh the way reviewing one specific account does.
router.get('/providers/leaderboard', async (req, res) => {
  const region = await myRegion(req);
  const { recommendedActionForScore } = require('../provider-score');
  let providers = await db.filter('users', u => u.role === 'provider' && u.trustScore != null);
  if (region) providers = providers.filter(p => inRegion(region, p));
  providers.sort((a, b) => (b.trustScore || 0) - (a.trustScore || 0));
  res.json({
    providers: providers.map(p => ({
      id: p.id, name: p.name, city: p.city, category: p.category,
      trustScore: p.trustScore, plan: p.plan, rating: p.rating, jobs: p.jobs,
      trustScoreUpdatedAt: p.trustScoreUpdatedAt,
      onHold: p.onHold, holdUntil: p.holdUntil,
      isNew: p.trustScoreProvisional === true, // v91: fewer than five completed jobs; number is provisional
      recommendedAction: p.trustScoreProvisional === true ? null : recommendedActionForScore(p.trustScore),
    })),
  });
});

// POST /api/admin/providers/:id/hold — a genuine manual account hold, for
// a real reason an admin actually types (fraud, a policy violation,
// anything serious enough to need one) — not an automatic consequence of
// a low trust score anymore. That consequence is now handled entirely by
// the weekly job-access tiers in src/provider-score.js
// (weeklyJobAccessCapForScore): a provider's new-match exposure scales
// down automatically as their score drops, down to fully suspended at
// 0-19, with no admin action needed, and it lifts itself the moment their
// score recovers. This endpoint is for something a score number alone
// can't capture — always requires a real reason and a real duration
// from the admin, never pre-filled from a score bracket.
router.post('/providers/:id/hold', async (req, res) => {
  const region = await myRegion(req);
  const provider = await db.find('users', u => u.id === req.params.id && u.role === 'provider');
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (region && !inRegion(region, provider)) return res.status(403).json({ error: 'That provider is outside the area you manage' });

  const { months, reason } = req.body || {};
  if (typeof months !== 'number' || months <= 0 || months > 24) {
    return res.status(400).json({ error: 'months must be a positive number (24 max)' });
  }
  if (!isNonEmptyString(reason, { min: 10, max: 300 })) {
    return res.status(400).json({ error: 'Enter a real reason for this hold (at least 10 characters) — it\'s shown to the provider' });
  }

  const holdUntil = new Date();
  holdUntil.setMonth(holdUntil.getMonth() + months);

  const updated = await db.update('users', provider.id, {
    onHold: true,
    holdReason: reason.trim(),
    holdSince: new Date().toISOString(),
    holdUntil: holdUntil.toISOString(),
  });
  await notify(provider.id, '⏸️', `Your account has been placed on hold for ${months} month${months === 1 ? '' : 's'}: ${reason.trim()} It will automatically reactivate on ${holdUntil.toLocaleDateString()}. Contact support if you have questions.`, null, { section: 'settings' });
  res.json({ user: publicAdmin(updated) });
});

// PATCH /api/admin/users/:id/status  { active: true|false } — suspend or
// reactivate a customer or provider account. Location admins can only do
// this to people in their own city; a super admin can do it to anyone,
// anytime, overriding whatever a location admin has set.
router.patch('/users/:id/status', async (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
  const region = await myRegion(req);
  const target = await db.find('users', u => u.id === req.params.id && (u.role === 'customer' || u.role === 'provider'));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (region && !inRegion(region, target)) return res.status(403).json({ error: 'That user is outside the area you manage' });
  const updated = await db.update('users', target.id, { active });
  await notify(target.id, active ? '✅' : '⛔', active ? 'Your account has been reactivated.' : 'Your account has been suspended. Contact support for details.', null, { section: 'settings' });

  // A suspended provider's in-progress jobs don't resolve themselves —
  // previously nothing happened to them at all, and a customer with real
  // money already in escrow would have no idea anything was wrong. This
  // doesn't auto-refund (the right call depends on why the suspension
  // happened, which this endpoint has no way to know) — it makes sure a
  // real person sees it and the affected customer isn't left in the dark.
  if (!active && target.role === 'provider') {
    const activeContracts = await db.filter('contracts', c => c.providerId === target.id && ['active', 'pending_agreement', 'pending_provider_confirmation'].includes(c.status));
    for (const contract of activeContracts) {
      await notify(contract.customerId, '⚠️', `Your provider for "${contract.service}" has had their account suspended. Our team is reviewing your booking and will follow up shortly — contact support if you need this resolved sooner.`, 'bookingUpdates', { section: 'bookings' });
    }
    if (activeContracts.length) {
      const supers = await db.filter('users', u => u.isSuperAdmin === true);
      for (const admin of supers) {
        await notify(admin.id, '⚠️', `${target.name} was just suspended with ${activeContracts.length} active booking${activeContracts.length === 1 ? '' : 's'} still in progress — these need a real decision (refund, reassign, etc.).`, null, { section: 'disputes' });
      }
    }
  }

  res.json({ user: publicAdmin(updated) });
});

// POST /api/admin/providers/:id/propose-commission-rate — a regional
// admin's way to reward a specific provider's excellent performance with
// a better individual commission rate, outside the normal Starter/Pro/
// Super-Pro tier ladder. This only ever proposes — it takes effect
// nowhere until a super admin approves it below. A regional admin can
// only propose this for a provider in their own city; a super admin can
// propose (and approve their own proposal) for anyone.
router.post('/providers/:id/propose-commission-rate', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  const { rate, reason } = req.body || {};
  if (typeof rate !== 'number' || rate < 0 || rate > 0.5) {
    return res.status(400).json({ error: 'Rate must be a number between 0 and 0.5 (e.g. 0.08 for 8%)' });
  }
  if (!isNonEmptyString(reason, { min: 10, max: 500 })) {
    return res.status(400).json({ error: 'Explain why this provider has earned a custom rate (at least 10 characters) — a super admin needs this to actually decide' });
  }
  const region = await myRegion(req);
  const provider = await db.find('users', u => u.id === req.params.id && u.role === 'provider');
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (region && !inRegion(region, provider)) return res.status(403).json({ error: 'That provider is outside the area you manage' });
  if (provider.commissionRateOverrideStatus === 'pending') {
    return res.status(400).json({ error: 'This provider already has a proposal awaiting approval' });
  }

  const updated = await db.update('users', provider.id, {
    commissionRateOverride: rate,
    commissionRateOverrideStatus: 'pending',
    commissionRateOverrideReason: reason.trim(),
    commissionRateOverrideProposedBy: m.id,
  });

  const supers = await db.filter('users', u => u.isSuperAdmin === true);
  for (const admin of supers) {
    await notify(admin.id, '💲', `${m.name} proposed a custom ${(rate * 100).toFixed(1)}% commission rate for ${provider.name}: "${reason.trim().slice(0, 80)}${reason.length > 80 ? '…' : ''}" — needs your approval.`, null, { section: 'people' });
  }

  res.json({ user: publicAdmin(updated) });
});

// POST /api/admin/providers/:id/commission-rate/:decision — super admin
// only. Approving actually activates the rate (see
// effectiveCommissionRate in src/commission.js); rejecting clears the
// proposal entirely rather than leaving a rejected rate sitting on the
// record.
router.post('/providers/:id/commission-rate/:decision', requireSuperAdmin, async (req, res) => {
  const { decision } = req.params;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
  const provider = await db.find('users', u => u.id === req.params.id && u.role === 'provider');
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (provider.commissionRateOverrideStatus !== 'pending') {
    return res.status(400).json({ error: 'This provider has no pending commission rate proposal' });
  }

  if (decision === 'approve') {
    const updated = await db.update('users', provider.id, { commissionRateOverrideStatus: 'approved' });
    await notify(provider.id, '🎉', `You've been approved for a custom ${(provider.commissionRateOverride * 100).toFixed(1)}% commission rate, effective immediately — recognition for your excellent performance.`, null, { section: 'settings' });
    if (provider.commissionRateOverrideProposedBy) {
      await notify(provider.commissionRateOverrideProposedBy, '✅', `Your proposed commission rate for ${provider.name} was approved.`, null, { section: 'people' });
    }
    return res.json({ user: publicAdmin(updated) });
  }

  const updated = await db.update('users', provider.id, {
    commissionRateOverride: null,
    commissionRateOverrideStatus: null,
    commissionRateOverrideReason: null,
  });
  if (provider.commissionRateOverrideProposedBy) {
    await notify(provider.commissionRateOverrideProposedBy, '❌', `Your proposed commission rate for ${provider.name} was not approved.`, null, { section: 'people' });
  }
  res.json({ user: publicAdmin(updated) });
});
// no longer set their own plan (that was the actual bug: anyone could
// click a button and set themselves to Pro or Super-Pro with zero check
// on whether they'd earned it). Pro now advances automatically once real
// stats qualify (see checkAndAdvanceProviderTier); Super-Pro is
// explicitly "reviewed, not automatic" per policy, so this is the real
// approval action an admin takes after that automatic check flags
// someone as eligible.
// PATCH /api/admin/users/:id/hold — release an account from a temporary
// hold (or place one manually, for cases a real admin wants to pause
// without waiting for an automatic flag). This is the actual human
// decision every hold ultimately routes to — nothing about the hold
// system can resolve itself.
router.patch('/users/:id/hold', async (req, res) => {
  const { onHold, reason } = req.body || {};
  if (typeof onHold !== 'boolean') return res.status(400).json({ error: 'onHold must be true or false' });
  const region = await myRegion(req);
  const target = await db.find('users', u => u.id === req.params.id && (u.role === 'customer' || u.role === 'provider'));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (region && !inRegion(region, target)) return res.status(403).json({ error: 'That user is outside the area you manage' });
  const updated = await db.update('users', target.id, {
    onHold,
    holdReason: onHold ? (reason || 'Placed on hold by an admin') : null,
    holdSince: onHold ? new Date().toISOString() : null,
  });
  await notify(target.id, onHold ? '⏸️' : '✅', onHold
    ? `Your account has been temporarily paused${reason ? `: ${reason}` : ''}. Contact support if you have questions.`
    : 'Your account hold has been cleared — you can book and accept jobs normally again.', null, { section: 'settings' });
  res.json({ user: publicAdmin(updated) });
});

router.patch('/users/:id/plan', requireSuperAdmin, async (req, res) => {
  const { plan } = req.body || {};
  if (!['starter', 'pro', 'superpro'].includes(plan)) return res.status(400).json({ error: 'plan must be starter, pro, or superpro' });
  const target = await db.find('users', u => u.id === req.params.id && u.role === 'provider');
  if (!target) return res.status(404).json({ error: 'Provider not found' });
  const updated = await db.update('users', target.id, { plan, superProEligibleSince: plan === 'superpro' ? target.superProEligibleSince : null });
  await notify(target.id, '🏆', `Your plan has been updated to ${plan === 'superpro' ? 'Super-Pro' : plan === 'pro' ? 'Pro' : 'Starter'} by an admin.`, null, { section: 'settings' });
  res.json({ user: publicAdmin(updated) });
});

// POST /api/admin/users/:id/decide  { decision: 'approve' | 'reject' }
router.post('/users/:id/decide', requireDepartment(['verification', 'customer_service']), async (req, res) => {
  const { decision, rejectionReason } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
  // Item: matches the same real-reason pattern verification decisions
  // already use (see POST /verification/:id/decide below) — this route
  // used to send a generic "contact support for details" on rejection,
  // with no way to actually tell the person why. Required, not optional,
  // for the same reason it's required there: a rejection with no reason
  // just leaves someone stuck with nothing to fix.
  if (decision === 'reject' && !isNonEmptyString(rejectionReason, { min: 3, max: 500 })) {
    return res.status(400).json({ error: 'A rejection reason is required so the applicant knows what to fix' });
  }
  const region = await myRegion(req);
  const target = await db.find('users', u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (region && !inRegion(region, target)) return res.status(403).json({ error: 'That user is outside the area you manage' });
  const finalRejectionReason = decision === 'reject' ? rejectionReason.trim() : null;
  // A provider's "ID checked" badge (the `verified` flag) now comes only
  // from an ID that was actually reviewed — an approved document in the
  // Verification Queue, or an automated Persona check. Approving the
  // account alone lets them in, but doesn't put the badge on.
  // v75: customers follow the same rule. Approving the account no longer
  // marks a customer "Verified" on its own; only a reviewed ID does.
  let verifiedValue = decision === 'approve';
  let providerNeedsId = false;
  if (decision === 'approve' && (target.role === 'provider' || target.role === 'customer')) {
    const approvedId = await db.find('verifications', v => v.userId === target.id && v.status === 'approved');
    verifiedValue = !!approvedId;
    providerNeedsId = !approvedId;
  }
  const updated = await db.update('users', req.params.id, { verified: verifiedValue, status: decision === 'approve' ? 'approved' : 'rejected', rejectionReason: finalRejectionReason, approvedBy: decision === 'approve' ? req.user.sub : null, approvedAt: decision === 'approve' ? new Date().toISOString() : null });
  const approveMessage = providerNeedsId
    ? (target.role === 'customer'
        ? 'Your account has been approved. Next, verify your identity in the Verification section. You can post a job or book a pro once your ID has been reviewed.'
        : 'Your account has been approved. Next, verify your identity in the Verification section, so customers see "ID checked" and you appear in search.')
    : target.role === 'provider' && !target.profilePhotoUrl
      ? 'Your account has been approved. One more step before you appear in search and job matches: add a profile picture in Settings.'
      : 'Your account has been approved.';
  await notify(target.id, decision === 'approve' ? '✅' : '❌', decision === 'approve' ? approveMessage : `Your account application was not approved: ${finalRejectionReason}`, null, { section: 'overview' });
  // v107: tell the admin screen whether the person still has to send an ID,
  // and whether one is already waiting, so "approved but still Unverified"
  // is explained on the spot.
  const idStatus = decision === 'approve' ? (await idStatusByUser())(target.id) : null;
  res.json({ user: publicAdmin(updated), needsId: providerNeedsId, idStatus });
});

// GET /api/admin/verification-queue
// GET /api/admin/providers-with-guarantors — every provider who's
// actually submitted guarantors, for the verification team to work
// through and call. Verification-department only, matching the same
// access as the rest of the identity-verification workflow.
router.get('/providers-with-guarantors', requireDepartment(['verification']), async (req, res) => {
  const region = await myRegion(req);
  let providers = await db.filter('users', u => u.role === 'provider' && u.guarantors && u.guarantors.length > 0);
  if (region) providers = providers.filter(p => inRegion(region, p));
  // v106: flag guarantors that are not really someone else (the pro's own
  // number or name), and numbers used as a guarantor by several pros.
  const { guarantorProblem, phoneKey } = require('../guarantor-check');
  const usedBy = new Map();
  for (const p of await db.filter('users', u => u.role === 'provider' && u.guarantors && u.guarantors.length > 0)) {
    for (const g of p.guarantors) { const k = phoneKey(g.phone); if (!usedBy.has(k)) usedBy.set(k, new Set()); usedBy.get(k).add(p.id); }
  }
  res.json({ providers: providers.map(p => ({ id: p.id, name: p.name, city: p.city, category: p.category, guarantors: p.guarantors.map(g => ({ ...g, problem: guarantorProblem(p, g), sharedWithOtherPros: Math.max(0, (usedBy.get(phoneKey(g.phone)) || new Set()).size - 1) })) })) });
});

// PATCH /api/admin/providers/:id/guarantors/:index — mark one specific
// guarantor as contacted or verified, after the verification team has
// actually called them. :index refers to the guarantor's position in
// the provider's own guarantors list (0, 1, or 2).
router.patch('/providers/:id/guarantors/:index', requireDepartment(['verification']), async (req, res) => {
  const region = await myRegion(req);
  const provider = await db.find('users', u => u.id === req.params.id && u.role === 'provider');
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (region && !inRegion(region, provider)) return res.status(403).json({ error: 'That provider is outside the area you manage' });
  const idx = parseInt(req.params.index, 10);
  const guarantors = provider.guarantors || [];
  if (!Number.isInteger(idx) || idx < 0 || idx >= guarantors.length) {
    return res.status(404).json({ error: 'That guarantor was not found on this provider\'s account' });
  }
  const { status } = req.body || {};
  if (!['contacted', 'verified', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be contacted, verified or rejected' });
  // v106: a guarantor with the pro's own number or name can't be marked verified.
  const problem = require('../guarantor-check').guarantorProblem(provider, guarantors[idx]);
  if (status === 'verified' && problem) {
    return res.status(400).json({ error: problem === 'phone' ? 'This guarantor has the pro\'s own phone number, so it can\'t be verified. Mark it not accepted and ask the pro for a different person.' : 'This guarantor has the pro\'s own name, so it can\'t be verified. Mark it not accepted and ask the pro for a different person.' });
  }
  guarantors[idx] = { ...guarantors[idx], status, contactedAt: new Date().toISOString() };
  const updated = await db.update('users', provider.id, { guarantors });
  if (status === 'rejected') {
    await notify(provider.id, '❌', `Your guarantor "${guarantors[idx].name}" wasn't accepted. A guarantor must be another person with their own phone number. Please replace them in Verification.`, null, { section: 'verification' });
  }
  if (status === 'verified') {
    await notify(provider.id, '✅', `Your guarantor "${guarantors[idx].name}" has been contacted and verified — thank you for helping us keep Trothen trustworthy.`, null, { section: 'verification' });
  }
  res.json({ user: publicAdmin(updated) });
});

router.get('/verification-queue', requireDepartment(['verification']), async (req, res) => {
  const region = await myRegion(req);
  // item 12: queue now covers both real open states — a plain "pending"
  // submission and one flagged for review_required (e.g. a name mismatch,
  // see POST /verification/submit) — not one vague "in review" bucket.
  const open = await db.filter('verifications', v => ['pending', 'review_required'].includes(v.status));
  const queue = [];
  for (const v of open) {
    const user = await db.find('users', u => u.id === v.userId);
    const { documentFilename, selfieFilename, backFilename, ...vSafe } = v;
    const entry = { ...vSafe, userName: user ? user.name : 'Unknown', accountName: user ? user.name : null, role: user ? user.role : null, country: user ? user.country : '', city: user ? user.city : null, hasDocument: !!v.documentFilename, hasSelfie: !!v.selfieFilename, hasBack: !!v.backFilename };
    if (!region || inRegion(region, entry)) queue.push(entry);
  }
  // v77: tell the reviewer how files are being kept, so a storage problem
  // or the retention period is visible on the page, not buried in logs.
  const { getSetting } = require('../platform-settings');
  res.json({
    queue,
    storage: { persistent: !!process.env.PRIVATE_UPLOADS_DIR, encrypted: require('../file-crypto').isEnabled() },
    retentionDays: Number(await getSetting('idDocumentRetentionDays')) || 0,
    automatedCheckConnected: require('../persona-verification').isPersonaConfigured ? !!require('../persona-verification').isPersonaConfigured() : false,
  });
});

// ── v83: accounts closed by their owners ───────────────────────────────
// GET /api/admin/account-closures — super admin.
router.get('/account-closures', requireSuperAdmin, async (req, res) => {
  let list = [];
  try { list = await db.all('accountClosures'); } catch (e) { list = []; }
  const users = new Map((await db.all('users')).map(u => [u.id, u]));
  res.json({
    closures: list.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))).map(c => {
      const u = users.get(c.userId);
      return { ...c, name: u ? u.name : 'Unknown', email: u && !u.erased ? u.email : null, daysSinceClosed: Math.floor((Date.now() - new Date(c.requestedAt).getTime()) / 86400000) };
    }),
  });
});
// POST /api/admin/account-closures/:id/reopen — super admin. Only before erasing.
router.post('/account-closures/:id/reopen', requireSuperAdmin, async (req, res) => {
  const c = await db.find('accountClosures', x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.status !== 'closed') return res.status(409).json({ error: 'This account\'s details have already been erased. It can\'t be reopened.' });
  await db.update('users', c.userId, { active: true, closedAt: null, closedByOwner: false });
  await db.update('accountClosures', c.id, { status: 'reopened', reopenedAt: new Date().toISOString(), reopenedBy: req.user.sub });
  const { logAccess } = require('../access-log');
  await logAccess(req, 'account_reopened', c.userId);
  res.json({ ok: true });
});
// POST /api/admin/account-closures/:id/erase — super admin. Permanent.
router.post('/account-closures/:id/erase', requireSuperAdmin, async (req, res) => {
  const c = await db.find('accountClosures', x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  if (c.status !== 'closed') return res.status(409).json({ error: c.status === 'erased' ? 'Already erased' : 'This account was reopened' });
  const result = await require('../account-privacy').eraseAccount(c, req.user.sub);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const { logAccess } = require('../access-log');
  await logAccess(req, 'account_erased', c.userId);
  res.json({ ok: true });
});

// GET /api/admin/backups — v82, super admin: the nightly data copies.
router.get('/backups', requireSuperAdmin, async (req, res) => {
  const b = require('../backup-scheduler');
  res.json({ applies: b.backupsApply(), keepDays: b.KEEP_DAYS, backups: b.backupsApply() ? b.listBackups() : [] });
});
// POST /api/admin/backups/download — v99, super admin: download one
// day's backup as a single file, to keep somewhere off the server.
// The file holds every record on the site (names, contact details,
// scrambled passwords, bookings, messages), so it asks for the super
// admin's password again, is limited to a few an hour, and is logged.
const backupDownloadLimiter = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000, max: 6, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many backup downloads this hour. Try again later.' },
});
router.post('/backups/download', requireSuperAdmin, backupDownloadLimiter, async (req, res) => {
  const b = require('../backup-scheduler');
  if (!b.backupsApply()) return res.status(400).json({ error: 'Backups here only apply to the file store' });
  const admin = await me(req);
  const { password, day } = req.body || {};
  const okPw = admin && admin.passwordHash && typeof password === 'string' && await require('bcryptjs').compare(password, admin.passwordHash);
  if (!okPw) return res.status(403).json({ error: 'That password isn\'t right. Enter your own sign-in password to download a backup.' });
  let list = b.listBackups();
  if (!list.length) { b.runBackup(); list = b.listBackups(); }
  const chosen = day ? list.find(x => x.day === day) : list[0];
  if (!chosen) return res.status(404).json({ error: 'There is no backup for that day' });
  let archive;
  try { archive = b.buildBackupArchive(chosen.day); } catch (e) { return res.status(500).json({ error: 'The backup file couldn\'t be built' }); }
  const { logAccess } = require('../access-log');
  await logAccess(req, 'backup_download', `${chosen.day} (${archive.files} files, ${archive.buffer.length} bytes)`);
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${archive.filename}"`, 'Content-Length': archive.buffer.length, 'Cache-Control': 'no-store' });
  res.end(archive.buffer);
});

// POST /api/admin/backups/run — v82, super admin: take a copy right now
// (for example just before a risky change).
router.post('/backups/run', requireSuperAdmin, async (req, res) => {
  const b = require('../backup-scheduler');
  if (!b.backupsApply()) return res.status(400).json({ error: 'Backups here only apply to the file store' });
  try {
    const result = b.runBackup();
    const { logAccess } = require('../access-log');
    await logAccess(req, 'backup_run', result.day);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: 'The backup failed: ' + e.message }); }
});

// POST /api/admin/users/:id/temp-password — v81, super admin only.
// The way back in for someone who has forgotten their password while
// reset-by-email isn't connected. Makes a one-time password, shows it to
// the super admin once, signs the person out everywhere, and makes them
// choose a new password the next time they sign in. Written to the access
// log. The super admin should give it to the person only after confirming
// who they are (for example by calling the phone number on the account).
router.post('/users/:id/temp-password', requireSuperAdmin, async (req, res) => {
  const target = await db.find('users', u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.sub) return res.status(400).json({ error: 'Use Change Password in your own settings for your own account' });
  if (target.isSuperAdmin) return res.status(403).json({ error: 'A super admin\'s password can\'t be reset from here' });
  const { hashPassword } = require('../auth');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = require('crypto').randomBytes(14);
  const tempPassword = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  await db.update('users', target.id, { passwordHash: hashPassword(tempPassword), mustChangePassword: true, tokenVersion: (target.tokenVersion || 0) + 1 });
  const { logAccess } = require('../access-log');
  await logAccess(req, 'temp_password_issued', target.id);
  await notify(target.id, '🔐', 'Your password was reset by the Trothen team. If you didn\'t ask for this, contact support straight away.', null, { section: 'settings' });
  res.json({ ok: true, tempPassword });
});

// PATCH /api/admin/settings/id-retention  { days } — super admin only.
// 0 keeps files until deleted by hand; otherwise 7 to 3650 days.
router.patch('/settings/id-retention', requireSuperAdmin, async (req, res) => {
  const days = Number((req.body || {}).days);
  if (!Number.isInteger(days) || days < 0 || (days > 0 && days < 7) || days > 3650) {
    return res.status(400).json({ error: 'Enter 0 to keep files, or a whole number of days from 7 to 3650' });
  }
  const { setSetting } = require('../platform-settings');
  await setSetting('idDocumentRetentionDays', days);
  const { logAccess } = require('../access-log');
  await logAccess(req, 'id_retention_update', String(days));
  res.json({ ok: true, retentionDays: days });
});

// POST /api/admin/verification-gaps-ask-all — v77: one message to every
// person marked verified with no reviewed ID and none waiting. Nobody's
// badge is removed by this.
router.post('/verification-gaps-ask-all', requireDepartment(['verification']), async (req, res) => {
  const region = await myRegion(req);
  const approvedIds = new Set((await db.filter('verifications', v => v.status === 'approved')).map(v => v.userId));
  const openIds = new Set((await db.filter('verifications', v => ['pending', 'review_required'].includes(v.status))).map(v => v.userId));
  const people = await db.filter('users', u => (u.role === 'provider' || u.role === 'customer') && u.verified === true && !approvedIds.has(u.id) && !openIds.has(u.id) && (!region || inRegion(region, u)));
  for (const p of people) {
    await notify(p.id, '🪪', p.role === 'customer'
      ? 'Please verify your identity in the Verification section, so your "Verified" status is backed by a reviewed ID.'
      : 'Please verify your identity in the Verification section, so the "ID checked" badge on your profile is backed by a reviewed ID.', null, { section: 'verification' });
  }
  res.json({ ok: true, asked: people.length });
});

// v82: every ID file is opened through this one place. It decrypts when
// the file was stored encrypted, sets the right type from the file's own
// first bytes (never the stored name), and keeps it out of every cache.
function sendPrivateIdFile(res, filename) {
  const pathMod = require('path');
  const { PRIVATE_UPLOADS_DIR } = require('../uploads');
  const filePath = pathMod.join(PRIVATE_UPLOADS_DIR, pathMod.basename(String(filename)));
  if (!require('fs').existsSync(filePath)) return res.status(404).json({ error: 'The file is missing on disk' });
  let buf;
  try { buf = require('../file-crypto').readPossiblyEncrypted(filePath); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  const head = buf.subarray(0, 12);
  const type = head.subarray(0, 4).toString('latin1') === '%PDF' ? 'application/pdf'
    : (head[0] === 0x89 && head[1] === 0x50) ? 'image/png'
    : (head[0] === 0xFF && head[1] === 0xD8) ? 'image/jpeg'
    : (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') ? 'image/webp'
    : 'application/octet-stream';
  res.set('Cache-Control', 'no-store, private');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', type);
  res.send(buf);
}

// GET /api/admin/verification/:id/back — v80: the back of the ID, when
// one was sent. Same rules as the front and the face photo.
router.get('/verification/:id/back', requireDepartment(['verification']), async (req, res) => {
  const record = await db.find('verifications', v => v.id === req.params.id);
  if (!record || !record.backFilename) return res.status(404).json({ error: 'No back of ID on record' });
  const region = await myRegion(req);
  const user = await db.find('users', u => u.id === record.userId);
  if (region && (!user || !inRegion(region, user))) return res.status(403).json({ error: 'That user is outside the area you manage' });
  const { logAccess } = require('../access-log');
  await logAccess(req, 'verification_document_back', record.id);
  sendPrivateIdFile(res, record.backFilename);
});

// GET /api/admin/verification/:id/selfie — v77: the face photo sent with
// the ID. Same rules as the document below: verification team only, own
// city only, every look recorded, never cached.
router.get('/verification/:id/selfie', requireDepartment(['verification']), async (req, res) => {
  const record = await db.find('verifications', v => v.id === req.params.id);
  if (!record || !record.selfieFilename) return res.status(404).json({ error: 'No face photo on record' });
  const region = await myRegion(req);
  const user = await db.find('users', u => u.id === record.userId);
  if (region && (!user || !inRegion(region, user))) return res.status(403).json({ error: 'That user is outside the area you manage' });
  const { logAccess } = require('../access-log');
  await logAccess(req, 'verification_selfie', record.id);
  sendPrivateIdFile(res, record.selfieFilename);
});

// GET /api/admin/verification-history — v85: checks that have already been
// decided, newest first, so a reviewer can look back at the documents for
// as long as the files are kept. Same people can see it as the queue, and
// a city admin only sees their own city.
router.get('/verification-history', requireDepartment(['verification']), async (req, res) => {
  const region = await myRegion(req);
  const decided = (await db.filter('verifications', v => ['approved', 'rejected', 'superseded'].includes(v.status)))
    .sort((a, b) => String(b.reviewedAt || b.createdAt || '').localeCompare(String(a.reviewedAt || a.createdAt || '')));
  const users = new Map((await db.all('users')).map(u => [u.id, u]));
  const { getSetting } = require('../platform-settings');
  const retentionDays = Number(await getSetting('idDocumentRetentionDays')) || 0;
  const onHold = await require('../id-retention-scheduler').accountsOnRetentionHold(); // v95
  const history = [];
  for (const v of decided) {
    const user = users.get(v.userId);
    if (region && (!user || !inRegion(region, user))) continue;
    const reviewer = v.reviewedBy && v.reviewedBy !== 'persona' ? users.get(v.reviewedBy) : null;
    const decidedAt = v.reviewedAt || v.createdAt || null;
    history.push({
      id: v.id,
      userName: user ? user.name : 'Unknown',
      role: user ? user.role : null,
      city: user ? user.city : null,
      docType: v.docType || null,
      idLegalName: v.idLegalName || null,
      status: v.status,
      rejectionReason: v.rejectionReason || null,
      decidedAt,
      reviewedByName: v.reviewedBy === 'persona' || v.source === 'persona' ? 'Automated check' : (reviewer ? reviewer.name : null),
      hasDocument: !!v.documentFilename, hasBack: !!v.backFilename, hasSelfie: !!v.selfieFilename,
      filesDeletedAt: v.filesDeletedAt || null,
      filesHeldReason: (v.documentFilename || v.selfieFilename || v.backFilename) ? (onHold.get(v.userId) || null) : null, // v95: kept past the period while this is open
      filesDeleteOn: (retentionDays > 0 && decidedAt && (v.documentFilename || v.selfieFilename || v.backFilename) && !onHold.has(v.userId))
        ? new Date(new Date(decidedAt).getTime() + retentionDays * 86400000).toISOString().slice(0, 10) : null,
    });
    if (history.length >= 200) break;
  }
  res.json({ history });
});

// GET /api/admin/verification-gaps — providers who carry the verified
// badge but have no approved ID on file (for example, approved through
// account approval before v64). Listed so a reviewer can ask them for an
// ID, or take the badge off until one is checked.
router.get('/verification-gaps', requireDepartment(['verification']), async (req, res) => {
  const region = await myRegion(req);
  const approvedIds = new Set((await db.filter('verifications', v => v.status === 'approved')).map(v => v.userId));
  const openIds = new Set((await db.filter('verifications', v => ['pending', 'review_required'].includes(v.status))).map(v => v.userId));
  const gaps = (await db.filter('users', u => (u.role === 'provider' || u.role === 'customer') && u.verified === true && !approvedIds.has(u.id) && (!region || inRegion(region, u))))
    .map(u => ({ id: u.id, name: u.name, role: u.role, city: u.city || null, country: u.country || null, idSubmitted: openIds.has(u.id) }));
  res.json({ gaps });
});

// v107: GET /api/admin/verification-waiting — people who are NOT verified
// and have nothing in the queue: they have never sent an ID, or their last
// one was turned down. Nothing an admin can approve; the next step is
// theirs. Listed so the team can see them and send a reminder.
router.get('/verification-waiting', requireDepartment(['verification']), async (req, res) => {
  const region = await myRegion(req);
  const idOf = await idStatusByUser();
  const people = (await db.filter('users', u => (u.role === 'provider' || u.role === 'customer') && u.verified !== true && u.active !== false && u.status !== 'rejected' && !u.erased && (!region || inRegion(region, u))))
    .map(u => ({ id: u.id, name: u.name, role: u.role, city: u.city || null, country: u.country || null, joined: (u.createdAt || '').slice(0, 10), idStatus: idOf(u.id), accountApproved: u.status === 'approved', lastIdReminderAt: u.lastIdReminderAt || null }))
    .filter(p => p.idStatus === 'none' || p.idStatus === 'rejected')
    .sort((a, b) => String(b.joined).localeCompare(String(a.joined)));
  res.json({ people, counts: { customers: people.filter(p => p.role === 'customer').length, providers: people.filter(p => p.role === 'provider').length } });
});

// POST /api/admin/verification-gaps/:userId  { action: 'request' | 'remove_badge' | 'remind' }
router.post('/verification-gaps/:userId', requireDepartment(['verification']), async (req, res) => {
  const { action } = req.body || {};
  if (!['request', 'remove_badge', 'remind'].includes(action)) return res.status(400).json({ error: 'action must be request, remove_badge or remind' });
  const region = await myRegion(req);
  const target = await db.find('users', u => u.id === req.params.userId && (u.role === 'provider' || u.role === 'customer'));
  if (!target) return res.status(404).json({ error: 'Person not found' });
  if (region && !inRegion(region, target)) return res.status(403).json({ error: 'That user is outside the area you manage' });
  const isCustomer = target.role === 'customer';
  if (action === 'remind') {
    // v107: a nudge to someone who isn't verified yet. At most one a day each.
    if (target.verified === true) return res.status(400).json({ error: 'This person is already verified.' });
    if (target.lastIdReminderAt && (Date.now() - new Date(target.lastIdReminderAt).getTime()) < 24 * 60 * 60 * 1000) return res.status(429).json({ error: 'They were already reminded in the last day.' });
    await notify(target.id, '🪪', isCustomer
      ? 'Reminder: please verify your identity in the Verification section. Upload a government ID and a photo of your face. You can post a job or book a pro once it has been reviewed.'
      : 'Reminder: please verify your identity in the Verification section. Upload a government ID and a photo of your face. You appear in search and can take jobs once it has been reviewed.', null, { section: 'verification' });
    await db.update('users', target.id, { lastIdReminderAt: new Date().toISOString() });
  } else if (action === 'remove_badge') {
    await db.update('users', target.id, { verified: false });
    await notify(target.id, '🪪', isCustomer
      ? 'Before your next booking, please verify your identity in the Verification section. It only takes a few minutes.'
      : 'To keep your "ID checked" badge and stay in search, please verify your identity in the Verification section. It only takes a few minutes.', null, { section: 'verification' });
  } else {
    await notify(target.id, '🪪', isCustomer
      ? 'Please verify your identity in the Verification section, so your "Verified" status is backed by a reviewed ID.'
      : 'Please verify your identity in the Verification section, so the "ID checked" badge on your profile is backed by a reviewed ID.', null, { section: 'verification' });
  }
  const { logAccess } = require('../access-log');
  await logAccess(req, `verification_gap_${action}`, target.id);
  res.json({ ok: true });
});

// GET /api/admin/verification/:id/document — the actual document file
// behind a verification record. Private by design (see PRIVATE_UPLOADS_DIR
// in src/uploads.js) — this is the ONLY way to see it, gated the exact
// same way as the decide action above: a super admin, a verification-
// department admin (any region), or the submitter's own plain regional
// admin. This is also the real fix for the "only superadmin can see
// verification documents/guarantors" report — requireDepartment already
// lets a plain regional admin (no department set) through; what was
// actually missing was this route existing at all.
router.get('/verification/:id/document', requireDepartment(['verification']), async (req, res) => {
  const record = await db.find('verifications', v => v.id === req.params.id);
  if (!record || !record.documentFilename) return res.status(404).json({ error: 'Document not found' });
  const region = await myRegion(req);
  const user = await db.find('users', u => u.id === record.userId);
  if (region && (!user || !inRegion(region, user))) return res.status(403).json({ error: 'That user is outside the area you manage' });
  // Every look at someone's ID is recorded (who, when, which record), and
  // the file is never kept in the browser's or any proxy's cache.
  const { logAccess } = require('../access-log');
  await logAccess(req, 'verification_document', record.id);
  sendPrivateIdFile(res, record.documentFilename);
});

// POST /api/admin/verification/:id/decide  { decision: 'approve' | 'reject', rejectionReason? }
router.post('/verification/:id/decide', requireDepartment(['verification']), async (req, res) => {
  const { decision, rejectionReason } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
  if (decision === 'reject' && !isNonEmptyString(rejectionReason, { min: 3, max: 500 })) {
    return res.status(400).json({ error: 'A rejection reason is required so the applicant knows what to fix and resubmit' });
  }
  const record = await db.find('verifications', v => v.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Verification record not found' });
  // Only a submission that's still waiting can be decided. An older one
  // replaced by a newer upload ("superseded"), or one already decided,
  // can't be approved by mistake from a stale screen.
  if (!['pending', 'review_required'].includes(record.status)) {
    return res.status(409).json({ error: `This submission is already ${record.status.replace('_', ' ')} — refresh the queue.` });
  }
  const region = await myRegion(req);
  const user = await db.find('users', u => u.id === record.userId);
  if (region && (!user || !inRegion(region, user))) return res.status(403).json({ error: 'That user is outside the area you manage' });
  if (user && user.id === req.user.sub) return res.status(403).json({ error: 'You can\'t review your own verification' });
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const finalRejectionReason = decision === 'reject' ? rejectionReason.trim() : null;
  // Who decided and when, kept with the record.
  await db.update('verifications', record.id, { status, rejectionReason: finalRejectionReason, reviewedBy: req.user.sub, reviewedAt: new Date().toISOString() });
  if (decision === 'approve') await db.update('users', record.userId, { verified: true });
  const approveMessage = user && user.role === 'provider' && !user.profilePhotoUrl
    ? 'Your identity verification was approved. One more step before you appear in search and job matches: add a profile picture in Settings.'
    : 'Your identity verification was approved.';
  await notify(record.userId, decision === 'approve' ? '✅' : '❌', decision === 'approve' ? approveMessage : `Your identity verification was rejected: ${rejectionReason.trim()} — please resubmit your documents.`, null, { section: 'verification' });
  res.json({ verification: { ...record, status, rejectionReason: finalRejectionReason } });
});

// GET /api/admin/disputes
router.get('/disputes', requireDepartment(['disputes', 'customer_service', 'legal']), async (req, res) => {
  const { logAccess } = require('../access-log');
  await logAccess(req, 'disputes_list');
  const region = await myRegion(req);
  const { from, to } = req.query;
  const all = await db.all('disputes');
  const allContractsForDisputes = await db.all('contracts');
  const allCustomersForDisputes = await db.filter('users', u => u.role === 'customer');
  const contractByIdForDisputes = new Map(allContractsForDisputes.map(c => [c.id, c]));
  const customerByIdForDisputes = new Map(allCustomersForDisputes.map(c => [c.id, c]));
  const disputes = [];
  for (const d of all) {
    if (from && (d.createdAt || '').slice(0, 10) < from) continue;
    if (to && (d.createdAt || '').slice(0, 10) > to) continue;
    if (!region || inRegion(region, await disputeCustomer(d, contractByIdForDisputes, customerByIdForDisputes))) disputes.push(d);
  }
  res.json({ disputes });
});

// GET /api/admin/disputes/pdf — a real downloadable dispute report,
// respecting the same region/department scope as the on-screen list.
// GET /api/admin/fraud-flags — every real flag raised by the rule-based
// fraud/safety checks, newest first. This is what actually backs the "every
// job screened automatically" claim — a real, reviewable queue, not just a
// marketing line.
router.get('/fraud-flags', requireDepartment('disputes'), async (req, res) => {
  const flags = await db.all('fraudFlags');
  const withNames = await Promise.all(flags.map(async f => {
    const user = f.userId ? await db.find('users', u => u.id === f.userId) : null;
    const relatedUser = f.relatedUserId ? await db.find('users', u => u.id === f.relatedUserId) : null;
    return {
      id: f.id, type: f.type, severity: f.severity, details: f.details, status: f.status,
      userName: user ? user.name : null, userEmail: user ? user.email : null,
      relatedUserName: relatedUser ? relatedUser.name : null,
      contractId: f.contractId, createdAt: f.createdAt,
    };
  }));
  withNames.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ flags: withNames });
});

// POST /api/admin/fraud-flags/:id/resolve — mark a flag reviewed or
// dismissed after a human has actually looked at it.
router.post('/fraud-flags/:id/resolve', requireDepartment('disputes'), async (req, res) => {
  const { decision } = req.body || {}; // 'reviewed' or 'dismissed'
  if (!['reviewed', 'dismissed'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be reviewed or dismissed' });
  }
  const flag = await db.find('fraudFlags', f => f.id === req.params.id);
  if (!flag) return res.status(404).json({ error: 'Flag not found' });
  const updated = await db.update('fraudFlags', flag.id, { status: decision, reviewedAt: new Date().toISOString() });
  res.json({ flag: updated });
});

router.get('/disputes/pdf', requireDepartment(['disputes', 'customer_service', 'legal']), async (req, res) => {
  const region = await myRegion(req);
  const { from, to } = req.query;
  const all = await db.all('disputes');
  const allContractsForDisputesPdf = await db.all('contracts');
  const allCustomersForDisputesPdf = await db.filter('users', u => u.role === 'customer');
  const contractByIdForDisputesPdf = new Map(allContractsForDisputesPdf.map(c => [c.id, c]));
  const customerByIdForDisputesPdf = new Map(allCustomersForDisputesPdf.map(c => [c.id, c]));
  const disputes = [];
  for (const d of all) {
    if (from && (d.createdAt || '').slice(0, 10) < from) continue;
    if (to && (d.createdAt || '').slice(0, 10) > to) continue;
    if (!region || inRegion(region, await disputeCustomer(d, contractByIdForDisputesPdf, customerByIdForDisputesPdf))) disputes.push(d);
  }
  disputes.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const me_ = await me(req);
  const { createReportDoc } = require('../pdf-report-builder');
  const rangeLabel = from || to ? `${from || 'earliest'} to ${to || 'today'}` : 'All time';
  const { sectionHeader, row, twoColumnRow, table, finish } = createReportDoc({
    res,
    filename: `Trothen-Disputes-Report.pdf`,
    title: 'Disputes Report',
    subtitle: region ? `Scoped to ${region}` : 'All locations',
    docId: rangeLabel,
    verificationSeed: `disputes|${me_.id}|${region || 'all'}|${from || ''}|${to || ''}|${disputes.length}`,
  });

  sectionHeader('Report Summary');
  twoColumnRow('Scope', region || 'All locations', 'Date Range', rangeLabel);
  const open = disputes.filter(d => d.status === 'open').length;
  const resolved = disputes.filter(d => d.status === 'resolved').length;
  twoColumnRow('Total Disputes', String(disputes.length), 'Open / Resolved', `${open} open, ${resolved} resolved`);

  sectionHeader('Disputes');
  if (disputes.length === 0) {
    row('No disputes', 'No disputes were found in this date range.');
  } else {
    table(
      [{ label: 'Dispute', width: 75 }, { label: 'Parties', width: 140 }, { label: 'Reason', width: 150 }, { label: 'Amount', width: 55, align: 'right' }, { label: 'Status', width: 60 }],
      disputes.map(d => [d.id, d.parties, d.reason, `$${d.amount}`, d.status])
    );
  }

  finish({ closingNote: 'This report reflects Trothen\'s dispute records within the scope and date range shown, as of the moment it was generated.' });
});

// GET /api/admin/transactions — every real contract on the platform (or
// within an admin's assigned city), with escrow and payout status. This is
// what the admin Payments page actually needs — previously it was showing
// unrelated demo data, not real platform transactions.
router.get('/transactions', requireDepartment(['financial', 'accountant', 'controller', 'legal']), async (req, res) => {
  const { logAccess } = require('../access-log');
  await logAccess(req, 'transactions_list');
  const region = await myRegion(req);
  const { from, to } = req.query;
  let contracts = await db.all('contracts');
  if (from) contracts = contracts.filter(c => (c.createdAt || '').slice(0, 10) >= from);
  if (to) contracts = contracts.filter(c => (c.createdAt || '').slice(0, 10) <= to);
  contracts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const rows = await Promise.all(contracts.map(async c => {
    const customer = await db.find('users', u => u.id === c.customerId);
    const provider = await db.find('users', u => u.id === c.providerId);
    const escrow = await db.find('escrowTransactions', e => e.contractId === c.id);
    return { c, customer, provider, escrow };
  }));
  const orgsById = new Map((await db.all('organizations')).map(o => [o.id, o]));

  const scoped = region ? rows.filter(r => r.customer && inRegion(region, r.customer)) : rows;
  const transactions = scoped.map(({ c, customer, provider, escrow }) => {
    const materialsAdvanceAmount = (escrow && escrow.materialsAdvanceAmount) || 0;
    // Real commission is only recorded on the payout itself, once it's
    // actually paid out (see payments.routes.js). Until then, this is a
    // clearly-labeled *estimate* — amount x the provider's effective rate
    // (their org's volume-discount rate if they're on a Custom-plan org,
    // otherwise their individual plan rate) — so admins aren't left
    // guessing what a job will net the platform before payout happens.
    const commissionRate = provider ? effectiveCommissionRate(provider, orgsById.get(provider.organizationId)) : null;
    const estCommission = commissionRate != null ? Math.round(Math.max(0, c.amount - (c.storeGoodsTotal || 0)) * commissionRate * 100) / 100 : null; // v105: no commission on store goods
    return {
      contractId: c.id,
      bookingNumber: c.bookingNumber || c.id,
      date: (c.createdAt || '').slice(0, 10),
      customerName: customer ? customer.name : 'Unknown',
      customerEmail: customer ? customer.email : null,
      providerName: provider ? provider.name : 'Unknown',
      category: provider ? (provider.category || null) : null,
      city: customer ? (customer.city || null) : null,
      country: customer ? (customer.country || null) : null,
      service: c.service,
      amount: c.amount,
      materialsAdvanceAmount,
      status: c.status,
      escrowStatus: escrow ? escrow.status : 'none',
      paidOut: !!(escrow && escrow.payoutId),
      commissionRate,
      estCommission,
    };
  });
  res.json({ transactions });
});

// GET /api/admin/transactions/pdf — a real, downloadable platform
// transactions report, same scoping and date range as the JSON endpoint.
router.get('/transactions/pdf', requireDepartment(['financial', 'accountant', 'controller', 'legal']), async (req, res) => {
  const { logAccess } = require('../access-log');
  await logAccess(req, 'transactions_pdf_download');
  const region = await myRegion(req);
  const { from, to } = req.query;
  let contracts = await db.all('contracts');
  if (from) contracts = contracts.filter(c => (c.createdAt || '').slice(0, 10) >= from);
  if (to) contracts = contracts.filter(c => (c.createdAt || '').slice(0, 10) <= to);

  const rows = await Promise.all(contracts.map(async c => {
    const customer = await db.find('users', u => u.id === c.customerId);
    const provider = await db.find('users', u => u.id === c.providerId);
    const escrow = await db.find('escrowTransactions', e => e.contractId === c.id);
    return { c, customer, provider, escrow };
  }));
  const scoped = (region ? rows.filter(r => r.customer && inRegion(region, r.customer)) : rows)
    .sort((a, b) => new Date(a.c.createdAt) - new Date(b.c.createdAt));

  const me_ = await me(req);
  const { createReportDoc } = require('../pdf-report-builder');
  const rangeLabel = from || to ? `${from || 'earliest'} to ${to || 'today'}` : 'All time';

  // Realized commission = what's actually been deducted on real payouts,
  // scoped to the same region and date range as the transactions above —
  // distinct from the estimate, which projects commission on jobs that
  // haven't paid out yet.
  let payoutsInScope = await db.all('payouts');
  if (from) payoutsInScope = payoutsInScope.filter(p => (p.date || '').slice(0, 10) >= from);
  if (to) payoutsInScope = payoutsInScope.filter(p => (p.date || '').slice(0, 10) <= to);
  if (region) {
    const regionalProviderIds = new Set((await db.filter('users', u => u.role === 'provider' && inRegion(region, u))).map(u => u.id));
    payoutsInScope = payoutsInScope.filter(p => regionalProviderIds.has(p.providerId));
  }
  const payoutsCommissionInScope = payoutsInScope.reduce((s, p) => s + (p.commissionAmount || 0) + (p.storeFeeAmount || 0), 0); // v106
  const orgsById = new Map((await db.all('organizations')).map(o => [o.id, o]));

  const { sectionHeader, row, twoColumnRow, table, finish } = createReportDoc({
    res,
    filename: `Trothen-Platform-Transactions-Report.pdf`,
    title: 'Platform Transactions Report',
    subtitle: region ? `Scoped to ${region}` : 'All locations',
    docId: rangeLabel,
    verificationSeed: `transactions|${me_.id}|${region || 'all'}|${from || ''}|${to || ''}|${scoped.length}`,
  });

  sectionHeader('Report Summary');
  twoColumnRow('Scope', region || 'All locations', 'Date Range', rangeLabel);
  const totalGMV = scoped.reduce((s, r) => s + r.c.amount, 0);
  const totalHeld = scoped.filter(r => r.escrow && r.escrow.status === 'held').reduce((s, r) => s + r.escrow.amount, 0);
  const totalReleased = scoped.filter(r => r.escrow && r.escrow.status === 'released').reduce((s, r) => s + r.escrow.amount, 0);
  const totalEstCommission = scoped.reduce((s, r) => s + Math.max(0, r.c.amount - (r.c.storeGoodsTotal || 0)) * effectiveCommissionRate(r.provider, orgsById.get(r.provider && r.provider.organizationId)), 0);
  twoColumnRow('Total GMV', `$${totalGMV.toFixed(2)}`, 'Transactions', String(scoped.length));
  twoColumnRow('Escrow Held', `$${totalHeld.toFixed(2)}`, 'Escrow Released', `$${totalReleased.toFixed(2)}`);
  twoColumnRow('Est. Commission (unpaid + paid)', `$${totalEstCommission.toFixed(2)}`, 'Realized Commission (paid out)', `$${payoutsCommissionInScope.toFixed(2)}`);

  sectionHeader('Transactions');
  if (scoped.length === 0) {
    row('No transactions', 'No transactions were found in this date range.');
  } else {
    table(
      [{ label: 'Date', width: 45 }, { label: 'Customer', width: 75 }, { label: 'Provider', width: 75 }, { label: 'Category', width: 55 }, { label: 'Service', width: 75 }, { label: 'Amount', width: 45, align: 'right' }, { label: 'Est. Comm.', width: 50, align: 'right' }, { label: 'Status', width: 45 }],
      scoped.map(({ c, customer, provider }) => [
        (c.createdAt || '').slice(0, 10),
        customer ? customer.name : 'Unknown',
        provider ? provider.name : 'Unknown',
        (provider && provider.category) || '—',
        c.service,
        `$${c.amount}`,
        `$${(Math.max(0, c.amount - (c.storeGoodsTotal || 0)) * effectiveCommissionRate(provider, orgsById.get(provider && provider.organizationId))).toFixed(2)}`,
        c.status,
      ])
    );
  }

  finish({ closingNote: 'This report reflects Trothen\'s transaction records within the scope and date range shown, as of the moment it was generated. GMV figures are gross booking values, not net of commission.' });
});

router.post('/disputes/:id/resolve', requireDepartment(['disputes', 'customer_service']), async (req, res) => {
  const region = await myRegion(req);
  const dispute = await db.find('disputes', d => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
  if (region && !inRegion(region, await disputeCustomer(dispute))) return res.status(403).json({ error: 'That dispute is outside the area you manage' });

  // Previously this only ever had one outcome: release escrow to the
  // provider, no matter what the dispute was actually about. If a
  // customer's complaint was legitimate — the provider never showed up,
  // did damage, didn't finish the job — there was no way to refund them
  // instead. Now the admin picks: release to the provider (defaults to
  // this when no decision is given, so nothing about existing behavior
  // silently changes for a request that doesn't specify one) or refund
  // the customer.
  const { decision, note } = req.body || {};
  // v84: the decision has to be spelled out. It used to be that anything
  // other than "refund_customer" (a typo, or nothing at all) quietly
  // released the money to the pro.
  // v96: a third outcome, "split": part goes back to the customer and the
  // rest is released to the pro.
  if (!['refund_customer', 'release_to_provider', 'split'].includes(decision)) {
    return res.status(400).json({ error: 'Choose a decision: refund the customer, release the payment to the pro, or split it' });
  }
  const outcome = decision;
  // Item: Joseph asked for a real way for the dispute team to explain a
  // decision to the people it actually affects — both parties previously
  // only ever got a fixed, generic line regardless of what the dispute
  // was actually about. Required, matching the same real-reason pattern
  // already used for verification/account rejections.
  if (!isNonEmptyString(note, { min: 3, max: 500 })) {
    return res.status(400).json({ error: 'A note explaining the resolution is required — both parties will see it' });
  }
  const trimmedNote = note.trim();

  // v84: a dispute is decided once. Before this, a resolved dispute could
  // be resolved again the other way, and again, moving the payment each
  // time: a customer could be refunded after the pro had already been
  // paid, so the same money was given out twice.
  if (['resolved', 'closed', 'rejected'].includes(dispute.status)) {
    return res.status(409).json({ error: `This dispute is already ${dispute.status}. A super admin has to reopen it before it can be decided again.` });
  }
  const escrowNow = await db.find('escrowTransactions', e => e.contractId === dispute.contractId);
  if (outcome === 'refund_customer' && escrowNow && (escrowNow.payoutId || escrowNow.materialsAdvancePayoutId)) {
    return res.status(409).json({ error: 'The pro has already been paid out for this booking, so the system can\'t refund it. This one has to be settled by hand: recover the money from the pro or refund the customer from Trothen\'s own funds, and record what was done in a note.' });
  }
  if (outcome === 'release_to_provider' && escrowNow && escrowNow.status === 'refunded') {
    return res.status(409).json({ error: 'This payment has already been refunded to the customer, so it can\'t be released to the pro.' });
  }
  // v96: split. Only possible while the whole payment is still held, so
  // the two parts always add up to exactly what the customer paid.
  let splitRefund = 0;
  if (outcome === 'split') {
    if (!escrowNow) return res.status(409).json({ error: 'There is no payment on this booking to split.' });
    if (escrowNow.status !== 'held' || escrowNow.payoutId || escrowNow.materialsAdvancePayoutId) {
      return res.status(409).json({ error: 'A split is only possible while the whole payment is still held. Part of this one has already been released, refunded or paid out.' });
    }
    const amt = Number((req.body || {}).refundAmount);
    splitRefund = Math.round(amt * 100) / 100;
    if (!Number.isFinite(amt) || splitRefund <= 0 || splitRefund >= escrowNow.amount) {
      return res.status(400).json({ error: `Enter how much to refund to the customer: more than 0 and less than the full $${escrowNow.amount}. For all or nothing, use Refund or Release instead.` });
    }
  }

  const updated = await db.update('disputes', dispute.id, { status: 'resolved', resolvedAt: new Date().toISOString(), resolution: outcome });
  const resolvingAdmin = await me(req);
  await db.insert('disputeAuditLog', {
    id: `dal_${nanoid(10)}`,
    disputeId: dispute.id,
    action: 'resolve',
    note: `${outcome === 'refund_customer' ? 'Resolved: refunded the customer' : outcome === 'split' ? `Resolved: split. $${splitRefund} refunded to the customer, the rest released to the provider` : 'Resolved: released escrow to the provider'} — ${trimmedNote}`,
    actorId: resolvingAdmin ? resolvingAdmin.id : null,
    actorName: resolvingAdmin ? resolvingAdmin.name : 'Unknown admin',
    createdAt: new Date().toISOString(),
  });
  const escrow = await db.find('escrowTransactions', e => e.contractId === updated.contractId);
  const contract = await db.find('contracts', c => c.id === updated.contractId);

  // v84: the booking itself is closed out too. It used to stay "disputed"
  // for good after the dispute was settled.
  if (contract && contract.status === 'disputed') {
    if (outcome === 'refund_customer') {
      await db.update('contracts', contract.id, { status: 'cancelled', cancelledByRole: 'dispute', cancelledAt: new Date().toISOString(), cancelReason: 'Refunded after a dispute' });
    } else {
      await db.update('contracts', contract.id, { status: 'completed', completedAt: new Date().toISOString(), completedVia: 'dispute' });
      const pro = await db.find('users', u => u.id === contract.providerId);
      if (pro) await db.update('users', pro.id, { jobs: (pro.jobs || 0) + 1 });
      try { await require('../commission').checkAndAdvanceProviderTier(contract.providerId); } catch (e) { /* never block a resolution on this */ }
    }
  }

  if (outcome === 'split') {
    const released = Math.round((escrow.amount - splitRefund) * 100) / 100;
    // The payment record now carries the part released to the pro (so
    // commission and the payout are worked out on that part only), and
    // remembers the original amount and the part refunded.
    await db.update('escrowTransactions', escrow.id, { status: 'released', originalAmount: escrow.amount, refundedAmount: splitRefund, amount: released, splitByDisputeId: dispute.id });
    await db.update('disputes', dispute.id, { refundedAmount: splitRefund, releasedAmount: released });
    if (contract) {
      await db.update('contracts', contract.id, { refundedAmount: splitRefund });
      await notify(contract.customerId, '⚖️', `Your dispute (${dispute.reason}) has been resolved with a split: $${splitRefund} is refunded to you and $${released} goes to your pro. ${trimmedNote}`, 'bookingUpdates', { section: 'bookings' });
      await notify(contract.providerId, '⚖️', `A dispute on one of your jobs (${dispute.reason}) has been resolved with a split: $${released} is released to you and $${splitRefund} is refunded to the customer. ${trimmedNote}`, 'bookingUpdates', { section: 'earnings' });
    }
    return res.json({ dispute: { ...updated, refundedAmount: splitRefund, releasedAmount: released } });
  }

  if (outcome === 'refund_customer') {
    const wasRefunded = escrow && escrow.status === 'refunded';
    if (escrow && !wasRefunded) await db.update('escrowTransactions', escrow.id, { status: 'refunded' });
    if (contract) {
      await notify(contract.customerId, '⚖️', `Your dispute (${dispute.reason}) has been resolved in your favor — ${wasRefunded ? 'your payment was already refunded.' : 'your payment has been refunded.'} ${trimmedNote}`, 'bookingUpdates', { section: 'bookings' });
      await notify(contract.providerId, '⚖️', `A dispute on one of your jobs (${dispute.reason}) has been resolved — the customer was refunded, so this booking's escrow will not be released to you. ${trimmedNote}`, 'bookingUpdates', { section: 'bookings' });
    }
    return res.json({ dispute: updated });
  }

  const wasReleased = escrow && escrow.status !== 'released';
  if (escrow) await db.update('escrowTransactions', escrow.id, { status: 'released' });
  if (contract) {
    await notify(contract.customerId, '⚖️', `Your dispute (${dispute.reason}) has been resolved. ${trimmedNote}`, 'bookingUpdates', { section: 'bookings' });
    if (wasReleased) {
      const providerContracts = await db.filter('contracts', c => c.providerId === contract.providerId);
      const providerContractIds = new Set(providerContracts.map(c => c.id));
      const releasedUnpaid = (await db.filter('escrowTransactions', e => e.status === 'released' && !e.payoutId))
        .filter(e => providerContractIds.has(e.contractId));
      const totalAvailable = releasedUnpaid.reduce((s, e) => s + e.amount, 0);
      await notify(contract.providerId, '⚖️', `A dispute on one of your jobs (${dispute.reason}) has been resolved — escrow released. You now have $${totalAvailable} available to request as a payout. ${trimmedNote}`, 'bookingUpdates', { section: 'earnings' });
    } else {
      await notify(contract.providerId, '⚖️', `A dispute on one of your jobs (${dispute.reason}) has been resolved. ${trimmedNote}`, 'bookingUpdates', { section: 'bookings' });
    }
  }
  res.json({ dispute: updated });
});

// POST /api/admin/disputes/:id/action — Super Admin Dispute Actions
// (item 14): the real, single control point for everything a dispute can
// do beyond the original release/refund resolution above — information
// requests, escalation, rejection, closure, and reopening — each one
// writing a real, permanent row to disputeAuditLog rather than just
// silently changing dispute.status with no record of who did it, when,
// or why. Deliberately super-admin-only: unlike day-to-day dispute
// resolution (open to the disputes/customer_service departments above),
// these are the actions that reverse a financial decision or escalate
// something beyond a regional team's own authority — exactly the kind
// of action that should require the top of the chain, not a regional
// admin's own department scope.
const DISPUTE_ACTIONS = ['request_info', 'escalate', 'reject', 'close', 'reopen'];
router.post('/disputes/:id/action', requireSuperAdmin, async (req, res) => {
  const { action, note } = req.body || {};
  if (!DISPUTE_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${DISPUTE_ACTIONS.join(', ')}` });
  }
  if (!isNonEmptyString(note, { min: 3, max: 1000 })) {
    return res.status(400).json({ error: 'A note explaining this action is required — it becomes part of the permanent audit trail' });
  }
  const dispute = await db.find('disputes', d => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
  const contract = await db.find('contracts', c => c.id === dispute.contractId);
  const actor = await me(req);

  // reopen is the one action that only makes sense from a settled state;
  // every other action only makes sense on a dispute that's still open —
  // trying to escalate an already-closed dispute, for instance, is a
  // real, reportable error, not something to silently allow.
  if (action === 'reopen' && dispute.status === 'open') {
    return res.status(400).json({ error: 'This dispute is already open' });
  }
  // v84: reopening has to put the money back where a fresh decision can be
  // made safely. That's only possible while the payment is still inside
  // Trothen: released to the pro's balance but not yet cashed out. If it
  // was refunded, or the pro has been paid, the money has left and the
  // dispute can't be reopened here.
  const escrowForAction = await db.find('escrowTransactions', e => e.contractId === dispute.contractId);
  if (action === 'reopen' && dispute.status === 'resolved' && escrowForAction) {
    if (escrowForAction.status === 'refunded') return res.status(409).json({ error: 'The customer has already been refunded, so this dispute can\'t be reopened.' });
    if (escrowForAction.payoutId || escrowForAction.materialsAdvancePayoutId) return res.status(409).json({ error: 'The pro has already been paid out for this booking, so this dispute can\'t be reopened here. Settle it by hand and record it in a note.' });
  }
  if (action !== 'reopen' && dispute.status !== 'open') {
    return res.status(400).json({ error: `This dispute is already ${dispute.status} — reopen it first if it needs further action` });
  }

  const statusByAction = { request_info: 'open', escalate: 'escalated', reject: 'rejected', close: 'closed', reopen: 'open' };
  const updated = await db.update('disputes', dispute.id, {
    status: statusByAction[action],
    ...(action === 'reopen' ? { resolvedAt: null, resolution: null } : {}),
  });

  // v84: keep the booking and its payment in step with the dispute.
  if (contract) {
    if (action === 'reopen') {
      // back to frozen, so it can be decided again
      if (escrowForAction && escrowForAction.status === 'released') {
        // v96: if it had been split, the full original amount goes back on hold.
        const restore = escrowForAction.originalAmount != null ? { amount: escrowForAction.originalAmount, originalAmount: null, refundedAmount: null, splitByDisputeId: null } : {};
        await db.update('escrowTransactions', escrowForAction.id, { status: 'held', ...restore });
        if (escrowForAction.originalAmount != null) await db.update('contracts', contract.id, { refundedAmount: null });
      }
      if (contract.status === 'completed' && contract.completedVia === 'dispute') {
        const pro = await db.find('users', u => u.id === contract.providerId);
        if (pro && (pro.jobs || 0) > 0) await db.update('users', pro.id, { jobs: pro.jobs - 1 });
      }
      await db.update('contracts', contract.id, { status: 'disputed', completedVia: null });
    } else if ((action === 'reject' || action === 'close') && contract.status === 'disputed') {
      // not upheld, or closed without a decision: the booking carries on as
      // it was, with the payment still held, instead of staying frozen forever.
      await db.update('contracts', contract.id, { status: 'active' });
    }
  }

  await db.insert('disputeAuditLog', {
    id: `dal_${nanoid(10)}`,
    disputeId: dispute.id,
    action,
    note: note.trim(),
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.name : 'Unknown admin',
    createdAt: new Date().toISOString(),
  });

  if (contract) {
    const actionMessages = {
      request_info: `More information was requested on your dispute (${dispute.reason}): "${note.trim()}"`,
      escalate: `Your dispute (${dispute.reason}) has been escalated for further review.`,
      reject: `Your dispute (${dispute.reason}) was reviewed and not upheld: ${note.trim()}`,
      close: `Your dispute (${dispute.reason}) has been closed: ${note.trim()}`,
      reopen: `Your dispute (${dispute.reason}) has been reopened for further review: ${note.trim()}`,
    };
    await notify(contract.customerId, '⚖️', actionMessages[action], 'bookingUpdates', { section: 'bookings' });
    await notify(contract.providerId, '⚖️', actionMessages[action], 'bookingUpdates', { section: 'bookings' });
  }

  res.json({ dispute: updated });
});

// GET /api/admin/disputes/:id/audit-log — the complete, real trail behind
// a dispute: every action taken (including the original resolve, which
// is also written to this log below), who took it, and why. Same
// regional scoping as everywhere else disputes are gated.
router.get('/disputes/:id/audit-log', requireDepartment(['disputes', 'customer_service', 'legal']), async (req, res) => {
  const region = await myRegion(req);
  const dispute = await db.find('disputes', d => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
  if (region && !inRegion(region, await disputeCustomer(dispute))) return res.status(403).json({ error: 'That dispute is outside the area you manage' });
  const log = (await db.filter('disputeAuditLog', l => l.disputeId === dispute.id)).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ log });
});


// ---- Data Management & Cleanup (item 13) -------------------------------------
// Real, scoped, protected deletion — not a blanket "wipe this country"
// button. This is specifically what's needed to actually delete a
// country via DELETE /admin/countries/:id above: that endpoint correctly
// refuses to delete a country with any real accounts on it (to avoid
// orphaning them) — what was actually missing was a safe way to clear
// the untouched TEST accounts under it first, so a real deletion can
// then succeed.
//
// The one hard rule everything here follows: a user or record is only
// ever eligible if they have ZERO financial, contract, or compliance
// history — no contract (as either party), no escrow transaction, no
// payout, no dispute — AND isn't one of this app's own seed/demo
// accounts (see isSeedAccount in src/seed.js). A test account that never
// actually transacted is safe to remove; a real account, a seed/demo
// account, or a test account that was ever
// actually used for a real-shaped transaction, never is, regardless of
// what scope is requested. This is checked fresh at execution time, not
// trusted from an earlier preview — a preview and an execute call could
// be minutes apart, and something could have genuinely changed.
async function findUntouchedTestAccounts(country) {
  // Item: Walter's real, explicit need — cleaning everything before
  // going live, not one country at a time. country is now optional:
  // omit it (or pass null) for a genuine sweep across every country at
  // once. Every existing safety rule still applies exactly as before —
  // no financial/contract/compliance history, never a seed/demo
  // account — this only changes which accounts are even considered, not
  // how safely they're filtered.
  const candidates = await db.filter('users', u => (!country || u.country === country) && (u.role === 'customer' || u.role === 'provider') && !u.isSeedAccount);
  const [contracts, escrow, payouts, disputes] = await Promise.all([
    db.all('contracts'), db.all('escrowTransactions'), db.all('payouts'), db.all('disputes'),
  ]);
  const touchedIds = new Set();
  for (const c of contracts) { touchedIds.add(c.customerId); touchedIds.add(c.providerId); }
  for (const p of payouts) touchedIds.add(p.providerId);
  // Escrow and disputes are keyed by contract, not user directly, but
  // every escrow/dispute already traces back to a contract, whose
  // parties are already captured above — checked anyway for genuine
  // belt-and-suspenders safety, since this is deletion.
  const contractById = new Map(contracts.map(c => [c.id, c]));
  for (const e of escrow) { const c = contractById.get(e.contractId); if (c) { touchedIds.add(c.customerId); touchedIds.add(c.providerId); } }
  for (const d of disputes) { const c = contractById.get(d.contractId); if (c) { touchedIds.add(c.customerId); touchedIds.add(c.providerId); } }

  return candidates.filter(u => !touchedIds.has(u.id));
}

// POST /api/admin/data-cleanup/preview — a real dry run: shows exactly
// who and what would be removed, with zero side effects, so a super
// admin can actually look before deleting anything.
router.post('/data-cleanup/preview', requireSuperAdmin, async (req, res) => {
  const { country } = req.body || {};
  // country is genuinely optional now — omit it for a real preview
  // across every country's untouched test accounts at once.
  const untouched = await findUntouchedTestAccounts(country || null);
  const untouchedIds = new Set(untouched.map(u => u.id));
  const [matches, notifications, verifications, portfolioPhotos] = await Promise.all([
    db.all('matches'), db.all('notifications'), db.all('verifications'), db.all('portfolioPhotos'),
  ]);
  res.json({
    country,
    accountsEligible: untouched.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })),
    relatedRecordsToRemove: {
      matches: matches.filter(m => untouchedIds.has(m.providerId) || untouchedIds.has(m.customerId)).length,
      notifications: notifications.filter(n => untouchedIds.has(n.userId)).length,
      verifications: verifications.filter(v => untouchedIds.has(v.userId)).length,
      portfolioPhotos: portfolioPhotos.filter(p => untouchedIds.has(p.providerId)).length,
    },
  });
});

// POST /api/admin/data-cleanup/execute — the real deletion. Requires
// typing an exact confirmation phrase (not a checkbox) specific to the
// country being cleared, so this can't be triggered by a stray click or
// a copy-pasted request — and everything it actually does is written to
// a permanent audit log below, since "who cleared what test data, when"
// is itself exactly the kind of record item 13 says must be protected,
// not the kind of thing this tool would ever delete about itself.
//
// accountIds (optional): lets a super admin select individual accounts
// from the preview instead of an all-or-nothing sweep of the whole
// country. Deliberately re-validated here, not trusted from what the
// preview showed a moment ago — every id is checked against a FRESH
// findUntouchedTestAccounts() result, so an id for an account that
// picked up real history in the meantime (or was never actually
// eligible) is silently dropped rather than deleted anyway. Omitting
// accountIds entirely keeps the original "clear everything eligible"
// behavior, unchanged.
router.post('/data-cleanup/execute', requireSuperAdmin, async (req, res) => {
  const { country, confirmPhrase, accountIds } = req.body || {};
  // Item: a real "clear everything" mode — country is genuinely
  // optional now. The confirmation phrase for this is deliberately
  // different and more explicit than the per-country one
  // ("DELETE ALL TEST DATA" vs. "DELETE TEST DATA FOR <country>") —
  // proportional to the real difference in blast radius between
  // clearing one country and clearing everything at once.
  const expectedPhrase = country ? `DELETE TEST DATA FOR ${country.toUpperCase()}` : 'DELETE ALL TEST DATA';
  if (confirmPhrase !== expectedPhrase) {
    return res.status(400).json({ error: `Type exactly "${expectedPhrase}" to confirm this action` });
  }

  let untouched = await findUntouchedTestAccounts(country || null);
  if (Array.isArray(accountIds)) {
    const selected = new Set(accountIds);
    untouched = untouched.filter(u => selected.has(u.id));
  }
  const untouchedIds = new Set(untouched.map(u => u.id));
  if (untouchedIds.size === 0) {
    return res.json({ deleted: { accounts: 0, matches: 0, notifications: 0, verifications: 0, portfolioPhotos: 0 } });
  }

  const [matches, notifications, verifications, portfolioPhotos] = await Promise.all([
    db.all('matches'), db.all('notifications'), db.all('verifications'), db.all('portfolioPhotos'),
  ]);
  const matchesToRemove = matches.filter(m => untouchedIds.has(m.providerId) || untouchedIds.has(m.customerId));
  const notificationsToRemove = notifications.filter(n => untouchedIds.has(n.userId));
  const verificationsToRemove = verifications.filter(v => untouchedIds.has(v.userId));
  const photosToRemove = portfolioPhotos.filter(p => untouchedIds.has(p.providerId));

  for (const m of matchesToRemove) await db.remove('matches', m.id);
  for (const n of notificationsToRemove) await db.remove('notifications', n.id);
  for (const v of verificationsToRemove) await db.remove('verifications', v.id);
  for (const p of photosToRemove) await db.remove('portfolioPhotos', p.id);
  for (const u of untouched) await db.remove('users', u.id);

  const actor = await me(req);
  await db.insert('dataCleanupAuditLog', {
    id: `dca_${nanoid(10)}`,
    country: country || 'ALL COUNTRIES',
    actorId: actor ? actor.id : null,
    actorName: actor ? actor.name : 'Unknown admin',
    accountsDeleted: untouched.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
    counts: { accounts: untouched.length, matches: matchesToRemove.length, notifications: notificationsToRemove.length, verifications: verificationsToRemove.length, portfolioPhotos: photosToRemove.length },
    createdAt: new Date().toISOString(),
  });

  res.json({ deleted: { accounts: untouched.length, matches: matchesToRemove.length, notifications: notificationsToRemove.length, verifications: verificationsToRemove.length, portfolioPhotos: photosToRemove.length } });
});

// GET /api/admin/data-cleanup/audit-log — the permanent record of every
// cleanup run — itself a compliance record, so this endpoint only ever
// reads, never deletes.
router.get('/data-cleanup/audit-log', requireSuperAdmin, async (req, res) => {
  const log = (await db.all('dataCleanupAuditLog')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ log });
});

// ---- Go-Live: real super admins, demo removal, readiness checklist ----------
// See src/go-live.js for the full reasoning. Super admin only.
router.get('/go-live/status', requireSuperAdmin, async (req, res) => {
  const { readinessReport } = require('../go-live');
  const actor = await me(req);
  res.json(await readinessReport(actor));
});

router.post('/go-live/super-admins', requireSuperAdmin, async (req, res) => {
  const { name, email, password } = req.body || {};
  const errors = validate([
    ['name', isValidName(name), 'Enter a real name — letters, spaces, hyphens, and apostrophes only'],
    ['email', isValidEmail(email), 'Enter a valid email address'],
    ['password', isValidPassword(password), 'Temporary password must be 8-72 characters and not a common password'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const { isDemoAccount, createSuperAdmin } = require('../go-live');
  if (isDemoAccount({ email })) return res.status(400).json({ error: 'Use a real email address, not a demo one.' });
  const existing = await db.find('users', u => u.email.toLowerCase() === email.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
  const admin = await createSuperAdmin({ name, email, password });
  const actor = await me(req);
  await db.insert('goLiveAuditLog', {
    id: `gla_${nanoid(10)}`, action: 'create_super_admin', actorId: actor ? actor.id : null, actorName: actor ? actor.name : 'Unknown',
    target: { id: admin.id, name: admin.name, email: admin.email }, createdAt: new Date().toISOString(),
  });
  res.status(201).json({ user: publicAdmin(admin) });
});

router.post('/go-live/demo-data/preview', requireSuperAdmin, async (req, res) => {
  const { planDemoRemoval } = require('../go-live');
  const actor = await me(req);
  const plan = await planDemoRemoval(actor ? [actor.id] : []);
  const records = {};
  for (const [k, v] of Object.entries(plan.records)) records[k] = v.length;
  res.json({
    accounts: plan.users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
    records,
  });
});

router.post('/go-live/demo-data/remove', requireSuperAdmin, async (req, res) => {
  const { confirmPhrase } = req.body || {};
  if (confirmPhrase !== 'REMOVE ALL DEMO DATA') {
    return res.status(400).json({ error: 'Type exactly "REMOVE ALL DEMO DATA" to confirm' });
  }
  const { isDemoAccount, executeDemoRemoval } = require('../go-live');
  const actor = await me(req);
  // Removing demo data while signed in as the demo super admin would
  // leave no way back in. Require a real super admin to do it.
  if (!actor || isDemoAccount(actor)) {
    return res.status(400).json({ error: 'You are signed in with a demo account. Create your own super admin first, sign in with it, then remove the demo data.' });
  }
  const counts = await executeDemoRemoval([actor.id], actor);
  res.json({ removed: counts });
});

router.post('/go-live/live-countries', requireSuperAdmin, async (req, res) => {
  const { countries } = req.body || {};
  if (!Array.isArray(countries) || !countries.length) return res.status(400).json({ error: 'Give at least one country' });
  const { setLiveCountries } = require('../go-live');
  const result = await setLiveCountries(countries);
  if (result.error) return res.status(400).json({ error: result.error });
  const actor = await me(req);
  await db.insert('goLiveAuditLog', {
    id: `gla_${nanoid(10)}`, action: 'set_live_countries', actorId: actor ? actor.id : null, actorName: actor ? actor.name : 'Unknown',
    target: { live: result.live }, counts: { changed: result.changed }, createdAt: new Date().toISOString(),
  });
  res.json(result);
});

router.get('/go-live/audit-log', requireSuperAdmin, async (req, res) => {
  const log = (await db.all('goLiveAuditLog').catch(() => [])).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ log });
});

// ---- Administration Announcement Center (item 16) ---------------------------
// A real, centralized way for Administration/Super Admin to reach every
// Regional Manager (or a chosen subset of regions) with something they
// actually need to know — with priority levels, real read/acknowledgment
// tracking (not just "sent and hope"), scheduling for a future time, and
// a permanent history. Deliberately super-admin-only to CREATE (this is
// an official, company-wide channel, not something any regional admin
// can broadcast on) — every admin can read and acknowledge what's
// targeted to them.

// POST /api/admin/announcements — create and (unless scheduled for later)
// send immediately.
router.post('/announcements', requireSuperAdmin, async (req, res) => {
  const { title, body, priority, targetRegions, scheduledFor } = req.body || {};
  const errors = validate([
    ['title', isNonEmptyString(title, { min: 3, max: 150 }), 'Title must be between 3 and 150 characters'],
    ['body', isNonEmptyString(body, { min: 3, max: 2000 }), 'Body must be between 3 and 2000 characters'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (priority && !['normal', 'high', 'urgent'].includes(priority)) {
    return res.status(400).json({ error: 'priority must be normal, high, or urgent' });
  }
  if (targetRegions !== undefined && targetRegions !== null && !Array.isArray(targetRegions)) {
    return res.status(400).json({ error: 'targetRegions must be an array of city names, or omitted for all regions' });
  }
  let scheduledForClean = null;
  if (scheduledFor) {
    const parsed = new Date(scheduledFor);
    if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'scheduledFor must be a valid date/time' });
    scheduledForClean = parsed.toISOString();
  }

  const actor = await me(req);
  const announcement = {
    id: `ann_${nanoid(10)}`,
    title: title.trim(),
    body: body.trim(),
    priority: priority || 'normal',
    targetRegions: (targetRegions && targetRegions.length) ? targetRegions : ['all'],
    authorId: actor ? actor.id : null,
    authorName: actor ? actor.name : 'Trothen HQ',
    scheduledFor: scheduledForClean,
    sentAt: null,
    recipientCount: 0,
    readBy: [],
    createdAt: new Date().toISOString(),
  };
  await db.insert('announcements', announcement);

  // No scheduled time, or a scheduled time already in the past: send it
  // for real right now rather than waiting for the next sweep — the
  // person creating this shouldn't have to wait up to 5 minutes (the
  // scheduler's own interval) to see it actually go out.
  let result = announcement;
  if (!scheduledForClean || scheduledForClean <= new Date().toISOString()) {
    const { sendOneAnnouncement } = require('../announcement-scheduler');
    result = await sendOneAnnouncement(announcement);
  }
  res.status(201).json({ announcement: result });
});

// GET /api/admin/announcements — a super admin sees everything, including
// unsent scheduled ones and full read stats. A regional/department admin
// only sees ones actually targeted to them AND already sent — no reason
// to show a recipient an announcement that hasn't gone out yet, and no
// reason to show them one aimed at a region they're not in.
router.get('/announcements', async (req, res) => {
  const actor = await me(req);
  if (!actor) return res.status(403).json({ error: 'Not authorized' });
  const all = (await db.all('announcements')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (actor.isSuperAdmin) {
    return res.json({ announcements: all.map(a => ({ ...a, readCount: (a.readBy || []).length })) });
  }
  const mine = all.filter(a => a.sentAt && (a.targetRegions.includes('all') || (actor.city && a.targetRegions.includes(actor.city))));
  res.json({ announcements: mine.map(a => ({ ...a, acknowledged: (a.readBy || []).some(r => r.adminId === actor.id) })) });
});

// POST /api/admin/announcements/:id/acknowledge — any admin it was
// actually sent to can mark it read. Idempotent — acknowledging twice
// doesn't create a duplicate entry or reset the original readAt time.
router.post('/announcements/:id/acknowledge', async (req, res) => {
  const actor = await me(req);
  if (!actor) return res.status(403).json({ error: 'Not authorized' });
  const announcement = await db.find('announcements', a => a.id === req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
  const alreadyRead = (announcement.readBy || []).some(r => r.adminId === actor.id);
  if (!alreadyRead) {
    const readBy = [...(announcement.readBy || []), { adminId: actor.id, name: actor.name, readAt: new Date().toISOString() }];
    await db.update('announcements', announcement.id, { readBy });
  }
  res.json({ ok: true });
});

// GET /api/admin/announcements/:id/stats — super admin only: exactly who
// has and hasn't acknowledged, against the real target list (not just a
// raw count) — the actual point of tracking this at all.
router.get('/announcements/:id/stats', requireSuperAdmin, async (req, res) => {
  const announcement = await db.find('announcements', a => a.id === req.params.id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
  const { resolveTargetAdmins } = require('../announcement-scheduler');
  const targets = await resolveTargetAdmins(announcement);
  const readIds = new Set((announcement.readBy || []).map(r => r.adminId));
  res.json({
    announcement,
    acknowledged: targets.filter(t => readIds.has(t.id)).map(t => ({ id: t.id, name: t.name, city: t.city })),
    notAcknowledged: targets.filter(t => !readIds.has(t.id)).map(t => ({ id: t.id, name: t.name, city: t.city })),
  });
});


router.get('/categories', async (req, res) => {
  const cats = await db.all('categories');
  const categories = await Promise.all(cats.map(async c => ({
    ...c,
    pros: (await db.filter('users', u => u.role === 'provider' && u.verified && u.category === c.name)).length,
  })));
  res.json({ categories });
});

// GET /api/admin/category-requests — the real approval queue for custom
// categories providers typed in at signup. Includes real elapsed time
// since request, so an overdue-for-24-hours request is actually visible,
// not just implied.
// POST /api/admin/sync-reference-data — safely adds any countries or
// categories that exist in the current codebase but are missing from this
// specific database (common after deploying new code to a database that
// was already seeded a while ago — new code alone doesn't retroactively
// add new reference data to an existing database). Never touches real
// users, bookings, or any existing country/category's settings.
// GET /api/admin/settings/booking-window — super admin only: the tiered
// defaults for how long a provider has to accept or decline a new
// booking, scaled by how soon the job actually is.
router.get('/settings/booking-window', requireSuperAdmin, async (req, res) => {
  const { getSetting, DEFAULTS } = require('../platform-settings');
  const tiers = await getSetting('bookingResponseTiers');
  res.json({ tiers, isDefault: JSON.stringify(tiers) === JSON.stringify(DEFAULTS.bookingResponseTiers) });
});

// PATCH /api/admin/settings/booking-window — super admin only: change the
// tiers. Takes effect immediately for every new booking; doesn't
// retroactively change the deadline on bookings already awaiting a
// response.
router.patch('/settings/booking-window', requireSuperAdmin, async (req, res) => {
  const { within24h, within7d, beyond7d } = req.body || {};
  for (const [label, val] of [['within24h', within24h], ['within7d', within7d], ['beyond7d', beyond7d]]) {
    if (typeof val !== 'number' || val < 0.25 || val > 168) {
      return res.status(400).json({ error: `${label} must be a number of hours between 0.25 and 168 (one week)` });
    }
  }
  const { setSetting } = require('../platform-settings');
  await setSetting('bookingResponseTiers', { within24h, within7d, beyond7d });
  res.json({ ok: true, tiers: { within24h, within7d, beyond7d } });
});

// GET /api/admin/settings/support-contact — the current WhatsApp/phone
// numbers behind the support chat. A super admin sees and edits the
// platform-wide fallback number. A plain regional admin sees and edits
// their own city's number instead — same "own city, not the whole
// platform" pattern already used for ad pricing and advertising
// inquiries. Falls back to the platform-wide number (isPlaceholder still
// computed honestly) if this city hasn't set its own yet.
router.get('/settings/support-contact', requireAuth, requireRole('admin'), async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  const { getSetting, DEFAULTS } = require('../platform-settings');
  const region = await myRegion(req);
  const global = await getSetting('supportContact');
  if (!region) {
    // Item: a super admin previously had no way to even SEE what
    // regional contacts already existed, let alone set a new one for a
    // city other than their own (they don't have one) — same real gap
    // as the pricing overrides table had. allRegional here is exactly
    // that: every city that currently has its own contact set, so the
    // admin panel can list and manage them directly.
    const regionalContacts = (await getSetting('regionalSupportContacts')) || {};
    const allRegional = Object.entries(regionalContacts).map(([city, c]) => ({ city, ...c }));
    return res.json({ ...global, isPlaceholder: global.whatsapp === DEFAULTS.supportContact.whatsapp, region: null, allRegional });
  }
  const regionalContacts = (await getSetting('regionalSupportContacts')) || {};
  const own = regionalContacts[region];
  if (own) return res.json({ ...own, isPlaceholder: false, region, usingPlatformFallback: false });
  return res.json({ ...global, isPlaceholder: global.whatsapp === DEFAULTS.supportContact.whatsapp, region, usingPlatformFallback: true });
});

// PATCH /api/admin/settings/support-contact — a super admin sets the
// platform-wide fallback; a regional admin sets their own city's real
// number, stored separately so one region's number never overwrites
// another's or the global fallback.
router.patch('/settings/support-contact', requireAuth, requireRole('admin'), async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  const { whatsapp, phoneDisplay, email } = req.body || {};
  if (!isNonEmptyString(whatsapp) || !/^\d{7,15}$/.test(whatsapp)) {
    return res.status(400).json({ error: 'WhatsApp number must be digits only, with country code and no +/spaces/dashes — e.g. 15551234567' });
  }
  if (!isNonEmptyString(phoneDisplay, { min: 5, max: 30 })) {
    return res.status(400).json({ error: 'Enter a valid display phone number' });
  }
  // Item: "Regional customer service email" — this contact record only
  // ever had WhatsApp and a phone number, with no way to also give a
  // region (or the platform-wide fallback) a real support email.
  // Optional, unlike the two above: a region/platform may reasonably
  // rely on WhatsApp and phone alone with no dedicated support inbox.
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  if (trimmedEmail && !isValidEmail(trimmedEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address, or leave it blank' });
  }
  const { getSetting, setSetting } = require('../platform-settings');
  // Item: same real gap as the pricing overrides had — a super admin
  // could only ever set the platform-wide fallback contact, with no way
  // to set a SPECIFIC other city's contact directly, the way a regional
  // admin can for their own city. Unlike pricing (country-scoped, and
  // the backend already fully supported any country), this one is
  // genuinely new on the backend too: myRegion() only ever reflects the
  // CALLER's own assignment, so a super admin had no way to name a
  // different target at all, even via a raw API call. targetRegion is
  // only honored for a super admin — a plain regional admin still only
  // ever affects their own city, exactly as before.
  const { targetRegion } = req.body || {};
  const region = (m.isSuperAdmin && isNonEmptyString(targetRegion)) ? targetRegion.trim() : await myRegion(req);
  if (!region) {
    await setSetting('supportContact', { whatsapp, phoneDisplay, email: trimmedEmail });
    return res.json({ ok: true, whatsapp, phoneDisplay, email: trimmedEmail, region: null });
  }
  const regionalContacts = (await getSetting('regionalSupportContacts')) || {};
  regionalContacts[region] = { whatsapp, phoneDisplay, email: trimmedEmail };
  await setSetting('regionalSupportContacts', regionalContacts);
  res.json({ ok: true, whatsapp, phoneDisplay, email: trimmedEmail, region });
});

// DELETE /api/admin/settings/support-contact — a regional admin can remove
// their own city's number to fall back to the platform-wide one again
// (e.g. their staff line changed and isn't set up yet). Not available to
// a super admin, who has no "fallback" of their own to fall back to.
router.delete('/settings/support-contact', requireAuth, requireRole('admin'), async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  // Same targetRegion pattern as the PATCH route above — a super admin
  // clearing a specific OTHER city's contact, not just their own (which
  // they don't have).
  const { targetRegion } = req.body || {};
  const region = (m.isSuperAdmin && isNonEmptyString(targetRegion)) ? targetRegion.trim() : await myRegion(req);
  if (!region) return res.status(400).json({ error: 'The platform-wide number can be changed, but not removed — set a new one instead.' });
  const { getSetting, setSetting } = require('../platform-settings');
  const regionalContacts = (await getSetting('regionalSupportContacts')) || {};
  delete regionalContacts[region];
  await setSetting('regionalSupportContacts', regionalContacts);
  res.json({ ok: true, region });
});

// GET /api/admin/settings/homepage-content — super admin only: the current
// homepage copy, for editing.
router.get('/settings/homepage-content', requireSuperAdmin, async (req, res) => {
  const { getSetting } = require('../platform-settings');
  const content = await getSetting('homepageContent');
  res.json(content);
});

// PATCH /api/admin/settings/homepage-content — super admin only: update
// the homepage copy. Takes effect immediately for every visitor — no
// deploy needed.
router.patch('/settings/homepage-content', requireSuperAdmin, async (req, res) => {
  const { heroPrefix, heroRotatingWords, heroSuffix, heroSubheadline, missionHeadline, missionBody } = req.body || {};
  if (!isNonEmptyString(heroPrefix, { min: 2, max: 60 })) return res.status(400).json({ error: 'Enter a hero headline prefix' });
  if (!Array.isArray(heroRotatingWords) || heroRotatingWords.length === 0 || heroRotatingWords.some(w => typeof w !== 'string' || !w.trim())) {
    return res.status(400).json({ error: 'Enter at least one rotating word (comma-separated)' });
  }
  if (!isNonEmptyString(heroSuffix, { min: 1, max: 40 })) return res.status(400).json({ error: 'Enter a hero headline suffix' });
  if (!isNonEmptyString(heroSubheadline, { min: 10, max: 400 })) return res.status(400).json({ error: 'Enter a hero subheadline (10-400 characters)' });
  if (!isNonEmptyString(missionHeadline, { min: 5, max: 150 })) return res.status(400).json({ error: 'Enter a mission headline' });
  if (!isNonEmptyString(missionBody, { min: 20, max: 1200 })) return res.status(400).json({ error: 'Enter mission body text (20-1200 characters)' });
  const { setSetting } = require('../platform-settings');
  const content = {
    heroPrefix: heroPrefix.trim(),
    heroRotatingWords: heroRotatingWords.map(w => w.trim()).filter(Boolean),
    heroSuffix: heroSuffix.trim(),
    heroSubheadline: heroSubheadline.trim(),
    missionHeadline: missionHeadline.trim(),
    missionBody: missionBody.trim(),
  };
  await setSetting('homepageContent', content);
  res.json({ ok: true, ...content });
});

// GET/PATCH /api/admin/settings/content-overrides — super admin only: the
// rest of the front-page wording (search box, job ticket, the four checks,
// section titles, closing boxes, footer line). Only known keys are
// accepted, only plain text (no < or >), each up to 600 characters. A key
// that's left out goes back to the built-in wording. Live immediately.
router.get('/settings/content-overrides', requireSuperAdmin, async (req, res) => {
  const { getSetting, EDITABLE_CONTENT_KEYS } = require('../platform-settings');
  res.json({ overrides: (await getSetting('contentOverrides')) || {}, editableKeys: EDITABLE_CONTENT_KEYS });
});
router.patch('/settings/content-overrides', requireSuperAdmin, async (req, res) => {
  const { setSetting, EDITABLE_CONTENT_KEYS } = require('../platform-settings');
  const { overrides } = req.body || {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return res.status(400).json({ error: 'overrides must be an object of key → text' });
  const clean = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!EDITABLE_CONTENT_KEYS.includes(key)) return res.status(400).json({ error: `"${key}" isn't an editable piece of text` });
    if (typeof value !== 'string') return res.status(400).json({ error: `The text for "${key}" must be plain text` });
    const text = value.trim();
    if (!text) continue; // blank = use the built-in wording
    if (text.length > 600) return res.status(400).json({ error: `The text for "${key}" is too long (600 characters at most)` });
    if (/[<>]/.test(text)) return res.status(400).json({ error: `Please don't use < or > in "${key}"` });
    clean[key] = text;
  }
  await setSetting('contentOverrides', clean);
  const { logAccess } = require('../access-log');
  await logAccess(req, 'content_overrides_update', null);
  res.json({ ok: true, overrides: clean });
});

// ── ABOUT US & TERMS OF SERVICE ──────────────────────────────────────────
// Real, admin-editable long-form pages — previously both were hardcoded
// directly in the HTML with no way to change them without a code deploy.
// Deliberately generous length limit: this is meant for genuinely
// substantial content (a real About page, a real Terms of Service), not a
// short marketing blurb like the homepage copy above.
router.get('/settings/about-us', requireSuperAdminOrCustomerService, async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ content: await getSetting('aboutUsContent') });
});

router.patch('/settings/about-us', requireSuperAdminOrCustomerService, async (req, res) => {
  const { content } = req.body || {};
  if (!isNonEmptyString(content, { min: 10, max: 50000 })) {
    return res.status(400).json({ error: 'Enter some content (up to 50,000 characters)' });
  }
  const { setSetting } = require('../platform-settings');
  await setSetting('aboutUsContent', content.trim());
  res.json({ ok: true, content: content.trim() });
});

// ── SITE FOOTER ───────────────────────────────────────────────────────────
// The "© [year] [company] · [location] · [email]" line shown at the
// bottom of every page — previously hardcoded in five separate places in
// public/index.html with no way to correct it without a code deploy.
router.get('/settings/footer', requireSuperAdmin, async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ footer: await getSetting('footerInfo') });
});

router.patch('/settings/footer', requireSuperAdmin, async (req, res) => {
  const { companyName, location, supportEmail, copyrightYear } = req.body || {};
  if (!isNonEmptyString(companyName, { min: 1, max: 120 })) {
    return res.status(400).json({ error: 'Enter a company name' });
  }
  if (!isNonEmptyString(location, { min: 1, max: 120 })) {
    return res.status(400).json({ error: 'Enter a location' });
  }
  if (!isNonEmptyString(supportEmail, { min: 5, max: 254 }) || !supportEmail.includes('@')) {
    return res.status(400).json({ error: 'Enter a valid support email address' });
  }
  const year = parseInt(copyrightYear, 10);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return res.status(400).json({ error: 'Enter a valid copyright year' });
  }
  const footer = { companyName: companyName.trim(), location: location.trim(), supportEmail: supportEmail.trim(), copyrightYear: year };
  const { setSetting } = require('../platform-settings');
  await setSetting('footerInfo', footer);
  require('../platform-settings').publicSupportEmail().catch(() => {}); // v95
  res.json({ ok: true, footer });
});

// GET /api/admin/settings/contact-check — v95: the one support email that
// visitors see, where it is used, and advice about it.
router.get('/settings/contact-check', requireSuperAdminOrCustomerService, async (req, res) => {
  const ps = require('../platform-settings');
  const email = await ps.publicSupportEmail();
  const host = (process.env.APP_URL ? String(process.env.APP_URL).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : req.get('host')) || '';
  res.json({
    email,
    advice: ps.supportEmailAdvice(email, host),
    usedIn: ['the footer of every page', 'the Terms of Service', 'the Privacy Policy', 'PDF reports and agreements', 'the support chat'],
    retentionDays: Number(await ps.getSetting('idDocumentRetentionDays')) || 0,
  });
});

// v94: the Privacy Policy, editable like the Terms of Service.
router.get('/settings/privacy-policy', requireSuperAdminOrCustomerService, async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ content: await getSetting('privacyPolicyContent') });
});
router.patch('/settings/privacy-policy', requireSuperAdminOrCustomerService, async (req, res) => {
  const { content } = req.body || {};
  if (!isNonEmptyString(content, { min: 10, max: 50000 })) {
    return res.status(400).json({ error: 'Enter some content (up to 50,000 characters)' });
  }
  const { setSetting } = require('../platform-settings');
  await setSetting('privacyPolicyContent', content.trim());
  const { logAccess } = require('../access-log');
  await logAccess(req, 'privacy_policy_update', String(content.trim().length));
  res.json({ ok: true, content: content.trim() });
});

router.get('/settings/terms-of-service-customer', requireSuperAdminOrCustomerService, async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ content: await getSetting('termsOfServiceCustomerContent') });
});

router.patch('/settings/terms-of-service-customer', requireSuperAdminOrCustomerService, async (req, res) => {
  const { content } = req.body || {};
  if (!isNonEmptyString(content, { min: 10, max: 50000 })) {
    return res.status(400).json({ error: 'Enter some content (up to 50,000 characters)' });
  }
  const { setSetting } = require('../platform-settings');
  await setSetting('termsOfServiceCustomerContent', content.trim());
  res.json({ ok: true, content: content.trim() });
});

router.get('/settings/terms-of-service-provider', requireSuperAdminOrCustomerService, async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ content: await getSetting('termsOfServiceProviderContent') });
});

router.patch('/settings/terms-of-service-provider', requireSuperAdminOrCustomerService, async (req, res) => {
  const { content } = req.body || {};
  if (!isNonEmptyString(content, { min: 10, max: 50000 })) {
    return res.status(400).json({ error: 'Enter some content (up to 50,000 characters)' });
  }
  const { setSetting } = require('../platform-settings');
  await setSetting('termsOfServiceProviderContent', content.trim());
  res.json({ ok: true, content: content.trim() });
});

// ── HOMEPAGE IMAGES ──────────────────────────────────────────────────────
// Real photo uploads for the marketing homepage — the hero and mission
// sections previously had no photo at all, just icons/gradients. One slot
// per named position on the page; uploading again for the same slot
// replaces whatever was there. Same multer/disk-storage approach already
// proven for provider portfolio photos, just scoped to super admin and
// keyed by slot instead of by provider.
const HOMEPAGE_IMAGE_SLOTS = ['hero', 'mission'];
const homepageImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `homepage_${req.params.slot}_${nanoid(10)}${ext}`);
  },
});
function homepageImageFileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.mimetype)) return cb(new Error('Only JPEG, PNG, or WEBP images are allowed'));
  cb(null, true);
}
const uploadHomepageImage = multer({ storage: homepageImageStorage, fileFilter: homepageImageFileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/admin/homepage-images/:slot/upload — super admin only.
router.post('/homepage-images/:slot/upload', requireSuperAdmin, (req, res) => {
  if (!HOMEPAGE_IMAGE_SLOTS.includes(req.params.slot)) {
    return res.status(400).json({ error: `slot must be one of: ${HOMEPAGE_IMAGE_SLOTS.join(', ')}` });
  }
  uploadHomepageImage.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No image file was provided' });

    // Same "confirm it actually landed" discipline as portfolio uploads —
    // reporting success on a write that silently didn't stick is the
    // failure mode that's hardest to notice until someone reports a
    // missing homepage image days later.
    if (!fs.existsSync(req.file.path)) {
      console.error(`Homepage image upload reported success but file is missing at ${req.file.path} — check UPLOADS_DIR points to a writable, persistent location.`);
      return res.status(500).json({ error: 'The image could not be saved to disk. Please try again.' });
    }

    if (!verifyImageMagicBytes(req.file.path, req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'This file does not appear to be a genuine image — please upload a real photo.' });
    }

    const url = `/uploads/${req.file.filename}`;
    const existing = await db.find('homepageImages', h => h.slot === req.params.slot);
    if (existing) {
      // Clean up the old file on disk now that it's being replaced —
      // otherwise every re-upload just accumulates orphaned files forever.
      const oldPath = path.join(UPLOADS_DIR, existing.filename);
      if (existing.filename && fs.existsSync(oldPath)) fs.unlink(oldPath, () => {});
      await db.update('homepageImages', existing.id, { filename: req.file.filename, url, updatedAt: new Date().toISOString() });
    } else {
      await db.insert('homepageImages', { id: `hi_${req.params.slot}`, slot: req.params.slot, filename: req.file.filename, url, createdAt: new Date().toISOString() });
    }
    res.status(201).json({ ok: true, slot: req.params.slot, url });
  });
});

// DELETE /api/admin/homepage-images/:slot — super admin only: removes the
// image, reverting that section back to its icon/gradient look.
router.delete('/homepage-images/:slot', requireSuperAdmin, async (req, res) => {
  const existing = await db.find('homepageImages', h => h.slot === req.params.slot);
  if (!existing) return res.json({ ok: true }); // nothing to remove
  const filePath = path.join(UPLOADS_DIR, existing.filename);
  if (existing.filename && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  await db.remove('homepageImages', existing.id);
  res.json({ ok: true });
});

// ── CATEGORY IMAGES (Popular Projects section) ──────────────────────────
// GET /api/admin/category-images — super admin only: every category's
// current photo, as a { categoryId: url } map, for the settings panel.
router.get('/category-images', requireSuperAdmin, async (req, res) => {
  const images = await db.all('categoryImages');
  const bySlot = {};
  for (const img of images) bySlot[img.categoryId] = img.url;
  res.json(bySlot);
});

const categoryImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `category_${req.params.categoryId}_${nanoid(10)}${ext}`);
  },
});
const uploadCategoryImage = multer({ storage: categoryImageStorage, fileFilter: homepageImageFileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/admin/category-images/:categoryId/upload — super admin only.
router.post('/category-images/:categoryId/upload', requireSuperAdmin, (req, res) => {
  uploadCategoryImage.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No image file was provided' });
    const category = await db.find('categories', c => c.id === req.params.categoryId);
    if (!category) { fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Category not found' }); }

    if (!fs.existsSync(req.file.path)) {
      console.error(`Category image upload reported success but file is missing at ${req.file.path} — check UPLOADS_DIR points to a writable, persistent location.`);
      return res.status(500).json({ error: 'The image could not be saved to disk. Please try again.' });
    }

    if (!verifyImageMagicBytes(req.file.path, req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'This file does not appear to be a genuine image — please upload a real photo.' });
    }

    const url = `/uploads/${req.file.filename}`;
    const existing = await db.find('categoryImages', h => h.categoryId === req.params.categoryId);
    if (existing) {
      const oldPath = path.join(UPLOADS_DIR, existing.filename);
      if (existing.filename && fs.existsSync(oldPath)) fs.unlink(oldPath, () => {});
      await db.update('categoryImages', existing.id, { filename: req.file.filename, url, updatedAt: new Date().toISOString() });
    } else {
      await db.insert('categoryImages', { id: `ci_${req.params.categoryId}`, categoryId: req.params.categoryId, filename: req.file.filename, url, createdAt: new Date().toISOString() });
    }
    res.status(201).json({ ok: true, categoryId: req.params.categoryId, url });
  });
});

// DELETE /api/admin/category-images/:categoryId — super admin only.
router.delete('/category-images/:categoryId', requireSuperAdmin, async (req, res) => {
  const existing = await db.find('categoryImages', h => h.categoryId === req.params.categoryId);
  if (!existing) return res.json({ ok: true });
  const filePath = path.join(UPLOADS_DIR, existing.filename);
  if (existing.filename && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
  await db.remove('categoryImages', existing.id);
  res.json({ ok: true });
});

router.post('/sync-reference-data', requireSuperAdmin, async (req, res) => {
  const { syncReferenceData } = require('../sync-reference-data');
  const result = await syncReferenceData();
  res.json(result);
});

// POST /api/admin/backfill-notification-links — same "new code doesn't
// retroactively fix old data" situation as the jobs-completed backfill:
// category-request, sales-inquiry, and advertising-inquiry notifications
// only started carrying a real linkTo destination once that was added to
// their notify() calls. Any notification created before that still has
// linkTo: null stored forever — new code doesn't rewrite already-saved
// rows on its own. This scans existing notifications and infers the
// correct destination from their own text (the same text each notify()
// call already writes), so old notifications become clickable too instead
// of only new ones going forward.
router.post('/backfill-notification-links', requireSuperAdmin, async (req, res) => {
  const patterns = [
    { match: t => t.includes('not a current category'), linkTo: { section: 'categories' } },
    { match: t => t.includes('New Custom plan sales inquiry'), linkTo: { section: 'sales' } },
    { match: t => t.includes('New advertising inquiry'), linkTo: { section: 'advertising' } },
    { match: t => t.includes('job match:') || t.includes('new AI job matches') || t.includes('new job matches'), linkTo: { section: 'matches' } },
    { match: t => t.includes('Escrow released —') || t.startsWith('Payout of '), linkTo: { section: 'earnings' } },
  ];
  const all = await db.all('notifications');
  let updated = 0;
  for (const n of all) {
    if (n.linkTo) continue; // already has a real destination — don't touch it

    // "New message from X: ..." needs a contactId, not just a section — the
    // notification text only ever recorded the sender's NAME, never their
    // ID, so this is a best-effort match: find a user with that exact name
    // and use them as the contact. Rare-but-possible duplicate names could
    // match the wrong person; still strictly better than staying dead.
    const messageMatch = /^New message from (.+?):/.exec(n.text || '');
    if (messageMatch) {
      const sender = await db.find('users', u => u.name === messageMatch[1]);
      if (sender) {
        await db.update('notifications', n.id, { linkTo: { section: 'messages', contactId: sender.id } });
        updated += 1;
      }
      continue;
    }

    const rule = patterns.find(p => p.match(n.text || ''));
    if (rule) {
      await db.update('notifications', n.id, { linkTo: rule.linkTo });
      updated += 1;
    }
  }
  res.json({ ok: true, checked: all.length, updated });
});

// POST /api/admin/backfill-jobs-completed — one-time correction tool, same
// spirit as sync-reference-data: "new code doesn't retroactively fix old
// data" applies here too. The jobs-completed count is now genuinely
// incremented on every real job completion (see POST
// /contracts/:id/complete), but that only affects jobs completed AFTER
// this fix shipped — any provider's existing count is still whatever
// static seed number they started with. This recomputes every provider's
// count from their actual completed contracts, once, on demand.
//
// Fair warning built into the response, not hidden: for providers with
// little or no real contract history yet, this will show as a large drop
// from an impressive-looking seed number down to an honest small one.
// That's the point — it's real deployments this matters for.
router.post('/backfill-jobs-completed', requireSuperAdmin, async (req, res) => {
  const providers = await db.filter('users', u => u.role === 'provider');
  const contracts = await db.all('contracts');
  let updated = 0;
  const changes = [];
  for (const p of providers) {
    const realCount = contracts.filter(c => c.providerId === p.id && c.status === 'completed').length;
    if (realCount !== (p.jobs || 0)) {
      changes.push({ providerId: p.id, name: p.name, before: p.jobs || 0, after: realCount });
      await db.update('users', p.id, { jobs: realCount });
      updated += 1;
    }
  }
  res.json({ ok: true, providersChecked: providers.length, providersUpdated: updated, changes });
});

router.get('/category-requests', requireSuperAdmin, async (req, res) => {
  const requests = await db.all('categoryRequests');
  const withDetails = await Promise.all(requests.map(async r => {
    const provider = await db.find('users', u => u.id === r.providerId);
    const hoursElapsed = (Date.now() - new Date(r.createdAt).getTime()) / (1000 * 60 * 60);
    return {
      id: r.id,
      providerId: r.providerId,
      providerName: provider ? provider.name : 'Unknown provider',
      providerEmail: provider ? provider.email : null,
      requestedCategory: r.requestedCategory,
      status: r.status,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      hoursElapsed: Math.round(hoursElapsed * 10) / 10,
      overdue: r.status === 'pending' && hoursElapsed > 24,
    };
  }));
  res.json({ requests: withDetails.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

// POST /api/admin/category-requests/:id/approve — formally adds the
// requested category (if it doesn't already exist) and marks the
// provider's account as approved for it.
// Normalizes a category name for COMPARISON only (never for storage/
// display) — strips punctuation like "&", collapses whitespace, lowercases.
// This is what catches "pick and drop" as the same real category as
// "Pick & Drop" rather than letting a near-duplicate get created just
// because the punctuation or casing differs.
function normalizeCategoryForComparison(name) {
  return name.toLowerCase().replace(/&/g, 'and').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function titleCase(name) {
  return name.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

router.post('/category-requests/:id/approve', requireSuperAdmin, async (req, res) => {
  const request = await db.find('categoryRequests', r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Category request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: `This request is already ${request.status}` });

  const allCategories = await db.all('categories');
  const requestedNormalized = normalizeCategoryForComparison(request.requestedCategory);
  const existingCategory = allCategories.find(c => normalizeCategoryForComparison(c.name) === requestedNormalized);

  // If this really is the same category under different punctuation or
  // casing (e.g. "pick and drop" vs the existing "Pick & Drop"), the
  // provider gets assigned to the REAL existing category rather than a
  // near-duplicate being created — and their account's category field is
  // corrected to match it.
  let finalCategoryName = request.requestedCategory;
  if (existingCategory) {
    finalCategoryName = existingCategory.name;
    await db.update('users', request.providerId, { category: finalCategoryName });
  } else {
    finalCategoryName = titleCase(request.requestedCategory);
    await db.insert('categories', { id: `cat_${nanoid(8)}`, name: finalCategoryName, icon: '🛠️', active: true });
    await db.update('users', request.providerId, { category: finalCategoryName });
  }
  await db.update('users', request.providerId, { categoryApprovalStatus: 'approved' });
  await db.update('categoryRequests', request.id, { status: 'approved', resolvedAt: new Date().toISOString() });
  await notify(request.providerId, '✅', `Your category "${finalCategoryName}" was approved — you're now fully listed and bookable.`, null, { section: 'settings' });
  res.json({ ok: true, matchedExisting: !!existingCategory, finalCategoryName });
});

// POST /api/admin/category-requests/:id/reject — declines the custom
// category; the provider keeps their account (never blocked), but their
// category needs to change before they're fully listed.
router.post('/category-requests/:id/reject', requireSuperAdmin, async (req, res) => {
  const request = await db.find('categoryRequests', r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Category request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: `This request is already ${request.status}` });

  await db.update('users', request.providerId, { categoryApprovalStatus: 'rejected' });
  await db.update('categoryRequests', request.id, { status: 'rejected', resolvedAt: new Date().toISOString() });
  await notify(request.providerId, '❌', `Your category "${request.requestedCategory}" wasn't approved. Please update your category in Settings to one of our current listed categories.`, null, { section: 'settings' });
  res.json({ ok: true });
});

// POST /api/admin/categories — add a new bookable service category
router.post('/categories', requireSuperAdmin, async (req, res) => {
  const { name, icon } = req.body || {};
  if (!isValidLabel(name, { min: 2, max: 40 })) {
    return res.status(400).json({ error: 'Enter a real category name (2-40 characters)' });
  }
  const trimmed = name.trim();
  const existing = await db.find('categories', c => c.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return res.status(409).json({ error: `"${trimmed}" already exists as a category` });

  // A real emoji/icon chosen at creation time instead of every category
  // silently falling back to the same generic wrench — falls back to that
  // wrench only if nothing valid was actually provided.
  const safeIcon = (typeof icon === 'string' && icon.trim().length > 0 && icon.trim().length <= 8) ? icon.trim() : '🛠️';

  const category = { id: `cat_${nanoid(8)}`, name: trimmed, icon: safeIcon, active: true };
  await db.insert('categories', category);
  res.status(201).json({ category });
});

router.patch('/categories/:id', requireSuperAdmin, async (req, res) => {
  const cat = await db.find('categories', c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const updated = await db.update('categories', cat.id, { active: !cat.active });
  res.json({ category: updated });
});

// PATCH /api/admin/categories/:id/response-window — sets (or clears, with
// hours: null) this category's own booking-confirmation window, overriding
// the tiered lead-time default for every booking in this category
// regardless of how soon the job is. Useful for categories with very
// different urgency profiles than the platform average — e.g. an
// "Emergency Plumbing" category might always need a fast response, while
// "Wedding Photography" bookings are usually planned weeks out and don't
// need one at all.
router.patch('/categories/:id/response-window', requireSuperAdmin, async (req, res) => {
  const cat = await db.find('categories', c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const { hours } = req.body || {};
  if (hours !== null && (typeof hours !== 'number' || hours < 0.25 || hours > 168)) {
    return res.status(400).json({ error: 'Enter a number of hours between 0.25 and 168, or null to clear the override' });
  }
  const updated = await db.update('categories', cat.id, { responseWindowOverrideHours: hours });
  res.json({ category: updated });
});

// DELETE /api/admin/categories/:id — real delete, guarded the same way as
// countries: a category with providers actually listed under it can't be
// deleted outright, since that would silently strand their accounts with a
// category that no longer exists anywhere in the system. Deactivating (the
// PATCH above) is the right move for "stop taking new bookings in this
// category" — delete is for one that was never actually adopted.
router.delete('/categories/:id', requireSuperAdmin, async (req, res) => {
  const cat = await db.find('categories', c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const providersHere = await db.filter('users', u => u.role === 'provider' && u.category === cat.name);
  if (providersHere.length > 0) {
    return res.status(409).json({ error: `Can't delete — ${providersHere.length} provider(s) are listed under "${cat.name}". Deactivate it instead to stop new bookings.` });
  }

  // category_images.category_id has a foreign-key reference to this
  // table with no cascade — on real Postgres, deleting a category that
  // still has an uploaded image would fail with a foreign-key violation
  // instead of a clean success. Clean up the image (row + file on disk)
  // first, same as the dedicated DELETE /category-images/:categoryId
  // endpoint does, so deleting a category always succeeds regardless of
  // whether a photo was ever uploaded for it.
  const existingImage = await db.find('categoryImages', h => h.categoryId === cat.id);
  if (existingImage) {
    const imgPath = path.join(UPLOADS_DIR, existingImage.filename);
    if (existingImage.filename && fs.existsSync(imgPath)) fs.unlink(imgPath, () => {});
    await db.remove('categoryImages', existingImage.id);
  }

  await db.remove('categories', cat.id);
  res.json({ ok: true });
});

router.get('/countries', async (req, res) => res.json({ countries: await db.all('countries') }));

// POST /api/admin/countries — add a new country (starts as 'planned' until
// a super admin flips it live, same two-step pattern as everything else that
// goes live on the platform)
router.post('/countries', requireSuperAdmin, async (req, res) => {
  const { name, status } = req.body || {};
  if (!isValidLabel(name, { min: 2, max: 60 })) {
    return res.status(400).json({ error: 'Enter a real country name (2-60 characters)' });
  }
  const trimmed = name.trim();
  const existing = await db.find('countries', c => c.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return res.status(409).json({ error: `"${trimmed}" already exists as a country` });

  const country = { id: `cty_${nanoid(8)}`, name: trimmed, status: status === 'live' ? 'live' : 'planned' };
  await db.insert('countries', country);
  res.status(201).json({ country });
});

router.patch('/countries/:id', requireSuperAdmin, async (req, res) => {
  const c = await db.find('countries', x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Country not found' });
  const updated = await db.update('countries', c.id, { status: c.status === 'live' ? 'planned' : 'live' });
  res.json({ country: updated });
});

// DELETE /api/admin/countries/:id — real delete, but only when it's actually
// safe: a country with real users registered under it can't be deleted,
// since that would silently orphan every one of their accounts (dangling
// references with no country data, breaking admin location scoping,
// reporting, etc). Deactivating (the PATCH above) is the right tool for
// "stop accepting new signups here" — deleting is for a country that was
// added by mistake or never actually launched.
router.delete('/countries/:id', requireSuperAdmin, async (req, res) => {
  const c = await db.find('countries', x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Country not found' });
  const usersHere = await db.filter('users', u => u.country === c.name);
  if (usersHere.length > 0) {
    return res.status(409).json({ error: `Can't delete — ${usersHere.length} account(s) are registered under ${c.name}. Set it to "Planned" instead to stop new signups there.` });
  }
  await db.remove('countries', c.id);
  res.json({ ok: true });
});

// ---- Locations & sub-admins (super admin only) ------------------------------

// GET /api/admin/cities — every open city and who administers it
router.get('/cities', requireSuperAdmin, async (req, res) => {
  const allCities = await db.all('cities');
  const cities = await Promise.all(allCities.map(async c => {
    const admin = await db.find('users', u => u.id === c.adminId);
    const userCount = (await db.filter('users', u => u.city === c.name && u.role !== 'admin')).length;
    return { ...c, adminName: admin ? admin.name : null, adminEmail: admin ? admin.email : null, adminActive: admin ? admin.active !== false : null, adminScope: admin && admin.adminScope === 'country' ? 'country' : 'city', userCount };
  }));
  res.json({ cities });
});

// GET /api/admin/sub-admins — every location admin (not super admins)
router.get('/sub-admins', requireSuperAdmin, async (req, res) => {
  const admins = (await db.filter('users', u => u.role === 'admin' && !u.isSuperAdmin)).map(publicAdmin);
  res.json({ admins });
});

// POST /api/admin/sub-admins — create a new location admin for a city
// Item: Joseph asked for the Customer Service team to be able to add new
// employees themselves, to grow their own team without needing a super
// admin for every hire. Opened to the customer_service department too —
// but NOT unrestricted: this endpoint can create an admin in any
// department (financial, legal, controller, and so on), and a customer
// service rep granting themselves or a colleague access to one of those
// would be a real privilege-escalation hole, not a convenience. So a
// customer_service caller is only ever allowed to create MORE
// customer_service accounts — never anything else, never a super admin
// (this route never sets that flag for anyone, super admin or not). A
// super admin caller keeps full, unrestricted access, unchanged.
router.post('/sub-admins', requireAuth, requireRole('admin'), async (req, res) => {
  const m = await me(req);
  if (!m) return res.status(403).json({ error: 'Not authorized' });
  // Deliberately NOT requireDepartment() here — that helper also lets a
  // plain regional admin (no department at all) through, which would
  // open employee-creation to every regional admin, not just customer
  // service. This route needs exactly two allowed callers: a super
  // admin, or specifically the customer_service department.
  if (!m.isSuperAdmin && m.adminDepartment !== 'customer_service') {
    return res.status(403).json({ error: 'Only a super admin or the customer service team can add new employees.' });
  }
  const { name, email, password, city, country, department, regionScoped, scope } = req.body || {};
  if (scope !== undefined && !['country', 'city'].includes(scope)) return res.status(400).json({ error: 'scope must be country or city' });
  const errors = validate([
    ['name', isValidName(name), 'Enter a real name — letters, spaces, hyphens, and apostrophes only'],
    ['email', isValidEmail(email), 'Enter a valid email address'],
    ['password', isValidPassword(password), 'Password must be 8-72 characters'],
    ['city', isNonEmptyString(city), 'City is required'],
    ['country', isNonEmptyString(country), 'Country is required'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (department && !['verification', 'disputes', 'financial', 'accountant', 'controller', 'customer_service', 'legal', 'sales', 'hr'].includes(department)) {
    return res.status(400).json({ error: 'department must be verification, disputes, financial, accountant, controller, customer_service, legal, sales, or hr' });
  }
  if (!m.isSuperAdmin && m.adminDepartment === 'customer_service' && department !== 'customer_service') {
    return res.status(403).json({ error: 'The customer service team can only add new customer service employees, not other departments.' });
  }

  const existing = await db.find('users', u => u.email.toLowerCase() === email.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const admin = {
    id: `u_${nanoid(10)}`,
    name: name.trim(), email: email.trim(), city, country,
    role: 'admin',
    region: city,
    adminScope: scope === 'country' ? 'country' : 'city', // v90: whole country, or just the city above
    isSuperAdmin: false,
    adminDepartment: department || null,
    active: true,
    verified: true,
    initials: name.trim().split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase(),
    passwordHash: hashPassword(password),
    // Whoever created this account chose the starting password (visible
    // to them on-screen), not this admin — requireAuth blocks every other
    // request until they set their own real password via
    // /auth/change-password, the same enforcement point already used for
    // suspended accounts and stale tokens.
    mustChangePassword: true,
    twoFactorEnabled: true,
    createdAt: new Date().toISOString(),
  };
  await db.insert('users', admin);

  // Register (or update) the city's entry in the cities registry
  const existingCity = await db.find('cities', c => c.name.toLowerCase() === city.toLowerCase());
  if (existingCity) {
    await db.update('cities', existingCity.id, { adminId: admin.id, country });
  } else {
    await db.insert('cities', { id: `city_${nanoid(8)}`, name: city, country, adminId: admin.id });
  }

  res.status(201).json({ admin: publicAdmin(admin) });
});

// PATCH /api/admin/sub-admins/:id — toggle active/suspended, or reassign city
router.patch('/sub-admins/:id', requireSuperAdmin, async (req, res) => {
  const target = await db.find('users', u => u.id === req.params.id && u.role === 'admin' && !u.isSuperAdmin);
  if (!target) return res.status(404).json({ error: 'Sub-admin not found' });
  const patch = {};
  if ('active' in (req.body || {})) {
    if (typeof req.body.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
    patch.active = req.body.active;
  }
  // v90: switch an existing admin between one city and the whole country.
  if ('scope' in (req.body || {})) {
    if (!['country', 'city'].includes(req.body.scope)) return res.status(400).json({ error: 'scope must be country or city' });
    if (req.body.scope === 'country' && !target.country) return res.status(400).json({ error: 'This admin has no country on their account. Set one first.' });
    patch.adminScope = req.body.scope;
  }
  if ('city' in (req.body || {})) {
    if (!isNonEmptyString(req.body.city, { min: 2, max: 100 })) return res.status(400).json({ error: 'Enter a valid city' });
    patch.city = req.body.city.trim();
    patch.region = patch.city;
  }
  // Item: "Monrovia should not see Philadelphia" — the actual bug wasn't
  // in the visibility logic itself (myRegion() above already scopes a
  // regionScoped department admin correctly). It's that there was no way
  // to FIX an admin who'd been created global by mistake (regionScoped
  // left unchecked) short of deleting and recreating the account. Now
  // editable after the fact, same super-admin-only gate as everything
  // else here.
  if ('department' in (req.body || {})) {
    const dept = req.body.department;
    if (dept !== null && !['verification', 'disputes', 'financial', 'accountant', 'controller', 'customer_service', 'legal', 'sales', 'hr'].includes(dept)) {
      return res.status(400).json({ error: 'department must be verification, disputes, financial, accountant, controller, customer_service, legal, sales, hr, or null for a plain regional admin' });
    }
    patch.adminDepartment = dept;
  }
  if ('regionScoped' in (req.body || {})) {
    if (typeof req.body.regionScoped !== 'boolean') return res.status(400).json({ error: 'regionScoped must be true or false' });
    patch.regionScoped = req.body.regionScoped;
  }
  if (!Object.keys(patch).length && req.body && req.body.toggleActive) patch.active = !target.active;
  const updated = await db.update('users', target.id, patch);
  res.json({ admin: publicAdmin(updated) });
});

// DELETE /api/admin/sub-admins/:id — real delete, guarded: a city currently
// pointing at this admin as its manager can't be left with a dangling
// reference, so this requires the city be reassigned to someone else first
// (via POST /sub-admins with the same city, which reassigns automatically —
// see that route). Suspending (PATCH above) is the right tool for "this
// person shouldn't have access right now" — delete is for removing the
// account entirely once no city depends on it.
router.delete('/sub-admins/:id', requireSuperAdmin, async (req, res) => {
  const target = await db.find('users', u => u.id === req.params.id && u.role === 'admin' && !u.isSuperAdmin);
  if (!target) return res.status(404).json({ error: 'Sub-admin not found' });
  const managedCity = await db.find('cities', c => c.adminId === target.id);
  if (managedCity) {
    return res.status(409).json({ error: `Can't delete — ${target.name} is still the assigned admin for ${managedCity.name}. Assign a new admin to that city first.` });
  }

  // notifications.user_id (and a few other tables) have a foreign-key
  // reference to this user with no cascade — on real Postgres, deleting
  // this account while it still has ANY notification history would fail
  // with a foreign-key violation instead of a clean success. Given every
  // admin gets notified constantly (every sales inquiry, advertising
  // inquiry, category request), this was true for essentially every real
  // admin account, not an edge case. Clean up every table that could
  // reference this user first, same principle as the category-image
  // cleanup before a category delete.
  await db.filter('notifications', n => n.userId === target.id).then(rows =>
    Promise.all(rows.map(r => db.remove('notifications', r.id)))
  );
  await db.filter('passwordResets', r => r.userId === target.id).then(rows =>
    Promise.all(rows.map(r => db.remove('passwordResets', r.id)))
  );
  await db.filter('phoneVerifications', r => r.userId === target.id).then(rows =>
    Promise.all(rows.map(r => db.remove('phoneVerifications', r.id)))
  );

  await db.remove('users', target.id);
  res.json({ ok: true });
});

// GET /api/admin/contact-submissions — the actual review screen that was
// missing entirely: submissions were being saved and a notification
// fired, but there was nowhere for any admin to go actually see the
// list, so anything the initial notification didn't catch was
// effectively lost. A plain regional admin sees submissions naming their
// own city (plus every unrouted one, since those still need someone to
// pick them up); a super admin sees everything.
router.get('/contact-submissions', async (req, res) => {
  const m = await me(req);
  if (!m) return res.status(403).json({ error: 'Not authorized' });
  let submissions = (await db.all('contactSubmissions')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!m.isSuperAdmin) {
    const kept = [];
    for (const sub of submissions) if (!sub.city || await adminCovers(m, sub)) kept.push(sub);
    submissions = kept;
  }
  res.json({ submissions });
});

// PATCH /api/admin/contact-submissions/:id/status — new -> read ->
// resolved, the same lightweight tracking every other admin queue here
// already uses.
router.patch('/contact-submissions/:id/status', async (req, res) => {
  const m = await me(req);
  if (!m) return res.status(403).json({ error: 'Not authorized' });
  const { status } = req.body || {};
  if (!['new', 'read', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'status must be new, read, or resolved' });
  }
  const target = await db.find('contactSubmissions', s => s.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Submission not found' });
  if (!m.isSuperAdmin && target.city && !(await adminCovers(m, target))) {
    return res.status(403).json({ error: 'That submission is outside the area you manage' });
  }
  const updated = await db.update('contactSubmissions', target.id, { status });
  res.json({ submission: updated });
});

// GET /api/admin/careers-inquiries — every job application on file.
// Scoped to HR-department admins and super admins only — this is company
// hiring, not a per-city customer/provider concern, so it doesn't follow
// the regional-scoping pattern the way disputes or ad inquiries do.
router.get('/careers-inquiries', async (req, res) => {
  const m = await me(req);
  const isPlainRegionalManager = !m.isSuperAdmin && !m.adminDepartment;
  const isGlobalHr = m.adminDepartment === 'hr' && !m.regionScoped;
  const isRegionalHr = m.adminDepartment === 'hr' && m.regionScoped;
  if (!m.isSuperAdmin && !isPlainRegionalManager && !isGlobalHr && !isRegionalHr) {
    return res.status(403).json({ error: 'Only HR, a regional manager, or a super admin can view job applications.' });
  }
  let inquiries = (await db.all('careersInquiries')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (isPlainRegionalManager || isRegionalHr) {
    const keptInq = [];
    for (const inq of inquiries) if (await adminCovers(m, inq)) keptInq.push(inq);
    inquiries = keptInq;
  }
  res.json({ inquiries });
});

// PATCH /api/admin/careers-inquiries/:id/status — track an application
// through new -> reviewed -> contacted -> rejected, same lightweight
// tracking every other admin queue on this platform already has.
router.patch('/careers-inquiries/:id/status', async (req, res) => {
  const m = await me(req);
  const isPlainRegionalManager = !m.isSuperAdmin && !m.adminDepartment;
  const isGlobalHr = m.adminDepartment === 'hr' && !m.regionScoped;
  const isRegionalHr = m.adminDepartment === 'hr' && m.regionScoped;
  if (!m.isSuperAdmin && !isPlainRegionalManager && !isGlobalHr && !isRegionalHr) {
    return res.status(403).json({ error: 'Only HR, a regional manager, or a super admin can update job applications.' });
  }
  const { status } = req.body || {};
  if (!['new', 'reviewed', 'contacted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be new, reviewed, contacted, or rejected' });
  }
  const target = await db.find('careersInquiries', i => i.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Application not found' });
  if ((isPlainRegionalManager || isRegionalHr) && !(await adminCovers(m, target))) {
    return res.status(403).json({ error: 'That application is outside the area you manage' });
  }
  const updated = await db.update('careersInquiries', target.id, { status });
  res.json({ inquiry: updated });
});

// GET /api/admin/referrals-overview — super admin only: real, platform-
// wide visibility into the referral system. Previously an admin had
// zero way to see this at all — referrals were entirely
// customer/provider-facing (their own code, their own referred list),
// with no admin-side view of who's actually driving signups. This
// doesn't change what any individual sees on their own referral panel —
// it's a separate, aggregate view for the team running the platform.
router.get('/referrals-overview', requireSuperAdmin, async (req, res) => {
  const allReferrals = await db.all('referrals');
  const byReferrer = new Map();
  for (const r of allReferrals) {
    if (!byReferrer.has(r.referrerId)) byReferrer.set(r.referrerId, []);
    byReferrer.get(r.referrerId).push(r);
  }
  const topReferrers = await Promise.all(
    [...byReferrer.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 25)
      .map(async ([referrerId, refs]) => {
        const referrer = await db.find('users', u => u.id === referrerId);
        return {
          referrerId,
          referrerName: referrer ? referrer.name : 'Unknown (deleted account)',
          referrerRole: referrer ? referrer.role : null,
          referralCode: referrer ? referrer.referralCode : null,
          totalReferred: refs.length,
        };
      })
  );
  const recent = (await Promise.all(allReferrals
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50)
    .map(async r => {
      const referrer = await db.find('users', u => u.id === r.referrerId);
      const referred = await db.find('users', u => u.id === r.referredUserId);
      return {
        id: r.id,
        referrerName: referrer ? referrer.name : 'Unknown',
        referredName: referred ? referred.name : 'Unknown',
        referredRole: r.referredRole,
        createdAt: r.createdAt,
      };
    })));
  res.json({
    totalReferrals: allReferrals.length,
    totalReferrers: byReferrer.size,
    topReferrers,
    recent,
  });
});

// GET /api/admin/promotions — every promotion this admin has a real
// reason to manage: a super admin sees all of them; a regional manager
// sees their own city's plus any platform-wide ones (for visibility, not
// editing — see the ownership check in PATCH/DELETE below).
router.get('/promotions', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  let promos = (await db.all('promotions')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!m.isSuperAdmin) promos = promos.filter(p => !p.region || sameText(p.region, m.city) || (m.adminScope === 'country' && sameText(p.region, m.country)));
  res.json({ promotions: promos });
});

// POST /api/admin/promotions — a regional manager's promo is always
// scoped to their own city (no way to post platform-wide from here,
// same "own city, not the whole platform" boundary already used for ad
// pricing and regional support contacts). A super admin can post
// platform-wide (leave region blank) or target a specific city.
const promoImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `promo_${req.user.sub}_${nanoid(10)}${ext}`);
  },
});
function promoImageFileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.mimetype)) return cb(new Error('Only JPEG, PNG, or WEBP images are allowed'));
  cb(null, true);
}
const uploadPromoImage = multer({ storage: promoImageStorage, fileFilter: promoImageFileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/admin/promotions/image — upload a real image for a promotion
// banner. Open to any admin who can post a promotion at all (super admin
// or a plain regional admin — matches the same access as POST
// /promotions below, not restricted to super admin the way homepage
// images are). Returns just the URL; the actual promotion is created or
// updated separately with that URL as imageUrl.
const handbookStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `handbook_${nanoid(10)}.pdf`),
});
function handbookFileFilter(req, file, cb) {
  if (file.mimetype !== 'application/pdf') return cb(new Error('The platform handbook must be a PDF file'));
  cb(null, true);
}
const uploadHandbook = multer({ storage: handbookStorage, fileFilter: handbookFileFilter, limits: { fileSize: 20 * 1024 * 1024 } });

// POST /api/admin/platform-handbook — super admin uploads (or replaces)
// the real getting-started guide PDF offered to every new customer and
// provider right after they sign up (see GET /platform-handbook below,
// which is what actually serves it publicly).
router.post('/platform-handbook', requireSuperAdmin, (req, res) => {
  uploadHandbook.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file was provided' });
    if (!fs.existsSync(req.file.path)) {
      console.error(`Platform handbook upload reported success but file is missing at ${req.file.path} — check UPLOADS_DIR points to a writable, persistent location.`);
      return res.status(500).json({ error: 'The file could not be saved to disk. Please try again.' });
    }
    if (!verifyPdfMagicBytes(req.file.path)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'That file doesn\'t look like a real PDF — please upload an actual PDF.' });
    }
    const { setSetting } = require('../platform-settings');
    await setSetting('platformHandbookUrl', `/uploads/${req.file.filename}`);
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

router.post('/promotions/image', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  uploadPromoImage.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No image file was provided' });
    if (!fs.existsSync(req.file.path)) {
      console.error(`Promotion image upload reported success but file is missing at ${req.file.path} — check UPLOADS_DIR points to a writable, persistent location.`);
      return res.status(500).json({ error: 'The image could not be saved to disk. Please try again.' });
    }
    if (!verifyImageMagicBytes(req.file.path, req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'This file does not appear to be a genuine image — please upload a real photo.' });
    }
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

router.post('/promotions', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  const { title, message, imageUrl, audience, region, expiresAt, sendEmail: shouldEmail } = req.body || {};
  const errors = validate([
    ['title', isNonEmptyString(title, { min: 2, max: 120 }), 'Enter a short title'],
    ['message', isNonEmptyString(message, { min: 5, max: 500 }), 'Enter the promotion message'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (audience && !['customers', 'providers', 'both'].includes(audience)) {
    return res.status(400).json({ error: 'audience must be customers, providers, or both' });
  }
  // v84: the picture has to be one uploaded here, and the end date a real
  // date that hasn't passed.
  if (imageUrl && !/^\/uploads\/[A-Za-z0-9._-]+$/.test(String(imageUrl))) {
    return res.status(400).json({ error: 'Use the upload button to add a promotion image' });
  }
  if (expiresAt && (Number.isNaN(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() < Date.now())) {
    return res.status(400).json({ error: 'The end date must be a real date in the future' });
  }

  const promo = {
    id: `promo_${nanoid(10)}`,
    title: title.trim(),
    message: message.trim(),
    imageUrl: imageUrl || null,
    createdBy: m.id,
    region: m.isSuperAdmin ? (region || null) : (m.adminScope === 'country' && m.country ? m.country : m.city), // v90: a country-wide admin's promotion reaches their whole country
    audience: audience || 'both',
    active: true,
    expiresAt: expiresAt || null,
    emailSentCount: 0,
    createdAt: new Date().toISOString(),
  };
  await db.insert('promotions', promo);

  // Real email delivery — this is what actually answers "how do we send
  // a general message or email as administrator" for something like a
  // policy change or a technical issue, not just an in-app banner
  // someone might not open today. Genuinely optional per-announcement
  // (not every promo needs an email blast), and a real no-op in test
  // mode — same honest pattern as every other email in this app — so
  // this never silently claims to have emailed people when nothing's
  // actually configured to send it.
  if (shouldEmail) {
    const { isEmailConfigured, sendEmail } = require('../delivery');
    if (isEmailConfigured()) {
      const roleFilter = promo.audience === 'both' ? (u => u.role === 'customer' || u.role === 'provider') : (u => u.role === promo.audience.slice(0, -1));
      let recipients = await db.filter('users', roleFilter);
      if (promo.region) recipients = recipients.filter(u => u.city === promo.region);
      let sent = 0;
      for (const recipient of recipients) {
        if (!recipient.email) continue;
        const result = await sendEmail(recipient.email, promo.title, `${promo.message}\n\n— The Trothen Team`);
        if (result.sent) sent += 1;
      }
      await db.update('promotions', promo.id, { emailSentCount: sent });
      promo.emailSentCount = sent;
    }
  }

  res.status(201).json({ promotion: promo, emailConfigured: shouldEmail ? require('../delivery').isEmailConfigured() : null });
});

// PATCH /api/admin/promotions/:id — toggle active/inactive, or edit.
// Only the admin who created it, or a super admin, can touch it — a
// regional manager can see a platform-wide promo (GET above) but can't
// edit or remove something they didn't post.
router.patch('/promotions/:id', async (req, res) => {
  const m = await me(req);
  const promo = await db.find('promotions', p => p.id === req.params.id);
  if (!promo) return res.status(404).json({ error: 'Promotion not found' });
  if (!m.isSuperAdmin && promo.createdBy !== m.id) {
    return res.status(403).json({ error: 'You can only edit promotions you created' });
  }
  const patch = {};
  if ('active' in req.body) patch.active = !!req.body.active;
  if ('title' in req.body && isNonEmptyString(req.body.title, { min: 2, max: 120 })) patch.title = req.body.title.trim();
  if ('message' in req.body && isNonEmptyString(req.body.message, { min: 5, max: 500 })) patch.message = req.body.message.trim();
  const updated = await db.update('promotions', promo.id, patch);
  res.json({ promotion: updated });
});

// DELETE /api/admin/promotions/:id — same ownership rule as PATCH.
router.delete('/promotions/:id', async (req, res) => {
  const m = await me(req);
  const promo = await db.find('promotions', p => p.id === req.params.id);
  if (!promo) return res.status(404).json({ error: 'Promotion not found' });
  if (!m.isSuperAdmin && promo.createdBy !== m.id) {
    return res.status(403).json({ error: 'You can only remove promotions you created' });
  }
  await db.remove('promotions', promo.id);
  res.json({ ok: true });
});

// GET /api/admin/access-logs — who on the admin team has actually viewed
// sensitive data, and when. Super admin and Legal only — this log is
// itself sensitive (it's a record of admin activity), so it gets the
// same tight scoping as everything it's tracking.
router.get('/access-logs', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment !== 'legal') {
    return res.status(403).json({ error: 'Only Legal or a super admin can view access logs.' });
  }
  const logs = (await db.all('accessLogs')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 500);
  const withAdminNames = await Promise.all(logs.map(async l => {
    const admin = await db.find('users', u => u.id === l.adminId);
    return { ...l, adminName: admin ? admin.name : 'Unknown', adminEmail: admin ? admin.email : null };
  }));
  res.json({ logs: withAdminNames });
});
// this admin has a claim to. A super admin sees all of them, everywhere. A
// regional admin sees only the ones targeting their own city — this is the
// regional-autonomy piece: a city's ad inventory belongs to that city's
// admin, the same way its disputes and verification queue already do.
// Department-scoped functional admins (Verification, Disputes, Financial,
// etc.) aren't tied to this at all, so they're blocked, same as elsewhere.
router.get('/advertising-inquiries', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  const region = await myRegion(req); // null for a super admin
  await require('../ads').endExpiredAds(); // v107: ads whose time is up come down before the list is shown
  let inquiries = await db.all('advertisingInquiries');
  if (region) {
    const prosById = new Map((await db.filter('users', u => u.role === 'provider')).map(u => [u.id, u]));
    const citiesHere = region instanceof CountryScope ? await require('../ads').citiesInCountry(region.country) : null;
    inquiries = inquiries.filter(i => adInRegion(region, i, prosById.get(i.providerId), citiesHere));
  }
  inquiries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ inquiries, defaultRunDays: require('../ads').DEFAULT_RUN_DAYS });
});

// PATCH /api/admin/advertising-inquiries/:id/status — move an inquiry
// through new -> contacted -> closed as the sales team works it. This is
// the same lightweight "worked it or not" tracking every other admin queue
// on the platform already has (disputes, verification, category requests).
router.patch('/advertising-inquiries/:id/status', async (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'contacted', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be new, contacted, or closed' });
  const declineReason = (req.body || {}).declineReason;
  if (declineReason !== undefined && !isNonEmptyString(declineReason, { min: 3, max: 300 })) return res.status(400).json({ error: 'Say why the ad is being turned down (3 to 300 characters)' });
  const target = await db.find('advertisingInquiries', i => i.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Inquiry not found' });
  const m = await me(req);
  if (!m.isSuperAdmin) {
    if (m.adminDepartment) return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
    const region = await myRegion(req);
    if (!adInRegion(region, target, target.providerId ? await db.find('users', u => u.id === target.providerId) : null, region instanceof CountryScope ? await require('../ads').citiesInCountry(region.country) : null)) return res.status(403).json({ error: 'This inquiry targets a different place than the one you manage.' });
  }
  // v107: closing an ad that is live takes it down too. Before, "Close"
  // left it showing on the home page with nothing in the list to say so.
  const patchStatus = { status };
  if (status === 'closed' && target.isLive) { patchStatus.isLive = false; patchStatus.endedAt = new Date().toISOString(); patchStatus.endedReason = 'closed_by_admin'; }
  if (status === 'closed' && declineReason) patchStatus.declineReason = String(declineReason).trim();
  const updated = await db.update('advertisingInquiries', target.id, patchStatus);
  // A pro who placed the ad is told. They used to hear nothing.
  if (status === 'closed' && target.providerId && target.status !== 'closed') {
    await notify(target.providerId, '📣', declineReason
      ? `Your ad "${target.displayHeadline || target.companyName}" wasn't approved: ${String(declineReason).trim()} You can change it and send it again from the home page. Payments are in test mode, so nothing was charged.`
      : `Your ad "${target.displayHeadline || target.companyName}" has been closed${target.isLive ? ' and is no longer showing' : ''}.`, null, { section: 'overview' });
  }
  res.json({ inquiry: updated });
});

// PATCH /api/admin/advertising-inquiries/:id/live — the actual regional
// self-service piece: approve an inquiry into a real, currently-displaying
// paid ad slot (or take one down), and set what it costs. A regional admin
// can do this for their own city without ever involving a super admin; a
// super admin can do it for any city, or for a platform-wide ad (one whose
// targetCity is null, which only a super admin can approve — that's not
// any one region's call to make).
router.patch('/advertising-inquiries/:id/live', async (req, res) => {
  const { isLive, price, currencyCode, displayHeadline, displaySubtext, displayLink, runDays } = req.body || {};
  if (isLive && runDays !== undefined && (!Number.isInteger(runDays) || runDays < 1 || runDays > 365)) return res.status(400).json({ error: 'An ad can run for 1 to 365 days' });
  if (displayHeadline !== undefined && String(displayHeadline || '').trim().length > 100) return res.status(400).json({ error: 'The headline must be under 100 characters' });
  if (displaySubtext !== undefined && String(displaySubtext || '').trim().length > 200) return res.status(400).json({ error: 'The line under the headline must be under 200 characters' });
  const target = await db.find('advertisingInquiries', i => i.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Inquiry not found' });
  const m = await me(req);
  if (!m.isSuperAdmin) {
    if (m.adminDepartment) return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
    const region = await myRegion(req);
    if (!target.targetCity) return res.status(403).json({ error: 'Platform-wide ads can only be approved by a super admin.' });
    if (!adInRegion(region, target, target.providerId ? await db.find('users', u => u.id === target.providerId) : null, region instanceof CountryScope ? await require('../ads').citiesInCountry(region.country) : null)) return res.status(403).json({ error: 'This inquiry targets a different place than the one you manage.' });
  }
  if (isLive && (typeof price !== 'number' || price < 0)) return res.status(400).json({ error: 'Enter a valid price to go live' });

  const patch = { isLive: !!isLive };
  if (isLive) {
    patch.price = price;
    patch.currencyCode = currencyCode || currencyForCountry(m.country || 'United States').code;
    patch.approvedBy = m.id;
    patch.approvedAt = new Date().toISOString();
    // v107: an ad runs for a set number of days, then comes down by itself.
    const days = Number.isInteger(runDays) ? runDays : require('../ads').DEFAULT_RUN_DAYS;
    patch.runDays = days;
    patch.liveUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    patch.status = 'contacted'; patch.endedAt = null; patch.endedReason = null; patch.declineReason = null;
    if (!target.isLive) { patch.views = 0; patch.clicks = 0; }
  } else if (target.isLive) {
    patch.endedAt = new Date().toISOString(); patch.endedReason = 'taken_down_by_admin';
  }
  // v107: a blank box no longer wipes what the advertiser wrote. Before,
  // approving a pro's ad with the "line under the headline" box left empty
  // erased the pro's own line and the ad showed a stock sentence instead.
  if (displayHeadline !== undefined && String(displayHeadline || '').trim()) patch.displayHeadline = String(displayHeadline).trim();
  if (displaySubtext !== undefined && String(displaySubtext || '').trim()) patch.displaySubtext = String(displaySubtext).trim();
  if (displayLink !== undefined) {
    const trimmedLink = (displayLink || '').trim();
    if (trimmedLink && !/^https?:\/\//i.test(trimmedLink)) {
      return res.status(400).json({ error: 'Link must start with http:// or https://' });
    }
    patch.displayLink = trimmedLink || null;
  }

  const updated = await db.update('advertisingInquiries', target.id, patch);
  if (target.providerId && !!isLive !== (target.isLive === true)) {
    await notify(target.providerId, '📣', isLive
      ? `Your ad "${updated.displayHeadline || updated.companyName}" is now live on the home page${updated.targetCity ? ' for ' + updated.targetCity : ''}. It runs until ${String(updated.liveUntil).slice(0, 10)}.`
      : `Your ad "${updated.displayHeadline || updated.companyName}" was taken down by the Trothen team and is no longer showing.`, null, { section: 'overview' });
  }
  res.json({ inquiry: updated });
});

// GET /api/admin/plan-pricing — pricing oversight, scoped to what this
// admin can actually see/edit. A super admin gets everything: the global
// USD base for each plan, every country's override, and (implicitly, via
// /exchange-rates) the full rate table. A regional admin gets just their
// own country's current effective pricing — base plus their own override
// if they've set one — so they can decide whether to set or change it.
// ── v78: provider monthly plan fee (see src/plan-billing.js) ───────────
// GET /api/admin/plan-billing — super admin: the two locks, what a month
// would bill right now, and the invoices so far.
router.get('/plan-billing', requireSuperAdmin, async (req, res) => {
  const planBilling = require('../plan-billing');
  const state = await planBilling.getState();
  const all = await db.all('planInvoices');
  const sum = (list, f) => Math.round(list.reduce((s, i) => s + f(i), 0) * 100) / 100;
  const names = new Map((await db.filter('users', u => u.role === 'provider')).map(u => [u.id, u.name]));
  res.json({
    state,
    preview: await planBilling.preview(),
    totals: {
      invoices: all.length,
      billedUsd: sum(all.filter(i => i.status !== 'waived'), i => i.amountUsd),
      collectedUsd: sum(all, i => i.paidUsd || 0),
      outstandingUsd: sum(all.filter(i => i.status === 'open'), i => i.amountUsd - (i.paidUsd || 0)),
    },
    recent: all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50)
      .map(i => ({ id: i.id, providerName: names.get(i.providerId) || 'Unknown', plan: i.plan, period: i.period, amountUsd: i.amountUsd, paidUsd: i.paidUsd || 0, status: i.status })),
  });
});

// PATCH /api/admin/plan-billing  { on?, noticeDays? } — super admin.
// Switching ON is refused unless PLAN_BILLING_ENABLED=true is set on the
// server. Switching on starts the notice period and tells every billable
// provider. Switching off stops new invoices and stops taking fees from
// payouts; nothing already recorded is deleted.
router.patch('/plan-billing', requireSuperAdmin, async (req, res) => {
  const planBilling = require('../plan-billing');
  const { getSetting, setSetting } = require('../platform-settings');
  const current = { on: false, startedAt: null, noticeDays: 30, ...((await getSetting('planBilling')) || {}) };
  const body = req.body || {};
  const next = { ...current };
  if ('noticeDays' in body) {
    const n = Number(body.noticeDays);
    if (!Number.isInteger(n) || n < 14 || n > 180) return res.status(400).json({ error: 'The notice period must be a whole number of days from 14 to 180' });
    if (current.on && n !== current.noticeDays) return res.status(400).json({ error: 'The notice period can\'t be changed while billing is switched on. Switch it off first.' });
    next.noticeDays = n;
  }
  let justStarted = false;
  if ('on' in body) {
    if (typeof body.on !== 'boolean') return res.status(400).json({ error: 'on must be true or false' });
    if (body.on && !planBilling.envEnabled()) {
      return res.status(400).json({ error: 'Plan billing is locked. Set PLAN_BILLING_ENABLED to true in the server environment (Render) first. Do that only once real payments are live.' });
    }
    if (body.on && !current.on) { next.startedAt = new Date().toISOString(); justStarted = true; }
    if (!body.on) next.startedAt = null;
    next.on = body.on;
  }
  await setSetting('planBilling', next);
  const { logAccess } = require('../access-log');
  await logAccess(req, 'plan_billing_update', JSON.stringify({ on: next.on, noticeDays: next.noticeDays }));
  let told = 0;
  if (justStarted) {
    const rows = await planBilling.pricingRows();
    const begins = new Date(Date.now() + next.noticeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const p of await db.filter('users', planBilling.isBillable)) {
      const pr = planBilling.priceFor(p, rows);
      if (!(pr.amountUsd > 0)) continue;
      const shown = pr.currencyCode === 'USD' ? `$${pr.amountUsd}` : `${pr.currencySymbol}${pr.localPrice} (about $${pr.amountUsd})`;
      await notify(p.id, '🧾', `From ${begins}, your Trothen plan fee of ${shown} a month starts. Nothing is charged to a card: it comes out of your payouts, and never more than half of one payout.`, null, { section: 'earnings' });
      told += 1;
    }
  }
  res.json({ ok: true, state: await planBilling.getState(), providersTold: told });
});

// POST /api/admin/plan-billing/invoices/:id/waive — super admin: forgive
// what's still owed on one invoice. Anything already collected stays.
router.post('/plan-billing/invoices/:id/waive', requireSuperAdmin, async (req, res) => {
  const inv = await db.find('planInvoices', i => i.id === req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  if (inv.status !== 'open') return res.status(409).json({ error: `This invoice is already ${inv.status}` });
  await db.update('planInvoices', inv.id, { status: 'waived', waivedBy: req.user.sub, waivedAt: new Date().toISOString() });
  const { logAccess } = require('../access-log');
  await logAccess(req, 'plan_invoice_waive', inv.id);
  await notify(inv.providerId, '🧾', `Your plan fee for ${inv.period} was waived by the Trothen team.`, null, { section: 'earnings' });
  res.json({ ok: true });
});

router.get('/plan-pricing', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  const [baseRows, overrideRows, rateRows] = await Promise.all([
    db.all('planPricingBase'), db.all('planPricingOverrides'), db.all('exchangeRates'),
  ]);
  if (m.isSuperAdmin) {
    const usdBase = PLAN_KEYS.map(plan => ({ plan, usdPrice: baseRows.find(r => r.plan === plan)?.usdPrice ?? DEFAULT_USD_PRICES[plan] }));
    return res.json({ usdBase, overrides: overrideRows });
  }
  const country = m.country;
  const plans = effectivePlanPricing(country, { baseRows, overrideRows, rateRows });
  res.json({ country, plans });
});

// PATCH /api/admin/plan-pricing/base — super admin only: edits the global
// USD starting price for one plan. Every country without its own override
// automatically reflects this change, converted to their local currency.
router.patch('/plan-pricing/base', requireSuperAdmin, async (req, res) => {
  const { plan, usdPrice } = req.body || {};
  if (!PLAN_KEYS.includes(plan)) return res.status(400).json({ error: 'plan must be starter, pro, or superpro' });
  if (typeof usdPrice !== 'number' || usdPrice < 0) return res.status(400).json({ error: 'Enter a valid non-negative USD price' });
  const existing = await db.find('planPricingBase', r => r.plan === plan);
  if (existing) await db.update('planPricingBase', existing.id, { usdPrice, updatedAt: new Date().toISOString() });
  else await db.insert('planPricingBase', { id: `ppb_${plan}`, plan, usdPrice, updatedAt: new Date().toISOString() });
  res.json({ ok: true });
});

// GET/PATCH /api/admin/settings/membership-pricing — super admin only:
// the customer-facing membership tiers (Plus/Pro/Elite — Free is always
// $0 and VIP is never self-priced, so neither is editable here). Same
// "DB override, code default as fallback" pattern as plan pricing above
// — see resolveMembershipPrice in src/membership.js, which both what a
// customer is shown and what they're actually charged read from, so an
// edit here can never leave the displayed price and the real charge out
// of sync with each other.
router.get('/settings/membership-pricing', requireSuperAdmin, async (req, res) => {
  const { MEMBERSHIP_TIERS, resolveMembershipPrice } = require('../membership');
  const baseRows = await db.all('membershipPricingBase');
  const tiers = ['plus', 'pro', 'elite'].map(tier => ({
    tier,
    label: MEMBERSHIP_TIERS[tier].label,
    defaultPrice: MEMBERSHIP_TIERS[tier].price,
    usdPrice: resolveMembershipPrice(tier, baseRows),
  }));
  res.json({ tiers });
});

router.patch('/settings/membership-pricing', requireSuperAdmin, async (req, res) => {
  const { tier, usdPrice } = req.body || {};
  if (!['plus', 'pro', 'elite'].includes(tier)) return res.status(400).json({ error: 'tier must be plus, pro, or elite' });
  if (typeof usdPrice !== 'number' || usdPrice < 0) return res.status(400).json({ error: 'Enter a valid non-negative USD price' });
  const existing = await db.find('membershipPricingBase', r => r.tier === tier);
  if (existing) await db.update('membershipPricingBase', existing.id, { usdPrice, updatedAt: new Date().toISOString() });
  else await db.insert('membershipPricingBase', { id: `mpb_${tier}`, tier, usdPrice, updatedAt: new Date().toISOString() });
  res.json({ ok: true });
});

// PATCH /api/admin/plan-pricing/override — set (or update) one country's
// real local-currency price for one plan. A regional admin can only do
// this for their own assigned country; a super admin can do it for any
// country. The USD-equivalent side-by-side figure is computed on read
// (see effectivePlanPricing), not stored here.
router.patch('/plan-pricing/override', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  const { country, plan, localPrice } = req.body || {};
  if (!PLAN_KEYS.includes(plan)) return res.status(400).json({ error: 'plan must be starter, pro, or superpro' });
  if (typeof localPrice !== 'number' || localPrice < 0) return res.status(400).json({ error: 'Enter a valid non-negative price' });
  if (!isNonEmptyString(country)) return res.status(400).json({ error: 'country is required' });
  if (!m.isSuperAdmin && country !== m.country) {
    return res.status(403).json({ error: `Your admin account is scoped to ${m.country} — you can't set pricing for other countries.` });
  }
  const currency = currencyForCountry(country);
  const existing = await db.find('planPricingOverrides', r => r.country === country && r.plan === plan);
  const patch = { country, plan, localPrice, currencyCode: currency.code, setBy: m.id, updatedAt: new Date().toISOString() };
  if (existing) await db.update('planPricingOverrides', existing.id, patch);
  else await db.insert('planPricingOverrides', { id: `ppo_${nanoid(8)}`, ...patch });
  res.json({ ok: true });
});

// DELETE /api/admin/plan-pricing/override/:country/:plan — clear an
// override, reverting that country's plan back to the auto-converted USD
// base price. Same scoping rule as setting one.
router.delete('/plan-pricing/override/:country/:plan', async (req, res) => {
  const m = await me(req);
  if (!m.isSuperAdmin && m.adminDepartment) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  const { country, plan } = req.params;
  if (!m.isSuperAdmin && country !== m.country) {
    return res.status(403).json({ error: `Your admin account is scoped to ${m.country} — you can't edit pricing for other countries.` });
  }
  const existing = await db.find('planPricingOverrides', r => r.country === country && r.plan === plan);
  if (existing) await db.remove('planPricingOverrides', existing.id);
  res.json({ ok: true });
});

// GET /api/admin/exchange-rates — super admin only: every currency
// Trothen operates in, with its effective rate and where it came from —
// a live daily fetch, a manual admin correction, or (if neither has ever
// run) the static approximate default from src/currency-data.js.
router.get('/exchange-rates', requireSuperAdmin, async (req, res) => {
  const rateRows = await db.all('exchangeRates');
  const codes = new Set(Object.values(CURRENCY_BY_COUNTRY).map(c => c.code));
  codes.add('USD');
  const rates = Array.from(codes).sort().map(code => {
    const row = rateRows.find(r => r.currencyCode === code);
    return {
      currencyCode: code,
      rateToUsd: row ? row.rateToUsd : (APPROX_USD_RATE[code] ?? 1),
      isOverride: !!row,
      source: row ? (row.source || 'manual') : 'default', // rows written before the source column existed are treated as manual
      fetchedAt: row ? (row.fetchedAt || null) : null,
      updatedAt: row ? row.updatedAt : null,
    };
  });
  res.json({ rates });
});

// PATCH /api/admin/exchange-rates — super admin only: manually overrides
// the rate for one currency. This feeds every conversion in the app that
// touches that currency — job payments, provider payouts, AND plan
// pricing alike, not just the pricing page. Marked source: 'manual' so the
// daily live-rate refresh (see src/fx-scheduler.js) never silently
// overwrites this intentional correction — a human decision always wins
// over automation here.
router.patch('/exchange-rates', requireSuperAdmin, async (req, res) => {
  const { currencyCode, rateToUsd } = req.body || {};
  if (!isNonEmptyString(currencyCode)) return res.status(400).json({ error: 'currencyCode is required' });
  if (typeof rateToUsd !== 'number' || rateToUsd <= 0) return res.status(400).json({ error: 'Enter a valid positive rate' });
  const existing = await db.find('exchangeRates', r => r.currencyCode === currencyCode);
  const patch = { rateToUsd, source: 'manual', updatedAt: new Date().toISOString() };
  if (existing) await db.update('exchangeRates', existing.id, patch);
  else await db.insert('exchangeRates', { id: `xr_${currencyCode}`, currencyCode, ...patch });
  res.json({ ok: true });
});

// PATCH /api/admin/exchange-rates/:currencyCode/reset-to-live — clears a
// manual override so this currency goes back to following the daily live
// refresh again, instead of staying pinned to a one-time manual correction
// forever.
router.patch('/exchange-rates/:currencyCode/reset-to-live', requireSuperAdmin, async (req, res) => {
  const existing = await db.find('exchangeRates', r => r.currencyCode === req.params.currencyCode);
  if (!existing) return res.json({ ok: true }); // nothing to reset — already following live/default
  await db.remove('exchangeRates', existing.id);
  const { refreshLiveExchangeRates } = require('../fx-scheduler');
  await refreshLiveExchangeRates(); // immediately re-fetch so it doesn't sit on the static default until the next scheduled run
  res.json({ ok: true });
});

// POST /api/admin/exchange-rates/refresh — super admin only: triggers an
// immediate live-rate refresh instead of waiting for the daily schedule.
// Useful right after deploying (to confirm the live provider is actually
// reachable from production) or any time a rate looks stale.
router.post('/exchange-rates/refresh', requireSuperAdmin, async (req, res) => {
  const { refreshLiveExchangeRates } = require('../fx-scheduler');
  const result = await refreshLiveExchangeRates();
  if (!result.ok) return res.status(502).json({ error: `Could not reach the live exchange rate provider: ${result.error}` });
  res.json(result);
});

// GET /api/admin/sales-inquiries — every Custom Plan "Contact Sales"
// submission, newest first. Super admin, or an admin scoped to the Sales
// department — an enterprise-sales function, not tied to any one city.
router.get('/sales-inquiries', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const inquiries = await db.all('salesInquiries');
  inquiries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ inquiries });
});

// PATCH /api/admin/sales-inquiries/:id/status
router.patch('/sales-inquiries/:id/status', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'contacted', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be new, contacted, or closed' });
  const target = await db.find('salesInquiries', i => i.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Inquiry not found' });
  const updated = await db.update('salesInquiries', target.id, { status });
  res.json({ inquiry: updated });
});

// PATCH /api/admin/sales-inquiries/:id/deal — records what was actually
// negotiated once a human has talked to this lead. This is deliberately
// just a record, not automation: saving an agreed price here does NOT
// create an account, set up billing, or provision anything — there's no
// multi-seat/organization account system yet for it to attach to (that's
// bigger future work). What this gives you now is an honest place to
// write down "we agreed to $X/seat" so it isn't lost in someone's email
// inbox, without pretending the system did more than it did.
router.patch('/sales-inquiries/:id/deal', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const { agreedPrice, agreedCurrency, internalNotes } = req.body || {};
  if (agreedPrice !== undefined && agreedPrice !== null && (typeof agreedPrice !== 'number' || agreedPrice < 0)) {
    return res.status(400).json({ error: 'Enter a valid non-negative price, or leave it blank' });
  }
  const target = await db.find('salesInquiries', i => i.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Inquiry not found' });
  const patch = { updatedAt: new Date().toISOString() };
  if (agreedPrice !== undefined) patch.agreedPrice = agreedPrice;
  if (agreedCurrency !== undefined) patch.agreedCurrency = (agreedCurrency || 'USD').toUpperCase();
  if (internalNotes !== undefined) patch.internalNotes = (internalNotes || '').trim() || null;
  const updated = await db.update('salesInquiries', target.id, patch);
  res.json({ inquiry: updated });
});

// ── ORGANIZATIONS (Custom-plan multi-seat accounts) ─────────────────────
// Super admin or Sales-department admin only — creating a company-wide
// account with its own commission rate is a genuine business decision,
// closed off to ordinary regional admins (unlike disputes/verification,
// which stay open to any regional admin with no department set).

// POST /api/admin/sales-inquiries/:id/convert-to-org — the actual "create
// the account" step once a Custom-plan deal is agreed. Requires deal terms
// (agreed price) to already be set via /deal — this endpoint doesn't
// invent a price, it turns an already-negotiated deal into a real account.
// Closes the originating inquiry and links back to it either direction,
// so there's always a paper trail from lead to account.
router.post('/sales-inquiries/:id/convert-to-org', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const inquiry = await db.find('salesInquiries', i => i.id === req.params.id);
  if (!inquiry) return res.status(404).json({ error: 'Inquiry not found' });
  if (inquiry.convertedToOrgId) return res.status(400).json({ error: 'This inquiry has already been converted to an organization' });
  if (inquiry.agreedPrice == null) return res.status(400).json({ error: 'Set agreed deal terms (Deal Notes) before converting to an account' });

  const { commissionRate, seatLimit, accountManagerId } = req.body || {};
  if (commissionRate != null && (typeof commissionRate !== 'number' || commissionRate < 0 || commissionRate > 1)) {
    return res.status(400).json({ error: 'commissionRate must be a decimal between 0 and 1 (e.g. 0.04 for 4%), or omitted' });
  }
  const me_ = await me(req);
  const parsedSeatLimit = seatLimit != null ? parseInt(seatLimit, 10) : (parseInt(inquiry.teamSize, 10) || null);

  const org = {
    id: `org_${nanoid(10)}`,
    name: inquiry.companyName,
    salesInquiryId: inquiry.id,
    agreedPrice: inquiry.agreedPrice,
    agreedCurrency: inquiry.agreedCurrency || 'USD',
    commissionRate: commissionRate ?? null,
    seatLimit: (parsedSeatLimit && parsedSeatLimit > 0) ? parsedSeatLimit : null,
    accountManagerId: accountManagerId || me_.id,
    billingContactName: inquiry.contactName,
    billingContactEmail: inquiry.email,
    status: 'active',
    createdBy: me_.id,
    createdAt: new Date().toISOString(),
  };
  await db.insert('organizations', org);
  await db.update('salesInquiries', inquiry.id, { convertedToOrgId: org.id, status: 'closed', updatedAt: new Date().toISOString() });
  res.status(201).json({ organization: org });
});

// GET /api/admin/organizations — every Custom-plan account, with real
// seat counts (not a stored counter — counted from actual attached users).
router.get('/organizations', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const orgs = await db.all('organizations');
  const providers = await db.filter('users', u => u.role === 'provider' && !!u.organizationId);
  const admins = await db.filter('users', u => u.role === 'admin');
  const adminById = new Map(admins.map(a => [a.id, a]));
  const result = orgs.map(o => ({
    ...o,
    seatCount: providers.filter(p => p.organizationId === o.id).length,
    accountManagerName: (adminById.get(o.accountManagerId) || {}).name || null,
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ organizations: result });
});

// GET /api/admin/organizations/:id — full detail: the org record, its real
// attached seats, active invite links, and combined performance across
// every seat (the "centralized reporting" promised on the Custom card) —
// computed the same honest way as the platform-wide Reports & Analytics
// (real contracts, not stored counters).
router.get('/organizations/:id', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const org = await db.find('organizations', o => o.id === req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const seats = await db.filter('users', u => u.role === 'provider' && u.organizationId === org.id);
  const seatIds = new Set(seats.map(s => s.id));
  const allContracts = await db.all('contracts');
  const orgContracts = allContracts.filter(c => seatIds.has(c.providerId));
  const completed = orgContracts.filter(c => c.status === 'completed');
  const gmv = Math.round(orgContracts.reduce((s, c) => s + (c.amount || 0), 0) * 100) / 100;
  const commissionRate = effectiveCommissionRate(null, org) ?? null;
  const invites = (await db.filter('organizationInvites', i => i.organizationId === org.id))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const admins = await db.filter('users', u => u.role === 'admin');
  const accountManager = admins.find(a => a.id === org.accountManagerId) || null;

  res.json({
    organization: { ...org, accountManagerName: accountManager ? accountManager.name : null },
    seats: seats.map(s => ({ id: s.id, name: s.name, email: s.email, category: s.category, city: s.city, rating: s.rating, verified: s.verified, active: s.active })),
    invites,
    performance: {
      seatCount: seats.length,
      jobsBooked: orgContracts.length,
      jobsCompleted: completed.length,
      gmv,
      commissionRate,
      estCommission: commissionRate != null ? Math.round(gmv * commissionRate * 100) / 100 : null,
    },
  });
});

// PATCH /api/admin/organizations/:id — edit the account: commission rate,
// seat limit, account manager, billing contact, or suspend/reactivate it.
router.patch('/organizations/:id', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const org = await db.find('organizations', o => o.id === req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const { commissionRate, seatLimit, accountManagerId, billingContactName, billingContactEmail, status } = req.body || {};
  const patch = { updatedAt: new Date().toISOString() };
  if (commissionRate !== undefined) {
    if (commissionRate !== null && (typeof commissionRate !== 'number' || commissionRate < 0 || commissionRate > 1)) {
      return res.status(400).json({ error: 'commissionRate must be a decimal between 0 and 1, or null to clear it' });
    }
    patch.commissionRate = commissionRate;
  }
  // v84: each of these is checked now. A seat limit of "lots" used to be
  // saved as "no limit", and -5 was saved as -5.
  if (seatLimit !== undefined) {
    if (seatLimit !== null && (!Number.isInteger(seatLimit) || seatLimit < 1 || seatLimit > 10000)) {
      return res.status(400).json({ error: 'Seat limit must be a whole number from 1 to 10,000, or empty for no limit' });
    }
    if (seatLimit !== null) {
      const seatsNow = (await db.filter('users', u => u.role === 'provider' && u.organizationId === org.id)).length;
      if (seatLimit < seatsNow) return res.status(400).json({ error: `This organization already has ${seatsNow} seats in use. Remove some first, or set the limit to at least ${seatsNow}.` });
    }
    patch.seatLimit = seatLimit;
  }
  if (accountManagerId !== undefined) {
    if (accountManagerId !== null && !(await db.find('users', u => u.id === accountManagerId && u.role === 'admin'))) {
      return res.status(400).json({ error: 'The account manager must be an admin account' });
    }
    patch.accountManagerId = accountManagerId;
  }
  if (billingContactName !== undefined) {
    if (billingContactName !== null && !isNonEmptyString(billingContactName, { min: 2, max: 120 })) return res.status(400).json({ error: 'Enter the billing contact\'s name (2 to 120 characters)' });
    patch.billingContactName = billingContactName === null ? null : billingContactName.trim();
  }
  if (billingContactEmail !== undefined) {
    if (billingContactEmail !== null && !isValidEmail(billingContactEmail)) return res.status(400).json({ error: 'Enter a valid billing email address' });
    patch.billingContactEmail = billingContactEmail === null ? null : billingContactEmail.trim();
  }
  if (status !== undefined) {
    if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'status must be active or suspended' });
    patch.status = status;
  }
  const updated = await db.update('organizations', org.id, patch);
  // v84: a change to an organization's commission rate or status affects
  // money, so it's written to the access log.
  if ('commissionRate' in patch || 'status' in patch) {
    const { logAccess } = require('../access-log');
    await logAccess(req, 'organization_update', `${org.id} ${JSON.stringify({ commissionRate: patch.commissionRate, status: patch.status })}`);
  }
  res.json({ organization: updated });
});

// POST /api/admin/organizations/:id/seats — admin-provisioned seat
// addition: attach an EXISTING provider account to this org directly
// (e.g. someone who signed up individually before the org existed).
// Complements invite links, which are for new/existing providers joining
// themselves.
router.post('/organizations/:id/seats', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const org = await db.find('organizations', o => o.id === req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const { providerId } = req.body || {};
  const provider = await db.find('users', u => u.id === providerId && u.role === 'provider');
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (provider.organizationId) return res.status(400).json({ error: `This provider already belongs to an organization${provider.organizationId === org.id ? ' (this one)' : ''}.` });
  if (org.seatLimit != null) {
    const currentSeats = (await db.filter('users', u => u.role === 'provider' && u.organizationId === org.id)).length;
    if (currentSeats >= org.seatLimit) return res.status(400).json({ error: `This organization is at its ${org.seatLimit}-seat limit.` });
  }
  const updated = await db.update('users', provider.id, { organizationId: org.id });
  res.json({ provider: publicAdmin(updated) });
});

// DELETE /api/admin/organizations/:id/seats/:userId — remove a provider
// from the org. They revert to their own individual plan rate immediately
// — nothing else about their account changes.
router.delete('/organizations/:id/seats/:userId', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const provider = await db.find('users', u => u.id === req.params.userId && u.organizationId === req.params.id);
  if (!provider) return res.status(404).json({ error: 'This provider is not a seat in this organization' });
  await db.update('users', provider.id, { organizationId: null });
  res.json({ ok: true });
});

// POST /api/admin/organizations/:id/invites — generate a new self-serve
// join link. A provider (new signup or existing account) who enters this
// code gets attached to the org automatically — see POST
// /api/org-invites/:code/redeem in marketplace.routes.js for the
// redemption side, and the signup flow for how a brand-new provider uses
// one during signup.
router.post('/organizations/:id/invites', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const org = await db.find('organizations', o => o.id === req.params.id);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const { maxUses, expiresInDays } = req.body || {};
  if (maxUses != null && (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1)) {
    return res.status(400).json({ error: 'maxUses must be a positive whole number, or omitted for unlimited' });
  }
  if (expiresInDays != null && (typeof expiresInDays !== 'number' || expiresInDays <= 0 || expiresInDays > 365)) {
    return res.status(400).json({ error: 'expiresInDays must be a positive number of days (365 max), or omitted for no expiry' });
  }
  const me_ = await me(req);
  const invite = {
    id: `oi_${nanoid(8)}`,
    organizationId: org.id,
    code: nanoid(10).replace(/[_-]/g, '').toUpperCase().slice(0, 8),
    createdBy: me_.id,
    maxUses: maxUses != null ? maxUses : null,
    usesCount: 0,
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  await db.insert('organizationInvites', invite);
  res.status(201).json({ invite });
});

// PATCH /api/admin/organizations/:id/invites/:inviteId/revoke — disable a
// join link immediately without deleting its usage history.
router.patch('/organizations/:id/invites/:inviteId/revoke', requireSuperAdminOrDepartment('sales'), async (req, res) => {
  const invite = await db.find('organizationInvites', i => i.id === req.params.inviteId && i.organizationId === req.params.id);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  const updated = await db.update('organizationInvites', invite.id, { status: 'revoked' });
  res.json({ invite: updated });
});

module.exports = router;
