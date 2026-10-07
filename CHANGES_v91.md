# Trothen v91: how a new pro is treated

## The two questions
After v90, two things were left for Joseph and me to decide:
1. What score should a new pro start at?
2. How many job matches a week should a new pro be allowed?

I asked Claude to apply the usual practice.

## The answers
**1. A new pro doesn't get a public score at all.** They are shown as "New on Trothen" until they have completed 5 jobs. This is how most marketplaces handle it: a star rating or score isn't shown until there is enough real work behind it, because a number implies a track record that doesn't exist yet.

**2. Ten job matches a week while new.** A fixed starter allowance: enough to reach five jobs quickly, small enough that an unproven account can't take on a flood of customers. After five completed jobs, the weekly allowance follows the score, as it already did.

## What changed

| | Before | Now |
|---|---|---|
| On a new pro's public card and profile | "76/99" | "New on Trothen" |
| What the public can read about a new pro's score | The number | Nothing. The number isn't sent |
| The new pro's own dashboard | A bare 76 | The number, marked "provisional", with a note saying it becomes real after 5 jobs and how many are left |
| Weekly job matches for a new pro | 15 (by way of the 76) | 10, fixed |
| Place in search results | Near the top (the 76 counted in full) | The middle: not buried, not above pros with a proven high score |
| Rewards tied to the score | A new pro could earn them | Held until 5 jobs are done |
| "Low score, call this pro" alerts to admins | Could fire for a new pro | Held until 5 jobs are done |
| Admin → Provider Scores | Listed like anyone else | Marked "New", with the provisional number shown to admins only |

**"New" ends automatically.** The moment a pro has 5 completed jobs, their real score shows on their profile, the weekly allowance follows the score, and rewards and alerts apply.

**The score itself is calculated the same way as v89.** Weights add up to 100. I didn't change the maths, only who sees the number and what it's allowed to do while a pro is new.

## Why not just start new pros at a lower number?
Because the score does three jobs: it is shown to customers, it sets how many matches a pro gets, and a low one alerts admins. Starting everyone at, say, 45 would have cut every new pro to 3 matches a week and fired an alert on day one. Hiding the number until it means something, and giving new pros their own allowance, fixes the real problem (an unearned 76 on display) without those side effects.

## Numbers I can change
Both are single values in src\provider-score.js:
- **5** completed jobs before a pro stops being "new".
- **10** job matches a week while new.
If Joseph wants different numbers, I tell Claude and it is a one-line change each.

## Things to know
- Pros already on the site with fewer than 5 completed jobs become "New on Trothen" the first time the server recalculates scores after deploy (within about 20 seconds of starting).
- The monthly top-score award (v89) already required at least one completed job in the month, so it is unaffected.
- A pro in a licensed trade still needs a valid license to be matched. That rule is separate.

## Tested
- A pro with 2 completed jobs: marked new, 3 jobs to go, provisional number stored, weekly allowance 10, no reward given.
- A pro with 6 completed jobs: not new, real score, allowance from the score tiers.
- Public data for the new pro contains no score, only "new"; the veteran's contains the score.
- Search cards: "New on Trothen" for the new pro, "78/100" for the veteran.
- The new pro's dashboard shows the provisional note and "0 of 10 ... starter allowance for new pros". The veteran's shows the normal wording.
- Admin → Provider Scores shows "New · provisional 73/100" for the new pro.
- Every section opened for a visitor, customer, pro and super admin with no errors.

## Files (complete replacements)
| File | Bytes | |
|---|---|---|
| server.js | 21496 | |
| public\index.html | 1226937 | changed in v91 |
| src\auth.js | 9391 | |
| src\platform-settings.js | 21616 | |
| src\validators.js | 17730 | |
| src\terms.js | 1245 | |
| src\plan-billing.js | 7530 | |
| src\id-retention-scheduler.js | 2249 | |
| src\file-crypto.js | 2776 | |
| src\backup-scheduler.js | 2385 | |
| src\account-privacy.js | 8577 | |
| src\provider-score.js | 16908 | changed in v91 |
| src\provider-score-scheduler.js | 5507 | changed in v91 |
| src\top-scorer-promotion-scheduler.js | 3512 | |
| src\routes\admin.routes.js | 212742 | changed in v91 |
| src\routes\marketplace.routes.js | 122827 | changed in v91 |
| src\routes\payments.routes.js | 61503 | |
| src\routes\auth.routes.js | 81162 | changed in v91 |
| src\routes\misc.routes.js | 58897 | |
| src\routes\portfolio.routes.js | 12210 | |

Six files changed in this version. The rest are the same as v90 and are included so this zip is complete on its own.

## Deploy (cmd.exe, not PowerShell)
1. Unzip trothen-v91-files.zip.
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
   git add server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\provider-score.js src\provider-score-scheduler.js src\top-scorer-promotion-scheduler.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v86.md CHANGES_v88.md CHANGES_v89.md CHANGES_v90.md CHANGES_v91.md
   git commit -m "v91: new pros shown as New on Trothen until five jobs; starter allowance of ten matches"
   git push
   ```
5. After Render finishes: search for pros. Anyone with fewer than 5 completed jobs should show "New on Trothen" instead of a score.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
