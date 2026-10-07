# Trothen v90: regional admins can cover a whole country

## What I asked for
"Fix everything" left over from Joseph's list. After v89, three things were open: the regional admin that "is not working", whether regional admins should cover a country, and where a new pro's score should start.

## The regional admin problem, and why I think this is it
I couldn't make the sign-in itself fail (v89). What I found instead is in what the admin sees after signing in.

A regional admin was tied to **one city**, and the system matched that city against the exact text each person typed for "City" when they signed up. So an admin "for Monrovia" only saw people whose city was written exactly "Monrovia". Someone who typed "monrovia", "Paynesville" or "Gbarnga" was invisible to them. A new admin opens the dashboard, sees almost nobody, and it looks broken. Joseph also said the award should be "in a country, not region", which is the same way of thinking.

## What I changed
**A regional admin can now cover a whole country.**
- When I create an admin (Admin → Locations & Admins), there is a new choice, "This admin covers":
  - **The whole country** (chosen by default): they see and manage every customer and pro in that country, whatever city each person typed.
  - **Only the one city**: the old behavior.
- For admins that already exist, the cities table has a new "Covers" column with a button: **Make country-wide** or **Limit to this city**. Nothing changes for an existing admin until I press it.
- A country-wide admin's dashboard is headed with the country ("Region Overview — Liberia").
- Everything a regional admin does follows the same rule: people, approvals, ID reviews, pro scores, disputes, fraud flags, payments, reports, ads, promotions, contact messages and job applications.
- A promotion made by a country-wide admin reaches their whole country.

**City admins got a fix too.** The city match no longer cares about capital letters or stray spaces, so "Monrovia" and "monrovia " are now the same city. Different spellings or different towns are still different.

**What a regional admin still can't do,** country-wide or not: see another country, read access logs, create admins, change site wording or prices, or anything else reserved for the super admin.

## To fix the admin Joseph created
1. Deploy this version.
2. Admin → Locations & Admins → find that admin's row → press **Make country-wide**.
3. Have them sign in again. They should now see everyone in Liberia.
4. Reset their password first (Customers & Providers → Reset password), since the starting one was shared in a chat.

If they still can't get in at all, I need to know which screen it stops on and what it says.

## What I did not change: where a new pro's score starts
A new pro with an approved ID and no jobs starts at about 76 out of 100. I left this alone on purpose. The score isn't only a number on a profile: it also decides how many job matches a pro may be sent each week, and a low score sends a "call this pro" alert to admins. If new pros started at, say, 45, every new pro would be limited to 3 matches a week and would trigger that alert on day one. Lowering the start is possible, but it needs those two rules changed with it, and that is a decision for Joseph and me: what should a new pro start at, and how many jobs a week should a new pro be allowed?

## Tested
On sample data with people in Monrovia, "monrovia ", Paynesville and Gbarnga (Liberia) plus the US, Nigeria and Ghana:
- **Country-wide admin for Liberia:** sees all 5 Liberians and nobody else; suspended a pro in Gbarnga; approved a pending pro; resolved a Liberian dispute; refused on a US customer and a US dispute; payments summary and report builder work; still refused access logs and creating admins.
- **City admin for Monrovia:** sees the 3 people in Monrovia (including the one typed "monrovia "); refused on Gbarnga.
- **An admin created before this change (Atlanta):** sees only Atlanta, exactly as before.
- **Super admin:** created a country-wide admin; a bad coverage value was refused; switched an admin to country-wide and back, and what they could see changed each time.
- Every admin section opened without errors for a country-wide admin, a city admin and the super admin.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 21496 | |
| public\index.html | 1225418 | changed in v90 |
| src\auth.js | 9391 | |
| src\platform-settings.js | 21616 | |
| src\validators.js | 17730 | |
| src\terms.js | 1245 | |
| src\plan-billing.js | 7530 | |
| src\id-retention-scheduler.js | 2249 | |
| src\file-crypto.js | 2776 | |
| src\backup-scheduler.js | 2385 | |
| src\account-privacy.js | 8577 | |
| src\provider-score.js | 15841 | |
| src\provider-score-scheduler.js | 5238 | |
| src\top-scorer-promotion-scheduler.js | 3512 | |
| src\routes\admin.routes.js | 212591 | changed in v90 |
| src\routes\marketplace.routes.js | 122352 | |
| src\routes\payments.routes.js | 61503 | changed in v90 |
| src\routes\auth.routes.js | 81081 | |
| src\routes\misc.routes.js | 58897 | changed in v90 |
| src\routes\portfolio.routes.js | 12210 | |

Four files changed in this version. The rest are the same as v89 and are included so this zip is complete on its own.

## Deploy (cmd.exe, not PowerShell)
1. Unzip trothen-v90-files.zip.
2. From the unzipped folder (replace the path with my repo folder):
   ```
   set REPO=C:\path\to\trothen-backend
   copy /Y server.js "%REPO%\server.js"
   copy /Y public\index.html "%REPO%\public\index.html"
   copy /Y src\auth.js "%REPO%\src\auth.js"
   copy /Y src\platform-settings.js "%REPO%\src\platform-settings.js"
   copy /Y src\validators.js "%REPO%\src\validators.js"
   copy /Y src\terms.js "%REPO%\src\terms.js"
   copy /Y src\plan-billing.js "%REPO%\src\plan-billing.js"
   copy /Y src\id-retention-scheduler.js "%REPO%\src\id-retention-scheduler.js"
   copy /Y src\file-crypto.js "%REPO%\src\file-crypto.js"
   copy /Y src\backup-scheduler.js "%REPO%\src\backup-scheduler.js"
   copy /Y src\account-privacy.js "%REPO%\src\account-privacy.js"
   copy /Y src\provider-score.js "%REPO%\src\provider-score.js"
   copy /Y src\provider-score-scheduler.js "%REPO%\src\provider-score-scheduler.js"
   copy /Y src\top-scorer-promotion-scheduler.js "%REPO%\src\top-scorer-promotion-scheduler.js"
   copy /Y src\routes\admin.routes.js "%REPO%\src\routes\admin.routes.js"
   copy /Y src\routes\marketplace.routes.js "%REPO%\src\routes\marketplace.routes.js"
   copy /Y src\routes\payments.routes.js "%REPO%\src\routes\payments.routes.js"
   copy /Y src\routes\auth.routes.js "%REPO%\src\routes\auth.routes.js"
   copy /Y src\routes\misc.routes.js "%REPO%\src\routes\misc.routes.js"
   copy /Y src\routes\portfolio.routes.js "%REPO%\src\routes\portfolio.routes.js"
   copy /Y CHANGES_v8*.md "%REPO%\"
   copy /Y CHANGES_v90.md "%REPO%\"
   ```
3. Check the sizes against the table:
   ```
   cd /d "%REPO%"
   for %I in (server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md
   git commit -m "v90: regional admins can cover a whole country; v89 review fixes"
   git push
   ```
5. After Render finishes: Admin → Locations & Admins. The cities table should have a "Covers" column, and the create form should have "This admin covers".
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
