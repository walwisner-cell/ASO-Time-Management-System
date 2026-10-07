// v107: advertising, in one place.
//
// What was wrong before:
//   - Only ONE live ad was ever shown, the first one found. A second
//     advertiser who paid was never seen.
//   - A city ad was only shown to a visitor whose city was typed exactly
//     the same way, and never to someone who wasn't signed in. Most
//     visitors are not signed in, so most city ads were shown to nobody.
//   - An ad never ended. One payment bought the slot for good.
//   - Nobody could see whether an ad was being looked at.
//
// Now: every live ad takes its turn. An ad runs for a set number of days
// and then comes down by itself. Who sees which ad:
//   1. ads for the visitor's own city (capital letters and spaces ignored)
//   2. ads for another city in the visitor's country
//   3. platform-wide ads
//   and a visitor whose place isn't known sees platform-wide ads first,
//   then city ads, so a paid ad is never shown to nobody.
const db = require('./db');

const DEFAULT_RUN_DAYS = 30;
const MAX_ADS_SHOWN = 6;
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function isRunning(ad, now = new Date()) {
  return ad.isLive === true && (!ad.liveUntil || new Date(ad.liveUntil) > now);
}

// Takes down ads whose time is up, and tells the pro who placed them.
async function endExpiredAds(now = new Date()) {
  let ended = 0;
  for (const ad of await db.filter('advertisingInquiries', a => a.isLive === true && a.liveUntil && new Date(a.liveUntil) <= now)) {
    await db.update('advertisingInquiries', ad.id, { isLive: false, status: 'closed', endedAt: now.toISOString(), endedReason: 'time_up' });
    ended += 1;
    if (ad.providerId) {
      try { await require('./notify').notify(ad.providerId, '📣', `Your ad "${ad.displayHeadline || ad.companyName}" has finished its run and is no longer showing. It was seen ${ad.views || 0} time${(ad.views || 0) === 1 ? '' : 's'}. You can place a new one from the home page.`, null, { section: 'overview' }); } catch (e) { /* the ad still ends */ }
    }
  }
  return ended;
}

// Every city name we know of in a country: the cities list, plus the
// cities people in that country have signed up from. Lower case.
async function citiesInCountry(country) {
  return new Set([
    ...(await db.filter('cities', c => same(c.country, country))).map(c => String(c.name || '').trim().toLowerCase()),
    ...(await db.filter('users', u => same(u.country, country) && u.city)).map(u => String(u.city).trim().toLowerCase()),
  ]);
}

function publicAd(ad) {
  return {
    id: ad.id,
    companyName: ad.companyName,
    displayHeadline: ad.displayHeadline || ad.companyName,
    displaySubtext: ad.displaySubtext || `Reach customers browsing Trothen${ad.targetCity ? ` in ${ad.targetCity}` : ''} right now`,
    displayLink: ad.displayLink || null,
    targetCity: ad.targetCity || null,
    providerId: ad.providerId || null, // so a pro's ad can open their Trothen profile
  };
}

// The ads to show this visitor, in order.
async function adsForVisitor({ city, country } = {}) {
  await endExpiredAds();
  const live = (await db.filter('advertisingInquiries', a => isRunning(a))).sort((a, b) => String(a.approvedAt || '').localeCompare(String(b.approvedAt || '')));
  if (!live.length) return [];
  const wide = live.filter(a => !a.targetCity);
  const local = city ? live.filter(a => a.targetCity && same(a.targetCity, city)) : [];
  let nearby = [];
  if (country) {
    // which cities are in this country: the cities list, plus the advertiser's own country
    const citiesHere = await citiesInCountry(country);
    const pros = new Map((await db.filter('users', u => u.role === 'provider')).map(u => [u.id, u]));
    nearby = live.filter(a => a.targetCity && !local.includes(a) && (citiesHere.has(String(a.targetCity).trim().toLowerCase()) || (a.providerId && pros.get(a.providerId) && same(pros.get(a.providerId).country, country))));
  }
  let chosen;
  if (city || country) chosen = [...local, ...nearby, ...wide];
  else chosen = [...wide, ...live.filter(a => a.targetCity)];
  return chosen.slice(0, MAX_ADS_SHOWN).map(publicAd);
}

module.exports = { DEFAULT_RUN_DAYS, MAX_ADS_SHOWN, isRunning, endExpiredAds, adsForVisitor, publicAd, citiesInCountry };
