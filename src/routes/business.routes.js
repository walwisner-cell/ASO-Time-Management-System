// v105: business tools for a pro.
//
//   - Quotes and estimates: build one from lines (goods from the store or
//     typed in), add tax, download it as a PDF, turn it into an invoice.
//   - Invoices: one is made automatically for every completed Trothen
//     booking; a pro can also write their own for work done off Trothen.
//   - Tools: a list of the pro's tools, where each one is and what state
//     it is in.
//   - Expenses: what the pro spent, by kind, with an optional receipt photo.
//   - Summary: income, expenses, tax and profit for any period, by month,
//     and as a tax report (PDF or spreadsheet).
//
// These are record-keeping tools. They do the arithmetic; they do not
// decide what tax a pro owes. Every report says so.
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { UPLOADS_DIR, verifyImageMagicBytes } = require('../uploads');
const { isNonEmptyString } = require('../validators');

const router = express.Router();
const pro = [requireAuth, requireRole('provider')];
const money = (n) => Math.round(Number(n) * 100) / 100;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
const today = () => new Date().toISOString().slice(0, 10);
const text = (v, max) => (v === undefined || v === null) ? '' : String(v).trim().slice(0, max);
const csvCell = (v) => {
  let s = String(v === null || v === undefined ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // so a spreadsheet never runs a typed value as a formula
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

// ── Business details used on quotes and invoices ───────────────────────
const BUSINESS_DEFAULTS = { taxRatePct: 0, taxLabel: 'Tax', taxId: '', trothenPricesIncludeTax: false, footerNote: '', contactLine: '' };
function businessOf(user) {
  return { ...BUSINESS_DEFAULTS, ...((user && user.business) || {}) };
}
router.get('/business/settings', pro, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  res.json({ business: businessOf(me), displayName: me.businessName || me.name });
});
router.put('/business/settings', pro, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  const b = req.body || {};
  const rate = Number(b.taxRatePct);
  if (!Number.isFinite(rate) || rate < 0 || rate > 50) return res.status(400).json({ error: 'The tax rate must be between 0 and 50 percent' });
  const next = {
    ...businessOf(me),
    taxRatePct: Math.round(rate * 100) / 100,
    taxLabel: text(b.taxLabel, 20) || 'Tax',
    taxId: text(b.taxId, 40),
    trothenPricesIncludeTax: b.trothenPricesIncludeTax === true,
    footerNote: text(b.footerNote, 300),
    contactLine: text(b.contactLine, 120),
  };
  await db.update('users', me.id, { business: next });
  res.json({ business: next });
});

// ── Tools ──────────────────────────────────────────────────────────────
const TOOL_CONDITIONS = ['good', 'needs_service', 'broken', 'lost'];
function readTool(b, existing) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b || {}, k);
  if (!existing || has('name')) { if (!isNonEmptyString(b.name, { min: 2, max: 80 })) return { error: 'Give the tool a name of 2 to 80 characters' }; out.name = b.name.trim(); }
  if (has('serial')) out.serial = text(b.serial, 60);
  if (has('location')) out.location = text(b.location, 80);
  if (has('notes')) out.notes = text(b.notes, 300);
  if (has('condition')) { if (!TOOL_CONDITIONS.includes(b.condition)) return { error: 'Choose the tool\'s condition from the list' }; out.condition = b.condition; }
  if (has('value')) { if (b.value === null || b.value === '') out.value = null; else if (typeof b.value !== 'number' || b.value < 0 || b.value > 10000000) return { error: 'The value must be zero or more' }; else out.value = money(b.value); }
  for (const k of ['boughtOn', 'serviceDue']) if (has(k)) { if (!b[k]) out[k] = null; else if (!isDay(b[k])) return { error: 'Enter the date as a real date' }; else out[k] = b[k]; }
  return { out };
}
router.get('/business/tools', pro, async (req, res) => {
  const tools = (await db.filter('proTools', t => t.providerId === req.user.sub)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  res.json({ tools, conditions: TOOL_CONDITIONS });
});
router.post('/business/tools', pro, async (req, res) => {
  const { out, error } = readTool(req.body, null);
  if (error) return res.status(400).json({ error });
  if ((await db.filter('proTools', t => t.providerId === req.user.sub)).length >= 300) return res.status(400).json({ error: 'The tool list holds up to 300 tools.' });
  const tool = { id: `tool_${nanoid(10)}`, providerId: req.user.sub, serial: '', location: '', notes: '', condition: 'good', value: null, boughtOn: null, serviceDue: null, ...out, createdAt: new Date().toISOString() };
  await db.insert('proTools', tool);
  res.status(201).json({ tool });
});
router.patch('/business/tools/:id', pro, async (req, res) => {
  const tool = await db.find('proTools', t => t.id === req.params.id && t.providerId === req.user.sub);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  const { out, error } = readTool(req.body, tool);
  if (error) return res.status(400).json({ error });
  res.json({ tool: await db.update('proTools', tool.id, out) });
});
router.delete('/business/tools/:id', pro, async (req, res) => {
  const tool = await db.find('proTools', t => t.id === req.params.id && t.providerId === req.user.sub);
  if (!tool) return res.status(404).json({ error: 'Tool not found' });
  await db.remove('proTools', tool.id);
  res.json({ ok: true });
});

// ── Expenses ───────────────────────────────────────────────────────────
const EXPENSE_KINDS = ['Materials', 'Stock for the store', 'Tools & equipment', 'Transport & fuel', 'Rent & utilities', 'Phone & data', 'Wages & helpers', 'Licences & insurance', 'Marketing', 'Other'];
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `receipt_${req.user.sub}_${nanoid(12)}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')}`),
  }),
  fileFilter: (req, file, cb) => ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG, PNG, WEBP or GIF photos are allowed')),
  limits: { fileSize: 12 * 1024 * 1024 },
});
router.post('/business/receipt/upload', pro, (req, res) => {
  receiptUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too big. The limit is 12MB.' : (err.message || 'Upload failed') });
    if (!req.file) return res.status(400).json({ error: 'No photo was provided' });
    if (!verifyImageMagicBytes(req.file.path, req.file.mimetype)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'This file does not appear to be a real photo.' }); }
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});
function readExpense(b, userId, existing) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b || {}, k);
  if (!existing || has('amount')) { if (typeof b.amount !== 'number' || !(b.amount > 0) || b.amount > 10000000) return { error: 'Enter the amount spent, above zero' }; out.amount = money(b.amount); }
  if (!existing || has('date')) { if (!isDay(b.date) || b.date > today()) return { error: 'Enter the day it was spent (not a day in the future)' }; out.date = b.date; }
  if (!existing || has('kind')) { if (!EXPENSE_KINDS.includes(b.kind)) return { error: 'Choose what kind of expense it was' }; out.kind = b.kind; }
  if (has('vendor')) out.vendor = text(b.vendor, 80);
  if (has('note')) out.note = text(b.note, 200);
  if (has('receiptUrl')) {
    if (!b.receiptUrl) out.receiptUrl = null;
    else if (typeof b.receiptUrl !== 'string' || !new RegExp(`^/uploads/receipt_${String(userId).replace(/[^\w-]/g, '')}_[\\w-]+\\.(jpe?g|png|webp|gif)$`, 'i').test(b.receiptUrl)) return { error: 'Add the receipt photo again on this page' };
    else out.receiptUrl = b.receiptUrl;
  }
  return { out };
}
router.get('/business/expenses', pro, async (req, res) => {
  const { from, to } = req.query;
  let list = await db.filter('proExpenses', e => e.providerId === req.user.sub);
  if (isDay(from)) list = list.filter(e => e.date >= from);
  if (isDay(to)) list = list.filter(e => e.date <= to);
  list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ expenses: list, kinds: EXPENSE_KINDS, total: money(list.reduce((s, e) => s + e.amount, 0)) });
});
router.post('/business/expenses', pro, async (req, res) => {
  const { out, error } = readExpense(req.body, req.user.sub, null);
  if (error) return res.status(400).json({ error });
  if ((await db.filter('proExpenses', e => e.providerId === req.user.sub)).length >= 5000) return res.status(400).json({ error: 'The expense list is full. Remove old entries first.' });
  const expense = { id: `exp_${nanoid(10)}`, providerId: req.user.sub, vendor: '', note: '', receiptUrl: null, ...out, createdAt: new Date().toISOString() };
  await db.insert('proExpenses', expense);
  res.status(201).json({ expense });
});
router.patch('/business/expenses/:id', pro, async (req, res) => {
  const e = await db.find('proExpenses', x => x.id === req.params.id && x.providerId === req.user.sub);
  if (!e) return res.status(404).json({ error: 'Expense not found' });
  const { out, error } = readExpense(req.body, req.user.sub, e);
  if (error) return res.status(400).json({ error });
  res.json({ expense: await db.update('proExpenses', e.id, out) });
});
router.delete('/business/expenses/:id', pro, async (req, res) => {
  const e = await db.find('proExpenses', x => x.id === req.params.id && x.providerId === req.user.sub);
  if (!e) return res.status(404).json({ error: 'Expense not found' });
  await db.remove('proExpenses', e.id);
  if (e.receiptUrl) { const f = path.join(UPLOADS_DIR, path.basename(e.receiptUrl)); if (f.startsWith(UPLOADS_DIR)) fs.unlink(f, () => {}); }
  res.json({ ok: true });
});

// ── Quotes, estimates and the pro's own invoices ───────────────────────
const DOC_TYPES = { quote: { label: 'Quotation', prefix: 'Q' }, estimate: { label: 'Estimate', prefix: 'E' }, invoice: { label: 'Invoice', prefix: 'INV' } };
const DOC_STATUSES = { quote: ['draft', 'sent', 'accepted', 'declined'], estimate: ['draft', 'sent', 'accepted', 'declined'], invoice: ['draft', 'sent', 'paid', 'void'] };

function totalsFor(items, taxRatePct, discount) {
  const subtotal = money(items.reduce((s, i) => s + i.lineTotal, 0));
  const disc = Math.min(money(discount || 0), subtotal);
  const taxable = money(subtotal - disc);
  const tax = money(taxable * (taxRatePct || 0) / 100);
  return { subtotal, discount: disc, tax, total: money(taxable + tax) };
}
function readDoc(b, existing, business) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b || {}, k);
  if (!existing) { if (!DOC_TYPES[b.type]) return { error: 'Choose quotation, estimate or invoice' }; out.type = b.type; }
  const type = existing ? existing.type : out.type;
  if (!existing || has('customerName')) { if (!isNonEmptyString(b.customerName, { min: 2, max: 80 })) return { error: 'Enter who it is for (2 to 80 characters)' }; out.customerName = b.customerName.trim(); }
  if (has('customerContact')) out.customerContact = text(b.customerContact, 120);
  if (has('title')) out.title = text(b.title, 120);
  if (has('notes')) out.notes = text(b.notes, 600);
  if (!existing || has('items')) {
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 40) return { error: 'Add between 1 and 40 lines' };
    const items = [];
    for (const it of b.items) {
      if (!it || !isNonEmptyString(it.description, { min: 1, max: 120 })) return { error: 'Every line needs a description (up to 120 characters)' };
      const qty = Number(it.qty), unitPrice = Number(it.unitPrice);
      if (!(qty > 0) || qty > 100000) return { error: `The quantity on "${String(it.description).slice(0, 30)}" must be above zero` };
      if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 10000000) return { error: `The price on "${String(it.description).slice(0, 30)}" must be zero or more` };
      items.push({ description: it.description.trim(), qty: Math.round(qty * 100) / 100, unitPrice: money(unitPrice), lineTotal: money(qty * unitPrice), kind: it.kind === 'goods' ? 'goods' : 'labour' });
    }
    out.items = items;
  }
  if (!existing || has('taxRatePct')) {
    const r = b.taxRatePct === undefined || b.taxRatePct === null || b.taxRatePct === '' ? business.taxRatePct : Number(b.taxRatePct);
    if (!Number.isFinite(r) || r < 0 || r > 50) return { error: 'The tax rate must be between 0 and 50 percent' };
    out.taxRatePct = Math.round(r * 100) / 100;
  }
  if (!existing || has('discount')) {
    const d = b.discount === undefined || b.discount === null || b.discount === '' ? 0 : Number(b.discount);
    if (!Number.isFinite(d) || d < 0) return { error: 'The discount must be zero or more' };
    out.discount = money(d);
  }
  for (const k of ['date', 'dueOrValidUntil']) if (has(k)) { if (!b[k]) out[k] = null; else if (!isDay(b[k])) return { error: 'Enter the date as a real date' }; else out[k] = b[k]; }
  if (has('status')) { if (!DOC_STATUSES[type].includes(b.status)) return { error: 'That status doesn\'t apply to this kind of document' }; out.status = b.status; }
  if (has('paidOn')) { if (!b.paidOn) out.paidOn = null; else if (!isDay(b.paidOn)) return { error: 'Enter the day it was paid as a real date' }; else out.paidOn = b.paidOn; }
  return { out };
}
async function nextDocNumber(userId, type) {
  const me = await db.find('users', u => u.id === userId);
  const counters = { ...((me && me.businessCounters) || {}) };
  counters[type] = (counters[type] || 0) + 1;
  await db.update('users', userId, { businessCounters: counters });
  return `${DOC_TYPES[type].prefix}-${String(counters[type]).padStart(4, '0')}`;
}
function withTotals(d) { return { ...d, ...totalsFor(d.items, d.taxRatePct, d.discount), typeLabel: DOC_TYPES[d.type].label }; }

router.get('/business/docs', pro, async (req, res) => {
  let docs = await db.filter('proDocs', d => d.providerId === req.user.sub);
  if (DOC_TYPES[req.query.type]) docs = docs.filter(d => d.type === req.query.type);
  docs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({ docs: docs.map(withTotals), statuses: DOC_STATUSES });
});
router.post('/business/docs', pro, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  const { out, error } = readDoc(req.body || {}, null, businessOf(me));
  if (error) return res.status(400).json({ error });
  if ((await db.filter('proDocs', d => d.providerId === me.id)).length >= 3000) return res.status(400).json({ error: 'The document list is full. Remove old drafts first.' });
  const doc = {
    id: `doc_${nanoid(10)}`, providerId: me.id, number: await nextDocNumber(me.id, out.type),
    customerContact: '', title: '', notes: '', date: today(), dueOrValidUntil: null, status: 'draft', paidOn: null,
    ...out, createdAt: new Date().toISOString(),
  };
  if (doc.type === 'invoice' && doc.status === 'paid' && !doc.paidOn) doc.paidOn = today();
  await db.insert('proDocs', doc);
  res.status(201).json({ doc: withTotals(doc) });
});
router.patch('/business/docs/:id', pro, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  const doc = await db.find('proDocs', d => d.id === req.params.id && d.providerId === me.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const { out, error } = readDoc(req.body || {}, doc, businessOf(me));
  if (error) return res.status(400).json({ error });
  // v106: what a customer accepted on Trothen can't be changed afterwards.
  if (doc.customerId && doc.status === 'accepted' && (out.items || out.discount !== undefined || out.taxRatePct !== undefined) && JSON.stringify(totalsFor(out.items || doc.items, out.taxRatePct !== undefined ? out.taxRatePct : doc.taxRatePct, out.discount !== undefined ? out.discount : doc.discount)) !== JSON.stringify(totalsFor(doc.items, doc.taxRatePct, doc.discount))) {
    return res.status(400).json({ error: 'Your customer already accepted this. Write a new one instead of changing the price.' });
  }
  if (doc.customerId && out.customerName !== undefined && out.customerName !== doc.customerName) delete out.customerName; // it was sent to a Trothen customer; the name stays theirs
  if (doc.type === 'invoice' && out.status === 'paid' && !out.paidOn && !doc.paidOn) out.paidOn = today();
  if (doc.type === 'invoice' && out.status && out.status !== 'paid') out.paidOn = null;
  res.json({ doc: withTotals(await db.update('proDocs', doc.id, out)) });
});
router.delete('/business/docs/:id', pro, async (req, res) => {
  const doc = await db.find('proDocs', d => d.id === req.params.id && d.providerId === req.user.sub);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  await db.remove('proDocs', doc.id);
  res.json({ ok: true });
});
// POST /api/business/docs/:id/to-invoice — a quote or estimate becomes an invoice
router.post('/business/docs/:id/to-invoice', pro, async (req, res) => {
  const src = await db.find('proDocs', d => d.id === req.params.id && d.providerId === req.user.sub);
  if (!src) return res.status(404).json({ error: 'Document not found' });
  if (src.type === 'invoice') return res.status(400).json({ error: 'This is already an invoice' });
  const inv = {
    id: `doc_${nanoid(10)}`, providerId: src.providerId, type: 'invoice', number: await nextDocNumber(src.providerId, 'invoice'),
    customerName: src.customerName, customerContact: src.customerContact || '', title: src.title || '', notes: src.notes || '',
    items: src.items, taxRatePct: src.taxRatePct, discount: src.discount, date: today(), dueOrValidUntil: null, status: 'draft', paidOn: null,
    fromDocNumber: src.number, createdAt: new Date().toISOString(),
  };
  await db.insert('proDocs', inv);
  await db.update('proDocs', src.id, { status: 'accepted', invoiceNumber: inv.number });
  res.status(201).json({ doc: withTotals(inv) });
});

// ── v106: sending a quote, estimate or invoice to a customer on Trothen ──
// A pro can send a paper to a customer they already have a booking or a
// message thread with. The customer is told, sees it under "Quotes &
// Invoices", can download the PDF, and can accept or decline a quote or
// estimate. Accepting is a yes in writing; money is only held once the
// customer books the pro.
async function customersOf(providerId) {
  const ids = new Set();
  for (const c of await db.filter('contracts', c => c.providerId === providerId)) ids.add(c.customerId);
  for (const m of await db.filter('messages', m => m.fromId === providerId || m.toId === providerId)) ids.add(m.fromId === providerId ? m.toId : m.fromId);
  for (const m of await db.filter('matches', m => m.providerId === providerId && ['interested', 'accepted'].includes(m.status))) ids.add(m.customerId);
  ids.delete(providerId);
  return (await db.filter('users', u => ids.has(u.id) && u.role === 'customer' && u.active !== false)).map(u => ({ id: u.id, name: u.name, city: u.city || '' })).sort((a, b) => a.name.localeCompare(b.name));
}
router.get('/business/customers', pro, async (req, res) => {
  res.json({ customers: await customersOf(req.user.sub) });
});
router.post('/business/docs/:id/send', pro, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  const doc = await db.find('proDocs', d => d.id === req.params.id && d.providerId === me.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (['void', 'declined'].includes(doc.status)) return res.status(400).json({ error: `This ${DOC_TYPES[doc.type].label.toLowerCase()} is ${doc.status}, so it can't be sent.` });
  const customer = (await customersOf(me.id)).find(c => c.id === (req.body || {}).customerId);
  if (!customer) return res.status(400).json({ error: 'You can send this to a customer you already have a booking or a conversation with on Trothen.' });
  const patch = { customerId: customer.id, customerName: customer.name, sentAt: new Date().toISOString() };
  if (doc.status === 'draft') patch.status = 'sent';
  const updated = await db.update('proDocs', doc.id, patch);
  const t = totalsFor(updated.items, updated.taxRatePct, updated.discount);
  const { notify } = require('../notify');
  await notify(customer.id, '🧾', `${me.businessName || me.name} sent you ${doc.type === 'invoice' ? 'an invoice' : doc.type === 'estimate' ? 'an estimate' : 'a quote'} (${doc.number}) for $${t.total.toFixed(2)}${doc.title ? ': ' + String(doc.title).slice(0, 60) : ''}.`, 'bookingUpdates', { section: 'quotes' });
  res.json({ doc: withTotals(updated) });
});
// The customer's side.
function docForCustomer(d, proUser) {
  const t = totalsFor(d.items, d.taxRatePct, d.discount);
  return { id: d.id, type: d.type, typeLabel: DOC_TYPES[d.type].label, number: d.number, title: d.title || '', date: d.date, dueOrValidUntil: d.dueOrValidUntil || null, status: d.status, sentAt: d.sentAt, items: d.items, notes: d.notes || '', taxRatePct: d.taxRatePct, ...t, providerId: d.providerId, providerName: proUser ? (proUser.businessName || proUser.name) : 'Pro', answeredAt: d.answeredAt || null };
}
router.get('/quotes/mine', requireAuth, requireRole('customer'), async (req, res) => {
  const docs = (await db.filter('proDocs', d => d.customerId === req.user.sub && d.sentAt && d.status !== 'draft')).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  const pros = new Map((await db.filter('users', u => docs.some(d => d.providerId === u.id))).map(u => [u.id, u]));
  res.json({ docs: docs.map(d => docForCustomer(d, pros.get(d.providerId))) });
});
router.post('/quotes/:id/respond', requireAuth, requireRole('customer'), async (req, res) => {
  const doc = await db.find('proDocs', d => d.id === req.params.id && d.customerId === req.user.sub && d.sentAt);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.type === 'invoice') return res.status(400).json({ error: 'An invoice is a bill, so there is nothing to accept or decline. Talk to the pro if something is wrong with it.' });
  if (doc.status !== 'sent') return res.status(400).json({ error: `This ${DOC_TYPES[doc.type].label.toLowerCase()} is already ${doc.status}.` });
  const { decision } = req.body || {};
  if (!['accept', 'decline'].includes(decision)) return res.status(400).json({ error: 'Choose accept or decline' });
  if (decision === 'accept' && doc.dueOrValidUntil && doc.dueOrValidUntil < today()) return res.status(400).json({ error: `This ${DOC_TYPES[doc.type].label.toLowerCase()} was valid until ${doc.dueOrValidUntil}. Ask the pro for a new one.` });
  const updated = await db.update('proDocs', doc.id, { status: decision === 'accept' ? 'accepted' : 'declined', answeredAt: new Date().toISOString() });
  const me = await db.find('users', u => u.id === req.user.sub);
  const { notify } = require('../notify');
  await notify(doc.providerId, decision === 'accept' ? '✅' : '❌', `${me ? me.name : 'Your customer'} ${decision === 'accept' ? 'accepted' : 'declined'} your ${DOC_TYPES[doc.type].label.toLowerCase()} ${doc.number}.`, null, { section: 'business' });
  const proUser = await db.find('users', u => u.id === doc.providerId);
  res.json({ doc: docForCustomer(updated, proUser) });
});
router.get('/quotes/:id/pdf', requireAuth, requireRole('customer'), async (req, res) => {
  const doc = await db.find('proDocs', d => d.id === req.params.id && d.customerId === req.user.sub && d.sentAt && d.status !== 'draft');
  if (!doc) return res.status(404).json({ error: 'Not found' });
  const me = await db.find('users', u => u.id === doc.providerId);
  if (!me) return res.status(404).json({ error: 'This pro\'s account is no longer available' });
  docPdf(res, me, doc);
});

function sendDocPdf(res, { me, business, typeLabel, number, date, extraDateLabel, extraDate, customerName, customerContact, title, items, totals, taxRatePct, notes, statusLine, closing }) {
  const { createReportDoc } = require('../pdf-report-builder');
  const from = me.businessName || me.name;
  const r = createReportDoc({
    res, filename: `${typeLabel}-${number}.pdf`.replace(/[^\w.-]/g, '-'),
    title: typeLabel, subtitle: `From ${from}`.slice(0, 90), docId: number,
    verificationSeed: `${typeLabel}|${me.id}|${number}|${totals.total}`,
  });
  r.sectionHeader('From');
  r.row(from, [me.city && `${me.city}${me.country ? ', ' + me.country : ''}`, business.contactLine || me.phone || me.email, business.taxId && `${business.taxLabel} number: ${business.taxId}`].filter(Boolean).join('  ·  '));
  r.sectionHeader('For');
  r.row(customerName, customerContact || '');
  r.twoColumnRow('Date', date || '', extraDateLabel || 'Status', extraDateLabel ? (extraDate || 'Not set') : (statusLine || ''));
  if (extraDateLabel && statusLine) r.row('Status', statusLine);
  if (title) r.row('For the work', title);
  r.sectionHeader('Lines');
  r.table(
    [{ label: 'Description', width: 250 }, { label: 'Qty', width: 60, align: 'right' }, { label: 'Each', width: 85, align: 'right' }, { label: 'Total', width: 85, align: 'right' }],
    items.map(i => [String(i.description).slice(0, 48), String(i.qty), `$${Number(i.unitPrice).toFixed(2)}`, `$${Number(i.lineTotal).toFixed(2)}`])
  );
  r.y += 14;
  r.twoColumnRow('Subtotal', `$${totals.subtotal.toFixed(2)}`, totals.discount > 0 ? 'Discount' : ' ', totals.discount > 0 ? `- $${totals.discount.toFixed(2)}` : ' ');
  r.twoColumnRow(`${business.taxLabel} (${taxRatePct}%)`, totals.taxNote || `$${totals.tax.toFixed(2)}`, 'Total', `$${totals.total.toFixed(2)}`);
  if (notes) { r.sectionHeader('Notes'); r.paragraph(notes, { size: 10, color: '#12161F' }); }
  r.finish({ closingNote: [business.footerNote, closing].filter(Boolean).join('  ') });
}

function docPdf(res, me, doc) {
  const t = totalsFor(doc.items, doc.taxRatePct, doc.discount);
  const isInvoice = doc.type === 'invoice';
  sendDocPdf(res, {
    me, business: businessOf(me), typeLabel: DOC_TYPES[doc.type].label, number: doc.number, date: doc.date,
    extraDateLabel: isInvoice ? 'Pay by' : 'Valid until', extraDate: doc.dueOrValidUntil,
    customerName: doc.customerName, customerContact: doc.customerContact, title: doc.title, items: doc.items, totals: t, taxRatePct: doc.taxRatePct, notes: doc.notes,
    statusLine: isInvoice ? (doc.status === 'paid' ? `Paid${doc.paidOn ? ' on ' + doc.paidOn : ''}` : doc.status === 'void' ? 'Void' : 'Not yet paid') : (doc.status.charAt(0).toUpperCase() + doc.status.slice(1)),
    closing: doc.type === 'estimate'
      ? 'This is an estimate. The final price may change once the work is seen. It was written by the pro named above using Trothen\'s business tools; Trothen is not a party to it.'
      : `This ${DOC_TYPES[doc.type].label.toLowerCase()} was written by the pro named above using Trothen's business tools. Trothen is not a party to it and holds no money for it unless the work is booked through Trothen.`,
  });
}
router.get('/business/docs/:id/pdf', pro, async (req, res) => {
  const me = await db.find('users', u => u.id === req.user.sub);
  const doc = await db.find('proDocs', d => d.id === req.params.id && d.providerId === me.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  docPdf(res, me, doc);
});

// ── Invoices for Trothen bookings (made automatically) ─────────────────
// Every completed booking has an invoice, built from the booking itself.
function bookingInvoice(contract, escrow, customer, business) {
  const goodsTotal = Math.min(contract.storeGoodsTotal || 0, escrow ? escrow.amount : contract.amount);
  const paid = escrow ? escrow.amount : contract.amount;
  const items = [];
  const labour = money(paid - goodsTotal);
  if (labour > 0) items.push({ description: String(contract.service).slice(0, 120), qty: 1, unitPrice: labour, lineTotal: labour, kind: 'labour' });
  if (goodsTotal > 0 && goodsTotal === (contract.storeGoodsTotal || 0)) for (const i of contract.storeItems || []) items.push({ description: String(i.name).slice(0, 120), qty: i.qty, unitPrice: i.unitPrice, lineTotal: i.lineTotal, kind: 'goods' });
  else if (goodsTotal > 0) items.push({ description: 'Goods from the store', qty: 1, unitPrice: goodsTotal, lineTotal: goodsTotal, kind: 'goods' });
  if ((contract.tipAmount || 0) > 0) items.push({ description: 'Tip', qty: 1, unitPrice: contract.tipAmount, lineTotal: contract.tipAmount, kind: 'tip' });
  const total = money(items.reduce((s, i) => s + i.lineTotal, 0));
  const taxable = money(total - (contract.tipAmount || 0));
  const rate = business.trothenPricesIncludeTax ? business.taxRatePct : 0;
  const tax = rate > 0 ? money(taxable - taxable / (1 + rate / 100)) : 0;
  return {
    number: `TR-${contract.bookingNumber || contract.id}`,
    contractId: contract.id,
    date: (contract.completedAt || contract.updatedAt || contract.createdAt || '').slice(0, 10),
    customerName: customer ? customer.name : 'Customer',
    items, taxRatePct: rate,
    subtotal: total, discount: 0, tax, total,
    taxIncluded: rate > 0,
    labourAmount: labour, goodsAmount: goodsTotal, tipAmount: contract.tipAmount || 0,
  };
}
async function bookingInvoicesFor(providerId) {
  const me = await db.find('users', u => u.id === providerId);
  const business = businessOf(me);
  const contracts = await db.filter('contracts', c => c.providerId === providerId);
  const ids = new Set(contracts.map(c => c.id));
  const escrows = new Map((await db.filter('escrowTransactions', e => ids.has(e.contractId))).map(e => [e.contractId, e]));
  const customers = new Map((await db.filter('users', u => contracts.some(c => c.customerId === u.id))).map(u => [u.id, u]));
  const out = [];
  for (const c of contracts) {
    const e = escrows.get(c.id);
    // Money counts as earned once it is released to the pro: a completed
    // job, or a dispute decided in the pro's favour (in full or in part).
    if (!e || e.status !== 'released') continue;
    out.push(bookingInvoice(c, e, customers.get(c.customerId), business));
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
router.get('/business/booking-invoices', pro, async (req, res) => {
  res.json({ invoices: await bookingInvoicesFor(req.user.sub) });
});
// Either the pro or the customer on the booking can download its invoice.
router.get('/business/booking-invoices/:contractId/pdf', requireAuth, async (req, res) => {
  const contract = await db.find('contracts', c => c.id === req.params.contractId && (c.providerId === req.user.sub || c.customerId === req.user.sub));
  if (!contract) return res.status(404).json({ error: 'Booking not found' });
  const escrow = await db.find('escrowTransactions', e => e.contractId === contract.id);
  if (!escrow || escrow.status !== 'released') return res.status(400).json({ error: 'The invoice is ready once the job is marked complete.' });
  const me = await db.find('users', u => u.id === contract.providerId);
  const customer = await db.find('users', u => u.id === contract.customerId);
  const business = businessOf(me);
  const inv = bookingInvoice(contract, escrow, customer, business);
  sendDocPdf(res, {
    me, business, typeLabel: 'Invoice', number: inv.number, date: inv.date,
    customerName: inv.customerName, customerContact: customer && customer.city ? `${customer.city}${customer.country ? ', ' + customer.country : ''}` : '',
    title: `Trothen booking #${contract.bookingNumber || contract.id}`, items: inv.items,
    totals: { subtotal: inv.subtotal, discount: 0, tax: inv.tax, total: inv.total, taxNote: inv.taxIncluded ? `$${inv.tax.toFixed(2)} (included in the prices)` : 'Not charged' },
    taxRatePct: inv.taxRatePct, notes: '',
    statusLine: 'Paid through Trothen',
    closing: 'Paid in full through Trothen. The customer also paid Trothen a separate service fee, which is not part of this invoice.',
  });
});

// ── Summary: dashboard and tax report ──────────────────────────────────
async function summaryFor(providerId, from, to) {
  const me = await db.find('users', u => u.id === providerId);
  const business = businessOf(me);
  const inRange = (day) => !!day && (!from || day >= from) && (!to || day <= to);
  const bookingInv = (await bookingInvoicesFor(providerId)).filter(i => inRange(i.date));
  const ownInv = (await db.filter('proDocs', d => d.providerId === providerId && d.type === 'invoice' && d.status === 'paid')).map(d => ({ ...d, ...totalsFor(d.items, d.taxRatePct, d.discount), day: d.paidOn || d.date })).filter(d => inRange(d.day));
  const expenses = (await db.filter('proExpenses', e => e.providerId === providerId)).filter(e => inRange(e.date));
  const payouts = (await db.filter('payouts', p => p.providerId === providerId)).filter(p => inRange(p.date));

  const trothenLabour = money(bookingInv.reduce((s, i) => s + i.labourAmount, 0));
  const trothenGoods = money(bookingInv.reduce((s, i) => s + i.goodsAmount, 0));
  const tips = money(bookingInv.reduce((s, i) => s + i.tipAmount, 0));
  const ownIncome = money(ownInv.reduce((s, d) => s + (d.total - d.tax), 0));
  const taxOnOwn = money(ownInv.reduce((s, d) => s + d.tax, 0));
  const taxInTrothen = money(bookingInv.reduce((s, i) => s + i.tax, 0));
  const expenseTotal = money(expenses.reduce((s, e) => s + e.amount, 0));
  const commission = money(payouts.reduce((s, p) => s + (p.commissionAmount || 0), 0));
  const planFees = money(payouts.reduce((s, p) => s + (p.planFeeAmount || 0), 0));
  const storeFees = money(payouts.reduce((s, p) => s + (p.storeFeeAmount || 0), 0)); // v106: when the pro pays the store purchase fee
  const income = money(trothenLabour + trothenGoods + tips + ownIncome - taxInTrothen);

  const byKind = {};
  for (const e of expenses) byKind[e.kind] = money((byKind[e.kind] || 0) + e.amount);

  const months = new Map();
  const bump = (day, key, amt) => { const m = String(day).slice(0, 7); if (!months.has(m)) months.set(m, { month: m, income: 0, expenses: 0 }); months.get(m)[key] = money(months.get(m)[key] + amt); };
  for (const i of bookingInv) bump(i.date, 'income', i.total - i.tax);
  for (const d of ownInv) bump(d.day, 'income', d.total - d.tax);
  for (const e of expenses) bump(e.date, 'expenses', e.amount);
  for (const p of payouts) bump(p.date, 'expenses', (p.commissionAmount || 0) + (p.planFeeAmount || 0) + (p.storeFeeAmount || 0));

  const goods = new Map();
  for (const i of bookingInv) for (const line of i.items) if (line.kind === 'goods') { const g = goods.get(line.description) || { name: line.description, qty: 0, amount: 0 }; g.qty += line.qty; g.amount = money(g.amount + line.lineTotal); goods.set(line.description, g); }

  return {
    from: from || null, to: to || null, business,
    income: { trothenJobs: trothenLabour, trothenGoods, tips, ownInvoices: ownIncome, total: income },
    tax: { label: business.taxLabel, ratePct: business.taxRatePct, onOwnInvoices: taxOnOwn, insideTrothenPrices: taxInTrothen, total: money(taxOnOwn + taxInTrothen) },
    costs: { expenses: expenseTotal, byKind, trothenCommission: commission, trothenPlanFees: planFees, trothenStoreFees: storeFees, total: money(expenseTotal + commission + planFees + storeFees) },
    profit: money(income - expenseTotal - commission - planFees - storeFees),
    counts: { trothenJobs: bookingInv.length, ownInvoicesPaid: ownInv.length, expenses: expenses.length },
    averageJob: bookingInv.length ? money((trothenLabour + trothenGoods) / bookingInv.length) : 0,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    topGoods: [...goods.values()].sort((a, b) => b.amount - a.amount).slice(0, 8),
    lines: { bookingInv, ownInv: ownInv.map(d => ({ number: d.number, day: d.day, customerName: d.customerName, net: money(d.total - d.tax), tax: d.tax, total: d.total })), expenses },
  };
}
function readRange(q) {
  const from = isDay(q.from) ? q.from : null, to = isDay(q.to) ? q.to : null;
  if (from && to && from > to) return { error: 'The start day is after the end day' };
  return { from, to };
}
router.get('/business/summary', pro, async (req, res) => {
  const r = readRange(req.query);
  if (r.error) return res.status(400).json({ error: r.error });
  const s = await summaryFor(req.user.sub, r.from, r.to);
  const goods = await db.filter('storeGoods', g => g.providerId === req.user.sub);
  const lowStock = goods.filter(g => g.stock !== null && g.stock !== undefined && g.stock <= (g.lowStockAt === null || g.lowStockAt === undefined ? 0 : g.lowStockAt)).map(g => ({ id: g.id, name: g.name, stock: g.stock }));
  const stockValue = money(goods.reduce((sum, g) => sum + ((g.stock || 0) * (g.costPrice || 0)), 0));
  const openQuotes = (await db.filter('proDocs', d => d.providerId === req.user.sub && d.type !== 'invoice' && d.status === 'sent')).length;
  const unpaidInvoices = (await db.filter('proDocs', d => d.providerId === req.user.sub && d.type === 'invoice' && d.status === 'sent')).map(d => totalsFor(d.items, d.taxRatePct, d.discount).total);
  const toolsDue = (await db.filter('proTools', t => t.providerId === req.user.sub && ((t.serviceDue && t.serviceDue <= today()) || ['needs_service', 'broken'].includes(t.condition)))).length;
  const { lines, ...rest } = s;
  res.json({ ...rest, lowStock, stockValue, openQuotes, unpaidInvoices: { count: unpaidInvoices.length, total: money(unpaidInvoices.reduce((a, b) => a + b, 0)) }, toolsDue });
});

const TAX_NOTE = 'This report adds up what is recorded on Trothen and what you entered yourself. It is not tax advice and it does not work out what you owe. Give it to your accountant or tax office, who can tell you what applies where you live.';
router.get('/business/tax-report.csv', pro, async (req, res) => {
  const r = readRange(req.query);
  if (r.error) return res.status(400).json({ error: r.error });
  const s = await summaryFor(req.user.sub, r.from, r.to);
  const rows = [['Section', 'Date', 'Reference', 'Who / what', 'Kind', 'Amount before tax', s.tax.label, 'Total']];
  for (const i of s.lines.bookingInv) rows.push(['Income: Trothen booking', i.date, i.number, i.customerName, i.goodsAmount > 0 ? (i.labourAmount > 0 ? 'Job and goods' : 'Goods') : 'Job', money(i.total - i.tax), i.tax, i.total]);
  for (const d of s.lines.ownInv) rows.push(['Income: own invoice', d.day, d.number, d.customerName, 'Invoice', d.net, d.tax, d.total]);
  for (const e of s.lines.expenses) rows.push(['Expense', e.date, '', e.vendor || e.note || '', e.kind, e.amount, '', e.amount]);
  rows.push([]);
  rows.push(['Totals', '', '', 'Income before tax', '', s.income.total, '', '']);
  rows.push(['Totals', '', '', `${s.tax.label} collected`, '', '', s.tax.total, '']);
  rows.push(['Totals', '', '', 'Expenses', '', s.costs.expenses, '', '']);
  rows.push(['Totals', '', '', 'Trothen commission', '', s.costs.trothenCommission, '', '']);
  rows.push(['Totals', '', '', 'Trothen plan fees', '', s.costs.trothenPlanFees, '', '']);
  rows.push(['Totals', '', '', 'Trothen store purchase fees', '', s.costs.trothenStoreFees, '', '']);
  rows.push(['Totals', '', '', 'Profit before tax', '', s.profit, '', '']);
  rows.push([]);
  rows.push([TAX_NOTE]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Trothen-tax-report-${s.from || 'start'}-to-${s.to || today()}.csv"`);
  res.send('﻿' + rows.map(r2 => r2.map(csvCell).join(',')).join('\r\n'));
});
router.get('/business/tax-report.pdf', pro, async (req, res) => {
  const r = readRange(req.query);
  if (r.error) return res.status(400).json({ error: r.error });
  const me = await db.find('users', u => u.id === req.user.sub);
  const s = await summaryFor(me.id, r.from, r.to);
  const { createReportDoc } = require('../pdf-report-builder');
  const range = `${s.from || 'the start'} to ${s.to || today()}`;
  const d = createReportDoc({ res, filename: `Trothen-tax-report-${s.from || 'start'}-to-${s.to || today()}.pdf`, title: 'Income, Expenses and Tax Report', subtitle: `${me.businessName || me.name}`.slice(0, 90), docId: range, verificationSeed: `tax|${me.id}|${range}|${s.profit}` });
  const $ = (n) => `$${Number(n).toFixed(2)}`;
  d.sectionHeader('Summary');
  d.twoColumnRow('Income before tax', $(s.income.total), `${s.tax.label} collected`, $(s.tax.total));
  d.twoColumnRow('Expenses you recorded', $(s.costs.expenses), 'Trothen commission and fees', $(s.costs.trothenCommission + s.costs.trothenPlanFees + s.costs.trothenStoreFees));
  d.row('Profit before tax', $(s.profit));
  d.sectionHeader('Where the income came from');
  d.twoColumnRow('Jobs through Trothen', $(s.income.trothenJobs), 'Goods sold through Trothen', $(s.income.trothenGoods));
  d.twoColumnRow('Tips', $(s.income.tips), 'Your own invoices marked paid', $(s.income.ownInvoices));
  if (s.business.taxId) d.row(`${s.tax.label} number`, s.business.taxId);
  d.sectionHeader('Expenses by kind');
  const kinds = Object.entries(s.costs.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length) d.table([{ label: 'Kind', width: 380 }, { label: 'Amount', width: 100, align: 'right' }], kinds.map(([k, v]) => [k, $(v)]));
  else d.row('No expenses recorded', 'Nothing was entered in the expense tracker for this period.');
  d.y += 12;
  d.sectionHeader('Income, line by line');
  const incomeRows = [
    ...s.lines.bookingInv.map(i => [i.date, i.number, String(i.customerName).slice(0, 26), $(i.total - i.tax), $(i.tax), $(i.total)]),
    ...s.lines.ownInv.map(x => [x.day, x.number, String(x.customerName).slice(0, 26), $(x.net), $(x.tax), $(x.total)]),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (incomeRows.length) d.table([{ label: 'Date', width: 70 }, { label: 'Reference', width: 90 }, { label: 'Customer', width: 140 }, { label: 'Before tax', width: 65, align: 'right' }, { label: s.tax.label, width: 50, align: 'right' }, { label: 'Total', width: 65, align: 'right' }], incomeRows);
  else d.row('No income recorded', 'No completed bookings or paid invoices in this period.');
  d.y += 12;
  if (s.lines.expenses.length) {
    d.sectionHeader('Expenses, line by line');
    d.table([{ label: 'Date', width: 70 }, { label: 'Kind', width: 140 }, { label: 'Paid to / note', width: 200 }, { label: 'Amount', width: 70, align: 'right' }], s.lines.expenses.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map(e => [e.date, e.kind, String(e.vendor || e.note || '').slice(0, 38), $(e.amount)]));
  }
  d.y += 12;
  d.finish({ closingNote: TAX_NOTE });
});

module.exports = router;
