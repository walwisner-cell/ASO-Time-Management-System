const db = require('./db');
const { notify } = require('./notify');

// Today, a provider's license is only ever checked at the moment they try
// to accept a job (see hasValidLicense in marketplace.routes.js) — a hard
// block, with zero advance warning. That means the first a provider hears
// about an expiring license is the day they're already locked out of
// accepting work. This sweep closes that gap: once a day, it looks for any
// provider whose licenseExpiryDate falls within the next 30 days and sends
// a one-time reminder to both the provider and whoever administers their
// city (same "super admins + regional admin for this city" pattern used
// for advertising/verification notifications elsewhere — see
// misc.routes.js).
//
// The date math intentionally mirrors hasValidLicense exactly (compare
// against the start of the expiry date in UTC) so "30 days out" here means
// the same thing "expired" already means everywhere else in the app —
// no separate, possibly-inconsistent definition of when a license counts
// as due.
const REMINDER_WINDOW_DAYS = 30;

function daysUntil(dateStr) {
  const expiry = new Date(dateStr + 'T00:00:00.000Z');
  const now = new Date();
  return Math.ceil((expiry.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

// Sends exactly one reminder per expiry date, not one per day inside the
// window — a provider who ignores the first reminder for 29 days
// shouldn't get 29 separate notifications. licenseExpiryReminderSentFor
// records which expiry date was last reminded about; if the provider
// renews their license (the date on file changes), this naturally allows
// a fresh reminder to go out again for the new date later.
async function sweepExpiringDocuments() {
  const providers = await db.filter('users', u =>
    u.role === 'provider' && !!u.licenseExpiryDate
  );

  let reminded = 0;
  for (const provider of providers) {
    const days = daysUntil(provider.licenseExpiryDate);
    const alreadyRemindedForThisDate = provider.licenseExpiryReminderSentFor === provider.licenseExpiryDate;
    if (days < 0 || days > REMINDER_WINDOW_DAYS || alreadyRemindedForThisDate) continue;

    const expiryLabel = new Date(provider.licenseExpiryDate + 'T00:00:00.000Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const daysLabel = days === 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`;

    await notify(
      provider.id, '📄',
      `Your license on file expires ${daysLabel} (${expiryLabel}). Renew it and update the expiry date in Settings before then, or you won't be able to accept new jobs once it lapses.`,
      null, { section: 'settings' }
    );

    const superAdmins = await db.filter('users', u => u.role === 'admin' && u.isSuperAdmin);
    const regionalAdmins = await require('./admin-scope').regionalAdminsFor({ city: provider.city, country: provider.country }); // v96
    for (const admin of [...superAdmins, ...regionalAdmins]) {
      await notify(
        admin.id, '📄',
        `${provider.name}'s license expires ${daysLabel} (${expiryLabel}) — they've been notified, but you may want to follow up if it lapses.`,
        null, { section: 'verification' }
      );
    }

    await db.update('users', provider.id, { licenseExpiryReminderSentFor: provider.licenseExpiryDate });
    reminded += 1;
  }

  if (reminded > 0) console.log(`[document-expiry-scheduler] Sent expiry reminders for ${reminded} provider license${reminded === 1 ? '' : 's'}.`);
  return { reminded, checked: providers.length };
}

module.exports = { sweepExpiringDocuments, daysUntil, REMINDER_WINDOW_DAYS };
