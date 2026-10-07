// v89: the top-score award is now once a month, per country.
//
// It used to run every day in every city: whoever had the highest score
// in a city that day got a commission-free payout, even a brand-new pro
// who had not done a single job. Now:
//   - One award per country per calendar month, given just after the
//     month ends (on the first run of the new month).
//   - Only pros who completed at least one job in that month can win.
//   - Highest Trothen Score wins. A tie goes to whoever completed more
//     jobs that month, then to the longer-standing account.
//   - The prize is unchanged: one commission-free payout.
// The sweep still runs daily, but it does nothing once a country's award
// for the month has been given, so a server restart can't award twice and
// a day of downtime can't make a month's award go missing.
const db = require('./db');
const { notify } = require('./notify');

function previousMonthKey(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7); // "2026-09"
}
// "in the United States", but "in Liberia".
function countryPhrase(name) {
  return /^(United |Netherlands$|Philippines$|Gambia$|Bahamas$|Maldives$|Seychelles$|Comoros$)|Republic|Islands$|Emirates$/.test(name) ? 'the ' + name : name;
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function sweepTopScorerPromotion(now = new Date()) {
  const month = previousMonthKey(now);
  const providers = await db.filter('users', u => u.role === 'provider' && u.active !== false && u.verified === true && u.trustScore != null && u.country);
  const contracts = await db.filter('contracts', c => c.status === 'completed' && String(c.completedAt || '').slice(0, 7) === month);
  const jobsThatMonth = new Map();
  for (const c of contracts) jobsThatMonth.set(c.providerId, (jobsThatMonth.get(c.providerId) || 0) + 1);

  const byCountry = new Map();
  for (const p of providers) {
    if (!byCountry.has(p.country)) byCountry.set(p.country, []);
    byCountry.get(p.country).push(p);
  }

  let awarded = 0;
  for (const [country, list] of byCountry) {
    if (list.some(p => p.topScorerAwardedForMonth === month)) continue; // this country's award for that month is already given
    const eligible = list.filter(p => (jobsThatMonth.get(p.id) || 0) > 0);
    if (!eligible.length) continue; // nobody in this country completed a job that month
    eligible.sort((a, b) =>
      (b.trustScore - a.trustScore) ||
      ((jobsThatMonth.get(b.id) || 0) - (jobsThatMonth.get(a.id) || 0)) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const winner = eligible[0];
    await db.update('users', winner.id, {
      freeCommissionCredits: (winner.freeCommissionCredits || 0) + 1,
      topScorerAwardedForMonth: month,
    });
    await notify(winner.id, '🏆', `You had the highest Trothen Score in ${countryPhrase(country)} for ${monthLabel(month)}. Your next payout will have 0% commission.`, null, { section: 'earnings' });
    awarded += 1;
  }

  if (awarded > 0) console.log(`[top-scorer-promotion-scheduler] ${monthLabel(month)}: awarded a commission-free payout to ${awarded} pro${awarded === 1 ? '' : 's'} (one per country).`);
  return { ran: true, month, awarded, countriesChecked: byCountry.size };
}

module.exports = { sweepTopScorerPromotion };
