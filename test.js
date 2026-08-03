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
    env: { ...process.env, DB_DIR: TEST_DIR, PORT: String(PORT), NODE_ENV: 'test' },
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

    console.log('\nAudit log integrity (hash chain):');
    const verifyBefore = await request('GET', '/api/audit-log/verify', { cookie: adminCookie });
    check('chain reports intact after normal use', verifyBefore.status === 200 && verifyBefore.body.intact === true);

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

    console.log('\nRole existence validation (catches a typo before it locks someone out):');
    const roleTypoBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    const roleTypoSetup = { ...roleTypoBase.body };
    roleTypoSetup.USERS = [...roleTypoSetup.USERS, { id: 'UTYPO', username: 'typouser', password: 'typopass1', name: 'Typo User', role: 'adnim' }];
    const typoResult = await request('POST', '/api/db/save', { body: roleTypoSetup, cookie: adminCookie });
    check('assigning a nonexistent role name is rejected', typoResult.status === 403);

    console.log('\nMax Staff / Shift validation:');
    const maxStaffBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    async function tryMaxStaff(value) {
      const body = { ...maxStaffBase.body };
      body.LOCATIONS = body.LOCATIONS.map((l, i) => i === 0 ? { ...l, maxStaff: value } : l);
      return request('POST', '/api/db/save', { body, cookie: adminCookie });
    }
    check('negative maxStaff is rejected', (await tryMaxStaff(-5)).status === 403);
    check('decimal maxStaff is rejected', (await tryMaxStaff(2.5)).status === 403);
    check('absurdly large maxStaff is rejected', (await tryMaxStaff(999999999)).status === 403);
    check('valid maxStaff is accepted', (await tryMaxStaff(3)).status === 200);
    check('zero (no limit) is accepted', (await tryMaxStaff(0)).status === 200);

    console.log('\nPer-house staffing caps and supervisor override:');
    const capBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    const capSetup = { ...capBase.body };
    capSetup.LOCATIONS = [...capSetup.LOCATIONS, { id: 'L90', name: 'Cap Test House', rate: 12, mult: 1.5, notes: '', rateHistory: [], maxStaff: 1 }];
    capSetup.STAFF = [...capSetup.STAFF,
      { id: 'S920', first: 'Cap', last: 'One', title: 'DSP', type: 'Full-Time', loc: 'Cap Test House', rate: 12, start: '2026-01-01', status: 'Active' },
      { id: 'S921', first: 'Cap', last: 'Two', title: 'DSP', type: 'Full-Time', loc: 'Cap Test House', rate: 12, start: '2026-01-01', status: 'Active' }];
    capSetup.USERS = [...capSetup.USERS,
      { id: 'U920', username: 'capworker1', password: 'cappass1', name: 'Cap One', role: 'employee', staffId: 'S920' },
      { id: 'U921', username: 'capworker2', password: 'cappass2', name: 'Cap Two', role: 'employee', staffId: 'S921' }];
    await request('POST', '/api/db/save', { body: capSetup, cookie: adminCookie });

    const cap1Login = await request('POST', '/api/auth/login', { body: { username: 'capworker1', password: 'cappass1' } });
    const cap1Cookie = cap1Login.cookie;
    const cap2Login = await request('POST', '/api/auth/login', { body: { username: 'capworker2', password: 'cappass2' } });
    const cap2Cookie = cap2Login.cookie;

    const firstIn = await request('POST', '/api/clock/in', { cookie: cap1Cookie, body: { location: 'Cap Test House', date: '2026-05-10', time: '08:00', lat: 39.95, lng: -75.16, accuracy: 10 } });
    check('first clock-in at a 1-person house succeeds', firstIn.status === 200);

    const secondIn = await request('POST', '/api/clock/in', { cookie: cap2Cookie, body: { location: 'Cap Test House', date: '2026-05-10', time: '08:05', lat: 39.95, lng: -75.16, accuracy: 10 } });
    check('second clock-in at the same house is blocked at capacity', secondIn.status === 400 && secondIn.body.atCapacity === true);

    const overrideNoAuth = await request('POST', '/api/clock/admin-in', { cookie: cap2Cookie, body: { staffId: 'S921', location: 'Cap Test House', date: '2026-05-10', time: '08:05', reason: 'test' } });
    check('non-admin cannot use the override endpoint', overrideNoAuth.status === 403);

    const overrideNoReason = await request('POST', '/api/clock/admin-in', { cookie: adminCookie, body: { staffId: 'S921', location: 'Cap Test House', date: '2026-05-10', time: '08:05', reason: '' } });
    check('override without a reason is rejected', overrideNoReason.status === 400);

    const overrideBadStaff = await request('POST', '/api/clock/admin-in', { cookie: adminCookie, body: { staffId: 'GHOST', location: 'Cap Test House', date: '2026-05-10', time: '08:05', reason: 'valid reason' } });
    check('override with an unknown staff ID is rejected', overrideBadStaff.status === 400);

    const overrideOk = await request('POST', '/api/clock/admin-in', { cookie: adminCookie, body: { staffId: 'S921', location: 'Cap Test House', date: '2026-05-10', time: '08:05', reason: 'Coverage emergency' } });
    check('override succeeds past a confirmed-at-capacity house', overrideOk.status === 200);

    const afterOverride = await request('GET', '/api/clock-entries', { cookie: adminCookie });
    const overriddenEntry = afterOverride.body.clockEntries.find(c => c.staffId === 'S921' && c.status === 'open');
    check('overridden entry correctly flagged with reason and who did it', overriddenEntry && overriddenEntry.overridden === true && overriddenEntry.overrideReason === 'Coverage emergency' && overriddenEntry.overrideBy === 'Admin');

    const doubleOverride = await request('POST', '/api/clock/admin-in', { cookie: adminCookie, body: { staffId: 'S921', location: 'Cap Test House', date: '2026-05-10', time: '09:00', reason: 'another try' } });
    check('double-override for someone already clocked in is still blocked', doubleOverride.status === 400);

    const auditAfterOverride = await request('GET', '/api/db/load', { cookie: adminCookie });
    const overrideAuditEntry = auditAfterOverride.body.AUDIT_LOG.find(e => e.type === 'CLOCK_IN_OVERRIDE');
    check('override is recorded in the audit trail', overrideAuditEntry && overrideAuditEntry.detail.includes('Coverage emergency'));

    console.log('\nGenuine concurrency — capacity and double-clock-in guards under real simultaneous requests:');
    const raceBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    const raceSetup = { ...raceBase.body };
    raceSetup.LOCATIONS = [...raceSetup.LOCATIONS, { id: 'LRACE', name: 'Race Condition House', rate: 12, mult: 1.5, notes: '', rateHistory: [], maxStaff: 2 }];
    const raceStaffIds = ['SR1','SR2','SR3','SR4','SR5'];
    raceSetup.STAFF = [...raceSetup.STAFF, ...raceStaffIds.map(id => ({ id, first: id, last: 'Race', title: 'DSP', type: 'Full-Time', loc: 'Race Condition House', rate: 12, start: '2026-01-01', status: 'Active' }))];
    raceSetup.USERS = [...raceSetup.USERS, ...raceStaffIds.map(id => ({ id: 'U'+id, username: 'race'+id.toLowerCase(), password: 'racepass1', name: id, role: 'employee', staffId: id }))];
    await request('POST', '/api/db/save', { body: raceSetup, cookie: adminCookie });

    const raceCookies = await Promise.all(raceStaffIds.map(id =>
      request('POST', '/api/auth/login', { body: { username: 'race'+id.toLowerCase(), password: 'racepass1' } }).then(r => r.cookie)
    ));

    // Fire all 5 clock-in requests at once — genuinely concurrent, not sequential awaits.
    const raceResults = await Promise.all(raceCookies.map(cookie =>
      request('POST', '/api/clock/in', { cookie, body: { location: 'Race Condition House', date: '2026-05-10', time: '08:00', lat: 39.95, lng: -75.16, accuracy: 10 } })
    ));
    const raceSuccesses = raceResults.filter(r => r.status === 200).length;
    check('exactly capacity (2) succeed out of 5 truly simultaneous clock-ins, never more', raceSuccesses === 2);

    const raceEntries = await request('GET', '/api/clock-entries', { cookie: adminCookie });
    const raceOpenCount = raceEntries.body.clockEntries.filter(c => c.location === 'Race Condition House' && c.status === 'open').length;
    check('database ground truth matches — exactly 2 open entries, not more', raceOpenCount === 2);

    // Same person firing 5 truly simultaneous clock-in requests (rapid double-click).
    const dblSetup = { ...raceBase.body };
    dblSetup.STAFF = [...dblSetup.STAFF, { id: 'SDBL', first: 'Double', last: 'Click', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Active' }];
    dblSetup.USERS = [...dblSetup.USERS, { id: 'UDBL', username: 'dblclick', password: 'dblpass1', name: 'Double Click', role: 'employee', staffId: 'SDBL' }];
    await request('POST', '/api/db/save', { body: dblSetup, cookie: adminCookie });
    const dblLogin = await request('POST', '/api/auth/login', { body: { username: 'dblclick', password: 'dblpass1' } });
    const dblResults = await Promise.all(Array(5).fill(0).map(() =>
      request('POST', '/api/clock/in', { cookie: dblLogin.cookie, body: { location: 'Usene House', date: '2026-05-10', time: '08:00', lat: 39.95, lng: -75.16, accuracy: 10 } })
    ));
    check('exactly 1 of 5 simultaneous clock-ins from the same person succeeds', dblResults.filter(r => r.status === 200).length === 1);

    console.log('\nClock-in/out geolocation (best-effort, separate module):');
    const geoSetup = { ...raceBase.body };
    geoSetup.STAFF = [...geoSetup.STAFF, { id: 'SGT1', first: 'Geo', last: 'Test', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Active' }];
    geoSetup.USERS = [...geoSetup.USERS, { id: 'UGT1', username: 'geotester', password: 'geopass1', name: 'Geo Test', role: 'employee', staffId: 'SGT1' }];
    await request('POST', '/api/db/save', { body: geoSetup, cookie: adminCookie });
    const geoLogin = await request('POST', '/api/auth/login', { body: { username: 'geotester', password: 'geopass1' } });

    const geoIn = await request('POST', '/api/clock/in', { cookie: geoLogin.cookie, body: { location: 'Usene House', date: '2026-08-03', time: '08:00:00', lat: 39.9526, lng: -75.1652, accuracy: 15 } });
    check('clock-in with valid coordinates succeeds', geoIn.status === 200);
    await request('POST', '/api/clock/out', { cookie: geoLogin.cookie, body: { date: '2026-08-03', time: '16:00:00', notes: '', lat: 39.953, lng: -75.1655, accuracy: 20 } });

    const dbLoadCheck = await request('GET', '/api/db/load', { cookie: adminCookie });
    const generalEntry = dbLoadCheck.body.CLOCK_ENTRIES.find(c => c.staffId === 'SGT1');
    check('location data does NOT leak into the general db/load response', generalEntry && !('clockInLat' in generalEntry));

    const clockEntriesCheck = await request('GET', '/api/clock-entries', { cookie: adminCookie });
    const generalEntry2 = clockEntriesCheck.body.clockEntries.find(c => c.staffId === 'SGT1');
    check('location data does NOT leak into the general clock-entries response', generalEntry2 && !('clockInLat' in generalEntry2));

    const geoLocations = await request('GET', '/api/clock-locations', { cookie: adminCookie });
    const dedicatedEntry = geoLocations.body.entries.find(e => e.staffId === 'SGT1');
    check('the dedicated clock-locations endpoint DOES have the coordinates', dedicatedEntry && dedicatedEntry.clockInLat === 39.9526 && dedicatedEntry.clockOutLat === 39.953);

    const supSetup = { ...raceBase.body };
    supSetup.USERS = [...supSetup.USERS, { id: 'USUPG', username: 'supgeo', password: 'supgeopass1', name: 'Sup Geo', role: 'supervisor' }];
    await request('POST', '/api/db/save', { body: supSetup, cookie: adminCookie });
    const supLogin = await request('POST', '/api/auth/login', { body: { username: 'supgeo', password: 'supgeopass1' } });
    const supGeoAttempt = await request('GET', '/api/clock-locations', { cookie: supLogin.cookie });
    check('supervisor is denied clock-locations access by default (not granted this permission)', supGeoAttempt.status === 403);

    const invalidGeoSetup = { ...raceBase.body };
    invalidGeoSetup.STAFF = [...invalidGeoSetup.STAFF, { id: 'SGT2', first: 'Invalid', last: 'Geo', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Active' }];
    invalidGeoSetup.USERS = [...invalidGeoSetup.USERS, { id: 'UGT2', username: 'invalidgeo', password: 'invpass1', name: 'Invalid Geo', role: 'employee', staffId: 'SGT2' }];
    await request('POST', '/api/db/save', { body: invalidGeoSetup, cookie: adminCookie });
    const invalidGeoLogin = await request('POST', '/api/auth/login', { body: { username: 'invalidgeo', password: 'invpass1' } });
    const invalidGeoIn = await request('POST', '/api/clock/in', { cookie: invalidGeoLogin.cookie, body: { location: 'Usene House', date: '2026-08-04', time: '08:00:00', lat: 999, lng: -9999, accuracy: -5 } });
    check('out-of-range coordinates are rejected (GPS is required, not best-effort)', invalidGeoIn.status === 400);

    const noGeoSetup = { ...raceBase.body };
    noGeoSetup.STAFF = [...noGeoSetup.STAFF, { id: 'SGT3', first: 'No', last: 'Geo', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Active' }];
    noGeoSetup.USERS = [...noGeoSetup.USERS, { id: 'UGT3', username: 'nogeo', password: 'nogeopass1', name: 'No Geo', role: 'employee', staffId: 'SGT3' }];
    await request('POST', '/api/db/save', { body: noGeoSetup, cookie: adminCookie });
    const noGeoLogin = await request('POST', '/api/auth/login', { body: { username: 'nogeo', password: 'nogeopass1' } });
    const noGeoIn = await request('POST', '/api/clock/in', { cookie: noGeoLogin.cookie, body: { location: 'Usene House', date: '2026-08-04', time: '09:00:00' } });
    check('clock-in with zero location fields is rejected (GPS is required)', noGeoIn.status === 400);
    const noGeoInWithCoords = await request('POST', '/api/clock/in', { cookie: noGeoLogin.cookie, body: { location: 'Usene House', date: '2026-08-04', time: '09:00:00', lat: 39.95, lng: -75.16, accuracy: 10 } });
    check('the same clock-in succeeds once valid coordinates are provided', noGeoInWithCoords.status === 200);

    console.log('\nSame-minute clock in/out (previously left people permanently stuck):');
    const sameMinSetup = { ...raceBase.body };
    sameMinSetup.STAFF = [...sameMinSetup.STAFF, { id: 'SSM1', first: 'Same', last: 'Minute', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Active' }];
    sameMinSetup.USERS = [...sameMinSetup.USERS, { id: 'USM1', username: 'sameminute', password: 'samepass1', name: 'Same Minute', role: 'employee', staffId: 'SSM1' }];
    await request('POST', '/api/db/save', { body: sameMinSetup, cookie: adminCookie });
    const sameMinLogin = await request('POST', '/api/auth/login', { body: { username: 'sameminute', password: 'samepass1' } });
    await request('POST', '/api/clock/in', { cookie: sameMinLogin.cookie, body: { location: 'Usene House', date: '2026-08-02', time: '22:11:05', lat: 39.95, lng: -75.16, accuracy: 10 } });
    const sameMinOut = await request('POST', '/api/clock/out', { cookie: sameMinLogin.cookie, body: { date: '2026-08-02', time: '22:11:45', notes: '', lat: 39.95, lng: -75.16, accuracy: 10 } });
    check('clocking out 40 seconds later in the same minute now succeeds', sameMinOut.status === 200 && sameMinOut.body.hours === 0.01);

    const trueZeroOut = await request('POST', '/api/clock/in', { cookie: sameMinLogin.cookie, body: { location: 'Usene House', date: '2026-08-02', time: '23:00:00', lat: 39.95, lng: -75.16, accuracy: 10 } })
      .then(() => request('POST', '/api/clock/out', { cookie: sameMinLogin.cookie, body: { date: '2026-08-02', time: '23:00:00', notes: '', lat: 39.95, lng: -75.16, accuracy: 10 } }));
    check('genuine zero-duration (exact same second) is still correctly rejected', trueZeroOut.status === 400);

    const cancelResult = await request('POST', '/api/clock/cancel', { cookie: sameMinLogin.cookie });
    check('cancelling an open clock-in succeeds', cancelResult.status === 200);
    const cancelAgain = await request('POST', '/api/clock/cancel', { cookie: sameMinLogin.cookie });
    check('cancelling with nothing open is correctly rejected', cancelAgain.status === 400);

    console.log('\nShift rejection (visible to the employee, excluded from payroll):');
    const rejectSetup = { ...raceBase.body };
    rejectSetup.STAFF = [...rejectSetup.STAFF, { id: 'SRJ1', first: 'Reject', last: 'Test', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Active' }];
    rejectSetup.SHIFTS = [...rejectSetup.SHIFTS, { id: 'SHRJ1', staff: 'SRJ1', date: '2026-08-02', start: '08:00', end: '16:00', location: 'Usene House', hours: 8, source: 'manual' }];
    await request('POST', '/api/db/save', { body: rejectSetup, cookie: adminCookie });

    const rejectNoReason = await request('POST', '/api/shifts/SHRJ1/reject', { cookie: adminCookie, body: { reason: '' } });
    check('rejecting a shift without a reason is rejected', rejectNoReason.status === 400);

    const rejectOk = await request('POST', '/api/shifts/SHRJ1/reject', { cookie: adminCookie, body: { reason: 'Duplicate entry, already logged separately' } });
    check('rejecting a shift with a reason succeeds', rejectOk.status === 200);

    const afterReject = await request('GET', '/api/db/load', { cookie: adminCookie });
    const rejectedShift = afterReject.body.SHIFTS.find(s => s.id === 'SHRJ1');
    check('rejected shift stays visible with status/reason, not deleted', rejectedShift && rejectedShift.shiftStatus === 'rejected' && rejectedShift.rejectedReason.includes('Duplicate'));

    const restoreOk = await request('POST', '/api/shifts/SHRJ1/restore', { cookie: adminCookie });
    check('restoring a rejected shift succeeds', restoreOk.status === 200);
    const afterRestore = await request('GET', '/api/db/load', { cookie: adminCookie });
    const restoredShift = afterRestore.body.SHIFTS.find(s => s.id === 'SHRJ1');
    check('restored shift is active again', restoredShift && restoredShift.shiftStatus === 'active');

    console.log('\nMeal break warning threshold persists correctly:');
    const mbtBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    const mbtSetup = { ...mbtBase.body, PAY_CONFIG: { ...mbtBase.body.PAY_CONFIG, mealBreakThresholdHours: 6 } };
    await request('POST', '/api/db/save', { body: mbtSetup, cookie: adminCookie });
    const mbtCheck = await request('GET', '/api/db/load', { cookie: adminCookie });
    check('meal break threshold saves and reloads correctly', mbtCheck.body.PAY_CONFIG.mealBreakThresholdHours === 6);
    // Reset to default so it doesn't affect any other test relying on the 5-hour default
    await request('POST', '/api/db/save', { body: { ...mbtCheck.body, PAY_CONFIG: { ...mbtCheck.body.PAY_CONFIG, mealBreakThresholdHours: 5 } }, cookie: adminCookie });

    console.log('\nMeal/rest break tracking, with meal breaks correctly deducted from paid hours:');
    const brkSetup = { ...raceBase.body };
    brkSetup.STAFF = [...brkSetup.STAFF, { id: 'SBRKT1', first: 'Break', last: 'Tester', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 20, start: '2026-01-01', status: 'Active' }];
    brkSetup.USERS = [...brkSetup.USERS, { id: 'UBRKT1', username: 'breaktester', password: 'brkpass1', name: 'Break Tester', role: 'employee', staffId: 'SBRKT1' }];
    await request('POST', '/api/db/save', { body: brkSetup, cookie: adminCookie });
    const brkLogin = await request('POST', '/api/auth/login', { body: { username: 'breaktester', password: 'brkpass1' } });

    await request('POST', '/api/clock/in', { cookie: brkLogin.cookie, body: { location: 'Usene House', date: '2026-08-03', time: '08:00:00', lat: 39.95, lng: -75.16, accuracy: 10 } });

    const endNoBreak = await request('POST', '/api/clock/break/end', { cookie: brkLogin.cookie, body: { date: '2026-08-03', time: '12:30:00' } });
    check('ending a break with none started is rejected', endNoBreak.status === 400);

    const startBreak = await request('POST', '/api/clock/break/start', { cookie: brkLogin.cookie, body: { breakType: 'meal', date: '2026-08-03', time: '12:00:00' } });
    check('starting a meal break succeeds', startBreak.status === 200 && startBreak.body.breakType === 'meal');

    const doubleBreak = await request('POST', '/api/clock/break/start', { cookie: brkLogin.cookie, body: { breakType: 'rest', date: '2026-08-03', time: '12:10:00' } });
    check('starting a second break while one is open is rejected', doubleBreak.status === 400);

    const endBreak = await request('POST', '/api/clock/break/end', { cookie: brkLogin.cookie, body: { date: '2026-08-03', time: '12:30:00' } });
    check('ending the break computes the correct duration (30 min = 0.5h)', endBreak.status === 200 && endBreak.body.hours === 0.5);

    await request('POST', '/api/clock/out', { cookie: brkLogin.cookie, body: { date: '2026-08-03', time: '16:00:00', notes: '', lat: 39.95, lng: -75.16, accuracy: 10 } });
    const brkEntriesList = await request('GET', '/api/clock-entries', { cookie: adminCookie });
    const brkEntry = brkEntriesList.body.clockEntries.find(c => c.staffId === 'SBRKT1');
    const brkApprove = await request('POST', `/api/clock-entries/${brkEntry.id}/review`, { cookie: adminCookie, body: { action: 'approve' } });
    check('approving the clock entry succeeds', brkApprove.status === 200);

    const afterBrkApprove = await request('GET', '/api/db/load', { cookie: adminCookie });
    const brkShift = afterBrkApprove.body.SHIFTS.find(s => s.id === brkApprove.body.shiftId);
    check('the resulting shift correctly shows 7.5 paid hours (8 total minus the 30-min unpaid meal break)', brkShift && brkShift.hours === 7.5 && brkShift.start === '08:00' && brkShift.end === '16:00');

    console.log('\nServer-side payroll finalization enforcement for Inactive-staff hours (real defense-in-depth, not just a client cache):');
    const pfBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    const pfSetup = { ...pfBase.body };
    pfSetup.STAFF = [...pfSetup.STAFF, { id: 'SPFT1', first: 'Inactive', last: 'PayrollTest', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 15, start: '2026-01-01', status: 'Inactive' }];
    pfSetup.SHIFTS = [...pfSetup.SHIFTS, { id: 'SHPFT1', staff: 'SPFT1', date: '2026-08-03', start: '08:00', end: '16:00', location: 'Usene House', hours: 8, source: 'manual' }];
    const pfSetupResult = await request('POST', '/api/db/save', { body: pfSetup, cookie: adminCookie });
    check('setting up the inactive staff + shift succeeds', pfSetupResult.status === 200);

    const pfAttemptBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    const pfAttempt = { ...pfAttemptBase.body };
    pfAttempt.PAYROLL_RECORDS = [{
      periodStart: '2026-08-01', periodLabel: 'Aug 1 - Aug 14, 2026 (Bi-Weekly)',
      confirmed: true, confirmedBy: 'Admin', confirmedAt: 'now', finalized: true, finalizedBy: 'Admin', finalizedAt: 'now',
      employeeRows: [{ staffId: 'SPFT1', name: 'PayrollTest, Inactive', gross: 120, deductions: [], totalDeductions: 0, net: 120 }],
      rows: []
    }];
    const pfBlockedResult = await request('POST', '/api/db/save', { body: pfAttempt, cookie: adminCookie });
    check('finalizing payroll with unapproved Inactive-staff hours is blocked server-side', pfBlockedResult.status === 403 && pfBlockedResult.body.error.includes('Inactive'));

    await request('POST', '/api/inactive-flags', { cookie: adminCookie, body: { staffId: 'SPFT1', periodStart: '2026-08-01' } });
    const pfFlagsList = await request('GET', '/api/inactive-flags', { cookie: adminCookie });
    const pfFlag = pfFlagsList.body.flags.find(f => f.staffId === 'SPFT1' && f.periodStart === '2026-08-01');
    await request('POST', `/api/inactive-flags/${pfFlag.id}/review`, { cookie: adminCookie, body: { action: 'approve' } });

    const pfApprovedResult = await request('POST', '/api/db/save', { body: pfAttempt, cookie: adminCookie });
    check('the SAME finalization succeeds once the flag is approved', pfApprovedResult.status === 200);

    const pfUnrelatedBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    const pfUnrelated = { ...pfUnrelatedBase.body };
    pfUnrelated.LOCATIONS = pfUnrelated.LOCATIONS.map(l => l.id === pfUnrelated.LOCATIONS[0].id ? { ...l, notes: 'unrelated tweak' } : l);
    const pfUnrelatedResult = await request('POST', '/api/db/save', { body: pfUnrelated, cookie: adminCookie });
    check('an unrelated save touching the same already-finalized record is not re-blocked', pfUnrelatedResult.status === 200);

    console.log('\nauthorizeSave converted to granular permissions (the highest-stakes authorization logic in the app):');
    const authSaveBase = await request('GET', '/api/db/load', { cookie: adminCookie });
    await request('POST', '/api/roles', { cookie: adminCookie, body: { name: 'Staff Only Manager', permissions: ['dashboard_view','staff_view','staff_manage'] } });
    const authSaveSetup = { ...authSaveBase.body };
    authSaveSetup.USERS = [...authSaveSetup.USERS, { id: 'USOM2', username: 'staffonlytest', password: 'staffpass1', name: 'Staff Only', role: 'Staff Only Manager' }];
    await request('POST', '/api/db/save', { body: authSaveSetup, cookie: adminCookie });
    const staffOnlyLogin = await request('POST', '/api/auth/login', { body: { username: 'staffonlytest', password: 'staffpass1' } });

    const staffOnlyBase = await request('GET', '/api/db/load', { cookie: staffOnlyLogin.cookie });
    const editStaffBody = { ...staffOnlyBase.body };
    editStaffBody.STAFF = editStaffBody.STAFF.map(s => s.id === 'S001' ? { ...s, title: 'Updated Title' } : s);
    const editStaffResult = await request('POST', '/api/db/save', { body: editStaffBody, cookie: staffOnlyLogin.cookie });
    check('custom role WITH staff_manage can edit staff', editStaffResult.status === 200);

    const addLocBody = { ...staffOnlyBase.body };
    addLocBody.LOCATIONS = [...addLocBody.LOCATIONS, { id: 'LSNEAK', name: 'Sneaky House', rate: 10, mult: 1.5, notes: '', rateHistory: [], maxStaff: 0 }];
    const addLocResult = await request('POST', '/api/db/save', { body: addLocBody, cookie: staffOnlyLogin.cookie });
    check('the SAME role WITHOUT locations_manage cannot add a location', addLocResult.status === 403);

    const addShiftBody = { ...staffOnlyBase.body };
    addShiftBody.SHIFTS = [...addShiftBody.SHIFTS, { id: 'SHSNEAK', staff: 'S001', date: '2026-08-05', start: '08:00', end: '16:00', location: 'Usene House', hours: 8, source: 'manual' }];
    const addShiftResult = await request('POST', '/api/db/save', { body: addShiftBody, cookie: staffOnlyLogin.cookie });
    check('the SAME role WITHOUT shifts_add cannot add a shift', addShiftResult.status === 403);

    // Re-confirm the original documented security concern still holds after conversion
    const viewerBody = { ...staffOnlyBase.body };
    viewerBody.APPROVED_EXCEPTIONS = [...viewerBody.APPROVED_EXCEPTIONS, { shiftId: 'FAKE1', approvedBy: 'Someone', reason: 'fabricated' }];
    const viewerFabResult = await request('POST', '/api/db/save', { body: viewerBody, cookie: viewerCookie });
    check('viewer role still cannot fabricate an approved exception (original security fix intact)', viewerFabResult.status === 403);

    console.log('\nGPS enforcement for clock in/out:');
    const gpsSetup = { ...raceBase.body };
    gpsSetup.STAFF = [...gpsSetup.STAFF, { id: 'SGPS1', first: 'Gps', last: 'Enforce', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Active' }];
    gpsSetup.USERS = [...gpsSetup.USERS, { id: 'UGPS1', username: 'gpsenforce', password: 'gpspass1', name: 'Gps Enforce', role: 'employee', staffId: 'SGPS1' }];
    await request('POST', '/api/db/save', { body: gpsSetup, cookie: adminCookie });
    const gpsLogin = await request('POST', '/api/auth/login', { body: { username: 'gpsenforce', password: 'gpspass1' } });
    const gpsNoCoords = await request('POST', '/api/clock/in', { cookie: gpsLogin.cookie, body: { location: 'Usene House', date: '2026-08-05', time: '08:00:00' } });
    check('clock-in with no GPS data at all is rejected', gpsNoCoords.status === 400);
    const gpsGoodIn = await request('POST', '/api/clock/in', { cookie: gpsLogin.cookie, body: { location: 'Usene House', date: '2026-08-05', time: '08:00:00', lat: 39.95, lng: -75.16, accuracy: 10 } });
    check('clock-in with valid GPS succeeds', gpsGoodIn.status === 200);
    const gpsNoCoordsOut = await request('POST', '/api/clock/out', { cookie: gpsLogin.cookie, body: { date: '2026-08-05', time: '16:00:00', notes: '' } });
    check('clock-out with no GPS data is rejected', gpsNoCoordsOut.status === 400);
    const gpsGoodOut = await request('POST', '/api/clock/out', { cookie: gpsLogin.cookie, body: { date: '2026-08-05', time: '16:00:00', notes: '', lat: 39.95, lng: -75.16, accuracy: 10 } });
    check('clock-out with valid GPS succeeds', gpsGoodOut.status === 200);

    console.log('\nSalary and External pay types:');
    const payTypeSetup = { ...raceBase.body };
    payTypeSetup.STAFF = [...payTypeSetup.STAFF,
      { id: 'SSAL2', first: 'Sal', last: 'Aried', title: 'Manager', type: 'Full-Time', loc: 'Usene House', rate: 0, start: '2026-01-01', status: 'Active', payType: 'salary', salaryAmount: 2000 },
      { id: 'SEXT2', first: 'Ext', last: 'Ernal', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 15, start: '2026-01-01', status: 'Active', payType: 'external' }];
    await request('POST', '/api/db/save', { body: payTypeSetup, cookie: adminCookie });

    const extOnHourly = await request('POST', '/api/external-payroll', { cookie: adminCookie, body: { staffId: 'S001', periodStart: '2026-08-01', hours: 80, amount: 1200 } });
    check('entering external payroll for an Hourly staff member is rejected', extOnHourly.status === 400);

    const extOk = await request('POST', '/api/external-payroll', { cookie: adminCookie, body: { staffId: 'SEXT2', periodStart: '2026-08-01', hours: 80, amount: 1200, notes: 'From other program' } });
    check('entering external payroll for the correct External staff member succeeds', extOk.status === 200);

    const extUpdate = await request('POST', '/api/external-payroll', { cookie: adminCookie, body: { staffId: 'SEXT2', periodStart: '2026-08-01', hours: 82, amount: 1230, notes: 'Corrected' } });
    check('re-submitting the same staff+period updates rather than duplicates', extUpdate.status === 200 && extUpdate.body.id === extOk.body.id);

    const extAbsurd = await request('POST', '/api/external-payroll', { cookie: adminCookie, body: { staffId: 'SEXT2', periodStart: '2026-08-01', hours: 80, amount: 9999999 } });
    check('an absurd external payroll amount is rejected', extAbsurd.status === 400);

    const extList = await request('GET', '/api/external-payroll', { cookie: adminCookie });
    const extEntry = extList.body.entries.find(e => e.staffId === 'SEXT2');
    check('the external payroll entry reflects the update, not the original', extEntry && extEntry.amount === 1230 && extEntry.notes === 'Corrected');

    const payTypeCheck = await request('GET', '/api/db/load', { cookie: adminCookie });
    const salStaff = payTypeCheck.body.STAFF.find(s => s.id === 'SSAL2');
    const extStaff = payTypeCheck.body.STAFF.find(s => s.id === 'SEXT2');
    check('staff pay types and salary amount persist correctly', salStaff && salStaff.payType === 'salary' && salStaff.salaryAmount === 2000 && extStaff && extStaff.payType === 'external');

    console.log('\nInactive staff with worked hours (payroll flag/review):');
    const inactiveSetup = { ...raceBase.body };
    inactiveSetup.STAFF = [...inactiveSetup.STAFF, { id: 'SINA1', first: 'Former', last: 'Employee', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Inactive' }];
    await request('POST', '/api/db/save', { body: inactiveSetup, cookie: adminCookie });

    const flagActive = await request('POST', '/api/inactive-flags', { cookie: adminCookie, body: { staffId: 'S001', periodStart: '2026-08-01' } });
    check('flagging an Active staff member is rejected', flagActive.status === 400);

    const flagOk = await request('POST', '/api/inactive-flags', { cookie: adminCookie, body: { staffId: 'SINA1', periodStart: '2026-08-01' } });
    check('flagging an Inactive staff member with hours succeeds', flagOk.status === 200 && flagOk.body.alreadyExisted === false);

    const flagAgain = await request('POST', '/api/inactive-flags', { cookie: adminCookie, body: { staffId: 'SINA1', periodStart: '2026-08-01' } });
    check('re-flagging the same staff+period is idempotent, not a duplicate', flagAgain.status === 200 && flagAgain.body.alreadyExisted === true && flagAgain.body.id === flagOk.body.id);

    const flagsList = await request('GET', '/api/inactive-flags', { cookie: adminCookie });
    check('the flag appears in the list as pending', flagsList.body.flags.some(f => f.id === flagOk.body.id && f.status === 'pending'));

    const flagApprove = await request('POST', `/api/inactive-flags/${flagOk.body.id}/review`, { cookie: adminCookie, body: { action: 'approve', notes: 'Confirmed one-off shift' } });
    check('approving the flag succeeds', flagApprove.status === 200);

    const flagsAfter = await request('GET', '/api/inactive-flags', { cookie: adminCookie });
    const approvedFlag = flagsAfter.body.flags.find(f => f.id === flagOk.body.id);
    check('flag now shows approved with the note and reviewer', approvedFlag && approvedFlag.status === 'approved' && approvedFlag.notes.includes('Confirmed') && approvedFlag.reviewedBy === 'Admin');

    console.log('\nAdmin closing out someone stuck clocked in:');
    const stuckSetup = { ...raceBase.body };
    stuckSetup.STAFF = [...stuckSetup.STAFF, { id: 'SSTUCK', first: 'Stuck', last: 'Employee', title: 'DSP', type: 'Full-Time', loc: 'Usene House', rate: 12, start: '2026-01-01', status: 'Active' }];
    stuckSetup.USERS = [...stuckSetup.USERS, { id: 'USTUCK', username: 'stuckemployee', password: 'stuckpass1', name: 'Stuck Employee', role: 'employee', staffId: 'SSTUCK' }];
    await request('POST', '/api/db/save', { body: stuckSetup, cookie: adminCookie });
    const stuckLogin = await request('POST', '/api/auth/login', { body: { username: 'stuckemployee', password: 'stuckpass1' } });
    await request('POST', '/api/clock/in', { cookie: stuckLogin.cookie, body: { location: 'Usene House', date: '2026-05-08', time: '08:00', lat: 39.95, lng: -75.16, accuracy: 10 } });

    const adminOutNoAuth = await request('POST', '/api/clock/admin-out', { cookie: stuckLogin.cookie, body: { staffId: 'SSTUCK', date: '2026-05-08', time: '16:00', reason: 'test' } });
    check('non-admin cannot use admin clock-out', adminOutNoAuth.status === 403);

    const adminOutNoReason = await request('POST', '/api/clock/admin-out', { cookie: adminCookie, body: { staffId: 'SSTUCK', date: '2026-05-08', time: '16:00', reason: '' } });
    check('admin clock-out without a reason is rejected', adminOutNoReason.status === 400);

    const adminOutNotClockedIn = await request('POST', '/api/clock/admin-out', { cookie: adminCookie, body: { staffId: 'S900', date: '2026-05-08', time: '16:00', reason: 'valid reason' } });
    check('admin clock-out for someone not currently clocked in is rejected', adminOutNotClockedIn.status === 400);

    const adminOutOk = await request('POST', '/api/clock/admin-out', { cookie: adminCookie, body: { staffId: 'SSTUCK', date: '2026-05-08', time: '16:00', reason: 'Forgot to clock out, confirmed with employee' } });
    check('admin successfully closes out a stuck clock-in with correct hours', adminOutOk.status === 200 && adminOutOk.body.hours === 8);

    const afterAdminOut = await request('GET', '/api/clock-entries', { cookie: adminCookie });
    const closedEntry = afterAdminOut.body.clockEntries.find(c => c.staffId === 'SSTUCK');
    check('closed-out entry is pending (still goes through normal review) and correctly flagged', closedEntry && closedEntry.status === 'pending' && closedEntry.overridden === true && closedEntry.overrideBy === 'Admin');

    const adminOutApprove = await request('POST', `/api/clock-entries/${closedEntry.id}/review`, { cookie: adminCookie, body: { action: 'approve' } });
    check('the admin-closed entry can still go through normal approval afterward', adminOutApprove.status === 200 && !!adminOutApprove.body.shiftId);

    console.log('\nAdmin-facing clock entry review:');
    await request('POST', '/api/clock/out', { cookie: cap1Cookie, body: { date: '2026-05-10', time: '16:00', notes: '', lat: 39.95, lng: -75.16, accuracy: 10 } });
    const pendingClockList = await request('GET', '/api/clock-entries', { cookie: adminCookie });
    const pendingClockEntry = pendingClockList.body.clockEntries.find(c => c.staffId === 'S920' && c.status === 'pending');
    check('clocked-out entry appears as pending for admin review', !!pendingClockEntry);

    const clockApprove = await request('POST', `/api/clock-entries/${pendingClockEntry.id}/review`, { cookie: adminCookie, body: { action: 'approve' } });
    check('approving a clock entry succeeds and returns a shift ID', clockApprove.status === 200 && !!clockApprove.body.shiftId);

    const afterClockApprove = await request('GET', '/api/db/load', { cookie: adminCookie });
    const createdShift = afterClockApprove.body.SHIFTS.find(s => s.id === clockApprove.body.shiftId);
    check('approved clock entry created a real shift with correct data', createdShift && createdShift.staff === 'S920' && createdShift.date === '2026-05-10' && createdShift.start === '08:00' && createdShift.end === '16:00');

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
