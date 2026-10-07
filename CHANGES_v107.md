# Trothen v107: customer verification, a shorter home page, and advertising

Three things in this release. Each one came from something I saw on the live site.

## 1. "Customers are not being verified"

I checked the whole path. A customer uploading an ID, the ID reaching the Verification Queue, and an admin approving it all work. The customer becomes Verified. Nothing was broken there. Two things on the admin screens made it look broken:

- **User Approvals → Approve does not verify anyone, and never did.** It only lets the account in. The screen said "Approved successfully" and the person stayed Unverified, with nothing to explain why.
- **A customer-service admin has "Verification Queue" in their menu, but the server does not let them open ID documents.** The page said "Nothing is waiting for review", which was not true.

What I changed:

- Every admin list of people now shows where the person's ID stands: **ID approved**, **ID waiting for review**, **ID rejected**, or **No ID sent yet**.
- After I approve an account, a message tells me plainly that the person is still Unverified until their ID is approved in the Verification Queue.
- The Verification Queue has a new list, **Waiting on the person**: people whose account is active but who have sent no ID, or whose ID was rejected. A **Remind** button sends them a notice (once a day at most).
- An admin who is not allowed to open IDs is now told so, and told who can, in place of "Nothing is waiting".
- When someone sends an ID, the country-wide admin for their country is now notified too. Before, only city admins and super admins were.

**Two decisions that are mine, not the code's. Nothing was changed here:**

1. Should customer-service admins be allowed to open ID documents? Today only a super admin, the verification team and the regional admin for the person's area can.
2. Should approving an account ever mark a customer Verified without an ID? Today it does not, and I think that is right, because "Verified" is what customers and pros trust.

## 2. A shorter home page with drop-downs

The home page was very long, mainly because the "Live now in" strip listed about 190 countries. On a phone it was 14,830 pixels tall. It is now 8,070. On a computer it went from 7,841 to 5,611.

- **Live now in**: stays exactly where it was. It shows Liberia, Ghana, Nigeria and the United States first, then a **+ more countries** button that opens the full list in place.
- **Kinds of work**: 6 on a phone, 12 on a computer, then **Show all**.
- **Pros** and **popular projects**: the first few, then **Show more**.
- **The four checks** ("Before a pro can take your job"): each one shows its title, and the explanation drops down when pressed.
- **Our mission**: the first lines, then **Read more**.

Nothing was removed. Everything opens with one press and closes again.

## 3. Advertising, fixed

What was wrong:

- Only **one** live ad was ever shown: the first one found. A second advertiser was never seen.
- A city ad was only shown when the visitor's city was typed exactly the same way, and **never to someone not signed in**. Most visitors are not signed in.
- An ad **never ended**.
- When I approved a pro's ad and left the second line blank, it **erased what the pro wrote**.
- **Close** left a live ad showing on the home page.
- A pro was never told their ad was approved or turned down, and could not take their own ad down. The page told them to contact support.
- Nobody could see whether an ad was being looked at.
- The home page labelled a paid ad "Featured pros".
- On a phone a longer ad was cut off, because the box had a fixed height.
- A country-wide admin could not see an ad placed by an outside company for a city in their country.

What it does now:

- **Every live ad takes its turn** (up to six), then the featured pros, then the invitation to advertise.
- **Who sees which ad:** ads for the visitor's own city first, then ads for another city in the same country, then platform-wide ads. A visitor whose place is not known sees platform-wide ads first, then city ads. Capital letters and spaces in a city name no longer matter.
- **Paid ads are marked "Sponsored".** The box is labelled "Featured".
- **An ad runs for a number of days I choose when I approve it** (1 to 365, 30 if I leave it). It comes down by itself, and the pro is told how many times it was seen.
- **Counting:** how many times an ad was on someone's screen and how many times its button was pressed. Only totals are kept. Nothing about the visitor is stored.
- **The pro's side:** they see whether the ad is waiting or live, the end date, the counts, and a **Take my ad down** button. If it was turned down they see my reason. They get a notice when it goes live, is turned down, is taken down, or finishes.
- **The admin side:** the list is split into Waiting for me, Live now and Closed, with four columns in place of nine. **Details** drops down the contact, message and ad text. **Approve** opens with the advertiser's own words already filled in. **Turn down** asks for a reason. Closing a live ad takes it down.
- The box stops turning while someone has their pointer or finger on it, and does not turn by itself for people who have asked their device for less motion. A long ad is shown in full on a phone.
- A pro's ad with no web link gets a **See this pro** button that opens their Trothen profile.

## What was tested

- 272 checks on the server, 52 of them new for advertising.
- 126 checks in a real browser as an admin, a pro, a customer and a signed-out visitor, on computer and phone width, 40 of them new.

All 398 passed.

## What still needs a person, not code

- **Ad payments are simulated**, like every other payment, until Stripe is connected. A pro's ad price is recorded but nothing is charged. This also means nothing is refunded when an ad is turned down or taken down early. Before real money moves I need to decide the refund rule for those two cases.
- **Advertising terms.** There is no written agreement for advertisers (what may be advertised, refunds, how long). That is for the attorney.
- **"Seen" is a simple count.** It counts once per ad per page load. It is not an audited figure and I should not sell it as one.
- **A visitor's city is only known if they are signed in or have typed a place in the search box.** The site does not look up location for ads.
- The two verification decisions in section 1.
- Everything listed in CHANGES_v106.md under the same heading still stands.

## Files

New: `src/ads.js`.

Changed: `public/index.html`, `server.js`, `src/routes/admin.routes.js`, `src/routes/misc.routes.js`, `src/routes/marketplace.routes.js`.

No new settings are needed on Render. This package includes everything from v86 onward, so earlier packages do not need deploying separately.
