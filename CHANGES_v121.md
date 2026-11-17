# v121 — Staff Report button for "Timesheet entry only" users

## The problem
On the Timesheet Log, Admin, Supervisor and Viewer accounts see two buttons: **Staff Report** and **Print Timesheet**.
Users on a "Timesheet entry only" role (for example Namiento Brown, Office Staff) only saw **Print Timesheet**.
The Staff Report button was hidden for them on purpose, and the Staff Timesheet Report page was blocked for them.

## The fix
I let "Timesheet entry only" users open the Staff Timesheet Report:
- The **Staff Report** button now shows next to **Print Timesheet** for them.
- **Staff Timesheet Report** now shows in their left menu under Reports.
- The report only lists the staff they are assigned to (their own record, staff picked for them, or staff of the houses picked for them). The server has never sent them anyone else's time, so there is nothing else for the report to show.
- They never see pay. The "Include pay amounts" box is hidden for them, and the server already sends their staff's rates as zero.
- They still cannot open any other page (Dashboard, Approvals, Payroll, other reports and so on).

The Roles page and the "Timesheet access" box now say "Timesheet Log and Staff Report" so the wording matches.

## Checked
I ran the system with an Office Staff user linked to her own staff record: the button shows, it opens her timesheet with her hours only, no pay, and no errors. The existing timesheet-entry tests still pass (30 passed, 0 failed).

## Files
ASO_OT_SYSTEM_SQL.html, STAFF_TIMESHEET_REPORT.md, CHANGES_v121.md.
