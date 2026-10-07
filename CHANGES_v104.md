# Trothen v104: the two technical notices are off the ID panel

## What I asked
In Admin → Verification Queue → "How ID files are kept" there were two lines:
- "Extra encryption: off. To switch it on, set ID_FILE_ENCRYPTION_KEY on the server..."
- "Automated ID and face check (Persona): not connected..."
I asked for them to be fixed or removed.

## What I changed (the "remove" part)
- **The encryption notice is gone from that panel while encryption is off.** It was a set-up note being shown to every reviewer on every visit. If I switch encryption on, the panel shows a short confirmation that it's on.
- **The Persona notice is replaced** by one plain line: "Every ID is checked by a person on the team, using the uploaded ID and face photo." If I connect Persona later, it says so.
- **Nothing is hidden from me.** Both items are still listed in Admin → Go-Live, with what to do about each. That is where set-up tasks belong.

## The "fix" part, which only I can do

**Extra encryption: about five minutes, no cost.**
It scrambles ID files and dispute evidence on the server's disk, so that someone who got hold of the disk or a copy of it couldn't open them.
1. In cmd.exe, in my repo folder, make a key:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   It prints 64 letters and digits.
2. **Save that key somewhere safe first** (a password manager, or written down and locked away). If the key is ever lost, every file scrambled with it is lost for good. Nobody can recover it, including Claude.
3. In Render: my service → Environment → Add Environment Variable. Key: `ID_FILE_ENCRYPTION_KEY`. Value: the 64 characters. Save. Render restarts the site.
4. Admin → Verification Queue: the panel now says "Extra encryption: on".

Things to know:
- Only files uploaded **after** that are scrambled. Files already there stay as they are and still open normally.
- **Never change or delete the key afterwards.** Files scrambled with the old key would stop opening.
- I must not paste the key into a chat, an email or the code.

**Automated ID and face check (Persona): a paid service.**
It needs an account with Persona, their approval, and three keys set in Render. Until then a person on my team checks each ID, which works. I only need this if the volume of sign-ups gets too high to check by hand.

## Tested
- The panel no longer shows the encryption key name or "not connected".
- Every section opens for a visitor, customer, pro and super admin with no errors.

## Files
Only public\index.html changed in this version: 1314362 bytes.

## Deploy (cmd.exe, not PowerShell)
```
set SRC=C:\Users\You\Downloads\trothen-v104-files
set REPO=C:\path\to\trothen-backend
xcopy "%SRC%\*" "%REPO%\" /E /Y /I
cd /d "%REPO%"
for %I in (public\index.html) do @echo %~zI  %I
git add server.js public src CHANGES_v*.md
git commit -m "v104: remove technical notices from the ID files panel"
git push
```
The size shown must be 1314362. If not, stop and copy again.
