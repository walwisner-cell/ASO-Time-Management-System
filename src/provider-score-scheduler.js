const db = require('./db');
const { notify } = require('./notify');
const { computeProviderScore, recommendedActionForScore } = require('./provider-score');

// Recomputes every provider's trust score once a day, stores it on their
// account (so it's fast to read/display without recomputing on every
// page load), and — the real point of this sweep — notifies the
// verification team and the provider's own regional admin the moment a
// score newly crosses into a band worth a human looking at. "Newly"
// matters: this only notifies once per crossing, not every single day
// the score stays low, the same "don't re-notify for something already
// flagged" principle the document-expiry sweep already uses.
//
// The real consequence of a low score is fully automatic and needs no
// admin action at all — see weeklyJobAccessCapForScore in
// ./provider-score, which scales a provider's new-match exposure down as
// their score drops (fully suspended at 0-19), and recovers the moment
// their score does. What this sweep surfaces is different: a recommendation for
// whether a human should actually reach out and help, via a real,
// separate manual action (POST /admin/providers/:id/hold) — which is
// for account holds over real issues like fraud, not a score-triggered
// pause anymore.
async function sweepProviderScores() {
  const providers = await db.filter('users', u => u.role === 'provider');
  let flagged = 0;
  let reactivated = 0;

  for (const provider of providers) {
    // A manual hold (see POST /admin/providers/:id/hold) auto-expires
    // once holdUntil passes — this is the actual check that makes that
    // "auto" real, rather than leaving a provider held forever until
    // someone remembers to manually clear it. A hold with no holdUntil
    // set is unaffected and stays exactly as permanent as it always was
    // — this only ever touches holds that were created with a real
    // expiry date.
    if (provider.onHold && provider.holdUntil && new Date(provider.holdUntil) <= new Date()) {
      await db.update('users', provider.id, { onHold: false, holdReason: null, holdSince: null, holdUntil: null });
      await notify(provider.id, '✅', 'Your account hold has expired and you can book and accept jobs normally again.', null, { section: 'settings' });
      reactivated += 1;
    }

    const result = await computeProviderScore(provider.id);
    if (!result) continue;

    const previousScore = provider.trustScore;
    await db.update('users', provider.id, {
      trustScore: result.total,
      trustScoreProvisional: !!result.isNew, // v91: true until five jobs are completed
      trustScoreBreakdown: result.breakdown,
      trustScoreUpdatedAt: new Date().toISOString(),
    });

    // Item 5 / High-Score Reward: crossing UP into the 90+ band earns 2
    // real, consumable free-commission credits — a genuine reward for
    // reaching that milestone, on top of (not instead of) the existing
    // daily per-city top-scorer credit (src/top-scorer-promotion-
    // scheduler.js), which reuses this exact same freeCommissionCredits
    // field. "Newly crosses" is the same one-time-per-occurrence pattern
    // already used below for the score-drop notification — a provider
    // sitting at 92 every day doesn't get re-rewarded daily, but a real
    // rise from below 90 up to 90+ does count again even if it's happened
    // before, since it's a genuine re-earned milestone each time.
    // v91: a new pro's number is provisional, so it earns no reward and
    // raises no low-score alert. Both start once five jobs are completed.
    if (result.isNew) continue;

    if (result.total >= 90 && (previousScore == null || previousScore < 90)) {
      await db.update('users', provider.id, { freeCommissionCredits: (provider.freeCommissionCredits || 0) + 2 });
      await notify(provider.id, '🏆', `Your Trothen Score reached ${result.total}/100 — you've earned 2 commission-free jobs, applied automatically to your next payouts.`, null, { section: 'earnings' });
    }

    const action = recommendedActionForScore(result.total);
    const previousAction = previousScore != null ? recommendedActionForScore(previousScore) : null;
    const isNewCrossing = action && (!previousAction || previousAction.label !== action.label);
    if (!isNewCrossing) continue;

    const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
    const regionalAdmins = await require('./admin-scope').regionalAdminsFor({ city: provider.city, country: provider.country }); // v96
    const verificationAdmins = await db.filter('users', u => u.role === 'admin' && u.adminDepartment === 'verification');
    const recipients = [...superAdmins, ...regionalAdmins, ...verificationAdmins];
    for (const admin of recipients) {
      await notify(admin.id, '⚠️', `${provider.name}'s Trothen Score dropped to ${result.total}/100 — recommended: ${action.label}.`, null, { section: 'people' });
    }
    flagged += 1;
  }

  if (flagged > 0) console.log(`[provider-score-scheduler] Flagged ${flagged} provider${flagged === 1 ? '' : 's'} for a newly-recommended score-based pause.`);
  if (reactivated > 0) console.log(`[provider-score-scheduler] Auto-reactivated ${reactivated} provider${reactivated === 1 ? '' : 's'} whose score-based pause expired.`);
  return { checked: providers.length, flagged, reactivated };
}

module.exports = { sweepProviderScores };
