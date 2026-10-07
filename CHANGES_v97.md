# Trothen v97: a second gap check, and Spanish for the new screens

## What I asked for
Fix all gaps. After v96 the only item left that code could close was Spanish for the screens added this month. Claude did that, and also re-checked this month's new code for the two kinds of problem found in earlier rounds.

## 1. Re-check: text people type that could run as code

Every feature added since the last full sweep takes typed text: landmarks, addresses, job descriptions, place names from the map search, closing-account reasons. Claude planted hostile text in every one of those fields and opened every screen as a visitor, a customer, a pro and the super admin, including the trip window, the map picker with a hostile place name coming back from the search, the ID viewer and the new admin panels.

**It found two real spots, both in the customer's own dashboard:**
- **My Bookings:** the "Budget" badge on a job request printed the budget exactly as typed.
- **Payments:** the "Address" line in a payment's details printed the booking address exactly as typed.

In both, the text a customer typed ran in that customer's own browser. That is a weaker problem than text running in someone else's browser, but it is the same class of fault and it's fixed.

**Nine more spots were tightened** that the sweep hadn't triggered but which printed a stored value without protection: a job's category (which can be typed by the customer when they choose "Other"), a pro's role line, category and city names in drop-downs, and an admin's role.

After the fixes the sweep was clean for all four kinds of user.

## 2. Re-check: who can reach what

Claude called every address added from v89 to v96 as six different people: nobody signed in, a customer, a pro, an HR admin, a city admin and the super admin. Fifteen addresses, ninety calls. **Every one answered correctly.** Examples:
- Editing the Privacy Policy, changing an admin's coverage, the Go-Live status, backups, the plan fee and closed accounts: super admin only.
- Past ID checks: verification staff and city admins, not HR.
- A trip's live position: only the customer and the pro on that booking. Even admins are refused.
- Sending a live position: only that booking's pro.
Nothing needed fixing here.

## 3. Spanish for the screens added this month

**What is now in Spanish** when a visitor chooses Español:
- **The agreement screen at sign-in:** the title, the introduction, every promise and its explanation (6 for customers, 7 for pros), the Terms of Service line, the privacy line, the small print, the box counter and the button. This is the one that mattered most: people were being asked to agree to promises in a language they hadn't chosen.
- **"Where is the job?":** the whole block on Post a Job and Book a Pro, the map picker, the status messages while finding a location, and the error messages.
- **The trip:** the "Track your pro" and "Trip map" buttons, the pro's agreement to share location, the sharing bar, and the trip window (who is coming, distance, how fresh the position is, the links).
- "New on Trothen" on a pro's card.

Ninety-eight pieces of text in all. Where a piece has no Spanish yet, the English shows; nothing goes blank.

**What is still English only**
- The ID upload form and the "verify your identity" prompt.
- "Download my data" and "Close my account".
- The Provider Plans page details, the split-dispute window and everything in Admin.
- The Terms of Service and the Privacy Policy themselves. Those are legal documents and should be translated by a person, then pasted into Admin if I want Spanish versions.
- French, Portuguese and the other languages in the menu. They were never switched on in the page.

**The Spanish needs a native reader.** Claude wrote it carefully in neutral Latin American Spanish, but the agreement promises are commitments people make. Someone who speaks Spanish natively should read them once before I rely on them. "Held in escrow" is translated as "se retiene en depósito".

## Tested
- Hostile-text sweep: clean after the fixes, for a visitor, customer, pro and super admin.
- Access: 90 calls across 15 addresses and 6 kinds of person, all correct.
- Spanish: for a customer and a pro, the agreement screen showed every promise in Spanish, the counter read "Marca las 6 casillas para continuar", then "Falta 1 casilla por marcar", then "Todo marcado. Puedes continuar.", and the button worked. The location block and the trip window showed in Spanish ("Luis Mora viene en camino", "Posición actualizada hace 15 segundos").
- English: the same screens are unchanged.
- Every section opens for a visitor, customer, pro and super admin with no errors.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 22159 |  |
| public\index.html | 1287515 | changed in v97 |
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

Only public\index.html changed in this version. The rest are the same as v96 and are included so this zip is complete on its own.

## Deploy (cmd.exe, not PowerShell)
0. If I haven't deployed v95 yet, read "Important before I deploy" in CHANGES_v95.md first (the 30-day ID retention).
1. Unzip trothen-v97-files.zip.
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
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md CHANGES_v94.md CHANGES_v95.md CHANGES_v96.md CHANGES_v97.md
   git commit -m "v97: second gap check (two unprotected spots fixed) and Spanish for the new screens"
   git push
   ```
5. After Render finishes: switch the site to Español, sign in with a test account that hasn't agreed yet, and read the agreement screen.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
