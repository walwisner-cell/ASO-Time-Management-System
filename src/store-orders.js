// v108: store orders and their delivery.
//
// A store order is goods bought from a pro's store with no job attached.
// The customer chooses how the goods reach them:
//
//   pickup  - the customer collects from the seller
//   seller  - the seller brings them, for the seller's own delivery charge
//   driver  - a pick-and-drop driver brings them. Trothen suggests drivers,
//             the customer picks one and approves that driver's price.
//
// How it is kept: the order is a booking with the seller (so the money is
// held, paid out, refunded and disputed exactly like every other booking).
// A driver's delivery is a second booking, with the driver, tied to the
// order. That way the driver is paid separately from the seller, has to
// accept the job, and records pick-up and drop-off with photos and a route
// using the hand-over tools that already exist.
//
// This file holds what other files call. The web addresses are in
// src/routes/orders.routes.js.
const db = require('./db');
const { notify } = require('./notify');
const store = require('./store');
const { distanceInMiles } = require('./geo-distance');

const KM_PER_MILE = 1.609344;
const DELIVERY_RESPONSE_MINUTES = 30; // how long a driver has to answer
const MAX_DRIVERS_SUGGESTED = 6;
const money = store.money;

function kmBetween(a, b) {
  if (!a || !b || typeof a.latitude !== 'number' || typeof b.latitude !== 'number') return null;
  return Math.round(distanceInMiles(a.latitude, a.longitude, b.latitude, b.longitude) * KM_PER_MILE * 10) / 10;
}
// Miles where people use miles (the US, Liberia, the UK), kilometres
// elsewhere: the same rule the page uses.
const MILE_COUNTRIES = ['United States', 'Liberia', 'United Kingdom', 'Myanmar'];
function distWords(km, country) {
  if (km == null) return '';
  if (!country || MILE_COUNTRIES.includes(country)) return `${(km / KM_PER_MILE).toFixed(1).replace(/\.0$/, '')} mi`;
  return `${km < 10 ? km.toFixed(1).replace(/\.0$/, '') : Math.round(km)} km`;
}
const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// A driver is a verified pro with the "Pick & Drop" skill who is taking work.
function isDriver(u) {
  return !!(u && u.role === 'provider' && u.verified === true && u.active !== false && u.onHold !== true && u.acceptingBookings !== false && store.hasSkill(u, store.DRIVER_SKILL));
}
// What a driver charges: a starting price, plus a price per kilometre.
// A driver who hasn't set these is offered at their listed price, flat.
function driverRates(u) {
  const r = (u && u.deliveryRates) || {};
  const base = Number(r.baseFee), perKm = Number(r.perKm);
  const set = Number.isFinite(base) && base > 0;
  return {
    vehicle: store.VEHICLES.includes(r.vehicle) ? r.vehicle : null,
    baseFee: set ? money(base) : money(Number(u && u.price) > 0 ? u.price : 5),
    perKm: set && Number.isFinite(perKm) && perKm >= 0 ? Math.round(perKm * 10000) / 10000 : 0, // kept to 4 places so a price per mile converts cleanly
    isSet: set,
  };
}
function quoteFor(u, km) {
  const r = driverRates(u);
  return Math.max(1, money(r.baseFee + (km ? r.perKm * km : 0)));
}

// The drivers to offer for one order: same country as the seller, the
// seller's own city first, then nearest to the store, then best rated.
async function suggestDrivers({ seller, dropoff, customerId }) {
  const opt = store.storeOptions(seller);
  const km = kmBetween(opt.pickupLocation, dropoff);
  const all = (await db.filter('users', u => isDriver(u) && u.id !== seller.id && u.id !== customerId && sameText(u.country, seller.country)));
  const rows = all.map(u => {
    const rates = driverRates(u);
    const toStore = (typeof u.latitude === 'number' && typeof u.longitude === 'number') ? kmBetween({ latitude: u.latitude, longitude: u.longitude }, opt.pickupLocation) : null;
    return {
      id: u.id, name: u.name, initials: u.initials || null, color: u.color || null, profilePhotoUrl: u.profilePhotoUrl || null,
      city: u.city || '', rating: u.rating || null, jobs: u.jobs || 0,
      isNewPro: u.trustScoreProvisional === true || u.trustScore == null, trustScore: (u.trustScore != null && u.trustScoreProvisional !== true) ? u.trustScore : null,
      vehicle: rates.vehicle, baseFee: rates.baseFee, perKm: rates.perKm,
      price: quoteFor(u, km), kmFromStore: toStore, sameCity: sameText(u.city, seller.city),
    };
  });
  rows.sort((a, b) => (b.sameCity - a.sameCity)
    || ((a.kmFromStore === null ? 1e9 : a.kmFromStore) - (b.kmFromStore === null ? 1e9 : b.kmFromStore))
    || ((b.rating || 0) - (a.rating || 0)) || (a.price - b.price));
  return { drivers: rows.slice(0, MAX_DRIVERS_SUGGESTED), distanceKm: km, totalFound: rows.length };
}

const isLive = (c) => !!c && ['pending_provider_confirmation', 'active'].includes(c.status);
async function deliveryOf(order) {
  return order && order.deliveryContractId ? db.find('contracts', c => c.id === order.deliveryContractId) : null;
}

// Something happened to a delivery booking: the driver said yes or no,
// didn't answer, or it was cancelled. Tells the people who need to know.
async function deliveryEvent(delivery, event) {
  const d = delivery.delivery || {};
  const order = await db.find('contracts', c => c.id === d.forContractId);
  const driver = await db.find('users', u => u.id === delivery.providerId);
  const who = driver ? driver.name : 'The driver';
  const n = d.orderNumber || (order && order.bookingNumber) || '';
  if (event === 'accepted') {
    await notify(delivery.customerId, '🚚', `${who} accepted the delivery of your store order #${n} for $${delivery.amount}. They will collect it from ${d.storeName || 'the seller'} and bring it to you.`, 'bookingUpdates', { section: 'orders' });
    if (d.sellerId) await notify(d.sellerId, '🚚', `${who} will collect store order #${n}. When you hand it over, record the pick-up with a photo so there is a record of what left your hands.`, 'bookingUpdates', { section: 'store' });
    return;
  }
  const orderStillOpen = order && order.status === 'active';
  const why = event === 'declined' ? `${who} can't take the delivery of` : event === 'expired' ? `${who} didn't answer in time for the delivery of` : `The delivery was cancelled for`;
  if (orderStillOpen) {
    await notify(delivery.customerId, '🚚', `${why} your store order #${n}. The $${delivery.amount} you paid for delivery was refunded. Choose another driver, or collect it yourself, from Store Orders.`, 'bookingUpdates', { section: 'orders' });
    if (d.sellerId) await notify(d.sellerId, '🚚', `The driver for store order #${n} fell through. The customer has been asked to choose another, or to collect it.`, 'bookingUpdates', { section: 'store' });
  }
}

// Runs after any booking is cancelled.
async function afterCancel(contract, byUserId) {
  // The order was cancelled: a delivery that hasn't collected the goods goes with it.
  if (contract.storeOrder && contract.deliveryContractId) {
    const d = await deliveryOf(contract);
    if (isLive(d)) {
      const h = d.handover || {};
      if ((h.pickup || []).length) {
        await notify(d.providerId, '⚠️', `Store order #${contract.bookingNumber} was cancelled after you collected it. Do not deliver it. Take the goods back to the seller and record that with a photo. Contact support if you need help.`, 'bookingUpdates', { section: 'bookings' });
      } else {
        const esc = await db.find('escrowTransactions', e => e.contractId === d.id);
        if (esc && esc.status === 'held') await db.update('escrowTransactions', esc.id, { status: 'refunded' });
        await db.update('contracts', d.id, { status: 'cancelled', cancelledByRole: 'order_cancelled', cancelReasonCategory: 'other' });
        await notify(d.providerId, '🚫', `The store order you were going to deliver (#${contract.bookingNumber}) was cancelled, so the delivery is cancelled too.`, 'bookingUpdates', { section: 'bookings' });
      }
    }
    return;
  }
  // A delivery was cancelled by the driver or the customer.
  if (contract.delivery) {
    const d = contract.delivery;
    const order = await db.find('contracts', c => c.id === d.forContractId);
    if (order && order.status === 'active') {
      if (d.sellerId) await notify(d.sellerId, '🚚', `The delivery for store order #${d.orderNumber || order.bookingNumber} was cancelled. The customer can choose another driver, or collect it.`, 'bookingUpdates', { section: 'store' });
      if (byUserId !== contract.customerId) await notify(contract.customerId, '🚚', `Choose another driver for store order #${d.orderNumber || order.bookingNumber}, or collect it yourself, from Store Orders.`, 'bookingUpdates', { section: 'orders' });
    }
  }
}

// Runs after the customer says they have their goods: the delivery that
// brought them is completed with it, so the driver is paid too.
async function afterComplete(order, customerId) {
  if (!order.storeOrder || !order.deliveryContractId) return null;
  const d = await deliveryOf(order);
  if (!d) return null;
  if (d.status === 'active') {
    const { completeContractCore } = require('./routes/payments.routes');
    return (await completeContractCore(d, 0, customerId)).contract;
  }
  if (d.status === 'pending_provider_confirmation') {
    // The customer already has the goods and the driver never accepted: nothing to deliver.
    const esc = await db.find('escrowTransactions', e => e.contractId === d.id);
    if (esc && esc.status === 'held') await db.update('escrowTransactions', esc.id, { status: 'refunded' });
    await db.update('contracts', d.id, { status: 'cancelled', cancelledByRole: 'order_completed', cancelReasonCategory: 'other' });
    await notify(d.providerId, '🚫', `The delivery request for store order #${order.bookingNumber} is no longer needed. The customer already has the goods.`, 'bookingUpdates', { section: 'bookings' });
  }
  return null;
}

module.exports = {
  DELIVERY_RESPONSE_MINUTES, MAX_DRIVERS_SUGGESTED, kmBetween, distWords, isDriver, driverRates, quoteFor, suggestDrivers,
  isLive, deliveryOf, deliveryEvent, afterCancel, afterComplete,
};
