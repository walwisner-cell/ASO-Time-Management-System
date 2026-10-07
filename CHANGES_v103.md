# Trothen v103: the Get the app button waits for the browser's installer

## What happened
I pressed "Get the app" and the installer did not come up.

## What Claude checked
It asked a real Chromium browser (the engine inside Chrome and Edge) whether it considers Trothen installable. The answer: the app's description file loads with no errors, the background helper is active, and the browser reports **no reasons the site can't be installed**. So the site itself is set up correctly.

## Why the installer may still not appear
The install box belongs to the browser, not to Trothen. Trothen can only ask the browser to open it, and the browser only allows that after it has handed the page an "installer ready" signal. If I press the button before that signal arrives, or the browser never sends it, v102 fell straight to written steps. The browser doesn't send it when:
- **Trothen is already installed** on that computer or phone
- I'm in a browser that can't install (Firefox, Opera)
- I'm in a private / InPrivate window
- the browser simply hasn't got round to it yet (it can take a few seconds after the page loads)

## What I changed
1. **The button now waits.** On Chrome and Edge, pressing "Get the app" shows "Opening the installer…" and waits up to three seconds for the browser's signal. If it arrives, the install box opens. Before, pressing a moment too early gave written steps instead.
2. **When it doesn't arrive, the steps are exact for that browser,** using its own menu wording, and they say what to check if "Install" isn't there (Trothen may already be installed).

## The way that always works, with or without the button
**Microsoft Edge:** the ··· menu (top right) → Apps → Install this site as an app → Install.
**Chrome:** the ⋮ menu (top right) → Cast, save and share → Install page as app… → Install. (On some versions the menu item is "Install Trothen…".)
Both browsers also show a small install icon at the right-hand end of the address bar.

If "Install" isn't offered in that menu, Trothen is probably already installed. On Windows, look in the Start menu for "Trothen".

## Tested
- A real Chromium browser reports the site as installable with no errors.
- Simulated Edge and Chrome on Windows: when the browser's signal arrived 1.5 seconds after the button was pressed, the install box opened; when it never arrived, the right menu steps for that browser appeared after three seconds.
- Every section opens for a visitor, customer, pro and super admin with no errors.
- Not tested: a real Windows computer. Claude can't see what my browser shows, so if it still doesn't open I need to say which browser I'm in and what appears after I press the button.

## Files
Only public\index.html changed in this version: 1314291 bytes. All other files are the same as v102.

## Deploy (cmd.exe, not PowerShell)
```
set SRC=C:\Users\You\Downloads\trothen-v103-files
set REPO=C:\path\to\trothen-backend
xcopy "%SRC%\*" "%REPO%\" /E /Y /I
cd /d "%REPO%"
for %I in (public\index.html) do @echo %~zI  %I
git add server.js public src CHANGES_v*.md
git commit -m "v103: Get the app waits for the browser's installer; exact menu steps"
git push
```
The size shown must be 1314291. If not, stop and copy again.
