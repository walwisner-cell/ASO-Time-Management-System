#!/usr/bin/env python3
"""
patch_html.py — patches ASO_OT_SYSTEM_vX_Y.html to use the SQLite backend API
Usage:  python patch_html.py ASO_OT_SYSTEM_vX_Y.html
Output: ASO_OT_SYSTEM_SQL.html

IMPORTANT — SCOPE OF THIS SCRIPT
This script only replaces the small "DATABASE LAYER" script block (data
loading/saving glue: dbSave, dbReset, dbImportBackup, the startup data-fetch
routine, and the DB_DEFAULTS shape). It does NOT touch, and will NOT remove:
  - Server-side session authentication (doLogin/doLogout/enterApp, defined
    elsewhere in the file) — those are untouched by this script.
  - The Payroll & Taxes feature, Pay Stubs, the Dashboard chart, or any other
    page/feature code — all of that lives outside the block this script edits.

That said, the embedded NEW_DB_LAYER template below must stay in sync with
whatever the real app currently does, or running this script would silently
replace the DB layer with a stale/incorrect version. If you significantly
change how login, session handling, or data loading works in
ASO_OT_SYSTEM_SQL.html, update NEW_DB_LAYER below to match before relying on
this script again. When in doubt, diff the script's <script>...DATABASE
LAYER...</script> block (before "// XSS SANITIZER") against NEW_DB_LAYER.
"""
import sys, re, os

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "ASO_OT_SYSTEM_vX_Y.html"
    if not os.path.exists(src):
        print(f"Error: {src} not found"); sys.exit(1)

    html = open(src, encoding="utf-8").read()

    # 1. Wipe the embedded seed tag
    html = re.sub(
        r'<script type="application/json" id="aso-seed">[\s\S]*?<\/script>',
        '<script type="application/json" id="aso-seed">null</script>',
        html, count=1
    )

    # 2. Build the replacement DB layer
    new_db = NEW_DB_LAYER

    # 3. Replace the entire DB layer script block
    #    It starts with: // DATABASE LAYER
    #    It ends just before: // XSS SANITIZER
    #    NOTE: uses a callable replacement (not a plain string) because the
    #    JS template contains literal backslash sequences like \u2705 — if
    #    passed as a plain string, Python's re module misreads those as
    #    regex backreference escapes and raises "bad escape \u".
    replacement = new_db + '\n// ──────────────────────────────────────────────────────────\n// XSS SANITIZER'
    html, n = re.subn(
        r'<script>\s*// ══+\s*// DATABASE LAYER[\s\S]*?// ──+\s*// XSS SANITIZER',
        lambda m: replacement,
        html, count=1
    )
    if n == 0:
        print("⚠️  Warning: could not find the DATABASE LAYER block to replace.")
        print("   The source file's structure may have changed — check it manually")
        print("   before trusting the output.")

    out = "ASO_OT_SYSTEM_SQL.html"
    open(out, "w", encoding="utf-8").write(html)
    print(f"✅  Written: {out}  ({os.path.getsize(out)//1024} KB)")
    print("   Reminder: this only patches the DB layer. Server-side auth (server.js)")
    print("   and this repo's Payroll/Pay Stubs/Dashboard features are untouched —")
    print("   verify they still work after patching a genuinely new source HTML file.")

NEW_DB_LAYER = r"""<script>
// ══════════════════════════════════════════════════════════
// DATABASE LAYER — SQLite backend, authenticated via server-side sessions
// ══════════════════════════════════════════════════════════
const DB_KEY = 'ASO_OT_DB_v7';
var PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS, PENDING_APPROVALS,
    APPROVED_EXCEPTIONS, DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG, PAYROLL_RECORDS, LEAVE_REQUESTS;
let _unsavedToFile = false;

const DB_DEFAULTS = {
  PAY_CONFIG: { anchorDate: '2026-05-09', periodDays: 14, otThreshold: 80, defaultDeductions: [] },
  USERS: [{ id:'U001', username:'admin', password:'admin123', name:'Admin', role:'admin' }],
  LOCATIONS: [], STAFF: [], SHIFTS: [],
  PENDING_APPROVALS: [], APPROVED_EXCEPTIONS: [],
  DATE_CORRECTION_LOG: [], DELETION_LOG: [], AUDIT_LOG: [], PAYROLL_RECORDS: [], LEAVE_REQUESTS: []
};

function dbSave() {
  const data = { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
                 PENDING_APPROVALS, APPROVED_EXCEPTIONS,
                 DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG, PAYROLL_RECORDS, LEAVE_REQUESTS };
  fetch('/api/db/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }).catch(e => console.warn('[ASO DB] Save failed:', e));
  _unsavedToFile = false;
  updateSaveIndicator();
}

function dbSaveToFile() {
  window.open('/api/db/export', '_blank');
  showToast('\u2705 Backup downloaded \u2014 keep this file safe!', 'success');
}

function dbReset() {
  if (!confirm('\u26A0\uFE0F RESET DATABASE\n\nThis will permanently delete ALL data.\n\nThis cannot be undone. Continue?')) return;
  fetch('/api/db/reset', { method: 'POST' })
    .then(() => location.reload())
    .catch(e => showToast('Reset failed: ' + e.message, 'danger'));
}

function dbExportBackup() { window.open('/api/db/export', '_blank'); showToast('Backup exported \u2705'); }

function dbImportBackup(input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.SHIFTS || !data.STAFF) { showToast('Invalid backup file', 'danger'); return; }
      if (!confirm('Import backup from ' + (data.exportedAt || 'unknown date') + '?\n\nThis will REPLACE all current data.')) return;
      fetch('/api/db/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      }).then(r => r.json()).then(result => {
        if (result.error) throw new Error(result.error);
        showToast('Imported \u2014 ' + result.shifts + ' shifts, ' + result.staff + ' staff \u2705', 'success');
        location.reload();
      }).catch(err => showToast('Import failed: ' + err.message, 'danger'));
    } catch(err) { showToast('Failed to parse backup', 'danger'); }
  };
  reader.readAsText(file); input.value = '';
}

(async function _asoAppInit() {
  const loginScreen = document.getElementById('login-screen');

  // If a valid session cookie already exists (e.g. page refresh), skip straight to loading data.
  try {
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
      const me = await meRes.json();
      _currentUser = me.user;
      if (loginScreen) loginScreen.style.display = 'none';
      const ok = await loadAppData();
      if (ok) enterApp();
      return;
    }
  } catch (e) { /* server not reachable yet — fall through to normal login screen */ }

  if (loginScreen) loginScreen.style.display = 'flex';
})();

// Fetches all application data from the server. Must only be called AFTER a
// successful login (or confirmed existing session) — the API requires auth.
async function loadAppData() {
  const overlay = document.createElement('div');
  overlay.id = 'aso-connecting';
  overlay.style.cssText = 'position:fixed;inset:0;background:#0E1826;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:18px;';
  overlay.innerHTML =
    '<svg width="80" height="80" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><radialGradient id="cg" cx="50%" cy="35%" r="65%">' +
    '<stop offset="0%" stop-color="#1a3a6e"/><stop offset="100%" stop-color="#0b0f1a"/>' +
    '</radialGradient></defs>' +
    '<path d="M32 2 L58 14 L58 36 C58 50 46 60 32 62 C18 60 6 50 6 36 L6 14 Z" fill="url(#cg)" stroke="#3b82f6" stroke-width="2.5"/>' +
    '<text x="32" y="37" font-family="Georgia,serif" font-size="18" font-weight="bold" fill="#3b82f6" text-anchor="middle">ASO</text>' +
    '<text x="32" y="48" font-family="Georgia,serif" font-size="6" fill="#4A9FE0" text-anchor="middle" letter-spacing="2">SAFETY</text></svg>' +
    '<div style="font-family:Montserrat,sans-serif;font-size:15px;font-weight:700;color:#E4EAF2">American Safety Options</div>' +
    '<div id="aso-conn-msg" style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:#8397AF;letter-spacing:.5px">Connecting to database\u2026</div>';
  document.body.appendChild(overlay);
  const msgEl = document.getElementById('aso-conn-msg');

  let data = null;
  for (let i = 1; i <= 20; i++) {
    try {
      const r = await fetch('/api/db/load');
      if (r.ok) { data = await r.json(); break; }
      if (r.status === 401) { overlay.remove(); doLogout(); return false; }
    } catch(e) {}
    if (msgEl) msgEl.textContent = 'Connecting\u2026 (' + i + '/20)';
    await new Promise(res => setTimeout(res, 600));
  }

  if (!data) {
    overlay.innerHTML =
      '<div style="text-align:center;color:#F08883;font-family:Montserrat,sans-serif;max-width:440px;padding:48px">' +
      '<div style="font-size:36px;margin-bottom:16px">\u26A0\uFE0F</div>' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:12px">Cannot reach ASO Server</div>' +
      '<div style="font-size:13px;color:#A8B8CC;line-height:1.7">Make sure <b>server.js</b> is running.<br>' +
      'Open a terminal in the install folder and run:<br>' +
      '<code style="background:#081018;padding:4px 12px;border-radius:6px;margin:8px 0;display:inline-block;color:#5AA9F0">node server.js</code><br><br>' +
      'Then refresh this page.</div>' +
      '<button onclick="location.reload()" style="margin-top:24px;background:#2E8AE8;border:none;border-radius:8px;padding:10px 28px;color:#fff;font-size:14px;font-family:Montserrat,sans-serif;font-weight:700;cursor:pointer">Retry</button></div>';
    return false;
  }

  PAY_CONFIG            = data.PAY_CONFIG            || DB_DEFAULTS.PAY_CONFIG;
  USERS                 = data.USERS                 || DB_DEFAULTS.USERS;
  LOCATIONS             = data.LOCATIONS             || [];
  STAFF                 = data.STAFF                 || [];
  SHIFTS                = data.SHIFTS                || [];
  PENDING_APPROVALS     = data.PENDING_APPROVALS     || [];
  APPROVED_EXCEPTIONS   = data.APPROVED_EXCEPTIONS   || [];
  DATE_CORRECTION_LOG   = data.DATE_CORRECTION_LOG   || [];
  DELETION_LOG          = data.DELETION_LOG          || [];
  AUDIT_LOG             = data.AUDIT_LOG             || [];
  PAYROLL_RECORDS       = data.PAYROLL_RECORDS       || [];
  LEAVE_REQUESTS        = data.LEAVE_REQUESTS         || [];

  LOCATIONS.forEach(l => {
    if (!l.rateHistory || l.rateHistory.length === 0)
      l.rateHistory = [{ rate: l.rate, mult: l.mult, effectiveFrom: '2000-01-01' }];
  });

  overlay.remove();
  console.log('[ASO DB] Ready \u2014', STAFF.length, 'staff,', SHIFTS.length, 'shifts');
  return true;
}

function genId() { return 'SH' + Date.now() + Math.random().toString(36).slice(2,6); }
"""

if __name__ == "__main__":
    main()
