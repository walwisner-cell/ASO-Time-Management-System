# ASO Staff OT System — SQL Edition (v9.2)

## What's in this package

| File | Purpose |
|---|---|
| `server.js` | Node.js + Express backend with SQLite database |
| `ASO_OT_SYSTEM_SQL.html` | The app UI (served by the server, not opened directly) |
| `package.json` | Node dependencies |
| `start.vbs` | Silent Windows launcher (no terminal window) |
| `installer.iss` | Inno Setup script → builds the Windows .exe installer |
| `patch_html.py` | Utility: re-patches a new HTML version to use the SQL backend |

---

## Quick Start (no installer)

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

---

## API Endpoints (for reference)

| Method | Path | Description |
|---|---|---|
| GET | `/` | Serves the app UI |
| GET | `/api/db/load` | Returns full DB as JSON |
| POST | `/api/db/save` | Saves full DB snapshot |
| POST | `/api/db/reset` | Resets to factory defaults |
| GET | `/api/db/export` | Downloads JSON backup file |
| POST | `/api/db/import` | Imports a JSON backup |
| GET | `/api/health` | Health check |
