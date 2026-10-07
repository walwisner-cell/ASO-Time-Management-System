# Trothen v89: Joseph's review list

## What this is
Joseph went through the live site and sent a list by WhatsApp. This version works through every item. For each one I say what was done, and where it needs something that code can't do.

## 1. "You pay Trothen" wording
**Asked:** say the customer pays the provider, and the payment is held in escrow.
**Done.** Everywhere it appeared:
- Agreement checkbox (customer): "I pay my pro through Trothen. The payment is held in escrow until I mark the job complete."
- Agreement checkbox (pro): "The customer pays me through Trothen. The payment is held in escrow and released to me when they mark the job complete, less the commission shown on my dashboard."
- Homepage card "Your money waits", its first step, and the job ticket note.
**For the attorney:** "escrow" is a regulated word in some places (in parts of the US, holding money "in escrow" can need a licence). Payments are still simulated today. Before real money moves, the attorney should confirm we may use this word, or tell us the wording to use.
**Note:** if I changed any of those homepage texts myself in Settings → Front page wording, my version is what shows; the new built-in wording appears when I press Reset on that box.

## 2. Customer subscription in local currency
**Asked:** the customer membership still shows in USD.
**Done.** Outside the United States the membership price is now shown in the customer's own currency first (for example "L$1,898/mo"), with "LRD · about $9.99" underneath. It uses the same exchange rates as the rest of the site.
**Why Joseph still saw dollars:** his test account is set to United States (Philadelphia), where dollars are correct. An account whose country is Liberia, Nigeria or Ghana sees its own currency.
**Still true:** payments are simulated and the amount recorded is in US dollars.

## 3. Provider score
**Asked:** it adds up to more than 100; give the most points to the most important activity.
**He was right.** The nine parts added up to 120, with the total capped at 99.
**Done.** The parts now add up to exactly 100, the total is shown out of 100, and the order follows the work itself:

| Part | Points before | Points now |
|---|---|---|
| Jobs completed | 15 | 20 |
| Customer trust rating | 15 | 20 |
| Low cancellation rate | 20 | 15 |
| Arrived on time | 10 | 15 |
| Identity verification | 10 | 10 |
| Responding to jobs | 15 | 7 |
| Repeat customers | 15 | 5 |
| License / documents | 10 | 4 |
| Background check | 10 | 4 |
| **Total** | **120** | **100** |

The highest score anyone can be shown is still 99.
**Something to decide:** a brand-new pro with an approved ID and no jobs starts at about 76. That is the existing rule (a new pro gets the benefit of the doubt on on-time, cancellations, trust and so on until they have a track record). If Joseph and I would rather new pros start lower and earn their way up, that is a small change; I need to say what a new pro should start at.
Everyone's score is recalculated the first time the server runs after deploy.

## 4. Background check
**Asked:** please activate background check.
**What it was:** the "Background Check" points were being given to anyone whose ID was approved. It was not a separate check.
**Done:** it is now a real result. A pro earns it when the verification team has actually spoken to their guarantors and marked them verified (Admin → Verification Queue → guarantors): one verified guarantor earns half, two or more earn all of it.
**What code can't do:** a criminal-record background check needs an outside company. In the US that is a service like Checkr, which is paid per check and needs the pro's written consent. In Liberia, Nigeria and Ghana there is no equivalent online service, which is why the guarantor system exists. If I want real record checks for US pros, I choose a provider and Claude can connect it.

## 5. "Highest Trust Score in Philadelphia today"
**Asked:** this should be once at the end of every month, per country, not per region.
**Done.**
- One award per country per calendar month, given just after the month ends.
- Only pros who completed at least one job in that month can win. (Before, a new pro with no jobs could win, every day.)
- Highest score wins; a tie goes to whoever completed more jobs that month.
- The prize is the same: one commission-free payout.
- The message now reads: "You had the highest Trothen Score in Liberia for September 2026."

## 6. Commission on the sign-up area
**Asked:** remove the commission price from the sign-up area; keep it in the system.
**Done.** The three lines "13% / 12% / 10% commission per job" are gone from the Provider Plans page that pros see before signing up. Commission still works exactly as before, and a pro still sees their rate on their dashboard and on each payout.
**For the attorney:** a pro now doesn't see the rate until after they have an account. The agreement checkbox mentions "the commission shown on my dashboard", and the rate should be stated in the provider Terms of Service so nobody can say it was hidden.

## 7. "Don't enter real card details"
**Asked:** remove it, because people confuse "card" with their ID card.
**Done.** It is gone from the banner at the top of every page. The warning now appears only where a bank card can be typed (Payments → Add Payment Method), and it says plainly: "Please don't type a real debit or credit card number here... This is about bank cards only. Your ID is handled under Verification."
I kept it there because payments are still in test mode and a real card number should not be typed in.

## 8. "Phone verification: why should a provider verify themselves?"
**Answer:** this is not the ID check. It only proves the phone number on the account belongs to that person: we text a 6-digit code and they type it in. It is what lets booking alerts and sign-in codes reach the right phone. It is optional.
**Done:** the wording caused the confusion, so the panel is now called "Confirm your phone number", the button says "Text me the code", and the text explains it in one paragraph and says it is separate from the ID check.
**Note:** real texts need Twilio connected. Until then the code is shown on screen.

## 9. "I created a regional administrator account but it is not working"
**I could not reproduce a failure.** Claude created a regional admin for Monrovia on a copy of the site in live mode and signed in as them from start to finish, twice. The path is:
1. Email and the starting password.
2. A 6-digit sign-in code (every admin has two-step sign-in).
3. A "Set your password" screen: type the starting password again, then a new one.
4. The dashboard for their city.

**Things that would make it look broken, and what I changed:**
- **The code step.** If email is connected on the live site, the code is emailed to the admin's address. The screen now says where it went ("We sent a 6-digit code by email to f•••@yahoo.com... check your spam folder"). If the address can't receive mail, the error now says so instead of "try again". If the Yahoo mailbox was only being created that day, the code had nowhere to go.
- **The "Set your password" screen gave a wrong rule.** It said "9+ characters, 6+ numbers, 2+ letters, 1+ symbol". The real rule is 8 or more characters and not a common password. Someone trying to follow the wrong rule could easily give up. Fixed in both places it appeared.
- **A regional admin only sees their own city.** One created for Monrovia sees Monrovia's users, jobs and payments, not all of Liberia. With few users in that city, the dashboard looks empty. This is how it was designed. If regional admins should cover a whole country, that is a change I need to ask for.

**What I need from Joseph to go further:** which step it stopped at, and the exact message on the screen.

**Important:** the admin's email and starting password were typed into a WhatsApp chat and photographed. Joseph's own sign-up password is also readable in one of the photos. Both should be changed now. The admin's can be reset from Admin → Customers & Providers → Reset password.

## Also from the photos
- The sign-up form, the agreement checkboxes, and the "Your data and your account" panel in the photos are all working as built.

## Tested
- Score: for four different pros the parts add up to the total and the maximums add up to 100. A pro with two verified guarantors gets 4/4 for background check, one gets 2/4, none gets 0/4.
- Award: on sample data with jobs completed last month, exactly one winner per country (Liberia and the United States); running it again the next day awarded nobody; a new pro with no jobs did not win.
- Membership: a Liberian customer sees "L$1,898/mo · LRD · about $9.99"; a US customer sees "$9.99/mo".
- Plans page: no commission percentages. Banner: no card warning. Card form: the new note is there.
- Regional admin: created and signed in through all four steps in live mode.
- Every section opened for a visitor, customer, pro and super admin with no errors.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 21496 | |
| public\index.html | 1223291 | changed in v89 |
| src\auth.js | 9391 | |
| src\platform-settings.js | 21616 | |
| src\validators.js | 17730 | |
| src\terms.js | 1245 | |
| src\plan-billing.js | 7530 | |
| src\id-retention-scheduler.js | 2249 | |
| src\file-crypto.js | 2776 | |
| src\backup-scheduler.js | 2385 | |
| src\account-privacy.js | 8577 | |
| src\provider-score.js | 15841 | changed in v89 |
| src\provider-score-scheduler.js | 5238 | changed in v89 |
| src\top-scorer-promotion-scheduler.js | 3512 | changed in v89 |
| src\routes\admin.routes.js | 208143 | |
| src\routes\marketplace.routes.js | 122352 | changed in v89 |
| src\routes\payments.routes.js | 60475 | |
| src\routes\auth.routes.js | 81081 | changed in v89 |
| src\routes\misc.routes.js | 58805 | |
| src\routes\portfolio.routes.js | 12210 | |

Six files changed in this version. The other fourteen are the same as v88 and are included so this zip is complete on its own.

## Deploy (cmd.exe, not PowerShell)
1. Unzip trothen-v89-files.zip.
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
   ```
3. Check the sizes against the table:
   ```
   cd /d "%REPO%"
   for %I in (server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md
   git commit -m "v89: Joseph's review list - score to 100, monthly country award, wording, local currency"
   git push
   ```
5. After Render finishes:
   - Provider Plans page: no commission percentages.
   - Top banner: no "Don't enter real card details".
   - Sign in as a pro: the score box shows "/ 100" and the parts add up.
   - Sign in as the regional admin and note exactly where it stops, if it does.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
