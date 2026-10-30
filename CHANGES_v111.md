# v111 — Overtime: assigned house first, then any house

## What I changed
I changed how the ASO Time System works out overtime and the pay rate when someone works away from their own house.

**Overtime (the default setting, "Assigned house first"):**
- Only hours worked at a staff member's **assigned (home) house** — their Primary Location on the Staff Register — count toward the 80 hours in a pay period.
- Hours at other houses do not count toward the 80.
- Once the 80 is reached at the home house, **every further hour in that pay period is overtime, at any house**, including another house.
- A staff member with no assigned house has every house counted.
- The other setting, "All houses combined", still adds all houses together, the same as before.

**Pay rate:**
- At the home house, a shift is paid at the staff member's own pay rate from the Staff Register (the house rate if they have none). This is the same as before.
- At **any other house**, a shift is now paid at **that house's rate** from the Locations page (their own rate if that house has no rate).
- Overtime is that rate times the house's OT multiplier.

## Where you see it
- Timesheet Log: the column is now **Home House Hrs** (running hours at the home house — the hours that count toward the 80). The line under the title reads "OT threshold: 80 hrs per 14-day period at the assigned house first, then any house".
- Pay Period Setup → Overtime Counted: the first choice is now **Assigned house first (80 hrs at home house, then any house)**.
- Staff Timesheet Report: the Overtime box reads "after 80 hrs at home house"; the other-houses note, the review note and the "worked at more than one house" page state the new rule.
- Report Builder: the running-hours column is now "Running Hrs at Home House".
- Every page that shows pay (Dashboard, Pay Period Report, Monthly Report, OT Leaderboard, Report Builder, Staff Timesheet Report, ADP pay effect) uses the new calculation, including for past periods.

## Files changed
- `ASO_OT_SYSTEM_SQL.html` — new `shiftPayRate()`; `computeShiftsWithOT()` rewritten for the new rule; labels and report wording.
- `test-staff-report.js` — checks updated for the new rule, plus 6 new checks (an away shift before 80 is regular at the other house's rate; the shift that reaches exactly 80 has no overtime; an away shift after 80 is all overtime at that house's rate × 1.5; a home shift after 80 is overtime at the own rate × 1.5; away hours do not raise the home-house total; no assigned house counts every house).
- No change to `server.js`, the database, or `patch_html.py` (the sync check still passes).

## Tests
- test-staff-report.js: 101 passed, 0 failed
- test.js: 119 passed · test-adp-match.js: 108 · test-shift-checks.js: 20 · test-meal-breaks.js: 8 · test-payroll-inactive-interaction.js: 9 · test-tax-brackets.js: 7 — all 0 failed

## Things I need to decide (not code)
- **Lead Staff, Office and similar.** Staff whose Primary Location is "Lead Staff" or "Office" now get the house's rate whenever they work a shift at a house, and their house hours never count toward their 80 (their home is not a house). For example, a $20/hr Lead Staff working a shift at a $12 house is now paid $12 for it. If Lead Staff should keep their own rate, or count house hours toward overtime, I need to say so and it is a small code change.
- **Primary Location must be right.** Overtime now depends on it. I check every staff member's Primary Location on the Staff Register.
- **Wage law.** Federal and Pennsylvania rules usually count all hours worked for one employer together and count overtime by the workweek. This rule is a company decision; I confirm it with my payroll provider or employment attorney. Official and final payroll is run using ADP.
