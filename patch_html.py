#!/usr/bin/env python3
"""
patch_html.py — patches ASO_OT_SYSTEM_v9_2.html to use the SQLite backend API
Usage:  python patch_html.py ASO_OT_SYSTEM_v9_2.html
Output: ASO_OT_SYSTEM_SQL.html
"""
import sys, re, os

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "ASO_OT_SYSTEM_v9_2.html"
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
    html = re.sub(
        r'<script>\s*// ══+\s*// DATABASE LAYER[\s\S]*?// ──+\s*// XSS SANITIZER',
        new_db + '\n// ──────────────────────────────────────────────────────────\n// XSS SANITIZER',
        html, count=1
    )

    out = "ASO_OT_SYSTEM_SQL.html"
    open(out, "w", encoding="utf-8").write(html)
    print(f"✅  Written: {out}  ({os.path.getsize(out)//1024} KB)")

NEW_DB_LAYER = r"""<script>
// ══════════════════════════════════════════════════════════
// DATABASE LAYER — SQLite backend via localhost:3000 API
// ══════════════════════════════════════════════════════════
const DB_KEY = 'ASO_OT_DB_v7';

var PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS, PENDING_APPROVALS,
    APPROVED_EXCEPTIONS, DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG;
let _unsavedToFile = false;

const DB_DEFAULTS = {
  PAY_CONFIG: { anchorDate: '2026-05-09', periodDays: 14, otThreshold: 80 },
  USERS: [{ id:'U001', username:'admin', password:'admin123', name:'Admin', role:'admin' }],
  LOCATIONS: [], STAFF: [], SHIFTS: [],
  PENDING_APPROVALS: [], APPROVED_EXCEPTIONS: [],
  DATE_CORRECTION_LOG: [], DELETION_LOG: [], AUDIT_LOG: []
};

// Fire-and-forget save to SQLite
function dbSave() {
  const data = { PAY_CONFIG, USERS, LOCATIONS, STAFF, SHIFTS,
                 PENDING_APPROVALS, APPROVED_EXCEPTIONS,
                 DATE_CORRECTION_LOG, DELETION_LOG, AUDIT_LOG };
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
  showToast('\u2705 Backup downloaded \u2014 keep it safe!', 'success');
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

// Async startup — load data from SQLite before showing login
(async function _asoDBInit() {
  // Hide login until we have data
  const loginScreen = document.getElementById('login-screen');
  if (loginScreen) loginScreen.style.display = 'none';

  // Show connecting overlay
  const overlay = document.createElement('div');
  overlay.id = 'aso-connecting';
  overlay.style.cssText = 'position:fixed;inset:0;background:#050c18;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;gap:18px;';
  overlay.innerHTML =
    '<svg width="80" height="80" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><radialGradient id="cg" cx="50%" cy="35%" r="65%">' +
    '<stop offset="0%" stop-color="#1a3a6e"/><stop offset="100%" stop-color="#0b0f1a"/>' +
    '</radialGradient></defs>' +
    '<path d="M32 2 L58 14 L58 36 C58 50 46 60 32 62 C18 60 6 50 6 36 L6 14 Z" fill="url(#cg)" stroke="#3b82f6" stroke-width="2.5"/>' +
    '<text x="32" y="37" font-family="Georgia,serif" font-size="18" font-weight="bold" fill="#3b82f6" text-anchor="middle">ASO</text>' +
    '<text x="32" y="48" font-family="Georgia,serif" font-size="6" fill="#60a5fa" text-anchor="middle" letter-spacing="2">SAFETY</text></svg>' +
    '<div style="font-family:Montserrat,sans-serif;font-size:15px;font-weight:700;color:#cdd9ec">American Safety Options</div>' +
    '<div id="aso-conn-msg" style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:#3a5878;letter-spacing:.5px">Connecting to database\u2026</div>';
  document.body.appendChild(overlay);
  const msgEl = document.getElementById('aso-conn-msg');

  // Retry loop — server may still be starting
  let data = null;
  for (let i = 1; i <= 20; i++) {
    try {
      const r = await fetch('/api/db/load');
      if (r.ok) { data = await r.json(); break; }
    } catch(e) {}
    if (msgEl) msgEl.textContent = 'Connecting\u2026 (' + i + '/20)';
    await new Promise(res => setTimeout(res, 600));
  }

  if (!data) {
    overlay.innerHTML =
      '<div style="text-align:center;color:#f87171;font-family:Montserrat,sans-serif;max-width:440px;padding:48px">' +
      '<div style="font-size:36px;margin-bottom:16px">\u26A0\uFE0F</div>' +
      '<div style="font-size:18px;font-weight:700;margin-bottom:12px">Cannot reach ASO Server</div>' +
      '<div style="font-size:13px;color:#7290b0;line-height:1.7">Make sure <b>server.js</b> is running.<br>' +
      'Open a terminal in the install folder and run:<br>' +
      '<code style="background:#0a1525;padding:4px 12px;border-radius:6px;margin:8px 0;display:inline-block;color:#4aaff5">node server.js</code><br><br>' +
      'Then refresh this page.</div>' +
      '<button onclick="location.reload()" style="margin-top:24px;background:#1a7bd8;border:none;border-radius:8px;padding:10px 28px;color:#fff;font-size:14px;font-family:Montserrat,sans-serif;font-weight:700;cursor:pointer">Retry</button></div>';
    return;
  }

  // Populate globals
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

  // Migrate location rateHistory
  LOCATIONS.forEach(l => {
    if (!l.rateHistory || l.rateHistory.length === 0)
      l.rateHistory = [{ rate: l.rate, mult: l.mult, effectiveFrom: '2000-01-01' }];
  });

  // Migrate plaintext passwords to hashes
  await migratePasswords();

  // Remove overlay and show login
  overlay.remove();
  if (loginScreen) loginScreen.style.display = 'flex';

  console.log('[ASO DB] Ready \u2014', STAFF.length, 'staff,', SHIFTS.length, 'shifts');
})();

// ── SHA-256 password hashing ──
const _PW_SALT = 'ASO_OT_SECURE_SALT_v7';
async function hashPw(password) {
  const encoded = new TextEncoder().encode(password + _PW_SALT);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
function isHashed(pw) { return /^[0-9a-f]{64}$/.test(pw); }
async function migratePasswords() {
  let changed = false;
  for (const u of USERS) {
    if (!isHashed(u.password)) { u.password = await hashPw(u.password); changed = true; }
  }
  if (changed) dbSave();
}

function genId() { return 'SH' + Date.now() + Math.random().toString(36).slice(2,6); }
"""

if __name__ == "__main__":
    main()
