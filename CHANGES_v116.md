# v116 — One timesheet per person, under the house they are assigned to

This update also includes v115 (Office staff sign their own timesheet).

## The problem

When I picked a house, the report printed a timesheet for everyone assigned to that house, and also for anyone from another house who had picked up a shift there. That meant a person who worked at two houses got two timesheets in the same pay period, one under each house. There was also an option, "Only hours worked at (house)", that printed a partial timesheet with just that house's shifts.

## What I changed

- **One timesheet per person per pay period.** When I pick a house, I get a timesheet only for the staff **assigned** to that house (their Primary Location).
- **Every timesheet has all the information.** It lists every shift the person worked in the pay period, at every house, with the totals, overtime and signature boxes.
- **Staff from another house who worked here** don't get a timesheet under this house. Their one timesheet prints under their own house, with these shifts on it. They are still shown in "Staff who worked at other houses (for Payroll)" and in the "By house" layout, so the house can still see who covered shifts there.
- **The "Only hours worked at (house)" option is gone.** No more partial timesheets.
- The Staff Member list now reads "All staff assigned to this house with hours", and it only lists staff assigned to that house.
- If I pick "All houses", every person still gets exactly one timesheet, the same as before.

## Something to check

A staff member whose Primary Location is blank, or doesn't match a house, only appears when I pick "All houses". I set every staff member's Primary Location so their timesheet appears under the right house.

## Files

- `ASO_OT_SYSTEM_SQL.html` — the change (includes v115)
- `test-staff-report.js` — includes the v115 Office checks
- `STAFF_TIMESHEET_REPORT.md`, `HANDOFF.md` — notes updated
- `CHANGES_v115.md`, `CHANGES_v116.md`
