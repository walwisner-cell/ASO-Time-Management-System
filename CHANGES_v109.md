# v109 — Overtime counted per house

## What I changed
To qualify for overtime, a staff member has to work 80 hours or more at one house in the pay period. Hours worked at other houses are paid at the regular rate and stated on the report, but they are not added together for overtime.

Example (the case I sent): 80.00 hrs at Benjamin House and 27.60 hrs at William House.
- Before: 107.60 hrs worked, 80.00 regular, 27.60 overtime.
- Now: 107.60 hrs worked, 107.60 regular, 0.00 overtime. The sheet states "Hours at other houses — William House: 27.60 hrs (3 shifts)".
- If someone works 88.5 hrs at one house and 8 at another, the 8.5 hrs past 80 at the first house are overtime; the 8 hrs at the other house are regular.

## Where it shows
- **Payroll, Timesheet Log, Pay Period Report, pay stubs** — all use the same overtime engine, so they all follow the per-house rule. The running-hours column now says "Running Hrs at This House".
- **Staff Timesheet Report** — the Overtime box says "after 80 hrs at one house". Right under the boxes, the hours at other houses show as their own row of boxes, styled like the summary boxes: the house name in bold, the hours in large type, and the shifts and days underneath. On an "only hours worked at [house]" sheet it says how many hours the person also worked elsewhere and that those hours do not count toward overtime at this house. Hours by house now shows Regular and OT for each house. The times-only copy, the PDF and the CSV ("Hours at other houses" column) carry the same information.
- **Staff Who Worked at More Than One House** page — its note now explains the per-house rule.
- **Items to review** — when the houses added together would have given more overtime, I see both numbers, for example: "Each house is counted on its own, so 0.00 overtime hrs are paid. With all houses added together it would be 27.60 overtime hrs." This changes no pay.

## Total hours worked
The first box on each sheet is now called **Total hours worked** and is always the total of every shift at every house in these dates. On a full sheet it says "all houses" under the number. On an "only hours worked at [house]" sheet it still shows the total of all shifts, with "80.00 here + 27.60 other" underneath; the Regular, Overtime and Pay boxes on that sheet are for that house.

## Also removed
The Staff Timesheet Report no longer marks shifts "Edited" or lists "shift was edited after it was first entered" under Items to review. Corrections made from ADP punches are still noted, with the time the time log sheet originally said. Every edit is still recorded in the Audit Trail.

## The setting
Pay Period Setup → **Overtime Counted**: "At each house separately" (now the default) or "All houses combined" (the old way). Only an admin can change it, the same as the OT threshold. It is saved in the database (new column `pay_config.ot_by_location`, added automatically on start).

## Something I need to settle outside the software
Federal law (FLSA) and the Pennsylvania Minimum Wage Act generally count all hours worked for the same employer in a workweek together, no matter which location they were worked at, and require overtime after 40 hours in the workweek. The 80-hours-in-14-days arrangement is a narrow exception for certain care facilities, and it also requires overtime after 8 hours in a day. Counting each house separately can mean paying less overtime than the law requires. The software now does what I asked, and the review line shows the difference on every affected timesheet, but whether ASO can pay this way is a question for my payroll provider or an employment attorney. I can switch back to "All houses combined" in one click.

## How I checked it
- `node test-staff-report.js` — 78 checks (15 new for the per-house rule, including the hand-calculated pay).
- `node test.js` — 117 checks. `node test-adp-match.js` — 108. `node test-payroll-inactive-interaction.js` — 9. `node test-meal-breaks.js` — 8. `node test-tax-brackets.js` — 7.
- In a real browser: 80 hrs at Benjamin + 27.60 at William gives 0.00 OT with the William hours stated; switching the setting to "All houses combined", saving, and logging in again gives 27.60 OT, so the setting survives a reload.
