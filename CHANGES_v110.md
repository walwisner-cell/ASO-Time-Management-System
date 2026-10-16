# v110 — Shift types (1st, 2nd, 3rd, double, normal hours)

## What I added
Every shift now has a shift type:

| Type | Times |
|---|---|
| 1st Shift | 6:00 AM – 2:00 PM |
| 2nd Shift | 2:00 PM – 10:00 PM |
| 3rd Shift | 10:00 PM – 6:00 AM |
| Double Shift (1st + 2nd) | 6:00 AM – 10:00 PM |
| Double Shift (2nd + 3rd) | 2:00 PM – 6:00 AM |
| Double Shift (3rd + 1st) | 10:00 PM – 2:00 PM |
| Normal Hours | 9:00 AM – 5:00 PM (Office, Day Program) |

## Entering a shift
Add Shift and Edit Shift have a new **Shift Type** dropdown before Shift Start. The menu lists only the names (1st Shift, 2nd Shift, 3rd Shift, Double (1st + 2nd), Double (2nd + 3rd), Double (3rd + 1st), Normal Working Hours), not the times, so it is not confusing to whoever is entering data. When I pick a type, the start and end times fill in by themselves and the hours update. If I change the times by hand, the dropdown moves to the matching type, or to "Custom times" when they match none. New shifts start on 1st Shift (6 AM – 2 PM) instead of 8 AM – 4 PM.

## How a shift gets its type
The type is worked out from the shift's times every time it is shown, so shifts I entered before this update, edited shifts and ADP-corrected shifts are all labelled. Nothing new is stored.
- A start up to 90 minutes away from 6 AM, 2 PM or 10 PM still counts (6:20 AM – 2:05 PM is a 1st shift; 7 AM – 3 PM is a 1st shift). About 8 hours (6½ to 9½) is one shift; about 16 hours (14½ to 17½) is a double.
- A start from 8:00 to 10:00 AM lasting about 8 hours is Normal Hours.
- Two back-to-back shifts by the same person, entered separately (for example 6 AM – 2 PM and then 2 PM – 10 PM), are both labelled **Double Shift (1st + 2nd)**. A rejected shift is never joined into a double.
- Anything else (for example 12 PM – 4 PM) is "Other hours".

## Where I see it
- **Timesheet Log** — under the times on each row (blue for 1st/2nd/3rd, orange for doubles, green for normal hours).
- **My Shifts** (employee view) — the same label.
- **Staff Timesheet Report** — a new **Shift** column after Date on the full report and the times-only copy, a "Shifts by type" count in the at-a-glance line (a double entered as two shifts counts once), and the type next to each name on the by-house sheets. The PDF and the CSV (Shift column) have it too.

## What did not change
Pay, overtime and hours are worked out exactly as before. The shift type is a label only.

## How I checked it
- `node test-staff-report.js` — 95 checks (11 new for shift types). `node test.js` — 117. `node test-adp-match.js` — 108. `node test-payroll-inactive-interaction.js` — 9. `node test-meal-breaks.js` — 8. `node test-tax-brackets.js` — 7.
- In a browser: picking each type fills in the right times; typing 9 AM – 5 PM moves the dropdown to Normal Working Hours; the Timesheet Log and Staff Timesheet Report show the labels, including a double made of two back-to-back shifts.
