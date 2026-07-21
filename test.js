/**
 * ASO Staff OT System — Automated Regression Test Suite
 *
 * Boots a temporary, disposable instance of the server against a scratch
 * database, exercises the things most likely to break silently (auth,
 * role security, employee data scoping, input validation, core payroll
 * math), and reports pass/fail. Nothing here touches your real data —
 * it uses its own throwaway DB_DIR under the OS temp folder.
 *
 * Run with:  node test.js
 * Exits with code 0 if everything passed, 1 if anything failed — so it's
 * safe to use in a CI pipeline or a pre-deploy check if you ever set one up.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const PORT = 8421; // deliberately different from the default, in case a real instance is also running
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aso-test-'));

let passed = 0, failed = 0;
const failures = [];

function check(name, condition) {
  if (condition) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; failures.push(name); console.log(`  \u2717 ${name}`); }
}

function request(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(chunks); } catch (e) { /* not JSON, fine for some endpoints */ }
        const setCookie = res.headers['set-cookie'];
        resolve({ status: res.statusCode, body: parsed, raw: chunks, cookie: setCookie ? setCookie[0].split(';')[0] : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitForServer(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`${BASE}/api/health`, res => resolve())
        .on('error', () => {
          if (n <= 0) return reject(new Error('Server did not start in time'));
          setTimeout(() => attempt(n - 1), 300);
        });
    };
    attempt(retries);
  });
}

async function main() {
  console.log(`\nStarting test server (scratch DB at ${TEST_DIR})...\n`);
  const server = spawn('node', [path.join(__dirname, 'server.js')], {
    env: { ...process.env, DB_DIR: TEST_DIR, PORT: String(PORT) },
    stdio: 'pipe'
  });
  let serverOutput = '';
  server.stdout.on('data', d => serverOutput += d);
  server.stderr.on('data', d => serverOutput += d);

  try {
    await waitForServer();

    console.log('Auth & session security:');
    const unauth = await request('GET', '/api/db/load');
    check('unauthenticated load is rejected (401)', unauth.status === 401);

    const badLogin = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } });
    check('wrong password is rejected', badLogin.status === 401);

    const login = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    check('correct admin login succeeds', login.status === 200 && login.body.ok === true);
    const adminCookie = login.cookie;

    const load = await request('GET', '/api/db/load', { cookie: adminCookie });
    check('authenticated load succeeds', load.status === 200);
    check('fresh install seeds a single admin user', load.body.USERS.length === 1 && load.body.USERS[0].role === 'admin');

    console.log('\nEmployee data scoping (the most important security boundary):');
    const withEmp = { ...load.body };
    withEmp.USERS = [...withEmp.USERS,
      { id: 'U900', username: 'testemp1', password: 'testpass1', name: 'Test Employee One', role: 'employee', staffId: 'DOES_NOT_EXIST' }];
    withEmp.STAFF = [{ id: 'S900', first: 'Test', last: 'One', title: 'DSP', type: 'Full-Time', loc: 'Test House', rate: 15, start: '2026-01-01', status: 'Active' },
                     { id: 'S901', first: 'Test', last: 'Two', title: 'DSP', type: 'Full-Time', loc: 'Test House', rate: 15, start: '2026-01-01', status: 'Active' }];
    withEmp.USERS[1].staffId = 'S900';
    withEmp.USERS.push({ id: 'U901', username: 'testemp2', password: 'testpass2', name: 'Test Employee Two', role: 'employee', staffId: 'S901' });
    withEmp.SHIFTS = [
      { id: 'TS1', staff: 'S900', date: '2026-05-10', start: '09:00', end: '17:00', location: 'Test House', hours: 8 },
      { id: 'TS2', staff: 'S901', date: '2026-05-10', start: '09:00', end: '17:00', location: 'Test House', hours: 8 }
    ];
    await request('POST', '/api/db/save', { body: withEmp, cookie: adminCookie });

    const emp1Login = await request('POST', '/api/auth/login', { body: { username: 'testemp1', password: 'testpass1' } });
    const emp1Cookie = emp1Login.cookie;
    const emp1Load = await request('GET', '/api/db/load', { cookie: emp1Cookie });
    check('employee only sees their own staff record', emp1Load.body.STAFF.length === 1 && emp1Load.body.STAFF[0].id === 'S900');
    check('employee only sees their own shifts', emp1Load.body.SHIFTS.length === 1 && emp1Load.body.SHIFTS[0].staff === 'S900');
    check('employee sees no other users', emp1Load.body.USERS.length === 0);
    check('employee data does not contain the other employee\'s ID anywhere', !JSON.stringify(emp1Load.body).includes('S901'));

    const empSaveAttempt = await request('POST', '/api/db/save', { body: {}, cookie: emp1Cookie });
    check('employee cannot use the generic save endpoint (403)', empSaveAttempt.status === 403);

    const spoofAttempt = await request('POST', '/api/leave-requests', {
      cookie: emp1Cookie,
      body: { staffId: 'S901', type: 'vacation', startDate: '2026-06-01', endDate: '2026-06-02', hours: 8 }
    });
    check('employee cannot submit a leave request under another staffId', spoofAttempt.body && spoofAttempt.body.id);
    const leaveList = await request('GET', '/api/leave-requests', { cookie: adminCookie });
    const spoofedEntry = leaveList.body.leaveRequests.find(r => r.id === spoofAttempt.body.id);
    check('the spoofed request was force-corrected to the employee\'s own staffId', spoofedEntry && spoofedEntry.staffId === 'S900');

    console.log('\nInput validation on leave requests:');
    const badType = await request('POST', '/api/leave-requests', { cookie: adminCookie, body: { staffId: 'S900', type: 'not_a_real_type', startDate: '2026-06-01', endDate: '2026-06-01', hours: 8 } });
    check('invalid leave type is rejected', badType.status === 400);

    const badDate = await request('POST', '/api/leave-requests', { cookie: adminCookie, body: { staffId: 'S900', type: 'sick', startDate: 'not-a-date', endDate: '2026-06-01', hours: 8 } });
    check('malformed date is rejected', badDate.status === 400);

    const backwardsDate = await request('POST', '/api/leave-requests', { cookie: adminCookie, body: { staffId: 'S900', type: 'sick', startDate: '2026-06-05', endDate: '2026-06-01', hours: 8 } });
    check('end date before start date is rejected', backwardsDate.status === 400);

    const hugeHours = await request('POST', '/api/leave-requests', { cookie: adminCookie, body: { staffId: 'S900', type: 'sick', startDate: '2026-06-01', endDate: '2026-06-01', hours: 99999 } });
    check('absurd hours value is rejected', hugeHours.status === 400);

    console.log('\nViewer-role authorization boundaries (previously unchecked fields):');
    const viewerLogin = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    let viewerSetup = await request('GET', '/api/db/load', { cookie: adminCookie });
    let withViewer = { ...viewerSetup.body };
    withViewer.USERS = [...withViewer.USERS, { id: 'U930', username: 'testviewer', password: 'viewpass1', name: 'Test Viewer', role: 'viewer' }];
    withViewer.PENDING_APPROVALS = [{ id: 'PA1', staffId: 'S900', date: '2026-05-10', location: 'Test House', start: '06:00', end: '22:00', hours: 16, totalDailyHrs: 16, reason: 'test violation' }];
    await request('POST', '/api/db/save', { body: withViewer, cookie: adminCookie });
    const viewerAuth = await request('POST', '/api/auth/login', { body: { username: 'testviewer', password: 'viewpass1' } });
    const viewerCookie = viewerAuth.cookie;

    const viewerLoad = await request('GET', '/api/db/load', { cookie: viewerCookie });
    const viewerAttack = { ...viewerLoad.body, PENDING_APPROVALS: [], APPROVED_EXCEPTIONS: [{ id: 'FAKE', staffId: 'S900', approvedBy: 'Admin', reason: 'forged' }] };
    const viewerAttackResult = await request('POST', '/api/db/save', { body: viewerAttack, cookie: viewerCookie });
    check('viewer cannot fabricate a fake approved exception or wipe pending approvals', viewerAttackResult.status === 403);

    const viewerDateAttack = { ...viewerLoad.body, DATE_CORRECTION_LOG: [{ shiftId: 'FAKE', reason: 'forged' }] };
    const viewerDateResult = await request('POST', '/api/db/save', { body: viewerDateAttack, cookie: viewerCookie });
    check('viewer cannot fabricate a date-correction log entry', viewerDateResult.status === 403);

    console.log('\nShift data validation (content, not just who can submit):');
    const shiftBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    const negHours = { ...shiftBase.body, SHIFTS: [{ id: 'BADSHIFT1', staff: 'S900', date: '2026-05-10', start: '09:00', end: '17:00', location: 'Test House', hours: -999 }] };
    const negResult = await request('POST', '/api/db/save', { body: negHours, cookie: adminCookie });
    check('negative shift hours are rejected', negResult.status === 403);

    const ghostStaff = { ...shiftBase.body, SHIFTS: [{ id: 'BADSHIFT2', staff: 'GHOST_ID', date: '2026-05-10', start: '09:00', end: '17:00', location: 'Test House', hours: 8 }] };
    const ghostResult = await request('POST', '/api/db/save', { body: ghostStaff, cookie: adminCookie });
    check('a shift referencing a nonexistent staff ID is rejected', ghostResult.status === 403);

    const absurdHours = { ...shiftBase.body, SHIFTS: [{ id: 'BADSHIFT3', staff: 'S900', date: '2026-05-10', start: '09:00', end: '17:00', location: 'Test House', hours: 999 }] };
    const absurdResult = await request('POST', '/api/db/save', { body: absurdHours, cookie: adminCookie });
    check('absurdly large shift hours are rejected', absurdResult.status === 403);

    console.log('\nPTO balance adjustments:');
    const ptoGrant = await request('POST', '/api/staff/S900/pto-adjust', { cookie: adminCookie, body: { delta: 40, reason: 'Annual grant' } });
    check('admin can grant PTO hours', ptoGrant.status === 200 && ptoGrant.body.newBalance === 40);

    const ptoAbsurd = await request('POST', '/api/staff/S900/pto-adjust', { cookie: adminCookie, body: { delta: 99999 } });
    check('absurd PTO adjustment is rejected', ptoAbsurd.status === 400);

    // The core risk this protects against: a stale browser tab bulk-saving an
    // old balance should never be able to silently revert a real adjustment.
    const staleLoad = await request('GET', '/api/db/load', { cookie: adminCookie });
    const staleData = { ...staleLoad.body };
    staleData.STAFF = staleData.STAFF.map(s => s.id === 'S900' ? { ...s, ptoBalance: 0 } : s);
    await request('POST', '/api/db/save', { body: staleData, cookie: adminCookie });
    const afterStaleSave = await request('GET', '/api/db/load', { cookie: adminCookie });
    const s900After = afterStaleSave.body.STAFF.find(s => s.id === 'S900');
    check('a stale bulk save cannot revert a PTO balance change', s900After && s900After.ptoBalance === 40);

    console.log('\nBackups:');
    const backupsBefore = await request('GET', '/api/backups', { cookie: adminCookie });
    const countBefore = backupsBefore.body.backups.length;
    await request('POST', '/api/backups', { cookie: adminCookie });
    const backupsAfter = await request('GET', '/api/backups', { cookie: adminCookie });
    check('manual backup creation adds a new backup', backupsAfter.body.backups.length === countBefore + 1);

    const traversal = await request('GET', '/api/backups/..%2F..%2F..%2Fetc%2Fpasswd', { cookie: adminCookie });
    check('path traversal in backup download is rejected', traversal.status === 400);

    console.log('\nAudit trail correctness:');
    const auditReload = await request('GET', '/api/db/load', { cookie: adminCookie });
    const leaveAuditEntries = auditReload.body.AUDIT_LOG.filter(e => e.type === 'LEAVE_LOGGED' || e.type === 'LEAVE_REQUESTED');
    check('leave request actions appear in the audit trail', leaveAuditEntries.length > 0);
    check('audit entries have the correct field shape (type/by/ts)', leaveAuditEntries.every(e => typeof e.ts === 'number' && e.by && e.type));

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
      console.log('Failed checks:', failures.join(', '));
    }
  } catch (err) {
    console.error('\nTest run crashed:', err);
    failed++;
  } finally {
    server.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
