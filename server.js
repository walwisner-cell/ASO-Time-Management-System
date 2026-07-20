/**
 * ASO Staff Overtime Management System — SQLite Backend
 * Node.js + Express + sql.js (no compilation required)
 *
 * Serves the app at http://localhost:8420
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

// ── Configuration ──────────────────────────────────────────
const PORT      = process.env.PORT || 8420;
const HOST      = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
// On Render, set DB_DIR to a mounted persistent disk path (e.g. /var/data)
// via an environment variable, otherwise falls back to local behavior.
const DB_DIR    = process.env.DB_DIR || path.join(os.homedir(), 'ASO_OT_Data');
const DB_PATH   = path.join(DB_DIR, 'aso_ot.db');
const HTML_FILE = path.join(__dirname, 'ASO_OT_SYSTEM_SQL.html');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// ── Load sql.js ────────────────────────────────────────────
const initSqlJs = require('sql.js');

let db; // will be set after async init

// ── Default seed data ──────────────────────────────────────
const DEFAULT_SEED = {
  PAY_CONFIG: { anchorDate: '2026-05-09', periodDays: 14, otThreshold: 80 },
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
  DATE_CORRECTION_LOG: [], DELETION_LOG: [], AUDIT_LOG: []
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
    ot_threshold INTEGER NOT NULL DEFAULT 80
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer'
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
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT DEFAULT '',
    user_id TEXT DEFAULT '', created_at TEXT NOT NULL
  )`);
}

function loadDB() {
  const pcRow = get('SELECT * FROM pay_config WHERE id=1');
  const PAY_CONFIG = pcRow
    ? { anchorDate: pcRow.anchor_date, periodDays: pcRow.period_days, otThreshold: pcRow.ot_threshold }
    : DEFAULT_SEED.PAY_CONFIG;

  const USERS     = all('SELECT id,username,password,name,role FROM users');
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
  const AUDIT_LOG = all('SELECT id,action,detail,user_id,created_at FROM audit_log')
    .map(r => ({ id: r.id, action: r.action, detail: r.detail, userId: r.user_id, ts: r.created_at }));

  return { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
           PENDING_APPROVALS, APPROVED_EXCEPTIONS,
           DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG };
}

function saveDB(data) {
  const { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
          PENDING_APPROVALS, APPROVED_EXCEPTIONS,
          DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG } = data;

  // PAY_CONFIG
  run(`INSERT INTO pay_config (id,anchor_date,period_days,ot_threshold) VALUES (1,?,?,?)
       ON CONFLICT(id) DO UPDATE SET anchor_date=excluded.anchor_date,
       period_days=excluded.period_days, ot_threshold=excluded.ot_threshold`,
    [PAY_CONFIG.anchorDate, PAY_CONFIG.periodDays, PAY_CONFIG.otThreshold]);

  // USERS
  run('DELETE FROM users');
  for (const u of (USERS || []))
    run('INSERT OR REPLACE INTO users (id,username,password,name,role) VALUES (?,?,?,?,?)',
        [u.id, u.username, u.password, u.name, u.role]);

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

  run('DELETE FROM audit_log');
  for (const r of (AUDIT_LOG||[]))
    run('INSERT INTO audit_log (id,action,detail,user_id,created_at) VALUES (?,?,?,?,?)',
        [r.id||('AL'+Date.now()+Math.random()), r.action||'', r.detail||'', r.userId||r.user_id||'', r.ts||r.created_at||new Date().toISOString()]);

  persistDB();
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

  // ── Express App ──────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/', (req, res) => {
    if (fs.existsSync(HTML_FILE)) {
      res.sendFile(HTML_FILE);
    } else {
      res.status(404).send(`
        <h2>ASO OT System — Setup Required</h2>
        <p>Place <code>ASO_OT_SYSTEM_SQL.html</code> in the same folder as server.js.</p>
        <p>Expected path: <code>${HTML_FILE}</code></p>
      `);
    }
  });

  app.get('/api/db/load', (req, res) => {
    try { res.json(loadDB()); }
    catch(e) { console.error('Load error:', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/db/save', (req, res) => {
    try { saveDB(req.body); res.json({ ok: true, ts: new Date().toISOString() }); }
    catch(e) { console.error('Save error:', e); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/db/reset', (req, res) => {
    try {
      const tables = ['pay_config','users','locations','staff','shifts',
                      'pending_approvals','approved_exceptions',
                      'date_correction_log','deletion_log','audit_log'];
      for (const t of tables) run(`DELETE FROM ${t}`);
      saveDB(DEFAULT_SEED);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/db/export', (req, res) => {
    try {
      const data = { ...loadDB(), exportedAt: new Date().toISOString(), version: 9 };
      res.setHeader('Content-Disposition', `attachment; filename="ASO_backup_${new Date().toISOString().split('T')[0]}.json"`);
      res.json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/db/import', (req, res) => {
    try {
      const data = req.body;
      if (!data.SHIFTS || !data.STAFF) return res.status(400).json({ error: 'Invalid backup' });
      saveDB(data);
      res.json({ ok: true, shifts: data.SHIFTS.length, staff: data.STAFF.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, db: DB_PATH }));

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
