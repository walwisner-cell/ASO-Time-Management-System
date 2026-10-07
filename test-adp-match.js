// Standalone test for the ADP Timecard Match feature: reading the ADP
// Timecard Report, matching ADP names to staff, and comparing punches to
// timesheet shifts. The functions are pulled straight out of the live HTML
// file on every run. The "PDF pages" here are hand-built in exactly the
// layout ADP prints (each value at the same left edge as its column
// heading), with made-up names, so no real timecard is stored in the repo.
const fs = require('fs');
const path = require('path');
function extractFunctions(names) {
  const html = fs.readFileSync(path.join(__dirname, 'ASO_OT_SYSTEM_SQL.html'), 'utf8');
  return names.map(name => {
    const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`));
    if (!m) throw new Error(`${name} not found in the live HTML file`);
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(m.index, i + 1); }
    }
  }).join('\n\n');
}
eval(extractFunctions(['adpHmToHours', 'adpTo24', 'adpMin', 'adpHm', 'adpParseTextPages', 'adpMatchName', 'adpCompareStaff', 'adpWhoIsMissing']));

let passed = 0, failed = 0;
function check(name, condition) { if (condition) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`); } }
const near = (a, b) => Math.abs(a - b) < 0.005;

// Builds one ADP page: header block, then rows [day, date, in, out, regular, overtime].
function page(name, range, total, rows) {
  const it = [{ str: 'Timecard Report', x: 232, y: 816 },
    { str: 'Employee Name', x: 38, y: 764 }, { str: 'Pay Period', x: 143, y: 764 }, { str: 'Date Range', x: 247, y: 764 }, { str: 'Total Paid Hours', x: 352, y: 764 }, { str: 'Show Source', x: 456, y: 764 },
    { str: name, x: 38, y: 748 }, { str: range, x: 247, y: 748 }, { str: total, x: 352, y: 748 }, { str: 'false', x: 456, y: 748 },
    { str: 'Date', x: 38, y: 732 }, { str: 'Start Work', x: 85, y: 732 }, { str: 'In Punch', x: 132, y: 732 }, { str: 'End Work', x: 179, y: 732 }, { str: 'Out Punch', x: 226, y: 732 },
    { str: 'Regular', x: 272, y: 732 }, { str: 'Overtime', x: 319, y: 732 }, { str: 'Doubletime', x: 366, y: 732 }, { str: 'Details', x: 413, y: 732 }, { str: 'Department', x: 460, y: 732 }, { str: 'Notes', x: 514, y: 732 }];
  let y = 704;
  rows.forEach(r => {
    it.push({ str: r[0], x: 38, y }, { str: r[1], x: 38, y: y - 12 }, { str: r[2], x: 85, y });
    if (r[3]) it.push({ str: r[3], x: 179, y });
    if (r[4]) it.push({ str: r[4], x: 272, y });
    if (r[5]) it.push({ str: r[5], x: 319, y }, { str: r[5], x: 413, y }, { str: 'Weekly', x: 413, y: y - 12 }, { str: 'Overtime', x: 413, y: y - 24 });
    it.push({ str: 'DSP (102)', x: 460, y });
    y -= 28;
  });
  it.push({ str: 'Signature', x: 36, y: 430 }, { str: 'Date', x: 241, y: 430 }, { str: 'Page 2 of 2', x: 277, y: 26 });
  return it;
}

console.log('Reading the ADP Timecard Report:\n');
const emps = adpParseTextPages([
  page('Rivers Jordan M', '09/27/2026 to 10/03/2026', '36:59', [
    ['Sun', '09/27/2026', '6:00 AM', '2:08 PM', '8:08', ''],
    ['Mon', '09/28/2026', '10:19 PM', '6:08 AM', '7:49', ''],        // overnight
    ['Thu', '10/01/2026', '7:06 AM', '6:57 PM', '9:11', '2:40'],     // regular + overtime on one row
    ['Sat', '10/03/2026', '10:15 PM', '11:15 PM', '', '1:00'],       // overtime only, Regular column empty
    ['Fri', '10/02/2026', '2:03 PM', '2:03 PM', '0:00', ''],         // punch error
    ['Wed', '09/30/2026', '9:25 AM', '5:36 PM', '8:11', '']
  ]),
  page('Stone Avery', '09/27/2026 to 10/03/2026', '8:00', [['Tue', '09/29/2026', '8:00 AM', '4:00 PM', '8:00', '']])
]);
const e = emps[0], on = d => e.entries.filter(x => x.date === d);
check('finds both employees with their names and date range', emps.length === 2 && e.name === 'Rivers Jordan M' && e.from === '2026-09-27' && e.to === '2026-10-03' && emps[1].name === 'Stone Avery');
check('reads all six punches and sorts them by date', e.entries.length === 6 && e.entries[0].date === '2026-09-27' && e.entries[5].date === '2026-10-03');
check('converts times to 24-hour and h:mm to decimal hours (6:00 AM–2:08 PM = 8.13)', on('2026-09-27')[0].start === '06:00' && on('2026-09-27')[0].end === '14:08' && near(on('2026-09-27')[0].hours, 8 + 8 / 60));
check('an overnight punch keeps its start date and its real length (7:49)', on('2026-09-28')[0].start === '22:19' && on('2026-09-28')[0].end === '06:08' && near(on('2026-09-28')[0].hours, 7 + 49 / 60));
check('regular + overtime on one row are added together (9:11 + 2:40 = 11:51)', near(on('2026-10-01')[0].hours, 11 + 51 / 60) && near(on('2026-10-01')[0].ot, 2 + 40 / 60));
check('an overtime-only row is NOT misread as regular time', near(on('2026-10-03')[0].reg, 0) && near(on('2026-10-03')[0].ot, 1) && near(on('2026-10-03')[0].hours, 1));
check('in and out at the same minute with 0:00 is a punch error with zero hours, not a 24-hour shift', on('2026-10-02')[0].zero === true && on('2026-10-02')[0].hours === 0);
check('the punches add up to ADP’s own Total Paid Hours (36:59)', near(e.entries.reduce((a, x) => a + x.hours, 0), e.total) && near(e.total, 36 + 59 / 60));
check('a file that is not a timecard gives no employees instead of an error', adpParseTextPages([[{ str: 'Invoice', x: 10, y: 10 }]]).length === 0 && adpParseTextPages([]).length === 0);

console.log('\nMatching ADP names to staff:\n');
const staff = [
  { id: 'S1', first: 'Jordan', last: 'Rivers' }, { id: 'S2', first: 'Avery', last: 'Stone' }, { id: 'S3', first: 'Mary Ann', last: 'De La Cruz' },
  { id: 'S4', first: 'Samuel', last: 'Baker' }, { id: 'S5', first: 'Sandra', last: 'Baker' }, { id: 'S6', first: 'Christopher', last: 'Okoro' }
];
check('"Last First M" matches with the middle initial ignored', adpMatchName('Rivers Jordan M', staff, {}).staff.id === 'S1' && adpMatchName('Rivers Jordan M', staff, {}).how === 'exact');
check('upper/lower case and spacing do not matter', adpMatchName('  STONE   avery ', staff, {}).staff.id === 'S2');
check('names with spaces in them still match', adpMatchName('De La Cruz Mary Ann', staff, {}).staff.id === 'S3');
check('a shortened first name matches on last name + initial and is marked for confirmation', adpMatchName('Okoro Chris', staff, {}).staff.id === 'S6' && adpMatchName('Okoro Chris', staff, {}).how === 'close');
check('two people with the same last name and initial are NOT guessed between', adpMatchName('Baker Sam', staff, {}).staff === null);
check('an unknown name is left unmatched', adpMatchName('Nobody Here', staff, {}).staff === null);
check('a match picked by hand wins and is reported as saved', adpMatchName('Baker Sam', staff, { 'Baker Sam': 'S4' }).staff.id === 'S4' && adpMatchName('Baker Sam', staff, { 'Baker Sam': 'S4' }).how === 'saved');
check('a name marked "leave out" stays out', adpMatchName('Rivers Jordan M', staff, { 'Rivers Jordan M': '__skip__' }).how === 'skip' && adpMatchName('Rivers Jordan M', staff, { 'Rivers Jordan M': '__skip__' }).staff === null);

console.log('\nComparing punches to the timesheet:\n');
const ts = (id, date, start, end, hours) => ({ id, date, start, end, hours, location: 'House' });
const shifts = [
  ts('A', '2026-09-27', '06:00', '14:00', 8),      // 8 minutes short on the way out
  ts('B', '2026-09-28', '22:00', '06:00', 8),      // overnight, 19 min late in
  ts('C', '2026-09-29', '08:00', '16:00', 8),      // no ADP punch
  ts('D', '2026-10-02', '14:00', '22:00', 8),      // day with an ADP punch error
  ts('E', '2026-09-30', '13:00', '21:00', 8)       // 3.5 hours off, but overlapping the punch
];
const byDate = (rows, d) => rows.filter(r => r.date === d);
let rows = adpCompareStaff(e.entries, shifts, 7);
check('within 7 minutes in and out counts as a match only when BOTH ends are', byDate(rows, '2026-09-27')[0].status === 'differs' && byDate(rows, '2026-09-27')[0].dOut === 8 && byDate(rows, '2026-09-27')[0].dIn === 0);
check('with a 10-minute tolerance the same row is a match, and is known not to be exact', byDate(adpCompareStaff(e.entries, shifts, 10), '2026-09-27')[0].status === 'match' && byDate(adpCompareStaff(e.entries, shifts, 10), '2026-09-27')[0].exact === false);
check('overnight shifts are compared correctly across midnight (in +19 min, out +8 min)', byDate(rows, '2026-09-28')[0].status === 'differs' && byDate(rows, '2026-09-28')[0].dIn === 19 && byDate(rows, '2026-09-28')[0].dOut === 8);
check('the hour difference is ADP minus timesheet', near(byDate(rows, '2026-09-27')[0].diffHours, 8 / 60) && near(byDate(rows, '2026-09-28')[0].diffHours, -11 / 60));
check('a timesheet shift with no ADP punch is listed as not in ADP', byDate(rows, '2026-09-29').length === 1 && byDate(rows, '2026-09-29')[0].status === 'ts_only' && byDate(rows, '2026-09-29')[0].shift.id === 'C');
check('ADP punches with no timesheet shift are listed as missing from the timesheet', byDate(rows, '2026-10-01')[0].status === 'adp_only' && byDate(rows, '2026-10-03')[0].status === 'adp_only');
check('a punch and a shift more than 4 hours apart but overlapping are still treated as the same shift', byDate(rows, '2026-09-30').length === 1 && byDate(rows, '2026-09-30')[0].status === 'differs' && byDate(rows, '2026-09-30')[0].shift.id === 'E');
const oct2 = byDate(rows, '2026-10-02');
check('a punch error is shown on its own line and never paired with a shift', oct2.length === 2 && oct2.some(r => r.status === 'adp_zero') && oct2.some(r => r.status === 'ts_only' && r.shift.id === 'D'));
check('every row on a punch-error day is marked so the timesheet shift cannot be bulk-rejected', oct2.every(r => r.adpIssue === true) && !byDate(rows, '2026-09-29')[0].adpIssue);
check('an exact match is recognised as exact', adpCompareStaff([{ date: '2026-09-29', start: '08:00', end: '16:00', hours: 8 }], [shifts[2]], 0)[0].status === 'match' && adpCompareStaff([{ date: '2026-09-29', start: '08:00', end: '16:00', hours: 8 }], [shifts[2]], 0)[0].exact === true);
const two = adpCompareStaff([{ date: '2026-09-27', start: '06:02', end: '14:01', hours: 7.98 }, { date: '2026-09-27', start: '22:00', end: '06:00', hours: 8 }], [ts('X', '2026-09-27', '22:00', '06:00', 8), ts('Y', '2026-09-27', '06:00', '14:00', 8)], 7);
check('two shifts on one day are each paired with the right punch', two.length === 2 && two.every(r => r.status === 'match') && two[0].shift.id === 'Y' && two[1].shift.id === 'X');
check('every punch and every shift appears exactly once in the result', rows.filter(r => r.adp).length === e.entries.length && rows.filter(r => r.shift).length === shifts.length);

console.log('\nWho is on one record but not the other:\n');
const P = (id, first, last, entries, tsCount, tsTotal) => ({ staff: { id, first, last }, emp: { name: last + ' ' + first, entries }, tsCount, tsTotal, adpTotal: entries.reduce((a, x) => a + x.hours, 0) });
const punch = h => ({ hours: h, zero: h === 0 });
const miss = adpWhoIsMissing(
  [P('S1', 'Jordan', 'Rivers', [punch(8), punch(8)], 2, 16),      // on both — in neither list
   P('S2', 'Avery', 'Stone', [punch(8), punch(7.5)], 0, 0),       // ADP only
   P('S3', 'Sam', 'Baker', [], 3, 24),                            // card with no punches, has shifts
   P('S4', 'Lee', 'Okoro', [punch(0)], 1, 8)],                    // only a punch error, has a shift
  [{ emp: { name: 'Ghost Pat', entries: [punch(6)] }, skipped: false }, { emp: { name: 'Temp Agency', entries: [punch(4)] }, skipped: true }, { emp: { name: 'Empty Card', entries: [] }, skipped: false }],
  [{ staff: { id: 'S9', first: 'Dana', last: 'Mills' }, shifts: 2, hours: 16 }]);
const names = arr => arr.map(x => x.name).join('|');
check('someone on both records is in neither list', !names(miss.adpOnly).includes('Jordan') && !names(miss.tsOnly).includes('Jordan'));
check('staff with ADP punches and no timesheet shifts are listed as ADP only, with their hours', miss.adpOnly.some(x => x.id === 'S2' && x.known && x.punches === 2 && near(x.hours, 15.5)));
check('an ADP name that is not a staff member here is listed as ADP only and marked unknown', miss.adpOnly.some(x => x.name === 'Ghost Pat' && x.known === false && !x.skipped));
check('a name left out on purpose is still listed, marked as such', miss.adpOnly.some(x => x.name === 'Temp Agency' && x.skipped === true));
check('an ADP card with no punches at all is not reported as ADP only', !names(miss.adpOnly).includes('Empty Card') && miss.adpOnly.length === 3);
check('staff with timesheet hours and no ADP timecard are listed as timesheet only', miss.tsOnly.some(x => x.id === 'S9' && x.shifts === 2 && near(x.hours, 16)));
check('staff whose ADP card is empty, or has only punch errors, are listed as timesheet only', miss.tsOnly.some(x => x.id === 'S3') && miss.tsOnly.some(x => x.id === 'S4' && /punch errors/.test(x.why)) && miss.tsOnly.length === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
