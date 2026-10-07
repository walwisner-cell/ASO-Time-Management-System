const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { isNonEmptyString, isValidCardExpiry, isValidPostalCode, validate, postalCodeErrorMessage } = require('../validators');
const { notify } = require('../notify');
const { currencyForCountry, convertFromUSD } = require('../currency-data');
const { resolveRate } = require('../plan-pricing');

const router = express.Router();

// Prevents two payout requests for the SAME provider from ever running at
// the same time. Without this, the payout endpoint has a real
// time-of-check-to-time-of-use gap: it reads which escrow is unpaid, does
// real work (customer/review lookups, currency conversion) that takes
// measurable time, and only stamps those escrow records as paid at the
// very end. A double-click, or a browser retrying a slow request, could
// let a second request read the exact same "still unpaid" records before
// the first had finished stamping them — producing two separate payouts
// for the same underlying money. This app runs as a single server
// instance (not horizontally scaled), so a simple in-memory lock keyed by
// provider ID is a complete fix, not a partial one — this is the same
// pattern any single-instance Node service uses for this exact problem.
const payoutLocks = new Set();

// Complete and cancel are two different ways a contract reaches a
// terminal state, and both follow the same read-status-then-write pattern
// as everything else fixed this session. Racing them against each other
// on the SAME contract (a customer double-clicking, or two open tabs)
// can't double-move money the way the payout race could — escrow status
// is a single field, not an incrementing balance — but it can leave the
// contract and its escrow disagreeing with each other: a contract marked
// "completed" whose escrow actually says "refunded" (so the provider can
// never actually get paid despite the customer thinking they confirmed
// the job), or the reverse (a customer who cancelled but whose money
// never actually came back because the job got marked complete a moment
// later). A shared lock keyed by contract id means only one of these two
// endpoints can ever be mid-flight for a given contract at once.
const { contractStatusLocks } = require('../contract-locks');

// ── TEST-MODE PAYMENT METHODS ────────────────────────────────────────────────
// This is a sandbox stand-in, not a real payment integration. It exists so
// the booking/escrow flow can be exercised end-to-end during testing without
// blocking on a real processor being chosen yet.
//
// Even in test mode, this never stores a full card number — only the last 4
// digits and a guessed brand, discarding everything else immediately. That's
// deliberate: it's the same handling pattern a real Stripe/processor
// integration would need (tokenize, never persist the PAN), so swapping in
// a real processor later means replacing this file's internals, not
// redesigning how the rest of the app calls it.
function detectCardBrand(digits) {
  if (/^4/.test(digits)) return 'Visa';
  if (/^5[1-5]/.test(digits)) return 'Mastercard';
  if (/^3[47]/.test(digits)) return 'Amex';
  if (/^6(?:011|5)/.test(digits)) return 'Discover';
  return 'Card';
}

// GET /api/payment-methods/mine
router.get('/payment-methods/mine', requireAuth, async (req, res) => {
  const methods = await db.filter('paymentMethods', m => m.userId === req.user.sub);
  res.json({ methods });
});

// POST /api/payment-methods — add a test payment method. Three types:
// - 'card' (default, unchanged): any input accepted, only last 4 + brand kept.
// - 'apple_pay': Apple Pay is authenticated on-device via the browser's
//   Payment Request API and a real Apple merchant account — neither
//   exists yet, so this simulates the same end state Stripe would give
//   back (a device-linked token), clearly labeled test mode, same
//   honesty convention used for signup codes and 2FA elsewhere in this
//   app. Wiring in the real Payment Request API later means replacing
//   what creates this record, not the record shape itself.
// - 'paypal': simulates a linked PayPal account by email — a real
//   integration exchanges this for a PayPal-issued billing agreement ID
//   instead of storing the email directly, but the method record shape
//   (type + a display label) doesn't change.
router.post('/payment-methods', requireAuth, async (req, res) => {
  const { type, cardNumber, expiry, nameOnCard, billingAddress, billingZip, paypalEmail, mobileMoneyProvider, mobileMoneyNumber } = req.body || {};
  const accountHolder = await db.find('users', u => u.id === req.user.sub);
  const methodType = ['card', 'apple_pay', 'paypal', 'mobile_money'].includes(type) ? type : 'card';

  if (methodType === 'card') {
    const errors = validate([
      ['cardNumber', isNonEmptyString(cardNumber, { min: 4 }), 'Enter a card number (any digits — this is test mode)'],
      ['expiry', isValidCardExpiry(expiry), 'Enter a valid, non-expired expiry date in MM/YY format'],
      ['nameOnCard', isNonEmptyString(nameOnCard, { min: 2 }), 'Enter the name on the card'],
      ['billingAddress', isNonEmptyString(billingAddress, { min: 3, max: 200 }), 'Enter the billing address'],
      ['billingZip', isValidPostalCode(billingZip, accountHolder && accountHolder.country), postalCodeErrorMessage(accountHolder && accountHolder.country)],
    ]);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });

    const digitsOnly = String(cardNumber).replace(/\D/g, '');
    if (digitsOnly.length < 4) return res.status(400).json({ error: 'Card number must contain at least 4 digits' });
    const last4 = digitsOnly.slice(-4);
    const brand = detectCardBrand(digitsOnly);

    const existing = await db.filter('paymentMethods', m => m.userId === req.user.sub);
    const method = {
      id: `pm_${nanoid(10)}`,
      userId: req.user.sub,
      type: 'card',
      brand, last4, nameOnCard: nameOnCard.trim(), expiry: expiry.trim(),
      billingAddress: billingAddress.trim(), billingZip: billingZip.trim(),
      isDefault: existing.length === 0, // first one added becomes default automatically
      mode: 'test',
      createdAt: new Date().toISOString(),
    };
    await db.insert('paymentMethods', method);
    return res.status(201).json({ method });
  }

  if (methodType === 'paypal') {
    const errors = validate([
      ['paypalEmail', isNonEmptyString(paypalEmail, { min: 5, max: 254 }) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypalEmail), 'Enter the email address linked to your PayPal account'],
    ]);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const existing = await db.filter('paymentMethods', m => m.userId === req.user.sub);
    const method = {
      id: `pm_${nanoid(10)}`,
      userId: req.user.sub,
      type: 'paypal',
      brand: 'PayPal',
      paypalEmail: paypalEmail.trim(),
      isDefault: existing.length === 0,
      mode: 'test',
      createdAt: new Date().toISOString(),
    };
    await db.insert('paymentMethods', method);
    return res.status(201).json({ method });
  }

  if (methodType === 'mobile_money') {
    const errors = validate([
      ['mobileMoneyProvider', isNonEmptyString(mobileMoneyProvider, { min: 2, max: 60 }), 'Enter your mobile money provider (e.g. Orange Money, MTN Mobile Money, Lonestar Cell MTN)'],
      ['mobileMoneyNumber', isNonEmptyString(mobileMoneyNumber, { min: 7, max: 20 }), 'Enter the phone number linked to your mobile money account'],
    ]);
    if (errors.length) return res.status(400).json({ error: errors[0], errors });
    const existing = await db.filter('paymentMethods', m => m.userId === req.user.sub);
    const method = {
      id: `pm_${nanoid(10)}`,
      userId: req.user.sub,
      type: 'mobile_money',
      brand: mobileMoneyProvider.trim(),
      mobileMoneyNumber: mobileMoneyNumber.trim(),
      isDefault: existing.length === 0,
      mode: 'test',
      createdAt: new Date().toISOString(),
    };
    await db.insert('paymentMethods', method);
    return res.status(201).json({ method });
  }

  // apple_pay — no form fields at all in a real integration (the device
  // handles authentication); nothing to validate beyond that the account
  // exists, which requireAuth already confirmed.
  const existing = await db.filter('paymentMethods', m => m.userId === req.user.sub);
  const method = {
    id: `pm_${nanoid(10)}`,
    userId: req.user.sub,
    type: 'apple_pay',
    brand: 'Apple Pay',
    isDefault: existing.length === 0,
    mode: 'test',
    createdAt: new Date().toISOString(),
  };
  await db.insert('paymentMethods', method);
  res.status(201).json({ method });
});

// PATCH /api/payment-methods/:id/default
router.patch('/payment-methods/:id/default', requireAuth, async (req, res) => {
  const method = await db.find('paymentMethods', m => m.id === req.params.id && m.userId === req.user.sub);
  if (!method) return res.status(404).json({ error: 'Payment method not found' });
  const others = await db.filter('paymentMethods', m => m.userId === req.user.sub);
  for (const m of others) {
    if (m.id !== method.id && m.isDefault) await db.update('paymentMethods', m.id, { isDefault: false });
  }
  const updated = await db.update('paymentMethods', method.id, { isDefault: true });
  res.json({ method: updated });
});

// DELETE /api/payment-methods/:id
router.delete('/payment-methods/:id', requireAuth, async (req, res) => {
  const method = await db.find('paymentMethods', m => m.id === req.params.id && m.userId === req.user.sub);
  if (!method) return res.status(404).json({ error: 'Payment method not found' });
  await db.remove('paymentMethods', method.id);
  // If we just removed the default, promote whichever method is left, if any.
  if (method.isDefault) {
    const remaining = await db.filter('paymentMethods', m => m.userId === req.user.sub);
    if (remaining.length) await db.update('paymentMethods', remaining[0].id, { isDefault: true });
  }
  res.json({ ok: true });
});

// GET /api/payouts/mine — provider payout history
router.get('/payouts/mine', requireAuth, requireRole('provider'), async (req, res) => {
  let payouts = await db.filter('payouts', p => p.providerId === req.user.sub);
  const { from, to } = req.query;
  if (from) payouts = payouts.filter(p => p.date >= from);
  if (to) payouts = payouts.filter(p => p.date <= to);
  payouts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ payouts });
});

// GET /api/payouts/pdf — a real, downloadable payout history report for a
// provider, honoring the same from/to date range as the on-screen history.
// Built so "who paid me, and when" is answerable from a document alone,
// not just by scrolling the dashboard.
router.get('/payouts/pdf', requireAuth, requireRole('provider'), async (req, res) => {
  const { from, to } = req.query;
  const provider = await db.find('users', u => u.id === req.user.sub);
  let payouts = await db.filter('payouts', p => p.providerId === req.user.sub);
  if (from) payouts = payouts.filter(p => p.date >= from);
  if (to) payouts = payouts.filter(p => p.date <= to);
  payouts.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const { createReportDoc } = require('../pdf-report-builder');
  const rangeLabel = from || to ? `${from || 'earliest'} to ${to || 'today'}` : 'All time';
  const { sectionHeader, row, twoColumnRow, table, finish } = createReportDoc({
    res,
    filename: `Trothen-Payout-History-${provider.name.replace(/\s+/g, '-')}.pdf`,
    title: 'Payout History Report',
    subtitle: 'AI-Matched · Identity-Verified · Escrow-Protected',
    docId: rangeLabel,
    verificationSeed: `payouts|${provider.id}|${from || ''}|${to || ''}|${payouts.length}`,
  });

  sectionHeader('Report Summary');
  twoColumnRow('Provider', `${provider.name} (${provider.email})`, 'Date Range', rangeLabel);
  const totalGross = payouts.reduce((s, p) => s + (p.grossAmount ?? p.amount), 0);
  const totalCommission = payouts.reduce((s, p) => s + (p.commissionAmount || 0), 0);
  const totalNet = payouts.reduce((s, p) => s + p.amount, 0);
  twoColumnRow('Total Earned (Gross)', `$${totalGross.toFixed(2)}`, 'Total Commission', `$${totalCommission.toFixed(2)}`);
  row('Total Paid Out (Net)', `$${totalNet.toFixed(2)}`);

  if (payouts.length === 0) {
    sectionHeader('Payouts');
    row('No payouts', 'No payouts were found in this date range.');
  } else {
    for (const payout of payouts) {
      sectionHeader(`Payout ${payout.id} — ${payout.date}`);
      twoColumnRow('Gross Earned', `$${(payout.grossAmount ?? payout.amount).toFixed(2)}`, 'Commission', payout.commissionAmount ? `$${payout.commissionAmount.toFixed(2)} (${Math.round((payout.commissionRate || 0) * 100)}%)` : '—');
      twoColumnRow('Net Paid Out', `$${payout.amount.toFixed(2)}`, 'Method / Status', `${payout.method} · ${payout.status}`);
      if (payout.lineItems && payout.lineItems.length) {
        table(
          [{ label: 'Customer', width: 110 }, { label: 'Job', width: 140 }, { label: 'Date', width: 60 }, { label: 'Booking #', width: 80 }, { label: 'Amount', width: 60, align: 'right' }],
          payout.lineItems.map(li => [li.customerName, li.service, li.jobDate || '—', li.bookingNumber, `$${li.amount}`])
        );
      }
    }
  }

  finish({
    closingNote: 'This report reflects Trothen\'s payout records for this provider account as of the moment it was generated. Commission is deducted according to the provider\'s plan at the time of each payout. Provided for the provider\'s own recordkeeping.',
  });
});
// POST /api/payouts/request — provider requests payout of released escrow
const { effectiveCommissionRate } = require('../commission');

router.post('/payouts/request', requireAuth, requireRole('provider'), require('../terms').requireCurrentTerms, async (req, res) => {
  const requestingProvider = await db.find('users', u => u.id === req.user.sub);
  if (requestingProvider && requestingProvider.onHold) {
    return res.status(403).json({ error: 'Your account is temporarily paused pending a quick review — payouts will resume once this clears, usually within a couple hours. Contact support if you need this resolved sooner.' });
  }
  const { payoutCurrency, useIntlMethod } = req.body || {}; // 'usd' or 'local' — defaults to local if the provider has a non-US country

  // Reject immediately if this provider already has a payout request in
  // flight — this is what actually closes the race, not just a courtesy
  // message. A genuinely concurrent second request never even reaches the
  // vulnerable read-then-write section below.
  if (payoutLocks.has(req.user.sub)) {
    return res.status(409).json({ error: 'A payout request is already being processed — please wait a moment before trying again.' });
  }
  payoutLocks.add(req.user.sub);

  try {
    return await handlePayoutRequest(req, res, payoutCurrency, useIntlMethod);
  } finally {
    payoutLocks.delete(req.user.sub);
  }
});

async function handlePayoutRequest(req, res, payoutCurrency, useIntlMethod) {
  const provider = await db.find('users', u => u.id === req.user.sub);

  // What's actually payable is escrow that's been RELEASED (the customer
  // confirmed the work) and hasn't already gone out in an earlier payout —
  // not escrow that's still held pending confirmation. Paying out held
  // funds would defeat the entire point of escrow protection, and paying
  // out the same released escrow twice would be a real financial bug, not
  // just a display one — so every included escrow record gets stamped
  // with this payout's id the moment it's included, and never counted
  // again after that.
  const releasedEscrow = await db.filter('escrowTransactions', e =>
    e.status === 'released' && !e.payoutId
  );
  const contracts = await db.filter('contracts', c => c.providerId === req.user.sub);
  const contractIds = new Set(contracts.map(c => c.id));
  const payableEscrow = releasedEscrow.filter(e => contractIds.has(e.contractId));

  // Materials advances release the moment they're agreed, independent of
  // whether the rest of the job is done — so they're gathered separately
  // here, using their own payout tracking field, since the MAIN escrow
  // record for that contract might still legitimately be 'held' for the
  // remainder while the advance itself is fully payable right now.
  const allEscrowForProvider = await db.filter('escrowTransactions', e => contractIds.has(e.contractId));
  const payableAdvances = allEscrowForProvider.filter(e =>
    e.materialsAdvanceReleased && e.materialsAdvanceAmount > 0 && !e.materialsAdvancePayoutId && e.status !== 'refunded'
  );

  const grossAmount = payableEscrow.reduce((sum, e) => sum + (e.amount - (e.materialsAdvanceAmount || 0)), 0)
    + payableAdvances.reduce((sum, e) => sum + e.materialsAdvanceAmount, 0);

  // Unpaid tips — gathered from completed contracts directly (not the
  // escrow ledger), and added to what's paid out AFTER commission is
  // computed on grossAmount above, so a tip is never commission-taxed.
  // Genuinely optional on the customer's side (see handleContractComplete),
  // so this is simply $0 for a provider with none.
  const unpaidTipContracts = (await db.filter('contracts', c => c.providerId === req.user.sub && c.tipAmount > 0 && !c.tipPaid));
  const totalTips = unpaidTipContracts.reduce((sum, c) => sum + c.tipAmount, 0);

  if (grossAmount <= 0 && totalTips <= 0) {
    return res.status(400).json({ error: 'Nothing to pay out yet — this only includes jobs the customer has marked complete, tips, or agreed materials advances, that haven\'t already been paid out.' });
  }

  // A provider should be able to see exactly which jobs and which
  // customers make up a payout, not just a lump sum — this is what
  // actually answers "who paid, and for what" when they look at their
  // payout history later.
  const lineItems = [];
  for (const e of payableEscrow) {
    const contract = contracts.find(c => c.id === e.contractId);
    if (!contract) continue;
    const customer = await db.find('users', u => u.id === contract.customerId);
    const review = await db.find('reviews', r => r.contractId === contract.id);
    const newlyPayable = e.amount - (e.materialsAdvanceAmount || 0);
    if (newlyPayable <= 0) continue; // the whole amount was already an advance, nothing further to add here
    lineItems.push({
      contractId: contract.id,
      bookingNumber: contract.bookingNumber || contract.id,
      customerName: customer ? customer.name : 'Unknown customer',
      customerEmail: customer ? customer.email : null,
      customerPhone: customer ? customer.phone : null,
      service: contract.service,
      jobDate: contract.date || null,
      jobTime: contract.time || null,
      address: contract.address || null,
      contractStatus: contract.status,
      signedAt: contract.signedAt || (contract.createdAt || '').slice(0, 10),
      review: review ? { stars: review.stars, text: review.text || null } : null,
      amount: newlyPayable,
    });
  }
  for (const e of payableAdvances) {
    const contract = contracts.find(c => c.id === e.contractId);
    if (!contract) continue;
    const customer = await db.find('users', u => u.id === contract.customerId);
    lineItems.push({
      contractId: contract.id,
      bookingNumber: contract.bookingNumber || contract.id,
      customerName: customer ? customer.name : 'Unknown customer',
      customerEmail: customer ? customer.email : null,
      customerPhone: customer ? customer.phone : null,
      service: `${contract.service} (materials advance)`,
      jobDate: contract.date || null,
      jobTime: contract.time || null,
      address: contract.address || null,
      contractStatus: contract.status,
      signedAt: contract.signedAt || (contract.createdAt || '').slice(0, 10),
      review: null,
      amount: e.materialsAdvanceAmount,
    });
  }

  // Commission is based on the provider's plan at the time they cash out —
  // matches the rates in COMMISSION_RATES (src/commission.js): Starter
  // 13%, Pro 12%, Super Pro 10%, actually deducted here rather than just
  // being marketing copy. A provider attached to a Custom-plan
  // organization uses that org's negotiated rate instead — the "volume
  // commission discount" promised on the Custom pricing card.
  // v84: a suspended organization's negotiated rate no longer applies. Its
  // pros pay the normal rate for their plan until it is active again.
  const organization = provider.organizationId ? await db.find('organizations', o => o.id === provider.organizationId && o.status !== 'suspended') : null;
  let commissionRate = effectiveCommissionRate(provider, organization);
  // A top-scorer free-commission credit (see
  // src/top-scorer-promotion-scheduler.js) is consumed here, on an actual
  // payout — not just checked and left alone, the way a read-only rate
  // lookup would. This is deliberately the only place this credit is
  // spent: requesting a payout is the one real, stateful action that
  // should use it up.
  const usedFreeCommissionCredit = (provider.freeCommissionCredits || 0) > 0;
  if (usedFreeCommissionCredit) commissionRate = 0;
  // v105: goods sold from the pro's store carry no commission. Trothen's
  // share of a store purchase is the flat fee the customer paid at
  // booking. So the goods part of each booking is taken out before the
  // commission is worked out. (If a dispute was split, what is left of
  // the booking is counted as goods first.)
  const storeGoodsAmount = Math.round(payableEscrow.reduce((sum, e) => sum + Math.min(e.storeGoodsAmount || 0, Math.max(0, e.amount - (e.materialsAdvanceAmount || 0))), 0) * 100) / 100;
  const commissionableAmount = Math.max(0, Math.round((grossAmount - storeGoodsAmount) * 100) / 100);
  const commissionAmount = Math.round(commissionableAmount * commissionRate * 100) / 100;
  // v106: store purchase fees the pro pays (when the super admin has set
  // the fee to come from the pro). Never more than what is being paid on
  // that booking, so a split dispute can't push a payout below zero.
  const storeFeeAmount = Math.round(payableEscrow.reduce((sum, e) => sum + Math.min(e.storeFeeFromPro || 0, Math.max(0, e.amount - (e.materialsAdvanceAmount || 0))), 0) * 100) / 100;
  let netAmount = Math.round((grossAmount - commissionAmount - storeFeeAmount + totalTips) * 100) / 100;
  // v78: open monthly plan fees come out here, oldest first, and never
  // more than half of this payout. Returns 0 while plan billing is off.
  const planBilling = require('../plan-billing');
  const planFee = await planBilling.planDeduction(provider.id, netAmount);
  netAmount = Math.round((netAmount - planFee.amount) * 100) / 100;

  // The contract/escrow ledger is always denominated in USD — that stays
  // the canonical accounting currency regardless of payout choice, so
  // reports and reconciliation are never ambiguous. What the provider
  // actually RECEIVES can be converted to their local currency at their
  // choice — the same way an international payout provider (Wise, Payoneer,
  // etc.) would let you choose your payout currency for a USD-denominated
  // balance.
  const currency = currencyForCountry(provider ? provider.country : 'United States');
  const wantsLocal = payoutCurrency === 'local' && currency.code !== 'USD';
  const rate = wantsLocal ? resolveRate(currency.code, await db.all('exchangeRates')) : null;
  const payoutAmountLocal = wantsLocal ? convertFromUSD(netAmount, currency.code, rate) : null;

  for (const c of unpaidTipContracts) {
    const customer = await db.find('users', u => u.id === c.customerId);
    lineItems.push({
      contractId: c.id,
      bookingNumber: c.bookingNumber || c.id,
      customerName: customer ? customer.name : 'Unknown customer',
      customerEmail: customer ? customer.email : null,
      customerPhone: customer ? customer.phone : null,
      service: `${c.service} (tip — no commission)`,
      jobDate: c.date || null,
      jobTime: c.time || null,
      address: c.address || null,
      contractStatus: c.status,
      signedAt: c.signedAt || (c.createdAt || '').slice(0, 10),
      review: null,
      amount: c.tipAmount,
    });
  }

  const payout = {
    id: `po_${nanoid(10)}`,
    providerId: req.user.sub,
    date: new Date().toISOString().slice(0, 10),
    grossAmount,
    commissionRate,
    commissionAmount,
    storeGoodsAmount, // v105: the part of this payout that is store goods (no commission)
    storeFeeAmount, // v106: flat store purchase fees paid by the pro
    amount: netAmount, // canonical USD amount actually paid out, after commission (and any plan fee)
    planFeeAmount: planFee.amount,
    planFeeItems: planFee.items,
    payoutCurrency: wantsLocal ? currency.code : 'USD',
    payoutAmountLocal,
    exchangeRateNote: wantsLocal ? 'Approximate test-mode exchange rate — not a live market rate' : null,
    method: (useIntlMethod && provider && provider.payoutMethodIntl) ? provider.payoutMethodIntl : ((provider && provider.payoutMethod) || 'Bank Transfer'),
    status: 'processing',
    lineItems,
    createdAt: new Date().toISOString(),
  };
  await db.insert('payouts', payout);
  if (planFee.amount > 0) await planBilling.applyDeduction(planFee.items, payout.id);

  const { checkPayoutVelocity } = require('../fraud-detection');
  await checkPayoutVelocity(req.user.sub);

  // Stamp every included escrow record so it can never be paid out again.
  for (const e of payableEscrow) {
    await db.update('escrowTransactions', e.id, { payoutId: payout.id });
  }
  for (const e of payableAdvances) {
    await db.update('escrowTransactions', e.id, { materialsAdvancePayoutId: payout.id });
  }
  for (const c of unpaidTipContracts) {
    await db.update('contracts', c.id, { tipPaid: true });
  }
  if (usedFreeCommissionCredit) {
    await db.update('users', provider.id, { freeCommissionCredits: (provider.freeCommissionCredits || 0) - 1 });
  }

  const displayAmount = wantsLocal ? `${currency.symbol}${payoutAmountLocal} (${currency.code}, ≈ $${payout.amount} USD)` : `$${payout.amount}`;
  const tipNote = totalTips > 0 ? ` (includes $${totalTips} in tips — no commission taken on those)` : '';
  const planFeeNote = planFee.amount > 0 ? ` $${planFee.amount} in plan fees was taken from this payout.` : '';
  const goodsNote = storeGoodsAmount > 0 ? ` $${storeGoodsAmount} of this is goods from your store, with no commission taken${storeFeeAmount > 0 ? `; $${storeFeeAmount} in store purchase fees was taken instead` : ''}.` : '';
  const creditNote = usedFreeCommissionCredit ? ' 🏆 Used your top-scorer free-commission credit — 0% commission on this payout!' : '';
  await notify(req.user.sub, '💸', `Payout of ${displayAmount} requested (after ${Math.round(commissionRate*100)}% commission — $${commissionAmount} — on $${grossAmount} earned)${tipNote}${goodsNote}${planFeeNote}${creditNote} — processing.`, 'payoutAlerts', { section: 'earnings' });
  res.status(201).json({ payout });
}

// GET /api/plan-billing/mine — v78: a provider's own plan fee: whether it
// is being charged yet, what it is, what's owed, and past invoices.
router.get('/plan-billing/mine', requireAuth, requireRole('provider'), async (req, res) => {
  const planBilling = require('../plan-billing');
  const me = await db.find('users', u => u.id === req.user.sub);
  const state = await planBilling.getState();
  const price = planBilling.priceFor(me, await planBilling.pricingRows());
  const invoices = (await db.filter('planInvoices', i => i.providerId === me.id))
    .sort((a, b) => String(b.period).localeCompare(String(a.period))).slice(0, 24)
    .map(i => ({ id: i.id, period: i.period, plan: i.plan, amountUsd: i.amountUsd, localPrice: i.localPrice, currencyCode: i.currencyCode, currencySymbol: i.currencySymbol, paidUsd: i.paidUsd || 0, status: i.status }));
  res.json({
    active: state.active, beginsAt: state.active ? state.beginsAt : null,
    billable: planBilling.isBillable(me), inOrganization: !!me.organizationId,
    price, outstandingUsd: await planBilling.outstandingUsd(me.id), invoices,
    maxShareOfPayoutPercent: planBilling.MAX_SHARE_OF_PAYOUT * 100,
  });
});

// POST /api/contracts/:id/complete — customer confirms job done -> release escrow
// POST /api/contracts/:id/on-my-way — a provider marks that they've left
// for an active job, optionally with a real GPS coordinate captured once
// at that moment (not continuous tracking — see the audit note on why:
// this app matches tasks like cleaning/repairs/deliveries, not a live
// rideshare map, and one-time stamps at meaningful moments cost far less
// battery/privacy than streaming location the whole time). The customer
// gets a real, timestamped notification either way, with or without a
// coordinate.
router.post('/contracts/:id/on-my-way', requireAuth, requireRole('provider'), async (req, res) => {
  const contract = await db.find('contracts', c => c.id === req.params.id && c.providerId === req.user.sub);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (contract.status !== 'active') return res.status(400).json({ error: `This booking is ${contract.status} — it can't be marked on the way` });
  if (contract.onMyWayAt) return res.status(400).json({ error: 'Already marked on the way for this booking' });

  const { latitude, longitude } = req.body || {};
  const hasValidCoords = typeof latitude === 'number' && typeof longitude === 'number' && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  const updated = await db.update('contracts', contract.id, {
    onMyWayAt: new Date().toISOString(),
    onMyWayLocation: hasValidCoords ? { latitude, longitude } : null,
    // v93: the first point of the live trip (see /live-location below)
    liveLocation: hasValidCoords ? { latitude, longitude, accuracyM: Number.isFinite(Number(req.body.accuracyM)) ? Math.round(Number(req.body.accuracyM)) : null, at: new Date().toISOString() } : null,
  });

  const provider = await db.find('users', u => u.id === req.user.sub);
  await notify(contract.customerId, '🚗', `${provider ? provider.name : 'Your provider'} is on the way for "${contract.service}".`, 'bookingUpdates', { section: 'bookings' });
  res.json({ contract: updated });
});

// POST /api/contracts/:id/arrived — same pattern as on-my-way, for the
// moment the provider actually shows up. Together these two timestamps
// (plus an optional coordinate each) give both sides a real, honest
// pickup/drop-off record without building a full live-tracking system
// this kind of marketplace doesn't really need.
// ── v93: LIVE TRIP TRACKING ────────────────────────────────────────────
// Between a pro tapping "On my way" and tapping "Arrived", their phone
// sends its position every few seconds and the customer can watch them
// come, with the distance left. This is the same idea as a ride app, with
// three honest differences because Trothen is a web page, not an
// installed app:
//   - The pro's phone only sends while the Trothen page is open and the
//     screen is on. The page asks the phone to stay awake, but if the pro
//     switches apps or locks the phone, updates stop until they come back.
//     The customer is shown how old the last position is.
//   - Distance is a straight line, not a road route.
//   - Nothing is sent before "On my way" or after "Arrived".
// Who can see it: only the customer and the pro on that one booking.
// The live position is wiped on arrival, and ignored after 6 hours.
const LIVE_TRIP_MAX_MS = 6 * 60 * 60 * 1000;
const liveLocationLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Location updates are arriving too quickly.' },
});

// POST /api/contracts/:id/live-location  { latitude, longitude, accuracyM }
router.post('/contracts/:id/live-location', requireAuth, requireRole('provider'), liveLocationLimiter, async (req, res) => {
  const contract = await db.find('contracts', c => c.id === req.params.id && c.providerId === req.user.sub);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  const tripOpen = contract.status === 'active' && contract.onMyWayAt && !contract.arrivedAt
    && (Date.now() - new Date(contract.onMyWayAt).getTime()) < LIVE_TRIP_MAX_MS;
  if (!tripOpen) return res.status(409).json({ code: 'TRIP_CLOSED', error: 'This trip isn\'t in progress, so your location isn\'t being shared.' });
  const { latitude, longitude, accuracyM } = req.body || {};
  const { isValidCoordinate } = require('../geo-distance');
  if (!isValidCoordinate(latitude, longitude) || (latitude === 0 && longitude === 0)) return res.status(400).json({ error: 'That isn\'t a valid position' });
  const acc = Number(accuracyM);
  await db.update('contracts', contract.id, {
    liveLocation: {
      latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6,
      accuracyM: Number.isFinite(acc) && acc > 0 && acc < 100000 ? Math.round(acc) : null,
      at: new Date().toISOString(),
    },
  });
  res.json({ ok: true });
});

// GET /api/contracts/:id/tracking — for the customer and the pro on this booking.
router.get('/contracts/:id/tracking', requireAuth, async (req, res) => {
  const contract = await db.find('contracts', c => c.id === req.params.id && (c.customerId === req.user.sub || c.providerId === req.user.sub));
  if (!contract) return res.status(404).json({ error: 'Booking not found' });
  const { distanceInMiles, isValidCoordinate } = require('../geo-distance');
  const pro = await db.find('users', u => u.id === contract.providerId);
  const customer = await db.find('users', u => u.id === contract.customerId);
  const tripOpen = contract.status === 'active' && !!contract.onMyWayAt && !contract.arrivedAt
    && (Date.now() - new Date(contract.onMyWayAt).getTime()) < LIVE_TRIP_MAX_MS;
  const phase = contract.arrivedAt ? 'arrived' : tripOpen ? 'on_the_way' : (contract.onMyWayAt ? 'ended' : 'not_started');
  const live = tripOpen && contract.liveLocation && isValidCoordinate(contract.liveLocation.latitude, contract.liveLocation.longitude) ? contract.liveLocation : null;
  const job = contract.jobLocation && isValidCoordinate(contract.jobLocation.latitude, contract.jobLocation.longitude) ? contract.jobLocation : null;
  const miles = live && job ? distanceInMiles(live.latitude, live.longitude, job.latitude, job.longitude) : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    phase,
    proName: pro ? pro.name : 'Your pro',
    customerName: customer ? customer.name : 'Customer',
    service: contract.service,
    onMyWayAt: contract.onMyWayAt || null,
    arrivedAt: contract.arrivedAt || null,
    proLocation: live ? { latitude: live.latitude, longitude: live.longitude, accuracyM: live.accuracyM } : null,
    secondsSinceUpdate: live ? Math.max(0, Math.round((Date.now() - new Date(live.at).getTime()) / 1000)) : null,
    jobLocation: job ? { latitude: job.latitude, longitude: job.longitude, accuracyM: job.accuracyM } : null,
    landmark: contract.landmark || null,
    distanceMiles: miles != null ? Math.round(miles * 100) / 100 : null,
    distanceKm: miles != null ? Math.round(miles * 1.609344 * 100) / 100 : null,
  });
});

router.post('/contracts/:id/arrived', requireAuth, requireRole('provider'), async (req, res) => {
  const contract = await db.find('contracts', c => c.id === req.params.id && c.providerId === req.user.sub);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (contract.status !== 'active') return res.status(400).json({ error: `This booking is ${contract.status} — it can't be marked arrived` });
  if (contract.arrivedAt) return res.status(400).json({ error: 'Already marked arrived for this booking' });

  const { latitude, longitude } = req.body || {};
  const hasValidCoords = typeof latitude === 'number' && typeof longitude === 'number' && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  const updated = await db.update('contracts', contract.id, {
    arrivedAt: new Date().toISOString(),
    arrivedLocation: hasValidCoords ? { latitude, longitude } : null,
    liveLocation: null, // v93: the trip is over, so the live position is wiped
  });

  if (hasValidCoords) {
    const { checkImplausibleTravelSpeed } = require('../fraud-detection');
    await checkImplausibleTravelSpeed(updated);
  }

  const provider = await db.find('users', u => u.id === req.user.sub);
  await notify(contract.customerId, '📍', `${provider ? provider.name : 'Your provider'} has arrived for "${contract.service}".`, 'bookingUpdates', { section: 'bookings' });
  res.json({ contract: updated });
});

// POST /api/contracts/:id/scope-change-request — a provider's way to
// handle a job that turns out bigger than what was actually posted or
// booked: request a specific additional amount through the platform,
// with a real reason, rather than negotiating extra money off-platform
// (which the app explicitly warns against everywhere else — see the
// Trust & Safety section of the handbook). This only ever proposes —
// nothing about the contract or the held escrow changes until the
// customer explicitly approves it below. Restricted to active contracts
// only: a scope discovery makes sense mid-job, not after it's already
// been marked complete and paid out.
router.post('/contracts/:id/scope-change-request', requireAuth, requireRole('provider'), async (req, res) => {
  const contract = await db.find('contracts', c => c.id === req.params.id && c.providerId === req.user.sub);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (contract.status !== 'active') return res.status(400).json({ error: `This booking is ${contract.status} — additional requests only apply to active jobs` });

  const { amount, reason } = req.body || {};
  if (typeof amount !== 'number' || amount <= 0 || amount > contract.amount * 5) {
    return res.status(400).json({ error: 'Enter a positive additional amount (and a realistic one — under 5x the original job price)' });
  }
  if (!isNonEmptyString(reason, { min: 10, max: 500 })) {
    return res.status(400).json({ error: 'Explain what changed about the job (at least 10 characters) — the customer needs a real reason to approve this' });
  }

  const existing = await db.find('scopeChangeRequests', r => r.contractId === contract.id && r.status === 'pending');
  if (existing) return res.status(400).json({ error: 'There\'s already a pending additional request for this job — wait for the customer to respond to it first' });

  const requestingProvider = await db.find('users', u => u.id === req.user.sub);
  const request = {
    id: `scr_${nanoid(10)}`,
    contractId: contract.id,
    providerId: contract.providerId,
    customerId: contract.customerId,
    amount: Math.round(amount * 100) / 100,
    reason: reason.trim(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await db.insert('scopeChangeRequests', request);
  await notify(contract.customerId, '📋', `${requestingProvider ? requestingProvider.name : 'Your provider'} is requesting an additional $${request.amount} for "${contract.service}": "${request.reason.slice(0, 80)}${request.reason.length > 80 ? '…' : ''}" — review and approve or decline.`, null, { section: 'bookings' });
  res.status(201).json({ request });
});

// GET /api/contracts/:id/scope-change-requests — either party to the
// contract can see the real history of requests on it, not just
// whatever's currently pending.
router.get('/contracts/:id/scope-change-requests', requireAuth, async (req, res) => {
  const contract = await db.find('contracts', c => c.id === req.params.id && (c.customerId === req.user.sub || c.providerId === req.user.sub));
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  const requests = (await db.filter('scopeChangeRequests', r => r.contractId === contract.id)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ requests });
});

// POST /api/scope-change-requests/:id/decide — the customer's real
// approve/decline. Approving is what actually adjusts the contract: the
// agreed amount goes up by the requested addition, and — critically —
// the SAME escrow record gets its held amount increased too (this app's
// escrow model is one record per contract everywhere else, so a second
// escrow record for the addition would silently break payout,
// completion, and PDF logic that all look up escrow by contract with a
// single find(), not a list). Declining changes nothing.
router.post('/scope-change-requests/:id/decide', requireAuth, requireRole('customer'), async (req, res) => {
  const request = await db.find('scopeChangeRequests', r => r.id === req.params.id && r.customerId === req.user.sub);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  // Locked on the real contract id (not the scope-change request id from
  // the URL) — this is the same shared lock /complete and /cancel use,
  // so an approval here can never interleave with the customer
  // completing or cancelling the very contract it's about to modify.
  if (contractStatusLocks.has(request.contractId)) {
    return res.status(409).json({ error: 'This booking is already being updated — please try again in a moment.' });
  }
  contractStatusLocks.add(request.contractId);
  try {
    return await handleScopeChangeDecide(req, res, request);
  } finally {
    contractStatusLocks.delete(request.contractId);
  }
});

async function handleScopeChangeDecide(req, res, request) {
  // Re-read fresh under the lock — the request looked up before
  // acquiring it could theoretically be stale if another request for
  // the same contract was mid-flight.
  request = await db.find('scopeChangeRequests', r => r.id === request.id);
  if (!request || request.status !== 'pending') return res.status(400).json({ error: 'This request has already been decided' });

  const { decision } = req.body || {};
  if (!['approve', 'decline'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or decline' });

  const contract = await db.find('contracts', c => c.id === request.contractId);
  if (!contract) return res.status(404).json({ error: 'The original contract no longer exists' });

  if (decision === 'decline') {
    await db.update('scopeChangeRequests', request.id, { status: 'declined', decidedAt: new Date().toISOString() });
    await notify(request.providerId, '❌', `Your additional request for $${request.amount} on "${contract.service}" was declined.`, null, { section: 'contracts' });
    return res.json({ request: { ...request, status: 'declined' } });
  }

  if (contract.status !== 'active') {
    return res.status(400).json({ error: `This booking is now ${contract.status} — it can no longer be adjusted` });
  }

  const updatedContract = await db.update('contracts', contract.id, { amount: Math.round((contract.amount + request.amount) * 100) / 100 });
  const escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
  if (escrow) {
    await db.update('escrowTransactions', escrow.id, { amount: Math.round((escrow.amount + request.amount) * 100) / 100 });
  }
  await db.update('scopeChangeRequests', request.id, { status: 'approved', decidedAt: new Date().toISOString() });

  await notify(request.providerId, '✅', `Your additional request for $${request.amount} on "${contract.service}" was approved — the contract and held escrow have been updated. New total: $${updatedContract.amount}.`, null, { section: 'contracts' });
  res.json({ request: { ...request, status: 'approved' }, contract: updatedContract });
}

router.post('/contracts/:id/complete', requireAuth, requireRole('customer'), async (req, res) => {
  if (contractStatusLocks.has(req.params.id)) {
    return res.status(409).json({ error: 'This booking is already being updated — please try again in a moment.' });
  }
  contractStatusLocks.add(req.params.id);
  try {
    return await handleContractComplete(req, res);
  } finally {
    contractStatusLocks.delete(req.params.id);
  }
});

async function handleContractComplete(req, res) {
  const contract = await db.find('contracts', c => c.id === req.params.id && c.customerId === req.user.sub);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (contract.status !== 'active') {
    return res.status(400).json({ error: `This booking is already ${contract.status} and can't be marked complete` });
  }

  // Tipping — genuinely optional (default $0, never required to complete
  // a job), and deliberately kept separate from the escrow/commission
  // flow entirely: a tip is 100% the provider's, taken out of the
  // commission calculation at payout time below rather than folded into
  // the same gross-earnings number the commission rate applies to.
  const { tipAmount } = req.body || {};
  let tip = 0;
  if (tipAmount !== undefined && tipAmount !== null && tipAmount !== '') {
    if (typeof tipAmount !== 'number' || tipAmount < 0 || tipAmount > contract.amount * 3) {
      return res.status(400).json({ error: 'Tip must be a positive number (and a realistic one — under 3x the job price)' });
    }
    tip = Math.round(tipAmount * 100) / 100;
  }

  const done = await completeContractCore(contract, tip, req.user.sub);
  // v108: a store order's driver is paid when the customer has the goods.
  try { await require('../store-orders').afterComplete(contract, req.user.sub); } catch (e) { console.error('[store-orders] after complete:', e.message); }
  res.json(done);
}

// v108: the part of "mark complete" that releases the money, on its own, so
// a store order can complete its delivery with the same steps. The caller
// has already checked who is asking and that the booking is active.
async function completeContractCore(contract, tip, customerId) {
  const escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
  if (escrow) await db.update('escrowTransactions', escrow.id, { status: 'released' });
  const updated = await db.update('contracts', contract.id, { status: 'completed', tipAmount: tip, tipPaid: false, completedAt: new Date().toISOString() }); // v105: the day it was completed, for invoices and the tax report

  // Real completed-jobs tracking — this used to be a static number set once
  // at signup and never touched again (every provider profile showed the
  // same seed value forever, regardless of real activity). Now it's
  // incremented for real, exactly once, the moment a job is genuinely
  // confirmed complete — the same event that releases their escrow.
  const provider = await db.find('users', u => u.id === contract.providerId);
  if (provider) await db.update('users', provider.id, { jobs: (provider.jobs || 0) + 1 });

  // Real tier-advancement check — the actual fix for providers previously
  // being able to just click a button and set their own tier regardless
  // of whether they'd earned it. This runs on the exact same event that
  // updates their completed-jobs count, so it always checks against
  // genuinely current data.
  const { checkAndAdvanceProviderTier } = require('../commission');
  await checkAndAdvanceProviderTier(contract.providerId).catch(e => console.error('[tier-advancement] Unexpected error:', e));

  // The alert tells the provider their real, current total available
  // balance — not just this one job's amount — so it's an accurate,
  // actionable number the moment they see it, matching exactly what
  // they'd see if they opened Earnings & Payouts right now.
  const providerContracts = await db.filter('contracts', c => c.providerId === contract.providerId);
  const providerContractIds = new Set(providerContracts.map(c => c.id));
  const releasedUnpaid = (await db.filter('escrowTransactions', e => e.status === 'released' && !e.payoutId))
    .filter(e => providerContractIds.has(e.contractId));
  const totalAvailable = releasedUnpaid.reduce((s, e) => s + e.amount, 0);

  await notify(contract.providerId, '💰', `Escrow released — $${contract.amount} for ${contract.service}. You now have $${totalAvailable} available to request as a payout.`, 'payoutAlerts', { section: 'earnings' });
  if (tip > 0) {
    await notify(contract.providerId, '🌟', `${(await db.find('users', u => u.id === customerId))?.name || 'The customer'} left you a $${tip} tip on "${contract.service}" — 100% yours, no commission, added to your next payout.`, 'payoutAlerts', { section: 'earnings' });
  }
  return { contract: updated, escrow: escrow ? { ...escrow, status: 'released' } : null };
}

// POST /api/contracts/:id/cancel — either the customer or the provider can
// cancel a booking before it's marked complete, or withdraw a Mutual
// Agreement offer that hasn't been responded to yet. Escrow is refunded
// (not released to the provider) since no work was confirmed done — and for
// a still-pending offer, there's no escrow yet to begin with, since funds
// were never held until the provider actually agreed to a number. The other
// party is notified either way.
router.post('/contracts/:id/cancel', requireAuth, async (req, res) => {
  if (contractStatusLocks.has(req.params.id)) {
    return res.status(409).json({ error: 'This booking is already being updated — please try again in a moment.' });
  }
  contractStatusLocks.add(req.params.id);
  try {
    return await handleContractCancel(req, res);
  } finally {
    contractStatusLocks.delete(req.params.id);
  }
});

// These specific reasons are explicitly protected by policy — a provider
// stopping a job for one of these must never count against them anywhere
// a cancellation rate is calculated (this file, or the tier-progress
// dashboard). This is enforced as a real system rule here, not left to
// support discretion downstream.
const PROTECTED_CANCEL_REASONS = new Set(['not_as_described', 'unsafe', 'out_of_category', 'unlicensed_required']);
const CANCEL_REASON_LABELS = {
  not_as_described: 'Job not as described',
  unsafe: 'Became unsafe to continue',
  out_of_category: 'Turned out to need a different trade/category',
  unlicensed_required: 'Requires a license I don\'t hold',
  customer_request: 'Customer asked to cancel',
  schedule_conflict: 'Scheduling conflict',
  other: 'Other',
};

async function handleContractCancel(req, res) {
  const { reason } = req.body || {};
  const reasonCategory = (reason && CANCEL_REASON_LABELS[reason]) ? reason : 'other';
  const contract = await db.find('contracts', c =>
    c.id === req.params.id && (c.customerId === req.user.sub || c.providerId === req.user.sub)
  );
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (!['active', 'pending_agreement', 'pending_provider_confirmation'].includes(contract.status)) {
    return res.status(400).json({ error: `This booking is already ${contract.status} and can't be cancelled` });
  }
  const escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
  if (escrow) await db.update('escrowTransactions', escrow.id, { status: 'refunded' });
  const iAmProvider = contract.providerId === req.user.sub;
  const isProtected = iAmProvider && PROTECTED_CANCEL_REASONS.has(reasonCategory);
  const updated = await db.update('contracts', contract.id, {
    status: 'cancelled',
    cancelReasonCategory: reasonCategory,
    cancelledByRole: iAmProvider ? 'provider' : 'customer',
    protectedCancellation: isProtected,
  });
  await require('../store').giveBackStock(contract); // v105: goods not yet handed over go back on the shelf
  // v108: a store order and its delivery go together. Cancelling the order
  // cancels a delivery that hasn't collected the goods yet; a driver
  // cancelling tells the customer and the seller so another can be chosen.
  try { await require('../store-orders').afterCancel(updated, req.user.sub); } catch (e) { console.error('[store-orders] after cancel:', e.message); }

  if (isProtected) {
    const { checkProtectedCancellationAbuse } = require('../fraud-detection');
    await checkProtectedCancellationAbuse(contract.providerId);
  }

  const iAmCustomer = contract.customerId === req.user.sub;
  const otherPartyId = iAmCustomer ? contract.providerId : contract.customerId;
  const canceller = await db.find('users', u => u.id === req.user.sub);
  const reasonNote = isProtected ? ` Reason: ${CANCEL_REASON_LABELS[reasonCategory]} — this does not count against them.` : '';
  const message = escrow
    ? `${canceller ? canceller.name : 'The other party'} cancelled the booking for "${contract.service}". Any held escrow has been refunded.${reasonNote}`
    : `${canceller ? canceller.name : 'The other party'} withdrew the offer for "${contract.service}".${reasonNote}`;
  await notify(otherPartyId, '🚫', message, 'bookingUpdates', { section: 'bookings' });

  res.json({ contract: updated, escrow: escrow ? { ...escrow, status: 'refunded' } : null });
}

// GET /api/payments/mine — a customer's real payment history: every
// contract they've funded, who the provider was, and what currency they
// actually paid in. The same "who paid / who got paid" concept as the
// provider's payout history, just from the other side of the transaction.
router.get('/payments/mine', requireAuth, requireRole('customer'), async (req, res) => {
  const { from, to } = req.query;
  let contracts = await db.filter('contracts', c => c.customerId === req.user.sub);
  if (from) contracts = contracts.filter(c => (c.createdAt || '').slice(0, 10) >= from);
  if (to) contracts = contracts.filter(c => (c.createdAt || '').slice(0, 10) <= to);
  contracts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const payments = await Promise.all(contracts.map(async c => {
    const provider = await db.find('users', u => u.id === c.providerId);
    const escrow = await db.find('escrowTransactions', e => e.contractId === c.id);
    const dispute = await db.find('disputes', d => d.contractId === c.id);
    return {
      contractId: c.id,
      bookingNumber: c.bookingNumber || c.id,
      date: (c.createdAt || '').slice(0, 10),
      providerName: provider ? provider.name : 'Unknown provider',
      providerEmail: provider ? provider.email : null,
      providerPhone: provider ? provider.phone : null,
      service: c.service,
      jobDate: c.date || null,
      jobTime: c.time || null,
      address: c.address || null,
      amount: c.amount,
      status: c.status,
      escrowStatus: escrow ? escrow.status : 'none',
      paidCurrency: escrow ? escrow.paidCurrency : 'USD',
      paidAmountLocal: escrow ? escrow.paidAmountLocal : null,
      disputeStatus: dispute ? dispute.status : null,
    };
  }));
  res.json({ payments });
});

// GET /api/payments/pdf — a real, downloadable payment history report for a
// customer, same date-range concept as the provider's payout report.
router.get('/payments/pdf', requireAuth, requireRole('customer'), async (req, res) => {
  const { from, to } = req.query;
  const customer = await db.find('users', u => u.id === req.user.sub);
  let contracts = await db.filter('contracts', c => c.customerId === req.user.sub);
  if (from) contracts = contracts.filter(c => (c.createdAt || '').slice(0, 10) >= from);
  if (to) contracts = contracts.filter(c => (c.createdAt || '').slice(0, 10) <= to);
  contracts.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const rows = await Promise.all(contracts.map(async c => {
    const provider = await db.find('users', u => u.id === c.providerId);
    const escrow = await db.find('escrowTransactions', e => e.contractId === c.id);
    return { c, provider, escrow };
  }));

  const { createReportDoc } = require('../pdf-report-builder');
  const rangeLabel = from || to ? `${from || 'earliest'} to ${to || 'today'}` : 'All time';
  const { sectionHeader, row, twoColumnRow, table, finish } = createReportDoc({
    res,
    filename: `Trothen-Payment-History-${customer.name.replace(/\s+/g, '-')}.pdf`,
    title: 'Payment History Report',
    subtitle: 'AI-Matched · Identity-Verified · Escrow-Protected',
    docId: rangeLabel,
    verificationSeed: `payments|${customer.id}|${from || ''}|${to || ''}|${contracts.length}`,
  });

  sectionHeader('Report Summary');
  twoColumnRow('Customer', `${customer.name} (${customer.email})`, 'Date Range', rangeLabel);
  const totalPaid = contracts.reduce((s, c) => s + c.amount, 0);
  row('Total Paid (USD)', `$${totalPaid.toFixed(2)} across ${contracts.length} booking${contracts.length === 1 ? '' : 's'}`);

  sectionHeader('Bookings & Payments');
  if (rows.length === 0) {
    row('No payments', 'No payments were found in this date range.');
  } else {
    table(
      [{ label: 'Date', width: 65 }, { label: 'Provider', width: 100 }, { label: 'Service', width: 165 }, { label: 'Booking #', width: 75 }, { label: 'Amount', width: 55, align: 'right' }],
      rows.map(({ c, provider }) => [(c.createdAt || '').slice(0, 10), provider ? provider.name : 'Unknown', c.service, c.bookingNumber || c.id, `$${c.amount}`])
    );
  }

  finish({
    closingNote: 'This report reflects Trothen\'s payment records for this customer account as of the moment it was generated. All amounts shown are in USD, the platform\'s canonical accounting currency, regardless of what currency was actually charged at checkout. Provided for the customer\'s own recordkeeping.',
  });
});

// the Financial team when an admin account has been set up that way — a
// super admin or an unscoped regional admin still sees this unchanged.
router.get('/escrow/summary', requireAuth, requireRole('admin'), async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!me.isSuperAdmin && me.adminDepartment && !['financial', 'legal'].includes(me.adminDepartment)) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${me.adminDepartment} team and doesn't have access to this.` });
  }
  // A regional admin (no department, just assigned a city) should only ever
  // see their own city's numbers here — every other financial view already
  // works this way; this was the one that didn't, which meant a regional
  // admin could see platform-wide totals well beyond their own city.
  const region = (!me.isSuperAdmin && !me.adminDepartment) ? me.region : null;
  // v90: a regional admin may cover a whole country instead of one city.
  const sameTxt = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
  const mine = (person) => (me.adminScope === 'country' && me.country) ? sameTxt(person.country, me.country) : sameTxt(person.city, region);

  let all = await db.all('escrowTransactions');
  let payouts = await db.all('payouts');
  if (region) {
    const contracts = await db.all('contracts');
    const allCustomers = await db.filter('users', u => u.role === 'customer');
    const customerById = new Map(allCustomers.map(c => [c.id, c]));
    const regionalContractIds = new Set();
    for (const c of contracts) {
      const customer = customerById.get(c.customerId);
      if (customer && mine(customer)) regionalContractIds.add(c.id);
    }
    all = all.filter(e => regionalContractIds.has(e.contractId));
    const regionalProviderIds = new Set((await db.filter('users', u => u.role === 'provider' && mine(u))).map(u => u.id));
    payouts = payouts.filter(p => regionalProviderIds.has(p.providerId));
  }

  const held = all.filter(e => e.status === 'held').reduce((s, e) => s + e.amount, 0);
  const released = all.filter(e => e.status === 'released').reduce((s, e) => s + e.amount, 0);
  // Real commission revenue — the sum of what's actually been deducted
  // across every payout ever made, not a placeholder figure.
  const commissionRevenue = payouts.reduce((s, p) => s + (p.commissionAmount || 0) + (p.storeFeeAmount || 0), 0); // v106: store fees paid by pros count as Trothen's share too
  // Real service fee revenue — the customer-side fee, genuinely separate
  // from commission (which comes from the provider's side). Summed across
  // every contract that actually reached a real transaction, matching the
  // same escrow records already being counted above, not a separate,
  // possibly-inconsistent query.
  const serviceFeeRevenue = all.reduce((s, e) => s + (e.serviceFee || 0), 0);
  res.json({ held, released, count: all.length, commissionRevenue, serviceFeeRevenue });
});

// GET /api/admin/financial-by-region — a real, per-city breakdown of escrow
// held/released and commission revenue, plus a grand total row, so the
// super admin (or the financial team) can actually see how each region is
// performing rather than only ever seeing one flattened global number.
router.get('/admin/financial-by-region', requireAuth, requireRole('admin'), async (req, res) => {
  const { logAccess } = require('../access-log');
  await logAccess(req, 'financial_by_region');
  const me = await db.find('users', u => u.id === req.user.sub);
  if (!me.isSuperAdmin && me.adminDepartment && !['financial', 'legal'].includes(me.adminDepartment)) {
    return res.status(403).json({ error: `Your admin account is scoped to the ${me.adminDepartment} team and doesn't have access to this.` });
  }
  // Same fix as /escrow/summary above: a plain regional admin (no
  // department, just assigned a city) must only ever see their own
  // region's row here — this endpoint was the one place in the file that
  // still returned every region's real financial data to whoever asked,
  // regardless of which city they actually administer. A super admin or
  // an unscoped financial/legal admin still sees every region unchanged.
  const region = (!me.isSuperAdmin && !me.adminDepartment) ? me.region : null;
  // v90: a regional admin may cover a whole country instead of one city.
  const sameTxt = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
  const mine = (person) => (me.adminScope === 'country' && me.country) ? sameTxt(person.country, me.country) : sameTxt(person.city, region);

  // Optional date range, applied the same way the Platform Transactions
  // panel applies it (against the contract's createdAt for escrow, and the
  // payout's own date for commission) — so the two panels stay in sync
  // when an admin filters by date.
  const { from, to } = req.query;

  const contracts = await db.all('contracts');
  let escrow = await db.all('escrowTransactions');
  let payouts = await db.all('payouts');
  const customers = await db.filter('users', u => u.role === 'customer');
  const providers = await db.filter('users', u => u.role === 'provider');
  const customerById = new Map(customers.map(c => [c.id, c]));
  const providerById = new Map(providers.map(p => [p.id, p]));
  const contractById = new Map(contracts.map(c => [c.id, c]));

  if (from || to) {
    escrow = escrow.filter(e => {
      const contract = contractById.get(e.contractId);
      const date = (contract && contract.createdAt || '').slice(0, 10);
      if (from && date < from) return false;
      if (to && date > to) return false;
      return true;
    });
    payouts = payouts.filter(p => {
      const date = (p.date || '').slice(0, 10);
      if (from && date < from) return false;
      if (to && date > to) return false;
      return true;
    });
  }

  // Group everything by the CUSTOMER's city — same convention used
  // everywhere else a "region" is derived (disputes, transactions).
  const byRegion = new Map(); // region -> { region, country, held, released, commissionRevenue, serviceFeeRevenue, transactionCount }
  function bucket(region, country) {
    if (!byRegion.has(region)) byRegion.set(region, { region, country, held: 0, released: 0, commissionRevenue: 0, serviceFeeRevenue: 0, transactionCount: 0 });
    return byRegion.get(region);
  }

  for (const e of escrow) {
    const contract = contractById.get(e.contractId);
    const customer = contract && customerById.get(contract.customerId);
    if (!customer) continue;
    const b = bucket(customer.city || 'Unknown', customer.country || 'Unknown');
    if (e.status === 'held') b.held += e.amount;
    if (e.status === 'released') b.released += e.amount;
    b.serviceFeeRevenue += (e.serviceFee || 0);
    b.transactionCount += 1;
  }
  for (const p of payouts) {
    const provider = providerById.get(p.providerId);
    if (!provider) continue;
    const b = bucket(provider.city || 'Unknown', provider.country || 'Unknown');
    b.commissionRevenue += (p.commissionAmount || 0) + (p.storeFeeAmount || 0);
  }

  // Average transaction value per region — total volume moved (held +
  // released) divided by however many escrow transactions built that
  // volume. Guards against divide-by-zero for a region with commission
  // activity but no escrow transactions in range.
  for (const b of byRegion.values()) {
    b.avgTransaction = b.transactionCount > 0 ? Math.round(((b.held + b.released) / b.transactionCount) * 100) / 100 : 0;
  }

  let regions = Array.from(byRegion.values()).sort((a, b) => (b.held + b.released) - (a.held + a.released));
  if (region) {
    regions = regions.filter(r => (me.adminScope === 'country' && me.country) ? sameTxt(r.country, me.country) : sameTxt(r.region, region));
  }
  const total = regions.reduce((acc, r) => ({
    held: acc.held + r.held,
    released: acc.released + r.released,
    commissionRevenue: acc.commissionRevenue + r.commissionRevenue,
    serviceFeeRevenue: acc.serviceFeeRevenue + r.serviceFeeRevenue,
    transactionCount: acc.transactionCount + r.transactionCount,
  }), { held: 0, released: 0, commissionRevenue: 0, serviceFeeRevenue: 0, transactionCount: 0 });
  total.avgTransaction = total.transactionCount > 0 ? Math.round(((total.held + total.released) / total.transactionCount) * 100) / 100 : 0;

  res.json({ regions, total });
});

// GET /api/admin/report-builder — a real, flexible query over actual
// contracts: any combination of date range, category, city, country,
// status, and provider tier. Returns both the filtered rows themselves
// (for a real table or CSV export) and honest aggregate stats computed
// from exactly those same rows — never a separately-computed, possibly
// inconsistent summary number.
router.get('/admin/report-builder', requireAuth, requireRole('admin'), async (req, res) => {
  const { dateFrom, dateTo, category, city, country, status, providerTier } = req.query;
  const requestingAdmin = await db.find('users', u => u.id === req.user.sub);
  const region = requestingAdmin && !requestingAdmin.isSuperAdmin && !requestingAdmin.adminDepartment ? requestingAdmin.region : null;
  const allContracts = await db.all('contracts');
  const allUsers = await db.all('users');
  const userById = new Map(allUsers.map(u => [u.id, u]));

  const rows = [];
  for (const c of allContracts) {
    const provider = userById.get(c.providerId);
    const customer = userById.get(c.customerId);
    if (!provider || !customer) continue;
    if (region) { // regional admins only ever see their own area's real activity (v90: a city, or their whole country)
      const same = (x, y) => String(x || '').trim().toLowerCase() === String(y || '').trim().toLowerCase();
      const covered = (requestingAdmin.adminScope === 'country' && requestingAdmin.country) ? same(provider.country, requestingAdmin.country) : same(provider.city, region);
      if (!covered) continue;
    }
    if (city && provider.city !== city) continue;
    if (country && provider.country !== country) continue;
    if (category && provider.category !== category) continue;
    if (status && c.status !== status) continue;
    if (providerTier && (provider.plan || 'starter') !== providerTier) continue;
    const created = c.createdAt ? c.createdAt.slice(0, 10) : null;
    if (dateFrom && created && created < dateFrom) continue;
    if (dateTo && created && created > dateTo) continue;

    rows.push({
      bookingNumber: c.bookingNumber, service: c.service, status: c.status,
      amount: c.amount, serviceFee: c.serviceFee || 0,
      customerName: customer.name, providerName: provider.name,
      providerCategory: provider.category, providerTier: provider.plan || 'starter',
      city: provider.city, country: provider.country,
      createdAt: c.createdAt,
    });
  }

  const total = {
    count: rows.length,
    gmv: Math.round(rows.reduce((s, r) => s + (r.amount || 0), 0) * 100) / 100,
    serviceFeeRevenue: Math.round(rows.reduce((s, r) => s + (r.serviceFee || 0), 0) * 100) / 100,
    completed: rows.filter(r => r.status === 'completed').length,
    cancelled: rows.filter(r => r.status === 'cancelled').length,
  };

  res.json({ rows, total });
});

module.exports = router;
module.exports.completeContractCore = completeContractCore; // v108
