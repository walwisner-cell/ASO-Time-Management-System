# v119 — "Timesheet entry only" accounts, limited to chosen houses / staff

## What it does
A custom role with the new **Timesheet entry only** permission gives a user ONLY the Timesheet Log page.
For each such user, an admin picks (Passwords page → **Timesheet access**):
- their own staff record (so they can enter their own time),
- houses: all staff assigned to that house, for shifts worked at that house,
- individual staff, at any house.

The user cannot see or change anyone else's time. They see no pay rates, payroll, users, reports or settings.

## How to set it up
1. Roles & Permissions → tick **Timesheet entry only** (other boxes switch off; "Delete shifts" can stay ticked if wanted) → create the role.
2. Passwords → add the user with that role.
3. Click **Timesheet access** on that user and choose their own record / houses / staff → Save access.

## Enforced on the server (not just hidden)
- Load returns only in-scope staff and their shifts, with rates set to 0; no payroll, users, audit log.
- Save merges only in-scope shifts; anything else is rejected (403). Other staff's data cannot be touched, even by reusing an id.
- Cannot approve their own 24-hour exception, clear a pending approval, or change a payroll-locked period.

## Files
server.js, ASO_OT_SYSTEM_SQL.html, test-entry-scope.js (30 checks), CHANGES_v119.md.
Existing suites unchanged and passing (test.js 119, adp 108, staff report 121, shift checks 20, helper 26).

## Also in v119: Change role
Passwords page → **Change role** on each user moves them to another role without deleting the account
(cannot change your own role; the last admin cannot be demoted). Admin always sees everything, so to limit
someone, change them to a "Timesheet entry only" role, then set their **Timesheet access**.
