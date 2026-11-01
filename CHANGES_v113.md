# v113 — Overtime at another house is paid at the home house rate

## What I changed
I changed the rate used for overtime hours worked at a house that is not the staff member's assigned (home) house.

The full rule is now:
- **Overtime starts** only after 80 hours in the pay period at the staff member's assigned (home) house — their Primary Location on the Staff Register. Hours at other houses do not count toward the 80.
- **After the 80**, every further hour in that pay period is overtime, at any house.
- **Regular hours at the home house:** the staff member's own pay rate (the home house rate if they have none).
- **Regular hours at another house:** that house's rate from the Locations page.
- **Overtime hours at the home house:** the own rate times the home house's OT multiplier.
- **Overtime hours at another house (new):** the **home house's rate** from the Locations page times the home house's OT multiplier. Before this change they were paid at the other house's rate.
- If the home house has no rate set, overtime at another house falls back to that house's rate.

## Where you see it
- Pay Period Setup → Overtime Counted: the help text states the rule.
- Staff Timesheet Report: the other-houses note and the "worked at more than one house" page state the rule.
- Every page that shows pay uses the new calculation, including past periods.

## Files changed
- `ASO_OT_SYSTEM_SQL.html` — overtime rate in `computeShiftsWithOT()`; wording. This file also contains v111 (assigned-house overtime) and v112 (sign-in page internal tool notice).
- `test-staff-report.js` — the away-overtime check now expects the home house rate ($14 × 1.5 = $21/hr, $168 for 8 hrs), plus a new check with different own and home house rates.
- No change to `server.js`, the database or `patch_html.py` (the sync check passes).

## Tests
test-staff-report.js 102 · test.js 119 · test-adp-match.js 108 · test-shift-checks.js 20 · test-meal-breaks.js 8 · test-payroll-inactive-interaction.js 9 · test-tax-brackets.js 7 — all 0 failed.

## Still to decide (business, not code)
- Lead Staff and Office staff are paid the house rate for regular hours at a house, and their house hours do not count toward their 80.
- Each staff member's Primary Location must be correct; it decides overtime and the overtime rate.
- I confirm this overtime approach with my payroll provider or employment attorney. Official and final payroll is run using ADP.
