// Tests for the checks that run before a shift is added or edited
// (shiftEntryProblems). Pulls the real functions out of the live HTML file.
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'ASO_OT_SYSTEM_SQL.html'), 'utf8');
function grab(name) {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`));
  if (!m) throw new Error(name + ' not found in the live HTML file');
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(m.index, i + 1); }
  }
}
eval(['stMin', 'shiftAbs', 'shiftEntryProblems', 'numFmtSafe'].map(grab).join('\n'));

let passed = 0, failed = 0;
const check = (name, ok) => { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } };
global.todayLocalISO = () => '2026-10-16';
global.STAFF = [
  { id: 'S049', first: 'Zulayha', last: 'Robinson', loc: 'Serah House', status: 'Active', start: '2026-01-05' },
  { id: 'S050', first: 'Amos', last: 'Kollie', loc: 'Serah House', status: 'Inactive' },
  { id: 'S051', first: 'Ben', last: 'Doe', loc: 'Serah House', status: 'Active' }
];
global.LOCATIONS = [{ name: 'Serah House', maxStaff: 2 }, { name: 'William House', maxStaff: 0 }];
let n = 0;
const sh = (staff, date, location, start, end, extra) => Object.assign({ id: 'T' + (++n), staff, date, location, start, end, shiftStatus: 'active' }, extra || {});
global.SHIFTS = [
  sh('S049', '2026-10-15', 'Serah House', '06:00', '14:00'),
  sh('S049', '2026-10-15', 'Serah House', '22:00', '06:00'),                 // overnight into Oct 16
  sh('S049', '2026-10-14', 'Serah House', '14:00', '22:00', { shiftStatus: 'rejected', rejectedReason: 'Duplicate' }),
  sh('S051', '2026-10-13', 'Serah House', '06:00', '14:00'),
  sh('S050', '2026-10-13', 'Serah House', '06:00', '14:00')
];
global.PENDING_APPROVALS = [{ staffId: 'S051', date: '2026-10-12', start: '06:00', end: '14:00', location: 'William House' }];
global.CLOCK_ENTRIES = [
  { staffId: 'S051', status: 'pending', clockInDate: '2026-10-11', clockInTime: '14:02:10', clockOutDate: '2026-10-11', clockOutTime: '22:01:00' },
  { staffId: 'S049', status: 'open', clockInDate: '2026-10-16', clockInTime: '14:00:00' }
];
const P = (e, ex) => shiftEntryProblems(Object.assign({ hours: 8 }, e), ex || null);

console.log('Duplicates and overlaps:\n');
let r = P({ date: '2026-10-15', staff: 'S049', location: 'Serah House', start: '06:00', end: '14:00' });
check('the exact same shift entered twice is blocked as a duplicate', r.blocks.length === 1 && /already entered/.test(r.blocks[0]));
r = P({ date: '2026-10-15', staff: 'S049', location: 'William House', start: '06:00', end: '14:00' });
check('same person, same times, different house is blocked', r.blocks.some(b => /exact times at Serah House/.test(b)));
r = P({ date: '2026-10-15', staff: 'S049', location: 'Serah House', start: '10:00', end: '18:00' });
check('a shift that partly overlaps another is blocked', r.blocks.some(b => /overlaps/.test(b)));
r = P({ date: '2026-10-16', staff: 'S049', location: 'Serah House', start: '05:00', end: '13:00' });
check('the next morning is checked against last night\'s 3rd shift (10 PM – 6 AM)', r.blocks.some(b => /overlaps/.test(b)));
r = P({ date: '2026-10-16', staff: 'S049', location: 'Serah House', start: '06:00', end: '14:00' });
check('starting exactly when the overnight shift ends is allowed', r.blocks.length === 0);
r = P({ date: '2026-10-15', staff: 'S049', location: 'Serah House', start: '14:00', end: '22:00' });
check('a back-to-back 2nd shift (a double) is allowed', r.blocks.length === 0);
r = P({ date: '2026-10-15', staff: 'S049', location: 'Serah House', start: '06:00', end: '14:00' }, 'T1');
check('editing a shift does not clash with itself', r.blocks.length === 0);
r = P({ date: '2026-10-14', staff: 'S049', location: 'Serah House', start: '14:00', end: '22:00' });
check('re-entering over a rejected shift is a warning, not a block', r.blocks.length === 0 && r.warns.some(w => /REJECTED.*Duplicate/.test(w)));
r = P({ date: '2026-10-15', staff: 'S051', location: 'Serah House', start: '06:00', end: '14:00' });
check('a different person at the same time is fine', r.blocks.length === 0);

console.log('\nApprovals and clock-ins:\n');
r = P({ date: '2026-10-12', staff: 'S051', location: 'William House', start: '07:00', end: '15:00' });
check('a shift already waiting for approval is blocked', r.blocks.some(b => /waiting for approval/.test(b)));
r = P({ date: '2026-10-11', staff: 'S051', location: 'Serah House', start: '14:00', end: '22:00' });
check('a clock-in/out waiting for approval is blocked (would count twice)', r.blocks.some(b => /clocked in and out/.test(b)));
r = P({ date: '2026-10-16', staff: 'S049', location: 'Serah House', start: '14:00', end: '22:00' });
check('someone clocked in right now is blocked', r.blocks.some(b => /clocked in right now/.test(b)));

console.log('\nDates, staff and hours:\n');
r = P({ date: '2026-10-20', staff: 'S051', location: 'Serah House', start: '06:00', end: '14:00' });
check('a future date is a warning', r.blocks.length === 0 && r.warns.some(w => /future/.test(w)));
r = P({ date: '2026-01-02', staff: 'S049', location: 'William House', start: '06:00', end: '14:00' });
check('a shift before the hire date is a warning', r.warns.some(w => /hire date/.test(w)));
r = P({ date: '2026-10-10', staff: 'S050', location: 'William House', start: '06:00', end: '14:00' });
check('an inactive staff member is a warning', r.warns.some(w => /Inactive/.test(w)));
r = P({ date: '2026-10-10', staff: 'S051', location: 'William House', start: '06:00', end: '06:00', hours: 24 });
check('same start and end time is blocked', r.blocks.some(b => /same/.test(b)));
r = P({ date: '2026-10-10', staff: 'S051', location: 'William House', start: '06:00', end: '02:00', hours: 20 });
check('a shift over 16 hours is a warning', r.warns.some(w => /20\.00-hour shift/.test(w)));
global.SHIFTS.push(sh('S051', '2026-10-09', 'William House', '06:00', '14:00'), sh('S051', '2026-10-09', 'William House', '14:00', '22:00'));
r = P({ date: '2026-10-09', staff: 'S051', location: 'William House', start: '22:00', end: '06:00' });
check('a third shift in a row (24 hours straight) is a warning', r.blocks.length === 0 && r.warns.some(w => /24\.00 hours in a row/.test(w)));

console.log('\nHouse staffing limit:\n');
global.SHIFTS.push(sh('S050', '2026-10-13', 'Serah House', '06:00', '14:00', { id: 'X' }));
r = P({ date: '2026-10-13', staff: 'S049', location: 'Serah House', start: '06:00', end: '14:00' });
check('a house already at its limit (2) is a warning', r.warns.some(w => /limit is 2/.test(w)));
r = P({ date: '2026-10-13', staff: 'S049', location: 'William House', start: '06:00', end: '14:00' });
check('no limit set means no warning', !r.warns.some(w => /limit/.test(w)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
