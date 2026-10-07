# Trothen v100: the site now asks people to install the app

## What I asked
Is the downloadable app working? Does it ask if you want to install, or is there a place that says download app?

## What was already there
The site could already be installed as an app on a phone or computer. That part worked:
- the app's name, icon and colours were set up
- on Android, and on Chrome or Edge on a computer, the browser's own install offer was being caught
- on iPhone, there were step-by-step instructions

**But it never asked.** The only way in was one button, "Add Trothen to your phone", in the footer at the very bottom of the homepage. Most people never scroll there.

## What I changed

**1. It asks.** A small card slides up from the bottom: "Install the Trothen app. One tap. No app store." with **Install** and **Not now**.
- It only appears when installing is really possible on that phone or computer, and not if Trothen is already installed.
- It waits about six seconds after the page loads, and stays out of the way while a window that needs an answer is open (the agreement, a booking form, a trip in progress).
- **Not now** hides it for 14 days. Installing hides it for good.

**2. There is a place that says it.** The account menu (my name, top right) now has **Get the app**. The footer button is still there too.

**3. iPhone.** iPhones don't let a website start an install. There the card says "Show me how" and opens the three steps (Share → Add to Home Screen → Add).

**4. People who arrive from WhatsApp, Facebook or Instagram.** Links opened inside those apps can't install anything. The card still shows, and pressing it tells them what to do first: open the page in Chrome (Android) or Safari (iPhone). This matters because most people will first open Trothen from a WhatsApp link.

**5. Spanish** for all of it.

## What the installed app is, honestly
- It puts a Trothen icon on the home screen and opens full screen, without the browser's address bar. It is the same site.
- **It is not in the Play Store or the App Store.** People install it from the website.
- **It still needs an internet connection.** It doesn't work offline.
- **It doesn't fix location sharing with the phone locked.** A pro on a trip still has to keep Trothen open with the screen on. That needs a true phone app.
- A listing in the app stores is a separate project (a developer account with Google and Apple, a review by each, and a wrapper around the site).

## How it behaves on each kind of device
| Device | What people see |
|---|---|
| Android phone, Chrome, Edge or Samsung Internet | The card, with Install. One tap opens the phone's own install box. |
| iPhone or iPad, Safari | The card, with "Show me how", then three steps. |
| Inside WhatsApp, Facebook, Instagram | The card; pressing it says to open the page in Chrome or Safari first. |
| Computer, Chrome or Edge | The card, with Install (also the install icon in the address bar). |
| Computer, Firefox or Safari | Nothing. Those browsers can't install a site as an app. |
| Already installed | Nothing. |

## Tested (simulated devices in a browser)
- **Android:** no card until the browser offers an install; card appears about six seconds later; Not now hides it and it stays hidden after a reload for 14 days; Install opens the browser's install box; after installing, the card and buttons are gone for good.
- **A window is open:** the card waits.
- **iPhone Safari:** the card appears with "Show me how" and opens the three steps.
- **Inside Facebook on iPhone / Instagram on Android:** the card appears and gives the "open in Safari / Chrome first" message.
- **Desktop with no install offer:** no card, no button.
- The app files (manifest, service worker, both icons) are served correctly.
- Every section opens for a visitor, customer, pro and super admin with no errors.
- **Not tested:** real phones. The first thing to check after deploy is that the card appears on an Android phone in Chrome and that Install puts the icon on the home screen.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 22159 |  |
| public\index.html | 1301990 | changed in v100 |
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
1. Unzip trothen-v100-files.zip.
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
   copy /Y CHANGES_v100.md "%REPO%\"
   ```
3. Check the sizes against the table:
   ```
   cd /d "%REPO%"
   for %I in (server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\location-retention-scheduler.js src\admin-scope.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\go-live.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\document-expiry-scheduler.js src\pdf-report-builder.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md CHANGES_v94.md CHANGES_v95.md CHANGES_v96.md CHANGES_v97.md CHANGES_v98.md CHANGES_v99.md CHANGES_v100.md
   git commit -m "v100: install-the-app card, Get the app menu entry, in-app browser guidance"
   git push
   ```
5. After Render finishes: open trothenpro.com in Chrome on an Android phone, wait a few seconds, and press Install on the card. Then try an iPhone in Safari.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
