# Trothen v106: closing the gaps left after v105

After v105 I listed the things that were unfinished or that I had decided on my own. This release closes every one that code can close. The ones that need a person (attorney, accountant, Stripe, a phone app) are listed again at the end, unchanged.

## 1. Who pays the store purchase fee is now a setting

In v105 I chose that the customer pays the flat fee. Now the super admin chooses, in **Stores & Skills**:

- **The customer, added at checkout** (as before), or
- **The pro, taken at payout.** The customer pays nothing extra. The fee comes out of the pro's goods money when they are paid, and never more than the goods came to.

Either way no commission is taken on goods. A change applies to new bookings only. Fees paid by pros are counted in the finance pages as Trothen's share, and the pro sees them as a cost in their business summary and tax report.

## 2. The banned goods list can be added to

The built-in list stays (weapons, drugs, medicines, alcohol, tobacco, counterfeit goods, protected wildlife). The super admin can now add **extra banned words**, one per line. A good or store with one of those words in its name or description is refused. Only whole words are matched.

## 3. Store rules a pro must agree to

A pro cannot open a store until they tick **"I have read these rules and I agree to them"**. The date is recorded. There are six built-in rules in plain words: the pro is the seller, photos must show the real goods, only lawful goods, the customer can report a problem and be refunded from held money, tax is the pro's to declare, and Trothen can take down goods or close the store.

The super admin can rewrite the rules. If the wording changes, every pro is asked to agree again the next time they save their store.

Customers are told, inside the store and on the booking form, that the goods are sold by the pro and not by Trothen, and to use "Report a Problem" if something is missing, wrong or damaged.

## 4. Quotes and invoices can be sent through Trothen

In v105 a pro could only download a PDF. Now:

- A pro can **send** a quote, estimate or invoice to a customer they already have a booking or a conversation with.
- The customer gets a notice and has a new **Quotes & Invoices** page. They can read it, download the PDF, and **accept or decline** a quote or estimate.
- Once accepted, the pro cannot change the price. **Book this pro** opens the booking form.
- The page tells the customer plainly that accepting takes no money, and that only money paid through a Trothen booking is held and protected.

## 5. Licence proof for an extra skill

In v105 a manager was told to approve a licensed trade "only if you have seen a licence", but had no way to see one. Now the pro attaches a photo or PDF of the licence and its expiry date. The manager opens it from Stores & Skills before deciding.

The file is kept in the private area with the ID documents, is encrypted when encryption is on, is never on a public address, and every time it is opened is written to the access log.

## 6. A guarantor has to be someone else

This was on my to-do list from the live site, where a guarantor with the pro's own phone number had been marked verified.

- A pro can no longer save a guarantor with their own phone number or their own name, or the same person twice.
- Guarantors already saved are checked too. In the admin list a self-guarantor is flagged in red, the **Mark Verified** button is removed, and there is a new **Not accepted** button that tells the pro to name someone else.
- A self-guarantor that was already marked verified no longer adds to the pro's score.
- The list also notes when one phone number is used as a guarantor by several pros.

## 7. The privacy policy tells me if it is behind

If the privacy policy was edited and saved in Settings, it does not pick up new paragraphs by itself. Stores & Skills now shows a notice saying how many paragraphs are missing, and one button adds them under the right headings without touching anything else I wrote.

## 8. Spanish for Business Tools

All eight Business Tools tabs and their forms are now in Spanish when Spanish is chosen, as are the new customer Quotes & Invoices page and the store rules. The admin pages stay in English, like the rest of the admin area.

## 9. Smaller things

- A pro is notified when a sale takes a good down to its warning level or sells it out.
- The "new booking" notice to the pro says how many goods are included and that they are being held.
- Stores & Skills shows what stores have sold: confirmed bookings with goods, goods sold, and purchase fees.

## What was tested

- 220 checks on the server (store, booking, hand-over, payout, skills, business tools, older flows, and 64 new ones for this release).
- 86 checks in a real browser as a pro, a manager and a customer, on desktop and phone width.

All 306 passed.

## What still needs a person, not code

- **Stripe.** No real money moves yet. Store purchases are simulated like every other payment.
- **Attorney.** The store rules and the customer wording are written to match how the store works. They are not a reviewed contract. The Provider Agreement and customer terms still do not mention goods.
- **Accountant.** Whether Trothen must collect tax on goods sold through it in Liberia, Ghana, Nigeria or the US. The site collects none.
- **The banned list.** The tool to add words is there. Deciding the words is for Joseph and me.
- **Route recording in the background** needs a phone app. On the website it only works while the page is open and the screen is on.
- **Not tested on real devices:** map pictures, a phone camera, GPS on the road.
- **The Spanish** was written by the same hand as the rest and has not been read by a native speaker.

## Files

New: `src/guarantor-check.js`.

Changed: `public/index.html`, `src/store.js`, `src/provider-score.js`, `src/account-privacy.js`, `src/platform-settings.js`, `src/routes/store.routes.js`, `src/routes/business.routes.js`, `src/routes/marketplace.routes.js`, `src/routes/payments.routes.js`, `src/routes/admin.routes.js`, `src/routes/misc.routes.js`.

No new settings are needed on Render. This package includes everything from v86 onward, so v102 to v105 do not need deploying separately.
