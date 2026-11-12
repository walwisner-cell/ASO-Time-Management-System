/**
 * Timesheet-entry-only accounts: a custom role with `timesheet_scoped` can enter
 * time only for the houses / staff assigned to that user. Run: node test-entry-scope.js
 */
const { spawn } = require('child_process');
const path = require('path'), os = require('os'), fs = require('fs'), http = require('http');
const PORT = 8423, BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aso-scope-'));
let passed = 0, failed = 0;
const check = (n, c) => { if (c) { passed++; console.log('  \u2713 ' + n); } else { failed++; console.log('  \u2717 ' + n); } };
function request(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let c = ''; res.on('data', d => c += d);
      res.on('end', () => { let b = null; try { b = JSON.parse(c); } catch (e) {} const sc = res.headers['set-cookie']; resolve({ status: res.statusCode, body: b, cookie: sc ? sc[0].split(';')[0] : null }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const wait = (n = 30) => new Promise((res, rej) => { const t = k => http.get(`${BASE}/api/health`, () => res()).on('error', () => k <= 0 ? rej(new Error('no server')) : setTimeout(() => t(k - 1), 300)); t(n); });
const shift = (id, staff, location, date = '2026-05-12') => ({ id, staff, date, start: '06:00', end: '14:00', location, hours: 8, source: 'manual' });

(async () => {
  const server = spawn('node', [path.join(__dirname, 'server.js')], { env: { ...process.env, DB_DIR: TEST_DIR, PORT: String(PORT), NODE_ENV: 'test', SEED_ADMIN_PASSWORD: 'admin123' }, stdio: 'pipe' });
  try {
    await wait();
    const admin = (await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } })).cookie;
    const mk = (id, first, loc) => ({ id, first, last: 'T', title: 'DSP', type: 'Full-Time', loc, rate: 20, start: '2026-01-01', status: 'Active' });
    const loc = (id, name) => ({ id, name, rate: 20, mult: 1.5, notes: '', rateHistory: [], maxStaff: 0 });

    console.log('Role setup:');
    let db = (await request('GET', '/api/db/load', { cookie: admin })).body;
    db.LOCATIONS = [loc('L1', 'House A'), loc('L2', 'House B'), loc('L3', 'House C')];
    db.STAFF = [mk('S1', 'Ann', 'House A'), mk('S2', 'Bob', 'House B'), mk('S3', 'Cy', 'House C'), mk('S4', 'Di', 'House A')];
    db.SHIFTS = [shift('X1', 'S1', 'House A'), shift('X2', 'S2', 'House B'), shift('X3', 'S3', 'House C')];
    db.USERS = [...db.USERS, { id: 'U10', username: 'mgr', password: 'managerpass1', name: 'Mgr', role: 'Entry Clerk' }];
    // role must exist before the user is saved
    const mixed = await request('POST', '/api/roles', { cookie: admin, body: { name: 'Entry Clerk', permissions: ['timesheet_scoped', 'payroll_run', 'staff_manage', 'shifts_delete'] } });
    check('role created', mixed.status === 200);
    const roles = (await request('GET', '/api/roles', { cookie: admin })).body.roles;
    const perms = roles.find(r => r.name === 'Entry Clerk').permissions;
    check('scoped role cannot be mixed with other powers (only delete is kept)', JSON.stringify(perms.sort()) === JSON.stringify(['shifts_delete', 'timesheet_scoped']));
    check('admin save with new data ok', (await request('POST', '/api/db/save', { cookie: admin, body: db })).status === 200);

    const adminPerms = (await request('GET', '/api/my-permissions', { cookie: admin })).body.permissions;
    check('admin is never subject to the scoped restriction', !adminPerms.includes('timesheet_scoped') && adminPerms.includes('payroll_run'));

    const mgr = (await request('POST', '/api/auth/login', { body: { username: 'mgr', password: 'managerpass1' } })).cookie;
    let l = (await request('GET', '/api/db/load', { cookie: mgr })).body;
    check('with no scope assigned the user sees nothing', l.STAFF.length === 0 && l.SHIFTS.length === 0);

    console.log('\nAssigning scope (House A + individual Cy):');
    check('non-admin cannot set scope', (await request('PUT', '/api/users/U10/entry-scope', { cookie: mgr, body: { locations: ['House B'], staff: [] } })).status === 403);
    const set = await request('PUT', '/api/users/U10/entry-scope', { cookie: admin, body: { locations: ['House A'], staff: ['S3'], staffId: null } });
    check('admin sets scope', set.status === 200);
    l = (await request('GET', '/api/db/load', { cookie: mgr })).body;
    const ids = l.STAFF.map(s => s.id).sort();
    check('sees only House A staff + Cy', JSON.stringify(ids) === JSON.stringify(['S1', 'S3', 'S4']));
    check('does not see Bob or his shift', !JSON.stringify(l).includes('S2') && !JSON.stringify(l).includes('"X2"'));
    check('pay rates are stripped', l.STAFF.every(s => s.rate === 0) && l.LOCATIONS.every(x => x.rate === 0));
    check('no users / payroll / audit leaked', l.USERS.length === 0 && l.PAYROLL_RECORDS.length === 0 && l.AUDIT_LOG.length === 0);
    check('other endpoints are closed (export / backups / payroll)',
      (await request('GET', '/api/db/export', { cookie: mgr })).status === 403 &&
      (await request('GET', '/api/external-payroll', { cookie: mgr })).status === 403);

    console.log('\nEntering time:');
    const save = async (shifts, extra = {}) => request('POST', '/api/db/save', { cookie: mgr, body: { ...l, SHIFTS: shifts, ...extra } });
    const reload = async () => { l = (await request('GET', '/api/db/load', { cookie: mgr })).body; };
    let r = await save([...l.SHIFTS, shift('N1', 'S1', 'House A')]);
    check('can add a shift for House A staff at House A', r.status === 200);
    await reload();
    r = await save([...l.SHIFTS, shift('N2', 'S2', 'House B')]);
    check('cannot add a shift for staff outside scope (Bob)', r.status === 403);
    r = await save([...l.SHIFTS, shift('N3', 'S1', 'House B')]);
    check('cannot enter House A staff at a house outside scope', r.status === 403);
    r = await save([...l.SHIFTS, shift('N4', 'S3', 'House B')]);
    check('individually granted staff (Cy) can be entered at any house', r.status === 200);
    await reload();
    r = await save([...l.SHIFTS, shift('X2', 'S1', 'House A')]);
    check('cannot overwrite another house\'s shift by reusing its id', r.status === 403);

    const adminLoad = (await request('GET', '/api/db/load', { cookie: admin })).body;
    check('Bob\'s shift and all other data untouched after scoped saves',
      adminLoad.SHIFTS.some(s => s.id === 'X2' && s.staff === 'S2') && adminLoad.STAFF.length === 4 && adminLoad.LOCATIONS.length === 3 && adminLoad.STAFF.find(s => s.id === 'S2').rate === 20);
    check('both permitted shifts were stored', adminLoad.SHIFTS.some(s => s.id === 'N1') && adminLoad.SHIFTS.some(s => s.id === 'N4'));

    await reload();
    check('scoped user sees the shifts they added', l.SHIFTS.some(s => s.id === 'N1') && l.SHIFTS.some(s => s.id === 'N4'));
    const edited = l.SHIFTS.map(s => s.id === 'N1' ? { ...s, end: '15:00', hours: 9 } : s);
    check('can edit an in-scope shift', (await save(edited)).status === 200);
    await reload();
    check('the edit was stored', l.SHIFTS.find(s => s.id === 'N1').hours === 9);
    check('cannot move an in-scope shift to staff outside scope', (await save(l.SHIFTS.map(s => s.id === 'N1' ? { ...s, staff: 'S2' } : s))).status === 403);
    check('can delete in scope only because role has shifts_delete', (await save(l.SHIFTS.filter(s => s.id !== 'N4'))).status === 200);
    check('cannot delete an out-of-scope shift (by never having seen it, it must stay)',
      (await request('GET', '/api/db/load', { cookie: admin })).body.SHIFTS.some(s => s.id === 'X2'));

    console.log('\nApprovals & locks:');
    r = await save(l.SHIFTS, { APPROVED_EXCEPTIONS: [{ shiftId: 'N1', staffId: 'S1', date: '2026-05-12', reason: 'self approve' }] });
    check('cannot self-approve a 24-hour exception', r.status === 403);
    r = await save(l.SHIFTS, { PENDING_APPROVALS: [{ id: 'P1', staffId: 'S1', date: '2026-05-12', reason: 'needs ok' }] });
    check('can submit a pending approval for in-scope staff', r.status === 200);
    r = await save(l.SHIFTS, { PENDING_APPROVALS: [] });
    check('cannot erase a pending approval', (await request('GET', '/api/db/load', { cookie: admin })).body.PENDING_APPROVALS.some(p => p.id === 'P1'));

    console.log('\nBuilt-in role untouched:');
    check('admin can still save everything', (await request('POST', '/api/db/save', { cookie: admin, body: (await request('GET', '/api/db/load', { cookie: admin })).body })).status === 200);
    const adm = (await request('GET', '/api/db/load', { cookie: admin })).body;
    check('admin save keeps the user\'s scope', adm.USERS.find(u => u.id === 'U10').entryScope.locations[0] === 'House A');
  } catch (e) { failed++; console.log('ERROR', e); }
  server.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
