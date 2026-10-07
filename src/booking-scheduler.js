const db = require('./db');
const { notify } = require('./notify');

// Expires exactly one overdue booking: refunds any held escrow, marks the
// contract expired, and notifies both parties with a message that actually
// tells them what happened and what to do next — not just a silent status
// change. Exported separately from the sweep below so the lazy safety-net
// check in POST /contracts/:id/respond-offer can reuse the exact same
// logic instead of duplicating it.
async function expireOneBooking(contract) {
  const escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
  if (escrow && escrow.status === 'held') {
    await db.update('escrowTransactions', escrow.id, { status: 'refunded' });
  }
  const updated = await db.update('contracts', contract.id, { status: 'expired' });
  try { await require('./store').giveBackStock(contract); } catch (e) { console.error('[store] could not give stock back:', e.message); } // v105

  const provider = await db.find('users', u => u.id === contract.providerId);
  // NOTE: contract.status here is still the pre-update value passed in by
  // the caller ('pending_provider_confirmation' or 'pending_agreement') —
  // read before the update above, not after.
  const isDirectBooking = contract.status === 'pending_provider_confirmation' && !contract.jobId;
  const isJobSelection = contract.status === 'pending_provider_confirmation' && !!contract.jobId;
  if (contract.delivery) { // v108: a driver didn't answer a delivery request in time
    await notify(contract.providerId, '⏰', `You didn't answer the delivery request "${contract.service}" in time, so it was offered back to the customer.`, null, { section: 'bookings' });
    try { await require('./store-orders').deliveryEvent(contract, 'expired'); } catch (e) { console.error('[store-orders] expiry:', e.message); }
    return updated;
  }

  await notify(contract.providerId, '⏰', `You didn't respond to the booking request for "${contract.service}" in time, so it expired automatically and the customer was refunded.`, null, { section: 'bookings' });

  if (isJobSelection) {
    // Item 10: try the next real candidate automatically instead of just
    // cancelling the customer's job — attemptJobReassignment handles its
    // own customer notification either way (reassigned, or reopened with
    // nobody left).
    const { attemptJobReassignment } = require('./routes/marketplace.routes');
    const job = await db.find('jobs', j => j.id === contract.jobId);
    if (job) await attemptJobReassignment(job, contract.providerId, contract.amount);
    return updated;
  }

  const customerMessage = isDirectBooking
    ? `${provider ? provider.name : 'The provider'} didn't confirm "${contract.service}" in time, so the booking was automatically cancelled and any held funds refunded. Try another provider, or book them again for a later time.`
    : `${provider ? provider.name : 'The provider'} didn't respond to your offer for "${contract.service}" in time, so it expired automatically and any held funds were refunded.`;
  await notify(contract.customerId, '⏰', customerMessage, null, { section: 'bookings' });

  return updated;
}

// The scheduled sweep — finds every booking still awaiting a provider's
// response whose deadline has already passed, and expires each one for
// real. This is what makes the deadline actually mean something: without
// this running, "respond within 4 hours" would just be a label with no
// consequence, and a customer's money would sit held indefinitely against
// a job nobody ever confirmed.
async function expireOverdueBookingResponses() {
  const now = new Date();
  const pending = await db.filter('contracts', c =>
    ['pending_agreement', 'pending_provider_confirmation'].includes(c.status)
    && c.providerResponseDeadline
    && new Date(c.providerResponseDeadline) < now
  );

  let expired = 0;
  for (const contract of pending) {
    try {
      await expireOneBooking(contract);
      expired += 1;
    } catch (e) {
      console.error(`[booking-scheduler] Failed to expire contract ${contract.id}:`, e.message);
    }
  }
  if (expired > 0) console.log(`[booking-scheduler] Expired ${expired} overdue booking response${expired === 1 ? '' : 's'}.`);
  return { expired, checked: pending.length };
}

module.exports = { expireOneBooking, expireOverdueBookingResponses };
