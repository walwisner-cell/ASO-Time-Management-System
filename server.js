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

// ── Configuration ──────────────────────────────────────────
const PORT      = process.env.PORT || 8420;
const HOST      = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const IS_PROD   = !!process.env.PORT; // Render (and most hosts) set PORT for us
// On Render, set DB_DIR to a mounted persistent disk path (e.g. /var/data)
// via an environment variable, otherwise falls back to local behavior.
const DB_DIR    = process.env.DB_DIR || path.join(os.homedir(), 'ASO_OT_Data');
const DB_PATH   = path.join(DB_DIR, 'aso_ot.db');
const HTML_FILE = path.join(__dirname, 'ASO_OT_SYSTEM_SQL.html');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_COOKIE = 'aso_session';

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

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
    password TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer'
  )`);
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
    start TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active'
  )`);
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
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT DEFAULT '',
    user_id TEXT DEFAULT '', created_at TEXT NOT NULL
  )`);
}

function loadDB() {
  const pcRow = get('SELECT * FROM pay_config WHERE id=1');
  const PAY_CONFIG = pcRow
    ? { anchorDate: pcRow.anchor_date, periodDays: pcRow.period_days, otThreshold: pcRow.ot_threshold,
        defaultDeductions: JSON.parse(pcRow.default_deductions || '[]') }
    : DEFAULT_SEED.PAY_CONFIG;

  // Password hashes never leave the server — the client has no legitimate use for them.
  const USERS     = all('SELECT id,username,name,role FROM users');
  const LOCATIONS = all('SELECT * FROM locations').map(r => ({
    id: r.id, name: r.name, rate: r.rate, mult: r.mult, notes: r.notes,
    rateHistory: JSON.parse(r.rate_history || '[]')
  }));
  const STAFF = all('SELECT * FROM staff').map(r => ({
    id: r.id, first: r.first, last: r.last, title: r.title,
    type: r.type, loc: r.loc, rate: r.rate, start: r.start, status: r.status
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
  const AUDIT_LOG = all('SELECT id,action,detail,user_id,created_at FROM audit_log')
    .map(r => ({ id: r.id, action: r.action, detail: r.detail, userId: r.user_id, ts: r.created_at }));

  return { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
           PENDING_APPROVALS, APPROVED_EXCEPTIONS,
           DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG, PAYROLL_RECORDS };
}

function saveDB(data) {
  const { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
          PENDING_APPROVALS, APPROVED_EXCEPTIONS,
          DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG, PAYROLL_RECORDS } = data;

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
    run('INSERT INTO users (id,username,password,name,role) VALUES (?,?,?,?,?)',
        [u.id, u.username, pw, u.name, u.role]);
  }

  // LOCATIONS
  run('DELETE FROM locations');
  for (const l of (LOCATIONS || []))
    run('INSERT INTO locations (id,name,rate,mult,notes,rate_history) VALUES (?,?,?,?,?,?)',
        [l.id, l.name, l.rate, l.mult, l.notes||'', JSON.stringify(l.rateHistory||[])]);

  // STAFF
  run('DELETE FROM staff');
  for (const s of (STAFF || []))
    run('INSERT INTO staff (id,first,last,title,type,loc,rate,start,status) VALUES (?,?,?,?,?,?,?,?,?)',
        [s.id, s.first, s.last, s.title||'DSP', s.type||'Full-Time', s.loc||'', s.rate, s.start, s.status||'Active']);

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
    run('INSERT INTO audit_log (id,action,detail,user_id,created_at) VALUES (?,?,?,?,?)',
        [r.id||('AL'+Date.now()+Math.random()), r.action||'', r.detail||'', r.userId||r.user_id||'', r.ts||r.created_at||new Date().toISOString()]);

  persistDB();
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
  const user = get('SELECT id,username,name,role FROM users WHERE id = ?', [session.user_id]);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  req.user = user;
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

function authorizeSave(existing, incoming, user) {
  const isAdmin = user.role === 'admin';
  const canShift = user.role === 'admin' || user.role === 'supervisor';

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

  // ── Express App ──────────────────────────────────────────
  const app = express();
  app.set('trust proxy', 1); // Render sits behind a proxy — needed for correct secure-cookie/IP detection
  app.use(helmet({ contentSecurityPolicy: false })); // CSP off: this app is one big self-contained HTML file with inline scripts
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts — please wait a few minutes and try again' }
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
      res.json({ ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
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
  app.post('/api/users/:id/password', requireAuth, (req, res) => {
    try {
      const targetId = req.params.id;
      const { password } = req.body || {};
      if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
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
    try { res.json(loadDB()); }
    catch(e) { console.error('Load error:', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/db/save', requireAuth, (req, res) => {
    try {
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
      res.setHeader('Content-Disposition', `attachment; filename="ASO_backup_${new Date().toISOString().split('T')[0]}.json"`);
      res.json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/db/import', requireAuth, requireAdmin, (req, res) => {
    try {
      const data = req.body;
      if (!data.SHIFTS || !data.STAFF) return res.status(400).json({ error: 'Invalid backup' });
      saveDB(data);
      res.json({ ok: true, shifts: data.SHIFTS.length, staff: data.STAFF.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

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
