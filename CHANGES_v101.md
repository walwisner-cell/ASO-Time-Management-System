# Trothen v101: the install card now shows without waiting for the browser

## What happened
I looked for the "Install the Trothen app" card from v100 and did not see it.

## Why I didn't see it
There are two possible reasons. Claude can't see my live site, so it can't tell which one applies.

**1. v100 isn't on the live site yet.** The card is new in v100. If the last thing I deployed is older, the card doesn't exist there.

**2. v100 was waiting for the browser, and the browser was holding back.** This one is a real weakness in v100, and it is fixed here. On Android and on a computer, v100 only showed the card after the browser itself announced "this site can be installed". Chrome only announces that after a visitor has tapped the page and stayed for about half a minute. Some browsers never announce it. So on a first quick look, the card had nothing to trigger it. It also never showed:
- on a computer in Firefox or Safari
- if Trothen was already installed on that device
- for 14 days after pressing "Not now"

## What I changed
**The card no longer waits for the browser on phones and tablets.** About six seconds after the page loads, anyone on a phone who hasn't installed Trothen sees it.
- If the browser has offered a one-tap install, the button says **Install**.
- If it hasn't (yet), the button says **Show me how** and opens the steps for that exact phone and browser. If the browser's offer arrives while the card is up, the button changes to Install by itself.

**"Get the app" is always there for anyone who hasn't installed it:** in the account menu, in the menu for visitors on a phone, and the button in the footer. Before, these were hidden until the browser made its offer.

**Steps for every kind of device.** Pressing "Get the app" or "Show me how" opens one window with the right steps:

| Using | What the steps say |
|---|---|
| Android, Chrome or Edge | ⋮ menu at the top right → "Install app" or "Add to Home screen" → Install |
| Android, Samsung Internet | ☰ menu at the bottom right → the same |
| Android, Firefox | ⋮ menu → "Install" or "Add to Home screen" |
| iPhone, Safari | Share button at the bottom → "Add to Home Screen" → Add |
| iPhone, Chrome | Share button in the address bar → "Add to Home Screen" → Add |
| Inside WhatsApp, Facebook, Instagram | Open the page in Chrome or Safari first, then press Get the app again |
| Computer, Chrome or Edge | The install icon at the end of the address bar, or the browser menu → "Install Trothen" |
| Computer, Firefox or Safari | This browser can't install a site; use Chrome or Edge (on a Mac, Safari: File → Add to Dock) |

**On a computer** the card itself still only appears when Chrome or Edge offers the install, so Firefox and Safari users aren't shown something they can't use. "Get the app" in the menu and footer is there either way.

All of it is in Spanish as well.

## If I still don't see the card after deploying this
1. Check I'm on a phone, or in Chrome or Edge on a computer.
2. Check Trothen isn't already installed on that device (look for the icon).
3. I may have pressed "Not now" earlier, which hides it for 14 days. Opening the site in a private window shows it again.
4. Wait about six seconds, with no other window open on the page.
5. Either way, "Get the app" is in the account menu and at the bottom of the homepage.

## Tested (eight simulated devices)
- Android Chrome, Samsung Internet and Firefox; iPhone Safari and Chrome; a WhatsApp-style in-app browser: the card appeared on all six without any offer from the browser, and "Show me how" opened the right steps for each.
- Android Chrome: when the browser's offer then arrived, the button changed to "Install" and pressing it opened the browser's install box.
- Windows Chrome and Windows Firefox: no card without an offer (as intended); "Get the app" gave the right steps for each.
- Every section opens for a visitor, customer, pro and super admin with no errors.
- Not tested on real phones.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 22159 |  |
| public\index.html | 1308325 | changed in v101 |
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
| src\backup-scheduler.js | 4325 |  |
| src\account-privacy.js | 9320 |  |
| src\go-live.js | 16691 |  |
| src\provider-score.js | 16908 |  |
| src\provider-score-scheduler.js | 5463 |  |
| src\top-scorer-promotion-scheduler.js | 3512 |  |
| src\document-expiry-scheduler.js | 3645 |  |
| src\pdf-report-builder.js | 7045 |  |
| src\routes\admin.routes.js | 219726 |  |
| src\routes\marketplace.routes.js | 131566 |  |
| src\routes\payments.routes.js | 66639 |  |
| src\routes\auth.routes.js | 81162 |  |
| src\routes\misc.routes.js | 58853 |  |
| src\routes\portfolio.routes.js | 12210 |  |

Only public\index.html changed in this version.

## Deploy (cmd.exe, not PowerShell)
0. If I haven't deployed v95 yet, read "Important before I deploy" in CHANGES_v95.md first (the 30-day ID retention).
1. Unzip trothen-v101-files.zip.
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
   copy /Y CHANGES_v10*.md "%REPO%\"
   ```
3. Check the sizes against the table:
   ```
   cd /d "%REPO%"
   for %I in (server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md CHANGES_v94.md CHANGES_v95.md CHANGES_v96.md CHANGES_v97.md CHANGES_v98.md CHANGES_v99.md CHANGES_v100.md CHANGES_v101.md
   git commit -m "v101: install card shows without waiting for the browser; steps for every device"
   git push
   ```
5. After Render finishes: open trothenpro.com on a phone in a private window and wait about six seconds.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
