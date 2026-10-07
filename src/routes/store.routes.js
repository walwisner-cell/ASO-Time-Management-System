// v105: the pro store, extra skills, and pick-up / drop-off records.
// See src/store.js for the rules in plain words.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { notify } = require('../notify');
const { UPLOADS_DIR, PRIVATE_UPLOADS_DIR, verifyImageMagicBytes, verifyPdfMagicBytes } = require('../uploads');
const { isNonEmptyString, looksLikeRealText } = require('../validators');
const { adminScopeFor, regionalAdminsFor } = require('../admin-scope');
const store = require('../store');
const { money } = store;

const router = express.Router();

// ── Shared bits ────────────────────────────────────────────────────────
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
function photoUploader(prefix) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOADS_DIR),
      filename: (req, file, cb) => cb(null, `${prefix}_${req.user.sub}_${nanoid(12)}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
    }),
    fileFilter: (req, file, cb) => IMAGE_TYPES.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG, PNG, WEBP or GIF photos are allowed')),
    limits: { fileSize: MAX_PHOTO_BYTES },
  });
}
function handlePhotoUpload(uploader, req, res) {
  uploader.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too big. The limit is 12MB.' : (err.message || 'Upload failed') });
    if (!req.file) return res.status(400).json({ error: 'No photo was provided' });
    if (!fs.existsSync(req.file.path)) return res.status(500).json({ error: 'The photo could not be saved. Please try again.' });
    // The real bytes are checked, not what the upload claimed to be.
    if (!verifyImageMagicBytes(req.file.path, req.file.mimetype)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'This file does not appear to be a real photo. Please choose a photo.' });
    }
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
}
const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many photos in a short time. Please wait a few minutes.' } });

// Only our own uploaded photos, and only ones this person uploaded.
function cleanPhotoUrls(urls, prefix, userId, max) {
  if (urls === undefined || urls === null) return [];
  if (!Array.isArray(urls) || urls.length > max) return null;
  const re = new RegExp(`^/uploads/${prefix}_${String(userId).replace(/[^\w-]/g, '')}_[\\w-]+\\.(jpe?g|png|webp|gif)$`, 'i');
  const out = [];
  for (const u of urls) { if (typeof u !== 'string' || !re.test(u)) return null; if (!out.includes(u)) out.push(u); }
  return out;
}

// Goods that can never be sold here. This is a first net; a manager still
// looks at every good before it goes live.
const BANNED_GOODS = [
  [/\b(gun|guns|firearm|pistol|rifle|ammunition|ammo|bullets?|explosives?|grenade)\b/i, 'weapons'],
  [/\b(cocaine|heroin|meth|methamphetamine|marijuana|cannabis|weed|narcotics?|tramadol|codeine|opioids?)\b/i, 'drugs'],
  [/\b(prescription|antibiotics?|injections?|syringes?)\b/i, 'medicines'],
  [/\b(beer|wine|whisk(e)?y|vodka|gin|rum|liquor|alcohol|cane juice|palm wine)\b/i, 'alcohol'],
  [/\b(cigarettes?|tobacco|vapes?|cigars?|shisha)\b/i, 'tobacco'],
  [/\b(counterfeit|fake (id|passport|licen[cs]e|certificate)|replica (watch|bag))\b/i, 'counterfeit goods'],
  [/\b(ivory|bush ?meat|pangolin)\b/i, 'protected wildlife'],
];
function bannedGoodReason(text) {
  for (const [re, why] of BANNED_GOODS) if (re.test(String(text || ''))) return why;
  return null;
}
// v106: the built-in list, then any extra words the super admin has added.
async function bannedReason(...texts) {
  const all = texts.filter(Boolean).join(' \n ');
  const builtIn = bannedGoodReason(all);
  if (builtIn) return builtIn;
  const { bannedWords } = await store.storeSettings();
  const lower = all.toLowerCase();
  for (const w of bannedWords) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(lower)) return `"${w}"`;
  }
  return null;
}

async function freshUser(req) { return db.find('users', u => u.id === req.user.sub); }
// What the pro's own page is told about an extra skill: never the file name.
function publicSkill(s) {
  return { category: s.category, status: s.status, requestedAt: s.requestedAt || null, decidedAt: s.decidedAt || null, hasLicence: !!s.licenceFile, licenceExpiry: s.licenceExpiry || null };
}

// ── THE PRO'S OWN STORE ────────────────────────────────────────────────
function goodForOwner(g, currencies) {
  return {
    id: g.id, name: g.name, description: g.description || '', ...store.goodPriceFields(g, currencies), unit: g.unit || '', photoUrls: g.photoUrls || [],
    stock: g.stock === undefined ? null : g.stock, lowStockAt: g.lowStockAt === undefined ? null : g.lowStockAt, costPrice: g.costPrice === undefined ? null : g.costPrice,
    forSale: g.forSale !== false, hidden: g.hidden === true, status: g.status, reviewNote: g.reviewNote || null, reviewedAt: g.reviewedAt || null,
    sold: g.sold || 0, stockLog: (g.stockLog || []).slice(-10), createdAt: g.createdAt, updatedAt: g.updatedAt || null,
  };
}
function goodForShopper(g, currencies) {
  return {
    id: g.id, name: g.name, description: g.description || '', ...store.goodPriceFields(g, currencies), unit: g.unit || '', photoUrls: g.photoUrls || [],
    soldOut: !store.inStock(g, 1), left: (g.stock !== null && g.stock !== undefined && g.stock <= 5) ? g.stock : null,
  };
}

// GET /api/store/mine
router.get('/store/mine', requireAuth, requireRole('provider'), async (req, res) => {
  const me = await freshUser(req);
  const goods = (await db.filter('storeGoods', g => g.providerId === req.user.sub)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const settings = await store.storeSettings();
  const currencies = await store.currenciesFor(me);
  res.json({
    store: me.store || null,
    live: store.storeIsLive(me),
    // v108: the manager's decision on the store itself, why it isn't showing, and its options
    approval: me.store && me.store.name ? { status: store.storeApproval(me), note: (me.store.approval && me.store.approval.note) || null } : null,
    whyNotLive: store.whyNotLive(me),
    options: store.storeOptions(me),
    currencies,
    goods: goods.map(g => goodForOwner(g, currencies)),
    settings: { enabled: settings.enabled, purchaseFee: settings.purchaseFee, maxGoodsPerStore: settings.maxGoodsPerStore, feePaidBy: settings.feePaidBy, deliveryFeePercent: settings.deliveryFeePercent },
    rules: { text: settings.rulesText, version: settings.rulesVersion, agreed: !!(me.store && me.store.rulesVersion === settings.rulesVersion), agreedAt: (me.store && me.store.rulesAgreedAt) || null },
    verified: me.verified === true,
  });
});

// PUT /api/store/mine  { name, description, open }
router.put('/store/mine', requireAuth, requireRole('provider'), async (req, res) => {
  const me = await freshUser(req);
  const { name, description, open, agreeRules, options } = req.body || {};
  const settings = await store.storeSettings();
  if (!isNonEmptyString(name, { min: 3, max: 60 }) || !looksLikeRealText(name)) return res.status(400).json({ error: 'Give your store a name of 3 to 60 characters' });
  if (description !== undefined && description !== null && description !== '' && !isNonEmptyString(description, { max: 300 })) return res.status(400).json({ error: 'The store description must be under 300 characters' });
  const banned = await bannedReason(name, description);
  if (banned) return res.status(400).json({ error: `A store can't be about ${banned}. That can't be sold on Trothen.` });
  const prev = me.store || {};
  // v106: a store can only be open once the pro has agreed to the current store rules.
  const alreadyAgreed = prev.rulesVersion === settings.rulesVersion;
  if (open === true && !alreadyAgreed && agreeRules !== true) {
    return res.status(400).json({ code: 'AGREE_STORE_RULES', error: 'Please read and agree to the store rules before opening your store.', rules: { text: settings.rulesText, version: settings.rulesVersion } });
  }
  if (open === true && prev.closedByAdmin) return res.status(403).json({ error: `Your store was closed by the Trothen team${prev.closedReason ? ': ' + prev.closedReason : ''}. Contact support to reopen it.` });
  const next = {
    ...prev,
    name: name.trim(), description: description ? String(description).trim() : '',
    open: open === true,
    createdAt: prev.createdAt || new Date().toISOString(),
    liveGoods: prev.liveGoods || 0,
  };
  if (agreeRules === true && !alreadyAgreed) { next.rulesVersion = settings.rulesVersion; next.rulesAgreedAt = new Date().toISOString(); }
  // v108: store options. Only what was sent is changed.
  if (options !== undefined) {
    const r = readStoreOptions(options, store.storeOptions(me));
    if (r.error) return res.status(400).json({ error: r.error });
    const bannedOpt = await bannedReason(r.out.pickupPlace, r.out.orderNote, r.out.hours);
    if (bannedOpt) return res.status(400).json({ error: `That wording can't be used (${bannedOpt}).` });
    next.options = r.out;
  }
  // v108: a manager approves the store itself. A new store, or one whose
  // name or description changed, waits for that. Switching it on or off,
  // or changing options, does not send it back.
  const wordsChanged = next.name !== (prev.name || '') || next.description !== (prev.description || '');
  const hadDecision = prev.approval && ['approved', 'rejected', 'pending'].includes(prev.approval.status);
  let askManagers = false;
  // A store that was turned down is looked at again whenever the pro saves it.
  if (!hadDecision || wordsChanged || prev.approval.status === 'rejected') {
    askManagers = !hadDecision || prev.approval.status !== 'pending'; // not told twice while it is already waiting
    next.approval = { status: 'pending', askedAt: new Date().toISOString(), note: null };
  }
  await db.update('users', me.id, { store: next });
  await store.refreshStoreLive(me.id);
  if (askManagers) await tellManagersAboutStore(me, next);
  const after = await freshUser(req);
  res.json({ store: after.store, live: store.storeIsLive(after), approval: { status: store.storeApproval(after), note: (after.store.approval && after.store.approval.note) || null }, whyNotLive: store.whyNotLive(after), options: store.storeOptions(after) });
});

// v108: reads the store options a pro sent. `cur` is what is saved now.
function readStoreOptions(o, cur) {
  if (!o || typeof o !== 'object') return { error: 'The store options could not be read.' };
  const out = { ...cur };
  if (o.deliveryMethods !== undefined) {
    if (!Array.isArray(o.deliveryMethods) || !o.deliveryMethods.length || o.deliveryMethods.some(m => !store.DELIVERY_METHODS.includes(m))) return { error: 'Choose at least one way for customers to get their goods.' };
    out.deliveryMethods = [...new Set(o.deliveryMethods)];
  }
  if (o.deliveryFee !== undefined) {
    if (typeof o.deliveryFee !== 'number' || o.deliveryFee < 0 || o.deliveryFee > 1000) return { error: 'Your delivery charge must be between $0 and $1,000.' };
    out.deliveryFee = money(o.deliveryFee);
  }
  for (const [k, max, label] of [['pickupPlace', 200, 'Where customers collect'], ['hours', 120, 'Opening hours'], ['orderNote', 300, 'The note to customers']]) {
    if (o[k] !== undefined) {
      if (o[k] !== null && o[k] !== '' && (typeof o[k] !== 'string' || o[k].trim().length > max)) return { error: `${label} must be under ${max} characters.` };
      out[k] = o[k] ? String(o[k]).trim() : '';
    }
  }
  if (o.pickupLocation !== undefined) {
    if (o.pickupLocation === null) out.pickupLocation = null;
    else { const pt = readPoint(o.pickupLocation); if (!pt) return { error: 'The pin for your store isn\'t a valid position. Please pin it again.' }; out.pickupLocation = { latitude: pt.latitude, longitude: pt.longitude }; }
  }
  if ((out.deliveryMethods.includes('pickup') || out.deliveryMethods.includes('driver')) && !out.pickupPlace && !out.pickupLocation) {
    return { error: 'Say where the goods are collected from: describe the place or pin it. Customers who collect, and drivers, need this.' };
  }
  return { out };
}
async function tellManagersAboutStore(provider, s) {
  const managers = await regionalAdminsFor({ city: provider.city, country: provider.country });
  const supers = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin && u.active !== false);
  const seen = new Set();
  for (const a of [...managers, ...supers]) {
    if (seen.has(a.id)) continue; seen.add(a.id);
    await notify(a.id, '🛍️', `${provider.name} has a store waiting for approval: "${s.name}". Approve it in Stores & Skills before it can go live.`, null, { section: 'stores' });
  }
}

// POST /api/store/photo/upload
const goodPhotoUpload = photoUploader('store');
router.post('/store/photo/upload', requireAuth, requireRole('provider'), uploadLimiter, (req, res) => handlePhotoUpload(goodPhotoUpload, req, res));

function readGoodBody(body, userId, existing, currencies) {
  const b = body || {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!existing || has('name')) {
    if (!isNonEmptyString(b.name, { min: 2, max: 80 }) || !looksLikeRealText(b.name)) return { error: 'Give the good a name of 2 to 80 characters' };
    out.name = b.name.trim();
  }
  if (has('description')) {
    if (b.description && !isNonEmptyString(b.description, { max: 400 })) return { error: 'The description must be under 400 characters' };
    out.description = b.description ? String(b.description).trim() : '';
  }
  if (!existing || has('price') || has('currency')) {
    // v108: the price can be in US dollars or in the currency of the pro's country.
    const code = has('currency') && b.currency ? String(b.currency).toUpperCase() : ((existing && existing.priceCurrency) || 'USD');
    const cur = (currencies || []).find(c => c.code === code);
    if (!cur) return { error: `Prices can be in ${(currencies || []).map(c => c.code).join(' or ') || 'USD'}.` };
    const amount = has('price') ? b.price : (existing ? (code === 'USD' ? existing.price : existing.priceLocal) : undefined);
    if (typeof amount !== 'number' || !(amount > 0)) return { error: 'Enter a price above zero' };
    if (code === 'USD') {
      if (amount > 100000) return { error: 'The price is too high. The most is $100,000.' };
      out.price = money(amount); out.priceCurrency = 'USD'; out.priceLocal = null;
    } else {
      const usd = store.usdFromLocal(amount, cur.rate);
      if (usd > 100000) return { error: 'The price is too high.' };
      if (usd < 0.01) return { error: `That price is less than one US cent. Enter a higher price in ${code}.` };
      out.priceCurrency = code; out.priceLocal = money(amount); out.price = usd; // dollars today; worked out again when someone buys
    }
  }
  if (has('unit')) {
    if (b.unit && !isNonEmptyString(b.unit, { max: 20 })) return { error: 'The unit must be under 20 characters, for example "pack" or "bottle"' };
    out.unit = b.unit ? String(b.unit).trim() : '';
  }
  if (has('photoUrls')) {
    const urls = cleanPhotoUrls(b.photoUrls, 'store', userId, store.MAX_PHOTOS_PER_GOOD);
    if (urls === null) return { error: `Add up to ${store.MAX_PHOTOS_PER_GOOD} photos, taken or chosen on this page` };
    out.photoUrls = urls;
  }
  for (const k of ['stock', 'lowStockAt']) {
    if (has(k)) {
      if (b[k] === null || b[k] === '') out[k] = null;
      else if (!Number.isInteger(b[k]) || b[k] < 0 || b[k] > 1000000) return { error: 'Stock must be a whole number, or left blank if you don\'t count it' };
      else out[k] = b[k];
    }
  }
  if (has('costPrice')) {
    if (b.costPrice === null || b.costPrice === '') out.costPrice = null;
    else if (typeof b.costPrice !== 'number' || b.costPrice < 0 || b.costPrice > 100000) return { error: 'What it cost you must be zero or more' };
    else out.costPrice = money(b.costPrice);
  }
  if (has('forSale')) out.forSale = b.forSale !== false;
  if (has('hidden')) out.hidden = b.hidden === true;
  return { out };
}

async function tellManagersAboutGood(provider, good) {
  const managers = await regionalAdminsFor({ city: provider.city, country: provider.country });
  const supers = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin && u.active !== false);
  const seen = new Set();
  for (const a of [...managers, ...supers]) {
    if (seen.has(a.id)) continue; seen.add(a.id);
    await notify(a.id, '🛍️', `${provider.name} added "${good.name}" to their store. It needs checking before customers can see it.`, null, { section: 'stores' });
  }
}

// POST /api/store/goods
router.post('/store/goods', requireAuth, requireRole('provider'), async (req, res) => {
  const me = await freshUser(req);
  const settings = await store.storeSettings();
  if (!settings.enabled) return res.status(403).json({ error: 'Stores are switched off at the moment.' });
  const currencies = await store.currenciesFor(me);
  const { out, error } = readGoodBody(req.body, me.id, null, currencies);
  if (error) return res.status(400).json({ error });
  const forSale = out.forSale !== false;
  if (forSale && !(me.store && me.store.name)) return res.status(400).json({ error: 'Name your store first, then add goods to it.' });
  if (forSale && !(out.photoUrls && out.photoUrls.length)) return res.status(400).json({ error: 'Add at least one photo of the good, so a manager and your customers can see what it is.' });
  const banned = await bannedReason(out.name, out.description);
  if (banned) return res.status(400).json({ error: `This can't be sold on Trothen (${banned}).` });
  const count = (await db.filter('storeGoods', g => g.providerId === me.id)).length;
  if (count >= settings.maxGoodsPerStore) return res.status(400).json({ error: `A store can hold up to ${settings.maxGoodsPerStore} goods. Remove one first.` });
  const good = {
    id: `good_${nanoid(10)}`, providerId: me.id,
    name: out.name, description: out.description || '', price: out.price, priceCurrency: out.priceCurrency || 'USD', priceLocal: out.priceLocal || null, unit: out.unit || '', photoUrls: out.photoUrls || [],
    stock: out.stock === undefined ? null : out.stock, lowStockAt: out.lowStockAt === undefined ? null : out.lowStockAt, costPrice: out.costPrice === undefined ? null : out.costPrice,
    forSale, hidden: false,
    status: forSale ? 'pending' : 'private',
    sold: 0, stockLog: [],
    createdAt: new Date().toISOString(),
  };
  await db.insert('storeGoods', good);
  if (forSale) await tellManagersAboutGood(me, good);
  await store.refreshStoreLive(me.id);
  res.status(201).json({ good: goodForOwner(good, currencies) });
});

// PATCH /api/store/goods/:id
router.patch('/store/goods/:id', requireAuth, requireRole('provider'), async (req, res) => {
  const me = await freshUser(req);
  const good = await db.find('storeGoods', g => g.id === req.params.id && g.providerId === me.id);
  if (!good) return res.status(404).json({ error: 'Good not found' });
  const currencies = await store.currenciesFor(me);
  const { out, error } = readGoodBody(req.body, me.id, good, currencies);
  if (error) return res.status(400).json({ error });
  const banned = await bannedReason(out.name !== undefined ? out.name : good.name, out.description !== undefined ? out.description : good.description);
  if (banned) return res.status(400).json({ error: `This can't be sold on Trothen (${banned}).` });
  const patch = { ...out };
  const forSale = out.forSale !== undefined ? out.forSale : good.forSale !== false;
  const photos = out.photoUrls !== undefined ? out.photoUrls : (good.photoUrls || []);
  if (forSale && !photos.length) return res.status(400).json({ error: 'A good for sale needs at least one photo.' });
  if (forSale && !(me.store && me.store.name)) return res.status(400).json({ error: 'Name your store first, then put goods up for sale.' });
  // What a customer reads or sees is what the manager approved. If the
  // name, description or photos change, it goes back for another look.
  // Price and stock can change freely.
  const wordsChanged = (out.name !== undefined && out.name !== good.name)
    || (out.description !== undefined && out.description !== (good.description || ''))
    || (out.photoUrls !== undefined && JSON.stringify(out.photoUrls) !== JSON.stringify(good.photoUrls || []));
  let needsReview = false;
  if (!forSale) patch.status = 'private';
  else if (good.status === 'private' || good.status === 'rejected' || wordsChanged) { patch.status = 'pending'; patch.reviewNote = null; needsReview = true; }
  if (out.stock !== undefined && out.stock !== good.stock) {
    patch.stockLog = [...(good.stockLog || []), { at: new Date().toISOString(), from: good.stock === undefined ? null : good.stock, to: out.stock, reason: 'Set by hand' }].slice(-30);
  }
  const updated = await db.update('storeGoods', good.id, patch);
  if (needsReview && good.status !== 'pending') await tellManagersAboutGood(me, updated);
  await store.refreshStoreLive(me.id);
  res.json({ good: goodForOwner(updated, currencies), needsReview });
});

// POST /api/store/goods/:id/stock  { change, reason }  — stock in or out by hand
router.post('/store/goods/:id/stock', requireAuth, requireRole('provider'), async (req, res) => {
  const good = await db.find('storeGoods', g => g.id === req.params.id && g.providerId === req.user.sub);
  if (!good) return res.status(404).json({ error: 'Good not found' });
  const change = Number((req.body || {}).change);
  if (!Number.isInteger(change) || change === 0 || Math.abs(change) > 100000) return res.status(400).json({ error: 'Enter how many came in (for example 10) or went out (for example -2)' });
  const reason = isNonEmptyString((req.body || {}).reason, { max: 80 }) ? String(req.body.reason).trim() : (change > 0 ? 'Stock in' : 'Stock out');
  const from = (good.stock === null || good.stock === undefined) ? 0 : good.stock;
  const to = from + change;
  if (to < 0) return res.status(400).json({ error: `You only have ${from}. Stock can't go below zero.` });
  const updated = await db.update('storeGoods', good.id, { stock: to, stockLog: [...(good.stockLog || []), { at: new Date().toISOString(), from, to, reason }].slice(-30) });
  res.json({ good: goodForOwner(updated, await store.currenciesFor(await freshUser(req))) });
});

// DELETE /api/store/goods/:id
router.delete('/store/goods/:id', requireAuth, requireRole('provider'), async (req, res) => {
  const good = await db.find('storeGoods', g => g.id === req.params.id && g.providerId === req.user.sub);
  if (!good) return res.status(404).json({ error: 'Good not found' });
  await db.remove('storeGoods', good.id);
  // The photo files are removed too. Bookings that included this good keep its name and price in writing.
  for (const u of good.photoUrls || []) {
    const file = path.join(UPLOADS_DIR, path.basename(u));
    if (file.startsWith(UPLOADS_DIR)) fs.unlink(file, () => {});
  }
  await store.refreshStoreLive(req.user.sub);
  res.json({ ok: true });
});

// ── WHAT CUSTOMERS SEE ─────────────────────────────────────────────────
// GET /api/providers/:id/store — the inside of one pro's store. This is
// the only place goods and prices are shown.
router.get('/providers/:id/store', async (req, res) => {
  const p = await db.find('users', u => u.id === req.params.id && u.role === 'provider' && u.verified);
  if (!p || !store.storeIsLive(p)) return res.status(404).json({ error: 'This pro doesn\'t have a store open right now.' });
  const goods = (await db.filter('storeGoods', g => g.providerId === p.id)).filter(store.isOnShelf)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const settings = await store.storeSettings();
  const currencies = await store.currenciesFor(p);
  const opt = store.storeOptions(p);
  res.json({
    store: { name: p.store.name, description: p.store.description || '', providerId: p.id, providerName: p.name, city: p.city || '', country: p.country || '' },
    goods: goods.map(g => goodForShopper(g, currencies)),
    // v108: how the goods can reach the customer, and what the seller charges to bring them
    delivery: { methods: opt.deliveryMethods, sellerFee: opt.deliveryFee, pickupPlace: opt.pickupPlace || [p.city, p.country].filter(Boolean).join(', '), hasPickupPin: !!opt.pickupLocation, hours: opt.hours, orderNote: opt.orderNote, feePercent: settings.deliveryFeePercent },
    currencies: currencies.map(c => ({ code: c.code, symbol: c.symbol })),
    purchaseFee: settings.feePaidBy === 'customer' ? settings.purchaseFee : 0, // v106: nothing extra for the customer when the pro pays the fee
  });
});

// POST /api/store/price-basket  { providerId, items:[{goodId, qty}] }
// So the booking form can show the same total the server will charge.
router.post('/store/price-basket', requireAuth, async (req, res) => {
  const { providerId, items } = req.body || {};
  const priced = await store.priceBasket(providerId, items);
  if (priced.error) return res.status(400).json({ error: priced.error });
  const settings = await store.storeSettings();
  res.json({ items: priced.items, goodsTotal: priced.total, purchaseFee: (priced.items.length && settings.feePaidBy === 'customer') ? settings.purchaseFee : 0 });
});

// ── EXTRA SKILLS ───────────────────────────────────────────────────────
// A pro keeps one main skill and can add up to four more. They are found
// under any of them. A skill in a licensed trade (electrical, plumbing…)
// is checked by a manager first, because a licence for one trade doesn't
// cover another.
router.get('/skills/mine', requireAuth, requireRole('provider'), async (req, res) => {
  const me = await freshUser(req);
  const { LICENSED_TRADE_CATEGORIES } = require('./marketplace.routes');
  res.json({ main: me.category || null, extraSkills: (me.extraSkills || []).map(publicSkill), max: store.MAX_EXTRA_SKILLS, licensed: [...LICENSED_TRADE_CATEGORIES] });
});

router.put('/skills/mine', requireAuth, requireRole('provider'), async (req, res) => {
  const me = await freshUser(req);
  const wanted = (req.body || {}).extraCategories;
  if (!Array.isArray(wanted) || wanted.some(c => typeof c !== 'string')) return res.status(400).json({ error: 'Choose your extra skills from the list' });
  const unique = [...new Set(wanted.map(c => c.trim()).filter(Boolean))].filter(c => c !== me.category);
  if (unique.length > store.MAX_EXTRA_SKILLS) return res.status(400).json({ error: `You can add up to ${store.MAX_EXTRA_SKILLS} extra skills on top of your main one.` });
  const active = new Set((await db.filter('categories', c => c.active)).map(c => c.name));
  const unknown = unique.find(c => !active.has(c));
  if (unknown) return res.status(400).json({ error: `"${unknown}" isn't one of the listed kinds of work.` });
  const { LICENSED_TRADE_CATEGORIES } = require('./marketplace.routes');
  const prev = Array.isArray(me.extraSkills) ? me.extraSkills : [];
  const now = new Date().toISOString();
  const next = [];
  const newlyPending = [];
  for (const category of unique) {
    const had = prev.find(s => s.category === category);
    if (had) { next.push(had); continue; }
    const needsCheck = LICENSED_TRADE_CATEGORIES.has(category);
    next.push({ category, status: needsCheck ? 'pending' : 'approved', requestedAt: now, decidedAt: needsCheck ? null : now });
    if (needsCheck) newlyPending.push(category);
  }
  await db.update('users', me.id, { extraSkills: next });
  if (newlyPending.length) {
    const managers = await regionalAdminsFor({ city: me.city, country: me.country });
    const supers = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin && u.active !== false);
    const seen = new Set();
    for (const a of [...managers, ...supers]) {
      if (seen.has(a.id)) continue; seen.add(a.id);
      await notify(a.id, '🧰', `${me.name} asked to add ${newlyPending.join(', ')} as an extra skill. It's a licensed trade, so it needs checking.`, null, { section: 'stores' });
    }
  }
  // Licence files of skills the pro removed are deleted with them.
  for (const old of prev) if (old.licenceFile && !next.some(n => n.category === old.category)) fs.unlink(path.join(PRIVATE_UPLOADS_DIR, path.basename(old.licenceFile)), () => {});
  res.json({ main: me.category || null, extraSkills: next.map(publicSkill), pending: newlyPending });
});

// v106: proof for an extra skill in a licensed trade. The pro attaches a
// photo or PDF of the licence and its expiry date; the manager opens it
// before deciding. The file is kept in the private area (never public),
// encrypted when encryption is on, and every time it is opened is logged.
const licenceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PRIVATE_UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `skilllic_${req.user.sub}_${nanoid(12)}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
  fileFilter: (req, file, cb) => [...IMAGE_TYPES, 'application/pdf'].includes(file.mimetype) ? cb(null, true) : cb(new Error('Add a photo (JPEG, PNG, WEBP) or a PDF of the licence')),
  limits: { fileSize: MAX_PHOTO_BYTES },
});
router.post('/skills/licence/upload', requireAuth, requireRole('provider'), uploadLimiter, (req, res) => {
  licenceUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too big. The limit is 12MB.' : (err.message || 'Upload failed') });
    if (!req.file) return res.status(400).json({ error: 'No file was provided' });
    const drop = () => fs.unlink(req.file.path, () => {});
    const real = req.file.mimetype === 'application/pdf' ? verifyPdfMagicBytes(req.file.path) : verifyImageMagicBytes(req.file.path, req.file.mimetype);
    if (!real) { drop(); return res.status(400).json({ error: 'This file does not appear to be a real photo or PDF.' }); }
    const { category, expiry } = req.body || {};
    if (expiry && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) { drop(); return res.status(400).json({ error: 'Enter the expiry date as a real date' }); }
    if (expiry && expiry <= new Date().toISOString().slice(0, 10)) { drop(); return res.status(400).json({ error: 'That licence has already expired.' }); }
    const me = await freshUser(req);
    const skills = Array.isArray(me.extraSkills) ? me.extraSkills.slice() : [];
    const idx = skills.findIndex(s => s.category === category && s.status !== 'approved');
    if (idx === -1) { drop(); return res.status(404).json({ error: 'Add the skill and save first, then attach its licence.' }); }
    if (skills[idx].licenceFile) fs.unlink(path.join(PRIVATE_UPLOADS_DIR, path.basename(skills[idx].licenceFile)), () => {});
    let encrypted = false;
    try { const fc = require('../file-crypto'); if (fc.isEnabled()) encrypted = !!fc.encryptFileInPlace(req.file.path); } catch (e) { /* kept unencrypted, still private */ }
    // A skill that was turned down goes back to waiting once a licence is attached.
    skills[idx] = { ...skills[idx], status: 'pending', licenceFile: req.file.filename, licenceMime: req.file.mimetype, licenceEncrypted: encrypted, licenceExpiry: expiry || null, licenceUploadedAt: new Date().toISOString(), decidedAt: null };
    await db.update('users', me.id, { extraSkills: skills });
    res.status(201).json({ extraSkills: skills.map(publicSkill) });
  });
});

// ── PICK-UP AND DROP-OFF ───────────────────────────────────────────────
// When goods or a customer's materials are carried as part of a booking,
// either side can take photos at pick-up and at drop-off. Each record
// keeps who took it, when, and where the phone was. While the pro is
// carrying the materials (after pick-up, before drop-off) their phone
// also records the route.
const handoverPhotoUpload = photoUploader('handover');
router.post('/handover-photos/upload', requireAuth, uploadLimiter, (req, res) => {
  if (!['customer', 'provider'].includes(req.user.role)) return res.status(403).json({ error: 'Only the customer and the pro on a booking can add these photos' });
  handlePhotoUpload(handoverPhotoUpload, req, res);
});

function readPoint(body) {
  const { isValidCoordinate } = require('../geo-distance');
  const b = body || {};
  if (!isValidCoordinate(b.latitude, b.longitude) || (b.latitude === 0 && b.longitude === 0)) return null;
  const acc = Number(b.accuracyM);
  return {
    latitude: Math.round(b.latitude * 1e6) / 1e6, longitude: Math.round(b.longitude * 1e6) / 1e6,
    accuracyM: Number.isFinite(acc) && acc > 0 && acc < 100000 ? Math.round(acc) : null,
  };
}
const CARRY_MAX_MS = 8 * 60 * 60 * 1000;
const MAX_TRAIL_POINTS = 240;
function carryOpen(contract) {
  const h = contract.handover || {};
  return contract.status === 'active' && !!h.carryStartedAt && !h.carryEndedAt && (Date.now() - new Date(h.carryStartedAt).getTime()) < CARRY_MAX_MS;
}

// POST /api/contracts/:id/handover  { stage: 'pickup'|'dropoff', photoUrls, location, note }
router.post('/contracts/:id/handover', requireAuth, async (req, res) => {
  // v108: on a delivery, the seller of the goods can also record the pick-up (handing them to the driver).
  const contract = await db.find('contracts', c => c.id === req.params.id && (c.customerId === req.user.sub || c.providerId === req.user.sub || (c.delivery && c.delivery.sellerId === req.user.sub)));
  if (!contract) return res.status(404).json({ error: 'Booking not found' });
  if (contract.status !== 'active') return res.status(400).json({ error: `This booking is ${String(contract.status).replace(/_/g, ' ')}. Pick-up and drop-off can only be recorded on a confirmed booking that isn't finished.` });
  const { stage, photoUrls, location, note } = req.body || {};
  if (!['pickup', 'dropoff'].includes(stage)) return res.status(400).json({ error: 'Say whether this is the pick-up or the drop-off' });
  const iAmSeller = !!(contract.delivery && contract.delivery.sellerId === req.user.sub && contract.providerId !== req.user.sub && contract.customerId !== req.user.sub);
  if (iAmSeller && stage !== 'pickup') return res.status(403).json({ error: 'As the seller you record the pick-up, when you hand the goods to the driver. The driver and the customer record the drop-off.' });
  const urls = cleanPhotoUrls(photoUrls, 'handover', req.user.sub, 6);
  if (urls === null || !urls.length) return res.status(400).json({ error: 'Add at least one photo (up to 6), taken on this page' });
  if (note && !isNonEmptyString(note, { max: 300 })) return res.status(400).json({ error: 'The note must be under 300 characters' });
  const iAmPro = contract.providerId === req.user.sub;
  const h = { pickup: [], dropoff: [], trail: [], ...(contract.handover || {}) };
  if (stage === 'dropoff' && !h.pickup.length) return res.status(400).json({ error: 'Record the pick-up first, then the drop-off.' });
  if (h[stage].length >= 6) return res.status(400).json({ error: `There are already 6 ${stage === 'pickup' ? 'pick-up' : 'drop-off'} records on this booking.` });
  const now = new Date().toISOString();
  const entry = { id: `ho_${nanoid(8)}`, by: iAmSeller ? 'seller' : iAmPro ? 'provider' : 'customer', byId: req.user.sub, at: now, photoUrls: urls, location: location ? readPoint(location) : null, note: note ? String(note).trim() : null };
  h[stage] = [...h[stage], entry];
  // The route is recorded from the PRO's pick-up to the PRO's drop-off.
  if (iAmPro && stage === 'pickup' && !h.carryStartedAt) { h.carryStartedAt = now; h.trail = entry.location ? [{ ...entry.location, at: now }] : []; }
  if (iAmPro && stage === 'dropoff' && h.carryStartedAt && !h.carryEndedAt) { h.carryEndedAt = now; if (entry.location) h.trail = [...(h.trail || []), { ...entry.location, at: now }].slice(-MAX_TRAIL_POINTS); }
  const updated = await db.update('contracts', contract.id, { handover: h });
  const me = await freshUser(req);
  const other = iAmPro ? contract.customerId : contract.providerId;
  // v108: on a delivery, everyone else on it is told: the customer, the driver and the seller.
  if (contract.delivery) {
    for (const id of new Set([contract.customerId, contract.providerId, contract.delivery.sellerId])) {
      if (!id || id === req.user.sub || id === other) continue;
      await notify(id, stage === 'pickup' ? '📦' : '✅', `${me ? me.name : 'Someone'} recorded the ${stage === 'pickup' ? 'pick-up' : 'drop-off'} for "${String(contract.service).slice(0, 60)}" with ${urls.length} photo${urls.length === 1 ? '' : 's'}.`, 'bookingUpdates', { section: id === contract.delivery.sellerId ? 'store' : 'bookings' });
    }
  }
  await notify(other, stage === 'pickup' ? '📦' : '✅', `${me ? me.name : 'The other person'} recorded the ${stage === 'pickup' ? 'pick-up' : 'drop-off'} for "${String(contract.service).slice(0, 60)}" with ${urls.length} photo${urls.length === 1 ? '' : 's'}.`, 'bookingUpdates', { section: 'bookings' });
  res.status(201).json({ handover: updated.handover, carrying: carryOpen(updated) });
});

// POST /api/contracts/:id/carry-location  { latitude, longitude, accuracyM }
const carryLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Location updates are arriving too quickly.' } });
router.post('/contracts/:id/carry-location', requireAuth, requireRole('provider'), carryLimiter, async (req, res) => {
  const contract = await db.find('contracts', c => c.id === req.params.id && c.providerId === req.user.sub);
  if (!contract) return res.status(404).json({ error: 'Booking not found' });
  if (!carryOpen(contract)) return res.status(409).json({ code: 'CARRY_CLOSED', error: 'Nothing is being carried on this booking right now, so your route isn\'t being recorded.' });
  const p = readPoint(req.body);
  if (!p) return res.status(400).json({ error: 'That isn\'t a valid position' });
  const h = contract.handover;
  const trail = Array.isArray(h.trail) ? h.trail : [];
  const last = trail[trail.length - 1];
  // Not more often than every 20 seconds, so a long trip still fits.
  if (last && (Date.now() - new Date(last.at).getTime()) < 20000) return res.json({ ok: true, kept: false });
  let next = [...trail, { ...p, at: new Date().toISOString() }];
  // If the route gets very long, keep every second point rather than losing the start.
  if (next.length > MAX_TRAIL_POINTS) next = next.filter((_, i) => i === 0 || i === next.length - 1 || i % 2 === 0);
  await db.update('contracts', contract.id, { handover: { ...h, trail: next } });
  res.json({ ok: true, kept: true, points: next.length });
});

// ── MANAGERS ───────────────────────────────────────────────────────────
// Every address below is for the Trothen team. A manager only sees pros
// in the place they look after.
async function adminGateCheck(req, res, next) {
  const m = await db.find('users', u => u.id === req.user.sub);
  if (!m || m.active === false) return res.status(403).json({ error: 'This account has been suspended. Contact a super admin for access.' });
  // Store and skill checks belong with the people who already check IDs.
  if (!m.isSuperAdmin && m.adminDepartment && !['verification', 'customer_service'].includes(m.adminDepartment)) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${m.adminDepartment} team and doesn't have access to this.` });
  }
  req.adminUser = m;
  req.covers = adminScopeFor(m);
  next();
}
// Applied to each address by name, so nothing else under /api/admin is touched.
const adminGate = [requireAuth, requireRole('admin'), adminGateCheck];

router.get('/admin/store/review', adminGate, async (req, res) => {
  const users = await db.filter('users', u => u.role === 'provider');
  const byId = new Map(users.map(u => [u.id, u]));
  const mine = (id) => { const p = byId.get(id); return p && req.covers(p) ? p : null; };
  const goods = await db.all('storeGoods');
  const proInfo = (p) => ({ id: p.id, name: p.name, email: p.email, city: p.city || '', country: p.country || '', category: p.category || '', storeName: (p.store && p.store.name) || '' });
  const curCache = new Map();
  const curFor = async (p) => { const k = p.country || ''; if (!curCache.has(k)) curCache.set(k, await store.currenciesFor(p)); return curCache.get(k); };
  for (const u of users) if (u.store && u.store.name) await curFor(u);
  const shape = (g, p) => ({ id: g.id, name: g.name, description: g.description || '', ...store.goodPriceFields(g, curCache.get(p.country || '') || []), unit: g.unit || '', photoUrls: g.photoUrls || [], status: g.status, reviewNote: g.reviewNote || null, reviewedAt: g.reviewedAt || null, reviewedByName: g.reviewedByName || null, createdAt: g.createdAt, updatedAt: g.updatedAt || null, pro: proInfo(p) });
  const pending = [], recent = [];
  for (const g of goods) {
    const p = mine(g.providerId);
    if (!p) continue;
    if (g.status === 'pending') pending.push(shape(g, p));
    else if (g.reviewedAt) recent.push(shape(g, p));
  }
  pending.sort((a, b) => String(a.updatedAt || a.createdAt).localeCompare(String(b.updatedAt || b.createdAt)));
  recent.sort((a, b) => String(b.reviewedAt).localeCompare(String(a.reviewedAt)));
  const stores = users.filter(u => u.store && u.store.name && req.covers(u)).map(u => ({
    ...proInfo(u), open: u.store.open === true, closedByAdmin: u.store.closedByAdmin === true, closedReason: u.store.closedReason || null,
    live: store.storeIsLive(u), goods: goods.filter(g => g.providerId === u.id && g.forSale !== false).length, liveGoods: u.store.liveGoods || 0,
    // v108: the store's own approval, and in plain words why it isn't showing
    description: u.store.description || '', approval: store.storeApproval(u), approvalNote: (u.store.approval && u.store.approval.note) || null, askedAt: (u.store.approval && u.store.approval.askedAt) || u.store.createdAt || null,
    whyNotLive: store.whyNotLive(u), whyNotLiveWords: store.WHY_NOT_LIVE_WORDS[store.whyNotLive(u)] || null,
    waitingGoods: goods.filter(g => g.providerId === u.id && g.status === 'pending').length,
    options: store.storeOptions(u), verified: u.verified === true,
  })).sort((a, b) => (a.approval === 'pending' ? 0 : 1) - (b.approval === 'pending' ? 0 : 1) || a.storeName.localeCompare(b.storeName));
  const skills = [];
  for (const u of users) {
    if (!req.covers(u)) continue;
    for (const s of (u.extraSkills || [])) if (s.status === 'pending') skills.push({ providerId: u.id, providerName: u.name, email: u.email, city: u.city || '', country: u.country || '', main: u.category || '', category: s.category, requestedAt: s.requestedAt, licenseExpiryDate: u.licenseExpiryDate || null, hasLicence: !!s.licenceFile, licenceExpiry: s.licenceExpiry || null, licenceUploadedAt: s.licenceUploadedAt || null });
  }
  const settings = await store.storeSettings();
  // v106: what stores have sold, for the pros this admin looks after.
  const sales = { orders: 0, goods: 0, feesFromCustomers: 0, feesFromPros: 0 };
  for (const c of await db.filter('contracts', c => Array.isArray(c.storeItems) && c.storeItems.length > 0 && ['active', 'completed'].includes(c.status))) {
    if (!mine(c.providerId)) continue;
    sales.orders += 1; sales.goods += c.storeGoodsTotal || 0;
    if (c.storeFeePaidBy === 'pro') sales.feesFromPros += c.storeFee || 0; else sales.feesFromCustomers += c.storeFee || 0;
  }
  for (const k of ['goods', 'feesFromCustomers', 'feesFromPros']) sales[k] = money(sales[k]);
  res.json({ pending, recent: recent.slice(0, 30), stores, skills, settings, sales, defaultRules: store.DEFAULT_STORE_RULES, canEditSettings: req.adminUser.isSuperAdmin === true });
});

router.post('/admin/store/goods/:id/decide', adminGate, async (req, res) => {
  const good = await db.find('storeGoods', g => g.id === req.params.id);
  const pro = good && await db.find('users', u => u.id === good.providerId);
  if (!good || !pro || !req.covers(pro)) return res.status(404).json({ error: 'Good not found' });
  const { decision, note } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Decide approve or reject' });
  if (good.forSale === false) return res.status(400).json({ error: 'This good is not for sale, so there is nothing to decide.' });
  if (decision === 'reject' && !isNonEmptyString(note, { min: 3, max: 300 })) return res.status(400).json({ error: 'Say why it is being turned down, so the pro can fix it (3 to 300 characters)' });
  if (note && !isNonEmptyString(note, { max: 300 })) return res.status(400).json({ error: 'The note must be under 300 characters' });
  const updated = await db.update('storeGoods', good.id, {
    status: decision === 'approve' ? 'approved' : 'rejected',
    reviewNote: note ? String(note).trim() : null,
    reviewedAt: new Date().toISOString(), reviewedBy: req.adminUser.id, reviewedByName: req.adminUser.name,
  });
  await store.refreshStoreLive(pro.id);
  await notify(pro.id, decision === 'approve' ? '✅' : '❌', decision === 'approve'
    ? `"${good.name}" was approved and is now in your store.`
    : `"${good.name}" wasn't approved for your store: ${String(note).trim()} Change it and it will be checked again.`, null, { section: 'store' });
  res.json({ good: { id: updated.id, status: updated.status } });
});

// v108: a manager approves or turns down the store itself.
router.post('/admin/store/stores/:providerId/decide', adminGate, async (req, res) => {
  const pro = await db.find('users', u => u.id === req.params.providerId && u.role === 'provider');
  if (!pro || !pro.store || !pro.store.name || !req.covers(pro)) return res.status(404).json({ error: 'Store not found' });
  const { decision, note } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Decide approve or reject' });
  if (decision === 'reject' && !isNonEmptyString(note, { min: 3, max: 300 })) return res.status(400).json({ error: 'Say why the store is being turned down, so the pro can fix it (3 to 300 characters)' });
  if (note && !isNonEmptyString(note, { max: 300 })) return res.status(400).json({ error: 'The note must be under 300 characters' });
  const approval = { status: decision === 'approve' ? 'approved' : 'rejected', note: note ? String(note).trim() : null, askedAt: (pro.store.approval && pro.store.approval.askedAt) || null, decidedAt: new Date().toISOString(), decidedBy: req.adminUser.id, decidedByName: req.adminUser.name };
  await db.update('users', pro.id, { store: { ...pro.store, approval } });
  await store.refreshStoreLive(pro.id);
  const after = await db.find('users', u => u.id === pro.id);
  const why = store.whyNotLive(after);
  try { await db.insert('accessLogs', { id: `al_${nanoid(10)}`, adminId: req.adminUser.id, resourceType: 'store_decision', resourceId: `${pro.id}: ${approval.status}`, ipAddress: req.ip, createdAt: new Date().toISOString() }); } catch (e) { /* the decision stands */ }
  await notify(pro.id, decision === 'approve' ? '✅' : '❌', decision === 'approve'
    ? `Your store "${pro.store.name}" was approved.${why ? ' It is not showing to customers yet: ' + (store.WHY_NOT_LIVE_WORDS[why] || '').toLowerCase() + '.' : ' Customers can now see it.'}`
    : `Your store "${pro.store.name}" wasn't approved: ${String(note).trim()} Change it in My Store and it will be looked at again.`, null, { section: 'store' });
  res.json({ ok: true, approval: approval.status, live: why === null, whyNotLive: why, whyNotLiveWords: store.WHY_NOT_LIVE_WORDS[why] || null });
});

router.post('/admin/store/stores/:providerId/close', adminGate, async (req, res) => {
  const pro = await db.find('users', u => u.id === req.params.providerId && u.role === 'provider');
  if (!pro || !pro.store || !req.covers(pro)) return res.status(404).json({ error: 'Store not found' });
  const { reason, reopen } = req.body || {};
  if (reopen === true) {
    await db.update('users', pro.id, { store: { ...pro.store, closedByAdmin: false, closedReason: null } });
    await notify(pro.id, '🛍️', 'Your store can be opened again. Switch it on in My Store.', null, { section: 'store' });
    return res.json({ ok: true, closedByAdmin: false });
  }
  if (!isNonEmptyString(reason, { min: 3, max: 300 })) return res.status(400).json({ error: 'Say why the store is being closed (3 to 300 characters)' });
  await db.update('users', pro.id, { store: { ...pro.store, open: false, closedByAdmin: true, closedReason: String(reason).trim(), closedAt: new Date().toISOString(), closedBy: req.adminUser.id } });
  await notify(pro.id, '🚫', `Your store was closed by the Trothen team: ${String(reason).trim()}`, null, { section: 'store' });
  res.json({ ok: true, closedByAdmin: true });
});

router.post('/admin/skills/:providerId/decide', adminGate, async (req, res) => {
  const pro = await db.find('users', u => u.id === req.params.providerId && u.role === 'provider');
  if (!pro || !req.covers(pro)) return res.status(404).json({ error: 'Pro not found' });
  const { category, decision } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Decide approve or reject' });
  const skills = Array.isArray(pro.extraSkills) ? pro.extraSkills : [];
  const idx = skills.findIndex(s => s.category === category && s.status === 'pending');
  if (idx === -1) return res.status(404).json({ error: 'That skill isn\'t waiting for a decision' });
  const next = skills.slice();
  next[idx] = { ...next[idx], status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: new Date().toISOString(), decidedBy: req.adminUser.id };
  await db.update('users', pro.id, { extraSkills: next });
  await notify(pro.id, decision === 'approve' ? '✅' : '❌', decision === 'approve'
    ? `${category} was added to your skills. Customers can now find you under it.`
    : `${category} wasn't added to your skills. It is a licensed trade, and we couldn't confirm a licence for it. Contact support if you hold one.`, null, { section: 'settings' });
  res.json({ ok: true });
});

router.get('/admin/skills/:providerId/licence', adminGate, async (req, res) => {
  const pro = await db.find('users', u => u.id === req.params.providerId && u.role === 'provider');
  if (!pro || !req.covers(pro)) return res.status(404).json({ error: 'Pro not found' });
  const skill = (pro.extraSkills || []).find(s => s.category === req.query.category);
  if (!skill || !skill.licenceFile) return res.status(404).json({ error: 'No licence was attached for this skill' });
  const filePath = path.join(PRIVATE_UPLOADS_DIR, path.basename(skill.licenceFile));
  let buf;
  try { buf = require('../file-crypto').readPossiblyEncrypted(filePath); }
  catch (e) { return res.status(404).json({ error: 'The licence file is no longer on the server' }); }
  try { await db.insert('accessLogs', { id: `al_${nanoid(10)}`, adminId: req.adminUser.id, resourceType: 'skill_licence', resourceId: `${pro.id}:${skill.category}`, ipAddress: req.ip, createdAt: new Date().toISOString() }); } catch (e) { /* still shown */ }
  res.setHeader('Content-Type', skill.licenceMime || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
});

// v106: if the privacy policy was edited and saved in Settings, the saved
// version does not pick up new paragraphs by itself. This says which of
// the v105 paragraphs are missing from it and can put them in.
const PRIVACY_ADDITIONS = [
  { key: 'stores', test: /Stores and business tools/i, after: /^Jobs and bookings\./m, text: 'Stores and business tools (pros only, optional). If you open a store: its name, your goods, their photos and prices, and your stock. If you use the business tools: the quotes, estimates and invoices you write (including the customer name and contact you type in), your list of tools, and your expenses and receipt photos. Only you can see your business records, except a quote, estimate or invoice you choose to send to a customer on Trothen, which that customer can also see. Your store name is public, and your goods and prices are shown to anyone who opens your store once a Trothen manager has approved them. If you add a skill in a licensed trade, the licence photo you attach is kept privately and only the Trothen staff who check it can open it.' },
  { key: 'handover', test: /Pick-up and drop-off\. When goods/i, after: /^Live trip\./m, text: 'Pick-up and drop-off. When goods or materials are carried as part of a booking, the customer or the pro can take photos at pick-up and at drop-off. Each record keeps who took it, when, and where the phone was, if the phone gives a position. From the pro\'s pick-up record until the pro\'s drop-off record, the pro\'s phone also records the route taken, while the Trothen page is open. Only the customer and the pro on that booking, and Trothen staff handling a dispute, can see these.' },
  { key: 'store-orders', test: /Store orders and delivery\./i, after: /^Pick-up and drop-off\. When goods/m, text: "Store orders and delivery. When you buy goods from a pro's store, the seller sees your first name, what you bought and any note you write. If you ask for the goods to be brought to you, the place you give (a pin, a landmark or an address) is shown to whoever brings them: the seller if the seller delivers, or the driver you chose. When a driver delivers, the seller is not shown your address. A store's collection place, and its pin if the seller set one, are shown to customers who order from it and to the driver. A driver's name, what they deliver with, their rating and their price are shown to customers choosing a driver; a driver's own position is never shown." }, // v108
  { key: 'handover-kept', test: /Pick-up and drop-off\. The positions/i, after: /^Job location\. The exact pin/m, text: 'Pick-up and drop-off. The positions on pick-up and drop-off records, and the recorded route, are removed on the same 90-day rule. The photos and times stay with the booking as the record of the hand-over.' },
];
function addMissingPrivacyParagraphs(content) {
  let out = String(content || ''); const added = [];
  for (const a of PRIVACY_ADDITIONS) {
    if (a.test.test(out)) continue;
    const m = a.after.exec(out);
    if (m) { const lineEnd = out.indexOf('\n', m.index); const at = lineEnd === -1 ? out.length : lineEnd; out = out.slice(0, at) + '\n\n' + a.text + out.slice(at); }
    else out = out.replace(/\s*$/, '') + '\n\n' + a.text + '\n';
    added.push(a.key);
  }
  return { content: out, added };
}
router.get('/admin/store/privacy-check', adminGate, async (req, res) => {
  const row = await db.find('platformSettings', s2 => s2.key === 'privacyPolicyContent');
  if (!row) return res.json({ edited: false, missing: [] }); // the built-in policy is in use, and it already has them
  res.json({ edited: true, missing: addMissingPrivacyParagraphs(row.value).added });
});
router.post('/admin/store/privacy-check/apply', adminGate, async (req, res) => {
  if (!req.adminUser.isSuperAdmin) return res.status(403).json({ error: 'This action requires a super admin account' });
  const row = await db.find('platformSettings', s2 => s2.key === 'privacyPolicyContent');
  if (!row) return res.json({ added: [] });
  const r = addMissingPrivacyParagraphs(row.value);
  if (r.added.length) await db.update('platformSettings', row.id, { value: r.content, updatedAt: new Date().toISOString() });
  res.json({ added: r.added });
});

router.put('/admin/store/settings', adminGate, async (req, res) => {
  if (!req.adminUser.isSuperAdmin) return res.status(403).json({ error: 'This action requires a super admin account' });
  const { enabled, purchaseFee, feePaidBy, bannedWords, rulesText, deliveryFeePercent } = req.body || {};
  const patch = {};
  const before = await store.storeSettings();
  if (feePaidBy !== undefined) {
    if (!['customer', 'pro'].includes(feePaidBy)) return res.status(400).json({ error: 'The fee is paid by the customer or by the pro' });
    patch.feePaidBy = feePaidBy;
  }
  if (bannedWords !== undefined) {
    if (!Array.isArray(bannedWords) || bannedWords.length > 200 || bannedWords.some(w => typeof w !== 'string' || w.trim().length < 3 || w.trim().length > 40)) return res.status(400).json({ error: 'Banned words: up to 200, each 3 to 40 characters' });
    patch.bannedWords = [...new Set(bannedWords.map(w => w.trim().toLowerCase()))];
  }
  if (rulesText !== undefined) {
    if (typeof rulesText !== 'string' || rulesText.trim().length > 4000) return res.status(400).json({ error: 'The store rules must be under 4,000 characters' });
    const next = rulesText.trim() || store.DEFAULT_STORE_RULES;
    // New wording means every pro is asked to agree again.
    if (next !== before.rulesText) { patch.rulesText = rulesText.trim(); patch.rulesVersion = before.rulesVersion + 1; }
  }
  if (deliveryFeePercent !== undefined) {
    if (typeof deliveryFeePercent !== 'number' || deliveryFeePercent < 0 || deliveryFeePercent > 30) return res.status(400).json({ error: 'Trothen\'s share of a delivery charge must be between 0% and 30%' });
    patch.deliveryFeePercent = Math.round(deliveryFeePercent * 100) / 100;
  }
  if (enabled !== undefined) patch.enabled = enabled === true;
  if (purchaseFee !== undefined) {
    if (typeof purchaseFee !== 'number' || purchaseFee < 0 || purchaseFee > 500) return res.status(400).json({ error: 'The purchase fee must be between $0 and $500' });
    patch.purchaseFee = money(purchaseFee);
  }
  const settings = await store.saveStoreSettings(patch);
  try { await db.insert('accessLogs', { id: `al_${nanoid(10)}`, adminId: req.adminUser.id, resourceType: 'store_settings', resourceId: `fee ${before.purchaseFee} -> ${settings.purchaseFee}; paid by ${before.feePaidBy} -> ${settings.feePaidBy}; stores ${before.enabled ? 'on' : 'off'} -> ${settings.enabled ? 'on' : 'off'}; rules v${before.rulesVersion} -> v${settings.rulesVersion}; banned words ${before.bannedWords.length} -> ${settings.bannedWords.length}`.slice(0, 250), ipAddress: req.ip, createdAt: new Date().toISOString() }); } catch (e) { /* the change still stands */ }
  res.json({ settings });
});

module.exports = router;
module.exports.bannedGoodReason = bannedGoodReason;
