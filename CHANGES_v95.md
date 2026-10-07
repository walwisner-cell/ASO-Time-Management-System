# Trothen v95: best practice for the two details that fill themselves in

## What I asked for
The Privacy Policy fills in two details by itself: how long ID files are kept, and the support email. I asked for best practice on both.

## 1. How long ID files are kept

**The usual practice** is to keep identity documents for the shortest time that does the job, and to keep them longer only while there is a specific reason. A photo of someone's ID is the most sensitive thing Trothen holds. After the check is decided, it is only needed if someone questions the decision.

**What I changed**
- **The default is now 30 days**, down from 90.
- **Automatic holds.** Files are not deleted while any of these is true for that person:
  - they are in a dispute that hasn't been settled
  - there is an open fraud review naming them
  - their account is on hold
  When it is closed, the files are deleted at the next daily clean-up.
- **Admin shows it.** In Verification Queue → Past checks, a held record says "Files held: open dispute" (or the other reason) instead of a deletion date. The "How ID files are kept" panel explains the holds.
- **The Privacy Policy says it:** "The files are deleted 30 days after your check is approved, rejected or replaced by a newer upload. If a dispute or a fraud review involving your account is open at that time, the files are kept until it is closed."
- What stays the same: the record of the check (document type, name, decision, reviewer, date) is kept; submissions still waiting for review are never deleted; I can change the number in Admin, and 0 means keep.

**Important before I deploy**
- If I have **never pressed Save** on the retention number in Admin, the new default of 30 applies as soon as the server starts. ID files decided between 30 and 90 days ago are then deleted within about 30 seconds (unless held). That can't be undone.
- If I want to stay on 90 days, I open Admin → Verification Queue → How ID files are kept **before deploying**, type 90 and press Save. A saved number is never changed by an update.

**Still a decision for the attorney:** 30 days is the cautious default, not legal advice. Some places set their own rules. When real payments start, the payment company does its own identity checks and keeps its own records; that is separate from these files.

## 2. The support email

**The usual practice** is one contact address, on the company's own domain, read by a person, and shown the same everywhere.

**What I found:** the address was coming from four different places.
- The footer read one setting.
- The Privacy Policy read a different setting, which was empty, so it said "use the Contact Us page".
- The Terms of Service, the PDF reports and agreements, and the support chat each had support@trothen.io typed into the code.

**What I changed**
- **One address feeds everything:** the footer, the Terms of Service, the Privacy Policy, PDF reports and agreements, and the support chat. It is the "Support email" in Admin → Settings → Footer. Change it there and all five change.
- If that is blank, the support-contact email is used. If both are blank, the documents point to the Contact Us page.
- **Admin checks the address for me.** Admin → Settings → Privacy Policy now starts with a status box: the address visitors see, where it is used, and a warning when:
  - no address is set
  - it is a personal-style mailbox (Gmail, Yahoo, Outlook and so on)
  - it is on a different domain from the site
  - it is a no-reply address
- **The Privacy Policy now gives a reply time:** "We aim to reply within 30 days." That is the common standard for requests about someone's own data.

**What I must do. Code can't.**
- **The address showing today is support@trothen.io, and my site is trothenpro.com.** The status box flags this. I need to find out whether that mailbox exists and who reads it.
- **Create a mailbox on my own domain,** for example support@trothenpro.com, through whoever hosts my domain's email, and make sure a person checks it.
- **Type it into Admin → Settings → Footer → Support email.**
- **Keep the 30-day promise.** If I can't, I change the sentence in the Privacy Policy editor.
- The footer also says "Trothen Tech Group · Atlanta, GA". If that isn't my real company name and city, I change it in the same Footer settings.

**Note on edited documents.** The new wording is in the built-in Terms and Privacy Policy. If I have edited either one in Admin, my edited version is what shows. To use the shared address there, I put {{SUPPORT_EMAIL}} where the address should go.

## Tested
- **Retention with holds:** five ID checks, four of them 40 days old and one 10 days old. First clean-up: the plain 40-day one was deleted; the three whose owners had an open dispute, an open fraud review, or an account on hold were kept; the 10-day one was kept. After the dispute, review and hold were closed: the three were deleted, the 10-day one still kept.
- **One address:** the Privacy Policy and both Terms showed the footer address with no unfilled markers. After changing the footer address in Admin, all of them showed the new one at once.
- **Advice:** a different-domain address, a Gmail address, a no-reply address and a blank each produced the right warning; an address on the site's own domain, or a subdomain of it, produced none.
- **Admin:** the status box showed the address, where it's used, the retention period and the domain warning. Past checks showed "Files held: open dispute" for a held record and a deletion date for a normal one.
- Every section opens for a visitor, customer, pro and super admin with no errors.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 21661 | changed in v95 |
| public\index.html | 1267899 | changed in v95 |
| public\vendor\leaflet\leaflet.js | 147552 |  |
| public\vendor\leaflet\leaflet.css | 14806 |  |
| public\vendor\leaflet\LICENSE.txt | 1395 |  |
| src\auth.js | 9391 |  |
| src\platform-settings.js | 32157 | changed in v95 |
| src\validators.js | 17730 |  |
| src\terms.js | 1245 |  |
| src\plan-billing.js | 7530 |  |
| src\id-retention-scheduler.js | 3810 | changed in v95 |
| src\file-crypto.js | 2776 |  |
| src\backup-scheduler.js | 2385 |  |
| src\account-privacy.js | 8577 |  |
| src\provider-score.js | 16908 |  |
| src\provider-score-scheduler.js | 5507 |  |
| src\top-scorer-promotion-scheduler.js | 3512 |  |
| src\pdf-report-builder.js | 7045 | changed in v95 |
| src\routes\admin.routes.js | 214763 | changed in v95 |
| src\routes\marketplace.routes.js | 130777 | changed in v95 |
| src\routes\payments.routes.js | 66639 |  |
| src\routes\auth.routes.js | 81162 |  |
| src\routes\misc.routes.js | 58897 |  |
| src\routes\portfolio.routes.js | 12210 |  |

Seven files changed in this version. src\pdf-report-builder.js is in the package for the first time.

## Deploy (cmd.exe, not PowerShell)
0. **First decide about the 30 days** (see "Important before I deploy" above).
1. Unzip trothen-v95-files.zip.
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
   copy /Y src\file-crypto.js "%REPO%\src\file-crypto.js"
   copy /Y src\backup-scheduler.js "%REPO%\src\backup-scheduler.js"
   copy /Y src\account-privacy.js "%REPO%\src\account-privacy.js"
   copy /Y src\provider-score.js "%REPO%\src\provider-score.js"
   copy /Y src\provider-score-scheduler.js "%REPO%\src\provider-score-scheduler.js"
   copy /Y src\top-scorer-promotion-scheduler.js "%REPO%\src\top-scorer-promotion-scheduler.js"
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
   for %I in (server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md CHANGES_v94.md CHANGES_v95.md
   git commit -m "v95: 30-day ID retention with automatic holds; one support email everywhere"
   git push
   ```
5. After Render finishes: Admin → Settings, scroll to Privacy Policy, and read the status box. Fix the support email in the Footer settings, then open trothenpro.com/privacy and check the last line.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
