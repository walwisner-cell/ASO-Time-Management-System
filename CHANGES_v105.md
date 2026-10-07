# Trothen v105: pro stores, extra skills, pick-up and drop-off, business tools

This is what Joseph asked for in his WhatsApp messages. I had it built in one release. Below is what each part does, the choices I made where his message could be read two ways, what was tested, and what code cannot settle.

## 1. A pro can open a store (optional)

A pro now has a **My Store** page in their menu. Nothing changes for a pro who never opens it.

- The pro names the store, adds goods with a photo and a price, and switches the store on.
- **A manager checks every good before it goes live.** Goods wait in a new admin page, **Stores & Skills**. The manager approves, or turns it down with a reason the pro sees. A regional admin only sees pros in their own city or country. The verification and customer service teams can do this too; finance, legal, HR and sales cannot.
- If the pro later changes a good's name, description or photos, it leaves the store and is checked again. Price and stock can be changed at any time without a new check.
- **Outside the store, customers only see the store's name**, under the pro on their card, quick view and profile. Goods and prices are not sent to the page at all until someone opens the store.
- Inside the store the customer sees goods with photos and prices and picks quantities with + and −.
- **What they pick goes to the booking as the materials cost and is paid when they book**, in the same step as the job. The money is held like any other booking.
- A customer can also order **just the goods, with no job**.
- A manager can close a store, with a reason. The pro cannot reopen it until the manager allows it.
- These can never be listed: weapons, drugs, medicines, alcohol, tobacco, counterfeit goods, protected wildlife. The site refuses them by keyword and the manager is the second check.

## 2. A flat fee on store purchases, not commission

- When a booking includes goods, the customer pays **one flat store purchase fee**. It starts at **$5**.
- **The super admin sets the amount** in Stores & Skills. Changing it only affects new bookings. Each change is recorded in the access log.
- **No commission is taken on goods.** When the pro is paid, the goods part of the booking is left out of the commission sum. Commission still applies to the job part as before.
- The 9% service fee is worked out on the job only, not on the goods.
- The super admin also has one switch that turns every store off.

Example that was tested: job $40, goods $26. The customer pays $40 + $3.60 service fee + $26 + $5 store fee = $74.60. The pro is paid commission on $40 only.

## 3. More than one skill

- A pro keeps one main skill and can add **up to four more** in Settings, under **Extra skills**.
- They are found under any of them: in category lists, in search, and when a customer posts a job in that kind of work.
- A skill in a **licensed trade** (plumbing, electrical, roofing and the others on the existing list) waits for a manager, because a licence for one trade does not cover another. Other skills are live at once.

## 4. Pick-up and drop-off, with photos and location

On any confirmed booking there is a new **Pick-up & drop-off** button, for both the customer and the pro.

- Either of them takes photos at pick-up and again at drop-off. Each record shows who took it, when, and where the phone was.
- From the pro's pick-up record until the pro's drop-off record, **the pro's phone records the route**, and both sides can see it on a map.
- The records are added to the booking's PDF.
- Positions and the route are removed 90 days after the booking ends, like the other location data. The photos and times stay.

## 5. Business tools for pros

A new **Business Tools** page with eight tabs:

- **Summary:** income, costs, profit, tax collected, month-by-month bars, best-selling goods, and what needs attention (low stock, tools due for service, quotes waiting, unpaid invoices).
- **Quotes & estimates:** build one from lines, add goods from stock with one tap, add tax and a discount, download a PDF, turn it into an invoice.
- **Invoices:** every completed Trothen booking gets an invoice automatically. The customer can download the same invoice from their bookings. A pro can also write invoices for work done outside Trothen.
- **Inventory:** stock for every item, a low-stock warning, cost and selling value. Stock goes down when a customer books goods and comes back if the booking is declined, runs out of time, or is cancelled before hand-over.
- **Tools:** what the pro owns, where each tool is or who has it, its condition, and when service is due.
- **Expenses:** amount, date, kind, who was paid, and an optional receipt photo.
- **Tax report:** income, tax collected, expenses, Trothen commission and profit for any period, as a PDF or a spreadsheet.
- **Tax & invoice details:** tax rate, what the tax is called, tax number, and the contact line printed on papers.

## Choices I made where the request could be read two ways

1. **Who pays the flat fee.** I made it the customer, added at checkout, where they can see it before paying. If Joseph meant it should come out of the pro's money instead, that is a small change.
2. **Who takes the pick-up and drop-off photos.** Joseph wrote "customer". I let both the customer and the pro do it, and the route is recorded from the pro's phone, since the pro is the one carrying the materials.
3. **Stock.** Counting stock is optional per good. If a pro leaves it blank the good never sells out.

## Two older problems found and fixed along the way

- **The booking amount was higher than the form showed.** The form showed "job amount plus 9% service fee", but the page sent the job amount with a little extra already added (8% of the hourly rate, or 8% of an offer), and the server then added its fee on top. A $40 job at $20 an hour was recorded as $42. The page now sends the job amount as shown.
- **A dropped connection while the page loaded signed the person out.** If the first request failed for any reason, the saved sign-in was thrown away. Now it is tried three times, and the sign-in is only removed when the server itself says it is no longer good. This matters on weak connections.

## What was tested

- 88 checks on stores, booking with goods, hand-over, payout and skills.
- 34 checks on the business tools, including the sums on quotes, invoices and the tax report.
- 34 checks that the older flows still work: a plain booking from start to payout, job post to hire, a dispute, stock given back on cancel and on time-out, and every admin page.
- 52 checks in a real browser as a pro, a manager and a customer, including a phone-width screen and store names and good names written as hostile code.
- 8 checks that every section for every kind of account still opens, and that the "Live now in" strip on the home page is where it was.

All 216 passed.

Not tested, because the test machine cannot reach them: map pictures from OpenStreetMap, a real phone camera, and real GPS on the road.

## What code cannot settle

- **No real money moves yet.** Store purchases are simulated like every other payment, until Stripe is connected.
- **Selling goods is a new kind of business for Trothen.** Please ask the attorney about: who is the seller (I have written it as the pro, with Trothen taking a fee), returns and refunds on goods, faulty or unsafe goods, and whether the Provider Agreement and customer terms need a section on stores. The current agreements do not mention goods.
- **Tax on goods.** In some places a marketplace has to collect sales tax or GST on goods sold through it. Please ask the accountant for Liberia, Ghana, Nigeria and the US. The site does not collect any tax on store purchases.
- **The tax report is record-keeping, not tax advice.** It says so on every copy.
- **The list of banned goods** is my first list. Joseph and the attorney should agree the real one, and managers need to be told what to turn down.
- **Route recording only works while the pro keeps the Trothen page open** with the screen on. A phone app would be needed to record in the background.
- **Spanish:** the store, booking and hand-over screens are translated. The pro's business tools and the admin page are in English only.
- **Quotes and invoices are downloaded as PDFs** and sent by the pro themselves. They are not sent through Trothen.

## If the privacy policy was edited in Settings

The built-in privacy policy now covers stores, business records, and pick-up and drop-off locations. If I saved my own version in Admin, Settings, my version stays and these three paragraphs need pasting in:

- In "What we collect": *Stores and business tools (pros only, optional). If you open a store: its name, your goods, their photos and prices, and your stock. If you use the business tools: the quotes, estimates and invoices you write (including the customer name and contact you type in), your list of tools, and your expenses and receipt photos. Only you can see your business records. Your store name is public, and your goods and prices are shown to anyone who opens your store once a Trothen manager has approved them.*
- In "Location": *Pick-up and drop-off. When goods or materials are carried as part of a booking, the customer or the pro can take photos at pick-up and at drop-off. Each record keeps who took it, when, and where the phone was, if the phone gives a position. From the pro's pick-up record until the pro's drop-off record, the pro's phone also records the route taken, while the Trothen page is open. Only the customer and the pro on that booking, and Trothen staff handling a dispute, can see these.*
- In "How long we keep it": *Pick-up and drop-off. The positions on pick-up and drop-off records, and the recorded route, are removed on the same 90-day rule. The photos and times stay with the booking as the record of the hand-over.*

## Files

New: `src/store.js`, `src/routes/store.routes.js`, `src/routes/business.routes.js`.

Changed: `server.js`, `public/index.html`, `src/admin-scope.js`, `src/booking-scheduler.js`, `src/location-retention-scheduler.js`, `src/account-privacy.js`, `src/go-live.js`, `src/platform-settings.js`, `src/routes/marketplace.routes.js`, `src/routes/payments.routes.js`, `src/routes/admin.routes.js`.

New data files appear by themselves on the server's disk the first time they are used: `storeGoods.json`, `proTools.json`, `proExpenses.json`, `proDocs.json`. The nightly backup picks them up automatically. No new settings are needed on Render.
