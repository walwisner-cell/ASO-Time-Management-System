# v112 — Sign-in page: internal tool notice

## What I changed
I made it clear on the first page of the ASO Time System — the sign-in page — that this is an internal tool for ASO.

- **Sign-in box:** a new orange notice above Username: "INTERNAL TOOL · ASO STAFF USE ONLY — For authorized American Safety Options staff only. Used to calculate the signed time log sheets and match them against ADP. Official and final payroll is run using ADP." It shows on computers and on phones.
- **Left-hand panel:** a badge "Internal tool · ASO staff use only". The title is now "ASO Time System" (it was "Staff Overtime & Payroll System"), and the description no longer says the system runs payroll.
- **Feature list:** the "Payroll & Pay Stubs" line is replaced by "ADP Timecard Match". The Employee Self-Service line no longer mentions pay stubs.
- **Browser tab:** now reads "ASO Time System — Internal Tool (ASO Staff Use Only)".

## Files changed
- `ASO_OT_SYSTEM_SQL.html` — sign-in page wording and the notice style. Nothing else changed.
- This file also includes everything in v111 (overtime after 80 hrs at the assigned house, then any house). If I have not installed v111 yet, I copy `test-staff-report.js` too.
- No change to `server.js`, the database or `patch_html.py` (the sync check passes).

## Tests
test.js 119 · test-staff-report.js 101 · test-adp-match.js 108 · test-shift-checks.js 20 — all 0 failed.
