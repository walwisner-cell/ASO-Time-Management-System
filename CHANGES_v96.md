# Trothen v96: the remaining gaps that code can close

## What I asked for
Fix all gaps.

## What I went back through
Every "known limit" and "still open" note from v81 to v95. Nine of them could be closed in code. They are below. The ones that can't are listed at the end, unchanged.

## 1. Disputes can now be split
**Gap:** a dispute had two outcomes only: everything back to the customer, or everything to the pro.
**Now:** a third button, **Split Between Them**. I type how much goes back to the customer; the rest is released to the pro. A preview shows both amounts before I confirm.
- Only possible while the whole payment is still held, so the two parts always add up to what the customer paid.
- The pro's commission is worked out on their part only.
- Both people are told the amounts and see my note.
- If a super admin reopens it before the pro cashes out, the full amount goes back on hold.

## 2. Any undecided dispute can be decided
**Gap:** the decision buttons only appeared for disputes marked "open". One marked "in review" or "escalated" had no buttons, so it couldn't be resolved from the dispute window.
**Now:** the buttons show for every dispute that hasn't been decided.

## 3. Country-wide admins now get the notices
**Gap:** when v90 let a regional admin cover a whole country, the notices still only went to an admin whose city matched. A country-wide admin was never told about a new contact message, a job application, a category request, a pro's expiring license, or a pro's falling score.
**Now:** one piece of code decides which regional admins look after a place, and all six kinds of notice use it.

## 4. Exact job locations expire
**Gap:** a job pin is usually the GPS position of a customer's home, and it was kept forever.
**Now:** a daily clean-up removes it once it's no longer needed.
- **Bookings:** the exact pin, and the points where the pro said "on my way" and "arrived", are removed 90 days after the booking ended.
- **Job posts that never became a booking:** the pin and landmark are removed after 30 days.
- Nothing is removed while a dispute on the booking is open.
- The landmark text and address on a booking stay, because they are part of the written agreement.
The Privacy Policy says this.

## 5. Erasing an account also erases where they live
**Gap:** when I erased a closed customer account, their name and contact details went, but the pin, landmark and address on their past jobs and bookings stayed.
**Now:** erasing a customer wipes those too. The booking records themselves stay.

## 6. The agreement names the place
**Gap:** the downloadable agreement for a booking only printed a street address. A job in Liberia with a pin and a landmark showed nothing useful.
**Now:** it prints the landmark and the location pin (Plus Code and coordinates).

## 7. "No insurance" is out of the built-in Terms
**Gap:** both versions of the Terms said that off the platform "there is no payment protection and no insurance", which suggests Trothen provides insurance on the platform. It doesn't. I had already removed this from the sign-in agreement in v76.
**Now:** removed from the built-in Terms as well. (If I edited the Terms in Admin, my version still has whatever I wrote.)

## 8. Distances in the units people use
**Gap:** every distance was in miles.
**Now:** miles for people in the United States, Liberia and the United Kingdom; kilometres for everyone else (Nigeria, Ghana and the rest). The trip window already showed both.

## 9. Go-Live shows everything in one place
**Gap:** Admin → Go-Live listed the launch checks from before this month's work.
**Now:** it also shows: whether a working support email is set, that the Privacy Policy needs an attorney's review, whether a backup was taken in the last two days, whether ID file encryption is on, whether automated ID checks are connected, and the state of the monthly plan fee.

## Small things fixed along the way
- The five page footers had "Trothen Tech Group · Atlanta, GA · support@trothen.io" typed into the page as a starting value. They now start as "© Trothen" until the real footer line loads from Settings.

## What is still open, and why code can't close it

**Needs a paid service or account**
- Real payments (Stripe).
- Email and text delivery (SendGrid, Twilio). Until then, sign-up and two-step codes show on screen.
- Live selfie and automatic ID checks (Persona).
- Road distance and arrival time on the trip map (a routing service).
- A paid map and place-search provider, once the site is busy.
- Virus scanning of uploaded PDFs.
- Backups kept off the server.
- An outside security test.

**Needs a phone app**
- Location sharing while the pro's phone is locked or in another app.

**Needs a larger rebuild**
- A strict security policy (the page is one large file).
- The Postgres database option, which is out of date. I don't use it.
- Spanish for the newer pages. The main site is translated; the pages added this month are English only.

**Needs my attorney or accountant**
- Review of the Terms and the Privacy Policy.
- Whether "escrow" may be used, and how the commission and plan fee are disclosed.
- How long ID files and locations may be kept in each country.
- Tax on the plan fee and service fee.

**Needs me**
- A working support mailbox on my own domain, typed into Settings → Footer.
- Deploying. Testing on real phones in Liberia.

## Tested
- **Split:** no amount and the full amount were refused; refunding $35 of $100 left $65 released, the booking completed and both figures recorded; deciding again was refused; reopening put the full $100 back on hold; a second split refunding $60 left $40; the pro's payout was $40 less 13% commission = $34.80.
- **Dispute window:** an "in review" dispute showed all three decision buttons; the split window showed the right preview.
- **Notices:** something in Monrovia, and a pro in Paynesville, both reach the Liberia-wide admin; something in Atlanta reaches the Atlanta admin only.
- **Location clean-up:** a booking finished 100 days ago lost its pin and kept its landmark; one finished 10 days ago kept its pin; an old booking with an open dispute kept its pin; a 40-day-old unhired job lost its pin; an open job kept it.
- **Agreement PDF** for a pinned booking was produced without error.
- **Go-Live** shows the six new checks.
- **Distances:** 2.5 miles shows as "2.5 mi" in the US and "4 km" in Nigeria.
- Every section opens for a visitor, customer, pro and super admin with no errors.

## Files (complete replacements; two are new)
| File | Bytes | |
|---|---|---|
| server.js | 22159 | changed in v96 |
| public\index.html | 1271747 | changed in v96 |
| public\vendor\leaflet\leaflet.js | 147552 |  |
| public\vendor\leaflet\leaflet.css | 14806 |  |
| public\vendor\leaflet\LICENSE.txt | 1395 |  |
| src\auth.js | 9391 |  |
| src\platform-settings.js | 32385 | changed in v96 |
| src\validators.js | 17730 |  |
| src\terms.js | 1245 |  |
| src\plan-billing.js | 7530 |  |
| src\id-retention-scheduler.js | 3810 |  |
| src\location-retention-scheduler.js | 3033 | new in v96 |
| src\admin-scope.js | 1690 | new in v96 |
| src\file-crypto.js | 2776 |  |
| src\backup-scheduler.js | 2385 |  |
| src\account-privacy.js | 9320 | changed in v96 |
| src\go-live.js | 16626 | changed in v96 |
| src\provider-score.js | 16908 |  |
| src\provider-score-scheduler.js | 5463 | changed in v96 |
| src\top-scorer-promotion-scheduler.js | 3512 |  |
| src\document-expiry-scheduler.js | 3645 | changed in v96 |
| src\pdf-report-builder.js | 7045 |  |
| src\routes\admin.routes.js | 217748 | changed in v96 |
| src\routes\marketplace.routes.js | 131566 | changed in v96 |
| src\routes\payments.routes.js | 66639 |  |
| src\routes\auth.routes.js | 81162 |  |
| src\routes\misc.routes.js | 58853 | changed in v96 |
| src\routes\portfolio.routes.js | 12210 |  |

## Deploy (cmd.exe, not PowerShell)
0. If I haven't deployed v95 yet, read "Important before I deploy" in CHANGES_v95.md first (the 30-day ID retention).
1. Unzip trothen-v96-files.zip.
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
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md CHANGES_v94.md CHANGES_v95.md CHANGES_v96.md
   git commit -m "v96: split disputes, location expiry, country-admin notices, agreement location, go-live checks"
   git push
   ```
5. After Render finishes: open Admin → Go-Live and read down the list. Everything marked "not yet" there is my to-do list.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
