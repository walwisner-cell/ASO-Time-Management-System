# ASO Staff Overtime & Payroll System — Project Handoff

Paste this whole document into a new chat along with the attached project files to continue exactly where this session left off.

## What this is
A Node.js/Express + SQLite (sql.js) web app for American Safety Options — staff scheduling, overtime calculation, payroll (with real IRS bracket-based federal withholding), employee self-service, PTO, and clock in/out with per-house staffing caps, supervisor override, and full admin review. Single-file frontend (`ASO_OT_SYSTEM_SQL.html`), Express backend (`server.js`).

## IMPORTANT — what actually happened before this session, read this first
A prior session's handoff described a large amount of finished work (tax brackets, staffing caps, browser verification) — but the code files that made it back to the user did **not** contain any of it; they matched an earlier, less-complete snapshot. This session rebuilt everything that handoff described, from scratch, verifying each piece as it was built rather than trusting the old document's claims. **The lesson: a handoff document describes what happened in a session, not what's guaranteed to be in whatever files get attached to the next one.** Before trusting a handoff, verify the actual code contains what it claims (grep for the specific functions/tables it says exist) before building on top of it.

## How to verify anything in this project
1. `npm install`
2. `node test.js` — 41 automated HTTP-level checks (auth, employee data isolation, input validation, audit integrity, clock in/out, staffing caps, supervisor override, etc.). Must show `41 passed, 0 failed`.
3. `node test-tax-brackets.js` — 7 checks of the federal withholding bracket math against hand-computed values, cross-checked against the actual 2026 IRS Publication 15-T numbers (fetched directly from irs.gov, not a third-party summary — see below for why that mattered). Extracts the real function straight from the live HTML file, so it can never silently drift from what ships.
4. Whenever you edit `ASO_OT_SYSTEM_SQL.html`'s "DATABASE LAYER" script block, mirror the same edit in `patch_html.py`, then confirm with:
   ```
   cp ASO_OT_SYSTEM_SQL.html /tmp/check.html
   rm ASO_OT_SYSTEM_SQL.html
   python3 patch_html.py /tmp/check.html
   diff /tmp/check.html ASO_OT_SYSTEM_SQL.html   # must show no differences
   ```
   This has caught real bugs multiple times. Note: this check itself regenerates the live file from `patch_html.py` — if you check sync before *both* files are actually updated, it can look "in sync" only because it just overwrote your edit. Finish editing both files before trusting the result.
5. Real browser verification is possible in this sandbox: a cached Chromium binary lives at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, and `playwright-core` (install as a dev-only, un-saved dependency — `npm install playwright-core --no-save`) can drive it directly. Boot the server and run the script in the *same* shell invocation. Login selectors: `#login-user` / `#login-pass` / `.login-btn`. **Prefer extracting real DOM text (`page.locator(...).innerText()`) over judging a screenshot by eye** — it's unambiguous where a screenshot leaves room for misreading. Always cross-check whatever the browser shows against the actual SQLite file's contents directly (read it with `sql.js`) — this session's own test setup initially forgot that an "open" (not yet clocked out) entry is correctly excluded from the admin review table by design, which looked like a bug in a screenshot until checked against ground truth.
6. Remove `playwright-core` from `node_modules` (and confirm it was never saved to `package.json`/`package-lock.json`) before packaging anything for the user — it's a dev-only verification tool, not a runtime dependency.

## THIS SESSION — rebuilt from a stale starting point: admin clock-review UI, per-house staffing caps, supervisor override, real IRS tax brackets, browser-verified

### Admin-facing Clock In/Out review (this was the one piece confirmed missing from every available file)
- `renderClockEntriesAdmin()` / `reviewClockEntry(id, action)` on the Approvals page, mirroring the existing Time Off Requests pattern exactly. Approving builds a real shift via the same `validateShifts()` every other entry point uses; denying touches nothing.
- `updateApprovalsBadge()` now includes pending clock entries in its count.
- Verified end-to-end with real HTTP requests: clock in → clock out → shows as pending → approve → real shift appears in `SHIFTS` with correct date/time/hours/location. Then separately verified deny creates nothing, double-review is blocked, malformed input is rejected.
- **Verified again with a real browser**, extracting actual rendered DOM text (not just screenshots) — confirmed the table shows the right staff name, location, times (correctly formatted), computed hours, status, and override note exactly matching what was in the database.

### Per-house staffing caps + supervisor override
- `locations.max_staff` column (0 = no limit), safely migrated. Admin UI: Add Location form and Edit Location modal both have the field; the Locations table shows it ("No limit" when 0).
- `POST /api/clock/in` now checks capacity before allowing a clock-in; blocks with a clear message if the house is full.
- `POST /api/clock/admin-in` (admin/supervisor only) can clock someone in past capacity — requires a reason (3+ chars, no way to skip), still blocks a genuine double clock-in for that person. Every override writes a `CLOCK_IN_OVERRIDE` audit entry.
- `GET /api/locations/occupancy` feeds a live occupancy hint in the client-side override panel (computed from `CLOCK_ENTRIES` + `LOCATIONS` already loaded, no extra round trip needed for the common case).
- **A real bug found and fixed the same way the prior (stale) handoff described**: clock entries get mapped from SQL to JSON in two separate places (`loadDB()` and the dedicated `GET /api/clock-entries` route) — updated both together this time, verified with a direct API test that the override fields (`overridden`/`overrideReason`/`overrideBy`) actually appear in both responses, not just one.
- 12 new permanent tests in `test.js`: capacity blocking, override authorization (403 for non-admin), reason required, unknown staff ID rejected, override succeeds and is correctly flagged, double-override blocked, audit trail entry confirmed.
- **Verified with a real browser**: set up a 2-person-capacity house, confirmed via real DOM inspection that the Locations table correctly shows "2" for the capped location and "No limit" for every other one in the same table.

### Real IRS federal tax brackets (2026)
- Fetched the actual `irs.gov/pub/irs-pdf/p15t.pdf` directly rather than trusting secondary sources — this mattered: two different tax-info sites disagreed with each other on the Single filer's top-bracket threshold ($626,350 vs $640,600). The real IRS table says **$648,100**. Both secondary sources were wrong or stale.
- Implements Worksheet 1A exactly (Percentage Method for Automated Payroll Systems, STANDARD Withholding Rate Schedules — i.e. Form W-4 Step 2 checkbox unchecked, the normal single-job case) with the verified 2026 bracket tables for Single/MFS, MFJ, and HoH.
- New W-4 fields on staff (filing status, Step 3 dependents credit, Step 4a/b/c) editable on the Staff edit modal. New "Federal Withholding (2026 Brackets)" deduction type on Taxes & Benefits — when selected, computes real per-employee withholding from actual gross pay and that employee's own W-4 elections, instead of a flat guessed percentage.
- `test-tax-brackets.js`: 7 hand-computed cases (Single/MFJ/HoH at different incomes, a Step 3 credit large enough to floor withholding at $0, a wage too low to clear the standard deduction offset, missing filing status defaulting to single, Step 4(c) extra withholding). Deliberately double-checked my own arithmetic on the trickiest case (a 24%-bracket calculation) given a prior session's warning that a hand-check had been wrong once before — this time it matched on the first try, but the discipline of checking is worth keeping regardless.
- Also verified the *integration*, not just the isolated function — ran the actual per-employee payroll loop with two different staff members on different filing statuses and confirmed each got their own correctly different withholding amount (not a shared/global value). One of the two came out to exactly $0 withholding at that income level, which is mathematically correct (MFJ's much larger standard deduction offset), not a bug — worth remembering that a $0 result isn't automatically suspicious.
- PA state tax note added to the Taxes & Benefits page: PA's flat state rate is correctly represented by the existing "% of Gross" deduction type (not a gap). Local PA Earned Income Tax (Act 32) is explicitly flagged as unhandled — municipalities/school districts set their own local EIT rates.

## Known limitations, stated honestly
- W-4 Step 2 checkbox (multiple jobs) isn't modeled — the calculation always uses the Standard Withholding Rate Schedule. If any staff checked that box on their real W-4, this understates their withholding relative to their actual election. Would need a `w4Step2Checked` boolean and the Step 2 Checkbox tables (Pub 15-T publishes both).
- Local PA Earned Income Tax (Act 32) — genuinely unhandled, flagged on-page.
- No automated test exercises `confirmAndRunPayroll()`'s full DOM-driven flow end-to-end with a bracket deduction selected — the integration test this session covers the core per-employee calculation loop with real data, which is the part that actually mattered, but not the full click-through-the-UI path.
- Concurrency under genuinely simultaneous load (not just sequential test calls) has never been load-tested — the capacity-check code relies on Node's synchronous, single-threaded request handling to naturally serialize simultaneous requests to the same house, which is correct by construction from reading the code, but unverified under real concurrent connections.
- No direct deposit / tax filing / W-2 generation — this is a payroll calculator and record-keeper, not a full payroll processor. Out of scope by design.

## Everything built and verified in prior sessions (chronological, high-value items)
- SQLite backend replacing an earlier local-storage version; bcrypt auth, sessions, RBAC (admin/supervisor/viewer/employee)
- Payroll (2-step confirm→finalize flow), pay stubs, Taxes & Benefits defaults, real PDF downloads (jsPDF) for pay stubs and most reports
- PTO: employee requests, admin/supervisor approve/deny, balance only deducted on approval, protected from being overwritten by a stale bulk save
- Employee self-service portal ("My Schedule & Pay") — own shifts, pay stubs, PTO, clock in/out
- Automated daily + manual backups
- Mobile responsive layout (multiple overflow bugs found/fixed across sessions)
- **Security fixes found via deliberate audits, not assumed**: a "viewer" role could forge approval records and wipe pending violations (fixed); shift data had no server-side validation (fixed); CSV formula injection across all exports (fixed); `dbSave()`/`dbReset()` never checked HTTP response status (fixed — check every `fetch()` call verifies `res.ok`)
- **Timezone bug**: `.toISOString().split('T')[0]` for "today" always converts to UTC — fixed with `todayLocalISO()` using local `Date` getters. This exact bug class is why clock in/out stores local date/time strings reported by the browser rather than server-side epoch timestamps.
- Audit log hash-chaining — tamper-evident, verified by directly editing the raw SQLite file and confirming `/api/audit-log/verify` catches it
- Session idle timeout (1hr) on top of the 24hr absolute session life
- Shift time entry: separate Hour/Minute/AM-PM dropdowns after 3 iterations of user feedback
