// Standalone test for how buildPayrollDetailRows() handles Salary and
// External staff who are marked Inactive. Extracts the exact functions
// straight from the live HTML file each run, so this can never silently
// drift from what actually ships.
//
// Background: these pay types have no shift records at all by design, so
// the original implementation filtered row-generation to Active staff only
// — which meant an Inactive salaried or externally-paid person's pay
// vanished from the payroll screen completely, with no row, no $0, no
// warning, nothing. That's worse than the silent-inclusion bug the whole
// inactive-staff-flag system exists to prevent. These tests lock in the fix:
// Inactive staff of either pay type still get a row (so it's visible), pay
// is held at $0 with a "needs review" flag until an admin explicitly
// approves it, and approving correctly releases the real amount.
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

eval(extractFunctions([
  'buildPayrollDetailRows', 'excludeInactiveUnapproved', 'computeShiftsWithOT',
  'getLocRate', 'getLocOTMult', 'getLocOTRate', 'getPeriodForDate', 'fmtPeriod'
]));

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}`); }
}

console.log('Payroll: Salary/External pay types interacting with Inactive-staff review:\n');

global.PAY_CONFIG = { anchorDate: '2026-08-01', periodDays: 14, otThreshold: 80 };
global.LOCATIONS = [{ name: 'Usene House', rate: 12, mult: 1.5, rateHistory: [] }];
global.APPROVED_EXCEPTIONS = [];
global.SHIFTS = [];
global.STAFF = [
  { id: 'SEXTINACT', first: 'External', last: 'Inactive', rate: 20, loc: 'Usene House', status: 'Inactive', payType: 'external' },
  { id: 'SSALINACT', first: 'Salary', last: 'Inactive', rate: 0, loc: 'Usene House', status: 'Inactive', payType: 'salary', salaryAmount: 3000 },
  { id: 'SSALACTIVE', first: 'Salary', last: 'Active', rate: 0, loc: 'Usene House', status: 'Active', payType: 'salary', salaryAmount: 2000 },
];
global.EXTERNAL_PAYROLL_ENTRIES = [
  { staffId: 'SEXTINACT', periodStart: '2026-08-01', hours: 80, amount: 1600, notes: 'from other program' }
];

const label = 'Aug 1 \u2013 Aug 14, 2026 (Bi-Weekly)';

global.window = { _inactiveFlagsCache: [] };
let rows = buildPayrollDetailRows(label, '2026-08-01');
let extRow = rows.find(r => r.staffId === 'SEXTINACT');
let salRow = rows.find(r => r.staffId === 'SSALINACT');
let activeSalRow = rows.find(r => r.staffId === 'SSALACTIVE');

check('an Inactive External staff member with an entry still gets a row (not silently dropped)', !!extRow);
check('...and it correctly shows $0, flagged for review, until approved', extRow && extRow.gross === 0 && extRow.inactiveNeedsReview === true);
check('an Inactive Salary staff member still gets a row (not silently dropped)', !!salRow);
check('...and it correctly shows $0, flagged for review, until approved', salRow && salRow.gross === 0 && salRow.inactiveNeedsReview === true);
check('a normal Active salaried staff member is completely unaffected', activeSalRow && activeSalRow.gross === 2000 && !activeSalRow.inactiveNeedsReview);

global.window = { _inactiveFlagsCache: [
  { staffId: 'SEXTINACT', periodStart: '2026-08-01', status: 'approved' },
  { staffId: 'SSALINACT', periodStart: '2026-08-01', status: 'approved' },
] };
rows = buildPayrollDetailRows(label, '2026-08-01');
extRow = rows.find(r => r.staffId === 'SEXTINACT');
salRow = rows.find(r => r.staffId === 'SSALINACT');
check('once approved, the real External amount flows through correctly', extRow && extRow.gross === 1600 && !extRow.inactiveNeedsReview);
check('once approved, the real Salary amount flows through correctly', salRow && salRow.gross === 3000 && !salRow.inactiveNeedsReview);

global.window = { _inactiveFlagsCache: [
  { staffId: 'SEXTINACT', periodStart: '2026-08-01', status: 'denied' },
] };
rows = buildPayrollDetailRows(label, '2026-08-01');
extRow = rows.find(r => r.staffId === 'SEXTINACT');
check('an explicitly denied flag still holds pay at $0 (denied is not the same as approved)', extRow && extRow.gross === 0 && extRow.inactiveNeedsReview === true);

// An Inactive External staff member with NO entry at all for this period —
// nothing was ever configured, so there's genuinely nothing to flag or pay.
global.window = { _inactiveFlagsCache: [] };
global.EXTERNAL_PAYROLL_ENTRIES = [];
rows = buildPayrollDetailRows(label, '2026-08-01');
const noEntryRow = rows.find(r => r.staffId === 'SEXTINACT');
check('an Inactive External staff member with no entry at all is correctly omitted (nothing to review)', !noEntryRow);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
