// Standalone test for meal-break compliance-warning detection. Extracts the
// exact functions straight from the live HTML file each run, so this can
// never silently drift from what actually ships.
const fs = require('fs');
const path = require('path');

function extractFunctions(names) {
  const html = fs.readFileSync(path.join(__dirname, 'ASO_OT_SYSTEM_SQL.html'), 'utf8');
  const chunks = [];
  for (const name of names) {
    const m = html.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{`));
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

eval(extractFunctions(['calcClockHours', 'clockEntryMissingMealBreak', 'shiftMissingMealBreak']));

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

console.log('Meal-break compliance-warning detection:\n');

global.PAY_CONFIG = { mealBreakThresholdHours: 5 };

global.CLOCK_ENTRIES = [];
global.CLOCK_BREAKS = [];
const entry1 = { id: 'CE1', clockInDate: '2026-08-03', clockInTime: '08:00', clockOutDate: '2026-08-03', clockOutTime: '14:00' };
check('a 6-hour entry with no meal break warns', clockEntryMissingMealBreak(entry1) === true);

global.CLOCK_BREAKS = [{ clockEntryId: 'CE1', breakType: 'meal', endTime: '12:30' }];
check('the same entry with a completed meal break does not warn', clockEntryMissingMealBreak(entry1) === false);

global.CLOCK_BREAKS = [];
const entry3 = { id: 'CE3', clockInDate: '2026-08-03', clockInTime: '08:00', clockOutDate: '2026-08-03', clockOutTime: '12:00' };
check('a 4-hour entry (below threshold) does not warn even with no break', clockEntryMissingMealBreak(entry3) === false);

const entry4 = { id: 'CE4', clockInDate: '2026-08-03', clockInTime: '08:00', clockOutDate: null, clockOutTime: null };
check('a still-open entry (no clock-out yet) does not warn', clockEntryMissingMealBreak(entry4) === false);

global.CLOCK_BREAKS = [{ clockEntryId: 'CE1', breakType: 'rest', endTime: '12:15' }];
check('a rest break alone does not satisfy the meal-break requirement', clockEntryMissingMealBreak(entry1) === true);

global.CLOCK_BREAKS = [{ clockEntryId: 'CE1', breakType: 'meal', endTime: null }];
check('an incomplete (never-ended) meal break does not count as taken', clockEntryMissingMealBreak(entry1) === true);

global.CLOCK_ENTRIES = [];
const manualShift = { id: 'SH1', source: 'manual' };
check('a manually-entered shift is never flagged (no break data exists to check)', shiftMissingMealBreak(manualShift) === false);

global.CLOCK_BREAKS = [];
global.CLOCK_ENTRIES = [{ id: 'CE1', shiftId: 'SH2', clockInDate: '2026-08-03', clockInTime: '08:00', clockOutDate: '2026-08-03', clockOutTime: '14:00' }];
const clockShift = { id: 'SH2', source: 'clock_in' };
check('a clock-derived shift correctly reverse-looks-up its clock entry and warns', shiftMissingMealBreak(clockShift) === true);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
