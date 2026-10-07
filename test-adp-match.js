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
eval(extractFunctions(['calendarDayDiff', 'formatTimeDisplay', 'fmtTime', 'numFmt', 'srAddDays', 'srDayName', 'adpHmToHours', 'adpTo24', 'adpMin', 'adpHm', 'adpParseTextPages', 'adpMatchName', 'adpCompareStaff', 'adpWhoIsMissing', 'adpClassify', 'adpSuggestHouse', 'adpPatterns', 'adpAuditState', 'adpDeptLabel', 'adpSpan', 'adpAbout', 'adpFindings', 'adpTimesheetChecks']));

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

console.log('\nMatching punches to shift periods (the audit workbook’s rules):\n');
const ts = (id, date, start, end, hours, extra) => Object.assign({ id, date, start, end, hours, location: 'House' }, extra || {});
const pu = (date, start, end, hours, extra) => Object.assign({ date, start, end, hours: hours === undefined ? 0 : hours, zero: !!end && start === end, missingOut: !end }, extra || {});
const one = (adp, shifts, tol) => adpCompareStaff(adp, shifts, tol === undefined ? 15 : tol);
const lab = r => adpClassify(r).label;
let rows = one([pu('2026-09-28', '06:19', '14:14', 7.92)], [ts('A', '2026-09-28', '06:00', '14:00', 8)]);
check('a punch 19 minutes late in but with the same hours is a Match (hours decide, not clock times)', rows.length === 1 && lab(rows[0]) === 'Match' && rows[0].dIn === 19);
check('16 minutes more on ADP than the timesheet is "Hours differ" at a 15-minute tolerance, and a Match at 30', lab(one([pu('2026-09-30', '06:02', '14:18', 8.27)], [ts('A', '2026-09-30', '06:00', '14:00', 8)])[0]) === 'Hours differ' && lab(one([pu('2026-09-30', '06:02', '14:18', 8.27)], [ts('A', '2026-09-30', '06:00', '14:00', 8)], 30)[0]) === 'Match');
check('exactly at the tolerance still matches', lab(one([pu('2026-09-30', '06:00', '14:15', 8.25)], [ts('A', '2026-09-30', '06:00', '14:00', 8)])[0]) === 'Match');
check('a shift with no punch at all is "No ADP punch"', lab(one([], [ts('A', '2026-09-28', '06:00', '14:00', 8)])[0]) === 'No ADP punch');
rows = one([pu('2026-09-29', '06:14', '14:04', 7.83)], [ts('A', '2026-09-29', '14:00', '22:00', 8)]);
check('a punch for the morning is NOT matched to an afternoon shift just because they touch for 4 minutes', rows.length === 2 && rows.some(r => r.status === 'ts_only') && rows.some(r => r.status === 'adp_only'));
rows = one([pu('2026-09-27', '06:01', '12:46', 6.75), pu('2026-09-27', '12:47', '22:01', 9.2)], [ts('A', '2026-09-27', '12:00', '22:00', 10)]);
check('two back-to-back punches covering one shift are joined into one stretch (6:01 AM – 10:01 PM, 15.95 hrs)', rows.length === 1 && rows[0].adp.start === '06:01' && rows[0].adp.end === '22:01' && near(rows[0].adp.hours, 15.95) && rows[0].adp.parts.length === 2 && lab(rows[0]) === 'Hours differ');
rows = one([pu('2026-09-27', '13:32', '22:42', 9.17), pu('2026-09-27', '22:44', '06:03', 7.32)], []);
check('back-to-back punches with NO shift stay as two separate lines', rows.length === 2 && rows.every(r => r.status === 'adp_only'));
rows = one([pu('2026-10-02', '22:19', '06:08', 7.82), pu('2026-10-02', '06:00', '14:51', 8.85)], [ts('N', '2026-10-02', '22:00', '06:00', 8)]);
check('an overnight shift takes the overnight punch; the day punch is left as "not on timesheet"', rows.find(r => r.shift).adp.start === '22:19' && lab(rows.find(r => r.shift)) === 'Match' && rows.find(r => !r.shift).adp.start === '06:00');
rows = one([pu('2026-10-03', '23:50', '08:05', 8.25)], [ts('M', '2026-10-04', '00:00', '08:00', 8)]);
check('a punch that starts just before midnight still finds the shift dated the next day', rows.length === 1 && lab(rows[0]) === 'Match');
rows = one([pu('2026-10-03', '14:00', '22:00', 8)], [ts('L', '2026-10-03', '14:00', '06:00', 16)]);
check('a 16-hour shift with only 8 hours punched is "Hours differ" by 8 hours', lab(rows[0]) === 'Hours differ' && near(rows[0].diffHours, -8) && rows[0].dOut === -480);
rows = one([pu('2026-10-03', '22:20', '22:23', 0.05)], [ts('L', '2026-10-03', '06:00', '22:00', 16)]);
check('a 3-minute punch just after the shift is pinned to it as "Incomplete ADP punch"', rows.length === 1 && lab(rows[0]) === 'Incomplete ADP punch' && near(rows[0].adpHours, 0.05));
rows = one([pu('2026-09-28', '14:03', '14:03', 0), pu('2026-09-28', '22:09', '22:09', 0)], [ts('Z', '2026-09-28', '14:00', '22:00', 8)]);
check('two zero-length punches at each end of a shift make ONE "Incomplete ADP punch" line carrying both', rows.length === 1 && lab(rows[0]) === 'Incomplete ADP punch' && rows[0].adpParts.length === 2 && rows[0].adpHours === 0);
check('a zero-length punch with no shift near it is a stray, not a shift', (() => { const r = one([pu('2026-10-03', '15:19', '15:19', 0)], [ts('Q', '2026-10-01', '06:00', '14:00', 8)]); return r.length === 2 && r.some(x => x.status === 'adp_zero') && lab(r.find(x => x.status === 'adp_zero')) === 'Stray ADP punch'; })());
check('a punch with no out time is never treated as a usable punch', lab(one([pu('2026-10-01', '06:00', null, 0)], [ts('Q', '2026-10-01', '06:00', '14:00', 8)])[0]) === 'Incomplete ADP punch');
rows = one([pu('2026-09-27', '06:02', '14:01', 7.98), pu('2026-09-27', '22:00', '06:00', 8)], [ts('X', '2026-09-27', '22:00', '06:00', 8), ts('Y', '2026-09-27', '06:00', '14:00', 8)]);
check('two shifts on one day each get their own punch', rows.length === 2 && rows.every(r => r.status === 'match') && rows[0].shift.id === 'Y' && rows[1].shift.id === 'X');
const big = one(e.entries, [ts('A', '2026-09-27', '06:00', '14:00', 8), ts('B', '2026-09-28', '22:00', '06:00', 8), ts('C', '2026-09-29', '08:00', '16:00', 8), ts('D', '2026-10-02', '14:00', '22:00', 8)]);
check('every punch and every shift appears exactly once', big.filter(r => r.shift).length === 4 && big.reduce((a, r) => a + (r.adp ? (r.adpParts || r.adp.parts || [r.adp]).length : 0), 0) === e.entries.length);
check('sorting is by tier: Match needs nothing, Hours differ is for review, No/Incomplete punch are held, ADP-only is a suggestion',
  adpClassify({ status: 'match' }).tier === 'ok' && adpClassify({ status: 'differs' }).tier === 'review' && adpClassify({ status: 'ts_only' }).tier === 'hold' && adpClassify({ status: 'incomplete' }).tier === 'hold' && adpClassify({ status: 'adp_only' }).tier === 'suggest' && adpClassify({ status: 'adp_zero' }).tier === 'blocked');

console.log('\n"What I found" notes:\n');
const person = (rws, loc) => ({ staff: { id: 'S1', first: 'Jordan', last: 'Rivers', loc: loc === undefined ? 'East House' : loc }, rows: rws });
const find = (adp, shifts, ctx, loc) => { const p = person(one(adp, shifts), loc); adpFindings(p, Object.assign({ hasCard: true, tol: 15, rangeShifts: [] }, ctx || {})); return p.rows; };
check('no ADP card at all is said plainly', /No ADP timecard for this person at all/.test(find([], [ts('A', '2026-09-28', '06:00', '14:00', 8)], { hasCard: false })[0].found));
check('has a card but no punch for the shift', /Has an ADP timecard in these dates, but no punch for this shift/.test(find([], [ts('A', '2026-09-28', '06:00', '14:00', 8)])[0].found));
let fr = find([pu('2026-09-29', '06:14', '14:04', 7.83)], [ts('A', '2026-09-29', '14:00', '22:00', 8)]);
check('same hours on a different shift that day is called out on both lines', /Same hours, different shift - confirm which shift was worked/.test(fr.find(r => r.shift).found) && /Timesheet has them on 2:00 PM-10:00 PM that day instead/.test(fr.find(r => !r.shift).found));
check('ADP running past the end of the shift', /ADP shows out at 4:09 PM; timesheet ends 2:00 PM\. About 2 hours on ADP not on the timesheet/.test(find([pu('2026-09-27', '06:12', '16:09', 9.95)], [ts('A', '2026-09-27', '06:00', '14:00', 8)])[0].found));
check('ADP starting long before the shift', /ADP shows on the clock from 6:01 AM; timesheet starts at 12:00 PM\. About 6 hours/.test(find([pu('2026-09-27', '06:01', '22:01', 15.95)], [ts('A', '2026-09-27', '12:00', '22:00', 10)])[0].found));
check('ADP stopping before the shift ends, with the long-shift note', (f => /ADP stops at 10:00 PM; timesheet runs to 6:00 AM\. About 8 hours on the timesheet have no punch/.test(f) && /Long shift \(16 hrs\)/.test(f))(find([pu('2026-10-03', '14:00', '22:00', 8)], [ts('L', '2026-10-03', '14:00', '06:00', 16)])[0].found));
check('two zero-length punches are explained as in and out entered separately', /two zero-length punches \(2:03 PM and 10:09 PM\).*Fix in ADP so 8 hours pay/.test(find([pu('2026-09-28', '14:03', '14:03', 0), pu('2026-09-28', '22:09', '22:09', 0)], [ts('Z', '2026-09-28', '14:00', '22:00', 8)])[0].found));
check('a single zero-length punch', /Only ADP punch is a single 10:21 PM entry \(in = out\)/.test(find([pu('2026-10-01', '22:21', '22:21', 0)], [ts('Z', '2026-10-01', '14:00', '22:00', 8)])[0].found));
check('a 3-minute punch', /Only ADP punch is 10:20 PM-10:23 PM \(3 minutes\)\. The 16-hour shift has no usable punch/.test(find([pu('2026-10-03', '22:20', '22:23', 0.05)], [ts('L', '2026-10-03', '06:00', '22:00', 16)])[0].found));
check('a stray punch with no shift', /Single punch at 3:19 PM \(in = out\), no timesheet shift\. Stray or incomplete punch/.test(find([pu('2026-10-03', '15:19', '15:19', 0)], [])[0].found));
fr = find([pu('2026-10-01', '22:05', '06:06', 8.02)], [], { rangeShifts: [{ staff: 'S9', name: 'Mills, Dana', date: '2026-10-01', start: '14:00', end: '22:00', location: 'East House' }] });
check('an ADP-only punch says the person is not on the timesheet and that their home house has no one listed then', /Not on the timesheet at all in these dates\. East House timesheet has no one listed for this time/.test(fr[0].found));
fr = find([pu('2026-10-01', '14:10', '22:02', 7.87)], [], { rangeShifts: [{ staff: 'S9', name: 'Mills, Dana', date: '2026-10-01', start: '14:00', end: '22:00', location: 'East House' }] });
check('…or names who the home house timesheet has on instead', /East House timesheet lists Mills, Dana for this time/.test(fr[0].found));
check('a clean match gets no note; an edited one says so', find([pu('2026-09-28', '06:00', '14:00', 8)], [ts('A', '2026-09-28', '06:00', '14:00', 8)])[0].found === '' && /Entry marked Edited/.test(find([pu('2026-09-28', '06:00', '14:00', 8)], [ts('A', '2026-09-28', '06:00', '14:00', 8, { _corrected: true })])[0].found));
check('ADP department labels are shortened the way the workbook shows them', adpDeptLabel('DSP (102)') === 'DSP' && adpDeptLabel('Administrative (101)') === 'Admin' && adpDeptLabel('') === '');

console.log('\nTimesheet checks:\n');
const cs = (staff, name, date, start, end, location, otHrs) => { let h = adpMin(end) - adpMin(start); if (h <= 0) h += 1440; return { staff, name, date, start, end, hours: h / 60, location, otHrs: otHrs || 0 }; };
const wk = ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];
// East House: fully staffed round the clock by three people, except where a test removes a shift.
const full = wk.flatMap((d, i) => [cs('E' + (i % 3), 'Day, Pat', d, '06:00', '14:00', 'East House'), cs('E' + ((i + 1) % 3), 'Eve, Sam', d, '14:00', '22:00', 'East House'), cs('E' + ((i + 2) % 3), 'Night, Lee', d, '22:00', '06:00', 'East House')]);
const chk = (shifts, extra) => adpTimesheetChecks(Object.assign({ shifts, from: '2026-09-27', to: '2026-10-03', houses: ['East House', 'West House', 'Office'] }, extra || {}));
const has = (list, check, re) => list.some(x => x.check === check && (!re || re.test(x.who + ' | ' + x.when + ' | ' + x.found)));
check('a fully staffed house raises no coverage findings (the first morning is not called a gap)', !has(chk(full), 'Coverage gap on timesheet') && !has(chk(full), 'House/day with no entries'));
let c1 = chk(full.concat([cs('K', 'Kollie, Jo', '2026-10-02', '23:00', '07:00', 'West House'), cs('K', 'Kollie, Jo', '2026-10-03', '06:00', '16:30', 'East House')]));
check('one person in two houses at once is caught, with the size of the overlap', has(c1, 'Overlapping shifts', /Kollie, Jo.*Fri 10\/02 - Sat 10\/03.*overlaps.*by 60 minutes\. They cannot be in both houses/));
c1 = chk(wk.slice(0, 6).map(d => cs('W', 'Work, Al', d, '06:00', '14:00', 'Office')));
check('over 40 hours in the week with no overtime showing is flagged', has(c1, 'Over 40 hours in the week, OT shows 0.00', /Work, Al.*09\/27 - 10\/03.*48 timesheet hours/));
check('…but not when the timesheet already shows overtime, or at exactly 40', !has(chk(wk.slice(0, 6).map((d, i) => cs('W', 'Work, Al', d, '06:00', '14:00', 'Office', i === 5 ? 8 : 0))), 'Over 40 hours in the week, OT shows 0.00') && !has(chk(wk.slice(0, 5).map(d => cs('W', 'Work, Al', d, '06:00', '14:00', 'Office'))), 'Over 40 hours in the week, OT shows 0.00'));
check('a single 22-hour entry is flagged; a 16-hour one is not', has(chk([cs('C', 'Chea, J', '2026-09-27', '08:00', '06:00', 'Office')]), 'Shift over 16 hours', /22 hours in one entry/) && !has(chk([cs('C', 'Chea, J', '2026-09-27', '06:00', '22:00', 'Office')]), 'Shift over 16 hours'));
check('two entries running straight into each other for 16 hours are flagged', has(chk([cs('B', 'Back, Bo', '2026-10-01', '06:00', '14:00', 'Office'), cs('B', 'Back, Bo', '2026-10-01', '14:00', '22:00', 'Office')]), 'Back-to-back shifts', /2 entries running together = 16 hours straight/));
check('…but not two shifts with a real break between them', !has(chk([cs('B', 'Back, Bo', '2026-10-01', '06:00', '14:00', 'Office'), cs('B', 'Back, Bo', '2026-10-01', '16:00', '23:59', 'Office')]), 'Back-to-back shifts'));
const noNight = full.filter(x => !(x.date === '2026-09-29' && x.start === '22:00'));
c1 = chk(noNight, { loose: [{ name: 'Johnson, Phil', home: 'East House', date: '2026-09-29', start: '22:06', end: '06:28' }] });
check('a missing overnight at a round-the-clock house is a coverage gap, and says who ADP shows working it', has(c1, 'Coverage gap on timesheet', /East House.*Tue 09\/29 - Wed 09\/30.*10:00 PM to 6:00 AM next day \(8 hours\)\. ADP shows Johnson on 10:06 PM-6:28 AM/));
check('a punch matched to a later shift at the same house is named when it reaches back into the gap', has(chk(noNight, { over: [{ name: 'Chambers, T', home: 'East House', date: '2026-09-29', start: '21:30', end: '06:05' }] }), 'Coverage gap on timesheet', /ADP shows Chambers on 9:30 PM-6:05 AM/));
check('with no ADP punch for the gap it says so', has(chk(noNight), 'Coverage gap on timesheet', /No ADP punch found for it either/));
const noSat = full.filter(x => x.date !== '2026-10-03' && !(x.date === '2026-10-02' && x.start === '22:00'));
check('a whole day with nothing entered is reported as a day with no entries', has(chk(noSat), 'House/day with no entries', /East House.*Sat 10\/03.*No timesheet entries for the whole day/));
check('a missing last overnight is caught even though it runs past the last date', has(chk(full.filter(x => !(x.date === '2026-10-03' && x.start === '22:00'))), 'Coverage gap on timesheet', /Sat 10\/03 - Sun 10\/04.*10:00 PM to 6:00 AM next day/));
check('a place that is not staffed round the clock (the Office) never gets coverage gaps', !has(chk(wk.slice(1, 6).map(d => cs('O', 'Desk, Di', d, '09:00', '17:00', 'Office'))), 'Coverage gap on timesheet') && !has(chk(wk.slice(1, 6).map(d => cs('O', 'Desk, Di', d, '09:00', '17:00', 'Office'))), 'House/day with no entries'));
check('a first shift starting at 8 AM on the first day is a 6–8 AM gap even when the night before is outside the dates', has(chk(full.filter(x => !(x.date === '2026-09-27' && x.start === '06:00')).concat([cs('E9', 'Late, Lu', '2026-09-27', '08:00', '14:00', 'East House')])), 'Coverage gap on timesheet', /Sun 09\/27.*6:00 AM to 8:00 AM \(2 hours\)/));
check('the evening before an empty day is shown as the whole missing overnight', has(chk(noSat), 'Coverage gap on timesheet', /Fri 10\/02 - Sat 10\/03.*10:00 PM to 6:00 AM next day \(8 hours\)/));
check('a late first morning IS a gap when the night before is known', has(chk(full.filter(x => !(x.date === '2026-09-27' && x.start === '06:00')), { edge: [cs('E2', 'Night, Lee', '2026-09-26', '22:00', '06:00', 'East House')] }), 'Coverage gap on timesheet', /Sun 09\/27.*6:00 AM to 2:00 PM/));
check('a house with ADP punches from its staff but nothing on the timesheet is named', has(chk(full, { loose: [{ name: 'Mawolo, P', home: 'West House', date: '2026-09-27', start: '13:32', end: '22:42' }] }), 'House missing from timesheet', /West House.*1 of its staff have ADP punches/));

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

console.log('\nSuggesting the house for a shift added from ADP:\n');
const who = { id: 'S1', loc: 'Home House' };
const hist = (date, location, extra) => Object.assign({ staff: 'S1', date, location, shiftStatus: 'active', source: 'manual' }, extra || {});
// Thursday 2026-10-01. Earlier Thursdays: Sep 24, 17, 10, 3.
check('uses the house worked on the same weekday in recent weeks', adpSuggestHouse(who, '2026-10-01', [hist('2026-09-24', 'East House'), hist('2026-09-17', 'East House'), hist('2026-09-10', 'Home House'), hist('2026-09-22', 'Home House'), hist('2026-09-23', 'Home House')]).house === 'East House');
check('says why, in plain words', /2 of the last 3 Thursdays/.test(adpSuggestHouse(who, '2026-10-01', [hist('2026-09-24', 'East House'), hist('2026-09-17', 'East House'), hist('2026-09-10', 'Home House')]).why));
check('falls back to where they usually work when that weekday has no history', adpSuggestHouse(who, '2026-10-01', [hist('2026-09-21', 'West House'), hist('2026-09-22', 'West House'), hist('2026-09-23', 'Home House')]).house === 'West House');
check('falls back to the home house with no history at all', adpSuggestHouse(who, '2026-10-01', []).house === 'Home House' && adpSuggestHouse(who, '2026-10-01', []).why === 'home house');
check('ignores rejected shifts, other people, older than 8 weeks, and shifts that were themselves added from ADP',
  adpSuggestHouse(who, '2026-10-01', [hist('2026-09-24', 'X', { shiftStatus: 'rejected' }), hist('2026-09-17', 'X', { shiftStatus: 'rejected' }), hist('2026-09-24', 'Y', { staff: 'S2' }), hist('2026-09-17', 'Y', { staff: 'S2' }), hist('2026-07-02', 'Z'), hist('2026-07-09', 'Z'), hist('2026-09-24', 'Q', { source: 'adp' }), hist('2026-09-17', 'Q', { source: 'adp' })]).house === 'Home House');
check('someone with no home house and no history gets a blank to fill in, not a guess', adpSuggestHouse({ id: 'S1', loc: '' }, '2026-10-01', []).house === '');

console.log('\nDecisions and sign-off kept in the Audit Trail:\n');
const log = [
  { type: 'ADP_REVIEWED', ts: 1, by: 'Pat', at: 't1', meta: 'key=S1|2026-09-29|x|A \u00B7 2026-09-29 \u00B7 Needs review \u00B7 note=worked as written' },
  { type: 'ADP_REVIEWED', ts: 2, by: 'Pat', at: 't2', meta: 'key=S2|2026-09-30|x|B \u00B7 2026-09-30 \u00B7 note=ok' },
  { type: 'ADP_REVIEW_UNDONE', ts: 3, by: 'Pat', at: 't3', meta: 'key=S2|2026-09-30|x|B \u00B7 2026-09-30' },
  { type: 'ADP_CORRECTION', ts: 4, by: 'Pat', at: 't4', detail: 'Shift corrected', meta: '2026-09-28 \u00B7 Old: 08:00\u201316:00' },
  { type: 'ADP_CORRECTION', ts: 5, by: 'Pat', at: 't5', detail: 'Shift corrected', meta: '2026-10-09 \u00B7 another week' },
  { type: 'ADP_SIGNOFF', ts: 6, by: 'Lee', at: 't6', meta: 'range=2026-09-27..2026-10-03 \u00B7 file' },
  { type: 'EDIT_SHIFT', ts: 7, by: 'Pat', at: 't7', meta: 'unrelated' }
];
const st1 = adpAuditState(log, '2026-09-27', '2026-10-03');
check('a reviewed decision is remembered with who, when and why', st1.reviewed['S1|2026-09-29|x|A'].by === 'Pat' && st1.reviewed['S1|2026-09-29|x|A'].note === 'worked as written');
check('an undone review is forgotten', !st1.reviewed['S2|2026-09-30|x|B']);
check('only corrections inside the report dates are listed', st1.corrections.length === 1 && st1.corrections[0].ts === 4);
check('the sign-off for these exact dates is found', st1.signoff && st1.signoff.by === 'Lee');
check('a sign-off for one week does not close a different week', adpAuditState(log, '2026-10-04', '2026-10-10').signoff === null);
check('reopening after sign-off opens the week again', adpAuditState(log.concat([{ type: 'ADP_REOPEN', ts: 8, by: 'Admin', at: 't8', meta: 'range=2026-09-27..2026-10-03 \u00B7 late punch fix' }]), '2026-09-27', '2026-10-03').signoff === null);
check('the order entries arrive in does not matter, only their time', adpAuditState(log.slice().reverse(), '2026-09-27', '2026-10-03').signoff.by === 'Lee' && !adpAuditState(log.slice().reverse(), '2026-09-27', '2026-10-03').reviewed['S2|2026-09-30|x|B']);
check('an empty or missing audit log is handled', adpAuditState(null, 'a', 'b').signoff === null && adpAuditState([], 'a', 'b').corrections.length === 0);

const hlog = log.filter(e => e.type !== 'ADP_SIGNOFF').concat([{ type: 'ADP_SIGNOFF', ts: 20, by: 'Mo', at: 't20', meta: 'range=2026-09-27..2026-10-03 house=East House \u00B7 file' }]);
check('a sign-off for one house closes that house only', adpAuditState(hlog, '2026-09-27', '2026-10-03', 'East House').signoff.by === 'Mo' && adpAuditState(hlog, '2026-09-27', '2026-10-03', 'East House').signoff.house === 'East House');
check('\u2026it does not close another house, a house with a similar name, or the whole week', adpAuditState(hlog, '2026-09-27', '2026-10-03', 'West House').signoff === null && adpAuditState(hlog, '2026-09-27', '2026-10-03', 'East').signoff === null && adpAuditState(hlog, '2026-09-27', '2026-10-03').signoff === null);
check('a whole-week sign-off is not mistaken for a single-house one', adpAuditState(log, '2026-09-27', '2026-10-03', 'East House').signoff === null && adpAuditState(log, '2026-09-27', '2026-10-03').signoff.by === 'Lee');
check('reopening one house leaves the others signed', (() => { const l2 = hlog.concat([{ type: 'ADP_SIGNOFF', ts: 21, by: 'Jo', at: 't21', meta: 'range=2026-09-27..2026-10-03 house=West House \u00B7 f' }, { type: 'ADP_REOPEN', ts: 22, by: 'Admin', at: 't22', meta: 'range=2026-09-27..2026-10-03 house=East House \u00B7 late fix' }]); return adpAuditState(l2, '2026-09-27', '2026-10-03', 'East House').signoff === null && adpAuditState(l2, '2026-09-27', '2026-10-03', 'West House').signoff.by === 'Jo'; })());

console.log('\nHabits worth a conversation:\n');
const mk = (id, first, rows) => ({ staff: { id, first, last: 'X', loc: 'Home House' }, rows });
const pr = (status, dIn, dOut, tier, loc) => ({ status, dIn, dOut, diffHours: 0.5, adp: status === 'ts_only' ? null : { inferred: false }, shift: status === 'adp_only' || status === 'adp_zero' ? null : { location: loc || 'Home House' }, cls: { tier } });
const pat = adpPatterns([
  mk('S1', 'Early', [pr('differs', -12, 0, 'auto'), pr('differs', -9, 14, 'auto'), pr('match', 0, 0, 'ok')]),
  mk('S2', 'Misser', [pr('ts_only', null, null, 'hold'), pr('adp_zero', null, null, 'blocked'), pr('adp_only', null, null, 'suggest')]),
  mk('S3', 'Fine', [pr('match', 0, 0, 'ok'), pr('differs', 3, -2, 'auto', 'East House')])
]);
check('counts early punch-ins and late punch-outs per person (8 minutes or more)', pat.who.find(x => x.id === 'S1').early === 2 && pat.who.find(x => x.id === 'S1').lateOut === 1);
check('counts missed or bad punches and punches with no timesheet shift', pat.who.find(x => x.id === 'S2').missed === 2 && pat.who.find(x => x.id === 'S2').unscheduled === 1);
check('someone with only small differences is not listed', !pat.who.some(x => x.id === 'S3'));
check('missed punches rank above early punch-ins', pat.who[0].id === 'S2');
check('differences are totalled by house', pat.houses.find(h => h.house === 'Home House').differences === 5 && pat.houses.find(h => h.house === 'East House').differences === 1 && pat.houses.find(h => h.house === 'Home House').lines === 7);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
