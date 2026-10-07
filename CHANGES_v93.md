# Trothen v93: follow the pro on a map, like a ride app

## What I asked for
When there is a booking and the pro accepts it and starts coming, I want to see their location and how far away they are, the way Uber does.

## What it does now

**For the customer**
- When the pro taps "On My Way", the booking gets a **Track your pro** button.
- It opens a window with a map showing two dots, the pro and the job, and a headline such as **"1.2 miles (1.9 km) away"**.
- Under it: how fresh the position is ("Position updated 12 seconds ago") and how accurate.
- It refreshes by itself every 8 seconds. When the pro taps Arrived, it changes to "has arrived".
- There are also links to open the pro's position, or the job location, in Google Maps.

**For the pro**
- Tapping "On My Way" first asks them to agree: their live location is shared with this customer, and only this customer, until they tap Arrived.
- A bar stays at the bottom of their screen the whole time: "Sharing your location with your customer until you tap Arrived."
- A **Trip map** button shows the same map from their side, with "0.8 miles to go" and a **Get directions in Google Maps** link that starts turn-by-turn navigation to the job pin.
- Tapping Arrived stops the sharing and removes the bar.

**The map** is drawn with Leaflet, a free open-source map library that now ships with the site, using OpenStreetMap street maps. No paid maps account is needed.

## How this differs from Uber, honestly
Uber is an app installed on the phone. Trothen is a web page. That causes three real differences:

1. **The pro has to keep the Trothen page open with the screen on.** A web page can't send location while the phone is locked or while the pro is in another app. The page asks the phone to stay awake during the trip, and picks up again when the pro comes back to it, but if they lock the phone the dot stops moving. The customer is told: after 90 seconds without an update it says "Their phone may be locked or out of signal. This is their last known position."
2. **The distance is a straight line, not the road distance**, and there is no arrival-time estimate. Road routes and arrival times need a paid routing service.
3. **The pro using Google Maps for directions means leaving the Trothen page**, which pauses the sharing until they switch back. On most phones they can use split screen, or glance back at Trothen now and then.

Removing these limits means building a phone app (Android and iPhone). That is a separate project.

## Privacy
- The pro's position is only sent between "On My Way" and "Arrived", and never for more than 6 hours.
- Only the customer and the pro on that one booking can see it. I tested that another pro, the customer trying to send, and someone not signed in are all refused.
- The live position is wiped when the pro taps Arrived. Signing out also stops the sharing.
- The pro has to agree each time before it starts.
- For the privacy policy: Trothen now handles a pro's live location during a trip. Attorney.

## Things to know
- **A booking needs a location pin (v92) for the distance to show.** Without a pin, the customer still sees the pro's dot and its freshness, but no distance.
- **OpenStreetMap's free map service is meant for light use.** It is fine while Trothen is small. If the site gets busy, I'll need a paid map-tile provider (a few dollars a month to start). The maps also need mobile data to draw; the distance and the links work even if the map picture doesn't load.
- **Data use:** a position is a tiny message sent about every 10 seconds while moving.
- **I couldn't see the street map itself in testing**, because the test machine can't reach OpenStreetMap. The map frame, both dots and their labels drew correctly. On the live site the streets should appear behind them. That is the first thing to check after deploy.

## Tested
- **Server:** before "On My Way" the customer sees "not started" and the pro's position is refused; after it, positions are accepted and both people see the pro's position, its age and the distance; another pro, the customer, and a visitor are refused; an impossible position is refused; after Arrived the status is "arrived", further positions are refused and the live position is wiped.
- **Two browsers at once:** a pro on a phone-sized screen moving toward the job along a simulated route, and the customer watching on a desktop.
  - The pro saw the agreement, then the sharing bar, then "260 feet (80 m) to go".
  - The customer saw the Track your pro button, "Lib Pro is coming", "260 feet (80 m) away", the freshness line, both dots on the map and both map links.
  - After the pro tapped Arrived: the pro's bar disappeared and location watching stopped; the customer's window changed to "Lib Pro has arrived. Live location sharing has stopped."
- Nothing was blocked by the security policy. No script errors. Every section still opens for a visitor, customer, pro and super admin.
- **Not tested:** real phones on a real road. That is the test that matters.

## Files (complete replacements; three are new)
| File | Bytes | |
|---|---|---|
| server.js | 21496 |  |
| public\index.html | 1253398 | changed in v93 |
| public\vendor\leaflet\leaflet.js | 147552 | new in v93 |
| public\vendor\leaflet\leaflet.css | 14806 | new in v93 |
| public\vendor\leaflet\LICENSE.txt | 1395 | new in v93 |
| src\auth.js | 9391 |  |
| src\platform-settings.js | 21616 |  |
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
| src\routes\admin.routes.js | 212742 |  |
| src\routes\marketplace.routes.js | 126763 |  |
| src\routes\payments.routes.js | 66639 | changed in v93 |
| src\routes\auth.routes.js | 81162 |  |
| src\routes\misc.routes.js | 58897 |  |
| src\routes\portfolio.routes.js | 12210 |  |

The three Leaflet files go in a **new folder**, public\vendor\leaflet. Everything else unchanged since v92 is included so this zip is complete on its own.

## Deploy (cmd.exe, not PowerShell)
1. Unzip trothen-v93-files.zip.
2. From the unzipped folder (replace the path with my repo folder). The first line makes the new folder:
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
4. Push. The new folder has to be added too:
   ```
   git add server.js public\index.html public\vendor\leaflet\leaflet.js public\vendor\leaflet\leaflet.css public\vendor\leaflet\LICENSE.txt src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md CHANGES_v93.md
   git commit -m "v93: live trip tracking with a map between On My Way and Arrived"
   git push
   ```
5. After Render finishes, test with two phones (or a phone and a computer):
   - As a customer, book a pro and pin the job location.
   - As the pro, confirm the booking, tap On My Way, and agree to share.
   - As the customer, press Track your pro. I should see a street map with two dots and the distance.
   - Walk around with the pro's phone, screen on, and watch the dot move.
   - Tap Arrived and confirm the customer's window says so.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
