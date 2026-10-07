# Trothen v102: when the browser can't install, send people to one that can

## What happened
I pressed "Get the app" on my Windows computer and got: "This browser can't install a website as an app." It didn't install.

## Why
That message was correct, but it was a dead end. Not every browser can install a website as an app:
- **Can:** Chrome and Edge on a computer; Chrome, Edge and Samsung Internet on Android; Safari on iPhone and on a Mac.
- **Can't:** Firefox and Opera on a computer, and a few others.
The browser I was using is one of the ones that can't. Nothing Trothen does can change that; it is the browser's own limit.

## What I can do right now, without deploying anything
Open trothenpro.com in **Microsoft Edge** (it is already on every Windows computer) or in **Chrome**. Then press "Get the app" at the bottom of the page, or click the small install icon at the right-hand end of the address bar, and press Install.

## What I changed
**The message now takes people somewhere.**
- **On Windows, in a browser that can't install:** the window names the browser ("Firefox can't install a website as an app, but Microsoft Edge can, and it is already on this computer") and has an **Open in Microsoft Edge** button. One click opens Trothen in Edge, where it can be installed. There is also a **Copy the address** button.
- **On a Mac in Safari:** it now gives Safari's own three steps (File → Add to Dock → Add) instead of telling people to switch browsers.
- **On a Mac in Firefox or Opera:** it shows the address to open in Chrome or Edge, with a Copy button.
- All in Spanish too.

Nothing changed for browsers that can install.

## Tested (six simulated desktop browsers)
- Windows Firefox and Windows Opera: named the browser, showed the Open in Microsoft Edge button with the right link, and Copy the address.
- Windows Chrome and Windows Edge: the normal install steps, no extra buttons.
- Mac Safari: the File → Add to Dock steps.
- Mac Firefox: the address and the Copy button.
- Every section opens for a visitor, customer, pro and super admin with no errors.
- Not tested: pressing "Open in Microsoft Edge" on a real Windows computer. The link uses a Windows feature that opens Edge directly; if a workplace computer has that switched off, the Copy button is the fallback.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 22159 |  |
| public\index.html | 1311672 | changed in v102 |
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
1. Unzip trothen-v102-files.zip.
2. Set the two folders (replace both paths):
   ```
   set SRC=C:\Users\You\Downloads\trothen-v102-files
   set REPO=C:\path\to\trothen-backend
   ```
3. Copy everything:
   ```
   xcopy "%SRC%\*" "%REPO%\" /E /Y /I
   ```
   (If v101 is already deployed, only public\index.html is different.)
4. Check the size of the file that changed:
   ```
   cd /d "%REPO%"
   for %I in (public\index.html) do @echo %~zI  %I
   ```
   It must say 1311672. If not, stop and copy again.
5. Push:
   ```
   git add server.js public src CHANGES_v*.md
   git commit -m "v102: Open in Microsoft Edge when the browser can't install"
   git push
   ```
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
