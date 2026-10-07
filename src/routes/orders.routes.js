// v108: store orders (goods bought with no job), delivery by a driver,
// and receipts. The rules are in plain words in src/store-orders.js.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { requireCurrentTerms } = require('../terms');
const { notify } = require('../notify');
const { isNonEmptyString } = require('../validators');
const { contractStatusLocks } = require('../contract-locks');
const store = require('../store');
const so = require('../store-orders');
const { money } = store;

const router = express.Router();
const today = () => new Date().toISOString().slice(0, 10);
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Customer';
const itemsLine = (items) => (items || []).map(i => `${i.qty} x ${i.name}`).join(', ');
const pct = (amount, percent) => money(Number(amount) * Number(percent) / 100);

// The same checks every booking makes of the customer.
async function customerCanBuy(req, res) {
  const customer = await db.find('users', u => u.id === req.user.sub);
  if (!customer || customer.verified !== true) {
    const openId = customer && await db.find('verifications', v => v.userId === customer.id && ['pending', 'review_required'].includes(v.status));
    if (openId) { res.status(403).json({ error: 'Your ID is being reviewed. You\'ll be able to buy as soon as it\'s approved, usually within 48 hours.' }); return null; }
    res.status(403).json({ code: 'VERIFY_IDENTITY', error: 'Please verify your identity first. Upload a government ID in the Verification section, and you can buy once it\'s been reviewed.' }); return null;
  }
  if (customer.onHold) { res.status(403).json({ error: 'Your account is temporarily paused pending a quick review. You\'ll be able to buy again shortly.' }); return null; }
  return customer;
}

// Where the goods are going. A pin, a landmark or an address: at least one.
function readDropoff(body) {
  const { readJobLocation } = require('./marketplace.routes');
  const where = readJobLocation(body || {});
  if (where.error) return { error: where.error };
  let address = typeof (body || {}).address === 'string' ? body.address.trim() : '';
  if (address.length > 200) return { error: 'The address must be under 200 characters' };
  if (address.length < 5 && (where.landmark || where.jobLocation)) address = where.landmark || 'Location pinned on the map';
  if (address.length < 5) return { error: 'Say where the goods should be brought: pin the place, describe a landmark, or type an address.' };
  return { address, landmark: where.landmark, jobLocation: where.jobLocation };
}

// Makes the booking with the driver for one order, and holds the money for it.
async function createDelivery({ order, seller, driver, where, payCurrency, expectedPrice }) {
  const { generateBookingNumber, fundEscrowForContract } = require('./marketplace.routes');
  const opt = store.storeOptions(seller);
  const settings = await store.storeSettings();
  const km = so.kmBetween(opt.pickupLocation, where.jobLocation);
  const price = so.quoteFor(driver, km);
  // The customer approved one price. If the driver changed their rates in
  // between, they are shown the new price instead of being charged it.
  if (expectedPrice !== undefined && Math.abs(Number(expectedPrice) - price) > 0.009) {
    return { error: `${driver.name}'s price is now $${price.toFixed(2)}. Check it and approve again.`, code: 'PRICE_CHANGED', price };
  }
  const rates = so.driverRates(driver);
  const delivery = {
    id: `ct_${nanoid(10)}`,
    bookingNumber: await generateBookingNumber(),
    customerId: order.customerId,
    providerId: driver.id,
    service: `Delivery: store order #${order.bookingNumber} from ${seller.store.name}`.slice(0, 200),
    date: today(), time: 'As soon as possible',
    address: where.address, jobLocation: where.jobLocation || null, landmark: where.landmark || null,
    amount: price,
    serviceFee: pct(price, settings.deliveryFeePercent),
    laborAmount: price,
    storeItems: [], storeGoodsTotal: 0, storeFee: 0, storeFeePaidBy: null, goodsOnly: false, materialsCost: null, storeStockHeld: false,
    loyaltyPointsRedeemed: 0, materialsAdvance: 0, materialsOnHand: null, photoUrls: [],
    status: 'pending_provider_confirmation',
    payCurrency: payCurrency === 'local' ? 'local' : 'usd',
    signedAt: null,
    providerResponseDeadline: new Date(Date.now() + so.DELIVERY_RESPONSE_MINUTES * 60 * 1000).toISOString(),
    delivery: {
      forContractId: order.id, orderNumber: order.bookingNumber, sellerId: seller.id, storeName: seller.store.name,
      pickupPlace: opt.pickupPlace || [seller.city, seller.country].filter(Boolean).join(', '), pickupLocation: opt.pickupLocation,
      distanceKm: km, vehicle: rates.vehicle, items: itemsLine(order.storeItems).slice(0, 300), itemCount: (order.storeItems || []).reduce((n, i) => n + i.qty, 0),
    },
    createdAt: new Date().toISOString(),
  };
  await db.insert('contracts', delivery);
  await fundEscrowForContract(delivery, order.customerId, payCurrency);
  await db.update('contracts', order.id, { deliveryMethod: 'driver', deliveryContractId: delivery.id, address: where.address, jobLocation: where.jobLocation || null, landmark: where.landmark || null });
  const by = new Date(delivery.providerResponseDeadline).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  await notify(driver.id, '🚚', `Delivery request: collect store order #${order.bookingNumber} (${delivery.delivery.items.slice(0, 80)}) from ${seller.store.name}, ${delivery.delivery.pickupPlace}, and take it to the customer${km ? `, about ${so.distWords(km, driver.country)}` : ''}. You are paid $${price.toFixed(2)}. Accept or decline within ${so.DELIVERY_RESPONSE_MINUTES} minutes (by ${by} server time).`, 'bookingUpdates', { section: 'bookings' });
  return { delivery };
}

// One order, as the person asking is allowed to see it.
async function orderView(order, viewerId) {
  const seller = await db.find('users', u => u.id === order.providerId);
  const customer = await db.find('users', u => u.id === order.customerId);
  const escrow = await db.find('escrowTransactions', e => e.contractId === order.id);
  const d = await so.deliveryOf(order);
  const iAmSeller = viewerId === order.providerId;
  const opt = seller ? store.storeOptions(seller) : { pickupPlace: '', pickupLocation: null, hours: '' };
  let delivery = null;
  if (d) {
    const driver = await db.find('users', u => u.id === d.providerId);
    const h = d.handover || {};
    delivery = {
      contractId: d.id, number: d.bookingNumber, status: d.status, price: d.amount, serviceFee: d.serviceFee || 0,
      distanceKm: (d.delivery && d.delivery.distanceKm) || null, answerBy: d.status === 'pending_provider_confirmation' ? d.providerResponseDeadline : null,
      driver: driver ? { id: driver.id, name: driver.name, vehicle: so.driverRates(driver).vehicle, rating: driver.rating || null, profilePhotoUrl: driver.profilePhotoUrl || null, initials: driver.initials || null, color: driver.color || null } : null,
      pickedUpAt: (h.pickup && h.pickup[0] && h.pickup[0].at) || null, droppedOffAt: (h.dropoff && h.dropoff[0] && h.dropoff[0].at) || null,
      // enough of the delivery booking for the hand-over window to open on it
      raw: { id: d.id, service: d.service, status: d.status, handover: d.handover || null, delivery: d.delivery, providerId: d.providerId, customerId: d.customerId },
    };
  }
  const live = so.isLive(d);
  const method = order.deliveryMethod || 'pickup';
  return {
    id: order.id, number: order.bookingNumber, createdAt: order.createdAt, status: order.status, completedAt: order.completedAt || null,
    items: order.storeItems || [], goodsTotal: order.storeGoodsTotal || 0,
    deliveryMethod: method, sellerDeliveryFee: order.sellerDeliveryFee || 0,
    storeFee: order.storeFeePaidBy === 'customer' ? (order.storeFee || 0) : 0, storeFeeFromSeller: order.storeFeePaidBy === 'pro' ? (order.storeFee || 0) : 0,
    serviceFee: order.serviceFee || 0, amount: order.amount, totalPaid: money((order.amount || 0) + (order.serviceFee || 0)),
    paidCurrency: escrow ? escrow.paidCurrency : 'USD', paidAmountLocal: escrow ? escrow.paidAmountLocal : null, moneyStatus: escrow ? escrow.status : 'none',
    readyAt: order.readyAt || null, note: order.orderNote || null,
    store: seller ? { providerId: seller.id, name: (seller.store && seller.store.name) || seller.name, sellerName: seller.name, hours: opt.hours } : null,
    pickup: { place: order.pickupPlace || opt.pickupPlace || '', location: order.pickupLocation || opt.pickupLocation || null },
    // Where it is going: shown to the seller only when the seller is the one bringing it.
    dropoff: method === 'pickup' ? null : (!iAmSeller || method === 'seller') ? { address: order.address, landmark: order.landmark || null, location: order.jobLocation || null } : { address: null, landmark: null, location: null },
    customer: customer ? { name: iAmSeller ? `${firstName(customer.name)} ${String(customer.name || '').trim().split(/\s+/).slice(-1)[0][0] || ''}.`.replace(/ \.$/, '') : customer.name } : null,
    delivery,
    // The customer can pick a driver (or switch to collecting) while the order is open and nobody is on the way.
    canArrangeDelivery: order.status === 'active' && method !== 'seller' && !live,
    handover: order.handover || null,
  };
}

// ── DRIVERS ────────────────────────────────────────────────────────────
// GET /api/delivery/rates — a pro's own delivery prices.
router.get('/delivery/rates', requireAuth, requireRole('provider'), async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  const settings = await store.storeSettings();
  res.json({ hasSkill: store.hasSkill(me, store.DRIVER_SKILL), offered: so.isDriver(me), rates: so.driverRates(me), vehicles: store.VEHICLES, skill: store.DRIVER_SKILL, feePercent: settings.deliveryFeePercent, hasLocation: typeof me.latitude === 'number' });
});
router.put('/delivery/rates', requireAuth, requireRole('provider'), async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!store.hasSkill(me, store.DRIVER_SKILL)) return res.status(403).json({ error: `Add "${store.DRIVER_SKILL}" to your skills first. Delivery prices are for pros who do pick-and-drop.` });
  const { vehicle, baseFee, perKm } = req.body || {};
  if (!store.VEHICLES.includes(vehicle)) return res.status(400).json({ error: 'Choose what you deliver with' });
  if (typeof baseFee !== 'number' || !(baseFee >= 1) || baseFee > 500) return res.status(400).json({ error: 'Your starting price must be between $1 and $500' });
  if (typeof perKm !== 'number' || perKm < 0 || perKm > 50) return res.status(400).json({ error: 'Your price per kilometre must be between $0 and $50' });
  await db.update('users', me.id, { deliveryRates: { vehicle, baseFee: money(baseFee), perKm: Math.round(perKm * 10000) / 10000, updatedAt: new Date().toISOString() } });
  const after = await db.find('users', u => u.id === me.id);
  res.json({ rates: so.driverRates(after), offered: so.isDriver(after) });
});

// GET /api/store/drivers?providerId=&latitude=&longitude= — drivers for one store's orders.
const driverLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait a moment.' } });
router.get('/store/drivers', requireAuth, driverLimiter, async (req, res) => {
  const seller = await db.find('users', u => u.id === req.query.providerId && u.role === 'provider');
  if (!seller || !store.storeIsLive(seller)) return res.status(404).json({ error: 'This store isn\'t open right now.' });
  if (!store.storeOptions(seller).deliveryMethods.includes('driver')) return res.json({ drivers: [], distanceKm: null, totalFound: 0, notOffered: true });
  const lat = Number(req.query.latitude), lng = Number(req.query.longitude);
  const { isValidCoordinate } = require('../geo-distance');
  const dropoff = (req.query.latitude !== undefined && isValidCoordinate(lat, lng) && !(lat === 0 && lng === 0)) ? { latitude: lat, longitude: lng } : null;
  const out = await so.suggestDrivers({ seller, dropoff, customerId: req.user.sub });
  const settings = await store.storeSettings();
  res.json({ ...out, feePercent: settings.deliveryFeePercent, storeHasPin: !!store.storeOptions(seller).pickupLocation, answerMinutes: so.DELIVERY_RESPONSE_MINUTES });
});

// ── BUYING ─────────────────────────────────────────────────────────────
// POST /api/store/orders { providerId, items, deliveryMethod, driverId, driverPrice, jobLocation, landmark, address, note, payCurrency }
router.post('/store/orders', requireAuth, requireRole('customer'), requireCurrentTerms, async (req, res) => {
  const customer = await customerCanBuy(req, res);
  if (!customer) return;
  const b = req.body || {};
  const seller = await db.find('users', u => u.id === b.providerId && u.role === 'provider');
  if (!seller) return res.status(404).json({ error: 'Store not found' });
  const basket = await store.priceBasket(seller.id, b.items);
  if (basket.error) return res.status(400).json({ error: basket.error });
  if (!basket.items.length) return res.status(400).json({ error: 'Pick at least one good from the store.' });
  const opt = store.storeOptions(seller);
  const method = b.deliveryMethod;
  if (!store.DELIVERY_METHODS.includes(method)) return res.status(400).json({ error: 'Choose how you want to get your goods.' });
  if (!opt.deliveryMethods.includes(method)) return res.status(400).json({ error: `This store doesn't offer that. Choose one of: ${opt.deliveryMethods.map(m => store.DELIVERY_LABELS[m].toLowerCase()).join('; ')}.` });
  if (b.note !== undefined && b.note !== null && b.note !== '' && !isNonEmptyString(b.note, { max: 300 })) return res.status(400).json({ error: 'The note to the seller must be under 300 characters' });
  let where = null, driver = null;
  if (method !== 'pickup') {
    where = readDropoff(b);
    if (where.error) return res.status(400).json({ error: where.error });
  }
  if (method === 'driver') {
    driver = await db.find('users', u => u.id === b.driverId);
    if (!driver || !so.isDriver(driver) || driver.id === seller.id || driver.id === customer.id || String(driver.country || '').toLowerCase() !== String(seller.country || '').toLowerCase()) {
      return res.status(400).json({ code: 'PICK_DRIVER', error: 'Choose a driver from the list. The one you picked isn\'t available any more.' });
    }
    // Checked before anything is charged, so a changed price never leaves a half-made order.
    const price = so.quoteFor(driver, so.kmBetween(opt.pickupLocation, where.jobLocation));
    if (b.driverPrice === undefined || Math.abs(Number(b.driverPrice) - price) > 0.009) {
      return res.status(409).json({ code: 'PRICE_CHANGED', price, error: `${driver.name}'s price for this trip is $${price.toFixed(2)}. Check it and approve again.` });
    }
  }
  const settings = await store.storeSettings();
  const { generateBookingNumber, fundEscrowForContract } = require('./marketplace.routes');
  const sellerDeliveryFee = method === 'seller' ? opt.deliveryFee : 0;
  const storeFee = settings.purchaseFee;
  const storeFeePaidBy = settings.feePaidBy === 'pro' ? 'pro' : 'customer';
  const pickupPlace = opt.pickupPlace || [seller.city, seller.country].filter(Boolean).join(', ');
  const order = {
    id: `ct_${nanoid(10)}`,
    bookingNumber: await generateBookingNumber(),
    customerId: customer.id,
    providerId: seller.id,
    service: ('Store order: ' + itemsLine(basket.items)).slice(0, 200),
    date: today(), time: 'Store order',
    address: method === 'pickup' ? `Collect from ${seller.store.name}: ${pickupPlace}`.slice(0, 200) : where.address,
    jobLocation: where ? (where.jobLocation || null) : null,
    landmark: where ? (where.landmark || null) : null,
    amount: money(basket.total + sellerDeliveryFee),
    // What the customer pays on top: the flat store fee (if the customer pays it) and Trothen's share of the seller's delivery charge.
    serviceFee: money((storeFeePaidBy === 'customer' ? storeFee : 0) + pct(sellerDeliveryFee, settings.deliveryFeePercent)),
    laborAmount: sellerDeliveryFee, // delivery is a service; the goods are not
    storeItems: basket.items, storeGoodsTotal: basket.total, storeFee, storeFeePaidBy,
    goodsOnly: true, storeOrder: true, materialsCost: basket.total, storeStockHeld: true,
    deliveryMethod: method, sellerDeliveryFee, pickupPlace, pickupLocation: opt.pickupLocation,
    orderNote: b.note ? String(b.note).trim() : null,
    loyaltyPointsRedeemed: 0, materialsAdvance: 0, materialsOnHand: null, photoUrls: [],
    // A store order is confirmed the moment it is paid for: the seller put
    // the goods on the shelf at that price. There is nothing to accept.
    status: 'active', signedAt: today(), providerResponseDeadline: null,
    payCurrency: b.payCurrency === 'local' ? 'local' : 'usd',
    createdAt: new Date().toISOString(),
  };
  await db.insert('contracts', order);
  await store.holdStock(basket.items);
  await fundEscrowForContract(order, customer.id, order.payCurrency);
  try { await require('../fraud-detection').checkNewAccountHighValue(customer.id, order.amount); } catch (e) { /* the order stands */ }
  const count = basket.items.reduce((n, i) => n + i.qty, 0);
  const how = method === 'pickup' ? 'The customer will collect it.' : method === 'seller' ? `Bring it to the customer: ${where.address}. Your delivery charge of $${sellerDeliveryFee.toFixed(2)} is included.` : `A driver (${driver.name}) has been asked to collect it.`;
  await notify(seller.id, '🛍️', `New store order #${order.bookingNumber} from ${firstName(customer.name)}: ${count} good${count === 1 ? '' : 's'} ($${basket.total.toFixed(2)}). ${how} The money is held and is released to you when the customer confirms they have the goods.`, 'bookingUpdates', { section: 'store' });
  if (driver) await createDelivery({ order, seller, driver, where, payCurrency: order.payCurrency });
  const fresh = await db.find('contracts', c => c.id === order.id);
  res.status(201).json({ order: await orderView(fresh, customer.id) });
});

// GET /api/store/orders/mine
router.get('/store/orders/mine', requireAuth, async (req, res) => {
  const me = req.user.sub;
  if (req.user.role === 'customer') {
    const orders = (await db.filter('contracts', c => c.customerId === me && c.storeOrder === true)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return res.json({ orders: await Promise.all(orders.slice(0, 100).map(o => orderView(o, me))) });
  }
  if (req.user.role !== 'provider') return res.status(403).json({ error: 'Store orders are for customers and pros' });
  const selling = (await db.filter('contracts', c => c.providerId === me && c.storeOrder === true)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const mine = (await db.filter('contracts', c => c.providerId === me && c.delivery)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const delivering = [];
  for (const d of mine.slice(0, 100)) {
    const order = await db.find('contracts', c => c.id === d.delivery.forContractId);
    const h = d.handover || {};
    delivering.push({
      contractId: d.id, number: d.bookingNumber, status: d.status, price: d.amount, createdAt: d.createdAt, answerBy: d.status === 'pending_provider_confirmation' ? d.providerResponseDeadline : null,
      orderNumber: d.delivery.orderNumber, storeName: d.delivery.storeName, items: d.delivery.items, itemCount: d.delivery.itemCount, distanceKm: d.delivery.distanceKm,
      pickup: { place: d.delivery.pickupPlace, location: d.delivery.pickupLocation || null },
      dropoff: { address: d.address, landmark: d.landmark || null, location: d.jobLocation || null },
      orderStatus: order ? order.status : null, orderReadyAt: order ? (order.readyAt || null) : null,
      pickedUpAt: (h.pickup && h.pickup[0] && h.pickup[0].at) || null, droppedOffAt: (h.dropoff && h.dropoff[0] && h.dropoff[0].at) || null,
    });
  }
  res.json({ selling: await Promise.all(selling.slice(0, 100).map(o => orderView(o, me))), delivering });
});

// POST /api/store/orders/:id/ready — the seller says the goods are packed.
router.post('/store/orders/:id/ready', requireAuth, requireRole('provider'), async (req, res) => {
  const order = await db.find('contracts', c => c.id === req.params.id && c.providerId === req.user.sub && c.storeOrder === true);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'active') return res.status(400).json({ error: `This order is ${String(order.status).replace(/_/g, ' ')}.` });
  if (order.readyAt) return res.json({ order: await orderView(order, req.user.sub) });
  const updated = await db.update('contracts', order.id, { readyAt: new Date().toISOString() });
  const seller = await db.find('users', u => u.id === order.providerId);
  const name = (seller && seller.store && seller.store.name) || 'The store';
  const method = order.deliveryMethod || 'pickup';
  await notify(order.customerId, '📦', method === 'pickup' ? `Your store order #${order.bookingNumber} is ready to collect from ${name}: ${order.pickupPlace || 'see the order for the place'}.` : method === 'seller' ? `Your store order #${order.bookingNumber} is packed. ${name} will bring it to you.` : `Your store order #${order.bookingNumber} is packed and waiting for the driver.`, 'bookingUpdates', { section: 'orders' });
  const d = await so.deliveryOf(order);
  if (d && d.status === 'active') await notify(d.providerId, '📦', `Store order #${order.bookingNumber} is packed and ready for you to collect from ${name}.`, 'bookingUpdates', { section: 'bookings' });
  res.json({ order: await orderView(updated, req.user.sub) });
});

// POST /api/store/orders/:id/delivery — the customer picks a driver after
// the first one fell through, changes from collecting to a driver, or the
// other way round. { deliveryMethod: 'driver'|'pickup', driverId, driverPrice, jobLocation, landmark, address }
router.post('/store/orders/:id/delivery', requireAuth, requireRole('customer'), requireCurrentTerms, async (req, res) => {
  if (contractStatusLocks.has(req.params.id)) return res.status(409).json({ error: 'This order is already being updated. Please try again in a moment.' });
  contractStatusLocks.add(req.params.id);
  try {
    const order = await db.find('contracts', c => c.id === req.params.id && c.customerId === req.user.sub && c.storeOrder === true);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'active') return res.status(400).json({ error: `This order is ${String(order.status).replace(/_/g, ' ')}, so its delivery can't be changed.` });
    if (order.deliveryMethod === 'seller') return res.status(400).json({ error: 'The seller is bringing this order, and you have paid them for that. To change it, cancel the order and buy again.' });
    if (so.isLive(await so.deliveryOf(order))) return res.status(409).json({ error: 'A driver is already on this order. Cancel that delivery first if you want a different one.' });
    const seller = await db.find('users', u => u.id === order.providerId);
    const opt = store.storeOptions(seller);
    const b = req.body || {};
    if (b.deliveryMethod === 'pickup') {
      if (!opt.deliveryMethods.includes('pickup')) return res.status(400).json({ error: 'This store doesn\'t offer collection.' });
      const pickupPlace = order.pickupPlace || opt.pickupPlace || [seller.city, seller.country].filter(Boolean).join(', ');
      const updated = await db.update('contracts', order.id, { deliveryMethod: 'pickup', address: `Collect from ${seller.store.name}: ${pickupPlace}`.slice(0, 200), jobLocation: null, landmark: null });
      await notify(seller.id, '🛍️', `The customer will now collect store order #${order.bookingNumber} themselves.`, 'bookingUpdates', { section: 'store' });
      return res.json({ order: await orderView(updated, req.user.sub) });
    }
    if (b.deliveryMethod !== 'driver') return res.status(400).json({ error: 'Choose a driver, or choose to collect it yourself.' });
    if (!opt.deliveryMethods.includes('driver')) return res.status(400).json({ error: 'This store doesn\'t offer delivery by a driver.' });
    // Use the place already on the order unless a new one was sent.
    const sentPlace = b.jobLocation || b.landmark || b.address;
    const where = sentPlace || order.deliveryMethod === 'pickup' || !order.address ? readDropoff(b) : { address: order.address, landmark: order.landmark, jobLocation: order.jobLocation };
    if (where.error) return res.status(400).json({ error: where.error });
    const driver = await db.find('users', u => u.id === b.driverId);
    if (!driver || !so.isDriver(driver) || driver.id === seller.id || driver.id === req.user.sub || String(driver.country || '').toLowerCase() !== String(seller.country || '').toLowerCase()) {
      return res.status(400).json({ code: 'PICK_DRIVER', error: 'Choose a driver from the list. The one you picked isn\'t available any more.' });
    }
    if (b.driverPrice === undefined) return res.status(400).json({ error: 'Approve the driver\'s price first.' });
    const made = await createDelivery({ order, seller, driver, where, payCurrency: order.payCurrency, expectedPrice: b.driverPrice });
    if (made.error) return res.status(409).json({ code: made.code, price: made.price, error: made.error });
    await notify(seller.id, '🚚', `A driver (${driver.name}) has been asked to collect store order #${order.bookingNumber}.`, 'bookingUpdates', { section: 'store' });
    const fresh = await db.find('contracts', c => c.id === order.id);
    res.json({ order: await orderView(fresh, req.user.sub) });
  } finally { contractStatusLocks.delete(req.params.id); }
});

// POST /api/store/orders/:id/received — "I have my goods". Releases the
// seller's money, and the driver's if a driver brought them.
router.post('/store/orders/:id/received', requireAuth, requireRole('customer'), async (req, res) => {
  if (contractStatusLocks.has(req.params.id)) return res.status(409).json({ error: 'This order is already being updated. Please try again in a moment.' });
  contractStatusLocks.add(req.params.id);
  try {
    const order = await db.find('contracts', c => c.id === req.params.id && c.customerId === req.user.sub && c.storeOrder === true);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'active') return res.status(400).json({ error: `This order is already ${String(order.status).replace(/_/g, ' ')}.` });
    const { completeContractCore } = require('./payments.routes');
    const done = await completeContractCore(order, 0, req.user.sub);
    await so.afterComplete(order, req.user.sub);
    res.json({ order: await orderView(done.contract, req.user.sub) });
  } finally { contractStatusLocks.delete(req.params.id); }
});

// ── RECEIPTS ───────────────────────────────────────────────────────────
// GET /api/store/orders/:id/receipt — a PDF receipt for any booking that
// includes goods from a store, for the customer and for the seller. For a
// delivery booking, a receipt for the customer and the driver.
router.get('/store/orders/:id/receipt', requireAuth, async (req, res) => {
  const c = await db.find('contracts', x => x.id === req.params.id && (x.customerId === req.user.sub || x.providerId === req.user.sub));
  if (!c) return res.status(404).json({ error: 'Not found' });
  const hasGoods = Array.isArray(c.storeItems) && c.storeItems.length > 0;
  if (!hasGoods && !c.delivery) return res.status(404).json({ error: 'There is no store receipt for this booking.' });
  const escrow = await db.find('escrowTransactions', e => e.contractId === c.id);
  if (!escrow) return res.status(409).json({ error: 'Nothing has been paid on this yet, so there is no receipt.' });
  const seller = await db.find('users', u => u.id === c.providerId);
  const customer = await db.find('users', u => u.id === c.customerId);
  const iAmCustomer = c.customerId === req.user.sub;
  const { createReportDoc } = require('../pdf-report-builder');
  const number = `R-${c.bookingNumber || c.id}`;
  const $ = (n) => `$${Number(n || 0).toFixed(2)}`;
  const storeName = c.delivery ? (seller ? seller.name : 'Driver') : ((seller && seller.store && seller.store.name) || (seller && seller.name) || 'Store');
  const r = createReportDoc({ res, filename: `Receipt-${number}.pdf`, title: c.delivery ? 'Delivery Receipt' : 'Store Receipt', subtitle: `From ${storeName}`.slice(0, 90), docId: number, verificationSeed: `receipt|${c.id}|${c.amount}|${escrow.status}` });
  r.sectionHeader(c.delivery ? 'Delivered by' : 'Sold by');
  r.row(storeName, c.delivery ? [so.driverRates(seller || {}).vehicle, seller && seller.city].filter(Boolean).join('  ·  ') : [seller && seller.name, seller && [seller.city, seller.country].filter(Boolean).join(', ')].filter(Boolean).join('  ·  '));
  r.sectionHeader(c.delivery ? 'Delivered to' : 'Sold to');
  r.row(customer ? customer.name : 'Customer', iAmCustomer || c.deliveryMethod === 'seller' || c.delivery ? (c.deliveryMethod === 'pickup' ? '' : String(c.address || '').slice(0, 90)) : '');
  r.twoColumnRow('Receipt number', number, 'Date', String(c.createdAt || '').slice(0, 10));
  const moneyLine = escrow.status === 'held' ? 'Paid. Held by Trothen until the customer confirms they have the goods.'
    : escrow.status === 'released' ? `Paid${c.completedAt ? ' and received on ' + String(c.completedAt).slice(0, 10) : ''}. Released to the ${c.delivery ? 'driver' : 'seller'}.`
    : escrow.status === 'refunded' ? 'Refunded to the customer.' : String(escrow.status);
  r.row('Payment', moneyLine);
  let driverPart = 0;
  if (c.delivery) {
    r.sectionHeader('Delivery');
    r.row('For', `Store order #${c.delivery.orderNumber} from ${c.delivery.storeName}`);
    r.row('Collected from', String(c.delivery.pickupPlace || '').slice(0, 90));
    if (c.delivery.distanceKm) r.row('Distance', `About ${so.distWords(c.delivery.distanceKm, seller && seller.country)}`);
    r.twoColumnRow('Delivery price', $(c.amount), iAmCustomer ? 'Trothen service fee' : ' ', iAmCustomer ? $(c.serviceFee) : ' ');
    if (iAmCustomer) r.twoColumnRow('Total paid', $(money(c.amount + (c.serviceFee || 0))), escrow.paidAmountLocal ? `Paid in ${escrow.paidCurrency}` : ' ', escrow.paidAmountLocal ? String(escrow.paidAmountLocal) : ' ');
  } else {
    r.sectionHeader('Goods');
    r.table(
      [{ label: 'Good', width: 230 }, { label: 'Qty', width: 50, align: 'right' }, { label: 'Each', width: 110, align: 'right' }, { label: 'Total', width: 90, align: 'right' }],
      c.storeItems.map(i => [String(i.name).slice(0, 44) + (i.unit ? ` (${String(i.unit).slice(0, 12)})` : ''), String(i.qty), i.priceCurrency ? `${i.priceCurrency} ${Number(i.unitPriceLocal).toFixed(2)} = ${$(i.unitPrice)}` : $(i.unitPrice), $(i.lineTotal)])
    );
    r.y += 14;
    const labour = money((c.amount || 0) - (c.storeGoodsTotal || 0));
    const customerStoreFee = c.storeFeePaidBy === 'customer' ? (c.storeFee || 0) : 0;
    r.twoColumnRow('Goods total', $(c.storeGoodsTotal), c.storeOrder ? (c.sellerDeliveryFee > 0 ? 'Seller\'s delivery charge' : 'Delivery') : 'Job amount', c.storeOrder ? (c.sellerDeliveryFee > 0 ? $(c.sellerDeliveryFee) : (store.DELIVERY_LABELS[c.deliveryMethod || 'pickup'] || '').replace(/^I collect it myself$/, 'Collected by the customer')) : $(labour));
    if (iAmCustomer) {
      r.twoColumnRow('Store purchase fee', customerStoreFee > 0 ? $(customerStoreFee) : 'None', 'Trothen service fee', $(money((c.serviceFee || 0) - customerStoreFee)));
      // A driver's delivery is a separate payment; show it so the customer has one piece of paper.
      const d = await so.deliveryOf(c);
      if (d && ['active', 'completed'].includes(d.status)) {
        const driver = await db.find('users', u => u.id === d.providerId);
        driverPart = money(d.amount + (d.serviceFee || 0));
        r.twoColumnRow(`Delivery by ${driver ? driver.name : 'a driver'}`.slice(0, 40), $(d.amount), 'Service fee on delivery', $(d.serviceFee));
      }
      r.twoColumnRow('Total paid', $(money((c.amount || 0) + (c.serviceFee || 0) + driverPart)), escrow.paidAmountLocal ? `Goods paid in ${escrow.paidCurrency}` : ' ', escrow.paidAmountLocal ? String(escrow.paidAmountLocal) : ' ');
    } else {
      r.twoColumnRow('Customer paid you', $(c.amount), c.storeFeePaidBy === 'pro' ? 'Store purchase fee (taken at payout)' : ' ', c.storeFeePaidBy === 'pro' ? `- ${$(Math.min(c.storeFee || 0, c.storeGoodsTotal || 0))}` : ' ');
    }
    if (c.orderNote && (iAmCustomer || c.storeOrder)) { r.sectionHeader('Note from the customer'); r.paragraph(String(c.orderNote), { size: 10, color: '#12161F' }); }
  }
  const simulated = process.env.PAYMENTS_LIVE === 'true' ? '' : ' Payments are simulated during early access: no real money moved.';
  r.finish({ closingNote: c.delivery
    ? 'This delivery was booked and paid for through Trothen. The driver named above carried the goods; Trothen held the payment. Amounts are in US dollars.' + simulated
    : 'These goods were sold by the seller named above, not by Trothen. Trothen held the payment and released it when the customer confirmed they had the goods. Amounts are in US dollars.' + simulated + ' If something is missing, wrong or damaged, use "Report a Problem" on the order.' });
});

module.exports = router;
