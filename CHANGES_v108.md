# Trothen v108: Joseph's store list, and five limits from the manual

This release has two parts. The first is the list Joseph sent on WhatsApp. The second is the five limits I picked out of the operations manual. Two of those five turned out differently from what the manual said, and I say so below.

## Part 1. Joseph's list

### 1. A manager approves the store itself

Before, a manager only approved goods. A store went live by itself when its first good was approved, and the manager's screen had "Close store" but nothing to approve. Now:

- A new store waits for a manager. An approved good is not enough.
- In **Stores & Skills** the manager sees **Approve store** and **Turn down** (with a reason the pro is shown), and a plain sentence for every store saying why it is or is not live.
- If the pro renames the store or rewrites its description, it is checked again. Switching it off and on, or changing its options, is not.
- **Every store that already exists will show as "waiting for approval" after this deploy.** That is on purpose, so Joseph can approve them. It also means James's store is not live until he does.

### 2. Store on and off, and store options

- The on/off switch is at the top of **My Store**. Switching off hides the store name at once. Switching on again needs no second approval.
- **Store options** are new: which ways customers can get goods (collect, I bring it, a driver), where to collect, and my own delivery charge.
- Outside the store customers still see only the store name under the pro. Goods and prices are only inside. They see the collection place in words, never the map pin.

### 3. Buying goods without a booking

A customer can open a store, pick goods and pay, with no job, date or time. The order is confirmed and paid at once. It does not wait for the pro to accept. The seller is told, marks it **ready**, and the customer presses **I have my goods**, which releases the money.

Underneath, an order is still kept as a booking with no job part. I did that on purpose: holding the money, refunds, payouts, cancelling and "Report a Problem" all work exactly as they already do.

### 4. Receipts

Every order has a PDF receipt for the customer and the seller, and a delivery receipt for the driver. It lists the goods, the price in the currency the seller set, delivery, fees and the total. While payments are in test mode the receipt says so.

### 5. Prices in more than one currency

A pro can price each good in US dollars or in their own country's currency (a Liberian pro: USD or LRD). A price set in local money stays fixed in local money; the dollar amount follows the exchange rate set in Plans & Pricing. Shoppers and managers see both.

### 6. Delivery: collect, the seller brings it, or pick and drop

- **I collect it myself.** No charge.
- **The seller brings it.** The seller's own delivery charge is added.
- **A pick-and-drop driver.** The site suggests up to six drivers with their vehicle and price. The customer picks one and approves that price. The driver has 30 minutes to accept. If they decline or do not answer, the delivery money is refunded and the customer picks another driver or collects.

How drivers work:

- A driver is a verified pro with the **Pick & Drop** skill. They set a starting price and a price per mile or kilometre in Settings.
- The driver is paid separately from the seller. The seller records handing the goods over, the driver records pick-up and drop-off with photos, and the route is recorded, using the hand-over tools from v105.
- **I have my goods** completes the order and the delivery together.

**Fees I had to choose, which are mine and Joseph's to confirm:** goods carry the flat store fee and no commission, as before. Delivery is treated as a service: 9% on top for the customer, with no minimum (the usual $2.99 minimum would be more than some rides), and the driver's normal commission.

### 7. Provider score missing from the pro dashboard

I could not make it disappear on my copy. I did find one way it could happen on the live site: one line in the score depended on a file added in v106, and if that file was missed in a deploy, or a guarantor list was saved in an odd shape, the whole score failed to load. That line can no longer stop the score. If it is still missing after this deploy, I need a screenshot of the dashboard.

### 8. "Customer id is not verified"

That was answered in v107: approving an account does not verify the person; approving their ID in the Verification Queue does. The admin screens now say so.

## Part 2. The five limits from the manual

### HEIC photos: fixed

An iPhone HEIC photo is now turned into JPEG on the person's own device before it is sent. The converter is a copy kept on our own site, not loaded from anyone else. A full-size phone photo took about one second in testing. The server still refuses a raw HEIC file, which is right, because it should never receive one now.

### Security policy: partly fixed, and I can say exactly how far

The page's code has moved out of `index.html` into its own files in `public\app`. `index.html` went from 1.5 MB to 238 KB. Because of that the policy now refuses any script written into the page itself, and still refuses code built from text. Those were the two common ways injected code runs.

What is left: the site's own buttons still say what to do in the page (onclick). Allowing those stays on. Closing it means rewriting every button on the site, which is a project of its own and not something to rush into a release with everything else.

### Disputes with a split: already there

The manual was out of date. A split outcome (part back to the customer, the rest to the pro) has been in since v96. I have corrected the manual. No code changed.

### Postgres: brought up to date

The Postgres option had fallen behind: 8 newer kinds of record were missing and some money fields came back as text. It now keeps every record whole, so it cannot fall behind again when a release adds a field. It was tested on a real PostgreSQL 16: the same 407 server checks pass on it as on the files, and 2,135 side-by-side comparisons match.

**The live site still runs on files, and this release does not change that.** Moving is a decision with steps, listed at the end.

### Spanish on the newer pages: done

Provider Plans, Careers, Contact and the agreement screen are now in Spanish when Spanish is chosen. The full terms themselves stay in English and say so, because a legal text should not be machine-translated.

## What was tested

- 407 checks on the server, 135 of them new.
- 214 checks in a real browser, 87 of them new, including HEIC conversion and the new security policy.
- The Postgres checks above.

All passed.

## What still needs a person, not code

- **Stripe.** No real money moves. Orders, delivery and receipts are simulated like every other payment.
- **Drivers.** The site checks a driver's ID like any pro. It does not check a driving licence, vehicle papers or insurance. Whether Trothen should, in each country, is for the attorney and for Joseph and me.
- **The delivery fee rule** in section 6.
- **Attorney.** The store rules and the customer terms do not yet cover orders without a booking, or delivery by a third person (who is responsible if goods are lost or damaged on the way).
- **Accountant.** Tax on goods and on delivery.
- **An order waits for the customer to press "I have my goods".** There is no automatic release after a number of days. I need to decide that number.
- **The Spanish** has not been read by a native speaker.
- **Not tested on real devices:** HEIC on an actual iPhone, GPS on the road, phone cameras.

## Deploying: two things are different this time

1. There is a **new folder, `public\app`**, and new files in `public\vendor\libheif`. Copy whole folders, not single files. If `public\app` is missing the site shows a plain notice and nothing else.
2. `src\migrate-json-to-postgres.js` is not part of this. Nothing uses it.

No new settings are needed on Render. This package includes everything from v86 onward.

## If I decide to move to Postgres later

Not needed now. When I do, at a quiet time:

1. In Render, create a PostgreSQL database in the same region. Copy its Internal Database URL.
2. In the web service's Shell run: `DATABASE_URL="<the URL>" DATA_DIR=/var/data node scripts/json-to-postgres.js`
3. The last line must say Postgres matches the files exactly. If any line says DIFFERENT, stop.
4. Add `DATABASE_URL` in the service's Environment and save.
5. Keep the disk. Photos and ID documents stay on it, and the files are the way back (remove `DATABASE_URL`).
6. Turn on the database's own backups in Render, because the nightly in-app backup does not run on Postgres.

Never set `DATABASE_URL` before step 2. The site would come up with no accounts (the data would still be safe on the disk).

## Files

New: `public\app\trothen.js`, `public\app\theme.js`, `public\vendor\libheif\` (4 files), `src\store-orders.js`, `src\routes\orders.routes.js`, `scripts\json-to-postgres.js`, `scripts\pg-parity-check.js`.

Changed: `public\index.html`, `server.js`, `src\store.js`, `src\provider-score.js`, `src\booking-scheduler.js`, `src\platform-settings.js`, `src\db-postgres.js`, `src\schema.sql`, `src\routes\store.routes.js`, `src\routes\marketplace.routes.js`, `src\routes\payments.routes.js`.
