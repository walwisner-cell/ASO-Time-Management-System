# Trothen v94: pick the job on a map, and a privacy policy

## What I asked for
Fixes for the three limits listed after v92:
1. A phone with Location switched off can't be pinned.
2. There's no map picture inside Trothen for choosing a spot.
3. The site stores the GPS position of a customer's job site, and that belongs in a privacy policy.

## 1 and 2: "Choose on a map"

The "Where is the job?" block (Post a Job and Book a Pro) has a second button next to "Pin my current location": **Choose on a map**.

- It opens a map inside Trothen with a red pin fixed in the middle. The customer slides the map until the pin sits on the right spot, then presses **Use this spot**.
- **It needs no GPS.** It works with Location switched off, on a computer, and when the customer isn't at the job site.
- **Search box:** type a town, area or landmark ("Paynesville") and the map jumps there. The customer then zooms in and places the pin.
- **Find me** uses GPS to jump to where they are, if Location is on. If it's off, it says so and the map still works by hand.
- **It opens somewhere sensible:** on the existing pin if there is one, else the customer's own city, else their country's main city.
- **The spot can't be accepted from far out.** "Use this spot" stays off until the map is zoomed in close enough to tell one building from the next.
- The Plus Code for the pin is shown as the map moves.
- A GPS pin can be corrected too: once pinned, "Adjust on the map" opens the map on that spot.

In v92 I wrote that dragging a pin on a map needs a paid maps service. That is no longer true: the free map library added in v93 for trip tracking does this job as well.

**How the place search works.** The search goes from my server to OpenStreetMap's free search service, not from the visitor's phone. That service asks sites to send at most one question a second, to remember answers, and to say who they are. The code does all three. If the service can't be reached, the customer sees a message and moves the map by hand.

## 3: A privacy policy

**There wasn't one anywhere on the site.** Now there is.

- **Where people find it:** a "Privacy Policy" link in every footer, in the account menu, on the agreement screen at sign-in, beside the location picker ("How we use your location"), and at trothenpro.com/privacy.
- **What it says:** written in plain words, in twelve short sections, to match what the system really does:
  - what is collected (account details, ID and face photo, guarantors, jobs and bookings, location, payments, messages, technical information)
  - a full section on location: the job pin, searching, a pro's base location, the live trip, and maps
  - why it's used, and that personal information is not sold
  - who can see what: other users, staff, and the outside companies involved
  - how long things are kept
  - people's choices: download my data, close my account, switch location off
  - security, the age limit (18), where data is stored (United States), changes, and contact
- **Two details fill themselves in** each time it's shown, so the policy can't disagree with the system: how long ID files are kept (from the setting in Admin), and the support email (from Settings).
- **I can edit it:** Admin → Settings → Privacy Policy, with a "See it as visitors do" button. Changes are live at once and recorded in the access log.

## What I must do. Code can't.
- **Have the attorney review the policy before launch.** Claude wrote it to describe the system accurately. It is not legal advice, and data protection law differs in the US, Nigeria, Ghana and Liberia.
- **Set a support email** in Admin → Settings. Until I do, the policy's contact line says "use the Contact Us page on this site".
- **Check the legal name.** The policy says "Trothen" throughout. If the company's legal name should appear, I add it in the editor.
- **Keep it true.** If I connect a new outside service or change what's collected, the policy needs a line about it. The outside companies are described by what they do (hosting, email, texts), not by brand name, so swapping one for another doesn't make it wrong.

## Things to know
- **I couldn't see the street map or use the real place search in testing,** because the test machine can't reach OpenStreetMap. The map frame, the pin, the zoom rule and saving the spot all worked, and the search was tested against a stand-in service that answers the same way. On the live site, check that streets appear and that searching a town name moves the map.
- **Map detail varies.** OpenStreetMap is detailed in Monrovia and the big cities and thinner in rural areas. Where the map is blank, the customer can still place the pin by eye, or use GPS or a landmark.
- **OpenStreetMap's free services are for light use.** If Trothen gets busy I'll need a paid map and search provider. To switch the search, I set PLACE_SEARCH_URL on the server; no code change.

## Tested
- **With Location switched off** on a phone-sized screen: opened Post a Job, pressed Choose on a map, the map opened on the customer's city; searched "Paynesville" and the map jumped there with two results listed; "Find me" explained that Location is off; zoomed in, pressed Use this spot; the form showed "Location pinned · chosen on the map" with its Plus Code; the job saved with that spot.
- **Place search on the server:** results returned; the same search again was answered from memory without a second call; calls were spaced 1.1 seconds apart; a one-letter search and a visitor who isn't signed in were refused.
- **Privacy policy:** the public version had the retention sentence filled in ("deleted 90 days after...") and no unfilled markers; the window opened from the page and from /privacy; the footer link is present; the admin editor loaded the text, and an edit saved and showed to visitors at once.
- Nothing blocked by the security policy. Every section opens for a visitor, customer, pro and super admin with no errors.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 21496 |  |
| public\index.html | 1266013 | changed in v94 |
| public\vendor\leaflet\leaflet.js | 147552 | new in v93 |
| public\vendor\leaflet\leaflet.css | 14806 | new in v93 |
| public\vendor\leaflet\LICENSE.txt | 1395 | new in v93 |
| src\auth.js | 9391 |  |
| src\platform-settings.js | 29208 | changed in v94 |
| src\validators.js | 17730 |  |
| src\terms.js | 1245 |  |
| src\plan-billing.js | 7530 |  |
| src\id-retention-scheduler.js | 2249 |  |
| src\file-crypto.js | 2776 |  |
| src\backup-scheduler.js | 2385 |  |
| src\account-privacy.js | 8577 |  |
| src\provider-score.js | 16908 |  |
| src\provider-score-scheduler.js | 5507 |  |
| src\top-scorer-promotion-scheduler.js | 3512 |  |
| src\routes\admin.routes.js | 213630 | changed in v94 |
| src\routes\marketplace.routes.js | 130378 | changed in v94 |
| src\routes\payments.routes.js | 66639 |  |
| src\routes\auth.routes.js | 81162 |  |
| src\routes\misc.routes.js | 58897 |  |
| src\routes\portfolio.routes.js | 12210 |  |

Four files changed in this version. The three Leaflet files are the ones from v93; I include them again in case v93 isn't deployed yet. They live in public\vendor\leaflet.

## Deploy (cmd.exe, not PowerShell)
1. Unzip trothen-v94-files.zip.
2. From the unzipped folder (replace the path with my repo folder). The mkdir line is harmless if the folder already exists:
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
   for %I in (server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md CHANGES_v94.md
   git commit -m "v94: choose the job location on a map; privacy policy"
   git push
   ```
5. After Render finishes:
   - Open trothenpro.com/privacy. The Privacy Policy should appear. Read it once.
   - Admin → Settings: set the support email, then look at the Privacy Policy panel.
   - As a customer: Post a Job → Choose on a map. Streets should be visible. Search a town, zoom in, press Use this spot.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
