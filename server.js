/**
 * ASO Staff Overtime Management System — SQLite Backend
 * Node.js + Express + sql.js (no compilation required)
 *
 * Serves the app at http://localhost:8420
 */

const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const bcrypt       = require('bcryptjs');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');

// ── Crash resilience ────────────────────────────────────────
// Without these, one uncaught error anywhere (a bad dependency call, a typo in
// a rarely-hit code path, a promise rejection nobody awaited) kills the whole
// process for every user until the host notices and restarts it. Instead:
// log clearly, save whatever's in memory to disk if possible, then exit —
// letting the platform's normal restart bring the app back up cleanly rather
// than continuing to run in a potentially corrupted state.
function crashSafeExit(kind, err) {
  console.error(`[ASO] ${kind}:`, err);
  try { if (typeof persistDB === 'function' && db) persistDB(); }
  catch (saveErr) { console.error('[ASO] Could not save DB during crash handling:', saveErr); }
  process.exit(1);
}
process.on('uncaughtException', (err) => crashSafeExit('Uncaught exception', err));
process.on('unhandledRejection', (err) => crashSafeExit('Unhandled promise rejection', err));

// ── Configuration ──────────────────────────────────────────
const PORT      = process.env.PORT || 8420;
const HOST      = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const IS_PROD   = !!process.env.PORT; // Render (and most hosts) set PORT for us
// On Render, set DB_DIR to a mounted persistent disk path (e.g. /var/data)
// via an environment variable, otherwise falls back to local behavior.
const DB_DIR    = process.env.DB_DIR || path.join(os.homedir(), 'ASO_OT_Data');
const DB_PATH   = path.join(DB_DIR, 'aso_ot.db');
const BACKUP_DIR = path.join(DB_DIR, 'backups');
const BACKUP_RETENTION = 14; // keep the last 14 automatic backups
const HTML_FILE = path.join(__dirname, 'ASO_OT_SYSTEM_SQL.html');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_COOKIE = 'aso_session';

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ── Load sql.js ────────────────────────────────────────────
const initSqlJs = require('sql.js');

let db; // will be set after async init

// ── Password hashing (bcrypt, with transparent migration from the old
//    client-side SHA-256+static-salt scheme used before this update) ──
const LEGACY_SALT = 'ASO_OT_SECURE_SALT_v7';
function legacySha256(pw) {
  return crypto.createHash('sha256').update(pw + LEGACY_SALT).digest('hex');
}
function isBcryptHash(s)   { return typeof s === 'string' && /^\$2[aby]\$\d{2}\$/.test(s); }
function isLegacySha256(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s); }
async function verifyPassword(storedHash, plaintext) {
  if (isBcryptHash(storedHash))   return bcrypt.compare(plaintext, storedHash);
  if (isLegacySha256(storedHash)) return legacySha256(plaintext) === storedHash;
  return plaintext === storedHash; // fresh/never-migrated plaintext seed value
}

// ── Default seed data ──────────────────────────────────────
const DEFAULT_SEED = {
  PAY_CONFIG: { anchorDate: '2026-05-09', periodDays: 14, otThreshold: 80,
    defaultDeductions: [
      { id: 'ded_federal', label: 'Federal Withholding', type: 'percent', value: 0 },
      { id: 'ded_fica', label: 'FICA', type: 'percent', value: 7.65 },
      { id: 'ded_state', label: 'State Withholding', type: 'percent', value: 3.07 },
    ] },
  USERS: [{ id: 'U001', username: 'admin', password: 'admin123', name: 'Admin', role: 'admin' }],
  LOCATIONS: [
    { id:'L01', name:'Serah House',     rate:18.5,  mult:1.5, notes:'Standard',                rateHistory:[{rate:18.5,  mult:1.5,effectiveFrom:'2000-01-01'}] },
    { id:'L02', name:'Benjamin House',  rate:13,    mult:1.5, notes:'Standard',                rateHistory:[{rate:13,    mult:1.5,effectiveFrom:'2000-01-01'}] },
    { id:'L03', name:'Atima House',     rate:11.75, mult:1.5, notes:'Standard',                rateHistory:[{rate:11.75, mult:1.5,effectiveFrom:'2000-01-01'}] },
    { id:'L04', name:'Gabriella House', rate:14,    mult:1.5, notes:'Standard',                rateHistory:[{rate:14,    mult:1.5,effectiveFrom:'2000-01-01'}] },
    { id:'L05', name:'Usene House',     rate:12,    mult:1.5, notes:'Standard',                rateHistory:[{rate:12,    mult:1.5,effectiveFrom:'2000-01-01'}] },
    { id:'L06', name:'William House',   rate:13.5,  mult:1.5, notes:'Standard',                rateHistory:[{rate:13.5, mult:1.5,effectiveFrom:'2000-01-01'}] },
    { id:'L07', name:'Office',          rate:15,    mult:1.5, notes:'Administrative / Office', rateHistory:[{rate:15,   mult:1.5,effectiveFrom:'2000-01-01'}] },
    { id:'L08', name:'Lead Staff',      rate:20,    mult:1.5, notes:'Lead Staff',              rateHistory:[{rate:20,   mult:1.5,effectiveFrom:'2000-01-01'}] },
    { id:'L09', name:'Daniel House',    rate:12.5,  mult:1.5, notes:'Standard',                rateHistory:[{rate:12.5, mult:1.5,effectiveFrom:'2000-01-01'}] },
  ],
  STAFF: [
    {id:'S001',first:'Alfred',    last:'Erzondah', title:'DSP',     type:'Full-Time',loc:'Usene House',     rate:12,    start:'2024-06-18',status:'Active'},
    {id:'S002',first:'Ashley',    last:'Parker',   title:'DSP',     type:'Full-Time',loc:'Atima House',     rate:11.75, start:'2026-01-25',status:'Active'},
    {id:'S003',first:'Daniel',    last:'Juan',     title:'DSP',     type:'Full-Time',loc:'Gabriella House', rate:14,    start:'2025-07-20',status:'Active'},
    {id:'S004',first:'Ekram',     last:'Boukhiar', title:'DSP',     type:'Full-Time',loc:'Gabriella House', rate:14,    start:'2025-07-09',status:'Active'},
    {id:'S005',first:'Ezekiel',   last:'Wilson',   title:'DSP',     type:'Full-Time',loc:'Gabriella House', rate:14,    start:'2024-12-31',status:'Active'},
    {id:'S006',first:'Gyude',     last:'Morgan',   title:'DSP',     type:'Full-Time',loc:'William House',   rate:13.5,  start:'2024-06-14',status:'Active'},
    {id:'S007',first:'Kathleen',  last:'Sims',     title:'DSP',     type:'Full-Time',loc:'Lead Staff',      rate:20,    start:'2025-10-26',status:'Active'},
    {id:'S008',first:'Marvin',    last:'Davis',    title:'DSP',     type:'Full-Time',loc:'Gabriella House', rate:14,    start:'2026-01-26',status:'Active'},
    {id:'S009',first:'Melvin',    last:'Morris',   title:'DSP',     type:'Full-Time',loc:'Usene House',     rate:12,    start:'2025-03-28',status:'Active'},
    {id:'S010',first:'Prince',    last:'Dolo',     title:'DSP',     type:'Full-Time',loc:'William House',   rate:13.5,  start:'2025-04-05',status:'Inactive'},
    {id:'S011',first:'Samuel',    last:'Baz',      title:'DSP',     type:'Full-Time',loc:'Usene House',     rate:12,    start:'2024-11-25',status:'Active'},
    {id:'S012',first:'Sawala',    last:'Koiyan',   title:'DSP',     type:'Full-Time',loc:'Atima House',     rate:11.75, start:'2025-09-14',status:'Active'},
    {id:'S013',first:'Sharon',    last:'Potoway',  title:'DSP',     type:'Full-Time',loc:'William House',   rate:13.5,  start:'2025-05-15',status:'Active'},
    {id:'S014',first:'Wadiyah',   last:'Campbell', title:'DSP',     type:'Full-Time',loc:'Lead Staff',      rate:20,    start:'2025-07-01',status:'Active'},
    {id:'S015',first:'Tracey',    last:'Chambers', title:'DSP',     type:'Full-Time',loc:'Benjamin House',  rate:13,    start:'2025-09-01',status:'Active'},
    {id:'S016',first:'David',     last:'Wuokolo',  title:'DSP',     type:'Full-Time',loc:'Usene House',     rate:12,    start:'2024-09-22',status:'Active'},
    {id:'S017',first:'Ribekia',   last:'Jenkins',  title:'Manager', type:'Full-Time',loc:'Office',          rate:15,    start:'2025-10-18',status:'Active'},
    {id:'S018',first:'Yemah',     last:'Price',    title:'DSP',     type:'Full-Time',loc:'Atima House',     rate:11.75, start:'2026-01-24',status:'Active'},
    {id:'S019',first:'Tohn',      last:'Zuo',      title:'DSP',     type:'Full-Time',loc:'Atima House',     rate:11.75, start:'2025-10-03',status:'Active'},
    {id:'S020',first:'Simeon',    last:'Barwu',    title:'DSP',     type:'Full-Time',loc:'Atima House',     rate:11.75, start:'2025-03-10',status:'Active'},
    {id:'S021',first:'Sellorm',   last:'Foley',    title:'DSP',     type:'Full-Time',loc:'Atima House',     rate:11.75, start:'2026-02-01',status:'Active'},
    {id:'S022',first:'Romeo',     last:'Kollie',   title:'DSP',     type:'Full-Time',loc:'Atima House',     rate:11.75, start:'2026-01-27',status:'Active'},
    {id:'S023',first:'Hussanatu', last:'Kamara',   title:'DSP',     type:'Full-Time',loc:'Benjamin House',  rate:13,    start:'2026-01-28',status:'Active'},
    {id:'S024',first:'Gilbert',   last:'Harris',   title:'DSP',     type:'Full-Time',loc:'Atima House',     rate:11.75, start:'2026-01-28',status:'Active'},
    {id:'S025',first:'Vamuyah',   last:'Sherif',   title:'DSP',     type:'Full-Time',loc:'Gabriella House', rate:14,    start:'2025-03-06',status:'Active'},
  ],
  SHIFTS: [], PENDING_APPROVALS: [], APPROVED_EXCEPTIONS: [],
  DATE_CORRECTION_LOG: [], DELETION_LOG: [], AUDIT_LOG: [], PAYROLL_RECORDS: []
};

// ── DB helpers ─────────────────────────────────────────────
function run(sql, params = []) {
  db.run(sql, params);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] || null;
}

function persistDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Writes directly to the audit_log table — used for actions that happen through
// dedicated endpoints (like leave requests) rather than the generic bulk-save
// path, so they're never silently missing from the tamper-resistant audit trail.
// Matches the exact shape the client's own auditLog() function produces
// (type/detail/meta/by/byRole/at/ts) so entries render identically either way.
function writeAuditLog(type, detail, user, meta) {
  const id = 'AL' + Date.now() + Math.random().toString(36).slice(2,8);
  const ts = Date.now();
  const at = new Date().toLocaleString();
  const by = (user && user.name) || 'System';
  const byRole = (user && user.role) || 'system';
  run(`INSERT INTO audit_log (id,type,detail,meta,by,by_role,at,ts,action,user_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, type, detail || '', meta ? JSON.stringify(meta) : '', by, byRole, at, ts,
       type, (user && user.id) || '', new Date(ts).toISOString()]);
}

// ── Backups ────────────────────────────────────────────────
// Snapshots the current DB file into BACKUP_DIR with a timestamped name, then
// prunes older automatic backups beyond BACKUP_RETENTION. Manual backups
// (triggered by an admin) are marked in the filename and are never pruned
// automatically — only automatic ones are rotated.
function createBackup(kind) {
  persistDB(); // make sure the on-disk file reflects the latest in-memory state first
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `aso_ot_${kind || 'auto'}_${ts}.db`;
  const dest = path.join(BACKUP_DIR, filename);
  fs.copyFileSync(DB_PATH, dest);
  if (!kind || kind === 'auto') pruneOldBackups();
  return filename;
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('aso_ot_auto_') && f.endsWith('.db'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  files.slice(BACKUP_RETENTION).forEach(f => {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) { /* ignore */ }
  });
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, sizeKB: Math.round(stat.size / 1024), createdAt: stat.mtime.toISOString(),
               manual: f.startsWith('aso_ot_manual_') };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Schema ─────────────────────────────────────────────────
function createSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS pay_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    anchor_date TEXT NOT NULL,
    period_days INTEGER NOT NULL DEFAULT 14,
    ot_threshold INTEGER NOT NULL DEFAULT 80,
    default_deductions TEXT DEFAULT '[]'
  )`);
  // Safe migration for databases created before default_deductions existed
  try { db.run(`ALTER TABLE pay_config ADD COLUMN default_deductions TEXT DEFAULT '[]'`); } catch (e) { /* already exists */ }
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer',
    staff_id TEXT DEFAULT NULL
  )`);
  try { db.run(`ALTER TABLE users ADD COLUMN staff_id TEXT DEFAULT NULL`); } catch (e) { /* already exists */ }
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    rate REAL NOT NULL DEFAULT 0, mult REAL NOT NULL DEFAULT 1.5,
    notes TEXT DEFAULT '', rate_history TEXT DEFAULT '[]'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY, first TEXT NOT NULL, last TEXT NOT NULL,
    title TEXT DEFAULT 'DSP', type TEXT DEFAULT 'Full-Time',
    loc TEXT DEFAULT '', rate REAL NOT NULL DEFAULT 0,
    start TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active',
    pto_balance REAL DEFAULT 0
  )`);
  try { db.run(`ALTER TABLE staff ADD COLUMN pto_balance REAL DEFAULT 0`); } catch (e) { /* already exists */ }
  db.run(`CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, date TEXT NOT NULL,
    time_in TEXT NOT NULL, time_out TEXT NOT NULL, loc TEXT DEFAULT '',
    hours REAL DEFAULT 0, reg_hours REAL DEFAULT 0, ot_hours REAL DEFAULT 0,
    approved INTEGER DEFAULT 0, period_start TEXT DEFAULT '',
    period_end TEXT DEFAULT '', extra_data TEXT DEFAULT '{}'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS pending_approvals (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS approved_exceptions (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS date_correction_log (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS deletion_log (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS payroll_records (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, type TEXT NOT NULL,
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, hours REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', notes TEXT DEFAULT '',
    requested_by TEXT DEFAULT '', requested_at TEXT NOT NULL,
    reviewed_by TEXT DEFAULT '', reviewed_at TEXT DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT DEFAULT '',
    user_id TEXT DEFAULT '', created_at TEXT NOT NULL,
    type TEXT DEFAULT '', meta TEXT DEFAULT '', by TEXT DEFAULT '',
    by_role TEXT DEFAULT '', at TEXT DEFAULT '', ts INTEGER DEFAULT 0
  )`);
  // Migration: the audit log was originally built around action/user_id/created_at
  // columns, but the client (and the Audit Trail page that renders it) has always
  // used a different shape — type/by/byRole/at/ts. That mismatch meant every
  // audit entry came back malformed after a page reload. These columns fix it.
  ['type','meta','by','by_role','at'].forEach(col => {
    try { db.run(`ALTER TABLE audit_log ADD COLUMN ${col} TEXT DEFAULT ''`); } catch (e) { /* already exists */ }
  });
  try { db.run(`ALTER TABLE audit_log ADD COLUMN ts INTEGER DEFAULT 0`); } catch (e) { /* already exists */ }
}

function loadDB() {
  const pcRow = get('SELECT * FROM pay_config WHERE id=1');
  const PAY_CONFIG = pcRow
    ? { anchorDate: pcRow.anchor_date, periodDays: pcRow.period_days, otThreshold: pcRow.ot_threshold,
        defaultDeductions: JSON.parse(pcRow.default_deductions || '[]') }
    : DEFAULT_SEED.PAY_CONFIG;

  // Password hashes never leave the server — the client has no legitimate use for them.
  const USERS     = all('SELECT id,username,name,role,staff_id FROM users').map(r => ({
    id: r.id, username: r.username, name: r.name, role: r.role, staffId: r.staff_id || null
  }));
  const LOCATIONS = all('SELECT * FROM locations').map(r => ({
    id: r.id, name: r.name, rate: r.rate, mult: r.mult, notes: r.notes,
    rateHistory: JSON.parse(r.rate_history || '[]')
  }));
  const STAFF = all('SELECT * FROM staff').map(r => ({
    id: r.id, first: r.first, last: r.last, title: r.title,
    type: r.type, loc: r.loc, rate: r.rate, start: r.start, status: r.status,
    ptoBalance: r.pto_balance || 0
  }));
  const SHIFTS = all('SELECT * FROM shifts').map(r => {
    const extra = JSON.parse(r.extra_data || '{}');
    return { id: r.id, staff: r.staff_id, date: r.date, timeIn: r.time_in, timeOut: r.time_out,
             loc: r.loc, hours: r.hours, regHours: r.reg_hours, otHours: r.ot_hours,
             approved: !!r.approved, periodStart: r.period_start, periodEnd: r.period_end, ...extra };
  });
  const PENDING_APPROVALS  = all('SELECT data FROM pending_approvals').map(r => JSON.parse(r.data));
  const APPROVED_EXCEPTIONS = all('SELECT data FROM approved_exceptions').map(r => JSON.parse(r.data));
  const DATE_CORRECTION_LOG = all('SELECT data FROM date_correction_log').map(r => JSON.parse(r.data));
  const DELETION_LOG        = all('SELECT data FROM deletion_log').map(r => JSON.parse(r.data));
  const PAYROLL_RECORDS     = all('SELECT data FROM payroll_records').map(r => JSON.parse(r.data));
  const AUDIT_LOG = all('SELECT id,type,detail,meta,by,by_role,at,ts FROM audit_log ORDER BY ts DESC')
    .map(r => ({ id: r.id, type: r.type, detail: r.detail, meta: r.meta ? JSON.parse(r.meta) : null,
                 by: r.by, byRole: r.by_role, at: r.at, ts: r.ts }));
  const LEAVE_REQUESTS = all('SELECT * FROM leave_requests').map(r => ({
    id: r.id, staffId: r.staff_id, type: r.type, startDate: r.start_date, endDate: r.end_date,
    hours: r.hours, status: r.status, notes: r.notes, requestedBy: r.requested_by,
    requestedAt: r.requested_at, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at
  }));

  return { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
           PENDING_APPROVALS, APPROVED_EXCEPTIONS,
           DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG, PAYROLL_RECORDS, LEAVE_REQUESTS };
}

function saveDB(data) {
  const { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
          PENDING_APPROVALS, APPROVED_EXCEPTIONS,
          DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG, PAYROLL_RECORDS, LEAVE_REQUESTS } = data;

  // PAY_CONFIG
  run(`INSERT INTO pay_config (id,anchor_date,period_days,ot_threshold,default_deductions) VALUES (1,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET anchor_date=excluded.anchor_date,
       period_days=excluded.period_days, ot_threshold=excluded.ot_threshold,
       default_deductions=excluded.default_deductions`,
    [PAY_CONFIG.anchorDate, PAY_CONFIG.periodDays, PAY_CONFIG.otThreshold,
     JSON.stringify(PAY_CONFIG.defaultDeductions || [])]);

  // USERS — passwords are managed exclusively through /api/auth/login (self-migration)
  // and /api/users/:id/password. Bulk saves NEVER overwrite an existing user's password
  // hash, no matter what the client sends — this is what keeps password changes safe
  // even though the whole app state round-trips through this one endpoint on every save.
  const existingPasswords = {};
  all('SELECT id, password FROM users').forEach(r => { existingPasswords[r.id] = r.password; });
  run('DELETE FROM users');
  for (const u of (USERS || [])) {
    let pw = existingPasswords[u.id];
    if (pw === undefined) {
      // Genuinely new user row — hash whatever was supplied (falls back to a random
      // password if none was given, so a malformed row can never create a blank-password account)
      pw = u.password ? bcrypt.hashSync(String(u.password), 10) : bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 10);
    }
    run('INSERT INTO users (id,username,password,name,role,staff_id) VALUES (?,?,?,?,?,?)',
        [u.id, u.username, pw, u.name, u.role, u.staffId || null]);
  }

  // LOCATIONS
  run('DELETE FROM locations');
  for (const l of (LOCATIONS || []))
    run('INSERT INTO locations (id,name,rate,mult,notes,rate_history) VALUES (?,?,?,?,?,?)',
        [l.id, l.name, l.rate, l.mult, l.notes||'', JSON.stringify(l.rateHistory||[])]);

  // STAFF — pto_balance is intentionally NEVER taken from the client payload.
  // It's only ever changed through the leave-request endpoints (request/approve),
  // which write it directly to the database. If a bulk save trusted whatever
  // balance number happened to be in the browser's memory, a stale second tab
  // (or one opened before someone else's PTO approval landed) could silently
  // revert an already-approved deduction back to an old value.
  const existingPtoBalances = {};
  all('SELECT id, pto_balance FROM staff').forEach(r => { existingPtoBalances[r.id] = r.pto_balance; });
  run('DELETE FROM staff');
  for (const s of (STAFF || [])) {
    const ptoBalance = existingPtoBalances[s.id] !== undefined ? existingPtoBalances[s.id] : (s.ptoBalance || 0);
    run('INSERT INTO staff (id,first,last,title,type,loc,rate,start,status,pto_balance) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [s.id, s.first, s.last, s.title||'DSP', s.type||'Full-Time', s.loc||'', s.rate, s.start, s.status||'Active', ptoBalance]);
  }

  // SHIFTS
  run('DELETE FROM shifts');
  for (const s of (SHIFTS || [])) {
    const { id, staff, date, timeIn, timeOut, loc, hours, regHours, otHours, approved, periodStart, periodEnd, ...rest } = s;
    run(`INSERT INTO shifts (id,staff_id,date,time_in,time_out,loc,hours,reg_hours,ot_hours,approved,period_start,period_end,extra_data)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, staff, date, timeIn||s.time_in||'', timeOut||s.time_out||'',
         loc||'', hours||0, regHours||s.reg_hours||0, otHours||s.ot_hours||0,
         approved?1:0, periodStart||s.period_start||'', periodEnd||s.period_end||'',
         JSON.stringify(rest)]);
  }

  // Blob tables
  run('DELETE FROM pending_approvals');
  for (const r of (PENDING_APPROVALS||[]))
    run('INSERT INTO pending_approvals (id,data) VALUES (?,?)', [r.id||('PA'+Date.now()+Math.random()), JSON.stringify(r)]);

  run('DELETE FROM approved_exceptions');
  for (const r of (APPROVED_EXCEPTIONS||[]))
    run('INSERT INTO approved_exceptions (id,data) VALUES (?,?)', [r.id||('AE'+Date.now()+Math.random()), JSON.stringify(r)]);

  run('DELETE FROM date_correction_log');
  for (const r of (DATE_CORRECTION_LOG||[]))
    run('INSERT INTO date_correction_log (id,data) VALUES (?,?)', [r.id||('DC'+Date.now()+Math.random()), JSON.stringify(r)]);

  run('DELETE FROM deletion_log');
  for (const r of (DELETION_LOG||[]))
    run('INSERT INTO deletion_log (id,data) VALUES (?,?)', [r.id||('DL'+Date.now()+Math.random()), JSON.stringify(r)]);

  run('DELETE FROM payroll_records');
  for (const r of (PAYROLL_RECORDS||[]))
    run('INSERT INTO payroll_records (id,data) VALUES (?,?)', [r.periodStart||('PR'+Date.now()+Math.random()), JSON.stringify(r)]);

  run('DELETE FROM audit_log');
  for (const r of (AUDIT_LOG||[]))
    run('INSERT INTO audit_log (id,type,detail,meta,by,by_role,at,ts,action,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [r.id||('AL'+Date.now()+Math.random()), r.type||'', r.detail||'',
         r.meta ? JSON.stringify(r.meta) : '', r.by||'System', r.byRole||'system',
         r.at||new Date().toLocaleString(), r.ts||Date.now(),
         r.type||'', r.by||'', new Date(r.ts||Date.now()).toISOString()]);

  persistDB();
}

// ── Employee self-service data scoping ──────────────────────
// An 'employee' role account must NEVER receive another employee's shifts,
// pay data, or PII. Rather than trust the client to hide what it's given
// (which is not real security), this filters the full dataset down to just
// what belongs to the requesting employee's linked staff record BEFORE it
// ever leaves the server. Returned in the same shape as loadDB() so the
// existing client bootstrapping code needs no special-casing.
function scopeDataForEmployee(fullData, staffId) {
  const empty = {
    PAY_CONFIG: fullData.PAY_CONFIG, USERS: [], LOCATIONS: [], STAFF: [], SHIFTS: [],
    PENDING_APPROVALS: [], APPROVED_EXCEPTIONS: [], DATE_CORRECTION_LOG: [],
    DELETION_LOG: [], AUDIT_LOG: [], PAYROLL_RECORDS: [], LEAVE_REQUESTS: []
  };
  if (!staffId) return empty; // employee account not linked to a staff record — safest is to show nothing

  const myStaff = fullData.STAFF.filter(s => s.id === staffId);
  if (!myStaff.length) return empty;

  const myShifts = fullData.SHIFTS.filter(s => s.staff === staffId);
  const myLocationNames = new Set(myShifts.map(s => s.loc).concat(myStaff.map(s => s.loc)));
  const myLocations = fullData.LOCATIONS.filter(l => myLocationNames.has(l.name));

  const myPayrollRecords = fullData.PAYROLL_RECORDS.map(rec => ({
    ...rec,
    rows: (rec.rows || []).filter(r => r.staffId === staffId),
    employeeRows: (rec.employeeRows || []).filter(r => r.staffId === staffId)
  })).filter(rec => rec.employeeRows.length > 0 || rec.rows.length > 0 || !rec.finalized);

  const myLeaveRequests = fullData.LEAVE_REQUESTS.filter(r => r.staffId === staffId);

  return {
    PAY_CONFIG: fullData.PAY_CONFIG,
    USERS: [], // employees don't need account info beyond their own session, already known client-side
    LOCATIONS: myLocations,
    STAFF: myStaff,
    SHIFTS: myShifts,
    PENDING_APPROVALS: fullData.PENDING_APPROVALS.filter(p => p.staffId === staffId),
    APPROVED_EXCEPTIONS: fullData.APPROVED_EXCEPTIONS.filter(a => a.staffId === staffId),
    DATE_CORRECTION_LOG: [], // internal admin audit detail, not needed for self-service
    DELETION_LOG: [],
    AUDIT_LOG: [],
    PAYROLL_RECORDS: myPayrollRecords,
    LEAVE_REQUESTS: myLeaveRequests
  };
}

// ── Auth middleware ────────────────────────────────────────
function requireAuth(req, res, next) {
  const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
  if (!sessionId) return res.status(401).json({ error: 'Not authenticated' });
  const session = get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  if (!session || session.expires_at < Date.now()) {
    if (session) { run('DELETE FROM sessions WHERE id = ?', [sessionId]); persistDB(); }
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
  const user = get('SELECT id,username,name,role,staff_id FROM users WHERE id = ?', [session.user_id]);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  req.user = { id: user.id, username: user.username, name: user.name, role: user.role, staffId: user.staff_id || null };
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'This action requires an admin account' });
  }
  next();
}

// ── Write authorization for the generic /api/db/save endpoint ──────
// Session auth alone only proves *who* is asking — it says nothing about
// *what* they're allowed to change. This checks the incoming payload against
// what's currently stored and rejects role-restricted changes, mirroring the
// client's own userCan() permission map so the UI's rules are actually enforced.
function deepChanged(a, b) { return JSON.stringify(a) !== JSON.stringify(b); }
function sortedById(arr) { return [...(arr||[])].sort((a,b) => String(a.id).localeCompare(String(b.id))); }
function stripPasswords(arr) { return sortedById((arr||[]).map(({ password, ...rest }) => rest)); }

// Validates the actual content of shift records, independent of who's allowed
// to submit them. authorizeSave only checks WHO can add/edit/delete a shift —
// nothing previously checked WHETHER the shift data itself made sense, so a
// malformed payload (negative hours, a staff ID that doesn't exist) could be
// saved without any complaint and quietly corrupt payroll calculations.
function validateShifts(incomingShifts, staffIds) {
  for (const s of (incomingShifts || [])) {
    if (!s.id || typeof s.id !== 'string') return 'A shift is missing a valid ID';
    if (!s.staff || !staffIds.has(s.staff)) return `Shift ${s.id} references a staff member that doesn't exist`;
    if (!s.date || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) return `Shift ${s.id} has an invalid date`;
    const hours = Number(s.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) return `Shift ${s.id} has an invalid hours value (must be 0\u201324)`;
  }
  return null;
}

function authorizeSave(existing, incoming, user) {
  const isAdmin = user.role === 'admin';
  const canShift = user.role === 'admin' || user.role === 'supervisor';

  const staffIds = new Set((incoming.STAFF || existing.STAFF || []).map(s => s.id));
  const shiftValidationError = validateShifts(incoming.SHIFTS, staffIds);
  if (shiftValidationError) return shiftValidationError;

  if (deepChanged(incoming.PAY_CONFIG, existing.PAY_CONFIG) && !isAdmin)
    return 'Pay period settings can only be changed by an admin account';

  if (deepChanged(sortedById(incoming.LOCATIONS), sortedById(existing.LOCATIONS)) && !isAdmin)
    return 'Locations can only be managed by an admin account';

  if (deepChanged(sortedById(incoming.STAFF), sortedById(existing.STAFF)) && !isAdmin)
    return 'Staff records can only be managed by an admin account';

  if (deepChanged(stripPasswords(incoming.USERS), stripPasswords(existing.USERS)) && !isAdmin)
    return 'User accounts can only be managed by an admin account';

  if (deepChanged(sortedById((incoming.PAYROLL_RECORDS||[]).map(r=>({...r, id:r.periodStart}))),
                   sortedById((existing.PAYROLL_RECORDS||[]).map(r=>({...r, id:r.periodStart})))) && !isAdmin)
    return 'Payroll can only be managed by an admin account';

  const existingShiftsById = {}; (existing.SHIFTS||[]).forEach(s => { existingShiftsById[s.id] = s; });
  const incomingShiftsById = {}; (incoming.SHIFTS||[]).forEach(s => { incomingShiftsById[s.id] = s; });
  for (const id in incomingShiftsById) {
    const ex = existingShiftsById[id];
    if (!ex) { if (!canShift) return 'Adding shifts requires an admin or supervisor account'; }
    else if (deepChanged(incomingShiftsById[id], ex) && !canShift) return 'Editing shifts requires an admin or supervisor account';
  }
  for (const id in existingShiftsById) {
    if (!incomingShiftsById[id] && user.role !== 'admin') return 'Deleting shifts requires an admin account';
  }

  // These were previously unchecked entirely — any authenticated role, including
  // 'viewer' (meant to be strictly read-only), could fabricate a fake approved
  // exception or silently wipe a pending 24-hour violation via a raw API call
  // that never touched the UI. Matches the same admin/supervisor gate the
  // Approvals page itself uses.
  if (deepChanged(sortedById(incoming.PENDING_APPROVALS), sortedById(existing.PENDING_APPROVALS)) && !canShift)
    return 'Managing pending approvals requires an admin or supervisor account';

  if (deepChanged(sortedById(incoming.APPROVED_EXCEPTIONS), sortedById(existing.APPROVED_EXCEPTIONS)) && !canShift)
    return 'Managing approved exceptions requires an admin or supervisor account';

  // Date corrections and deletion history are only ever legitimately created by
  // admin-only actions (Pay Period Setup's date-correction tool, and shift
  // deletion) — same reasoning as above, a lower-severity but real gap since
  // these logs weren't checked at all before.
  if ((incoming.DATE_CORRECTION_LOG||[]).length > (existing.DATE_CORRECTION_LOG||[]).length && !isAdmin)
    return 'Date corrections require an admin account';

  if ((incoming.DELETION_LOG||[]).length > (existing.DELETION_LOG||[]).length && !isAdmin)
    return 'Recording a deletion requires an admin account';

  return null; // authorized
}

// ── Append-only protection for history/log tables ──────────────────
// A generic full-replace save should never be able to shrink these — that
// would mean an authenticated user (of any role) could erase the audit trail,
// deletion log, or date-correction log simply by sending a shorter array.
function mergeAppendOnly(existingArr, incomingArr, tsField) {
  const existing = existingArr || [];
  const incoming = incomingArr || [];
  const hasIds = existing.every(e => e && e.id) && incoming.every(e => e && e.id);
  if (hasIds) {
    const byId = {};
    existing.forEach(e => { byId[e.id] = e; });
    incoming.forEach(e => { byId[e.id] = e; });
    const merged = Object.values(byId);
    if (tsField) merged.sort((a,b) => (b[tsField]||0) > (a[tsField]||0) ? 1 : -1);
    return merged;
  }
  // No reliable id on this log (e.g. DATE_CORRECTION_LOG) — dedupe by content instead
  const seen = new Set(existing.map(e => JSON.stringify(e)));
  const merged = existing.slice();
  incoming.forEach(e => { const k = JSON.stringify(e); if (!seen.has(k)) { merged.push(e); seen.add(k); } });
  return merged;
}

// ── Start everything ───────────────────────────────────────
async function main() {
  // Init sql.js
  const SQL = await initSqlJs();

  // Load existing DB file or create fresh
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[ASO DB] Loaded existing database from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[ASO DB] Creating new database at', DB_PATH);
  }

  createSchema();

  // Seed if empty
  const hasConfig = get('SELECT COUNT(*) as c FROM pay_config').c;
  if (!hasConfig) {
    console.log('[ASO DB] First run — seeding defaults...');
    saveDB(DEFAULT_SEED);
    console.log('[ASO DB] Seed complete.');
  } else {
    const counts = {
      shifts: get('SELECT COUNT(*) as c FROM shifts').c,
      staff:  get('SELECT COUNT(*) as c FROM staff').c,
    };
    console.log(`[ASO DB] Ready — ${counts.staff} staff, ${counts.shifts} shifts`);
  }

  // Periodic cleanup of expired sessions (every hour)
  setInterval(() => {
    try {
      run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
      persistDB();
    } catch (e) { /* ignore */ }
  }, 60 * 60 * 1000);

  // Automatic daily backup, plus one at startup so a fresh deploy always has
  // at least one snapshot without waiting a full day.
  try { createBackup('auto'); console.log('[ASO Backup] Startup snapshot created'); }
  catch (e) { console.warn('[ASO Backup] Startup snapshot failed:', e.message); }
  setInterval(() => {
    try { createBackup('auto'); console.log('[ASO Backup] Daily snapshot created'); }
    catch (e) { console.warn('[ASO Backup] Daily snapshot failed:', e.message); }
  }, 24 * 60 * 60 * 1000);

  // ── Express App ──────────────────────────────────────────
  const app = express();
  app.set('trust proxy', 1); // Render sits behind a proxy — needed for correct secure-cookie/IP detection
  app.use(helmet({ contentSecurityPolicy: false })); // CSP off: this app is one big self-contained HTML file with inline scripts
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  // Rate-limited by IP, which matters here specifically: staff at the same
  // house share one WiFi connection, and several people logging in around a
  // shift change could plausibly hit a low shared limit together even with
  // no malicious intent. 60/15min still blocks a real brute-force attempt
  // (a genuine attacker trying hundreds of passwords) while giving a house
  // with a dozen-plus staff realistic headroom for normal daily use.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts from this network — please wait a few minutes and try again' }
  });

  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please wait a few minutes and try again' }
  });

  app.get('/', (req, res) => {
    if (fs.existsSync(HTML_FILE)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(HTML_FILE);
    } else {
      res.status(404).send(`
        <h2>ASO OT System — Setup Required</h2>
        <p>Place <code>ASO_OT_SYSTEM_SQL.html</code> in the same folder as server.js.</p>
        <p>Expected path: <code>${HTML_FILE}</code></p>
      `);
    }
  });

  // ── Auth routes ────────────────────────────────────────
  app.post('/api/auth/login', loginLimiter, async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

      const user = get('SELECT * FROM users WHERE username = ?', [String(username).trim().toLowerCase()]);
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });

      const ok = await verifyPassword(user.password, password);
      if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

      // Transparently upgrade legacy password hashes to bcrypt on successful login
      if (!isBcryptHash(user.password)) {
        run('UPDATE users SET password = ? WHERE id = ?', [bcrypt.hashSync(password, 10), user.id]);
      }

      const sessionId = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + SESSION_TTL_MS;
      run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)', [sessionId, user.id, expiresAt]);
      persistDB();

      res.cookie(SESSION_COOKIE, sessionId, {
        httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: SESSION_TTL_MS, path: '/'
      });
      res.json({ ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role, staffId: user.staff_id || null } });
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const sessionId = req.cookies && req.cookies[SESSION_COOKIE];
    if (sessionId) { run('DELETE FROM sessions WHERE id = ?', [sessionId]); persistDB(); }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // Self-service (or admin-on-behalf-of) password change — the only way a
  // password is ever set for an EXISTING account. See saveDB() for why.
  app.post('/api/users/:id/password', requireAuth, writeLimiter, (req, res) => {
    try {
      const targetId = req.params.id;
      const { password } = req.body || {};
      if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      if (req.user.id !== targetId && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Not authorized to change this password' });
      }
      const target = get('SELECT id FROM users WHERE id = ?', [targetId]);
      if (!target) return res.status(404).json({ error: 'User not found' });
      run('UPDATE users SET password = ? WHERE id = ?', [bcrypt.hashSync(password, 10), targetId]);
      persistDB();
      res.json({ ok: true });
    } catch (e) {
      console.error('Password change error:', e);
      res.status(500).json({ error: 'Password change failed' });
    }
  });

  // ── Data routes (all require a valid session) ───────────
  app.get('/api/db/load', requireAuth, (req, res) => {
    try {
      const data = loadDB();
      if (req.user.role === 'employee') {
        return res.json(scopeDataForEmployee(data, req.user.staffId));
      }
      res.json(data);
    }
    catch(e) { console.error('Load error:', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/db/save', requireAuth, (req, res) => {
    try {
      if (req.user.role === 'employee') {
        return res.status(403).json({ error: 'Employee accounts cannot modify shared data directly' });
      }
      const existing = loadDB();
      const denyReason = authorizeSave(existing, req.body, req.user);
      if (denyReason) return res.status(403).json({ error: denyReason });

      const payload = { ...req.body };
      payload.AUDIT_LOG          = mergeAppendOnly(existing.AUDIT_LOG, payload.AUDIT_LOG, 'ts');
      payload.DELETION_LOG       = mergeAppendOnly(existing.DELETION_LOG, payload.DELETION_LOG);
      payload.DATE_CORRECTION_LOG = mergeAppendOnly(existing.DATE_CORRECTION_LOG, payload.DATE_CORRECTION_LOG);

      saveDB(payload);
      res.json({ ok: true, ts: new Date().toISOString() });
    }
    catch(e) { console.error('Save error:', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/db/reset', requireAuth, requireAdmin, (req, res) => {
    try {
      const tables = ['pay_config','users','locations','staff','shifts',
                      'pending_approvals','approved_exceptions',
                      'date_correction_log','deletion_log','payroll_records','audit_log','sessions'];
      for (const t of tables) run(`DELETE FROM ${t}`);
      saveDB(DEFAULT_SEED);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/db/export', requireAuth, requireAdmin, (req, res) => {
    try {
      const data = { ...loadDB(), exportedAt: new Date().toISOString(), version: 10 };
      const now = new Date();
      const dateLabel = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      res.setHeader('Content-Disposition', `attachment; filename="ASO_backup_${dateLabel}.json"`);
      res.json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/db/import', requireAuth, requireAdmin, (req, res) => {
    try {
      const data = req.body;
      if (!Array.isArray(data.SHIFTS) || !Array.isArray(data.STAFF)) {
        return res.status(400).json({ error: 'Invalid backup — SHIFTS and STAFF must be present' });
      }
      const staffIds = new Set(data.STAFF.map(s => s.id));
      const shiftError = validateShifts(data.SHIFTS, staffIds);
      if (shiftError) return res.status(400).json({ error: `Backup contains invalid shift data: ${shiftError}` });
      saveDB(data);
      res.json({ ok: true, shifts: data.SHIFTS.length, staff: data.STAFF.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Automatic + manual database backups (separate from the JSON export
  //    above — these are raw SQLite snapshots stored on the server's disk) ──
  // ── Leave requests (PTO) ─────────────────────────────────
  // Full list — admin/supervisor only, for reviewing requests.
  app.get('/api/leave-requests', requireAuth, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'supervisor') {
      return res.status(403).json({ error: 'Not authorized to view all leave requests' });
    }
    try {
      const rows = all('SELECT * FROM leave_requests ORDER BY requested_at DESC');
      res.json({ leaveRequests: rows.map(r => ({
        id: r.id, staffId: r.staff_id, type: r.type, startDate: r.start_date, endDate: r.end_date,
        hours: r.hours, status: r.status, notes: r.notes, requestedBy: r.requested_by,
        requestedAt: r.requested_at, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at
      })) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Create a request. Employees can only ever create one for themselves — the
  // staffId in the request body is ignored for employee accounts and forced
  // to their own linked staff record server-side. Admin/supervisor can log
  // PTO on behalf of anyone, and their entries are auto-approved immediately
  // (they already have the authority to grant it) with the balance deducted.
  const LEAVE_TYPES = ['vacation', 'sick', 'personal'];
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  app.post('/api/leave-requests', requireAuth, writeLimiter, (req, res) => {
    try {
      const isStaffAction = req.user.role === 'admin' || req.user.role === 'supervisor';
      const staffId = isStaffAction ? (req.body.staffId || req.user.staffId) : req.user.staffId;
      if (!staffId) return res.status(400).json({ error: 'No staff record linked to this account' });

      const { type, startDate, endDate, notes } = req.body || {};
      const hours = Number(req.body && req.body.hours);

      if (!LEAVE_TYPES.includes(type)) {
        return res.status(400).json({ error: 'Type must be vacation, sick, or personal' });
      }
      if (!ISO_DATE_RE.test(startDate) || !ISO_DATE_RE.test(endDate)) {
        return res.status(400).json({ error: 'Dates must be valid (YYYY-MM-DD)' });
      }
      if (endDate < startDate) {
        return res.status(400).json({ error: 'End date must be on or after the start date' });
      }
      if (!Number.isFinite(hours) || hours <= 0 || hours > 500) {
        return res.status(400).json({ error: 'Hours must be a positive number (500 or fewer)' });
      }
      const safeNotes = typeof notes === 'string' ? notes.slice(0, 500) : '';

      const staff = get('SELECT * FROM staff WHERE id = ?', [staffId]);
      if (!staff) return res.status(404).json({ error: 'Staff record not found' });

      const id = 'LV' + Date.now() + Math.random().toString(36).slice(2,6);
      const status = isStaffAction ? 'approved' : 'pending';
      const now = new Date().toLocaleString();
      run(`INSERT INTO leave_requests (id,staff_id,type,start_date,end_date,hours,status,notes,requested_by,requested_at,reviewed_by,reviewed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, staffId, type, startDate, endDate, hours, status, safeNotes, req.user.name, now,
         isStaffAction ? req.user.name : '', isStaffAction ? now : '']);

      if (isStaffAction) {
        run('UPDATE staff SET pto_balance = pto_balance - ? WHERE id = ?', [hours, staffId]);
      }
      writeAuditLog(
        isStaffAction ? 'LEAVE_LOGGED' : 'LEAVE_REQUESTED',
        `${req.user.name} ${isStaffAction ? 'logged' : 'requested'} ${hours}h ${type} for ${staff.first} ${staff.last} (${startDate} to ${endDate})`,
        req.user
      );
      persistDB();
      res.json({ ok: true, id, status });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Approve/deny a pending request — admin/supervisor only. Approving deducts
  // the hours from the employee's PTO balance at review time (not request time),
  // since a denied request should never have touched the balance.
  app.post('/api/leave-requests/:id/review', requireAuth, writeLimiter, (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'supervisor') {
      return res.status(403).json({ error: 'Not authorized to review leave requests' });
    }
    try {
      const { action } = req.body || {};
      if (action !== 'approve' && action !== 'deny') return res.status(400).json({ error: 'Invalid action' });
      const reqRow = get('SELECT * FROM leave_requests WHERE id = ?', [req.params.id]);
      if (!reqRow) return res.status(404).json({ error: 'Request not found' });
      if (reqRow.status !== 'pending') return res.status(400).json({ error: 'This request has already been reviewed' });

      const now = new Date().toLocaleString();
      run('UPDATE leave_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
        [action === 'approve' ? 'approved' : 'denied', req.user.name, now, req.params.id]);

      if (action === 'approve') {
        run('UPDATE staff SET pto_balance = pto_balance - ? WHERE id = ?', [reqRow.hours, reqRow.staff_id]);
      }
      const staff = get('SELECT * FROM staff WHERE id = ?', [reqRow.staff_id]);
      writeAuditLog(
        action === 'approve' ? 'LEAVE_APPROVED' : 'LEAVE_DENIED',
        `${req.user.name} ${action === 'approve' ? 'approved' : 'denied'} ${reqRow.hours}h ${reqRow.type} for ${staff ? staff.first+' '+staff.last : reqRow.staff_id}`,
        req.user
      );
      persistDB();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Manual PTO balance adjustment — admin only. For granting an annual
  // allotment or correcting a mistake. Writes directly to the database (same
  // pattern as leave-request review) so it's never at risk of being reverted
  // by a stale bulk save, and always leaves an audit trail entry.
  app.post('/api/staff/:id/pto-adjust', requireAuth, requireAdmin, writeLimiter, (req, res) => {
    try {
      const delta = Number(req.body && req.body.delta);
      const reason = typeof (req.body && req.body.reason) === 'string' ? req.body.reason.slice(0, 300) : '';
      if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 2000) {
        return res.status(400).json({ error: 'Adjustment must be a non-zero number (2000 hours or fewer in magnitude)' });
      }
      const staff = get('SELECT * FROM staff WHERE id = ?', [req.params.id]);
      if (!staff) return res.status(404).json({ error: 'Staff record not found' });

      run('UPDATE staff SET pto_balance = pto_balance + ? WHERE id = ?', [delta, req.params.id]);
      const updated = get('SELECT pto_balance FROM staff WHERE id = ?', [req.params.id]);
      writeAuditLog(
        'PTO_ADJUSTED',
        `${req.user.name} adjusted PTO balance for ${staff.first} ${staff.last} by ${delta > 0 ? '+' : ''}${delta}h${reason ? ` (${reason})` : ''}`,
        req.user
      );
      persistDB();
      res.json({ ok: true, newBalance: updated.pto_balance });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/backups', requireAuth, requireAdmin, (req, res) => {
    try { res.json({ backups: listBackups(), retention: BACKUP_RETENTION }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/backups', requireAuth, requireAdmin, writeLimiter, (req, res) => {
    try {
      const filename = createBackup('manual');
      res.json({ ok: true, filename });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/backups/:filename', requireAuth, requireAdmin, (req, res) => {
    const filename = req.params.filename;
    // Only allow filenames we actually generated ourselves — never accept a
    // path from the client verbatim for a filesystem read.
    if (!/^aso_ot_(auto|manual)_[\w-]+\.db$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid backup filename' });
    }
    const filePath = path.join(BACKUP_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
    res.download(filePath, filename);
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Catch-all error handler — must be registered after every route. Anything
  // that throws synchronously in a route handler and wasn't already caught by
  // its own try/catch lands here instead of crashing the whole process.
  app.use((err, req, res, next) => {
    console.error('[ASO] Unhandled route error:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  });

  app.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║   ASO Staff OT System — Server Running  ║');
    console.log(`  ║   http://${HOST}:${PORT}                  ║`);
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log('  Press Ctrl+C to stop the server.\n');
    if (process.platform === 'win32' && !process.env.PORT) {
      const { exec } = require('child_process');
      exec('start http://localhost:8420');
    }
  });

  process.on('SIGINT', () => {
    console.log('\n[ASO] Saving and stopping...');
    persistDB();
    db.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[ASO] Fatal error:', err);
  process.exit(1);
});
