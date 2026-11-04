# v114 — Approval line on printed reports is now the Payroll Officer / Supervisor

## What I changed

I changed the approval box at the bottom of the Staff Timesheet Report and the House Time Report. This applies on screen, when printing, and in the PDF.

**Before:** "Program Manager / Supervisor approval". The signature, printed name and date were all blank.

**Now:** "Payroll Officer / Supervisor approval".

- **Printed name** is filled in for you. It is the name of the person signed in to the ASO Time System who printed the report.
- **Date** is filled in for you. It is the date the report was printed (generated).
- **Signature** is still blank so it can be signed by hand.

The wording now says the time was already checked and signed before it was entered:

- Staff report: "These times were verified and signed by the Program Manager / House Supervisor on the employee's time log sheet(s) before they were entered. I have checked them against the schedule and approve them for payroll."
- House report: "These staff, dates and hours were verified and signed by the Program Manager / House Supervisor on the time log sheets before they were entered. I have checked them against the schedule and approve them for payroll."

The "Employee signature: on file" line is unchanged.

In the report options, the tick box is now named "Payroll Officer / Supervisor approval line". It is still on by default.

## Where the printed name comes from

The name and date come from the sign-in of the person who prints. The name is the **Name** on that person's user account. The date is the day they print.

If an account's Name is "Admin", the report prints "Admin". Before v114 there was no way to change the name on an existing account. So I added an **Edit name** button next to each user in the user list. I use it to set the full name (for example "Walter Cecil Wisner") on every account that prints reports. Each rename is recorded in the Audit Trail as "User Renamed".

## Files

- `ASO_OT_SYSTEM_SQL.html` — the approval line, and the Edit name button
- `test-staff-report.js` — 7 new checks for the approval line (109 checks in total)
- `STAFF_TIMESHEET_REPORT.md`, `HANDOFF.md` — notes updated
- `CHANGES_v114.md` — this file
