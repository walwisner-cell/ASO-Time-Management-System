const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { COUNTRIES, statesForCountry, dialCodeForCountry } = require('../geo-data');
const { nanoid } = require('nanoid');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { isNonEmptyString, validate, postalCodeIsOptionalFor, looksLikeRealText } = require('../validators');
const { notify } = require('../notify');
const { currencyForCountry, convertFromUSD } = require('../currency-data');
const { effectivePlanPricing, resolveRate } = require('../plan-pricing');
const { contractStatusLocks } = require('../contract-locks');
const proStore = require('../store'); // v105: pro stores and extra skills

const router = express.Router();

// A genuine dispute should be rare — this is defense against spam
// (someone opening dozens in a row), not a barrier to legitimate use. The
// existing one-open-dispute-per-contract rule already prevents the same
// contract being disputed repeatedly; this catches the same person
// hammering the endpoint across many different contracts.
const disputeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many disputes filed recently — please contact support directly if you need to report something urgent.' },
});

// Same race-condition class as the payout lock in payments.routes.js: an
// organization's seat limit is checked by reading the current seat count,
// then writing the new provider's organizationId — with real time between
// those two steps. Two people redeeming the same invite link within
// moments of each other (very plausible — an invite is often shared in a
// group chat or email, and several people click it around the same time)
// could both pass the "is there room?" check before either had actually
// claimed a seat, letting an organization exceed its own seat limit. A
// per-organization lock closes this the same way the payout lock closes
// its equivalent gap.
const orgSeatLocks = new Set();

// The internal contract id (ct_xxxxxxxxxx) is what the system/API uses —
// fine for URLs and database keys, but not something a customer wants to
// read out over the phone to a provider. This generates a short 6-digit
// number instead, purely for humans to reference the same booking by.
async function generateBookingNumber() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = String(Math.floor(100000 + Math.random() * 900000));
    const collision = await db.find('contracts', c => c.bookingNumber === candidate);
    if (!collision) return candidate;
  }
  // Astronomically unlikely to ever reach here (5 collisions in a row out of
  // 900,000 possibilities), but fall back to a guaranteed-unique value
  // rather than ever leaving a contract without one.
  return String(Date.now()).slice(-6);
}

// Every place a contract goes active, this is what actually funds escrow —
// one shared path so the USD ledger amount, the real currency conversion,
// and the escrow record shape are all consistent everywhere, rather than
// multiple call sites drifting out of sync with each other.
async function fundEscrowForContract(contract, customerId, payCurrencyChoice) {
  const customer = await db.find('users', u => u.id === customerId);
  const currency = currencyForCountry(customer ? customer.country : 'United States');
  const wantsLocal = payCurrencyChoice === 'local' && currency.code !== 'USD';
  const rate = wantsLocal ? resolveRate(currency.code, await db.all('exchangeRates')) : null;
  const paidAmountLocal = wantsLocal ? convertFromUSD(contract.amount, currency.code, rate) : null;

  // Real integration point for Liberia mobile money collections (LCMMMI
  // — see src/liberia-momo.js for the full picture). isLiberiaMoMoConfigured()
  // returns false until real credentials exist, so this changes nothing
  // for any booking today — confirmed live. Once real credentials ARE
  // set: a Liberian customer paying by mobile money gets a genuine
  // charge attempt HERE, before the escrow record below is ever
  // created. MTN's API is asynchronous (a successful call here only
  // means "accepted for processing," never "paid") — the real outcome
  // needs a follow-up status check or a real webhook, not this call
  // alone; for now, a failed *request* (never even accepted) is enough
  // reason to stop and refuse to create an escrow record for money that
  // was never actually collected — express-async-errors (already used
  // throughout this file) turns this throw into a real, clean error
  // response instead of a crash.
  let liberiaMoMoReference = null;
  if (customer && customer.country === 'Liberia') {
    const { isLiberiaMoMoConfigured, requestMobileMoneyCollection } = require('../liberia-momo');
    if (isLiberiaMoMoConfigured()) {
      const defaultMethod = await db.find('paymentMethods', m => m.userId === customer.id && m.isDefault);
      if (defaultMethod && defaultMethod.type === 'mobile_money') {
        const result = await requestMobileMoneyCollection(defaultMethod.mobileMoneyNumber, contract.amount, contract.id, rate);
        if (!result.success) throw new Error(`Mobile money charge could not be started: ${result.message}`);
        liberiaMoMoReference = result.referenceId;
      }
    }
  }

  // A materials advance is tracked on the SAME escrow record as separate
  // fields, rather than as a second record — every existing feature
  // (payouts, PDFs, admin reporting) assumes one escrow per contract, and
  // this keeps that true while still letting an advance release early.
  // The main `amount`/`status` still represent the full contract and its
  // overall held/released state exactly as before.
  const advance = Math.min(contract.materialsAdvance || 0, contract.amount);

  const escrow = {
    id: `esc_${nanoid(10)}`,
    contractId: contract.id,
    amount: contract.amount, // canonical USD amount — always the accounting figure of record
    serviceFee: contract.serviceFee || 0, // tracked separately — real revenue tied to this booking, distinct from the provider's commission
    storeGoodsAmount: contract.storeGoodsTotal || 0, // v105: the part of the amount that is goods from the pro's store (no commission)
    storeFee: contract.storeFee || 0, // v105: the flat store purchase fee
    // v106: when the pro pays the fee it is not in serviceFee; it is taken at payout instead.
    storeFeeFromPro: contract.storeFeePaidBy === 'pro' ? Math.min(contract.storeFee || 0, contract.storeGoodsTotal || 0) : 0,
    paidCurrency: wantsLocal ? currency.code : 'USD',
    paidAmountLocal,
    exchangeRateNote: wantsLocal ? 'Approximate test-mode exchange rate — not a live market rate' : null,
    status: 'held',
    materialsAdvanceAmount: advance,
    materialsAdvanceReleased: false,
    materialsAdvancePayoutId: null,
    liberiaMoMoReference, // null unless a real LCMMMI collection request was actually made for this escrow — see above
    createdAt: new Date().toISOString(),
  };
  await db.insert('escrowTransactions', escrow);

  // A materials advance releases as soon as the JOB itself is confirmed —
  // not the moment the customer books, before any provider has agreed to
  // take it. Releasing it earlier would mean a provider could receive (and
  // even cash out) advance money for a job they later decline or simply
  // never respond to — exactly the premature-commitment problem the whole
  // booking-confirmation flow exists to prevent. For a direct booking
  // (status still pending_provider_confirmation at this point), the
  // advance stays unreleased until POST /contracts/:id/respond-offer
  // accepts it. For a negotiable offer, this function is only ever called
  // AFTER the provider has already accepted (see respond-offer), so
  // releasing immediately here is correct and unchanged.
  if (advance > 0 && contract.status !== 'pending_provider_confirmation') {
    await db.update('escrowTransactions', escrow.id, { materialsAdvanceReleased: true });
    escrow.materialsAdvanceReleased = true;
  }

  return escrow;
}

// Strictly validates that every photo URL a customer submits is actually
// one of OUR OWN uploaded job photos (from POST /job-photos/upload) — not
// an arbitrary external URL. Without this, someone could submit any URL
// they want (a tracking pixel, a link to unrelated/inappropriate content)
// and have it displayed to a real provider as if it were a legitimate
// part of their job photos. Returns the cleaned array, or null if
// anything in it doesn't pass.
// Some categories of work are never permitted on the platform at all, per
// policy — blocked at the moment of posting rather than caught
// afterwards. This is a plain-language keyword check on the free-text
// description and custom category name, not a perfect classifier — it
// can't catch everything, and it can occasionally flag something
// innocent (a false positive is a minor annoyance; a missed real one is
// a real safety failure, so this deliberately errs toward over-catching).
// A flagged post is rejected outright, with a clear reason, rather than
// silently allowed through.
const PROHIBITED_CONTENT_PATTERNS = [
  { pattern: /\b(transport|drive|ride|shuttle|pick up|drop off|take)\b.*\b(person|people|passenger|kid|child|children|someone|anybody|mother|father|mom|dad|parent|grandma|grandpa|grandmother|grandfather|wife|husband|spouse|friend|relative|elderly|patient|guest)\b/i, reason: 'transporting people' },
  { pattern: /\b(unsupervised|alone)\b.*\b(minor|child|kid|children)\b/i, reason: 'unsupervised minors' },
  { pattern: /\b(gun|firearm|weapon|ammunition|ammo)\b/i, reason: 'weapons' },
  { pattern: /\b(drugs?|narcotics?|cocaine|heroin|meth(amphetamine)?|marijuana|cannabis|weed)\b/i, reason: 'controlled substances' },
  { pattern: /\b(surgery|surgical|inject(ion)?|prescription|veterinary procedure|medical procedure)\b/i, reason: 'medical or veterinary procedures' },
  { pattern: /\b(hazardous waste|biohazard|biological waste|toxic waste|radioactive)\b/i, reason: 'hazardous or biological waste' },
];
// Categories where escorting/accompanying a client somewhere is a normal,
// expected, already-vetted-for part of the job — a caregiver driving an
// elderly client to a doctor's appointment, or a nanny picking a child up
// from school, isn't the unauthorized-rideshare risk this rule exists to
// catch. The same phrase from an unrelated category (a plumber offering
// to "drive someone" as a side gig) is exactly that risk, so the
// exemption is narrow and specific rather than loosening the rule
// generally.
const TRANSPORT_EXEMPT_CATEGORIES = new Set(['Elder Care', 'Babysitting & Nanny Services']);

function findProhibitedContent(text, category) {
  if (!text) return null;
  for (const { pattern, reason } of PROHIBITED_CONTENT_PATTERNS) {
    if (reason === 'transporting people' && category && TRANSPORT_EXEMPT_CATEGORIES.has(category)) continue;
    if (pattern.test(text)) return reason;
  }
  return null;
}

const MAX_JOB_PHOTOS_PER_POST = 5;
function validateJobPhotoUrls(photoUrls) {
  if (photoUrls === undefined || photoUrls === null) return [];
  if (!Array.isArray(photoUrls)) return null;
  if (photoUrls.length > MAX_JOB_PHOTOS_PER_POST) return null;
  const cleaned = [];
  for (const url of photoUrls) {
    if (typeof url !== 'string' || !/^\/uploads\/jobphoto_[\w-]+\.(jpe?g|png|webp|gif)$/i.test(url)) return null;
    cleaned.push(url);
  }
  return cleaned;
}

function publicProvider(u) {
  return {
    id: u.id, name: u.name, initials: u.initials, role: u.providerRole, category: u.category,
    rating: u.rating, jobs: u.jobs, price: u.price, tags: u.tags, color: u.color, since: u.since,
    verified: u.verified, country: u.country, city: u.city, state: u.state, zipCode: u.zipCode,
    latitude: u.latitude != null ? u.latitude : null, longitude: u.longitude != null ? u.longitude : null,
    availability: u.availability && u.availability.length ? u.availability : ['Morning (8–12pm)', 'Afternoon (12–5pm)', 'Evening (5–8pm)'],
    pricingModel: u.pricingModel || 'hourly',
    plan: u.plan || 'starter',
    profilePhotoUrl: u.profilePhotoUrl || null,
    businessName: u.businessName || null,
    acceptingBookings: u.acceptingBookings !== false,
    serviceRadiusMiles: u.serviceRadiusMiles != null ? u.serviceRadiusMiles : null,
    // v91: a new pro (fewer than five completed jobs) is shown as "New on
    // Trothen", not as a number, so the number is not sent to the public.
    trustScore: (u.trustScore != null && u.trustScoreProvisional !== true) ? u.trustScore : null,
    isNewPro: u.trustScoreProvisional === true || u.trustScore == null,
    // Only a yes/no, so a profile can say "two-step sign-in turned on" truthfully.
    twoFactorEnabled: u.twoFactorEnabled === true,
    // v105: every kind of work this pro can be found under (the main one
    // first), and the NAME of their store if it is open. Goods and prices
    // are never sent here; they are only shown inside the store.
    skills: proStore.approvedSkills(u),
    store: proStore.publicStore(u),
  };
}

// Parses a customer-entered budget string like "$80-150", "$80 - $150", or
// "$120" into a single representative amount. Previously this stripped all
// non-digit characters and parsed the result as one number, which turned a
// range like "$80-150" into 80150 — fixed to take the first number in the
// string (a sensible starting quote) instead.
function parseBudgetAmount(budget, fallback = 100) {
  if (!budget) return fallback;
  const match = String(budget).match(/\d+/);
  if (!match) return fallback;
  const n = parseInt(match[0], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// GET /api/categories — public directory of active categories with real,
// live counts of verified providers in each (no auth required; this powers
// the marketing homepage and the full "Browse Categories" page).
router.get('/categories', async (req, res) => {
  const categories = await db.filter('categories', c => c.active);
  const withCounts = await Promise.all(categories.map(async c => ({
    id: c.id,
    name: c.name,
    icon: c.icon || '🛠️',
    proCount: (await db.filter('users', u => u.role === 'provider' && u.verified && proStore.hasSkill(u, c.name))).length, // v105: counts extra skills too
  })));
  res.json({ categories: withCounts });
});

// GET /api/popular-projects — real categories, ranked by real provider
// coverage (the most honest available "popular" signal — actual bookings
// data is still thin in a young marketplace, but provider count never
// lies about which categories are genuinely active right now). "Starting
// at $X" is computed live from real provider rates, not a marketing
// number someone typed in once and forgot to update — it's the lowest
// hourly rate among verified, active providers actually in that category.
// A category with no providers yet is simply left out, rather than
// showing a fabricated or zero price.
router.get('/popular-projects', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);
  const [categories, providers, images] = await Promise.all([
    db.filter('categories', c => c.active),
    db.filter('users', u => u.role === 'provider' && u.verified && u.acceptingBookings !== false),
    db.all('categoryImages'),
  ]);
  const imageByCategory = new Map(images.map(img => [img.categoryId, img.url]));

  const withData = categories.map(c => {
    const inCategory = providers.filter(p => p.category === c.name && typeof p.price === 'number');
    const startingAt = inCategory.length ? Math.min(...inCategory.map(p => p.price)) : null;
    return {
      id: c.id,
      name: c.name,
      icon: c.icon || '🛠️',
      proCount: inCategory.length,
      startingAt,
      imageUrl: imageByCategory.get(c.id) || null,
    };
  })
  .filter(c => c.proCount > 0) // an empty category has nothing real to show yet
  .sort((a, b) => b.proCount - a.proCount)
  .slice(0, limit);

  res.json({ projects: withData });
});

// GET /api/cities — public, name+country only (no admin details — that
// stays behind /admin/cities). Cities here are ones with a dedicated
// regional admin assigned — a real, valuable feature, but no longer a
// requirement for signup (see /api/geo below): a customer or provider can
// select any real country + state/region even if no city there has its own
// admin yet, and simply falls under the super admin's oversight until one
// is assigned.
router.get('/cities', async (req, res) => {
  const cities = await db.all('cities');
  res.json({ cities: cities.map(c => ({ name: c.name, country: c.country })) });
});

// GET /api/geo — the real, full geographic reference data: every country,
// and (for the countries with real subdivision data) their actual
// states/provinces/regions. This is what powers the signup form's
// Country → State/Region dropdowns, and what the AI matching engine uses to
// expand a search outward (city → state → country) when nothing is found
// in the customer's exact city. City itself stays free text — a full
// worldwide city database would be tens of thousands of entries and
// unusable as a dropdown; country + state is the real, bounded, well-known
// dataset that scales.
// GET /api/platform-stats — real, computed numbers for the homepage hero
// (verified pro count, completed jobs, average rating). Public — this is
// marketing-page data, not anything sensitive — and genuinely derived from
// the database rather than being hardcoded copy.
router.get('/platform-stats', async (req, res) => {
  const verifiedPros = await db.filter('users', u => u.role === 'provider' && u.verified);
  const completedContracts = await db.filter('contracts', c => c.status === 'completed');
  const ratedPros = verifiedPros.filter(p => p.rating && p.rating > 0);
  const avgRating = ratedPros.length
    ? Math.round((ratedPros.reduce((s, p) => s + p.rating, 0) / ratedPros.length) * 10) / 10
    : null;
  res.json({
    verifiedProsCount: verifiedPros.length,
    jobsCompletedCount: completedContracts.length,
    averageRating: avgRating,
  });
});

// GET /api/plan-pricing?country=Nigeria — real plan pricing for the
// pricing page, signup flow, and a provider's own plan-selection screen.
// Always returns both the local-currency figure and its USD equivalent
// side by side, whether the local figure is a regional admin's explicit
// override or an automatic conversion of the super admin's USD base price
// — so a visitor (or an admin deciding whether to set an override) can
// always compare the two. No country given (or an unrecognized one) falls
// back to USD.
router.get('/plan-pricing', async (req, res) => {
  const country = req.query.country || 'United States';
  const [baseRows, overrideRows, rateRows] = await Promise.all([
    db.all('planPricingBase'),
    db.all('planPricingOverrides'),
    db.all('exchangeRates'),
  ]);
  // v78: the real commission for each plan (the same numbers payouts use)
  // and whether the monthly fee is actually being charged yet.
  const { commissionRateForPlan } = require('../commission');
  const plans = effectivePlanPricing(country, { baseRows, overrideRows, rateRows })
    .map(p => ({ ...p, commissionPercent: Math.round(commissionRateForPlan(p.plan) * 1000) / 10 }));
  const billing = await require('../plan-billing').getState();
  res.json({ country, plans, billing: { active: billing.active, beginsAt: billing.active ? billing.beginsAt : null } });
});

// GET /api/support-contact — public, no auth: the real WhatsApp/phone
// numbers behind the homepage support chat's "Chat with us" / "Call"
// links. Optional ?city= returns that region's own number if a regional
// admin has set one, falling back to the platform-wide number otherwise.
// Ships with an obviously-fake placeholder until a real number is set
// anywhere in the chain — isPlaceholder tells the frontend whether what
// it's showing is still that placeholder, so it can be honest about it
// rather than silently presenting a fake number as real.
router.get('/support-contact', async (req, res) => {
  const { getSetting, DEFAULTS } = require('../platform-settings');
  const global = await getSetting('supportContact');
  const city = (req.query.city || '').trim();
  if (city) {
    const regionalContacts = (await getSetting('regionalSupportContacts')) || {};
    const own = regionalContacts[city];
    if (own) return res.json({ ...own, isPlaceholder: false, region: city });
  }
  res.json({ ...global, isPlaceholder: global.whatsapp === DEFAULTS.supportContact.whatsapp, region: null });
});

// GET /api/footer — public, no auth: every visitor, signed in or not,
// needs this for the page footer. Read-only here on purpose; changing it
// is admin.routes.js's PATCH /admin/settings/footer (super admin only).
router.get('/footer', async (req, res) => {
  const { getSetting } = require('../platform-settings');
  require('../platform-settings').publicSupportEmail().catch(() => {}); // v95: keeps the address used in PDF footers fresh
  res.json({ footer: await getSetting('footerInfo') });
});

// GET /api/homepage-content — public, no auth: the real, current homepage
// copy (hero headline pieces, rotating word list, subheadline, mission
// section). Editable in Settings → Platform Settings (super admin).
// GET /api/content-overrides — public: front-page wording the super admin
// has changed (English only). An empty object means nothing's changed.
router.get('/content-overrides', async (req, res) => {
  const { getSetting } = require('../platform-settings');
  const overrides = await getSetting('contentOverrides');
  res.set('Cache-Control', 'no-cache');
  res.json({ overrides: overrides && typeof overrides === 'object' ? overrides : {} });
});

router.get('/homepage-content', async (req, res) => {
  const { getSetting, DEFAULTS } = require('../platform-settings');
  const content = await getSetting('homepageContent');
  // isCustomized tells the frontend whether this is genuinely admin-
  // written text (which has no translation, so stays exactly as typed
  // in every language) or still the untouched default copy (which DOES
  // have real per-language translations — see CATEGORY_TRANSLATIONS'
  // sibling, the hero_prefix/hero_suffix/etc. keys in I18N). A simple
  // deep-equality check against the built-in default is enough here —
  // there's no real case where someone deliberately re-saves the exact
  // default text and expects it to stop translating.
  const isCustomized = JSON.stringify(content) !== JSON.stringify(DEFAULTS.homepageContent);
  // Item: genuinely connected to the real Countries admin panel now —
  // this is Walter's actual, real, explicit correction: a separate,
  // manually-typed "Featured Countries" text field could drift out of
  // sync with what's really configured, which is exactly the bug he
  // caught. There's no separate setting to edit anymore — this always
  // reflects whichever countries are actually toggled to "live" in
  // Admin → Locations & Countries, live, every time this loads. Editing
  // this line now means editing the real thing, not a duplicate of it.
  const liveCountries = (await db.filter('countries', c => c.status === 'live')).map(c => c.name);
  res.json({ ...content, featuredCountries: liveCountries, isCustomized });
});

// GET /api/about-us-content, /api/terms-of-service-customer-content,
// /api/terms-of-service-provider-content — public, no auth: these are
// real pages anyone can read, not admin-only data. Customer and Provider
// versions are genuinely separate documents, not one shared page —
// what each side actually agrees to is different enough (independent
// contractor status, commission structure, cancellation protection) that
// a single mixed document was doing neither side justice.
router.get('/about-us-content', async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ content: await getSetting('aboutUsContent') });
});

// GET /api/platform-handbook — the real getting-started guide PDF, if
// one's actually been uploaded (see POST /admin/platform-handbook).
// Returns url: null rather than a 404 when nothing's been uploaded yet,
// so the frontend can simply not show the download link instead of
// treating it as an error.
router.get('/platform-handbook', async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ url: (await getSetting('platformHandbookUrl')) || null });
});

// v76: the built-in terms carry a "Last updated: [set this date...]" note
// meant for the admin. Until a real date is typed in, that line is left
// out of what visitors see rather than shown to them as is.
const withoutDatePlaceholder = (text) => String(text || '').replace(/^Last updated: \[[^\]]*\]\s*\n+/m, '');
// v77: the built-in terms say how long ID files are kept. The number comes
// from the live setting, so the terms and the system can't drift apart.
const withRetention = async (text) => {
  const { getSetting } = require('../platform-settings');
  const days = Number(await getSetting('idDocumentRetentionDays'));
  const sentence = days > 0
    ? `The files are deleted ${days} days after your check is approved, rejected or replaced by a newer upload.`
    : 'The files are kept until Trothen deletes them.';
  return String(text || '').replace(/\{\{ID_RETENTION_SENTENCE\}\}/g, sentence);
};
// v95: the Terms and the Privacy Policy both show the ONE support email
// from Settings. With no address set, they point to the Contact Us page.
const withSupportEmail = async (text) => {
  const email = await require('../platform-settings').publicSupportEmail();
  return String(text || '').replace(/\{\{SUPPORT_EMAIL\}\}/g, email || 'use the Contact Us page on this site');
};

// GET /api/privacy-policy-content — v94: public. The retention period and
// the support email are filled in from live settings, so the policy can't
// say something different from what the system does.
router.get('/privacy-policy-content', async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ content: await withSupportEmail(await withRetention(await getSetting('privacyPolicyContent'))) });
});

// GET /api/geo/place-search?q=Paynesville — v94: find a town, area or
// landmark by name so the "Choose on a map" picker can jump there. It asks
// OpenStreetMap's free search service from the server (not from the
// visitor's browser), one question a second at most, and remembers answers
// for a day, which is what that service asks of the sites that use it.
// If the service can't be reached, the picker still works: the person
// just moves the map by hand.
const PLACE_SEARCH_URL = process.env.PLACE_SEARCH_URL || 'https://nominatim.openstreetmap.org/search';
const placeCache = new Map();
let placeQueue = Promise.resolve();
let lastPlaceCallAt = 0;
const placeSearchLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many searches in a row. Wait a moment, or move the map by hand.' },
});
router.get('/geo/place-search', requireAuth, placeSearchLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2 || q.length > 80) return res.status(400).json({ error: 'Type at least 2 letters of a place name' });
  const me = await db.find('users', u => u.id === req.user.sub);
  const country = me && me.country ? me.country : '';
  const key = (q + '|' + country).toLowerCase();
  const hit = placeCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return res.json({ places: hit.places, cached: true });
  const run = async () => {
    const wait = 1100 - (Date.now() - lastPlaceCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastPlaceCallAt = Date.now();
    const url = PLACE_SEARCH_URL + '?format=jsonv2&limit=5&q=' + encodeURIComponent(country ? q + ', ' + country : q);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Trothen/1.0 (trothenpro.com; job location picker)', 'Accept-Language': 'en' } });
      if (!r.ok) throw new Error('search service answered ' + r.status);
      const rows = await r.json();
      return (Array.isArray(rows) ? rows : []).map(x => ({
        name: String(x.display_name || x.name || '').slice(0, 140),
        latitude: Math.round(parseFloat(x.lat) * 1e6) / 1e6,
        longitude: Math.round(parseFloat(x.lon) * 1e6) / 1e6,
      })).filter(x => x.name && Number.isFinite(x.latitude) && Number.isFinite(x.longitude)).slice(0, 5);
    } finally { clearTimeout(timer); }
  };
  try {
    const job = placeQueue.then(run, run);
    placeQueue = job.catch(() => {});
    const places = await job;
    if (placeCache.size > 2000) placeCache.clear();
    placeCache.set(key, { at: Date.now(), places });
    res.json({ places });
  } catch (e) {
    res.status(502).json({ error: 'Place search isn\'t available right now. You can still move the map by hand.' });
  }
});

router.get('/terms-of-service-customer-content', async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ content: await withSupportEmail(await withRetention(withoutDatePlaceholder(await getSetting('termsOfServiceCustomerContent')))) });
});

router.get('/terms-of-service-provider-content', async (req, res) => {
  const { getSetting } = require('../platform-settings');
  res.json({ content: await withSupportEmail(await withRetention(withoutDatePlaceholder(await getSetting('termsOfServiceProviderContent')))) });
});

// GET /api/homepage-images — public, no auth: the real uploaded photo (if
// any) for each homepage slot. A slot with no image simply isn't in the
// response, so the frontend falls back to its existing icon/gradient look
// — never a broken image.
router.get('/homepage-images', async (req, res) => {
  const images = await db.all('homepageImages');
  const bySlot = {};
  for (const img of images) bySlot[img.slot] = img.url;
  res.json(bySlot);
});

// GET /api/live-ads?city=Atlanta — the one currently-live paid ad slot for
// this city, if any (city-specific ads take priority over a platform-wide
// one). Public, no auth — this is what powers the real "Advertise Here"
// banner slide on the homepage. Returns { ad: null } when nothing is live
// for this city, so the frontend falls back to the generic pitch slide.
// GET /api/showcase — real reviews and real work photos for the front
// page. Only from providers who are verified and have a profile photo
// (the same rule as the public directory). Reviewer names are shortened
// to first name + last initial. Each list comes back empty until there's
// enough real material to fill it (3 reviews, 4 photos), so the front
// page never shows a half-empty wall.
function showcaseShortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A customer';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}
router.get('/showcase', async (req, res) => {
  const pros = await db.filter('users', u => u.role === 'provider' && u.verified && u.profilePhotoUrl);
  const byId = new Map(pros.map(p => [p.id, p]));
  const proInfo = p => ({ id: p.id, name: p.name, category: p.category, role: p.providerRole || null, profilePhotoUrl: p.profilePhotoUrl || null, initials: p.initials || null, color: p.color || null });
  const newestFirst = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

  let reviews = (await db.filter('reviews', r => byId.has(r.providerId) && Number(r.stars) >= 4 && typeof r.text === 'string' && r.text.trim().length >= 12))
    .sort(newestFirst).slice(0, 24)
    .map(r => ({ id: r.id, stars: Number(r.stars), text: r.text.trim().slice(0, 280), authorName: showcaseShortName(r.authorName), createdAt: r.createdAt, provider: proInfo(byId.get(r.providerId)) }));
  if (reviews.length < 3) reviews = [];

  let photos = (await db.filter('portfolioPhotos', ph => byId.has(ph.providerId) && /\.(jpe?g|png|webp|gif)$/i.test(ph.url || '')))
    .sort(newestFirst).slice(0, 24)
    .map(ph => ({ id: ph.id, url: ph.url, provider: proInfo(byId.get(ph.providerId)) }));
  if (photos.length < 4) photos = [];

  res.json({ reviews, photos });
});

router.get('/live-ads', async (req, res) => {
  // v107: every live ad takes its turn, city ads reach visitors who aren't
  // signed in, and ads end when their time is up (see src/ads.js).
  const ads = await require('../ads').adsForVisitor({ city: typeof req.query.city === 'string' ? req.query.city : null, country: typeof req.query.country === 'string' ? req.query.country : null });
  res.set('Cache-Control', 'no-store');
  res.json({ ads, ad: ads[0] || null });
});

// v107: counting. When an ad is shown on someone's screen, and when its
// button is pressed. No visitor details are kept, only the totals.
const adCountLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' } });
router.post('/live-ads/:id/:what(seen|click)', adCountLimiter, async (req, res) => {
  const ad = await db.find('advertisingInquiries', a => a.id === req.params.id);
  if (ad && require('../ads').isRunning(ad)) {
    const field = req.params.what === 'click' ? 'clicks' : 'views';
    await db.update('advertisingInquiries', ad.id, { [field]: (ad[field] || 0) + 1 });
  }
  res.json({ ok: true });
});

// GET /api/org-invites/:code — public, no auth: lets the signup page (or
// anyone with the link) confirm a code is real before asking someone to
// fill out a whole signup form. Deliberately returns only the org name,
// nothing else about the account (commission rate, billing contact, etc.
// stay admin-only).
router.get('/org-invites/:code', async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();
  const invite = await db.find('organizationInvites', i => i.code === code);
  if (!invite) return res.status(404).json({ valid: false, error: 'This invite link is invalid' });
  if (invite.status !== 'active') return res.status(400).json({ valid: false, error: 'This invite link has been revoked' });
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return res.status(400).json({ valid: false, error: 'This invite link has expired' });
  if (invite.maxUses != null && invite.usesCount >= invite.maxUses) return res.status(400).json({ valid: false, error: 'This invite link has reached its usage limit' });
  const org = await db.find('organizations', o => o.id === invite.organizationId);
  if (!org || org.status !== 'active') return res.status(400).json({ valid: false, error: 'This organization account is no longer active' });
  res.json({ valid: true, organizationName: org.name });
});

// POST /api/org-invites/:code/redeem — for a provider who ALREADY has an
// account (signed up before the org existed, or before they got the link)
// to join an organization's seats themselves, without an admin manually
// attaching them. Same validation as the signup-time path, just for an
// existing account instead of a brand-new one.
router.post('/org-invites/:code/redeem', requireAuth, requireRole('provider'), async (req, res) => {
  const code = (req.params.code || '').trim().toUpperCase();

  // Locking on the invite code itself (not the org id, which isn't known
  // yet at this point) closes the race for both checks below in one
  // step: two people redeeming the same link can't both pass the
  // maxUses check, and can't both pass the seat-limit check either.
  if (orgSeatLocks.has(code)) {
    return res.status(409).json({ error: 'This invite is being processed — please try again in a moment.' });
  }
  orgSeatLocks.add(code);

  try {
    const provider = await db.find('users', u => u.id === req.user.sub);
    if (provider.organizationId) return res.status(400).json({ error: 'Your account already belongs to an organization' });
    const invite = await db.find('organizationInvites', i => i.code === code);
    if (!invite) return res.status(404).json({ error: 'This invite link is invalid' });
    if (invite.status !== 'active') return res.status(400).json({ error: 'This invite link has been revoked' });
    if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) return res.status(400).json({ error: 'This invite link has expired' });
    if (invite.maxUses != null && invite.usesCount >= invite.maxUses) return res.status(400).json({ error: 'This invite link has reached its usage limit' });
    const org = await db.find('organizations', o => o.id === invite.organizationId);
    if (!org || org.status !== 'active') return res.status(400).json({ error: 'This organization account is no longer active' });
    if (org.seatLimit != null) {
      const currentSeats = (await db.filter('users', u => u.role === 'provider' && u.organizationId === org.id)).length;
      if (currentSeats >= org.seatLimit) return res.status(400).json({ error: `${org.name} is at its seat limit — contact them to request more seats.` });
    }
    await db.update('users', provider.id, { organizationId: org.id });
    await db.update('organizationInvites', invite.id, { usesCount: invite.usesCount + 1 });
    res.json({ ok: true, organizationName: org.name });
  } finally {
    orgSeatLocks.delete(code);
  }
});

router.get('/geo', async (req, res) => {
  const liveCountries = (await db.filter('countries', c => c.status === 'live')).map(c => c.name);
  // Only actually-live countries are offered — matches the super admin's
  // real toggle in Categories & Countries, so turning a country off there
  // genuinely removes it from signup, not just from a marketing label.
  const countries = COUNTRIES.filter(c => liveCountries.includes(c));
  const statesByCountry = {};
  const dialCodeByCountry = {};
  for (const c of countries) {
    statesByCountry[c] = statesForCountry(c);
    dialCodeByCountry[c] = dialCodeForCountry(c);
  }
  const noPostalCodeCountries = countries.filter(c => postalCodeIsOptionalFor(c));
  res.json({ countries, statesByCountry, noPostalCodeCountries, dialCodeByCountry });
});

// GET /api/currency/mine — the signed-in user's real local currency, plus a
// live conversion preview for a given USD amount. Used to show "pay in
// local currency or USD" at the moment of actually paying or requesting a
// payout, not to change how prices are quoted elsewhere in the app.
router.get('/currency/mine', requireAuth, async (req, res) => {
  const user = await db.find('users', u => u.id === req.user.sub);
  const currency = currencyForCountry(user ? user.country : 'United States');
  const amount = parseFloat(req.query.amount);
  const rate = currency.code !== 'USD' ? resolveRate(currency.code, await db.all('exchangeRates')) : null;
  const converted = (!isNaN(amount) && currency.code !== 'USD') ? convertFromUSD(amount, currency.code, rate) : null;
  res.json({
    currency,
    isUSD: currency.code === 'USD',
    convertedAmount: converted,
    exchangeRateNote: currency.code !== 'USD' ? 'Approximate test-mode exchange rate — not a live market rate' : null,
  });
});

// GET /api/providers?category=Plumbing&q=leak&city=Atlanta
// GET /api/providers/featured — for the homepage carousel. Only providers
// on a paid plan (Pro or Super Pro) ever appear here — that's the actual
// perk of paying, not a cosmetic label. Super Pro providers are weighted
// 2x as likely to appear as Pro providers in any given rotation, matching
// the requested 4x/day vs 2x/day ratio: guaranteeing an exact literal count
// per calendar day would need real session/analytics tracking per visitor,
// which doesn't exist yet, so this implements the same relative emphasis
// (2:1) through weighted random rotation instead — proportionally correct,
// verifiable by anyone pulling this endpoint repeatedly, not a fixed fake
// schedule.
router.get('/providers/featured', async (req, res) => {
  const { country } = req.query;
  const paid = await db.filter('users', u => u.role === 'provider' && u.verified && ['pro', 'superpro'].includes(u.plan));

  // If we actually know the customer's country, showing a plumber from a
  // completely different one on their very first screen isn't a
  // "featured pro" — it's just confusing, and out of step with the real
  // country/GPS matching used everywhere else in this app. Prefer a
  // real, local selection first; only fall back to a general,
  // all-locations showcase if there genuinely isn't enough local data yet
  // — and say so plainly rather than silently mixing in unrelated pros.
  const MIN_FOR_LOCAL_SCOPE = 3;
  let pool = paid;
  let scope = 'mixed';
  if (country) {
    const local = paid.filter(p => p.country === country);
    if (local.length >= MIN_FOR_LOCAL_SCOPE) {
      pool = local;
      scope = 'country';
    }
  }

  const weighted = [];
  for (const p of pool) {
    const weight = p.plan === 'superpro' ? 2 : 1;
    for (let i = 0; i < weight; i++) weighted.push(p);
  }
  // Shuffle (Fisher-Yates) so repeated calls don't always return the same
  // order, then de-duplicate back down to unique providers for display,
  // preserving the shuffled (weighted) order.
  for (let i = weighted.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [weighted[i], weighted[j]] = [weighted[j], weighted[i]];
  }
  const seen = new Set();
  const ordered = [];
  for (const p of weighted) {
    if (!seen.has(p.id)) { seen.add(p.id); ordered.push(p); }
  }
  res.json({ providers: ordered.map(publicProvider), scope });
});

router.get('/providers', async (req, res) => {
  const { category, q, city, state, country, lat, lng } = req.query;
  const customerLat = lat !== undefined ? parseFloat(lat) : null;
  const customerLng = lng !== undefined ? parseFloat(lng) : null;
  // Only verified providers appear in the public directory — showing an
  // unverified provider here (even briefly, while their documents are in
  // review) would contradict the "Fully Verified" promise shown on the
  // marketing page and profile badges. Also requires a real profile
  // picture (item 6 / Mandatory Profile Picture) — a verified provider
  // with no photo yet isn't "fully active" for discovery purposes; they
  // still have a working account and can add one in Settings any time.
  let providers = await db.filter('users', u => u.role === 'provider' && u.verified && u.profilePhotoUrl);
  if (category) providers = providers.filter(p => proStore.hasSkill(p, category)); // v105: main skill or an approved extra one
  if (q) {
    const needle = q.toLowerCase();
    // Item 2 / search strengthening: plain substring matching alone missed
    // very natural queries like "plumber" against the category "Plumbing"
    // — see src/search-synonyms.js. A query that maps to a known category
    // also matches any provider in that category, on top of the existing
    // name/category/role/tag substring matching (never instead of it).
    const { categoriesForSearchTerm } = require('../search-synonyms');
    const synonymCategories = categoriesForSearchTerm(needle);
    providers = providers.filter(p =>
      p.name.toLowerCase().includes(needle) ||
      p.category.toLowerCase().includes(needle) ||
      (p.providerRole || '').toLowerCase().includes(needle) ||
      (p.tags || []).some(t => t.toLowerCase().includes(needle)) ||
      synonymCategories.includes(p.category) ||
      // v105: a carpenter who also does plumbing is found by "plumber" too
      proStore.approvedSkills(p).some(sk => sk.toLowerCase().includes(needle) || synonymCategories.includes(sk))
    );
  }

  // Geographic scope expands outward the same way job matching does: exact
  // city first, then the same state/region, then the whole country —
  // never crossing into another country automatically. Searching
  // "Philadelphia" with no results there should show nearby Pennsylvania
  // pros before giving up, not just come back empty. Country alone (with
  // no city) is a fully real, supported case on its own — someone
  // selecting just their country to browse shouldn't require a city too.
  let locationScope = 'none';
  let suggestedCountry = null;
  if (city || country) {
    let scoped = providers;
    if (city) {
      const cityMatches = scoped.filter(p => p.city && p.city.toLowerCase() === city.toLowerCase() && (!country || p.country === country));
      if (cityMatches.length) { providers = cityMatches; locationScope = 'city'; }
    }
    if (locationScope === 'none' && city && state) {
      const stateMatches = scoped.filter(p => p.state && p.state.toLowerCase() === state.toLowerCase() && (!country || p.country === country));
      if (stateMatches.length) { providers = stateMatches; locationScope = 'state'; }
    }
    if (locationScope === 'none' && country) {
      const countryMatches = scoped.filter(p => p.country === country);
      if (countryMatches.length) {
        providers = countryMatches;
        locationScope = 'country';
      } else {
        // The real extreme case: nothing anywhere in the whole country.
        // Never silently substitute another country's results — offer
        // the nearest real alternative as an explicit, separate
        // suggestion the customer can choose to look at or ignore.
        providers = [];
        locationScope = 'country_empty';
        const otherCountryProviders = scoped.filter(p => p.country && p.country !== country);
        if (otherCountryProviders.length) {
          const { regionForCountry } = require('../region-map');
          const myRegion = regionForCountry(country);
          const counts = new Map();
          for (const p of otherCountryProviders) counts.set(p.country, (counts.get(p.country) || 0) + 1);
          // Prefer a country in the same real-world region first (a
          // customer in Liberia gets a genuinely useful suggestion —
          // another West African country with real providers — rather
          // than just whichever country happens to have the most total
          // sellers on the platform, which might be on the other side of
          // the world and no more relevant to them than a random guess).
          const sameRegionCandidates = myRegion
            ? [...counts.entries()].filter(([c]) => regionForCountry(c) === myRegion)
            : [];
          const ranked = sameRegionCandidates.length ? sameRegionCandidates : [...counts.entries()];
          suggestedCountry = ranked.sort((a, b) => b[1] - a[1])[0][0];
        }
      }
    } else if (locationScope === 'none') {
      providers = [];
    }
  }

  let finalProviders = providers.map(publicProvider);
  const { distanceInMiles, isValidCoordinate } = require('../geo-distance');
  if (isValidCoordinate(customerLat, customerLng)) {
    finalProviders = finalProviders.map(p => ({
      ...p,
      distanceMiles: isValidCoordinate(p.latitude, p.longitude)
        ? Math.round(distanceInMiles(customerLat, customerLng, p.latitude, p.longitude) * 10) / 10
        : null,
    }));
    // A provider's own service radius only ever excludes them here when
    // there's a real distance to compare it against — a provider who set
    // a radius but hasn't shared their live location, or a customer who
    // hasn't shared theirs, means there's nothing real to filter on, so
    // they're never silently hidden based on a distance nobody actually
    // knows.
    finalProviders = finalProviders.filter(p => p.distanceMiles == null || p.serviceRadiusMiles == null || p.distanceMiles <= p.serviceRadiusMiles);
    // Nearest real distance first; providers who haven't shared GPS yet
    // (distanceMiles is null) sort after everyone who has, but are still
    // shown — not sharing a precise location isn't a reason to hide
    // someone who otherwise matches on city/category.
    finalProviders.sort((a, b) => {
      if (a.distanceMiles == null && b.distanceMiles == null) return 0;
      if (a.distanceMiles == null) return 1;
      if (b.distanceMiles == null) return -1;
      return a.distanceMiles - b.distanceMiles;
    });
  }

  res.json({ providers: finalProviders, locationScope, suggestedCountry });
});

// GET /api/providers/:id  (profile page: includes reviews and portfolio photos)
router.get('/providers/:id', async (req, res) => {
  const p = await db.find('users', u => u.id === req.params.id && u.role === 'provider' && u.verified);
  if (!p) return res.status(404).json({ error: 'Provider not found' });
  const reviews = await db.filter('reviews', r => r.providerId === p.id);
  const portfolio = await db.filter('portfolioPhotos', ph => ph.providerId === p.id);
  res.json({ provider: publicProvider(p), reviews, portfolio });
});

// ---- Jobs & AI matching -----------------------------------------------------

// Item 9 / Provider Score & Job Access: replaced the old binary
// NEW_MATCH_TRUST_SCORE_FLOOR (a flat cutoff at 40 — either unlimited new
// matches or none at all) with a graduated weekly cap by score band (see
// weeklyJobAccessCapForScore in src/provider-score.js for the actual
// tiers and the reasoning behind them). isEligibleForNewMatch below is
// the real enforcement point — checked once per candidate when a job is
// posted, using each provider's real match count over the trailing 7
// days, not a calendar-week reset (a rolling window can't be gamed by
// timing a request around a fixed reset moment the way a fixed weekly
// boundary could).
async function weeklyMatchCountsForProviders(providerIds) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentMatches = await db.filter('matches', m => providerIds.includes(m.providerId) && m.createdAt >= sevenDaysAgo);
  const counts = new Map();
  for (const m of recentMatches) counts.set(m.providerId, (counts.get(m.providerId) || 0) + 1);
  return counts;
}

// POST /api/jobs — customer posts a job, triggers AI matching immediately
const { requireCurrentTerms } = require('../terms'); // v81: agreement checked on the server too

// v92: where the job is, for places without street addresses.
// A job or booking can carry a GPS pin taken on the customer's phone at
// the job site, plus a landmark in their own words ("blue gate behind the
// Total station"). In much of Liberia there is no street address to type,
// so until now a pro had nothing to navigate by.
//   - The pin is { latitude, longitude, accuracyM }. accuracyM is how many
//     metres the phone said it could be off by; it is kept so nobody
//     treats a rough fix as exact.
//   - The exact pin and landmark are only given to the pro who is HIRED.
//     Pros who are merely matched to a job see a rounded distance, not
//     the spot.
function readJobLocation(body) {
  const out = { jobLocation: null, landmark: null, error: null };
  const loc = body && body.jobLocation;
  if (loc !== undefined && loc !== null) {
    const { isValidCoordinate } = require('../geo-distance');
    if (typeof loc !== 'object' || !isValidCoordinate(loc.latitude, loc.longitude)) { out.error = 'The location pin isn\'t a valid position. Please pin it again.'; return out; }
    if (loc.latitude === 0 && loc.longitude === 0) { out.error = 'The location pin isn\'t a valid position. Please pin it again.'; return out; }
    const acc = Number(loc.accuracyM);
    out.jobLocation = {
      latitude: Math.round(loc.latitude * 1e6) / 1e6,
      longitude: Math.round(loc.longitude * 1e6) / 1e6,
      accuracyM: Number.isFinite(acc) && acc > 0 && acc < 100000 ? Math.round(acc) : null,
      source: ['gps', 'typed', 'map'].includes(loc.source) ? loc.source : 'gps', // v94: 'map' = chosen on the map picker
      capturedAt: new Date().toISOString(),
    };
  }
  const lm = body && body.landmark;
  if (lm !== undefined && lm !== null && String(lm).trim() !== '') {
    if (typeof lm !== 'string' || lm.trim().length > 200) { out.error = 'The landmark note must be under 200 characters'; return out; }
    out.landmark = lm.trim();
  }
  return out;
}
router.post('/jobs', requireAuth, requireRole('customer'), requireCurrentTerms, async (req, res) => {
  const customer = await db.find('users', u => u.id === req.user.sub);
  if (!customer || customer.verified !== true) {
    // v75: say what's actually needed. "code" lets the page open the
    // verify-now prompt instead of only showing a message.
    const openId = customer && await db.find('verifications', v => v.userId === customer.id && ['pending', 'review_required'].includes(v.status));
    if (openId) return res.status(403).json({ error: 'Your ID is being reviewed. You\'ll be able to post a job as soon as it\'s approved, usually within 48 hours.' });
    return res.status(403).json({ code: 'VERIFY_IDENTITY', error: 'Please verify your identity first. Upload a government ID in the Verification section, and you can post a job once it\'s been reviewed.' });
  }
  if (customer.onHold) {
    return res.status(403).json({ error: 'Your account is temporarily paused pending a quick review — you\'ll be able to post a job again shortly. Contact support if you need this resolved sooner.' });
  }
  const { category, description, materialsOnHand, materialsCost, budget, payCurrency, photoUrls } = req.body || {};
  const jobWhere = readJobLocation(req.body); // v92
  if (jobWhere.error) return res.status(400).json({ error: jobWhere.error });
  const errors = validate([
    ['category', isNonEmptyString(category, { min: 2, max: 60 }), 'Category is required'],
    ['description', isNonEmptyString(description, { min: 5, max: 500 }), 'Description must be between 5 and 500 characters'],
    ['description', typeof description !== 'string' || looksLikeRealText(description), 'Please describe the job in real words so we can match you correctly'],
  ]);
  if (materialsOnHand && !isNonEmptyString(materialsOnHand, { max: 300 })) {
    return res.status(400).json({ error: 'What you already have must be under 300 characters' });
  }
  if (materialsCost !== undefined && materialsCost !== null && (typeof materialsCost !== 'number' || materialsCost < 0 || materialsCost > 100000)) {
    return res.status(400).json({ error: 'Materials cost must be a positive number, or left blank' });
  }
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const prohibitedHit = findProhibitedContent(category, category) || findProhibitedContent(description, category);
  if (prohibitedHit) {
    return res.status(400).json({ error: `This can't be posted on Trothen — jobs involving ${prohibitedHit} are never permitted on the platform.` });
  }
  const validPhotoUrls = validateJobPhotoUrls(photoUrls);
  if (validPhotoUrls === null) return res.status(400).json({ error: 'Invalid photo — please re-upload your photos and try again' });

  const activeCategories = (await db.filter('categories', c => c.active)).map(c => c.name);
  const isKnownCategory = activeCategories.includes(category);
  // A job in a category we don't currently list is still a real request —
  // rejecting it here would mean "sorry, we can't help you" the moment a
  // customer's actual need doesn't match our current catalog. It posts
  // normally; AI matching just won't find anyone yet (no provider is tagged
  // to a category that doesn't exist), and the super admin is notified so
  // real demand for a new category is visible instead of silently lost.
  if (budget && !isNonEmptyString(budget, { max: 40 })) {
    return res.status(400).json({ error: 'Budget must be under 40 characters' });
  }

  const job = {
    id: `job_${nanoid(10)}`,
    customerId: req.user.sub,
    category, description: description.trim(), materialsOnHand: materialsOnHand ? materialsOnHand.trim() : null, materialsCost: materialsCost != null ? materialsCost : null, budget: budget ? budget.trim() : null,
    // Captured now, used later — escrow isn't actually funded until a
    // provider accepts the match, but the customer's currency preference is
    // set at the moment they post, not re-asked for later.
    payCurrency: payCurrency === 'local' ? 'local' : 'usd',
    photoUrls: validPhotoUrls,
    jobLocation: jobWhere.jobLocation, // v92: GPS pin of the job site, if the customer gave one
    landmark: jobWhere.landmark,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  await db.insert('jobs', job);

  if (!isKnownCategory) {
    const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
    for (const admin of superAdmins) {
      await notify(admin.id, '📋', `A customer requested "${category}" — not a current category. Consider adding it if you're seeing repeat demand.`, null, { section: 'categories' });
    }
  }

  // --- Matching (deterministic scoring stand-in for a real ranking model) ---
  // Every verified provider in the resolved geographic scope gets notified
  // and can respond — this used to cut the list down to the top 3 scored
  // candidates, which meant most verified providers never even saw a job
  // in their own category and city. Score = base 70 + rating weight +
  // experience weight + community-proximity boost + small deterministic
  // jitter derived from the job id (stable per job, varies across jobs).
  // It's still computed and returned so the customer can sort/see who's
  // the strongest fit among everyone who responds — it just no longer
  // decides who gets left out.
  //
  // Geographic scope expands outward in real stages, never skipping ahead
  // and never crossing into another country: try the customer's exact city
  // first; if nothing verified is found there, widen to the same
  // state/region; only if THAT comes up empty does it widen to the whole
  // country. A customer in Lagos is never matched to a provider in Abuja
  // over one in a different country, no matter how good that provider is.
  const inCategoryUnfiltered = await db.filter('users', u => u.role === 'provider' && proStore.hasSkill(u, category) && u.verified && u.profilePhotoUrl); // v105: main skill or an approved extra one
  const weeklyCounts = await weeklyMatchCountsForProviders(inCategoryUnfiltered.map(u => u.id));
  // Lazy require — provider-score.js requires this file back (for
  // LICENSED_TRADE_CATEGORIES/hasValidLicense), so a top-level require
  // here would be circular; every other cross-reference in this route
  // handler already follows the same lazy-require pattern.
  const { weeklyJobAccessCapForScore } = require('../provider-score');
  const allInCategory = inCategoryUnfiltered.filter(u => {
    const cap = weeklyJobAccessCapForScore(u.trustScore, u.trustScoreProvisional === true);
    if (cap === 0) return false; // suspended — 0-19 band
    if (cap === null) return true; // unlimited — 90+ band
    return (weeklyCounts.get(u.id) || 0) < cap;
  });

  let candidates = [];
  let matchScope = 'city';
  if (!customer) {
    candidates = allInCategory;
    matchScope = 'none';
  } else {
    candidates = allInCategory.filter(p => p.city && p.city.toLowerCase() === customer.city.toLowerCase() && p.country === customer.country);
    if (!candidates.length && customer.state) {
      candidates = allInCategory.filter(p => p.state && p.state.toLowerCase() === customer.state.toLowerCase() && p.country === customer.country);
      matchScope = 'state';
    }
    if (!candidates.length && customer.country) {
      candidates = allInCategory.filter(p => p.country === customer.country);
      matchScope = 'country';
    }
  }

  const scored = candidates.map(p => {
    const jitter = (parseInt(job.id.slice(-4), 36) % 7);
    const sameCommunity = customer && p.zipCode && customer.zipCode && p.zipCode === customer.zipCode;
    const communityBoost = sameCommunity ? 8 : 0;
    // The Trust Score (see src/provider-score.js) already measures
    // exactly what "intelligent matching" needs beyond raw rating —
    // reliability, cancellation behavior, response rate, job history —
    // so this reuses it directly instead of inventing a second, competing
    // definition of the same idea. Blended at a modest weight (up to +6)
    // rather than dominating the score: a provider's average customer
    // rating is still the primary signal, this just tips close calls
    // toward the more reliable provider. A provider with no trust score
    // computed yet (brand new account, before the first daily sweep runs)
    // is unaffected — this term is simply zero, not treated as a penalty.
    // v91: a new pro gets a middle placement boost (3 of 6): not buried,
    // but not ranked above pros with a proven high score either.
    const trustBoost = p.trustScoreProvisional === true ? 3 : (p.trustScore != null ? Math.round((Math.min(p.trustScore, 99) / 99) * 6) : 0);
    const score = Math.min(99, Math.round(70 + p.rating * 4 + Math.min(p.jobs, 300) / 30 + communityBoost + trustBoost + jitter));
    return { provider: p, score, sameCommunity };
  }).sort((a, b) => b.score - a.score);

  const matches = [];
  for (const { provider, score, sameCommunity } of scored) {
    const match = {
      id: `match_${nanoid(10)}`,
      jobId: job.id,
      providerId: provider.id,
      customerId: req.user.sub,
      score,
      sameCommunity,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await db.insert('matches', match);
    await notify(provider.id, '🎯', `New job match: ${job.description.slice(0, 50)}${job.description.length > 50 ? '…' : ''} (${score}% fit)`, 'newMatches', { section: 'matches' });
    matches.push({ ...match, provider: publicProvider(provider) });
  }

  res.status(201).json({ job, matches, isKnownCategory, matchScope });
});

// GET /api/jobs/mine — customer's posted jobs
router.get('/jobs/mine', requireAuth, requireRole('customer'), async (req, res) => {
  const jobs = await db.filter('jobs', j => j.customerId === req.user.sub);
  res.json({ jobs });
});

// POST /api/jobs/:id/cancel — a customer can remove their own job request
// as long as it's still open (unmatched). Once a match is accepted it
// becomes a real contract, which has its own cancellation path — this is
// specifically for "I made a mistake" or "never mind" on a raw request
// that hasn't turned into a booking yet.
router.post('/jobs/:id/cancel', requireAuth, requireRole('customer'), async (req, res) => {
  const job = await db.find('jobs', j => j.id === req.params.id && j.customerId === req.user.sub);
  if (!job) return res.status(404).json({ error: 'Job request not found' });
  if (job.status !== 'open') {
    return res.status(400).json({ error: `This request is already ${job.status} and can't be cancelled here` });
  }
  const updated = await db.update('jobs', job.id, { status: 'cancelled' });
  res.json({ job: updated });
});

// GET /api/matches/mine — a provider's own view of jobs matched to them:
// ones still awaiting their response, plus ones they've already expressed
// interest in (so the job doesn't disappear from their list the moment
// they respond — they can keep negotiating, or see it marked filled/not
// selected once the customer hires someone).
router.get('/matches/mine', requireAuth, requireRole('provider'), async (req, res) => {
  const matches = await db.filter('matches', m => m.providerId === req.user.sub && ['pending', 'interested'].includes(m.status));
  const meProvider = await db.find('users', u => u.id === req.user.sub);
  const withJob = await Promise.all(matches.map(async m => {
    const customer = await db.find('users', u => u.id === m.customerId);
    const fullJob = await db.find('jobs', j => j.id === m.jobId);
    // v92: a matched pro is not given the exact pin or the landmark, only
    // how far away the job is (rounded), worked out from their own shared
    // location. They get the spot itself once the customer hires them.
    let job = fullJob, distanceMiles = null, hasPin = false;
    if (fullJob) {
      const { jobLocation, landmark, ...rest } = fullJob;
      job = rest; hasPin = !!jobLocation;
      const { distanceInMiles, isValidCoordinate } = require('../geo-distance');
      if (jobLocation && meProvider && isValidCoordinate(meProvider.latitude, meProvider.longitude)) {
        distanceMiles = Math.max(0.5, Math.round(distanceInMiles(meProvider.latitude, meProvider.longitude, jobLocation.latitude, jobLocation.longitude) * 2) / 2);
      }
    }
    return { ...m, job, distanceMiles, jobHasPin: hasPin, customerName: customer ? customer.name : 'Customer' };
  }));
  res.json({ matches: withJob });
});

// POST /api/matches/:id/respond  { decision: 'accept' | 'decline' }
// Trades where accepting real work without a real, current license is a
// genuine safety issue, not just a policy formality — matches the
// Restricted/Documented tier distinction in the published category
// policy. Rather than deactivating these categories outright (which
// would remove real, valuable business from the platform), participation
// is gated behind an actual verified license on file, the same pattern
// real competitors (Thumbtack, Angi) use.
const LICENSED_TRADE_CATEGORIES = new Set([
  'Plumbing', 'Electrical', 'Roofing',
  // Added on the same reasoning: genuinely, near-universally licensed
  // professions in real jurisdictions, not just skilled trades.
  // Deliberately left out ambiguous ones — Accounting & Bookkeeping (plain
  // bookkeeping usually needs no license, only formal CPA work does),
  // Elder Care and Auto Repair (requirements vary too much by location to
  // treat as a universal rule the way these do).
  'HVAC & Air Conditioning', 'General Contracting', 'Legal Consulting',
  'Pest Control', 'Locksmith', 'Massage Therapy', 'Notary Services', 'Security Services',
]);

// The customer-side service fee — 9% with a $1.99 minimum, exactly
// matching the published Fees and Payment Policy. This is separate from
// (and in addition to) the Provider's commission: the Provider is still
// paid out based on the job amount alone, unaffected by this — this fee
// is pure, additional revenue on the customer side, shown to them
// itemized before they ever confirm a booking.
// The customer-side service fee — 9% with a $2.99 minimum and a $25
// maximum, exactly matching the current Master Reference and Fees and
// Payment Policy. This is separate from (and in addition to) the
// Provider's commission: the Provider is still paid out based on the job
// amount alone, unaffected by this — this fee is pure, additional revenue
// on the customer side, shown to them itemized before they ever confirm
// a booking.
const SERVICE_FEE_RATE = 0.09;
const MIN_SERVICE_FEE = 2.99;
const MAX_SERVICE_FEE = 25;
function computeServiceFee(amount) {
  const raw = Math.max(amount * SERVICE_FEE_RATE, MIN_SERVICE_FEE);
  return Math.round(Math.min(raw, MAX_SERVICE_FEE) * 100) / 100;
}

function hasValidLicense(provider) {
  if (!provider.licenseExpiryDate) return false;
  // The Provider Agreement is explicit: "Expired documents block
  // acceptance automatically on the day they lapse. There is no grace
  // period and no override." That means the stated expiry date itself is
  // the first invalid day — not the day after. An earlier fix here (for
  // a genuine, different bug: a license briefly looking expired hours
  // before its actual day was over) had the side effect of granting a
  // full extra day of validity past the stated date, which is exactly
  // the grace period this policy explicitly rules out. This compares
  // against the start of the expiry date, not its end.
  const expiry = new Date(provider.licenseExpiryDate + 'T00:00:00.000Z');
  return expiry > new Date();
}

// POST /api/matches/:id/respond  { decision: 'accept' | 'decline' }
// 'accept' used to immediately create a contract and fund escrow — the
// first provider to click won the job outright, with no negotiation and
// no actual choice for the customer. That's not what the platform
// promises (see the handbook: customers review who responded and choose
// who to hire) and it meant a job could be taken before a customer even
// saw who else was interested. Accepting now just means "I'm interested
// and available" — it notifies the customer and shows up in their list of
// responses, but the job isn't filled until the customer actually hires
// someone via POST /jobs/:id/select-provider below.
router.post('/matches/:id/respond', requireAuth, requireRole('provider'), requireCurrentTerms, async (req, res) => {
  const { decision, coverLetter } = req.body || {};
  const match = await db.find('matches', m => m.id === req.params.id && m.providerId === req.user.sub);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (!['accept', 'decline'].includes(decision)) return res.status(400).json({ error: 'decision must be accept or decline' });
  // Item 3 / Cover Letter: an optional short note a provider can attach
  // when expressing interest — genuinely optional (a provider who just
  // clicks "Interested" isn't blocked), but real and visible to the
  // customer in GET /jobs/:id/candidates below, not just accepted and
  // discarded.
  if (coverLetter !== undefined && coverLetter !== null && !isNonEmptyString(coverLetter, { max: 1000 })) {
    return res.status(400).json({ error: 'Cover letter must be under 1000 characters' });
  }

  if (decision === 'accept') {
    const provider = await db.find('users', u => u.id === req.user.sub);
    if (provider && provider.onHold) {
      return res.status(403).json({ error: 'Your account is temporarily paused pending a quick review — you\'ll be able to respond to jobs again shortly. Contact support if you need this resolved sooner.' });
    }
    if (provider && LICENSED_TRADE_CATEGORIES.has(provider.category) && !hasValidLicense(provider)) {
      return res.status(403).json({ error: `${provider.category} requires a current, verified license on file before you can respond to jobs — add your license expiry date in Settings.` });
    }
  }

  const matchPatch = { status: decision === 'accept' ? 'interested' : 'declined' };
  if (decision === 'accept' && isNonEmptyString(coverLetter, { max: 1000 })) matchPatch.coverLetter = coverLetter.trim();
  const updated = await db.update('matches', match.id, matchPatch);

  if (decision === 'accept') {
    const provider = await db.find('users', u => u.id === req.user.sub);
    const job = await db.find('jobs', j => j.id === match.jobId);
    await notify(match.customerId, '🙋', `${provider ? provider.name : 'A provider'} is interested in your job${job ? ` — "${job.description.slice(0, 50)}${job.description.length > 50 ? '…' : ''}"` : ''}. Review responses and message them to agree on a price.`, 'newMatches', { section: 'bookings' });
  }

  res.json({ match: updated });
});

// GET /api/jobs/:id/candidates — a customer's own view of everyone who's
// responded to one of their open jobs: every match (whatever its status)
// with the provider's public profile and their message thread for this
// specific job, so the customer can compare responses and negotiate
// without extra round trips.
router.get('/jobs/:id/candidates', requireAuth, requireRole('customer'), async (req, res) => {
  const job = await db.find('jobs', j => j.id === req.params.id && j.customerId === req.user.sub);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const matches = (await db.filter('matches', m => m.jobId === job.id)).sort((a, b) => b.score - a.score);
  const candidates = await Promise.all(matches.map(async m => {
    const provider = await db.find('users', u => u.id === m.providerId);
    if (!provider) return null;
    const messages = (await db.filter('messages', msg => msg.jobId === job.id && (msg.fromId === m.providerId || msg.toId === m.providerId)))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return { matchId: m.id, status: m.status, score: m.score, sameCommunity: m.sameCommunity, coverLetter: m.coverLetter || null, provider: publicProvider(provider), messages };
  }));
  res.json({ job, candidates: candidates.filter(Boolean) });
});

// POST /api/jobs/:id/select-provider — the actual "hire" action once a
// customer has reviewed responses and (optionally) negotiated a price by
// message. Creates the real contract at the agreed amount, funds escrow,
// snapshots the negotiation thread onto the contract for the record, and
// closes the job out for every other provider who'd responded.
router.post('/jobs/:id/select-provider', requireAuth, requireRole('customer'), async (req, res) => {
  const job = await db.find('jobs', j => j.id === req.params.id && j.customerId === req.user.sub);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'open') return res.status(400).json({ error: `This job is already ${job.status} — it can't be hired out again.` });

  const { providerId, amount } = req.body || {};
  if (!isNonEmptyString(providerId)) return res.status(400).json({ error: 'A provider must be selected' });
  const match = await db.find('matches', m => m.jobId === job.id && m.providerId === providerId);
  if (!match) return res.status(404).json({ error: 'This provider hasn\'t responded to this job' });
  if (match.status === 'declined') return res.status(400).json({ error: 'This provider declined this job' });

  const provider = await db.find('users', u => u.id === providerId);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  if (provider.onHold) return res.status(403).json({ error: 'This provider\'s account is temporarily paused — choose another provider, or check back shortly.' });
  if (LICENSED_TRADE_CATEGORIES.has(provider.category) && !hasValidLicense(provider)) {
    return res.status(403).json({ error: `${provider.name} doesn't have a current, verified license on file for ${provider.category} and can't be hired for this job right now.` });
  }

  let finalAmount = parseBudgetAmount(job.budget, 100);
  if (amount !== undefined) {
    if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Amount must be a positive number' });
    finalAmount = amount;
  }

  // The actual negotiation — every message either side sent about this
  // specific job — frozen onto the contract right now, exactly as it
  // happened. Anything said after this point (small talk, scheduling
  // logistics) is a normal message, not part of the negotiation record.
  const jobMessages = (await db.filter('messages', m => m.jobId === job.id && (m.fromId === providerId || m.toId === providerId)))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const negotiationTranscript = jobMessages.map(m => ({
    from: m.fromId === req.user.sub ? 'customer' : 'provider',
    text: m.text,
    at: m.createdAt,
  }));

  // This used to go straight to 'active' with escrow already funded and
  // the job marked filled — meaning a job could sit "confirmed" on a
  // provider's calendar (and every other candidate turned away) before
  // that provider had actually agreed to the final price and terms a
  // customer picked. Selecting/expressing interest earlier isn't the same
  // as accepting a specific hire. Brought in line with the direct-booking
  // flow below (POST /contracts): funds are held immediately (the
  // customer is committing real money the moment they hire), but the
  // contract itself is real only once a human on the provider's side
  // actually confirms — same real deadline, same automatic-expiry
  // handling (src/booking-scheduler.js), and now also automatic
  // reassignment to the next candidate instead of leaving the customer's
  // job dead if this pick doesn't confirm (see attemptJobReassignment
  // below, used here and from the decline/expiry paths).
  const { getSetting, computeResponseWindowHours } = require('../platform-settings');
  const tiers = await getSetting('bookingResponseTiers');
  // Posted jobs have no fixed date/time (unlike a direct booking), so
  // jobDateTime is null — computeResponseWindowHours already handles that
  // by falling back to the middle tier rather than guessing wrong.
  const windowHours = computeResponseWindowHours({ now: new Date(), jobDateTime: null, tiers, categoryOverrideHours: null });
  const responseDeadline = new Date(Date.now() + windowHours * 60 * 60 * 1000).toISOString();

  const contract = {
    id: `ct_${nanoid(10)}`,
    bookingNumber: await generateBookingNumber(),
    customerId: req.user.sub,
    providerId,
    jobId: job.id,
    service: job.description,
    jobLocation: job.jobLocation || null, // v92: now the hired pro can see where to go
    landmark: job.landmark || null,
    address: job.landmark || null,
    amount: finalAmount,
    serviceFee: computeServiceFee(finalAmount),
    status: 'pending_provider_confirmation',
    signedAt: null,
    providerResponseDeadline: responseDeadline,
    negotiationTranscript,
    createdAt: new Date().toISOString(),
  };
  await db.insert('contracts', contract);
  const escrow = await fundEscrowForContract(contract, req.user.sub, job.payCurrency);
  await db.update('jobs', job.id, { status: 'matched' });
  await db.update('matches', match.id, { status: 'accepted' });

  const { checkPriceAnomaly, checkNewAccountHighValue } = require('../fraud-detection');
  await checkPriceAnomaly(provider.category, contract.amount, contract.id, req.user.sub, providerId);
  await checkNewAccountHighValue(req.user.sub, contract.amount);

  const deadlineLabel = new Date(responseDeadline).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  await notify(providerId, '🎉', `You were selected for "${job.description.slice(0, 50)}${job.description.length > 50 ? '…' : ''}" at $${finalAmount} — confirm by ${deadlineLabel} or it's automatically offered to the next candidate.`, null, { section: 'bookings' });
  await notify(req.user.sub, '⏳', `Your booking for "${job.description.slice(0, 50)}${job.description.length > 50 ? '…' : ''}" is awaiting the provider's confirmation.`, null, { section: 'bookings' });

  // NOTE: other candidates are deliberately NOT dismissed here — see
  // finalizeJobSelection below. They only get marked not_selected once
  // this specific hire is actually confirmed, so they're still available
  // as real fallback candidates if this one declines or times out.

  res.status(201).json({ contract, escrow });
});

// Called once a job-originated hire is actually confirmed (see
// handleRespondOffer): this is the real "job's filled" moment, so this is
// when other candidates who responded actually get dismissed and told.
async function finalizeJobSelection(job, confirmedMatchId) {
  const otherMatches = await db.filter('matches', m => m.jobId === job.id && m.id !== confirmedMatchId && ['pending', 'interested'].includes(m.status));
  for (const other of otherMatches) {
    await db.update('matches', other.id, { status: 'not_selected' });
    await notify(other.providerId, '📋', `The customer hired another provider for "${job.description.slice(0, 50)}${job.description.length > 50 ? '…' : ''}" — this job is no longer available.`, null, { section: 'matches' });
  }
}

// The real implementation behind item 10: when a job-originated hire
// declines or times out unconfirmed, this looks for the next real
// candidate — another provider who actually expressed interest in this
// same job and hasn't already been tried and failed — and automatically
// re-offers the job to them at the same amount, instead of just refunding
// and leaving the customer to start over. Only if nobody's left does it
// fall back to reopening the job for the customer to pick again.
// contractOrNull may be null (nothing to refund yet, e.g. called from a
// context that already handled that) — reassignment logic is identical
// either way.
async function attemptJobReassignment(job, failedProviderId, failedAmount) {
  const alreadyTried = (await db.filter('contracts', c => c.jobId === job.id)).map(c => c.providerId);
  const candidates = await db.filter('matches', m =>
    m.jobId === job.id && m.status === 'interested' && !alreadyTried.includes(m.providerId)
  );
  candidates.sort((a, b) => b.score - a.score);
  const next = candidates[0];

  if (!next) {
    // Nobody left to offer it to — reopen the job so the customer can
    // pick again (or wait for new responses) rather than it dying silently.
    await db.update('jobs', job.id, { status: 'open' });
    await notify(job.customerId, '🔁', `Your provider for "${job.description.slice(0, 50)}${job.description.length > 50 ? '…' : ''}" didn't confirm in time and no other candidates are available — the job is reopened so you can choose again.`, null, { section: 'bookings' });
    return null;
  }

  const provider = await db.find('users', u => u.id === next.providerId);
  const { getSetting, computeResponseWindowHours } = require('../platform-settings');
  const tiers = await getSetting('bookingResponseTiers');
  const windowHours = computeResponseWindowHours({ now: new Date(), jobDateTime: null, tiers, categoryOverrideHours: null });
  const responseDeadline = new Date(Date.now() + windowHours * 60 * 60 * 1000).toISOString();

  const contract = {
    id: `ct_${nanoid(10)}`,
    bookingNumber: await generateBookingNumber(),
    customerId: job.customerId,
    providerId: next.providerId,
    jobId: job.id,
    service: job.description,
    amount: failedAmount,
    serviceFee: computeServiceFee(failedAmount),
    status: 'pending_provider_confirmation',
    signedAt: null,
    providerResponseDeadline: responseDeadline,
    negotiationTranscript: [],
    createdAt: new Date().toISOString(),
  };
  await db.insert('contracts', contract);
  const escrow = await fundEscrowForContract(contract, job.customerId, job.payCurrency);
  await db.update('matches', next.id, { status: 'accepted' });

  const deadlineLabel = new Date(responseDeadline).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  await notify(next.providerId, '🎉', `You were selected for "${job.description.slice(0, 50)}${job.description.length > 50 ? '…' : ''}" at $${failedAmount} — confirm by ${deadlineLabel} or it's automatically offered to the next candidate.`, null, { section: 'bookings' });
  await notify(job.customerId, '🔁', `${provider ? provider.name : 'The next available provider'} wasn't able to confirm your original pick, so your job for "${job.description.slice(0, 50)}${job.description.length > 50 ? '…' : ''}" was automatically offered to the next available candidate at the same price.`, null, { section: 'bookings' });

  return contract;
}

// ---- Contracts / bookings ----------------------------------------------------

// POST /api/contracts — direct booking of a specific provider (skips matching)
router.post('/contracts', requireAuth, requireRole('customer'), requireCurrentTerms, async (req, res) => {
  const customer = await db.find('users', u => u.id === req.user.sub);
  if (!customer || customer.verified !== true) {
    // v75: say what's actually needed. "code" lets the page open the
    // verify-now prompt instead of only showing a message.
    const openId = customer && await db.find('verifications', v => v.userId === customer.id && ['pending', 'review_required'].includes(v.status));
    if (openId) return res.status(403).json({ error: 'Your ID is being reviewed. You\'ll be able to book a pro as soon as it\'s approved, usually within 48 hours.' });
    return res.status(403).json({ code: 'VERIFY_IDENTITY', error: 'Please verify your identity first. Upload a government ID in the Verification section, and you can book a pro once it\'s been reviewed.' });
  }
  if (customer.onHold) {
    return res.status(403).json({ error: 'Your account is temporarily paused pending a quick review — you\'ll be able to book again shortly. Contact support if you need this resolved sooner.' });
  }
  const { providerId, date, time, amount, payCurrency, materialsAdvance, photoUrls, isOffer, useLoyaltyPoints, materialsOnHand } = req.body || {};
  let { service } = req.body || {};
  // v105: goods picked in the pro's store, and whether this is goods only (no job).
  const goodsOnly = (req.body || {}).goodsOnly === true;
  const basket = await proStore.priceBasket(providerId, (req.body || {}).storeItems);
  if (basket.error) return res.status(400).json({ error: basket.error });
  if (goodsOnly && !basket.items.length) return res.status(400).json({ error: 'Pick at least one good from the store, or book the pro for a job.' });
  if (goodsOnly && (typeof service !== 'string' || service.trim().length < 3)) {
    service = ('Store order: ' + basket.items.map(i => `${i.qty} x ${i.name}`).join(', ')).slice(0, 200);
  }
  // v92: a street address is no longer the only way to say where the job
  // is. A GPS pin or a landmark is enough, because many places have no
  // street address. At least one of the three is still required.
  const bookWhere = readJobLocation(req.body);
  if (bookWhere.error) return res.status(400).json({ error: bookWhere.error });
  let address = typeof (req.body || {}).address === 'string' ? req.body.address : '';
  if (address.trim().length < 5 && (bookWhere.landmark || bookWhere.jobLocation)) address = bookWhere.landmark || 'Location pinned on the map';
  if (materialsOnHand && !isNonEmptyString(materialsOnHand, { max: 300 })) {
    return res.status(400).json({ error: 'What you already have must be under 300 characters' });
  }
  const errors = validate([
    ['providerId', isNonEmptyString(providerId), 'A provider must be selected'],
    ['service', isNonEmptyString(service, { min: 3, max: 200 }), 'Describe the service in at least 3 characters'],
    ['service', typeof service !== 'string' || looksLikeRealText(service), 'Please describe the job in real words so we can match you correctly'],
    ['date', isNonEmptyString(date), 'Pick a date for the job'],
    ['time', isNonEmptyString(time), 'Pick a time for the job'],
    ['address', isNonEmptyString(address, { min: 5, max: 200 }), 'Tell the pro where the job is: pin the location, describe a landmark, or type an address'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const provider = await db.find('users', u => u.id === providerId && u.role === 'provider');
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const prohibitedHit = findProhibitedContent(service, provider.category);
  if (prohibitedHit) {
    return res.status(400).json({ error: `This can't be booked on Trothen — jobs involving ${prohibitedHit} are never permitted on the platform.` });
  }
  if (amount !== undefined && (typeof amount !== 'number' || amount <= 0)) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }
  if (materialsAdvance !== undefined && (typeof materialsAdvance !== 'number' || materialsAdvance < 0)) {
    return res.status(400).json({ error: 'Materials advance must be zero or a positive number' });
  }
  if (materialsAdvance && amount && materialsAdvance > amount) {
    return res.status(400).json({ error: 'The materials advance can\'t be more than the total job amount' });
  }
  if (goodsOnly && materialsAdvance) {
    return res.status(400).json({ error: 'A materials advance is for a job. This order is for goods only.' });
  }
  const validPhotoUrls = validateJobPhotoUrls(photoUrls);
  if (validPhotoUrls === null) return res.status(400).json({ error: 'Invalid photo — please re-upload your photos and try again' });

  // A provider can pause new bookings without deleting their profile or
  // going through the confirm/decline dance on every request — the
  // "vacation mode" pattern TaskRabbit and Thumbtack both have. Checked
  // before anything else so a customer isn't left holding a pending
  // request the provider was never going to see.
  if (provider.acceptingBookings === false) {
    return res.status(400).json({ error: `${provider.name} isn't currently accepting new bookings. Try another provider, or check back later.` });
  }

  const isNegotiable = !goodsOnly && (provider.pricingModel === 'negotiable' || (provider.pricingModel === 'both' && !!isOffer)); // v105: goods have a fixed price, so a goods-only order is never an offer
  if (isNegotiable && (amount === undefined || amount <= 0)) {
    return res.status(400).json({ error: 'Enter your offer amount for this provider' });
  }

  // Every new booking — direct or a Mutual Agreement offer — now genuinely
  // requires the provider to accept before it's a real, confirmed job.
  // Previously a direct (non-negotiable) booking skipped this entirely and
  // went straight to 'active' with escrow already funded, meaning a
  // provider could have a job "confirmed" on their calendar that they
  // never actually agreed to take. Funds are still held immediately either
  // way (the customer is committing real money the moment they book) —
  // what changed is that the job itself isn't real until a human on the
  // provider's side says yes, and that decision has a real deadline
  // instead of being able to sit unanswered forever (see
  // src/booking-scheduler.js for what happens if they don't respond).
  //
  // The deadline itself is tiered by how soon the job actually is (see
  // src/platform-settings.js), not a flat number — an emergency plumbing
  // job booked for this afternoon needs a fast response; a mover booked
  // for next month doesn't. A category can override this entirely (e.g.
  // "Emergency Plumbing" always needs a 30-minute response regardless of
  // lead time), set in Categories & Countries.
  const { getSetting, computeResponseWindowHours } = require('../platform-settings');
  const tiers = await getSetting('bookingResponseTiers');
  const categoryRecord = await db.find('categories', c => c.name === provider.category);
  const jobDateTime = new Date(`${date} ${time}`);
  const windowHours = computeResponseWindowHours({
    now: new Date(),
    jobDateTime,
    tiers,
    categoryOverrideHours: categoryRecord ? categoryRecord.responseWindowOverrideHours : null,
  });
  const responseDeadline = new Date(Date.now() + windowHours * 60 * 60 * 1000).toISOString();

  // Loyalty points redemption — waives the platform's own service fee,
  // never the provider's payment (the provider is always paid the full
  // agreed amount regardless). Re-checks the customer's real point
  // balance server-side rather than trusting the client's flag — a
  // request claiming a discount it hasn't actually earned is silently
  // ignored rather than honored.
  const { awardLoyaltyPoint, POINTS_FOR_FREE_BOOKING } = require('../loyalty');
  const customerForPoints = await db.find('users', u => u.id === req.user.sub);
  const canRedeemPoints = !goodsOnly && !!useLoyaltyPoints && customerForPoints && (customerForPoints.loyaltyPoints || 0) >= POINTS_FOR_FREE_BOOKING; // v105: points waive the fee on a job; a goods-only order has no such fee
  // v105: the booking amount is the job plus any goods from the pro's
  // store. The 9% service fee is worked out on the job only. Goods carry
  // one flat purchase fee instead (set by the super admin), and no
  // commission is taken on them when the pro is paid.
  const laborAmount = goodsOnly ? 0 : (amount || provider.price * 2);
  const goodsTotal = basket.total;
  const finalContractAmount = proStore.money(laborAmount + goodsTotal);
  const storeSettingsNow = await proStore.storeSettings();
  const storeFee = basket.items.length ? storeSettingsNow.purchaseFee : 0;
  // v106: the super admin chooses who pays the flat fee. When the pro pays,
  // the customer is charged nothing extra and the fee is taken from the
  // pro's money at payout (never more than the goods came to).
  const storeFeePaidBy = storeSettingsNow.feePaidBy === 'pro' ? 'pro' : 'customer';
  const storeFeeFromCustomer = storeFeePaidBy === 'customer' ? storeFee : 0;
  const { feeDiscountForTier } = require('../membership');
  const realServiceFee = laborAmount > 0 ? Math.round(computeServiceFee(laborAmount) * (1 - feeDiscountForTier(customerForPoints && customerForPoints.membershipTier)) * 100) / 100 : 0;

  const contract = {
    id: `ct_${nanoid(10)}`,
    bookingNumber: await generateBookingNumber(),
    customerId: req.user.sub,
    providerId,
    service: service.trim(),
    date, time, address: address.trim(),
    jobLocation: bookWhere.jobLocation, // v92
    landmark: bookWhere.landmark,
    amount: finalContractAmount,
    serviceFee: proStore.money((canRedeemPoints ? 0 : realServiceFee) + storeFeeFromCustomer),
    // v105: what the amount is made of
    laborAmount,
    storeItems: basket.items,
    storeGoodsTotal: goodsTotal,
    storeFee,
    storeFeePaidBy: basket.items.length ? storeFeePaidBy : null,
    goodsOnly,
    materialsCost: goodsTotal > 0 ? goodsTotal : null,
    storeStockHeld: basket.items.length > 0,
    loyaltyPointsRedeemed: canRedeemPoints ? POINTS_FOR_FREE_BOOKING : 0,
    materialsAdvance: materialsAdvance || 0,
    materialsOnHand: materialsOnHand ? materialsOnHand.trim() : null,
    photoUrls: validPhotoUrls,
    status: isNegotiable ? 'pending_agreement' : 'pending_provider_confirmation',
    payCurrency: payCurrency === 'local' ? 'local' : 'usd',
    signedAt: null,
    providerResponseDeadline: responseDeadline,
    createdAt: new Date().toISOString(),
  };
  await db.insert('contracts', contract);
  if (basket.items.length) await proStore.holdStock(basket.items); // v105: held now, given back if the booking doesn't go ahead

  if (canRedeemPoints) {
    await db.update('users', customerForPoints.id, { loyaltyPoints: (customerForPoints.loyaltyPoints || 0) - POINTS_FOR_FREE_BOOKING });
    await notify(req.user.sub, '🎁', `Free booking credit applied — $${realServiceFee.toFixed(2)} service fee waived on "${contract.service}".`, null, { section: 'bookings' });
  }
  await awardLoyaltyPoint(req.user.sub, 'booking');

  // Real fraud/safety screening on every booking — this is what actually
  // backs the "every job screened automatically" claim. Never blocks the
  // booking itself; just creates a real, reviewable flag when something's
  // genuinely off.
  const { checkPriceAnomaly, checkNewAccountHighValue } = require('../fraud-detection');
  if (laborAmount > 0) await checkPriceAnomaly(provider.category, laborAmount, contract.id, req.user.sub, providerId); // v105: goods don't count as an unusual job price
  await checkNewAccountHighValue(req.user.sub, contract.amount);

  // Funds are held immediately regardless of pricing model — a direct
  // booking is a firm request at a firm price, so there's no reason to
  // wait on escrow the way a negotiable offer has to wait on the price
  // itself being agreed. If the provider declines or doesn't respond in
  // time, this gets refunded automatically (see /respond-offer and
  // src/booking-scheduler.js).
  let escrow = null;
  const deadlineLabel = new Date(responseDeadline).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });

  // This app's booking form uses free-text time slots ("Morning (8–12pm)",
  // "10:00 AM"), not precise start/end timestamps — so there's no reliable
  // way to detect a genuine minute-by-minute schedule conflict the way a
  // real calendar system would. What IS reliably checkable: whether this
  // provider already has another active or pending job on the exact same
  // date. Rather than silently letting a provider get double-booked with
  // no warning, that's surfaced directly in the notification so they can
  // make an informed accept/decline decision instead of finding out later.
  const sameDayConflict = await db.find('contracts', c =>
    c.id !== contract.id && c.providerId === providerId && c.date === date &&
    ['active', 'pending_provider_confirmation', 'pending_agreement'].includes(c.status)
  );
  const conflictNote = sameDayConflict ? ` Note: you already have another job on ${date} — double check your schedule before confirming.` : '';

  if (isNegotiable) {
    await notify(providerId, '🤝', `${customer ? customer.name : 'A customer'} sent an offer of $${contract.amount} for "${contract.service}" — respond by ${deadlineLabel} or it expires automatically.${conflictNote}`, null, { section: 'bookings' });
  } else {
    escrow = await fundEscrowForContract(contract, req.user.sub, payCurrency);
    const goodsNote = basket.items.length ? ` It includes ${basket.items.reduce((n, i) => n + i.qty, 0)} good${basket.items.reduce((n, i) => n + i.qty, 0) === 1 ? '' : 's'} from your store ($${goodsTotal}); they are held for this customer.` : ''; // v106
    await notify(providerId, '📋', `${customer ? customer.name : 'A customer'} booked you for "${contract.service}" on ${date} — confirm by ${deadlineLabel} or the booking is automatically cancelled and refunded.${goodsNote}${conflictNote}`, null, { section: 'bookings' });
  }
  res.status(201).json({ contract, escrow, sameDayConflict: !!sameDayConflict });
});

// POST /api/contracts/:id/respond-offer — provider accepts or declines a
// pending booking: either a Mutual Agreement offer (pending_agreement) or
// a direct booking awaiting confirmation (pending_provider_confirmation).
// For an offer, accepting is the moment the fund amount becomes agreed and
// escrow gets funded at exactly that number. For a direct booking, escrow
// is already funded (see POST /contracts above) — accepting just confirms
// a human on the provider's side actually agreed to do the job; declining
// refunds it, same as a cancellation.
router.post('/contracts/:id/respond-offer', requireAuth, requireRole('provider'), requireCurrentTerms, async (req, res) => {
  if (contractStatusLocks.has(req.params.id)) {
    return res.status(409).json({ error: 'This booking is already being updated — please try again in a moment.' });
  }
  contractStatusLocks.add(req.params.id);
  try {
    return await handleRespondOffer(req, res);
  } finally {
    contractStatusLocks.delete(req.params.id);
  }
});

async function handleRespondOffer(req, res) {
  const { decision } = req.body || {};
  if (!['accept', 'decline'].includes(decision)) return res.status(400).json({ error: 'decision must be accept or decline' });
  const contract = await db.find('contracts', c => c.id === req.params.id && c.providerId === req.user.sub);
  if (!contract) return res.status(404).json({ error: 'Offer not found' });
  if (!['pending_agreement', 'pending_provider_confirmation'].includes(contract.status)) {
    return res.status(400).json({ error: `This booking is already ${contract.status} and can't be responded to again` });
  }

  // Lazy safety net: the scheduled sweep (src/booking-scheduler.js) should
  // have already caught this, but if it somehow hasn't run yet, don't let
  // a provider accept something past its own deadline — expire it right
  // now instead, with the same refund treatment.
  if (contract.providerResponseDeadline && new Date(contract.providerResponseDeadline) < new Date()) {
    const { expireOneBooking } = require('../booking-scheduler');
    await expireOneBooking(contract);
    return res.status(400).json({ error: 'The response window for this booking has already passed — it was automatically cancelled and refunded.' });
  }

  // Three real shapes share this endpoint: a negotiable Mutual Agreement
  // offer (pending_agreement, escrow funded on accept), a direct booking
  // (pending_provider_confirmation with no jobId, escrow already funded at
  // booking time), and a job-board hire (pending_provider_confirmation
  // WITH a jobId, escrow also already funded at selection time — see
  // POST /jobs/:id/select-provider). The job-board case is the only one
  // with real fallback candidates to reassign to if it falls through.
  const isJobSelection = contract.status === 'pending_provider_confirmation' && !!contract.jobId;
  const isDirectBooking = contract.status === 'pending_provider_confirmation' && !contract.jobId;

  if (decision === 'decline') {
    if (isDirectBooking || isJobSelection) {
      // Escrow was already funded at booking/selection time — declining
      // refunds it, same treatment as a cancellation.
      const escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
      if (escrow) await db.update('escrowTransactions', escrow.id, { status: 'refunded' });
    }
    const updated = await db.update('contracts', contract.id, { status: 'declined' });
    await proStore.giveBackStock(contract); // v105: goods go back on the shelf

    if (isJobSelection) {
      const job = await db.find('jobs', j => j.id === contract.jobId);
      if (job) await attemptJobReassignment(job, contract.providerId, contract.amount);
      return res.json({ contract: updated, escrow: null });
    }

    const provider = await db.find('users', u => u.id === req.user.sub);
    if (contract.delivery) { // v108: a driver said no to a delivery
      await require('../store-orders').deliveryEvent(contract, 'declined');
      return res.json({ contract: updated, escrow: null });
    }
    await notify(contract.customerId, '❌', `${provider ? provider.name : 'The provider'} can't take "${contract.service}" and declined the booking. Any held funds have been refunded — try another provider.`, null, { section: 'bookings' });
    return res.json({ contract: updated, escrow: null });
  }

  const acceptingProvider = await db.find('users', u => u.id === req.user.sub);
  if (acceptingProvider && acceptingProvider.onHold) {
    return res.status(403).json({ error: 'Your account is temporarily paused pending a quick review — you\'ll be able to accept new jobs again shortly. Contact support if you need this resolved sooner.' });
  }
  if (acceptingProvider && LICENSED_TRADE_CATEGORIES.has(acceptingProvider.category) && !hasValidLicense(acceptingProvider)) {
    return res.status(403).json({ error: `${acceptingProvider.category} requires a current, verified license on file before you can accept jobs — add your license expiry date in Settings.` });
  }

  const updated = await db.update('contracts', contract.id, { status: 'active', signedAt: new Date().toISOString().slice(0, 10) });
  let escrow;
  if (isDirectBooking) {
    // Already funded at booking time — but the materials advance was
    // deliberately held back until now (see fundEscrowForContract). This
    // is the actual confirmation moment, so release it now if one exists.
    escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
    if (escrow && escrow.materialsAdvanceAmount > 0 && !escrow.materialsAdvanceReleased) {
      await db.update('escrowTransactions', escrow.id, { materialsAdvanceReleased: true });
      escrow = { ...escrow, materialsAdvanceReleased: true };
    }
  } else if (isJobSelection) {
    // Already funded at selection time — this is the actual confirmation
    // moment. This is also the real "job's filled" moment: only now do
    // the other candidates who responded actually get dismissed.
    escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
    const match = await db.find('matches', m => m.jobId === contract.jobId && m.providerId === contract.providerId);
    const job = await db.find('jobs', j => j.id === contract.jobId);
    if (job) await finalizeJobSelection(job, match ? match.id : null);
  } else {
    escrow = await fundEscrowForContract(updated, contract.customerId, contract.payCurrency); // negotiable offer funds now, at the agreed number — pass the freshly-updated contract (status: 'active'), not the stale pre-update object
  }
  const confirmMessage = (isDirectBooking || isJobSelection)
    ? `Your booking for "${contract.service}" was confirmed by the provider.`
    : `Your offer of $${contract.amount} for "${contract.service}" was accepted — escrow funded, booking confirmed.`;
  if (contract.delivery) await require('../store-orders').deliveryEvent(contract, 'accepted'); // v108: tells the customer and the seller
  else await notify(contract.customerId, '🤝', confirmMessage, null, { section: 'bookings' });
  res.json({ contract: updated, escrow });
}

// GET /api/contracts/mine — works for both customers and providers
router.get('/contracts/mine', requireAuth, async (req, res) => {
  const field = req.user.role === 'provider' ? 'providerId' : 'customerId';
  const contracts = await db.filter('contracts', c => c[field] === req.user.sub);
  const withNames = await Promise.all(contracts.map(async c => {
    const customer = await db.find('users', u => u.id === c.customerId);
    const provider = await db.find('users', u => u.id === c.providerId);
    const escrow = await db.find('escrowTransactions', e => e.contractId === c.id);
    const reviewed = !!(await db.find('reviews', r => r.contractId === c.id));
    return { ...c, customerName: customer ? customer.name : 'Customer', providerName: provider ? provider.name : 'Provider', escrow, reviewed };
  }));
  res.json({ contracts: withNames });
});

// GET /api/contracts/:id/pdf — a real, downloadable record of the contract,
// meant to actually work if someone needs to hand it to a lawyer or a court
// over a dispute — not a screenshot, and not a bare data dump either. That
// means: a plain-language declaration of what the document is, full
// identification of both parties, a real chronological timeline (not just
// a snapshot), a short explanation of how Trothen's escrow/dispute process
// works (a reader outside the platform won't know this), the review if one
// exists, and a verification ID so the document can't be casually altered
// without it being obvious.
router.get('/contracts/:id/pdf', requireAuth, async (req, res) => {
  const contract = await db.find('contracts', c =>
    c.id === req.params.id && (c.customerId === req.user.sub || c.providerId === req.user.sub || req.user.role === 'admin')
  );
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  const customer = await db.find('users', u => u.id === contract.customerId);
  const provider = await db.find('users', u => u.id === contract.providerId);
  const escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
  const dispute = await db.find('disputes', d => d.contractId === contract.id);
  const review = await db.find('reviews', r => r.contractId === contract.id);

  const PDFDocument = require('pdfkit');
  const path = require('path');
  const fs = require('fs');
  const crypto = require('crypto');
  const logoPath = path.join(__dirname, '..', 'assets', 'trothen-logo.png');

  const doc = new PDFDocument({ size: 'LETTER', margin: 0, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Trothen-Contract-${contract.bookingNumber || contract.id}.pdf"`);
  doc.pipe(res);

  const navy = '#12161F';
  const slate = '#5A5F6C';
  const gold = '#B08A3E';
  const cream = '#F5F3ED';
  const pageWidth = 612; // LETTER width in points
  const pageBottom = 700; // leave room for the footer below this
  const margin = 56;
  const contentWidth = pageWidth - margin * 2;
  const generatedAt = new Date();

  // A short, stable checksum tying this document's content to a specific
  // moment — not cryptographic proof of anything, but enough that a
  // casually altered copy (a changed amount, a swapped name) won't match
  // if someone checks it against Trothen's own records.
  const verificationId = crypto.createHash('sha256')
    .update(`${contract.id}|${contract.status}|${contract.amount}|${escrow ? escrow.status : 'none'}|${generatedAt.toISOString()}`)
    .digest('hex').slice(0, 16).toUpperCase();

  function drawLetterhead() {
    doc.rect(0, 0, pageWidth, 118).fill(navy);
    if (fs.existsSync(logoPath)) doc.image(logoPath, margin, 28, { width: 56, height: 56 });
    doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold').text('TROTHEN', margin + 70, 36);
    doc.fillColor(gold).fontSize(10).font('Helvetica-Bold').text('SERVICE CONTRACT & ESCROW RECORD', margin + 70, 62, { characterSpacing: 1.2 });
    doc.fillColor('#B7BAC2').fontSize(8.5).font('Helvetica').text('AI-Matched · Identity-Verified · Escrow-Protected', margin + 70, 78);
    doc.fillColor('#B7BAC2').fontSize(8).font('Helvetica').text(`Generated ${generatedAt.toLocaleString('en-US')}`, margin, 96, { width: contentWidth - 140 });
    doc.fillColor('#FFFFFF').fontSize(13).font('Helvetica-Bold').text(`#${contract.bookingNumber || contract.id}`, pageWidth - margin - 150, 90, { width: 150, align: 'right' });
  }

  function drawContinuationHeader() {
    doc.fillColor(slate).fontSize(8).font('Helvetica-Bold').text(`TROTHEN — CONTRACT #${contract.bookingNumber || contract.id} (CONTINUED)`, margin, 32, { characterSpacing: 0.5 });
    doc.strokeColor('#D8D3C8').lineWidth(0.5).moveTo(margin, 48).lineTo(pageWidth - margin, 48).stroke();
  }

  let y;
  drawLetterhead();
  y = 148;

  // Ensures a section never gets split awkwardly across a page break — if
  // there isn't room left for what's coming, start a fresh page first.
  function ensureSpace(neededHeight) {
    if (y + neededHeight > pageBottom) {
      doc.addPage();
      drawContinuationHeader();
      y = 66;
    }
  }

  function sectionHeader(title) {
    ensureSpace(50);
    doc.rect(margin, y, contentWidth, 20).fill(cream);
    doc.fillColor(navy).fontSize(10).font('Helvetica-Bold').text(title.toUpperCase(), margin + 10, y + 5, { characterSpacing: 0.8 });
    y += 30;
  }

  function row(label, value) {
    ensureSpace(38);
    doc.fillColor(slate).fontSize(8.5).font('Helvetica-Bold').text(label.toUpperCase(), margin, y, { characterSpacing: 0.4 });
    doc.fillColor(navy).fontSize(11.5).font('Helvetica').text(value || '—', margin, y + 12, { width: contentWidth });
    y += 38;
  }

  function twoColumnRow(labelA, valueA, labelB, valueB) {
    ensureSpace(38);
    const colWidth = contentWidth / 2 - 10;
    doc.fillColor(slate).fontSize(8.5).font('Helvetica-Bold').text(labelA.toUpperCase(), margin, y, { characterSpacing: 0.4 });
    doc.fillColor(navy).fontSize(11.5).font('Helvetica').text(valueA || '—', margin, y + 12, { width: colWidth });
    doc.fillColor(slate).fontSize(8.5).font('Helvetica-Bold').text(labelB.toUpperCase(), margin + colWidth + 20, y, { characterSpacing: 0.4 });
    doc.fillColor(navy).fontSize(11.5).font('Helvetica').text(valueB || '—', margin + colWidth + 20, y + 12, { width: colWidth });
    y += 38;
  }

  function paragraph(text, opts = {}) {
    const height = doc.heightOfString(text, { width: contentWidth, lineGap: 2 });
    ensureSpace(height + 8);
    doc.fillColor(opts.color || slate).fontSize(opts.size || 9).font(opts.font || 'Helvetica').text(text, margin, y, { width: contentWidth, lineGap: 2 });
    y += height + (opts.gapAfter ?? 10);
  }

  // ── OPENING DECLARATION ─────────────────────────────────────────────────
  // States plainly, in the first thing anyone reads, what this document is
  // and what it's for — a lawyer or clerk unfamiliar with Trothen should not
  // have to guess.
  paragraph(
    `This document certifies the terms and current status of a service engagement facilitated through the Trothen platform between the customer and service provider identified below. It is generated on request directly from Trothen's records and reflects the state of the booking as of the date and time shown above.`,
    { color: navy, size: 9.5, gapAfter: 14 }
  );

  sectionHeader('Booking Summary');
  twoColumnRow('Booking Number', contract.bookingNumber || contract.id, 'Current Status', contract.status.charAt(0).toUpperCase() + contract.status.slice(1));
  row('Internal Reference ID', contract.id);

  sectionHeader('Parties to This Agreement');
  row('Customer', customer
    ? `${customer.name}  ·  ${customer.email}${customer.phone ? '  ·  ' + customer.phone : ''}${customer.city ? '  ·  ' + customer.city + (customer.country ? ', ' + customer.country : '') : ''}`
    : 'Account no longer available');
  row('Service Provider', provider
    ? `${provider.name}  ·  ${provider.email}${provider.phone ? '  ·  ' + provider.phone : ''}${provider.city ? '  ·  ' + provider.city + (provider.country ? ', ' + provider.country : '') : ''}`
    : 'Account no longer available');

  sectionHeader('Service Details');
  row('Service Requested', contract.service);
  if (contract.date) row('Scheduled Date & Time', `${contract.date}${contract.time ? '  ·  ' + contract.time : ''}`);
  if (contract.address) row('Service Address', contract.address);
  // v96: for places with no street address, the agreement names the spot.
  if (contract.landmark && contract.landmark !== contract.address) row('Landmark', contract.landmark);
  if (contract.jobLocation && typeof contract.jobLocation.latitude === 'number') {
    const A = '23456789CFGHJMPQRVWX';
    let a = Math.floor((Math.min(Math.max(contract.jobLocation.latitude, -90), 90 - 1e-9) + 90) * 8000);
    let b = Math.floor(((((contract.jobLocation.longitude + 180) % 360) + 360) % 360) * 8000);
    let code = '';
    for (let i = 0; i < 5; i++) { code = A[a % 20] + A[b % 20] + code; a = Math.floor(a / 20); b = Math.floor(b / 20); }
    row('Location pin', `Plus Code ${code.slice(0, 8)}+${code.slice(8)}  (${contract.jobLocation.latitude}, ${contract.jobLocation.longitude})`);
  }
  twoColumnRow('Agreed Amount (USD)', `$${contract.amount}`, 'Contract Signed', contract.signedAt || new Date(contract.createdAt).toLocaleDateString());
  // v105: goods bought from the pro's store as part of this booking.
  if (Array.isArray(contract.storeItems) && contract.storeItems.length) {
    sectionHeader('Goods From the Pro\'s Store');
    for (const i of contract.storeItems) row(String(i.name).slice(0, 80), `${i.qty} x $${Number(i.unitPrice).toFixed(2)}${i.unit ? ' per ' + i.unit : ''}  =  $${Number(i.lineTotal).toFixed(2)}`);
    twoColumnRow('Goods Total', `$${Number(contract.storeGoodsTotal || 0).toFixed(2)}`, contract.goodsOnly ? 'Job' : 'Job Amount', contract.goodsOnly ? 'Goods only, no job' : `$${Number(contract.laborAmount || 0).toFixed(2)}`);
    row('Store Purchase Fee', `$${Number(contract.storeFee || 0).toFixed(2)} (a flat fee to Trothen, paid by ${contract.storeFeePaidBy === 'pro' ? 'the pro out of the goods money' : 'the customer'}; no commission is taken on goods)`);
  }
  if (contract.handover && ((contract.handover.pickup || []).length || (contract.handover.dropoff || []).length)) {
    sectionHeader('Pick-up and Drop-off Record');
    const who = (e) => e.by === 'provider' ? 'the pro' : 'the customer';
    const where = (e) => e.location ? `  ·  at ${e.location.latitude}, ${e.location.longitude}` : '  ·  no location recorded';
    for (const e of (contract.handover.pickup || [])) row('Pick-up', `${new Date(e.at).toLocaleString('en-US')}  ·  ${e.photoUrls.length} photo${e.photoUrls.length === 1 ? '' : 's'} by ${who(e)}${where(e)}${e.note ? '  ·  ' + e.note : ''}`);
    for (const e of (contract.handover.dropoff || [])) row('Drop-off', `${new Date(e.at).toLocaleString('en-US')}  ·  ${e.photoUrls.length} photo${e.photoUrls.length === 1 ? '' : 's'} by ${who(e)}${where(e)}${e.note ? '  ·  ' + e.note : ''}`);
    if ((contract.handover.trail || []).length > 1) row('Route recorded', `${contract.handover.trail.length} positions from the pro's phone between pick-up and drop-off`);
  }

  sectionHeader('Escrow & Payment');
  if (escrow) {
    twoColumnRow('Escrow Amount (USD)', `$${escrow.amount}`, 'Escrow Status', escrow.status.charAt(0).toUpperCase() + escrow.status.slice(1));
    if (escrow.materialsAdvanceAmount > 0) {
      twoColumnRow('Materials Advance', `$${escrow.materialsAdvanceAmount} (released ${escrow.materialsAdvanceReleased ? 'immediately upon booking' : 'pending'})`, 'Remaining Held in Escrow', `$${(escrow.amount - escrow.materialsAdvanceAmount).toFixed(2)}`);
    }
    // Real local-currency payment record, when the customer chose to pay
    // in their own currency rather than USD — the USD figure above always
    // stays the accounting figure of record; this shows what the customer
    // actually paid.
    if (escrow.paidCurrency && escrow.paidCurrency !== 'USD' && escrow.paidAmountLocal) {
      row('Amount Charged to Customer', `${escrow.paidAmountLocal} ${escrow.paidCurrency}  (${escrow.exchangeRateNote || 'converted at time of payment'})`);
    }
  } else {
    row('Escrow Status', 'No escrow was funded for this booking — see status above');
  }

  // ── NEGOTIATION RECORD ────────────────────────────────────────────────
  // Only present for jobs where the customer picked a provider out of
  // several who responded to an open job post — a snapshot of the actual
  // chat that led to this price and terms, taken at the moment the
  // customer hired this provider (see POST /jobs/:id/select-provider).
  // Frozen at that point on purpose: later messages between the same two
  // people (about a different job, or just chit-chat) shouldn't quietly
  // become part of this contract's record.
  if (Array.isArray(contract.negotiationTranscript) && contract.negotiationTranscript.length) {
    sectionHeader('Negotiation Record');
    paragraph(
      `The messages below were exchanged between the customer and provider before this booking was confirmed, and are preserved here exactly as sent — this is the actual conversation that led to the terms above, not a summary.`,
      { gapAfter: 10 }
    );
    for (const msg of contract.negotiationTranscript) {
      const who = msg.from === 'customer' ? (customer ? customer.name : 'Customer') : (provider ? provider.name : 'Provider');
      const when = new Date(msg.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      row(`${who} — ${when}`, msg.text);
    }
  }

  // ── TIMELINE ─────────────────────────────────────────────────────────────
  // A dispute or legal review cares about sequence as much as current
  // state — when was this actually booked, completed, contested. Built
  // only from events that genuinely happened for this contract, never a
  // fabricated or assumed step.
  const timelineEvents = [];
  timelineEvents.push({ date: new Date(contract.createdAt), label: 'Booking created and contract formed' });
  if (escrow) timelineEvents.push({ date: new Date(escrow.createdAt), label: `Escrow funded ($${escrow.amount})` });
  if (contract.onMyWayAt) timelineEvents.push({ date: new Date(contract.onMyWayAt), label: `Provider marked on the way${contract.onMyWayLocation ? ' (GPS location recorded)' : ''}` });
  if (contract.arrivedAt) timelineEvents.push({ date: new Date(contract.arrivedAt), label: `Provider marked arrived${contract.arrivedLocation ? ' (GPS location recorded)' : ''}` });
  if (dispute) timelineEvents.push({ date: new Date(dispute.createdAt), label: `Dispute opened: "${dispute.reason}"` });
  if (dispute && dispute.status === 'resolved') timelineEvents.push({ date: new Date(dispute.resolvedAt || dispute.createdAt), label: 'Dispute resolved and escrow released' });
  if (contract.status === 'completed' && escrow && escrow.status === 'released') timelineEvents.push({ date: generatedAt, label: 'Marked complete — escrow released to provider' });
  timelineEvents.sort((a, b) => a.date - b.date);

  sectionHeader('Timeline');
  for (const ev of timelineEvents) {
    row(ev.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), ev.label);
  }

  if (review) {
    sectionHeader('Customer Review');
    row('Rating Given', `${review.stars} out of 5 stars`);
    if (review.text) row('Review Text', review.text);
  }

  if (dispute) {
    sectionHeader('Dispute Record');
    row('Reason Filed', dispute.reason);
    twoColumnRow('Dispute Status', dispute.status.charAt(0).toUpperCase() + dispute.status.slice(1), 'Opened', new Date(dispute.createdAt).toLocaleDateString());
  }

  // ── HOW ESCROW & DISPUTES WORK ───────────────────────────────────────────
  // Written for a reader who has never used Trothen — a lawyer, a judge, a
  // bank — so the record above makes sense without needing to ask the
  // parties to explain the platform first.
  sectionHeader("How Trothen's Escrow & Dispute Process Works");
  paragraph(
    `Under Trothen's terms of service, payment for a booking is collected from the customer and held in escrow — not released to the provider — until the customer confirms the work was completed. Either party may raise a dispute before that confirmation, which freezes the contract and holds escrow in place pending review. A resolved dispute results in escrow being released to the provider, refunded to the customer, or otherwise apportioned according to Trothen's review of the matter. This structure is designed so that no party is paid, or loses funds, before the outcome of the booking is settled.`,
    { gapAfter: 14 }
  );

  ensureSpace(70);
  doc.strokeColor('#D8D3C8').lineWidth(1).moveTo(margin, y).lineTo(pageWidth - margin, y).stroke();
  y += 16;
  doc.fillColor(navy).fontSize(9).font('Helvetica-Bold').text('RECORD OF AGREEMENT', margin, y, { characterSpacing: 0.6 });
  y += 16;
  paragraph(
    `This contract was formed electronically when both parties confirmed the booking through the Trothen platform, and constitutes the agreement between the customer and provider named above for the service described. No physical signature is required for a Trothen contract to be valid. This printout reflects Trothen's records as of the moment it was generated; the authoritative, continuously updated record remains within Trothen's systems and may be requested again at any time by either party to this agreement.`,
    { size: 8.5 }
  );

  // ── FOOTER (every page) ──────────────────────────────────────────────
  const pageRange = doc.bufferedPageRange();
  for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
    doc.switchToPage(i);
    const footerY = 740;
    doc.strokeColor('#D8D3C8').lineWidth(0.5).moveTo(margin, footerY).lineTo(pageWidth - margin, footerY).stroke();
    doc.fillColor(slate).fontSize(7.5).font('Helvetica').text(
      `Verification ID ${verificationId} · This document is a system-generated record reflecting the state of the contract, escrow, and any dispute at the time of generation. Provided for the parties' own recordkeeping.`,
      margin, footerY + 8, { width: contentWidth - 90 }
    );
    doc.fillColor(slate).fontSize(7.5).font('Helvetica').text(
      `Page ${i - pageRange.start + 1} of ${pageRange.count}`,
      pageWidth - margin - 90, footerY + 8, { width: 90, align: 'right' }
    );
    doc.fillColor(gold).fontSize(7.5).font('Helvetica-Bold').text(require('../platform-settings').supportEmailCached(), margin, footerY + 26); // v95
  }

  doc.end();
});

// POST /api/reviews — leave a review for a completed contract (customer only,
// once per contract). Recomputes the provider's average rating from every
// real review on file, so the rating shown across the app becomes genuine
// customer feedback instead of a static seeded number.
router.post('/reviews', requireAuth, requireRole('customer'), async (req, res) => {
  const { contractId, stars, text, trusted } = req.body || {};
  const errors = validate([
    ['stars', Number.isInteger(stars) && stars >= 1 && stars <= 5, 'Rating must be between 1 and 5 stars'],
    ['text', isNonEmptyString(text, { min: 5, max: 500 }), 'Review must be between 5 and 500 characters'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (trusted !== undefined && trusted !== null && typeof trusted !== 'boolean') {
    return res.status(400).json({ error: 'trusted must be true, false, or omitted' });
  }

  const contract = await db.find('contracts', c => c.id === contractId && c.customerId === req.user.sub);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (contract.status !== 'completed') {
    return res.status(400).json({ error: 'You can only review a job after it is marked complete' });
  }
  const existing = await db.find('reviews', r => r.contractId === contractId);
  if (existing) return res.status(409).json({ error: "You've already reviewed this job" });

  const customer = await db.find('users', u => u.id === req.user.sub);
  const review = {
    id: `rev_${nanoid(10)}`,
    contractId,
    providerId: contract.providerId,
    authorName: customer ? customer.name : 'Customer',
    stars,
    text: text.trim(),
    trusted: trusted === undefined ? null : trusted,
    createdAt: new Date().toISOString(),
  };
  await db.insert('reviews', review);

  // Recompute the provider's average rating from every review on file.
  const allReviews = await db.filter('reviews', r => r.providerId === contract.providerId);
  const avg = allReviews.reduce((s, r) => s + r.stars, 0) / allReviews.length;
  // Trust rate: the real % of customers who answered the trust question
  // and said yes — only counted among reviews that actually answered it
  // (trusted !== null), since this is deliberately optional and an
  // unanswered question shouldn't silently count against (or for)
  // anyone. Feeds into the Trust Score as its own component — see
  // src/provider-score.js.
  const answeredTrust = allReviews.filter(r => r.trusted !== null && r.trusted !== undefined);
  const trustRatePercent = answeredTrust.length ? Math.round((answeredTrust.filter(r => r.trusted).length / answeredTrust.length) * 100) : null;
  await db.update('users', contract.providerId, { rating: Math.round(avg * 10) / 10, trustRatePercent, trustRatingSampleSize: answeredTrust.length });

  await notify(contract.providerId, '⭐', `New ${stars}-star review: "${text.trim().slice(0, 60)}${text.length > 60 ? '…' : ''}"`, null, { section: 'bookings' });
  if (trusted === false) {
    await notify(contract.providerId, '⚠️', `A customer indicated they didn't fully trust you on a recent job. Your trust rate is now ${trustRatePercent}%.`, null, { section: 'verification' });
  }
  const { awardLoyaltyPoint } = require('../loyalty');
  await awardLoyaltyPoint(req.user.sub, 'review');

  res.status(201).json({ review });
});

// POST /api/disputes — customer or provider raises a real dispute against a
// contract they're actually party to. Previously the UI claimed "customer/
// provider-raised disputes" but no such endpoint existed at all — only
// admins could resolve pre-existing (seeded) disputes.
router.post('/disputes', requireAuth, disputeLimiter, async (req, res) => {
  const { contractId, reason } = req.body || {};
  const errors = validate([
    ['contractId', isNonEmptyString(contractId), 'A booking must be selected'],
    ['reason', isNonEmptyString(reason, { min: 10, max: 500 }), 'Describe the issue in at least 10 characters'],
  ]);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const contract = await db.find('contracts', c =>
    c.id === contractId && (c.customerId === req.user.sub || c.providerId === req.user.sub)
  );
  if (!contract) return res.status(404).json({ error: 'Booking not found' });
  if (contract.status === 'disputed') {
    return res.status(409).json({ error: 'There is already an open dispute on this booking' });
  }
  if (contract.status !== 'active') {
    return res.status(400).json({ error: `This booking is ${contract.status} and can no longer be disputed` });
  }
  const existing = await db.find('disputes', d => d.contractId === contractId && d.status !== 'resolved');
  if (existing) return res.status(409).json({ error: 'There is already an open dispute on this booking' });

  const customer = await db.find('users', u => u.id === contract.customerId);
  const provider = await db.find('users', u => u.id === contract.providerId);
  const dispute = {
    id: `dp_${nanoid(10)}`,
    contractId,
    reason: reason.trim(),
    amount: contract.amount,
    status: 'open',
    parties: `${provider ? provider.name : 'Provider'} ↔ ${customer ? customer.name : 'Customer'}`,
    createdAt: new Date().toISOString(),
  };
  await db.insert('disputes', dispute);
  await db.update('contracts', contractId, { status: 'disputed' });

  // Notify whichever party didn't raise the dispute.
  const otherPartyId = req.user.sub === contract.customerId ? contract.providerId : contract.customerId;
  await notify(otherPartyId, '⚠️', `A dispute was opened on "${contract.service}" — our team is reviewing it.`, 'bookingUpdates', { section: 'bookings' });

  // Real fraud/safety screening — checks both parties for an unusual
  // pattern of repeat disputes, not just this one.
  const { checkRapidDisputes } = require('../fraud-detection');
  await checkRapidDisputes(contract.customerId);
  await checkRapidDisputes(contract.providerId);

  res.status(201).json({ dispute });
});

// Item: disputes had no way to actually attach evidence — a photo of bad
// work, a screenshot, a receipt — the dispute team only ever had the
// typed reason to go on. Storage/validation reuse the exact same private,
// magic-byte-verified pattern already used for identity documents (see
// verificationDocStorage in src/routes/misc.routes.js) — evidence is
// just as sensitive as an ID document and gets the same protection.
const disputeEvidenceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, require('../uploads').PRIVATE_UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = file.mimetype === 'application/pdf' ? '.pdf' : (path.extname(file.originalname).toLowerCase() || '.jpg');
    cb(null, `dispute_ev_${req.params.id}_${nanoid(16)}${ext}`);
  },
});
const disputeEvidenceFileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
  if (!allowed.includes(file.mimetype)) return cb(new Error('Evidence must be a JPEG, PNG, or PDF file'));
  cb(null, true);
};
const uploadDisputeEvidence = multer({ storage: disputeEvidenceStorage, fileFilter: disputeEvidenceFileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// Real permission check shared by all three routes below: a caller may
// touch a dispute's evidence only if they're one of its two actual
// parties (customer or provider on the underlying contract), OR they're
// an admin whose department can already see disputes at all
// (disputes/customer_service/legal — the same list GET /admin/disputes
// itself uses — or a super admin). Everyone else gets a flat 404 rather
// than a 403, so a dispute's existence isn't confirmable by a stranger
// probing IDs.
async function canAccessDisputeEvidence(req, dispute) {
  const contract = await db.find('contracts', c => c.id === dispute.contractId);
  if (contract && (contract.customerId === req.user.sub || contract.providerId === req.user.sub)) return true;
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!me || me.role !== 'admin') return false;
  if (me.isSuperAdmin) return true;
  return ['disputes', 'customer_service', 'legal'].includes(me.adminDepartment);
}

// POST /api/disputes/:id/evidence — upload one piece of evidence.
router.post('/disputes/:id/evidence', requireAuth, (req, res, next) => {
  uploadDisputeEvidence.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Evidence upload failed' });
    next();
  });
}, async (req, res) => {
  const dispute = await db.find('disputes', d => d.id === req.params.id);
  const { PRIVATE_UPLOADS_DIR, verifyImageMagicBytes, verifyPdfMagicBytes } = require('../uploads');
  const cleanup = () => { if (req.file) { try { fs.unlinkSync(path.join(PRIVATE_UPLOADS_DIR, req.file.filename)); } catch (e) {} } };
  if (!dispute) { cleanup(); return res.status(404).json({ error: 'Dispute not found' }); }
  if (!(await canAccessDisputeEvidence(req, dispute))) { cleanup(); return res.status(404).json({ error: 'Dispute not found' }); }
  if (!req.file) return res.status(400).json({ error: 'A file is required' });

  const filePath = path.join(PRIVATE_UPLOADS_DIR, req.file.filename);
  const bytesValid = req.file.mimetype === 'application/pdf' ? verifyPdfMagicBytes(filePath) : verifyImageMagicBytes(filePath, req.file.mimetype);
  if (!bytesValid) { cleanup(); return res.status(400).json({ error: "That file doesn't look like a genuine document of the type it claims to be — please re-upload" }); }

  const uploader = await db.find('users', u => u.id === req.user.sub);
  // v83: evidence gets the same optional encryption as ID files.
  const evidenceEncrypted = require('../file-crypto').isEnabled()
    ? require('../file-crypto').encryptFileInPlace(path.join(PRIVATE_UPLOADS_DIR, req.file.filename)) : false;
  const record = {
    encrypted: evidenceEncrypted,
    id: `dpev_${nanoid(10)}`,
    disputeId: dispute.id,
    uploadedBy: req.user.sub,
    uploadedByName: uploader ? uploader.name : 'Unknown',
    filename: req.file.filename,
    originalName: (req.file.originalname || 'evidence').slice(0, 200),
    mimeType: req.file.mimetype,
    createdAt: new Date().toISOString(),
  };
  await db.insert('disputeEvidence', record);

  // Whoever didn't upload this gets told something was added — the same
  // "the other side should know" pattern the dispute notification itself
  // already uses.
  const contract = await db.find('contracts', c => c.id === dispute.contractId);
  if (contract) {
    const otherPartyId = req.user.sub === contract.customerId ? contract.providerId : contract.customerId;
    await notify(otherPartyId, '📎', `New evidence was added to the dispute on "${contract.service}".`, 'bookingUpdates', { section: 'bookings' });
  }
  const { uploadedBy, ...publicRecord } = record;
  res.status(201).json({ evidence: publicRecord });
});

// GET /api/disputes/:id/evidence — list, metadata only (no raw file
// bytes here — see the dedicated download route below for that).
router.get('/disputes/:id/evidence', requireAuth, async (req, res) => {
  const dispute = await db.find('disputes', d => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
  if (!(await canAccessDisputeEvidence(req, dispute))) return res.status(404).json({ error: 'Dispute not found' });
  const list = (await db.filter('disputeEvidence', e => e.disputeId === dispute.id))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(({ uploadedBy, ...rest }) => rest);
  res.json({ evidence: list });
});

// GET /api/disputes/:id/evidence/:evidenceId/file — the actual file.
router.get('/disputes/:id/evidence/:evidenceId/file', requireAuth, async (req, res) => {
  const dispute = await db.find('disputes', d => d.id === req.params.id);
  if (!dispute) return res.status(404).json({ error: 'Dispute not found' });
  if (!(await canAccessDisputeEvidence(req, dispute))) return res.status(404).json({ error: 'Dispute not found' });
  const record = await db.find('disputeEvidence', e => e.id === req.params.evidenceId && e.disputeId === dispute.id);
  if (!record) return res.status(404).json({ error: 'Evidence not found' });
  const { PRIVATE_UPLOADS_DIR } = require('../uploads');
  const filePath = path.join(PRIVATE_UPLOADS_DIR, path.basename(String(record.filename)));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File is missing on disk' });
  // v83: decrypted if it was stored encrypted; never cached; type taken
  // from what was recorded at upload, limited to the three allowed kinds.
  let buf;
  try { buf = require('../file-crypto').readPossiblyEncrypted(filePath); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  const type = ['image/jpeg', 'image/png', 'application/pdf'].includes(record.mimeType) ? record.mimeType : 'application/octet-stream';
  res.set('Cache-Control', 'no-store, private');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', type);
  res.send(buf);
});

module.exports = router;
// Attached rather than replacing the export — a router is a function, so
// it can carry extra named properties without affecting its use as
// Express middleware. Lets src/provider-score.js reuse the exact same
// license-validity rule instead of a second, possibly-drifting copy of it.
module.exports.LICENSED_TRADE_CATEGORIES = LICENSED_TRADE_CATEGORIES;
module.exports.hasValidLicense = hasValidLicense;
module.exports.publicProvider = publicProvider;
// Lets src/booking-scheduler.js trigger the same automatic-reassignment
// logic when a job-originated hire expires unconfirmed, not just when it's
// actively declined — one real implementation, not two copies that could
// drift apart.
module.exports.attemptJobReassignment = attemptJobReassignment;
// v108: store orders are made in src/routes/orders.routes.js with the same
// booking number, payment hold and location rules as every other booking.
module.exports.generateBookingNumber = generateBookingNumber;
module.exports.fundEscrowForContract = fundEscrowForContract;
module.exports.readJobLocation = readJobLocation;
