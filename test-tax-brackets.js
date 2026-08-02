// Standalone test for federal withholding bracket math. Extracts the exact
// function straight from the live HTML file each run, so this can never
// silently drift from what actually ships. Compares against carefully
// hand-computed values using the real 2026 IRS Publication 15-T numbers.
const fs = require('fs');
const path = require('path');

function extractFunction() {
  const html = fs.readFileSync(path.join(__dirname, 'ASO_OT_SYSTEM_SQL.html'), 'utf8');
  const m = html.match(/function computeFederalWithholding\([^)]*\)\s*\{/);
  if (!m) throw new Error('computeFederalWithholding not found in the live HTML file');
  const start = m.index;
  let depth = 0, end = -1;
  for (let i = m.index + m[0].length - 1; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const constStart = html.lastIndexOf('const FED_TAX_BRACKETS_2026', start);
  return html.slice(constStart, end);
}

eval(extractFunction());

let passed = 0, failed = 0;
function check(name, actual, expected, tolerance) {
  tolerance = tolerance || 0.01;
  const ok = Math.abs(actual - expected) < tolerance;
  if (ok) { passed++; console.log(`  \u2713 ${name} (got $${actual.toFixed(2)})`); }
  else { failed++; console.log(`  \u2717 ${name} \u2014 got $${actual.toFixed(2)}, expected $${expected.toFixed(2)}`); }
}

console.log('Federal withholding bracket math (2026 IRS Pub 15-T):\n');

// 1. Single, biweekly, $1,000/period, no adjustments.
// annual = 26,000; adjusted = 26,000 - 8,600 = 17,400 (falls in $7,500-$19,900, 10% bracket, base $0)
// tentative annual = 0 + (17,400 - 7,500) * 0.10 = 990; per period = 990/26 = 38.0769...
check('Single, biweekly, $1,000/period', computeFederalWithholding(1000, 'biweekly', { filingStatus: 'single' }), 990/26);

// 2. MFJ, biweekly, $2,000/period, no adjustments.
// annual = 52,000; adjusted = 52,000 - 12,900 = 39,100 (falls in $19,300-$44,100, 10% bracket, base $0)
// tentative annual = 0 + (39,100 - 19,300) * 0.10 = 1,980; per period = 1,980/26 = 76.1538...
check('MFJ, biweekly, $2,000/period', computeFederalWithholding(2000, 'biweekly', { filingStatus: 'mfj' }), 1980/26);

// 3. Single, biweekly, $5,000/period (higher earner, crosses into the 24% bracket).
// annual = 130,000; adjusted = 130,000 - 8,600 = 121,400 (falls in $113,200-$209,275, 24% bracket, base $17,966)
// tentative annual = 17,966 + (121,400 - 113,200) * 0.24 = 17,966 + 1,968 = 19,934; per period = 19,934/26 = 766.6923...
check('Single, biweekly, $5,000/period (24% bracket)', computeFederalWithholding(5000, 'biweekly', { filingStatus: 'single' }), 19934/26);

// 4. HoH, biweekly, $1,500/period, with a $2,000 annual Step 3 credit that
// exceeds the tentative withholding entirely — should floor at $0, not go negative.
// annual = 39,000; adjusted = 39,000 - 8,600 = 30,400 (falls in $15,550-$33,250, 10% bracket, base $0)
// tentative annual = 0 + (30,400 - 15,550) * 0.10 = 1,485; per period = 1,485/26 = 57.1153...
// step3 per period = 2,000/26 = 76.9230... which exceeds the tentative amount, so result floors at $0.
check('HoH with Step 3 credit exceeding tentative withholding floors at $0', computeFederalWithholding(1500, 'biweekly', { filingStatus: 'hoh', w4Step3: 2000 }), 0);

// 5. Very low wage: Single, biweekly, $200/period — annualized wage doesn't
// even clear the standard deduction offset, should floor at $0.
// annual = 5,200; adjusted = max(0, 5,200 - 8,600) = 0 (falls in $0-$7,500, 0% bracket)
check('Very low wage floors the adjusted annual wage at $0', computeFederalWithholding(200, 'biweekly', { filingStatus: 'single' }), 0);

// 6. Missing/unrecognized filingStatus defaults to single — should exactly
// match test #1's result.
check('Missing filingStatus defaults to single', computeFederalWithholding(1000, 'biweekly', {}), 990/26);

// 7. Step 4(c) extra withholding is added flat, per period, on top of everything else.
// Same base as test #1 ($38.0769...) plus a flat $25/period.
check('Step 4(c) extra withholding added per period', computeFederalWithholding(1000, 'biweekly', { filingStatus: 'single', w4Step4c: 25 }), (990/26) + 25);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
