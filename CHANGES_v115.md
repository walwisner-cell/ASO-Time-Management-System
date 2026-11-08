# v115 — Office staff sign their own timesheet, with a separate Payroll approval

## What I changed

This only affects staff whose home location is the **Office**. Their printed Staff Timesheet Report (screen, print and PDF) now has two signature boxes at the bottom:

1. **Employee — Office**
   - Wording: "I work at the Office. The times on this timesheet are a true and complete record of the time I worked. Pay period: (dates)."
   - **Printed name:** filled in automatically with the staff member's own name.
   - **Date:** filled in automatically with the date the report is printed.
   - **Signature:** blank. The office staff member signs it.

2. **Payroll approval**
   - Wording: "I have checked these hours and approve them for payroll."
   - Signature, printed name and date are all blank. Payroll fills these in by hand.

Office staff sign on the report itself, so their report no longer shows the "Employee signature: on file" line.

## What did not change

- **Staff at the houses** keep the v114 box: "Payroll Officer / Supervisor approval". It shows the signed-in person's name and the print date, plus the "Employee signature: on file" line.
- The House Time Report is unchanged.

## How the system knows who is Office staff

It looks at each staff member's **Primary Location**. If that location's name contains the word "Office", the person gets the Office boxes. To move someone onto or off the Office layout, I change their Primary Location on their staff record.

## Files

- `ASO_OT_SYSTEM_SQL.html` — the change
- `test-staff-report.js` — 8 new checks for Office staff (117 checks in total)
- `STAFF_TIMESHEET_REPORT.md`, `HANDOFF.md` — notes updated
- `CHANGES_v115.md` — this file
