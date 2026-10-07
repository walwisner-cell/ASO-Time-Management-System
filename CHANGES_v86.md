# Trothen v86: the "Live now in" strip comes back and can't quietly disappear

## What happened
The dark band on the homepage that says "Live now in ... Liberia ..." was gone from my live site.

## What I found
- **The strip was never removed from the code.** It is identical in my original upload and in v85, and it shows when v85 runs on demo data.
- **I could reproduce my live site's symptom exactly one way:** when no country is marked "live" in the data, v85 hides the strip. With every country switched off, v85 shows nothing there. The strip only lists countries that are switched on in Admin → Categories & Countries.
- **So on my live site, the countries (Liberia included) are switched off in the data.** Claude can't see my live data, so it can't say what switched them off. The usual ways are the toggle on that admin page, or Go-Live → Step 3, which sets every country not on its list to "planned".
- **This has a second effect I may not have noticed:** the sign-up form only offers live countries. If none are live, nobody can sign up.

## A correction
In the last reply Claude said the server sets the four core countries back to live every time it starts. That was wrong. The code for that correction existed, but it only ran when someone pressed "Sync" in Admin or ran it by hand. It did not run at startup.

## What I changed
1. **At every server start, the four core markets are switched to live if they aren't:** United States, Nigeria, Ghana, Liberia. The log says which ones were corrected. Other countries are never touched.
2. **The strip is drawn first and on its own.** It used to be the last step of loading the homepage, so if that request failed or anything before it stumbled, the strip stayed hidden without a word. Now it has a fallback (the list of countries open for sign-up), and if it still has nothing to show it says why in the browser console.

So deploying this version brings the strip back by itself: the server restarts, finds the core countries switched off, and switches them on.

## Something I should know about this rule
If I ever deliberately switch off one of those four countries in Admin, it will be switched back on the next time the server restarts (every deploy). If I really do want one of them off, I need to tell Claude so the rule can be changed. Any other country I switch on or off stays exactly as I set it.

## If I want it back right now, without deploying
Admin → Categories & Countries → find Liberia (and the other countries I serve) → flip the switch to on. The strip returns the moment the homepage is reloaded.

## Nothing else was removed
I asked whether anything else had been taken out. Claude compared my original upload with the current version: page elements, screens, functions, homepage text, wording, menu items and server routes. The only things removed across v74 to v85, all deliberately:
- the old agreement screen's step bar, locked checkbox and "read first" button (replaced by the checkbox version I asked for, v76)
- the on-screen password-reset code on the live site (v81, it allowed account takeover)
- the 5MB block on photos (v80)
- fixed prices in the support chat's pricing answer (v78)

## Tested
- Data with every country switched off, server in live-site mode:
  - v85: strip hidden (this matches what I see on my site).
  - v86: the log shows "Switched back to live at startup: United States, Nigeria, Ghana, Liberia" and the strip shows "Live now in Ghana, Liberia, Nigeria, United States".
- Homepage request made to fail on purpose: strip still shows (fallback).
- Homepage content made malformed on purpose: strip still shows.
- No script errors.

## Files (complete replacements; this zip includes v74 to v85)
| File | Bytes |
|---|---|
| server.js | 21496 |
| public\index.html | 1222098 |
| src\auth.js | 9391 |
| src\platform-settings.js | 21616 |
| src\validators.js | 17730 |
| src\terms.js | 1245 |
| src\plan-billing.js | 7530 |
| src\id-retention-scheduler.js | 2249 |
| src\file-crypto.js | 2776 |
| src\backup-scheduler.js | 2385 |
| src\account-privacy.js | 8577 |
| src\routes\admin.routes.js | 208143 |
| src\routes\marketplace.routes.js | 122338 |
| src\routes\payments.routes.js | 60475 |
| src\routes\auth.routes.js | 80421 |
| src\routes\misc.routes.js | 58805 |
| src\routes\portfolio.routes.js | 12210 |

Changed in this version: server.js and public\index.html.

## Deploy (cmd.exe, not PowerShell)
1. Unzip trothen-v86-files.zip.
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
   copy /Y src\routes\admin.routes.js "%REPO%\src\routes\admin.routes.js"
   copy /Y src\routes\marketplace.routes.js "%REPO%\src\routes\marketplace.routes.js"
   copy /Y src\routes\payments.routes.js "%REPO%\src\routes\payments.routes.js"
   copy /Y src\routes\auth.routes.js "%REPO%\src\routes\auth.routes.js"
   copy /Y src\routes\misc.routes.js "%REPO%\src\routes\misc.routes.js"
   copy /Y src\routes\portfolio.routes.js "%REPO%\src\routes\portfolio.routes.js"
   copy /Y CHANGES_v7*.md "%REPO%\"
   copy /Y CHANGES_v8*.md "%REPO%\"
   ```
3. Check the sizes against the table:
   ```
   cd /d "%REPO%"
   for %I in (server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js) do @echo %~zI  %I
   ```
   If any number is different, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html src\auth.js src\platform-settings.js src\validators.js src\terms.js src\plan-billing.js src\id-retention-scheduler.js src\file-crypto.js src\backup-scheduler.js src\account-privacy.js src\routes\admin.routes.js src\routes\marketplace.routes.js src\routes\payments.routes.js src\routes\auth.routes.js src\routes\misc.routes.js src\routes\portfolio.routes.js CHANGES_v74.md CHANGES_v75.md CHANGES_v76.md CHANGES_v77.md CHANGES_v78.md CHANGES_v79.md CHANGES_v80.md CHANGES_v81.md CHANGES_v82.md CHANGES_v83.md CHANGES_v84.md CHANGES_v85.md CHANGES_v86.md
   git commit -m "v86: Live-now-in strip restored and made self-correcting; v74-v85"
   git push
   ```
5. After Render finishes: reload the homepage and scroll just below the search box. The dark "Live now in" band should be there. In Render → Logs I can look for the line starting "[countries] Switched back to live at startup".
6. Then open the sign-up form and confirm my countries are offered.
7. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
