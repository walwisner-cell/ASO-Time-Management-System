// Standalone test for (1) the pay-period calendar math and (2) the Staff
// Timesheet Report builder. Like the other standalone tests, it pulls the
// real functions straight out of the live HTML file on every run, so it can
// never drift from what actually ships.
//
// Pinned to Pennsylvania time on purpose: the pay-period bug this guards
// against only shows up in a timezone that changes its clocks.
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');

function extractFunctions(names) {
  const html = fs.readFileSync(path.join(__dirname, 'ASO_OT_SYSTEM_SQL.html'), 'utf8');
  const chunks = [];
  for (const name of names) {
    const m = html.match(new RegExp(`function ${name.replace('$', '\\$')}\\([^)]*\\)\\s*\\{`));
    if (!m) throw new Error(`${name} not found in the live HTML file`);
    let depth = 0, end = -1;
    for (let i = m.index + m[0].length - 1; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    chunks.push(html.slice(m.index, end));
  }
  return chunks.join('\n\n');
}

eval(extractFunctions([
  'calendarDayDiff', 'periodIndexForDate', 'periodBoundsByIndex', 'getPeriodForDate', 'fmtPeriod', 'getPeriodLabel',
  'calcClockHours', 'clockEntryMissingMealBreak', 'shiftMissingMealBreak', 'getLocRate', 'getLocOTMult',
  'computeShiftsWithOT', 'formatDateDisplay', 'formatTimeDisplay',
  'srAddDays', 'srDayName', 'srShortDate', 'srTime', 'srHrs', 'srWeekStart', 'srBuildStaffReport', 'srLeaveLabel', 'srWeekLines', 'srSourceLabel', 'srHouseCrossover', 'srBuildHouseDays'
]));

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}
const near = (a, b) => Math.abs(a - b) < 0.005;

// ───────────────────────── Pay-period calendar math ─────────────────────────
console.log('Pay periods across the clock changes:\n');

global.PAY_CONFIG = { anchorDate: '2026-05-09', periodDays: 14, otThreshold: 80 };
check('summer anchor: a normal summer date is unchanged (Jun 20 starts its own period)',
  getPeriodForDate('2026-06-20').key === '2026-06-20' && getPeriodLabel('2026-06-20').startsWith('Jun 20 – Jul 3, 2026'));
check('summer anchor: the period containing the Nov 1 clock change ends Nov 6, not Nov 5',
  getPeriodLabel('2026-10-24').startsWith('Oct 24 – Nov 6, 2026'));
check('summer anchor: the first winter period is labelled Nov 7 – Nov 20, not Nov 6 – Nov 19',
  getPeriodForDate('2026-11-07').key === '2026-11-07' && getPeriodLabel('2026-11-07').startsWith('Nov 7 – Nov 20, 2026'));
check('summer anchor: the last day of a winter period still belongs to that period',
  getPeriodForDate('2026-11-20').key === '2026-11-07' && getPeriodForDate('2026-11-21').key === '2026-11-21');
const pw = getPeriodForDate('2026-12-25');
check('period start and end are always local midnight (no 11 PM drift)', pw.start.getHours() === 0 && pw.end.getHours() === 0);

global.PAY_CONFIG = { anchorDate: '2026-01-03', periodDays: 14, otThreshold: 80 };
check('winter anchor: the first day of a summer period is NOT pushed into the previous period',
  getPeriodForDate('2026-06-20').key === '2026-06-20');
check('winter anchor: the day before still belongs to the earlier period', getPeriodForDate('2026-06-19').key === '2026-06-06');
check('winter anchor: Oct 24 starts its own period', getPeriodForDate('2026-10-24').key === '2026-10-24');
check('a date before the anchor resolves to the period that contains it', getPeriodForDate('2025-12-31').key === '2025-12-20');
check('calendarDayDiff counts whole days across a clock change', calendarDayDiff('2026-10-31', '2026-11-02') === 2 && calendarDayDiff('2026-03-07', '2026-03-09') === 2);

// ───────────────────────── Staff Timesheet Report ─────────────────────────
console.log('\nStaff Timesheet Report builder:\n');

global.PAY_CONFIG = { anchorDate: '2026-05-09', periodDays: 14, otThreshold: 80, mealBreakThresholdHours: 5 };
global.LOCATIONS = [
  { name: 'Gabriella House', rate: 14, mult: 1.5 },
  { name: 'William House', rate: 13.5, mult: 1.5 }
];
const dj = { id: 'S003', first: 'Daniel', last: 'Juan', title: 'DSP', type: 'Full-Time', loc: 'Gabriella House', rate: 14, status: 'Active' };
global.STAFF = [dj, { id: 'S001', first: 'Alfred', last: 'Erzondah', loc: 'William House', rate: 0, status: 'Active' }];
global.APPROVED_EXCEPTIONS = [];
let n = 0;
const hrs = (a, b) => { const [sh, sm] = a.split(':').map(Number); const [eh, em] = b.split(':').map(Number); let s = sh * 60 + sm, e = eh * 60 + em; if (e <= s) e += 1440; return (e - s) / 60; };
const sh = (staff, date, location, start, end, extra) => Object.assign({ id: 'T' + (++n), staff, date, location, start, end, hours: hrs(start, end), source: 'manual', shiftStatus: 'active' }, extra || {});
global.SHIFTS = [
  sh('S003', '2026-09-26', 'Gabriella House', '07:00', '19:00'),                       // 12
  sh('S003', '2026-09-27', 'Gabriella House', '07:00', '19:00'),                       // 12
  sh('S003', '2026-09-28', 'Gabriella House', '07:00', '23:00'),                       // 16  long shift
  sh('S003', '2026-09-29', 'William House',   '15:00', '23:00'),                       //  8  away from home house
  sh('S003', '2026-09-30', 'Gabriella House', '23:00', '07:00'),                       //  8  overnight
  sh('S003', '2026-10-01', 'Gabriella House', '15:00', '23:00', { shiftStatus: 'rejected', rejectedReason: 'Duplicate', rejectedBy: 'Admin' }),
  sh('S003', '2026-10-02', 'Gabriella House', '07:00', '15:00'),                       //  8  -> week 1 = 64
  sh('S003', '2026-10-03', 'Gabriella House', '07:00', '19:00'),                       // 12
  sh('S003', '2026-10-04', 'Gabriella House', '07:00', '19:00'),                       // 12  crosses 80 here
  sh('S003', '2026-10-05', 'Gabriella House', '07:00', '15:30', { id: 'CLK1', source: 'clock_in' }), // 8.5 -> week 2 = 32.5
  sh('S003', '2026-10-10', 'Gabriella House', '07:00', '15:00'),                       // next period — must be left out
  sh('S001', '2026-09-28', 'William House', '08:00', '16:00')                          // someone else — must be left out
];
global.CLOCK_ENTRIES = [
  { id: 'CE1', staffId: 'S003', shiftId: 'CLK1', status: 'approved', clockInDate: '2026-10-05', clockInTime: '07:00', clockOutDate: '2026-10-05', clockOutTime: '16:00' },
  { id: 'CE2', staffId: 'S003', shiftId: '', status: 'pending', clockInDate: '2026-10-06', clockInTime: '07:00', clockOutDate: '2026-10-06', clockOutTime: '15:00' }
];
global.CLOCK_BREAKS = [{ clockEntryId: 'CE1', breakType: 'meal', startDate: '2026-10-05', startTime: '12:00', endDate: '2026-10-05', endTime: '12:30' }];
global.LEAVE_REQUESTS = [
  { staffId: 'S003', type: 'vacation', startDate: '2026-10-07', endDate: '2026-10-08', hours: 16, status: 'approved' },
  { staffId: 'S003', type: 'personal', startDate: '2026-10-09', endDate: '2026-10-09', hours: 8, status: 'pending' },
  { staffId: 'S003', type: 'sick', startDate: '2026-10-06', endDate: '2026-10-06', hours: 8, status: 'denied' },
  { staffId: 'S001', type: 'vacation', startDate: '2026-10-07', endDate: '2026-10-07', hours: 8, status: 'approved' }
];

const all = computeShiftsWithOT();
const r = srBuildStaffReport(dj, '2026-09-26', '2026-10-09', all);
const T = r.totals;

check('lists every shift in the range, including the rejected one, and nothing outside it', r.rows.length === 10);
check('total hours leave the rejected shift out (96.5, not 104.5)', near(T.hours, 96.5));
check('regular + overtime hours add back up to total hours', near(T.reg + T.ot, T.hours));
check('regular is capped at the 80-hour threshold and the rest is overtime', near(T.reg, 80) && near(T.ot, 16.5));
check('gross pay matches a hand calculation (80 x $14 + 16.5 x $21 = $1,466.50)', near(T.gross, 1466.5) && near(T.regPay, 1120) && near(T.otPay, 346.5));
check('report totals equal the payroll engine’s own totals for the same shifts',
  near(T.gross, all.filter(s => s.staff === 'S003' && s.date <= '2026-10-09').reduce((a, s) => a + s.shiftPay, 0)));
check('counts 9 paid shifts on 9 days and 1 rejected', T.shifts === 9 && T.days === 9 && T.rejected === 1);
check('splits the period into two workweeks on the right dates',
  r.weeks.length === 2 && r.weeks[0].start === '2026-09-26' && r.weeks[0].end === '2026-10-02' && r.weeks[1].start === '2026-10-03');
check('week subtotals are right (64 and 32.5) and add up to the total', near(r.weeks[0].hours, 64) && near(r.weeks[1].hours, 32.5) && near(r.weeks[0].hours + r.weeks[1].hours, T.hours));
check('week 1 shows 24 hours beyond 40; week 2 shows none', near(r.weeks[0].over40, 24) && near(r.weeks[1].over40, 0));
check('hours by house add up to the total and mark the home house',
  near(r.houses.reduce((a, h) => a + h.hours, 0), T.hours) && r.houses.find(h => h.name === 'Gabriella House').home === true && near(r.houses.find(h => h.name === 'William House').hours, 8));
check('overnight shift is marked as ending the next day', r.rows.find(x => x.date === '2026-09-30').overnight === true && r.rows.find(x => x.date === '2026-09-26').overnight === false);
check('a clocked shift shows its recorded 30-minute meal break; a typed-in shift shows none on record',
  r.rows.find(x => x.id === 'CLK1').mealMin === 30 && r.rows.find(x => x.date === '2026-09-26').mealMin === null);
check('approved time off is totalled (16); pending is listed but not totalled; denied and other people’s are left out',
  near(r.leaveHours, 16) && r.leave.length === 2);
const txt = r.notes.map(x => x.level + ':' + x.text).join('\n');
check('flags the rejected shift with its reason', /check:.*rejected and is not paid: Duplicate/.test(txt));
check('flags the 16-hour shift', /check:.*single shift of 16\.00 hours/.test(txt));
check('flags the clock entry still waiting for approval as something to settle first', /action:1 clock in\/out entry is still waiting/.test(txt));
check('flags the pending time-off request as something to settle first', /action:Time-off request still pending/.test(txt));
check('shows the overtime cross-check (24 hrs beyond 40 in a week vs 16.5 paid)', /Overtime cross-check: 24\.00 hrs.*16\.50 overtime hrs are paid/.test(txt));
check('reports the longest run of days worked in a row (5: Sep 26 – Sep 30, broken by the rejected Oct 1)', r.streak.len === 5 && r.streak.start === '2026-09-26');
check('does not flag a meal break on the clocked shift that has one', !/no meal break/.test(txt));

global.CLOCK_BREAKS = [];
const r2 = srBuildStaffReport(dj, '2026-09-26', '2026-10-09', computeShiftsWithOT());
check('with the break removed, the same clocked shift IS flagged for a missing meal break', /no meal break recorded/.test(r2.notes.map(x => x.text).join('\n')) && r2.rows.find(x => x.id === 'CLK1').mealMin === 0);

const r3 = srBuildStaffReport(dj, '2026-10-01', '2026-10-05', computeShiftsWithOT());
check('a custom range that cuts through both weeks marks them as partial and skips the 40-hour cross-check',
  r3.weeks.length === 2 && r3.weeks.every(w => w.partial) && !/Overtime cross-check/.test(r3.notes.map(x => x.text).join('\n')));
check('a custom range still carries the correct overtime from the full pay period (16.5)', near(r3.totals.ot, 16.5) && near(r3.totals.hours, 40.5));

const r4 = srBuildStaffReport(Object.assign({}, dj, { status: 'Inactive' }), '2026-09-26', '2026-10-09', computeShiftsWithOT());
check('an Inactive staff member with hours is flagged to settle first', r4.notes.some(x => x.level === 'action' && /marked Inactive/.test(x.text)));
const r5 = srBuildStaffReport({ id: 'S099', first: 'No', last: 'Hours', loc: 'William House', status: 'Active' }, '2026-09-26', '2026-10-09', computeShiftsWithOT());
check('a staff member with no shifts gets an empty sheet with zero totals, not an error', r5.rows.length === 0 && r5.totals.hours === 0 && r5.weeks.length === 2 && r5.notes.some(x => /No hours recorded/.test(x.text)));

// ───────────────────────── Layout helpers added with the signature copy ─────────────────────────
console.log('\nSignature copy, single date, every-day list:\n');
check('at-a-glance figures: average shift 96.5 / 9, 4 weekend days, 1 overnight shift, 2 houses',
  near(r.stats.avgShift, 96.5 / 9) && r.stats.weekendDays === 4 && r.stats.overnight === 1 && r.stats.houses === 2);
check('year to date runs Jan 1 through the last report date and leaves out rejected shifts and later periods',
  near(r.ytd.hours, 96.5) && near(r.ytd.ot, 16.5) && near(r.ytd.gross, 1466.5));
check('shifts typed in by the office are labelled as coming from the time log sheet', srSourceLabel('manual') === 'Time log' && srSourceLabel(undefined) === 'Time log' && srSourceLabel('clock_in') === 'Clock');
const wl = srWeekLines(r, r.weeks[1], true);
check('"List every day" gives all 7 days of week 2: 3 shifts and 4 days with nothing worked', wl.length === 7 && wl.filter(l => l.kind === 'shift').length === 3 && wl.filter(l => l.kind === 'off').length === 4);
check('a day covered by approved time off says so; a pending request does not',
  /Time off/.test(wl.find(l => l.date === '2026-10-07').text) && wl.find(l => l.date === '2026-10-09').text === 'Off');
check('without "List every day" only real shifts are listed', srWeekLines(r, r.weeks[1], false).length === 3);
const d1 = srBuildStaffReport(dj, '2026-09-29', '2026-09-29', computeShiftsWithOT());
check('a single-date report holds just that day\u2019s shift (8 hrs at William House)', d1.rows.length === 1 && near(d1.totals.hours, 8) && d1.houses[0].name === 'William House' && d1.weeks.length === 1);
check('a single-date report with every day listed shows exactly one line', srWeekLines(d1, d1.weeks[0], true).length === 1);
const d0 = srBuildStaffReport(dj, '2026-10-07', '2026-10-07', computeShiftsWithOT());
check('a single date with nothing worked gives zero hours and one time-off line', d0.totals.hours === 0 && srWeekLines(d0, d0.weeks[0], true).length === 1 && /Time off/.test(srWeekLines(d0, d0.weeks[0], true)[0].text));

// ───────────────────────── Per house, and who worked at other houses ─────────────────────────
console.log('\nPer house, and staff who worked at other houses:\n');
const allNow = computeShiftsWithOT();
const fullDJ = srBuildStaffReport(dj, '2026-09-26', '2026-10-09', allNow);
const gabOnly = srBuildStaffReport(dj, '2026-09-26', '2026-10-09', allNow, 'Gabriella House');
const wilOnly = srBuildStaffReport(dj, '2026-09-26', '2026-10-09', allNow, 'William House');
check('"only this house" keeps just the shifts worked there (1 shift, 8 hrs at William House)', wilOnly.rows.length === 1 && near(wilOnly.totals.hours, 8) && wilOnly.houses.length === 1 && wilOnly.onlyHouse === 'William House');
check('the two houses add back up to the full timesheet (hours and pay)', near(gabOnly.totals.hours + wilOnly.totals.hours, fullDJ.totals.hours) && near(gabOnly.totals.gross + wilOnly.totals.gross, fullDJ.totals.gross));
check('overtime in a one-house view is still the overtime payroll worked out on the whole period, not recalculated', near(gabOnly.totals.ot + wilOnly.totals.ot, fullDJ.totals.ot) && near(gabOnly.totals.ot, 16.5));
check('hours by house now carry regular and overtime separately', near(fullDJ.houses.find(h => h.name === 'Gabriella House').reg + fullDJ.houses.find(h => h.name === 'William House').reg, 80) && near(fullDJ.houses.find(h => h.name === 'Gabriella House').ot, 16.5));
const homeOnly = srBuildStaffReport(STAFF[1], '2026-09-26', '2026-10-09', allNow);        // Alfred: home William House, worked only there
const visitor = srBuildStaffReport({ id: 'S001', first: 'Alfred', last: 'Erzondah', loc: 'Gabriella House', status: 'Active' }, '2026-09-26', '2026-10-09', allNow); // same shifts, different home
const cross = srHouseCrossover([fullDJ, homeOnly, r5]);
check('lists the person who worked at their home house and one other', cross.length === 1 && cross[0].staff.id === 'S003' && cross[0].houses.length === 2);
check('home house is listed first and the other house is marked as not home', cross[0].houses[0].home === true && cross[0].houses[1].name === 'William House' && cross[0].houses[1].home === false);
check('splits the hours into home and other (88.5 and 8)', near(cross[0].homeHours, 88.5) && near(cross[0].awayHours, 8) && near(cross[0].total.hours, 96.5));
check('someone who only worked at their home house, or did not work at all, is left off', !cross.some(c => c.staff.id === 'S001' || c.staff.id === 'S099'));
check('someone who worked ONLY at a house that is not their home is still listed', srHouseCrossover([visitor]).length === 1 && near(srHouseCrossover([visitor])[0].awayHours, 8) && near(srHouseCrossover([visitor])[0].homeHours, 0));

// ───────────────────────── By house: each house, each date, who worked ─────────────────────────
console.log('\nBy house (each house, each date, who worked):\n');
const hd = srBuildHouseDays([fullDJ, homeOnly, r5]);
const gab = hd.find(h => h.house === 'Gabriella House'), wil = hd.find(h => h.house === 'William House');
check('one entry per house that has shifts, in name order', hd.length === 2 && hd[0].house === 'Gabriella House' && hd[1].house === 'William House');
check('every date worked at the house is listed once, in order', gab.days.length === 9 && gab.days[0].date === '2026-09-26' && gab.days.every((d, i) => i === 0 || d.date > gab.days[i - 1].date));
check('house hours are right and leave the rejected shift out (88.5 at Gabriella)', near(gab.totals.hours, 88.5) && gab.totals.shifts === 8 && gab.totals.rejected === 1);
check('the rejected shift is still listed on its date, but that date counts no staff or hours', gab.days.find(d => d.date === '2026-10-01').lines.length === 1 && gab.days.find(d => d.date === '2026-10-01').staff === 0 && gab.totals.days === 8);
check('a date shows everyone who worked there, with visitors marked as not from this house',
  wil.days.find(d => d.date === '2026-09-28').lines[0].staff.id === 'S001' && wil.days.find(d => d.date === '2026-09-28').lines[0].home === true &&
  wil.days.find(d => d.date === '2026-09-29').lines[0].staff.id === 'S003' && wil.days.find(d => d.date === '2026-09-29').lines[0].home === false);
check('staff and visitors are counted per house (William: 2 staff, 1 from another house)', wil.totals.staff === 2 && wil.totals.visitors === 1 && gab.totals.staff === 1 && gab.totals.visitors === 0);
check('all houses together add up to all staff timesheets together', near(hd.reduce((a, h) => a + h.totals.hours, 0), fullDJ.totals.hours + homeOnly.totals.hours) && near(hd.reduce((a, h) => a + h.totals.ot, 0), fullDJ.totals.ot + homeOnly.totals.ot));
check('choosing one house returns just that house', srBuildHouseDays([fullDJ, homeOnly], 'William House').length === 1 && near(srBuildHouseDays([fullDJ, homeOnly], 'William House')[0].totals.hours, 16));
check('no shifts gives no houses, not an error', srBuildHouseDays([r5]).length === 0 && srBuildHouseDays([]).length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
