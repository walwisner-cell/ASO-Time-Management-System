# v120 — role / access changes now reach people who are already signed in

## The problem
Changing a custom role (Roles page → Save Changes), moving a user with Change role, or editing someone's
Timesheet access saved correctly on the server, but a user who was already logged in kept their old
permissions until they logged out and back in. It looked like "Permissions updated" did nothing.

## The fix
The page now re-checks the signed-in user's role, permissions and timesheet access:
- every 60 seconds,
- whenever the browser tab is shown or clicked back into.
If anything changed, a notice appears and the page refreshes itself so the menu, buttons and data match the new access.
Shifts are saved as they are entered, so nothing is lost.

The Roles page toast now says people on the role get the change within a minute.

## Files
ASO_OT_SYSTEM_SQL.html (only file changed), CHANGES_v120.md.
