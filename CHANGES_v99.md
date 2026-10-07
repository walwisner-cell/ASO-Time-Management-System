# Trothen v99: two items from the "needs a paid service" list, done without one

## What I asked for
Fix all gaps.

## Where things stood
After v98, every remaining item was marked as needing a paid service, a phone app, an attorney, or me. Claude went back through that list one more time and asked of each: is there a version of this that works without the paid service? Two of them had one.

## 1. Backups I can keep off the server
**The gap:** the nightly backups sit on the same disk as the site. If that disk is lost, the backups go with it. The list said "backups kept off the server" needed an outside service.
**What I can do now:** Admin → Settings → Data backups has a **Download** button beside each day. It saves that day's backup to my computer as one file, which I can then keep on another computer, a USB drive, or a private cloud folder.
- **It asks for my password again.** The file holds every record on the site: names, contact details, scrambled passwords, bookings and messages.
- **Super admin only**, limited to six downloads an hour, and every download is written to the access log.
- **The file** is named like trothen-backup-2026-10-06.tar.gz. Windows 11 opens it by double-clicking. On any Windows 10 or 11 machine, in cmd.exe: `tar -xzf trothen-backup-2026-10-06.tar.gz`. Inside is one folder with the data files.
- **What it doesn't include:** uploaded photos and ID files. Those stay on the server's disk only.
- **A sensible habit:** download one about once a week. The panel says so.

**What this is not:** it isn't automatic. If I forget to download, I have no off-server copy. A scheduled copy to outside storage still needs an outside storage account.

**To restore from one:** unpack it, and the .json files inside go back into the server's data folder (the one DATA_DIR points to) while the server is stopped. On Render that is done from the Shell tab. I'd ask Claude to walk me through it when the time comes rather than try it cold.

## 2. A rough arrival time on the trip
**The gap:** the trip window showed the distance but no idea of how long. The list said arrival time needs a paid routing service, which is true for a real one.
**What it shows now:** under the distance, a line such as "Rough guess: 5–13 minutes, depending on the roads and traffic."
- It is worked out from the straight-line distance: roads are assumed to be 1.3 to 1.6 times longer, and town traffic to move at 15 to 30 km/h. That gives a range, not a single number.
- It is called a guess on screen, because that's what it is. There is no route behind it. On a long detour, in a jam, or on a motorbike it will be off.
- It only shows when the pro is more than about 300 metres away and their position is fresh.
- It is in Spanish too.

A true arrival time, following the actual roads, still needs a routing service.

## What is still open after this
**Needs a paid service or account:** real payments; email and text delivery; automatic ID checks; true road routes; a paid map provider once the site is busy; virus scanning of uploads; automatic off-server backups; an outside security test.
**Needs a phone app:** location sharing while the pro's phone is locked.
**Needs a larger rebuild:** a strict security policy; Spanish for server messages and Admin.
**Needs my attorney or accountant:** the Terms, the Privacy Policy, "escrow", retention periods, tax.
**Needs me:** a support mailbox on my own domain; a native reader for the Spanish; deploying; testing on real phones.

Claude has now been through this list four times. It does not see another item on it that can be done, even partly, without one of those.

## Tested
- **Backup download:** a wrong password, no password, a city admin, and a visitor were all refused; a made-up day was refused; the right password returned the file. The file opened with two different tools, held 25 data files, and every one matched the server's own copy byte for byte and was valid. The download was logged.
- **In a browser:** the panel shows a Download button per day; a wrong password keeps the window open; the right one starts the download and closes it.
- **Arrival guess:** 0.5 km gives 1–3 minutes; 2 km gives 5–13; 5 km gives 13–32; 12 km gives 31–77.
- Every section opens for a visitor, customer, pro and super admin with no errors.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 22159 |  |
| public\index.html | 1295753 | changed in v99 |
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
| src\backup-scheduler.js | 4325 | changed in v99 |
| src\account-privacy.js | 9320 |  |
| src\go-live.js | 16691 | changed in v99 |
| src\provider-score.js | 16908 |  |
| src\provider-score-scheduler.js | 5463 |  |
| src\top-scorer-promotion-scheduler.js | 3512 |  |
| src\document-expiry-scheduler.js | 3645 |  |
| src\pdf-report-builder.js | 7045 |  |
| src\routes\admin.routes.js | 219726 | changed in v99 |
| src\routes\marketplace.routes.js | 131566 |  |
| src\routes\payments.routes.js | 66639 |  |
| src\routes\auth.routes.js | 81162 |  |
| src\routes\misc.routes.js | 58853 |  |
| src\routes\portfolio.routes.js | 12210 |  |

Four files changed in this version.

## Deploy (cmd.exe, not PowerShell)
0. If I haven't deployed v95 yet, read "Important before I deploy" in CHANGES_v95.md first (the 30-day ID retention).
1. Unzip trothen-v99-files.zip.
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
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md CHANGES_v94.md CHANGES_v95.md CHANGES_v96.md CHANGES_v97.md CHANGES_v98.md CHANGES_v99.md
   git commit -m "v99: downloadable backups for off-server copies; rough arrival guess on the trip"
   git push
   ```
5. After Render finishes: Admin → Settings → Data backups → Download. Open the file once to see that it unpacks, then put it somewhere safe.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
