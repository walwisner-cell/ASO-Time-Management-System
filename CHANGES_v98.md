# Trothen v98: three more checks, and the rest of the customer-facing Spanish

## What I asked for
Continue fixing all gaps.

## What was done
After v97 nothing was left on the open list that code alone could close, so this round looked for gaps a different way: by using the site from start to finish, instead of checking one feature at a time. Three checks were run. Two found nothing wrong. The third finished the Spanish.

## 1. A brand-new site, walked from start to finish
Claude started an empty copy of the site in live mode, exactly as Render would, and went through it using only what a real person can reach: 34 steps.

- **Owner setup:** the first super admin is created at startup; the password is accepted; a sign-in code is required; the dashboard is blocked until the owner sets their own password; then it opens.
- **Sign-up:** a customer and a pro in Monrovia sign up with an email code.
- **The rules hold:** posting a job is refused before agreeing to the terms, and refused again before the ID check.
- **ID check:** both submit an ID and a face photo; the admin sees both in the queue, opens the ID and the face photo, and approves them.
- **Getting found:** the pro adds a photo, shares a base location, and appears in the public search marked "New on Trothen".
- **The job:** the customer posts a job with a pin and a landmark; the pro is matched and sees "1.5 mi" but not the pin; says yes; the customer sees the candidate and hires them; only then does the pro see the pin and landmark; the pro confirms.
- **The day:** the agreement PDF downloads; the pro taps On My Way; the phone sends a live position; the customer's tracking shows "on the way, 0.49 mi away"; the pro taps Arrived; the customer marks it complete.
- **Money:** the pro requests a payout: $30 less 13% commission = $26.10.
- **After:** the pro's score is provisional with 4 jobs to go; the customer downloads their data; the account-closing check answers; the Go-Live checklist loads.

**Every step did what it should.** No fix was needed. (Two steps first looked wrong because the test itself sent the wrong field names; with the right names they passed.)

## 2. Every screen at phone width
Claude opened the homepage, every dashboard section for a customer, a pro and the super admin, and the newer windows (Post a Job, the map picker, the trip window, the privacy policy, the split-dispute window) on a phone-sized screen, and checked for anything spilling off the side. **Nothing did.**

## 3. The rest of the customer-facing Spanish
v97 left three customer-facing screens in English. They are now in Spanish too:
- **The ID upload form:** the three progress labels, every field label, the instructions under each upload, the privacy note and the button.
- **"Your data and your account"** in Settings, including Download my data.
- **The Close my account window.**

That is 28 more pieces, 126 in all across v97 and v98.

**Still English when Español is chosen**
- Messages that come from the server, such as "You have 1 booking still in progress" in the close-account window, and error messages generally.
- Everything in Admin, and the split-dispute window.
- The Terms of Service and Privacy Policy documents.
- As before: the Spanish should be read once by a native speaker.

## Where this leaves things
Three rounds in a row have now looked for gaps in different ways (reading back the open list, attacking the new code, and using the site end to end). The last round found nothing broken. More rounds from here are unlikely to find much, because what is left can't be seen from a test machine:
- whether street maps and place search load on the live site
- whether Google sign-in works under the security policy
- how GPS behaves on real phones in Liberia
- whether real email and text codes arrive

Those need a deploy and a few real phones.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 22159 |  |
| public\index.html | 1291808 | changed in v98 |
| public\vendor\leaflet\leaflet.js | 147552 |  |
| public\vendor\leaflet\leaflet.css | 14806 |  |
| public\vendor\leaflet\LICENSE.txt | 1395 |  |
| src\auth.js | 9391 |  |
| src\platform-settings.js | 32385 |  |
| src\validators.js | 17730 |  |
| src\terms.js | 1245 |  |
| src\plan-billing.js | 7530 |  |
| src\id-retention-scheduler.js | 3810 |  |
| src\location-retention-scheduler.js | 3033 |  |
| src\admin-scope.js | 1690 |  |
| src\file-crypto.js | 2776 |  |
| src\backup-scheduler.js | 2385 |  |
| src\account-privacy.js | 9320 |  |
| src\go-live.js | 16626 |  |
| src\provider-score.js | 16908 |  |
| src\provider-score-scheduler.js | 5463 |  |
| src\top-scorer-promotion-scheduler.js | 3512 |  |
| src\document-expiry-scheduler.js | 3645 |  |
| src\pdf-report-builder.js | 7045 |  |
| src\routes\admin.routes.js | 217748 |  |
| src\routes\marketplace.routes.js | 131566 |  |
| src\routes\payments.routes.js | 66639 |  |
| src\routes\auth.routes.js | 81162 |  |
| src\routes\misc.routes.js | 58853 |  |
| src\routes\portfolio.routes.js | 12210 |  |

Only public\index.html changed in this version.

## Deploy (cmd.exe, not PowerShell)
0. If I haven't deployed v95 yet, read "Important before I deploy" in CHANGES_v95.md first (the 30-day ID retention).
1. Unzip trothen-v98-files.zip.
2. From the unzipped folder (replace the path with my repo folder). The mkdir line is harmless if the folder exists:
   ```
   set REPO=C:\path\to\trothen-backend
   mkdir "%REPO%\public\vendor\leaflet"
   copy /Y server.js "%REPO%\server.js"
   copy /Y public\index.html "%REPO%\public\index.html"
   copy /Y public\vendor\leaflet\leaflet.js "%REPO%\public\vendor\leaflet\leaflet.js"
   copy /Y public\vendor\leaflet\leaflet.css "%REPO%\public\vendor\leaflet\leaflet.css"
   copy /Y public\vendor\leaflet\LICENSE.txt "%REPO%\public\vendor\leaflet\LICENSE.txt"
   copy /Y src\auth.js "%REPO%\src\auth.js"
   copy /Y src\platform-settings.js "%REPO%\src\platform-settings.js"
   copy /Y src\validators.js "%REPO%\src\validators.js"
   copy /Y src\terms.js "%REPO%\src\terms.js"
   copy /Y src\plan-billing.js "%REPO%\src\plan-billing.js"
   copy /Y src\id-retention-scheduler.js "%REPO%\src\id-retention-scheduler.js"
   copy /Y src\location-retention-scheduler.js "%REPO%\src\location-retention-scheduler.js"
   copy /Y src\admin-scope.js "%REPO%\src\admin-scope.js"
   copy /Y src\file-crypto.js "%REPO%\src\file-crypto.js"
   copy /Y src\backup-scheduler.js "%REPO%\src\backup-scheduler.js"
   copy /Y src\account-privacy.js "%REPO%\src\account-privacy.js"
   copy /Y src\go-live.js "%REPO%\src\go-live.js"
   copy /Y src\provider-score.js "%REPO%\src\provider-score.js"
   copy /Y src\provider-score-scheduler.js "%REPO%\src\provider-score-scheduler.js"
   copy /Y src\top-scorer-promotion-scheduler.js "%REPO%\src\top-scorer-promotion-scheduler.js"
   copy /Y src\document-expiry-scheduler.js "%REPO%\src\document-expiry-scheduler.js"
   copy /Y src\pdf-report-builder.js "%REPO%\src\pdf-report-builder.js"
   copy /Y src\routes\admin.routes.js "%REPO%\src\routes\admin.routes.js"
   copy /Y src\routes\marketplace.routes.js "%REPO%\src\routes\marketplace.routes.js"
   copy /Y src\routes\payments.routes.js "%REPO%\src\routes\payments.routes.js"
   copy /Y src\routes\auth.routes.js "%REPO%\src\routes\auth.routes.js"
   copy /Y src\routes\misc.routes.js "%REPO%\src\routes\misc.routes.js"
   copy /Y src\routes\portfolio.routes.js "%REPO%\src\routes\portfolio.routes.js"
   copy /Y CHANGES_v8*.md "%REPO%\"
   copy /Y CHANGES_v9*.md "%REPO%\"
   ```
3. Check the sizes against the table:
   ```
   cd /d "%REPO%"
   for %I in (server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md CHANGES_v94.md CHANGES_v95.md CHANGES_v96.md CHANGES_v97.md CHANGES_v98.md
   git commit -m "v98: end-to-end and phone-width checks; Spanish for ID form, data and close-account"
   git push
   ```
5. After Render finishes, the checks that matter are the four listed under "Where this leaves things".
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
