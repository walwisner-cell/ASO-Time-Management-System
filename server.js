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
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — absolute session lifetime
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour — session dies early if unused this long, even within the 24hr window
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
  return { changes: db.getRowsModified() };
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

// ── Audit log hash chain (tamper-evidence) ──────────────────
// Each entry's hash is computed from the previous entry's hash plus this
// entry's own content — the same principle a blockchain uses. Changing or
// deleting ANY past entry changes what its hash *should* be, which no longer
// matches what every later entry was chained from — breaking the chain from
// that point forward. This is deterministic and stateless: given the same
// entries in the same order, /api/audit-log/verify can recompute the exact
// same chain from scratch and prove nothing was altered, rather than just
// making tampering harder through the normal app (which append-only merging
// already handled, but couldn't detect direct database tampering).
const AUDIT_CHAIN_GENESIS = 'GENESIS';
function computeEntryHash(prevHash, entry) {
  const payload = `${prevHash}|${entry.id}|${entry.type}|${entry.detail}|${entry.by}|${entry.byRole}|${entry.at}|${entry.ts}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}
function computeHashChain(entriesOldestFirst) {
  let prevHash = AUDIT_CHAIN_GENESIS;
  return entriesOldestFirst.map(e => {
    const hash = computeEntryHash(prevHash, e);
    prevHash = hash;
    return { ...e, hash };
  });
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
  const newEntry = { id, type, detail: detail || '', by, byRole, at, ts };

  // Recompute the chain including this new entry, so its hash is guaranteed
  // consistent with however saveDB() would compute it for the same data.
  const existing = all('SELECT id,type,detail,by,by_role AS byRole,at,ts FROM audit_log ORDER BY ts ASC');
  const chained = computeHashChain([...existing, newEntry]);
  const hash = chained[chained.length - 1].hash;

  run(`INSERT INTO audit_log (id,type,detail,meta,by,by_role,at,ts,hash,action,user_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, type, detail || '', meta ? JSON.stringify(meta) : '', by, byRole, at, ts, hash,
       type, (user && user.id) || '', new Date(ts).toISOString()]);
}

// ── Granular permissions ────────────────────────────────────
// Every permission key that exists in the system, organized by module. This
// is the single source of truth for what CAN be granted — a custom role's
// stored permissions are validated against this list on every save, so a
// tampered or malformed role definition can never grant something that
// isn't a real, recognized permission.
const ALL_PERMISSIONS = [
  'dashboard_view',
  'shifts_view', 'shifts_add', 'shifts_edit', 'shifts_delete',
  'approvals_view', 'approvals_review_shifts', 'approvals_review_leave', 'approvals_review_clock', 'clock_override',
  'clock_locations_view',
  'payroll_view', 'payroll_run', 'payroll_unlock', 'taxes_manage',
  'staff_view', 'staff_manage', 'staff_view_wage', 'staff_pto_adjust',
  'locations_view', 'locations_manage',
  'users_view', 'users_manage', 'roles_manage',
  'data_export', 'data_import', 'data_backup', 'data_reset',
  'reports_view', 'audit_view', 'audit_verify',
];

// The four original roles are "built-in": their permissions are fixed here
// in code, not in the database, specifically so nothing (a bug, a bad
// migration, direct database access) can ever silently weaken what "admin"
// or "supervisor" is allowed to do. This mapping preserves the EXACT same
// behavior these roles already had before granular permissions existed —
// no existing account's access changes because this system was added.
const BUILTIN_ROLE_PERMISSIONS = {
  admin: ALL_PERMISSIONS, // everything, always
  supervisor: [
    'dashboard_view', 'shifts_view', 'shifts_add', 'shifts_edit',
    'approvals_view', 'approvals_review_shifts', 'approvals_review_leave', 'approvals_review_clock', 'clock_override',
    'payroll_view', 'staff_view', 'locations_view', 'reports_view',
  ],
  viewer: [
    'dashboard_view', 'shifts_view', 'approvals_view', 'payroll_view',
    'staff_view', 'locations_view', 'reports_view', 'audit_view',
  ],
  employee: [], // employees use their own scoped self-service endpoints, not this permission system at all
};

function roleExists(roleName) {
  if (BUILTIN_ROLE_PERMISSIONS[roleName]) return true;
  return !!get('SELECT id FROM roles WHERE name = ?', [roleName]);
}

function getRolePermissions(roleName) {
  if (BUILTIN_ROLE_PERMISSIONS[roleName]) return BUILTIN_ROLE_PERMISSIONS[roleName];
  const row = get('SELECT permissions FROM roles WHERE name = ?', [roleName]);
  if (!row) return [];
  try {
    const perms = JSON.parse(row.permissions);
    // Re-validate against ALL_PERMISSIONS on every read too, not just on
    // save — defense in depth in case a permission was ever removed from
    // the taxonomy after a role was created with it.
    return Array.isArray(perms) ? perms.filter(p => ALL_PERMISSIONS.includes(p)) : [];
  } catch (e) { return []; }
}

// The one function every permission check in this file should call. Takes
// the full req.user object (needs .role) and a permission key.
function hasPermission(user, permissionKey) {
  if (!user || !user.role) return false;
  if (!ALL_PERMISSIONS.includes(permissionKey)) return false; // fail closed on an unrecognized key, never fail open
  return getRolePermissions(user.role).includes(permissionKey);
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
  // Custom roles: 'admin'/'supervisor'/'viewer'/'employee' are built-in and
  // never stored here — their permissions are fixed in code (see
  // BUILTIN_ROLE_PERMISSIONS below) specifically so they can never be
  // accidentally weakened by editing a database row. Anything else is a
  // custom role, defined here with a per-permission-key JSON object.
  db.run(`CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    permissions TEXT NOT NULL DEFAULT '{}',
    created_by TEXT DEFAULT '', created_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    last_activity INTEGER DEFAULT 0
  )`);
  try { db.run(`ALTER TABLE sessions ADD COLUMN last_activity INTEGER DEFAULT 0`); } catch (e) { /* already exists */ }
  db.run(`CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    rate REAL NOT NULL DEFAULT 0, mult REAL NOT NULL DEFAULT 1.5,
    notes TEXT DEFAULT '', rate_history TEXT DEFAULT '[]',
    max_staff INTEGER DEFAULT 0
  )`);
  // 0 = no limit. Migration is additive so existing installs don't suddenly
  // start blocking anyone — every location defaults to unlimited until an
  // admin explicitly sets a cap.
  try { db.run(`ALTER TABLE locations ADD COLUMN max_staff INTEGER DEFAULT 0`); } catch (e) { /* already exists */ }
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
    period_end TEXT DEFAULT '', extra_data TEXT DEFAULT '{}',
    source TEXT DEFAULT 'manual'
  )`);
  // 'manual' (entered by an admin/supervisor), 'clock_in' (employee clocked
  // themselves in/out, then approved), or 'clock_in_override' (an admin
  // clocked someone in past capacity, or closed out a stuck clock-in on
  // their behalf, before it was approved). Existing shifts predate this
  // column and default to 'manual', which is accurate — they were all
  // entered by hand before clock in/out existed.
  try { db.run(`ALTER TABLE shifts ADD COLUMN source TEXT DEFAULT 'manual'`); } catch (e) { /* already exists */ }
  // A rejected shift is never deleted — it stays fully visible to the
  // employee (with the reason) and excluded from payroll, rather than
  // silently vanishing with no explanation. Deleting a shift is still
  // available separately for genuine mistakes (duplicate entry, wrong
  // person entirely); rejecting is for "this happened, but shouldn't count."
  ['shift_status TEXT DEFAULT \'active\'', 'rejected_reason TEXT DEFAULT \'\'', 'rejected_by TEXT DEFAULT \'\'', 'rejected_at TEXT DEFAULT \'\''].forEach(colDef => {
    try { db.run(`ALTER TABLE shifts ADD COLUMN ${colDef}`); } catch (e) { /* already exists */ }
  });
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
  // Clock in/out: an employee clocks in and out themselves, but nothing
  // touches the real SHIFTS table (and therefore payroll/OT calculations)
  // until an admin or supervisor reviews and approves it. Dates/times are
  // the employee's own local date/time strings, reported by their browser
  // at the moment they click — exactly like every other date/time in this
  // app already works (manual shift entry trusts the browser's local date
  // too). Deliberately NOT server-side epoch-to-local-time conversion,
  // which would silently reintroduce the same timezone bug fixed earlier
  // this session (the server doesn't know what timezone the employee is
  // actually in). status begins 'open' while clocked in, becomes 'pending'
  // once clocked out (ready for review), then 'approved' or 'denied'.
  db.run(`CREATE TABLE IF NOT EXISTS clock_entries (
    id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, location TEXT DEFAULT '',
    clock_in_date TEXT NOT NULL, clock_in_time TEXT NOT NULL,
    clock_out_date TEXT DEFAULT '', clock_out_time TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', notes TEXT DEFAULT '',
    reviewed_by TEXT DEFAULT '', reviewed_at TEXT DEFAULT '',
    shift_id TEXT DEFAULT '', created_at TEXT NOT NULL,
    overridden INTEGER DEFAULT 0, override_reason TEXT DEFAULT '', override_by TEXT DEFAULT ''
  )`);
  [
    'overridden INTEGER DEFAULT 0', 'override_reason TEXT DEFAULT \'\'', 'override_by TEXT DEFAULT \'\'',
    // Geolocation is best-effort and point-in-time only — captured once at
    // the moment of the clock action, never continuously tracked. Always
    // NULL if the employee's browser didn't grant location permission or
    // the request failed/timed out; clocking in/out never blocks on this.
    'clock_in_lat REAL DEFAULT NULL', 'clock_in_lng REAL DEFAULT NULL', 'clock_in_accuracy REAL DEFAULT NULL',
    'clock_out_lat REAL DEFAULT NULL', 'clock_out_lng REAL DEFAULT NULL', 'clock_out_accuracy REAL DEFAULT NULL'
  ].forEach(colDef => {
    try { db.run(`ALTER TABLE clock_entries ADD COLUMN ${colDef}`); } catch (e) { /* already exists */ }
  });
  // When a staff member is marked Inactive but still has shift hours on
  // record for a pay period (they worked before being deactivated, or came
  // back for a one-off shift), payroll should never silently either include
  // or drop those hours. One row per staff+period combo once flagged;
  // 'pending' is treated exactly like 'denied' by payroll — excluded and
  // clearly called out as excluded — until an admin explicitly approves it.
  db.run(`CREATE TABLE IF NOT EXISTS payroll_inactive_flags (
    id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, period_start TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', notes TEXT DEFAULT '',
    reviewed_by TEXT DEFAULT '', reviewed_at TEXT DEFAULT '', created_at TEXT NOT NULL,
    UNIQUE(staff_id, period_start)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT DEFAULT '',
    user_id TEXT DEFAULT '', created_at TEXT NOT NULL,
    type TEXT DEFAULT '', meta TEXT DEFAULT '', by TEXT DEFAULT '',
    by_role TEXT DEFAULT '', at TEXT DEFAULT '', ts INTEGER DEFAULT 0,
    hash TEXT DEFAULT ''
  )`);
  // Migration: the audit log was originally built around action/user_id/created_at
  // columns, but the client (and the Audit Trail page that renders it) has always
  // used a different shape — type/by/byRole/at/ts. That mismatch meant every
  // audit entry came back malformed after a page reload. These columns fix it.
  ['type','meta','by','by_role','at'].forEach(col => {
    try { db.run(`ALTER TABLE audit_log ADD COLUMN ${col} TEXT DEFAULT ''`); } catch (e) { /* already exists */ }
  });
  try { db.run(`ALTER TABLE audit_log ADD COLUMN hash TEXT DEFAULT ''`); } catch (e) { /* already exists */ }
  // Backfill: anyone upgrading from before this feature existed has audit
  // entries with no hash at all. Without this, /api/audit-log/verify would
  // report every pre-existing entry as "tampered" — a false alarm, not a
  // real detection — the moment they first check it. Recompute the whole
  // chain from scratch once so historical entries get a real, valid hash.
  try {
    const needsBackfill = get(`SELECT COUNT(*) as c FROM audit_log WHERE hash = '' OR hash IS NULL`);
    if (needsBackfill && needsBackfill.c > 0) {
      const rows = all('SELECT id,type,detail,by,by_role AS byRole,at,ts FROM audit_log ORDER BY ts ASC');
      const chained = computeHashChain(rows);
      for (const r of chained) run('UPDATE audit_log SET hash = ? WHERE id = ?', [r.hash, r.id]);
      console.log(`[ASO DB] Backfilled hash chain for ${chained.length} pre-existing audit log entries`);
    }
  } catch (e) { console.warn('[ASO DB] Audit hash backfill skipped:', e.message); }
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
    rateHistory: JSON.parse(r.rate_history || '[]'), maxStaff: r.max_staff || 0
  }));
  const STAFF = all('SELECT * FROM staff').map(r => ({
    id: r.id, first: r.first, last: r.last, title: r.title,
    type: r.type, loc: r.loc, rate: r.rate, start: r.start, status: r.status,
    ptoBalance: r.pto_balance || 0
  }));
  const SHIFTS = all('SELECT * FROM shifts').map(r => {
    const extra = JSON.parse(r.extra_data || '{}');
    return { id: r.id, staff: r.staff_id, date: r.date, start: r.time_in, end: r.time_out,
             location: r.loc, hours: r.hours, regHours: r.reg_hours, otHours: r.ot_hours,
             approved: !!r.approved, periodStart: r.period_start, periodEnd: r.period_end,
             source: r.source || 'manual', shiftStatus: r.shift_status || 'active',
             rejectedReason: r.rejected_reason || '', rejectedBy: r.rejected_by || '', rejectedAt: r.rejected_at || '',
             ...extra };
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
  // Like LEAVE_REQUESTS, CLOCK_ENTRIES is read here for the client's benefit
  // but is NEVER written through the generic bulk save below — only through
  // the dedicated clock-in/out/review endpoints, so it can't be tampered
  // with via a raw save payload.
  const CLOCK_ENTRIES = all('SELECT * FROM clock_entries ORDER BY created_at DESC').map(r => ({
    id: r.id, staffId: r.staff_id, location: r.location,
    clockInDate: r.clock_in_date, clockInTime: r.clock_in_time,
    clockOutDate: r.clock_out_date || null, clockOutTime: r.clock_out_time || null,
    status: r.status, notes: r.notes, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
    shiftId: r.shift_id || null,
    overridden: !!r.overridden, overrideReason: r.override_reason || '', overrideBy: r.override_by || ''
  }));

  return { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
           PENDING_APPROVALS, APPROVED_EXCEPTIONS,
           DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG, PAYROLL_RECORDS, LEAVE_REQUESTS, CLOCK_ENTRIES };
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
    run('INSERT INTO locations (id,name,rate,mult,notes,rate_history,max_staff) VALUES (?,?,?,?,?,?,?)',
        [l.id, l.name, l.rate, l.mult, l.notes||'', JSON.stringify(l.rateHistory||[]), l.maxStaff||0]);

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
    const { id, staff, date, start, end, location, hours, regHours, otHours, approved, periodStart, periodEnd, source, shiftStatus, rejectedReason, rejectedBy, rejectedAt, ...rest } = s;
    run(`INSERT INTO shifts (id,staff_id,date,time_in,time_out,loc,hours,reg_hours,ot_hours,approved,period_start,period_end,extra_data,source,shift_status,rejected_reason,rejected_by,rejected_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, staff, date, start||'', end||'',
         location||'', hours||0, regHours||0, otHours||0,
         approved?1:0, periodStart||s.period_start||'', periodEnd||s.period_end||'',
         JSON.stringify(rest), source||'manual', shiftStatus||'active',
         rejectedReason||'', rejectedBy||'', rejectedAt||'']);
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
  const sortedAudit = (AUDIT_LOG||[]).slice().sort((a,b) => (a.ts||0) - (b.ts||0));
  const chainedAudit = computeHashChain(sortedAudit.map(r => ({
    id: r.id||('AL'+Date.now()+Math.random()), type: r.type||'', detail: r.detail||'',
    by: r.by||'System', byRole: r.byRole||'system', at: r.at||new Date().toLocaleString(),
    ts: r.ts||Date.now(), meta: r.meta
  })));
  for (const r of chainedAudit)
    run(`INSERT INTO audit_log (id,type,detail,meta,by,by_role,at,ts,hash,action,user_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.id, r.type, r.detail, r.meta ? JSON.stringify(r.meta) : '', r.by, r.byRole,
         r.at, r.ts, r.hash, r.type, r.by, new Date(r.ts).toISOString()]);

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
    DELETION_LOG: [], AUDIT_LOG: [], PAYROLL_RECORDS: [], LEAVE_REQUESTS: [], CLOCK_ENTRIES: []
  };
  if (!staffId) return empty; // employee account not linked to a staff record — safest is to show nothing

  const myStaff = fullData.STAFF.filter(s => s.id === staffId);
  if (!myStaff.length) return empty;

  const myShifts = fullData.SHIFTS.filter(s => s.staff === staffId);
  // Deliberately NOT filtered down to only locations this employee has
  // already worked at — staff sometimes cover shifts at other houses, and
  // they need to see every active location (name, rate, current staffing)
  // to pick one when clocking in, not just their own history. None of this
  // is sensitive per-person data; it's the same operational info already
  // visible to anyone who's ever seen a shift entry.
  const myLocations = fullData.LOCATIONS;

  const myPayrollRecords = fullData.PAYROLL_RECORDS.map(rec => ({
    ...rec,
    rows: (rec.rows || []).filter(r => r.staffId === staffId),
    employeeRows: (rec.employeeRows || []).filter(r => r.staffId === staffId)
  })).filter(rec => rec.employeeRows.length > 0 || rec.rows.length > 0 || !rec.finalized);

  const myLeaveRequests = fullData.LEAVE_REQUESTS.filter(r => r.staffId === staffId);
  const myClockEntries = fullData.CLOCK_ENTRIES.filter(c => c.staffId === staffId);

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
    LEAVE_REQUESTS: myLeaveRequests,
    CLOCK_ENTRIES: myClockEntries
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
  // Idle timeout: even within the 24hr absolute lifetime, a session that
  // hasn't been used in a while (e.g. a device left unlocked and unattended)
  // is killed early. Activity is tracked in memory and only flushed to disk
  // on the next natural save (or the hourly cleanup job) — writing the whole
  // database to disk on every single authenticated request would be far too
  // expensive given how often this fires.
  const lastActivity = session.last_activity || 0;
  if (lastActivity && Date.now() - lastActivity > SESSION_IDLE_TIMEOUT_MS) {
    run('DELETE FROM sessions WHERE id = ?', [sessionId]); persistDB();
    return res.status(401).json({ error: 'Session timed out from inactivity — please log in again' });
  }
  run('UPDATE sessions SET last_activity = ? WHERE id = ?', [Date.now(), sessionId]);
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

// maxStaff of 0 means "no limit" everywhere else in the app, so it's
// deliberately allowed here too — only negative, non-integer, or absurdly
// large values get rejected. Without this, a negative value was silently
// being treated as "no limit" by the capacity-check logic (which only
// enforces a cap when maxStaff > 0), which is the opposite of what an admin
// entering a negative number would reasonably expect it to mean.
function validateLocations(incomingLocations) {
  for (const l of (incomingLocations || [])) {
    if (l.maxStaff === undefined || l.maxStaff === null) continue;
    const maxStaff = Number(l.maxStaff);
    if (!Number.isFinite(maxStaff) || !Number.isInteger(maxStaff) || maxStaff < 0 || maxStaff > 100) {
      return `${l.name || 'A location'}'s Max Staff / Shift must be a whole number from 0 (no limit) to 100`;
    }
  }
  return null;
}

// Catches the exact failure mode a typo would cause: assigning someone to a
// role name that doesn't exist (built-in or custom) doesn't grant them
// nothing dangerous — hasPermission() fails closed — but it silently locks
// that person out with no explanation, which is its own kind of data
// integrity problem in a system managing people's actual paychecks.
function validateUsers(incomingUsers) {
  for (const u of (incomingUsers || [])) {
    if (!u.role || !roleExists(u.role)) {
      return `"${u.name || u.username || 'A user'}" is assigned to "${u.role || '(no role)'}", which isn't a real role \u2014 check for a typo or create that role first`;
    }
  }
  return null;
}

function authorizeSave(existing, incoming, user) {
  const isAdmin = user.role === 'admin';
  const canShift = user.role === 'admin' || user.role === 'supervisor';

  const staffIds = new Set((incoming.STAFF || existing.STAFF || []).map(s => s.id));
  const shiftValidationError = validateShifts(incoming.SHIFTS, staffIds);
  if (shiftValidationError) return shiftValidationError;

  const locationValidationError = validateLocations(incoming.LOCATIONS);
  if (locationValidationError) return locationValidationError;

  const userValidationError = validateUsers(incoming.USERS);
  if (userValidationError) return userValidationError;

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
      run('DELETE FROM sessions WHERE expires_at < ? OR (last_activity > 0 AND ? - last_activity > ?)',
          [Date.now(), Date.now(), SESSION_IDLE_TIMEOUT_MS]);
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
  // Rate limits are unchanged in production. The only thing IS_TEST_ENV
  // affects is the ceiling itself — tests run many requests from one IP in
  // a tight loop (simulating many different people in quick succession),
  // which isn't the pattern this limiter exists to catch. This does NOT
  // disable rate limiting for tests, it just sets a realistic ceiling for
  // an automated test run instead of a single real user's normal pace.
  const IS_TEST_ENV = process.env.NODE_ENV === 'test';

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: IS_TEST_ENV ? 1000 : 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts from this network — please wait a few minutes and try again' }
  });

  const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: IS_TEST_ENV ? 1000 : 40,
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
      run('INSERT INTO sessions (id, user_id, expires_at, last_activity) VALUES (?,?,?,?)', [sessionId, user.id, expiresAt, Date.now()]);
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

  // ── Custom roles / granular permissions ──────────────────
  // Creating, editing, or deleting a role requires 'roles_manage' — held
  // only by admin among the built-in roles, and only grantable to a custom
  // role by an admin (see the privilege-escalation check in POST below).
  // ── Inactive staff with worked shifts ─────────────────────
  // A staff member marked Inactive who still has shift hours for a period
  // (worked before deactivation, or came back for a one-off shift) needs an
  // explicit decision before those hours can affect payroll — never a
  // silent include or a silent drop. The client detects candidates using
  // its own period logic and reports them here; the server independently
  // re-verifies the staff member is actually Inactive before accepting a
  // flag, rather than trusting the client's claim.
  app.post('/api/inactive-flags', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'approvals_review_shifts')) {
      return res.status(403).json({ error: 'Not authorized to flag payroll items' });
    }
    try {
      const { staffId, periodStart } = req.body || {};
      const staff = get('SELECT * FROM staff WHERE id = ?', [staffId]);
      if (!staff) return res.status(400).json({ error: 'Unknown staff member' });
      if (staff.status === 'Active') return res.status(400).json({ error: 'This staff member is Active \u2014 nothing to flag' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return res.status(400).json({ error: 'Invalid period' });

      const existing = get('SELECT id FROM payroll_inactive_flags WHERE staff_id = ? AND period_start = ?', [staffId, periodStart]);
      if (existing) return res.json({ ok: true, id: existing.id, alreadyExisted: true });

      const id = 'FLAG' + Date.now() + Math.random().toString(36).slice(2,6);
      run('INSERT INTO payroll_inactive_flags (id,staff_id,period_start,status,created_at) VALUES (?,?,?,\'pending\',?)',
        [id, staffId, periodStart, new Date().toISOString()]);
      writeAuditLog('INACTIVE_STAFF_FLAGGED', `${staff.first} ${staff.last} (Inactive) has shift hours in period starting ${periodStart} \u2014 flagged for payroll review`, req.user);
      persistDB();
      res.json({ ok: true, id, alreadyExisted: false });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/inactive-flags', requireAuth, (req, res) => {
    if (!hasPermission(req.user, 'approvals_review_shifts')) {
      return res.status(403).json({ error: 'Not authorized to view payroll flags' });
    }
    try {
      const rows = all('SELECT * FROM payroll_inactive_flags ORDER BY created_at DESC');
      res.json({ flags: rows.map(r => ({
        id: r.id, staffId: r.staff_id, periodStart: r.period_start, status: r.status,
        notes: r.notes, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, createdAt: r.created_at
      })) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/inactive-flags/:id/review', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'approvals_review_shifts')) {
      return res.status(403).json({ error: 'Not authorized to review payroll flags' });
    }
    try {
      const { action, notes } = req.body || {};
      if (action !== 'approve' && action !== 'deny') return res.status(400).json({ error: 'Invalid action' });
      const flag = get('SELECT * FROM payroll_inactive_flags WHERE id = ?', [req.params.id]);
      if (!flag) return res.status(404).json({ error: 'Flag not found' });
      const staff = get('SELECT * FROM staff WHERE id = ?', [flag.staff_id]);
      const safeNotes = typeof notes === 'string' ? notes.slice(0, 500) : '';

      run(`UPDATE payroll_inactive_flags SET status = ?, notes = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
        [action === 'approve' ? 'approved' : 'denied', safeNotes, req.user.name, new Date().toISOString(), req.params.id]);
      writeAuditLog(action === 'approve' ? 'INACTIVE_STAFF_PAYROLL_APPROVED' : 'INACTIVE_STAFF_PAYROLL_DENIED',
        `${req.user.name} ${action === 'approve' ? 'approved including' : 'denied including'} ${staff ? staff.first+' '+staff.last : flag.staff_id}'s hours (Inactive) for period ${flag.period_start} in payroll${safeNotes ? ' \u2014 ' + safeNotes : ''}`,
        req.user);
      persistDB();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/permissions', requireAuth, (req, res) => {
    // The full taxonomy and what the built-in roles have, so the client can
    // render a real permission matrix instead of a hardcoded guess.
    res.json({ allPermissions: ALL_PERMISSIONS, builtinRoles: BUILTIN_ROLE_PERMISSIONS });
  });

  // A user's own resolved permission list — works identically for built-in
  // and custom roles, so the client never needs to know which kind of role
  // it's looking at, just what it's actually allowed to do.
  app.get('/api/my-permissions', requireAuth, (req, res) => {
    res.json({ role: req.user.role, permissions: getRolePermissions(req.user.role) });
  });

  app.get('/api/roles', requireAuth, (req, res) => {
    try {
      const rows = all('SELECT * FROM roles ORDER BY name ASC');
      res.json({ roles: rows.map(r => ({
        id: r.id, name: r.name, permissions: JSON.parse(r.permissions || '[]'),
        createdBy: r.created_by, createdAt: r.created_at
      })) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/roles', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'roles_manage')) return res.status(403).json({ error: 'Not authorized to manage roles' });
    try {
      const { name, permissions } = req.body || {};
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      if (trimmedName.length < 2 || trimmedName.length > 40) return res.status(400).json({ error: 'Role name must be 2-40 characters' });
      if (BUILTIN_ROLE_PERMISSIONS[trimmedName.toLowerCase()]) return res.status(400).json({ error: `"${trimmedName}" is a built-in role name and can't be reused` });
      if (roleExists(trimmedName)) return res.status(400).json({ error: 'A role with this name already exists' });
      if (!Array.isArray(permissions)) return res.status(400).json({ error: 'Permissions must be a list' });
      // Only real, recognized permission keys can ever be stored — this is
      // the actual privilege-escalation guard: even if something upstream
      // is compromised or buggy, a role can never be granted a permission
      // that doesn't exist in ALL_PERMISSIONS.
      const validPerms = permissions.filter(p => ALL_PERMISSIONS.includes(p));
      // A custom role can only ever be granted roles_manage by an existing
      // holder of roles_manage (i.e. today, only admin) — otherwise someone
      // with a lesser permission set could create a role that out-ranks
      // their own and assign themselves to it.
      if (validPerms.includes('roles_manage') && !hasPermission(req.user, 'roles_manage')) {
        return res.status(403).json({ error: 'You cannot grant a permission you do not hold yourself' });
      }

      const id = 'ROLE' + Date.now() + Math.random().toString(36).slice(2,6);
      run('INSERT INTO roles (id,name,permissions,created_by,created_at) VALUES (?,?,?,?,?)',
        [id, trimmedName, JSON.stringify(validPerms), req.user.name, new Date().toISOString()]);
      writeAuditLog('ROLE_CREATED', `${req.user.name} created role "${trimmedName}" with permissions: ${validPerms.join(', ') || '(none)'}`, req.user);
      persistDB();
      res.json({ ok: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/roles/:id', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'roles_manage')) return res.status(403).json({ error: 'Not authorized to manage roles' });
    try {
      const existing = get('SELECT * FROM roles WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Role not found' });
      const { permissions } = req.body || {};
      if (!Array.isArray(permissions)) return res.status(400).json({ error: 'Permissions must be a list' });
      const validPerms = permissions.filter(p => ALL_PERMISSIONS.includes(p));
      if (validPerms.includes('roles_manage') && !hasPermission(req.user, 'roles_manage')) {
        return res.status(403).json({ error: 'You cannot grant a permission you do not hold yourself' });
      }
      run('UPDATE roles SET permissions = ? WHERE id = ?', [JSON.stringify(validPerms), req.params.id]);
      writeAuditLog('ROLE_UPDATED', `${req.user.name} updated role "${existing.name}" \u2014 permissions now: ${validPerms.join(', ') || '(none)'}`, req.user);
      persistDB();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/roles/:id', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'roles_manage')) return res.status(403).json({ error: 'Not authorized to manage roles' });
    try {
      const existing = get('SELECT * FROM roles WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Role not found' });
      const inUse = get('SELECT COUNT(*) as c FROM users WHERE role = ?', [existing.name]);
      if (inUse && inUse.c > 0) return res.status(400).json({ error: `${inUse.c} user${inUse.c!==1?'s are':' is'} still assigned to this role \u2014 reassign them first` });
      run('DELETE FROM roles WHERE id = ?', [req.params.id]);
      writeAuditLog('ROLE_DELETED', `${req.user.name} deleted role "${existing.name}"`, req.user);
      persistDB();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
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
    if (!hasPermission(req.user, 'approvals_review_leave')) {
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
      const isStaffAction = hasPermission(req.user, 'approvals_review_leave');
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
    if (!hasPermission(req.user, 'approvals_review_leave')) {
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

  const ISO_DATE_RE_CLOCK = /^\d{4}-\d{2}-\d{2}$/;
  // Accepts HH:MM or HH:MM:SS. Employee self-service clock in/out sends
  // seconds (see the fix note below); admin-entered times via the
  // hour/minute/AM-PM dropdowns don't have a seconds control, so HH:MM
  // alone is still valid there.
  const TIME_RE_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

  // Normalizes to HH:MM:SS so computeClockHours always compares consistent
  // precision regardless of which caller supplied seconds.
  function normalizeClockTime(t) { return t.length === 5 ? t + ':00' : t; }

  // True elapsed hours between two local date+time pairs — handles same-day,
  // overnight, and (if someone forgets to clock out for a long stretch) any
  // gap at all, rather than assuming a simple "add 24h if end looks earlier"
  // shortcut. An absurd gap naturally produces an absurd hours value, which
  // validateShifts() will then correctly reject rather than silently
  // creating a bogus multi-day "shift".
  //
  // FIX: this used to compare at minute precision only. Clocking in and out
  // within the same clock minute (extremely easy to do by accident — a
  // mis-click, or someone testing the buttons) computed to exactly 0 hours,
  // which was then rejected as "clock-out must be after clock-in" — leaving
  // the person stuck with no way to clock out until the minute ticked over,
  // and stuck again if it happened again. Now compares at second precision,
  // so two genuinely distinct actions (even a few seconds apart) always
  // produce a real, positive duration.
  function computeClockHours(inDate, inTime, outDate, outTime) {
    const inMs = new Date(`${inDate}T${normalizeClockTime(inTime)}`).getTime();
    const outMs = new Date(`${outDate}T${normalizeClockTime(outTime)}`).getTime();
    return (outMs - inMs) / 3600000;
  }

  // List clock entries — admin/supervisor see everyone's, an employee sees
  // only their own (though employees normally get this via the scoped
  // /api/db/load response already; this endpoint exists for the Approvals
  // page's live view without needing a full reload).
  app.get('/api/clock-entries', requireAuth, (req, res) => {
    try {
      const isStaffAction = hasPermission(req.user, 'approvals_review_clock');
      const rows = isStaffAction
        ? all('SELECT * FROM clock_entries ORDER BY created_at DESC')
        : all('SELECT * FROM clock_entries WHERE staff_id = ? ORDER BY created_at DESC', [req.user.staffId || '__none__']);
      res.json({ clockEntries: rows.map(r => ({
        id: r.id, staffId: r.staff_id, location: r.location,
        clockInDate: r.clock_in_date, clockInTime: r.clock_in_time,
        clockOutDate: r.clock_out_date || null, clockOutTime: r.clock_out_time || null,
        status: r.status, notes: r.notes, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
        shiftId: r.shift_id || null,
        overridden: !!r.overridden, overrideReason: r.override_reason || '', overrideBy: r.override_by || ''
      })) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Deliberately its own endpoint, gated by its own permission
  // (clock_locations_view), separate from ordinary clock-entry review
  // access — someone who can approve/deny clock entries does not
  // automatically see where those clock-ins physically came from. Only
  // entries that actually captured a location (best-effort, never
  // required) appear here; there is nothing to see for anyone who didn't
  // grant their browser location access.
  app.get('/api/clock-locations', requireAuth, (req, res) => {
    if (!hasPermission(req.user, 'clock_locations_view')) {
      return res.status(403).json({ error: 'Not authorized to view clock-in/out locations' });
    }
    try {
      const rows = all(`SELECT * FROM clock_entries
                         WHERE clock_in_lat IS NOT NULL OR clock_out_lat IS NOT NULL
                         ORDER BY created_at DESC LIMIT 500`);
      res.json({ entries: rows.map(r => ({
        id: r.id, staffId: r.staff_id, location: r.location, status: r.status,
        clockInDate: r.clock_in_date, clockInTime: r.clock_in_time,
        clockOutDate: r.clock_out_date || null, clockOutTime: r.clock_out_time || null,
        clockInLat: r.clock_in_lat, clockInLng: r.clock_in_lng, clockInAccuracy: r.clock_in_accuracy,
        clockOutLat: r.clock_out_lat, clockOutLng: r.clock_out_lng, clockOutAccuracy: r.clock_out_accuracy
      })) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  function checkLocationCapacity(locationName) {
    const loc = get('SELECT max_staff FROM locations WHERE name = ?', [locationName]);
    const maxStaff = loc ? (loc.max_staff || 0) : 0;
    const occupancy = get(`SELECT COUNT(*) as c FROM clock_entries WHERE location = ? AND status = 'open'`, [locationName]).c;
    return { maxStaff, occupancy, atCapacity: maxStaff > 0 && occupancy >= maxStaff };
  }

  // Returns [lat, lng, accuracy] as numbers if the payload includes valid
  // coordinates, or [null, null, null] otherwise. Never rejects the whole
  // request over bad/missing location data — it's always optional.
  function extractGeoOrNull(body) {
    const lat = Number(body && body.lat);
    const lng = Number(body && body.lng);
    const accuracy = Number(body && body.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return [null, null, null];
    }
    return [lat, lng, Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null];
  }

  app.post('/api/clock/in', requireAuth, writeLimiter, (req, res) => {
    try {
      if (!req.user.staffId) return res.status(400).json({ error: 'No staff record linked to this account' });
      const { location, date, time } = req.body || {};
      if (!ISO_DATE_RE_CLOCK.test(date)) return res.status(400).json({ error: 'Invalid date' });
      if (!TIME_RE_CLOCK.test(time)) return res.status(400).json({ error: 'Invalid time' });
      const safeLocation = typeof location === 'string' ? location.slice(0, 100) : '';
      if (!get('SELECT id FROM locations WHERE name = ?', [safeLocation])) {
        return res.status(400).json({ error: 'Unknown location' });
      }
      const [lat, lng, accuracy] = extractGeoOrNull(req.body);

      // The staffing cap and the "no double clock-in" rule both live inside
      // the WHERE clause of the INSERT itself, not a separate check beforehand.
      // This isn't "check, then insert" — it's one atomic SQL statement, so
      // there's no gap in between for two near-simultaneous requests to both
      // slip through and over-fill the same house. This holds regardless of
      // Node's single-threaded execution model or any future refactor that
      // might add an `await` between a check and an insert — the database
      // itself is the single source of truth for whether the row goes in.
      const id = 'CE' + Date.now() + Math.random().toString(36).slice(2,6);
      const result = run(
        `INSERT INTO clock_entries (id,staff_id,location,clock_in_date,clock_in_time,status,created_at,clock_in_lat,clock_in_lng,clock_in_accuracy)
         SELECT ?,?,?,?,?,'open',?,?,?,?
         WHERE NOT EXISTS (SELECT 1 FROM clock_entries WHERE staff_id = ? AND status = 'open')
           AND (
             COALESCE((SELECT max_staff FROM locations WHERE name = ?), 0) = 0
             OR (SELECT COUNT(*) FROM clock_entries WHERE location = ? AND status = 'open')
                < (SELECT max_staff FROM locations WHERE name = ?)
           )`,
        [id, req.user.staffId, safeLocation, date, time, new Date().toISOString(), lat, lng, accuracy,
         req.user.staffId, safeLocation, safeLocation, safeLocation]
      );

      if (result.changes === 0) {
        // The atomic insert didn't happen — figure out which of the two
        // guards actually blocked it, purely to give a clear error message.
        // This read happens AFTER the fact and doesn't affect correctness;
        // the real decision was already made atomically above.
        const stillOpen = get(`SELECT id FROM clock_entries WHERE staff_id = ? AND status = 'open'`, [req.user.staffId]);
        if (stillOpen) return res.status(400).json({ error: 'Already clocked in — clock out first' });
        const capacity = checkLocationCapacity(safeLocation);
        return res.status(400).json({ error: `${safeLocation} is at its staffing limit (${capacity.occupancy}/${capacity.maxStaff}) — ask a supervisor to override if this is intentional`, atCapacity: true });
      }

      writeAuditLog('CLOCK_IN', `${req.user.name} clocked in at ${time} on ${date}${safeLocation ? ' — ' + safeLocation : ''}`, req.user);
      persistDB();
      res.json({ ok: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/clock/out', requireAuth, writeLimiter, (req, res) => {
    try {
      if (!req.user.staffId) return res.status(400).json({ error: 'No staff record linked to this account' });
      const { date, time, notes } = req.body || {};
      if (!ISO_DATE_RE_CLOCK.test(date)) return res.status(400).json({ error: 'Invalid date' });
      if (!TIME_RE_CLOCK.test(time)) return res.status(400).json({ error: 'Invalid time' });
      const safeNotes = typeof notes === 'string' ? notes.slice(0, 500) : '';

      const openEntry = get(`SELECT * FROM clock_entries WHERE staff_id = ? AND status = 'open'`, [req.user.staffId]);
      if (!openEntry) return res.status(400).json({ error: 'You are not currently clocked in' });

      const hours = computeClockHours(openEntry.clock_in_date, openEntry.clock_in_time, date, time);
      if (!Number.isFinite(hours) || hours <= 0) {
        return res.status(400).json({ error: 'Clock-out time must be after your clock-in time. If you clocked in by mistake, use "Cancel Clock-In" instead of clocking out.' });
      }
      const [lat, lng, accuracy] = extractGeoOrNull(req.body);

      run(`UPDATE clock_entries SET clock_out_date = ?, clock_out_time = ?, notes = ?, status = 'pending', clock_out_lat = ?, clock_out_lng = ?, clock_out_accuracy = ? WHERE id = ?`,
        [date, time, safeNotes, lat, lng, accuracy, openEntry.id]);
      writeAuditLog('CLOCK_OUT', `${req.user.name} clocked out at ${time} on ${date} (${hours.toFixed(2)}h) — awaiting approval`, req.user);
      persistDB();
      res.json({ ok: true, hours: Math.round(hours * 100) / 100 });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Self-service undo for a clock-in that should never have happened — only
  // while it's still open. Deletes the row entirely rather than creating a
  // 0-hour shift record, since there's genuinely nothing to review here: it
  // never should have existed in the first place. Once someone has clocked
  // out of an entry it's a real record for an admin to review/reject, not
  // something the employee can silently erase.
  app.post('/api/clock/cancel', requireAuth, writeLimiter, (req, res) => {
    try {
      if (!req.user.staffId) return res.status(400).json({ error: 'No staff record linked to this account' });
      const openEntry = get(`SELECT * FROM clock_entries WHERE staff_id = ? AND status = 'open'`, [req.user.staffId]);
      if (!openEntry) return res.status(400).json({ error: 'You are not currently clocked in' });
      run('DELETE FROM clock_entries WHERE id = ?', [openEntry.id]);
      writeAuditLog('CLOCK_IN_CANCELLED', `${req.user.name} cancelled an accidental clock-in at ${openEntry.location} (${openEntry.clock_in_time} on ${openEntry.clock_in_date})`, req.user);
      persistDB();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Rejecting a shift never deletes it — it stays fully visible to the
  // employee, with the reason, and is excluded from payroll (computeShiftsWithOT
  // filters shiftStatus !== 'active' out before any hours/pay math runs).
  // This is deliberately different from Delete, which is for a shift that
  // genuinely never should have existed at all (duplicate, wrong person).
  app.post('/api/shifts/:id/reject', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'approvals_review_shifts')) {
      return res.status(403).json({ error: 'Not authorized to reject shifts' });
    }
    try {
      const shift = get('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
      if (!shift) return res.status(404).json({ error: 'Shift not found' });
      const { reason } = req.body || {};
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (trimmedReason.length < 3) return res.status(400).json({ error: 'A reason (at least 3 characters) is required to reject a shift' });

      const staff = get('SELECT * FROM staff WHERE id = ?', [shift.staff_id]);
      run(`UPDATE shifts SET shift_status = 'rejected', rejected_reason = ?, rejected_by = ?, rejected_at = ? WHERE id = ?`,
        [trimmedReason.slice(0,500), req.user.name, new Date().toLocaleString(), req.params.id]);
      writeAuditLog('SHIFT_REJECTED', `${req.user.name} rejected a ${shift.hours}h shift for ${staff ? staff.first+' '+staff.last : shift.staff_id} on ${shift.date} \u2014 ${trimmedReason.slice(0,500)}`, req.user);
      persistDB();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/shifts/:id/restore', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'approvals_review_shifts')) {
      return res.status(403).json({ error: 'Not authorized to restore shifts' });
    }
    try {
      const shift = get('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
      if (!shift) return res.status(404).json({ error: 'Shift not found' });
      const staff = get('SELECT * FROM staff WHERE id = ?', [shift.staff_id]);
      run(`UPDATE shifts SET shift_status = 'active', rejected_reason = '', rejected_by = '', rejected_at = '' WHERE id = ?`, [req.params.id]);
      writeAuditLog('SHIFT_RESTORED', `${req.user.name} restored a previously-rejected shift for ${staff ? staff.first+' '+staff.last : shift.staff_id} on ${shift.date}`, req.user);
      persistDB();
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Live occupancy per location — how many people currently have an open
  // clock-in there right now, against each location's cap. Feeds the
  // override panel's occupancy hint on the Approvals page.
  // Any authenticated user can see this — it's aggregate counts only, never
  // staff identities, so there's no privacy concern in letting an employee
  // see "2/3 clocked in" before picking a house, the same way the admin
  // override panel already shows it.
  app.get('/api/locations/occupancy', requireAuth, (req, res) => {
    try {
      const locs = all('SELECT name, max_staff FROM locations');
      const occupancy = locs.map(l => {
        const c = checkLocationCapacity(l.name);
        return { location: l.name, maxStaff: c.maxStaff, occupancy: c.occupancy, atCapacity: c.atCapacity };
      });
      res.json({ occupancy });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Admin/supervisor clocking a staff member in directly — the one path
  // that's allowed to bypass a house's staffing cap, and only with an
  // explicit, required, audited reason. Still blocks a genuine double
  // clock-in (someone already has an open entry) — capacity override and
  // "prevent two open entries for the same person" are different concerns,
  // and this only relaxes the first one.
  app.post('/api/clock/admin-in', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'clock_override')) {
      return res.status(403).json({ error: 'Not authorized to clock someone in directly' });
    }
    try {
      const { staffId, location, date, time, reason } = req.body || {};
      if (!staffId || !get('SELECT id FROM staff WHERE id = ?', [staffId])) {
        return res.status(400).json({ error: 'Unknown staff member' });
      }
      if (!ISO_DATE_RE_CLOCK.test(date)) return res.status(400).json({ error: 'Invalid date' });
      if (!TIME_RE_CLOCK.test(time)) return res.status(400).json({ error: 'Invalid time' });
      const safeLocation = typeof location === 'string' ? location.slice(0, 100) : '';
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (trimmedReason.length < 3) return res.status(400).json({ error: 'A reason (at least 3 characters) is required to override' });

      const existingOpen = get(`SELECT id FROM clock_entries WHERE staff_id = ? AND status = 'open'`, [staffId]);
      if (existingOpen) return res.status(400).json({ error: 'This staff member is already clocked in' });

      const staff = get('SELECT * FROM staff WHERE id = ?', [staffId]);
      const id = 'CE' + Date.now() + Math.random().toString(36).slice(2,6);
      run(`INSERT INTO clock_entries (id,staff_id,location,clock_in_date,clock_in_time,status,created_at,overridden,override_reason,override_by)
           VALUES (?,?,?,?,?,'open',?,1,?,?)`,
        [id, staffId, safeLocation, date, time, new Date().toISOString(), trimmedReason.slice(0,300), req.user.name]);
      writeAuditLog('CLOCK_IN_OVERRIDE',
        `${req.user.name} clocked in ${staff.first} ${staff.last} at ${safeLocation} past capacity \u2014 reason: ${trimmedReason.slice(0,300)}`,
        req.user);
      persistDB();
      res.json({ ok: true, id });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/clock/admin-out', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'clock_override')) {
      return res.status(403).json({ error: 'Not authorized to clock someone out directly' });
    }
    try {
      const { staffId, date, time, reason } = req.body || {};
      if (!staffId || !get('SELECT id FROM staff WHERE id = ?', [staffId])) {
        return res.status(400).json({ error: 'Unknown staff member' });
      }
      if (!ISO_DATE_RE_CLOCK.test(date)) return res.status(400).json({ error: 'Invalid date' });
      if (!TIME_RE_CLOCK.test(time)) return res.status(400).json({ error: 'Invalid time' });
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (trimmedReason.length < 3) return res.status(400).json({ error: 'A reason (at least 3 characters) is required — e.g. "forgot to clock out, confirmed with employee"' });

      const openEntry = get(`SELECT * FROM clock_entries WHERE staff_id = ? AND status = 'open'`, [staffId]);
      if (!openEntry) return res.status(400).json({ error: 'This staff member is not currently clocked in' });

      const hours = computeClockHours(openEntry.clock_in_date, openEntry.clock_in_time, date, time);
      if (!Number.isFinite(hours) || hours <= 0) {
        return res.status(400).json({ error: 'Clock-out time must be after the clock-in time (' + openEntry.clock_in_date + ' ' + openEntry.clock_in_time + ')' });
      }

      const staff = get('SELECT * FROM staff WHERE id = ?', [staffId]);
      run(`UPDATE clock_entries SET clock_out_date = ?, clock_out_time = ?, status = 'pending', overridden = 1, override_reason = ?, override_by = ? WHERE id = ?`,
        [date, time, trimmedReason.slice(0,300), req.user.name, openEntry.id]);
      writeAuditLog('CLOCK_OUT_OVERRIDE',
        `${req.user.name} closed out ${staff.first} ${staff.last}'s open clock-in at ${time} on ${date} (${hours.toFixed(2)}h) \u2014 reason: ${trimmedReason.slice(0,300)}`,
        req.user);
      persistDB();
      res.json({ ok: true, hours: Math.round(hours * 100) / 100 });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/clock-entries/:id/review', requireAuth, writeLimiter, (req, res) => {
    if (!hasPermission(req.user, 'approvals_review_clock')) {
      return res.status(403).json({ error: 'Not authorized to review clock entries' });
    }
    try {
      const { action, location } = req.body || {};
      if (action !== 'approve' && action !== 'deny') return res.status(400).json({ error: 'Invalid action' });
      const entry = get('SELECT * FROM clock_entries WHERE id = ?', [req.params.id]);
      if (!entry) return res.status(404).json({ error: 'Clock entry not found' });
      if (entry.status !== 'pending') return res.status(400).json({ error: 'This entry has already been reviewed, or is still open' });

      const now = new Date().toLocaleString();
      const staff = get('SELECT * FROM staff WHERE id = ?', [entry.staff_id]);

      if (action === 'deny') {
        run(`UPDATE clock_entries SET status = 'denied', reviewed_by = ?, reviewed_at = ? WHERE id = ?`,
          [req.user.name, now, entry.id]);
        writeAuditLog('CLOCK_DENIED', `${req.user.name} denied a clock entry for ${staff ? staff.first+' '+staff.last : entry.staff_id}`, req.user);
        persistDB();
        return res.json({ ok: true });
      }

      // Approve: build a real shift and validate it exactly like any other
      // shift entry — a clock entry is just a different way of arriving at
      // the same SHIFTS row, so it gets the same scrutiny before it can
      // affect payroll.
      const finalLocation = (typeof location === 'string' && location.trim()) ? location.trim() : (entry.location || (staff ? staff.loc : ''));
      const hours = computeClockHours(entry.clock_in_date, entry.clock_in_time, entry.clock_out_date, entry.clock_out_time);
      const shiftId = 'SH' + Date.now() + Math.random().toString(36).slice(2,6);
      // Shifts always use HH:MM (no seconds) everywhere else in the app —
      // the extra precision only matters for clock_entries' own same-minute
      // validation, not for the resulting payroll record.
      const newShift = { id: shiftId, staff: entry.staff_id, date: entry.clock_in_date,
                          start: entry.clock_in_time.slice(0,5), end: entry.clock_out_time.slice(0,5),
                          location: finalLocation, hours: Math.round(hours * 100) / 100 };
      const shiftSource = entry.overridden ? 'clock_in_override' : 'clock_in';

      const staffIds = new Set(all('SELECT id FROM staff').map(s => s.id));
      const shiftError = validateShifts([newShift], staffIds);
      if (shiftError) return res.status(400).json({ error: `Cannot approve — ${shiftError}` });

      run(`INSERT INTO shifts (id,staff_id,date,time_in,time_out,loc,hours,reg_hours,ot_hours,approved,period_start,period_end,extra_data,source)
           VALUES (?,?,?,?,?,?,?,0,0,1,'','','{}',?)`,
        [newShift.id, newShift.staff, newShift.date, newShift.start, newShift.end, newShift.location, newShift.hours, shiftSource]);

      run(`UPDATE clock_entries SET status = 'approved', reviewed_by = ?, reviewed_at = ?, shift_id = ? WHERE id = ?`,
        [req.user.name, now, shiftId, entry.id]);
      writeAuditLog('CLOCK_APPROVED', `${req.user.name} approved a ${newShift.hours}h clock entry for ${staff ? staff.first+' '+staff.last : entry.staff_id} \u2014 added to timesheet`, req.user);
      persistDB();
      res.json({ ok: true, shiftId });
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

  // Walks the entire audit log hash chain and confirms every entry's stored
  // hash matches what it should be, given its content and the entry before
  // it. Any mismatch — an edited detail, a deleted entry, a reordered one —
  // is detected here, pinpointing exactly where the chain breaks, rather
  // than just trusting that append-only merging was never bypassed.
  app.get('/api/audit-log/verify', requireAuth, requireAdmin, writeLimiter, (req, res) => {
    try {
      const entries = all('SELECT id,type,detail,by,by_role AS byRole,at,ts,hash FROM audit_log ORDER BY ts ASC');
      let prevHash = AUDIT_CHAIN_GENESIS;
      let brokenAt = null;
      for (const e of entries) {
        const expectedHash = computeEntryHash(prevHash, e);
        if (expectedHash !== e.hash) { brokenAt = e; break; }
        prevHash = e.hash;
      }
      res.json({
        ok: true,
        totalEntries: entries.length,
        intact: brokenAt === null,
        brokenAt: brokenAt ? { id: brokenAt.id, type: brokenAt.type, at: brokenAt.at } : null
      });
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
