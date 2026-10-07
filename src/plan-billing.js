// v78: the monthly plan fee for providers (Starter / Pro / Super Pro).
//
// Until now the price on the Provider Plans page was only ever displayed.
// Nothing charged it. This file is the whole mechanism for charging it,
// built and tested, and switched OFF.
//
// How it works once it is on:
//   1. Once a month, each billable provider gets one invoice for their
//      plan's price in their country (the same price the Plans page shows).
//   2. Nothing is ever charged to a card. Open invoices are taken out of
//      the provider's own payouts when they cash out, oldest first, and
//      never more than half of any one payout. Anything left carries over.
//   3. A provider with no earnings simply carries a balance. Nothing is
//      suspended automatically.
//
// Two locks, both must be open:
//   - PLAN_BILLING_ENABLED must be exactly "true" in the server's
//     environment (set in Render). This is the lock a person can't open by
//     clicking the wrong thing.
//   - The super admin must switch it on in Admin → Plans & Pricing.
// After it's switched on, nothing is invoiced for `noticeDays` (default
// 30), so every provider gets fair warning, and a brand-new provider isn't
// invoiced for their first `noticeDays` either. Nothing is ever back-billed.
const db = require('./db');
const { nanoid } = require('nanoid');

const DAY = 24 * 60 * 60 * 1000;
const MAX_SHARE_OF_PAYOUT = 0.5;
const cents = (n) => Math.round(Number(n) * 100) / 100;

function envEnabled() { return process.env.PLAN_BILLING_ENABLED === 'true'; }

async function getState() {
  const { getSetting } = require('./platform-settings');
  const s = (await getSetting('planBilling')) || {};
  const noticeDays = Number.isInteger(s.noticeDays) ? s.noticeDays : 30;
  const on = s.on === true;
  const startedAt = s.startedAt || null;
  const beginsAt = on && startedAt ? new Date(new Date(startedAt).getTime() + noticeDays * DAY).toISOString() : null;
  return { on, startedAt, noticeDays, beginsAt, envEnabled: envEnabled(), active: on && envEnabled() };
}

// Who pays a plan fee: an approved, ID-checked, active provider who isn't a
// seat inside an organization (organizations are on the Custom plan and
// are billed by agreement, not here).
function isBillable(u) {
  return !!u && u.role === 'provider' && u.active !== false && u.verified === true && !u.organizationId;
}

async function pricingRows() {
  const [baseRows, overrideRows, rateRows] = await Promise.all([db.all('planPricingBase'), db.all('planPricingOverrides'), db.all('exchangeRates')]);
  return { baseRows, overrideRows, rateRows };
}
function priceFor(provider, rows) {
  const { effectivePlanPricing } = require('./plan-pricing');
  const plan = ['starter', 'pro', 'superpro'].includes(provider.plan) ? provider.plan : 'starter';
  const p = effectivePlanPricing(provider.country || 'United States', rows).find(x => x.plan === plan);
  return { plan, amountUsd: cents(p.usdEquivalent), localPrice: p.localPrice, currencyCode: p.currencyCode, currencySymbol: p.currencySymbol };
}

// What a month of billing would look like right now. Works whether
// billing is on or off, so the numbers can be checked before switching on.
async function preview() {
  const rows = await pricingRows();
  const providers = (await db.filter('users', isBillable));
  const byPlan = { starter: { count: 0, usd: 0 }, pro: { count: 0, usd: 0 }, superpro: { count: 0, usd: 0 } };
  for (const p of providers) { const pr = priceFor(p, rows); byPlan[pr.plan].count += 1; byPlan[pr.plan].usd = cents(byPlan[pr.plan].usd + pr.amountUsd); }
  const totalUsd = cents(Object.values(byPlan).reduce((s, x) => s + x.usd, 0));
  return { providers: providers.length, byPlan, totalUsd };
}

function periodOf(date) { return new Date(date).toISOString().slice(0, 7); } // "2027-03"

async function sweepPlanInvoices(now = new Date()) {
  const state = await getState();
  if (!state.active) return { created: 0, skipped: 'billing is off' };
  if (!state.beginsAt || now.toISOString() < state.beginsAt) return { created: 0, skipped: 'still inside the notice period' };
  const { notify } = require('./notify');
  const rows = await pricingRows();
  const period = periodOf(now);
  const existing = new Set((await db.filter('planInvoices', i => i.period === period)).map(i => i.providerId));
  let created = 0;
  for (const p of await db.filter('users', isBillable)) {
    if (existing.has(p.id)) continue;
    // New providers get the same notice period before their first invoice.
    if (p.createdAt && new Date(p.createdAt).getTime() + state.noticeDays * DAY > now.getTime()) continue;
    const pr = priceFor(p, rows);
    if (!(pr.amountUsd > 0)) continue; // a plan priced at 0 is free; no invoice
    await db.insert('planInvoices', {
      id: `pinv_${nanoid(10)}`, providerId: p.id, plan: pr.plan, period,
      amountUsd: pr.amountUsd, localPrice: pr.localPrice, currencyCode: pr.currencyCode, currencySymbol: pr.currencySymbol,
      paidUsd: 0, status: 'open', payments: [], createdAt: now.toISOString(),
    });
    const shown = pr.currencyCode === 'USD' ? `$${pr.amountUsd}` : `${pr.currencySymbol}${pr.localPrice} (about $${pr.amountUsd})`;
    await notify(p.id, '🧾', `Your plan fee for ${period} is ${shown}. Nothing is charged to a card: it comes out of your next payout, and never more than half of one payout.`, null, { section: 'earnings' });
    created += 1;
  }
  if (created > 0) console.log(`[plan-billing] Created ${created} plan invoice${created === 1 ? '' : 's'} for ${period}.`);
  return { created, period };
}

async function openInvoices(providerId) {
  return (await db.filter('planInvoices', i => i.providerId === providerId && i.status === 'open'))
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));
}
async function outstandingUsd(providerId) {
  return cents((await openInvoices(providerId)).reduce((s, i) => s + (i.amountUsd - (i.paidUsd || 0)), 0));
}

// Step 1 at cash-out: work out how much of this payout goes to plan fees.
// Changes nothing. Returns 0 when billing is off.
async function planDeduction(providerId, netUsd) {
  const state = await getState();
  if (!state.active || !(netUsd > 0)) return { amount: 0, items: [] };
  let room = cents(netUsd * MAX_SHARE_OF_PAYOUT);
  const items = [];
  for (const inv of await openInvoices(providerId)) {
    if (room <= 0) break;
    const owed = cents(inv.amountUsd - (inv.paidUsd || 0));
    const take = Math.min(owed, room);
    if (take > 0) { items.push({ invoiceId: inv.id, period: inv.period, amountUsd: cents(take) }); room = cents(room - take); }
  }
  return { amount: cents(items.reduce((s, x) => s + x.amountUsd, 0)), items };
}
// Step 2, after the payout record exists: write the payments onto the invoices.
async function applyDeduction(items, payoutId) {
  for (const it of items || []) {
    const inv = await db.find('planInvoices', i => i.id === it.invoiceId);
    if (!inv) continue;
    const paidUsd = cents((inv.paidUsd || 0) + it.amountUsd);
    await db.update('planInvoices', inv.id, {
      paidUsd, status: paidUsd >= inv.amountUsd ? 'paid' : 'open',
      payments: [...(inv.payments || []), { payoutId, amountUsd: it.amountUsd, at: new Date().toISOString() }],
      paidAt: paidUsd >= inv.amountUsd ? new Date().toISOString() : null,
    });
  }
}

module.exports = { envEnabled, getState, isBillable, priceFor, pricingRows, preview, sweepPlanInvoices, openInvoices, outstandingUsd, planDeduction, applyDeduction, MAX_SHARE_OF_PAYOUT };
