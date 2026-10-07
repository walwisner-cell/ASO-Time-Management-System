// v105: the pro store.
//
// A pro can choose to open a store and sell goods to their customers: a
// salon puts hair and wave on the shelf, a plumber puts fittings. It is
// optional. The rules, in one place:
//
//   - Goods are checked by a manager before customers can see them.
//   - Outside the store, customers only see the STORE NAME under the pro.
//     The goods and their prices are only shown once someone opens the store.
//   - What a customer picks is added to the booking as the materials cost
//     and is paid for when they book.
//   - Trothen takes a flat fee per store purchase (set by the super admin,
//     $5 to begin with). No commission is taken on goods.
//
// This file holds the parts other files need: pricing a basket, holding
// and giving back stock, and the store settings. The web addresses are in
// src/routes/store.routes.js.
const db = require('./db');

const STORE_DEFAULTS = {
  enabled: true,        // one switch to turn every store off
  purchaseFee: 5,       // flat fee in US dollars added to a booking that includes goods
  maxGoodsPerStore: 60,
  // v106: who pays the purchase fee. 'customer' = added at checkout.
  // 'pro' = the customer pays nothing extra and the fee comes out of the
  // pro's money when they are paid.
  feePaidBy: 'customer',
  // v106: extra words a super admin has banned, on top of the built-in list.
  bannedWords: [],
  // v106: the rules a pro agrees to before opening a store. A new
  // rulesVersion makes every pro agree again the next time they save.
  rulesVersion: 1,
  rulesText: '',
  // v108: Trothen's share of a delivery charge, as a percentage. It is
  // added for the customer at checkout, on a seller's own delivery charge
  // and on a pick-and-drop driver's price. Never on the goods.
  deliveryFeePercent: 9,
};
// v108: how goods can reach the customer.
const DELIVERY_METHODS = ['pickup', 'seller', 'driver'];
const DELIVERY_LABELS = { pickup: 'I collect it myself', seller: 'The seller brings it', driver: 'A pick-and-drop driver brings it' };
const DRIVER_SKILL = 'Pick & Drop';
const VEHICLES = ['motorbike', 'keke', 'car', 'van', 'truck', 'bicycle', 'on foot'];
// The built-in store rules, used until a super admin writes their own.
// Plain commitments, not a contract an attorney has approved.
const DEFAULT_STORE_RULES = [
  'I am the seller of everything in my store. Trothen shows my goods and holds the customer\'s money; it does not own, stock or deliver them.',
  'My photos and descriptions show the real goods, and I will hand over exactly what the customer paid for.',
  'I will only sell goods I am allowed to sell where I live, and never weapons, drugs, medicines, alcohol, tobacco, fake or stolen goods.',
  'If goods are missing, wrong, damaged or unsafe, the customer can report a problem on the booking and Trothen can refund them from the money it is holding.',
  'Any tax due on what I sell is mine to declare and pay.',
  'Trothen can take down a good or close my store if these rules are broken.',
].join('\n');
const MAX_PHOTOS_PER_GOOD = 4;
const MAX_QTY_PER_LINE = 99;
const MAX_LINES_PER_ORDER = 20;
const MAX_EXTRA_SKILLS = 4;

const money = (n) => Math.round(Number(n) * 100) / 100;

let cached = { ...STORE_DEFAULTS, rulesText: DEFAULT_STORE_RULES };
async function storeSettings() {
  try {
    const row = await db.find('platformSettings', s => s.key === 'storeSettings');
    const v = (row && row.value) || {};
    cached = {
      enabled: v.enabled !== false,
      purchaseFee: Number.isFinite(Number(v.purchaseFee)) && Number(v.purchaseFee) >= 0 ? money(v.purchaseFee) : STORE_DEFAULTS.purchaseFee,
      maxGoodsPerStore: Number.isInteger(v.maxGoodsPerStore) && v.maxGoodsPerStore > 0 ? v.maxGoodsPerStore : STORE_DEFAULTS.maxGoodsPerStore,
      feePaidBy: v.feePaidBy === 'pro' ? 'pro' : 'customer',
      bannedWords: Array.isArray(v.bannedWords) ? v.bannedWords.filter(w => typeof w === 'string' && w.trim()).map(w => w.trim().toLowerCase()).slice(0, 200) : [],
      rulesVersion: Number.isInteger(v.rulesVersion) && v.rulesVersion > 0 ? v.rulesVersion : 1,
      rulesText: typeof v.rulesText === 'string' && v.rulesText.trim() ? v.rulesText.trim() : DEFAULT_STORE_RULES,
      deliveryFeePercent: Number.isFinite(Number(v.deliveryFeePercent)) && Number(v.deliveryFeePercent) >= 0 && Number(v.deliveryFeePercent) <= 30 ? Math.round(Number(v.deliveryFeePercent) * 100) / 100 : STORE_DEFAULTS.deliveryFeePercent,
    };
  } catch (e) { /* keep the last known settings */ }
  return cached;
}
function storeSettingsCached() { return cached; }
async function saveStoreSettings(patch) {
  const cur = await storeSettings();
  const next = { ...cur, ...patch };
  const existing = await db.find('platformSettings', s => s.key === 'storeSettings');
  const row = { key: 'storeSettings', value: next, updatedAt: new Date().toISOString() };
  if (existing) await db.update('platformSettings', existing.id, row);
  else await db.insert('platformSettings', { id: 'ps_storeSettings', ...row });
  return storeSettings();
}
storeSettings().catch(() => {});

// A good is on the shelf when a manager approved it, the pro hasn't
// hidden it, and it isn't sold out.
function isOnShelf(g) {
  return g.forSale !== false && g.status === 'approved' && g.hidden !== true;
}
function inStock(g, qty = 1) {
  return g.stock === null || g.stock === undefined || g.stock >= qty;
}

// v108: a manager approves the STORE itself (its name and what it says it
// sells), as well as each good. Stores made before this are 'pending'.
function storeApproval(user) {
  const a = user && user.store && user.store.approval;
  return a && ['approved', 'rejected', 'pending'].includes(a.status) ? a.status : 'pending';
}
// Why a store is not showing to customers, as one short code, or null when
// it is live. In the order a person would fix them.
function whyNotLive(user) {
  const s = user && user.store;
  if (!cached.enabled) return 'stores_off';
  if (!s || !s.name) return 'not_set_up';
  if (user.active === false || user.onHold === true) return 'account_paused';
  if (s.closedByAdmin === true) return 'closed_by_team';
  if (!user.verified) return 'id_not_verified';
  if (storeApproval(user) === 'rejected') return 'store_turned_down';
  if (storeApproval(user) !== 'approved') return 'store_waiting';
  if (!((s.liveGoods || 0) > 0)) return 'no_approved_goods';
  if (s.open !== true) return 'switched_off';
  return null;
}
const WHY_NOT_LIVE_WORDS = {
  stores_off: 'Stores are switched off for everyone',
  not_set_up: 'The store has no name yet',
  account_paused: 'The pro\'s account is paused or closed',
  closed_by_team: 'Closed by the Trothen team',
  id_not_verified: 'The pro\'s ID is not verified yet',
  store_turned_down: 'The store was turned down by a manager',
  store_waiting: 'Waiting for a manager to approve the store',
  no_approved_goods: 'No approved goods on the shelf yet',
  switched_off: 'The pro has switched the store off',
};
// The store is live (its name shows under the pro) when a manager approved
// it, the pro switched it on, a manager hasn't closed it, and at least one
// good is approved. A closed or paused account's store is never live.
function storeIsLive(user) {
  return whyNotLive(user) === null;
}

// v108: store options, read with safe defaults. A store with no options
// saved offers self pick-up and a pick-and-drop driver.
function storeOptions(user) {
  const o = (user && user.store && user.store.options) || {};
  let methods = Array.isArray(o.deliveryMethods) ? o.deliveryMethods.filter(m => DELIVERY_METHODS.includes(m)) : ['pickup', 'driver'];
  if (!methods.length) methods = ['pickup'];
  const fee = Number(o.deliveryFee);
  const loc = o.pickupLocation && typeof o.pickupLocation.latitude === 'number' && typeof o.pickupLocation.longitude === 'number' ? { latitude: o.pickupLocation.latitude, longitude: o.pickupLocation.longitude } : null;
  return {
    deliveryMethods: [...new Set(methods)],
    deliveryFee: Number.isFinite(fee) && fee >= 0 ? money(fee) : 0,
    pickupPlace: typeof o.pickupPlace === 'string' ? o.pickupPlace : '',
    pickupLocation: loc,
    hours: typeof o.hours === 'string' ? o.hours : '',
    orderNote: typeof o.orderNote === 'string' ? o.orderNote : '',
  };
}

// v108: prices in more than one currency. A good is priced in US dollars
// or in the currency of the pro's own country. Money on Trothen is always
// held in US dollars, so a local price is turned into dollars with the
// exchange rate at the moment someone buys.
const { currencyForCountry } = require('./currency-data');
const { resolveRate } = require('./plan-pricing');
async function currenciesFor(user) {
  const local = currencyForCountry((user && user.country) || 'United States');
  const out = [{ code: 'USD', symbol: '$', name: 'US Dollar', rate: 1 }];
  if (local.code !== 'USD') out.push({ code: local.code, symbol: local.symbol, name: local.name, rate: resolveRate(local.code, await db.all('exchangeRates')) });
  return out;
}
function usdFromLocal(amount, rate) { return money(Number(amount) / (rate > 0 ? rate : 1)); }
// The price of a good in US dollars right now.
function goodUsdPrice(g, currencies) {
  if (g.priceCurrency && g.priceCurrency !== 'USD' && Number(g.priceLocal) > 0) {
    const c = (currencies || []).find(x => x.code === g.priceCurrency);
    if (c) return Math.max(0.01, usdFromLocal(g.priceLocal, c.rate));
  }
  return g.price;
}
function goodPriceFields(g, currencies) {
  const c = g.priceCurrency && g.priceCurrency !== 'USD' ? (currencies || []).find(x => x.code === g.priceCurrency) : null;
  return c && Number(g.priceLocal) > 0
    ? { price: goodUsdPrice(g, currencies), priceCurrency: c.code, priceLocal: g.priceLocal, priceSymbol: c.symbol }
    : { price: g.price, priceCurrency: 'USD', priceLocal: null, priceSymbol: '$' };
}
function publicStore(user) {
  return storeIsLive(user) ? { name: user.store.name } : null;
}

// Keeps the count of approved goods on the pro's own record, so the
// public list of pros can show a store name without reading every good.
async function refreshStoreLive(providerId) {
  const user = await db.find('users', u => u.id === providerId);
  if (!user || !user.store) return;
  const goods = await db.filter('storeGoods', g => g.providerId === providerId);
  const liveGoods = goods.filter(isOnShelf).length;
  if ((user.store.liveGoods || 0) !== liveGoods) await db.update('users', providerId, { store: { ...user.store, liveGoods } });
}

// Prices a basket from the server's own records. Nothing the customer's
// browser says about names or prices is used: only which good and how many.
// Returns { items, total } or { error }.
async function priceBasket(providerId, rawItems) {
  if (rawItems === undefined || rawItems === null) return { items: [], total: 0 };
  if (!Array.isArray(rawItems)) return { error: 'The basket could not be read. Please pick your goods again.' };
  if (!rawItems.length) return { items: [], total: 0 };
  if (rawItems.length > MAX_LINES_PER_ORDER) return { error: `A booking can include at most ${MAX_LINES_PER_ORDER} different goods.` };
  const settings = await storeSettings();
  if (!settings.enabled) return { error: 'Stores are switched off at the moment, so goods can\'t be added to a booking.' };
  const provider = await db.find('users', u => u.id === providerId && u.role === 'provider');
  if (!provider || !storeIsLive(provider)) return { error: 'This pro\'s store isn\'t open right now. Remove the goods to carry on with the booking.' };
  const goods = await db.filter('storeGoods', g => g.providerId === providerId);
  const currencies = await currenciesFor(provider); // v108
  const merged = new Map();
  for (const it of rawItems) {
    if (!it || typeof it.goodId !== 'string') return { error: 'The basket could not be read. Please pick your goods again.' };
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) return { error: `Choose a quantity between 1 and ${MAX_QTY_PER_LINE} for each good.` };
    merged.set(it.goodId, (merged.get(it.goodId) || 0) + qty);
  }
  const items = [];
  for (const [goodId, qty] of merged) {
    if (qty > MAX_QTY_PER_LINE) return { error: `Choose a quantity between 1 and ${MAX_QTY_PER_LINE} for each good.` };
    const g = goods.find(x => x.id === goodId);
    if (!g || !isOnShelf(g)) return { error: 'One of the goods you picked is no longer in the store. Open the store and pick again.' };
    if (!inStock(g, qty)) return { error: g.stock > 0 ? `Only ${g.stock} of "${g.name}" left in the store.` : `"${g.name}" is sold out.` };
    const pf = goodPriceFields(g, currencies);
    const line = { goodId: g.id, name: g.name, unit: g.unit || null, unitPrice: pf.price, qty, lineTotal: money(pf.price * qty) };
    // v108: a good priced in local money keeps that price on the order, next to the dollars charged.
    if (pf.priceCurrency !== 'USD') { line.priceCurrency = pf.priceCurrency; line.priceSymbol = pf.priceSymbol; line.unitPriceLocal = pf.priceLocal; line.lineTotalLocal = money(pf.priceLocal * qty); }
    items.push(line);
  }
  return { items, total: money(items.reduce((s, i) => s + i.lineTotal, 0)) };
}

// Stock is held the moment a booking is made, so two customers can't
// both buy the last one, and given back if the booking doesn't go ahead.
async function holdStock(items) {
  for (const it of items || []) {
    const g = await db.find('storeGoods', x => x.id === it.goodId);
    if (g && g.stock !== null && g.stock !== undefined) {
      const left = Math.max(0, g.stock - it.qty);
      await db.update('storeGoods', g.id, { stock: left, sold: (g.sold || 0) + it.qty });
      // v106: tell the pro when a sale takes a good down to its warning level.
      const warnAt = (g.lowStockAt === null || g.lowStockAt === undefined) ? 0 : g.lowStockAt;
      if (left <= warnAt && g.stock > warnAt) {
        try { await require('./notify').notify(g.providerId, '📦', left === 0 ? `"${g.name}" is now sold out in your store.` : `"${g.name}" is running low: ${left} left.`, null, { section: 'store' }); } catch (e) { /* the sale still stands */ }
      }
    } else if (g) {
      await db.update('storeGoods', g.id, { sold: (g.sold || 0) + it.qty });
    }
  }
}
async function giveBackStock(contract) {
  if (!contract || !Array.isArray(contract.storeItems) || !contract.storeItems.length) return false;
  const fresh = await db.find('contracts', c => c.id === contract.id);
  if (!fresh || fresh.storeStockHeld !== true || fresh.storeStockGivenBack === true) return false;
  // Goods already handed over stay sold; a refund after that is a dispute matter.
  const h = fresh.handover || {};
  if ((h.dropoff && h.dropoff.length) || (h.pickup && h.pickup.length)) return false;
  // v108: the same when a driver has already collected them.
  if (fresh.deliveryContractId) {
    const d = await db.find('contracts', c => c.id === fresh.deliveryContractId);
    const dh = (d && d.handover) || {};
    if ((dh.pickup && dh.pickup.length) || (dh.dropoff && dh.dropoff.length)) return false;
  }
  await db.update('contracts', fresh.id, { storeStockGivenBack: true });
  for (const it of fresh.storeItems) {
    const g = await db.find('storeGoods', x => x.id === it.goodId);
    if (!g) continue;
    const patch = { sold: Math.max(0, (g.sold || 0) - it.qty) };
    if (g.stock !== null && g.stock !== undefined) patch.stock = g.stock + it.qty;
    await db.update('storeGoods', g.id, patch);
  }
  return true;
}

// Which of a pro's skills customers can find them under: the main one,
// plus every extra one a manager has approved (or that needed no check).
function approvedSkills(user) {
  const out = [];
  if (user && user.category) out.push(user.category);
  for (const s of (user && Array.isArray(user.extraSkills) ? user.extraSkills : [])) {
    if (s && s.status === 'approved' && s.category && !out.includes(s.category)) out.push(s.category);
  }
  return out;
}
function hasSkill(user, category) {
  return approvedSkills(user).includes(category);
}

module.exports = {
  STORE_DEFAULTS, DEFAULT_STORE_RULES, MAX_PHOTOS_PER_GOOD, MAX_QTY_PER_LINE, MAX_EXTRA_SKILLS, money,
  storeSettings, storeSettingsCached, saveStoreSettings,
  isOnShelf, inStock, storeIsLive, publicStore, refreshStoreLive,
  DELIVERY_METHODS, DELIVERY_LABELS, DRIVER_SKILL, VEHICLES, storeApproval, whyNotLive, WHY_NOT_LIVE_WORDS, storeOptions,
  currenciesFor, usdFromLocal, goodUsdPrice, goodPriceFields,
  priceBasket, holdStock, giveBackStock,
  approvedSkills, hasSkill,
};
