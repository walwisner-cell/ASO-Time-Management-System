# Trothen v92: GPS that works in Liberia

## What I asked for
Can we use GPS, especially in Liberia, where it is a challenge?

## What was already there
- A customer could press the location button in the search box to sort pros by distance.
- A pro could share their location and set how far they travel.
- "On my way" and "Arrived" recorded where the pro was.

## Why it wasn't enough for Liberia
1. **A job had no location a pro could navigate to.** A job posted for matching carried no address at all. A direct booking demanded a street address of at least 5 characters, and most places in Liberia don't have one.
2. **The site gave up on GPS too fast.** It asked the phone once and stopped after 8 to 10 seconds. A phone, especially a low-cost one, often needs longer than that to find satellites, and under a zinc roof it may not find them at all.
3. **It never said how good the fix was.** A reading that was 2 km off looked the same as one that was 10 m off.
4. **One number was made up.** The "distance" shown to a pro on each job match was a random figure. It was not measured from anything.

## What I changed

**1. "Where is the job?" on both Post a Job and Book a Pro.**
- **Pin my current location:** the customer stands at the place and presses it. The site saves the GPS position.
- **Landmark or directions:** in their own words, for example "Blue gate behind the Total station, ELWA Junction".
- **Type the location instead**, for when GPS won't work or the customer isn't there: coordinates, a full Plus Code, or a Google Maps link.
- For a direct booking, any one of these is now enough: a pin, a landmark, or a street address. The street address is no longer required.

**2. A Plus Code for every pin.**
A Plus Code is a short code for a spot on the earth, like 6CRF858V+62. Google Maps understands it, it works offline, and it can be read out over the phone or sent by text. The site works it out from the GPS position by arithmetic, with no outside service. I checked the result against two published reference codes and they match exactly.

**3. The hired pro gets a way to find the place.**
On their bookings list: **Open in Maps** (opens the exact spot), the Plus Code, the landmark, and a warning if the pin was only rough.

**4. Privacy: only the hired pro sees the exact spot.**
A pro who is merely matched to a job sees how far away it is, rounded to the nearest half mile and worked out from their own shared location. They don't get the pin or the landmark. Those appear when the customer hires them.

**5. A patient location reader, used everywhere.**
- It keeps listening for up to 25 seconds and keeps the best reading it hears.
- It stops early as soon as the reading is good (within 30 m for a job pin).
- If GPS gives nothing, it tries once more using mobile masts and Wi-Fi, which is rougher but usually works indoors.
- It always says how accurate the result is: "accurate to about 22 m", or "very rough: within about 1.8 km" with advice to step outside or add a landmark.
- If location is blocked or fails completely, it says what to do, and the customer can still type a location or just describe a landmark.
The search box, the pro's "share my location", and "On my way" / "Arrived" all use it now.

**6. The made-up distance is gone.** A job match now shows the real rounded distance, or "Share your location to see" if the pro hasn't shared theirs, or a dash if the job has no pin.

## What this can't fix
- **A phone with no GPS chip, or with Location switched off**, can't be pinned. The typed location and the landmark are there for that.
- **Mobile data.** The page needs a connection to load and to save. Finding the GPS position itself doesn't use data, and a Plus Code works offline in Google Maps once the pro has it.
- **A wrong pin.** If the customer pins from somewhere other than the job site, the pin is wrong. The form says to pin "if you are at the place now" and shows a "Check it on the map" link before they submit.
- **There is no map picture inside Trothen.** Showing a map on the page and letting people drag a pin needs a maps service (Google Maps or Mapbox), which is paid and needs an account. For now the links open Google Maps.
- **Distances are in miles**, as they already were. Liberia and the US use miles; Nigeria and Ghana use kilometres. If I want kilometres shown for those two, that is a small change.

## For the privacy policy
The site now stores the GPS position of a customer's job site (usually their home). It is shown only to the pro they hire and to admins. This belongs in the privacy policy with the other items for the attorney.

## Tested
- **Server:** a job posted with a pin and landmark; a matched pro saw no pin and no landmark, only "1.5 miles"; a matched pro with no shared location saw no distance; after hiring, the hired pro saw the exact pin and landmark and another pro saw nothing. A booking with only a pin and landmark was accepted; one with only a landmark was accepted; one with nothing was refused; one with only a street address worked as before. Impossible coordinates were refused.
- **Five GPS situations, simulated in a browser at phone size:**
  - weak signal improving over a few seconds → pinned at 22 m
  - only a rough signal → pinned and marked "very rough: within about 1.8 km" with advice
  - GPS dead but masts work → pinned and marked very rough
  - nothing works → clear message, then a Plus Code, plain coordinates and a Google Maps link each typed in and accepted; nonsense refused
  - location blocked → clear message
- The hired pro's bookings list showed "Open in Maps", the Plus Code and the landmark, with the right map links.
- Every section opened for a visitor, customer, pro and super admin with no errors.
- I did not test on a physical phone in Liberia. That is the real test: pin a job from a phone in Monrovia, hire a pro, and have the pro open the map link.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 21496 | |
| public\index.html | 1237337 | changed in v92 |
| src\auth.js | 9391 | |
| src\platform-settings.js | 21616 | |
| src\validators.js | 17730 | |
| src\terms.js | 1245 | |
| src\plan-billing.js | 7530 | |
| src\id-retention-scheduler.js | 2249 | |
| src\file-crypto.js | 2776 | |
| src\backup-scheduler.js | 2385 | |
| src\account-privacy.js | 8577 | |
| src\provider-score.js | 16908 | |
| src\provider-score-scheduler.js | 5507 | |
| src\top-scorer-promotion-scheduler.js | 3512 | |
| src\routes\admin.routes.js | 212742 | |
| src\routes\marketplace.routes.js | 126763 | changed in v92 |
| src\routes\payments.routes.js | 61503 | |
| src\routes\auth.routes.js | 81162 | |
| src\routes\misc.routes.js | 58897 | |
| src\routes\portfolio.routes.js | 12210 | |

Two files changed in this version. The rest are the same as v91 and are included so this zip is complete on its own.

## Deploy (cmd.exe, not PowerShell)
1. Unzip trothen-v92-files.zip.
2. From the unzipped folder (replace the path with my repo folder):
   ```
   set REPO=C:\path\to\trothen-backend
   copy /Y server.js "%REPO%\server.js"
   copy /Y public\index.html "%REPO%\public\index.html"
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
   for %I in (server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md CHANGES_v92.md
   git commit -m "v92: GPS job pin, landmark and Plus Code; patient location reader"
   git push
   ```
5. After Render finishes, on a phone: sign in as a customer, press Post a Job, scroll to "Where is the job?", press "Pin my current location" and allow location when the phone asks.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
