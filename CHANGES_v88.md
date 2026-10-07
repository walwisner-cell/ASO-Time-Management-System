# Trothen v88: "Live now in" back in its original position

## What I asked for
Put the strip back where it was. I did not want it moved to the top.

## What changed
- The "Live now in" band is back in its original place: at the bottom of the hero, directly under the search box and job ticket, above the numbers row. Its size and spacing are the original ones too.
- The v87 move to the top of the page is undone completely.

## What I kept (from v86)
- At every server start, the United States, Nigeria, Ghana and Liberia are switched to live if they aren't. Other countries are never touched.
- The strip is drawn first and on its own, with a fallback, so a failed homepage request can't hide it.

## Where to look for it
On a laptop it sits just below the first screen, so I scroll down a little past the search box. If it isn't there after deploying, the countries are switched off in my live data: Admin → Categories & Countries → switch Liberia (and the others I serve) on.

## Tested
My uploaded copy with these files, live-site mode, fresh disk: the strip shows "Live now in Ghana, Liberia, Nigeria, United States" in its original place under the hero. No script errors.

## Files
Compared with my repo (v85), two files differ:

| File | Bytes |
|---|---|
| server.js | 21496 |
| public\index.html | 1222098 |

## Deploy (cmd.exe, not PowerShell)
1. Unzip trothen-v88-files.zip.
2. From the unzipped folder (replace the path with my repo folder):
   ```
   set REPO=C:\path\to\trothen-backend
   copy /Y server.js "%REPO%\server.js"
   copy /Y public\index.html "%REPO%\public\index.html"
   copy /Y CHANGES_v86.md "%REPO%\"
   copy /Y CHANGES_v88.md "%REPO%\"
   ```
3. Check the sizes:
   ```
   cd /d "%REPO%"
   for %I in (server.js public\index.html) do @echo %~zI  %I
   ```
   If either number is different from the table, stop and copy again.
4. Push:
   ```
   git add server.js public\index.html CHANGES_v86.md CHANGES_v88.md
   git commit -m "v88: Live-now-in strip in its original position; core countries live at startup"
   git push
   ```
5. If I already deployed v87, this replaces it. I don't need CHANGES_v87.md.
6. I still do not set PLAN_BILLING_ENABLED (see CHANGES_v78.md).
