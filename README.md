# ASO Staff OT System — SQL Edition (v9.2)

## What's in this package

| File | Purpose |
|---|---|
| `server.js` | Node.js + Express backend — SQLite database, session authentication, security middleware |
| `ASO_OT_SYSTEM_SQL.html` | The app UI (served by the server, not opened directly) |
| `package.json` | Node dependencies |
| `start.vbs` | Silent Windows launcher (no terminal window) |
| `installer.iss` | Inno Setup script → builds the Windows .exe installer |
| `patch_html.py` | Utility: re-patches a new HTML version to use the SQL backend (see warning in that file) |
| `render.yaml` | Deployment config for hosting on [Render](https://render.com) |

The app covers timesheets, overtime calculation, shift approvals, staff/location
management, reporting, and a full **Payroll** workflow: set your standard
taxes and benefits once (Taxes & Benefits page), then for each pay period —
review timesheets and confirm & run payroll in one step, with your saved
taxes/benefits applied automatically. Generates printable **Pay Stubs** with
year-to-date totals.

---

## Logging in

The app requires a login — there's no anonymous access to any data. On first
run, a default admin account is seeded:

```
Username: admin
Password: admin123
```

**Change this password immediately** after your first login (Passwords page,
admin only). The app will nag you with a warning toast until you do. Every
account has a role — `admin`, `supervisor`, or `viewer` — and the server
enforces what each role can write, not just the UI.

---

## Quick Start (running locally)

### Requirements
- [Node.js 18 LTS or newer](https://nodejs.org/en/download)

### Steps
1. Put all files in one folder.
2. Open a terminal in that folder:
   ```
   npm install
   node server.js
   ```
3. Your browser will open automatically to **http://localhost:8420**

Data is saved to:  `C:\Users\<you>\ASO_OT_Data\aso_ot.db`

### Environment variables (optional, used mainly for cloud hosting)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8420` | Port the server listens on |
| `HOST` | `127.0.0.1` (or `0.0.0.0` if `PORT` is set) | Network interface to bind |
| `DB_DIR` | `~/ASO_OT_Data` | Folder where the SQLite file is stored |

---

## Deploying to Render

This repo includes `render.yaml`, which Render reads automatically:
1. Push this repo to GitHub.
2. On [render.com](https://render.com) → **New → Web Service** → connect the repo.
3. Render pre-fills the build/start commands and attaches a persistent disk
   (`/var/data`) so your database survives redeploys.
4. Deploy, then log in with the default admin credentials above and change
   the password right away — the app is now reachable on the public internet.

---

## Building the Windows Installer (.exe)

### Requirements
- [Inno Setup 6](https://jrsoftware.org/isinfo.php) (free)
- Node.js installed on your build machine
- Run `npm install` first so `node_modules\` is populated

### Steps
1. Install Inno Setup.
2. Open **installer.iss** in the Inno Setup IDE.
3. (Optional) Replace `aso_icon.ico` with your own icon file.
4. Press **F9** (Build → Compile).
5. The installer will appear in the **Output\** folder as `ASO_OT_Setup.exe`.

### What the installer does
- Checks that Node.js ≥ 18 is installed (prompts to download if not)
- Copies all app files to `C:\Program Files\ASO Staff OT System\`
- Creates a **desktop shortcut** and **Start Menu** entry
- Stores the install path in the registry so `start.vbs` can find it
- Optionally adds the server to Windows startup

### Silent install (for IT deployment)
```
ASO_OT_Setup.exe /SILENT /SUPPRESSMSGBOXES
```

---

## Database location

The SQLite file lives at:
```
C:\Users\<username>\ASO_OT_Data\aso_ot.db
```
Back this file up regularly, or use the **Export JSON Backup** button inside the app.

You can open the `.db` file with [DB Browser for SQLite](https://sqlitebrowser.org/) to inspect or query data directly.

---

## Bundling portable Node.js (optional — no Node install required)

If you want the installer to work on machines without Node.js:

1. Download the **Node.js Windows Binary (.zip)** from https://nodejs.org
2. Extract it into a subfolder called `node\` next to the `.iss` file
3. In `installer.iss`, uncomment the line:
   ```
   Source: "node\*"; DestDir: "{app}\node"; ...
   ```
4. Recompile the installer.

`start.vbs` already checks for `{app}\node\node.exe` as a fallback.

---

## Upgrading to a new HTML version

When you receive an updated `ASO_OT_SYSTEM_vX_Y.html`:

```bash
python patch_html.py ASO_OT_SYSTEM_vX_Y.html
```

This produces a new `ASO_OT_SYSTEM_SQL.html` — copy it into the install folder.
Your data in the SQLite database is untouched.

**Note:** this script only re-patches the small "database layer" script block
(data loading/saving). Login, sessions, Payroll, Taxes & Benefits, Pay Stubs, and other
features live elsewhere in the file and are not affected either way — but if
you've made deep custom changes to how login or data-loading works, read the
warning comment at the top of `patch_html.py` before running it.

---

## API Endpoints (for reference)

All `/api/db/*` and `/api/users/*` routes require a valid login session
(cookie set by `/api/auth/login`). Routes marked **admin** additionally
require the `admin` role — the server checks this itself, not just the UI.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | none | Serves the app UI |
| POST | `/api/auth/login` | rate-limited | Log in, sets session cookie |
| POST | `/api/auth/logout` | none | Clears the session |
| GET | `/api/auth/me` | session | Returns the current logged-in user |
| POST | `/api/users/:id/password` | session (self or admin) | Change a password |
| GET | `/api/db/load` | session | Returns full DB as JSON (no password hashes) |
| POST | `/api/db/save` | session | Saves full DB snapshot (role-checked per field) |
| POST | `/api/db/reset` | session + **admin** | Resets to factory defaults |
| GET | `/api/db/export` | session + **admin** | Downloads JSON backup file |
| POST | `/api/db/import` | session + **admin** | Imports a JSON backup |
| GET | `/api/health` | none | Health check (used by Render) |
