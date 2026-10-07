// v96: exact job locations are not kept forever.
//
// A job pin is usually the GPS position of a customer's home. It is needed
// while the job is being arranged and done, and for a while afterwards in
// case of a dispute. After that there is no reason to hold it.
//   - Bookings: the exact pin, and the points where the pro said "on my
//     way" and "arrived", are removed PIN_DAYS_AFTER_BOOKING days after
//     the booking ended (completed, cancelled, declined or expired).
//   - Job posts that never became a booking: the pin and landmark are
//     removed PIN_DAYS_UNHIRED_JOB days after the job was posted, once it
//     is no longer open.
//   - Nothing is removed while a dispute on the booking is still open.
// What stays: the landmark text and address on a booking (they are part
// of the written agreement), and everything else about the booking.
const db = require('./db');

const PIN_DAYS_AFTER_BOOKING = 90;
const PIN_DAYS_UNHIRED_JOB = 30;
const DAY = 24 * 60 * 60 * 1000;
const ENDED = ['completed', 'cancelled', 'declined', 'expired', 'rejected'];

async function sweepLocationRetention(now = new Date()) {
  const safe = async (c) => { try { return await db.all(c); } catch (e) { return []; } };
  const openDisputeContracts = new Set((await safe('disputes')).filter(d => !['resolved', 'closed', 'rejected'].includes(d.status)).map(d => d.contractId));
  let bookings = 0, jobs = 0;

  const bookingCutoff = new Date(now.getTime() - PIN_DAYS_AFTER_BOOKING * DAY).toISOString();
  for (const c of await safe('contracts')) {
    if (!ENDED.includes(c.status) || openDisputeContracts.has(c.id)) continue;
    const carried = c.handover && ((c.handover.trail || []).length || [...(c.handover.pickup || []), ...(c.handover.dropoff || [])].some(e => e.location)); // v105
    if (!c.jobLocation && !c.onMyWayLocation && !c.arrivedLocation && !c.liveLocation && !carried) continue;
    const endedAt = c.completedAt || c.cancelledAt || c.updatedAt || c.createdAt;
    if (!endedAt || String(endedAt) > bookingCutoff) continue;
    const patch = { jobLocation: null, onMyWayLocation: null, arrivedLocation: null, liveLocation: null, locationRemovedAt: now.toISOString() };
    // v105: the recorded route and the positions on pick-up and drop-off
    // records go too. The photos and times stay as the record of the hand-over.
    if (carried) {
      const strip = (list) => (list || []).map(e => ({ ...e, location: null }));
      patch.handover = { ...c.handover, trail: [], pickup: strip(c.handover.pickup), dropoff: strip(c.handover.dropoff) };
    }
    await db.update('contracts', c.id, patch);
    bookings += 1;
  }

  const jobCutoff = new Date(now.getTime() - PIN_DAYS_UNHIRED_JOB * DAY).toISOString();
  const hiredJobIds = new Set((await safe('contracts')).map(c => c.jobId).filter(Boolean));
  for (const j of await safe('jobs')) {
    if (!j.jobLocation && !j.landmark) continue;
    if (j.status === 'open' || String(j.createdAt || '') > jobCutoff) continue;
    // A hired job's pin lives on its booking and follows the booking rule above.
    if (hiredJobIds.has(j.id) && String(j.createdAt || '') > bookingCutoff) continue;
    await db.update('jobs', j.id, { jobLocation: null, landmark: null, locationRemovedAt: now.toISOString() });
    jobs += 1;
  }
  if (bookings || jobs) console.log(`[location-retention] Removed the exact location from ${bookings} ended booking${bookings === 1 ? '' : 's'} and ${jobs} old job post${jobs === 1 ? '' : 's'}.`);
  return { bookings, jobs };
}

module.exports = { sweepLocationRetention, PIN_DAYS_AFTER_BOOKING, PIN_DAYS_UNHIRED_JOB };
