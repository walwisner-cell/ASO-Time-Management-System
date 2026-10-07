// v77: ID documents and selfies are not kept forever.
//
// Once a verification has been decided (approved, rejected, or replaced by
// a newer upload), the uploaded files are only needed for a while: long
// enough to answer a question or a dispute about the decision. After the
// number of days set in Admin → Verification, the FILES are deleted from
// the disk. The RECORD stays (who, which kind of document, the name on it,
// who reviewed it and when), so "Verified" still has its trail.
//
// Submissions still waiting for review are never touched.
// A setting of 0 means "keep files until I delete them myself".
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DECIDED = ['approved', 'rejected', 'superseded'];

async function sweepIdDocumentRetention() {
  const { getSetting } = require('./platform-settings');
  const { PRIVATE_UPLOADS_DIR } = require('./uploads');
  const days = Number(await getSetting('idDocumentRetentionDays'));
  if (!Number.isFinite(days) || days <= 0) return { deleted: 0, skipped: 'retention is off' };

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const due = await db.filter('verifications', v =>
    DECIDED.includes(v.status) &&
    (v.documentFilename || v.selfieFilename || v.backFilename) &&
    String(v.reviewedAt || v.createdAt || '') !== '' &&
    String(v.reviewedAt || v.createdAt) <= cutoff
  );

  // v95: files are HELD, not deleted, while something involving the
  // account is still open, because the ID may be needed to settle it.
  const held = await accountsOnRetentionHold();
  let deleted = 0, heldBack = 0;
  for (const v of due) {
    if (held.has(v.userId)) { heldBack += 1; continue; }
    for (const name of [v.documentFilename, v.selfieFilename, v.backFilename]) {
      if (!name) continue;
      // Only ever a plain file name inside the private folder.
      const safe = path.basename(String(name));
      try { fs.unlinkSync(path.join(PRIVATE_UPLOADS_DIR, safe)); } catch (e) { /* already gone is fine */ }
    }
    await db.update('verifications', v.id, { documentFilename: null, selfieFilename: null, backFilename: null, filesDeletedAt: new Date().toISOString() });
    deleted += 1;
  }
  if (deleted > 0) console.log(`[id-retention] Deleted the uploaded files for ${deleted} decided verification${deleted === 1 ? '' : 's'} older than ${days} days. The records are kept.`);
  if (heldBack > 0) console.log(`[id-retention] Kept the files for ${heldBack} verification${heldBack === 1 ? '' : 's'} past the retention period because a dispute or fraud review is open.`);
  return { deleted, heldBack };
}

// Accounts whose ID files must not be deleted yet, with the reason:
//   - a party to a dispute that hasn't been resolved, closed or rejected
//   - an open fraud flag naming the account
//   - the account is on hold
async function accountsOnRetentionHold() {
  const reasons = new Map();
  const safe = async (c) => { try { return await db.all(c); } catch (e) { return []; } };
  const contracts = new Map((await safe('contracts')).map(c => [c.id, c]));
  for (const d of await safe('disputes')) {
    if (['resolved', 'closed', 'rejected'].includes(d.status)) continue;
    const c = contracts.get(d.contractId);
    if (c) { reasons.set(c.customerId, 'open dispute'); reasons.set(c.providerId, 'open dispute'); }
  }
  for (const f of await safe('fraudFlags')) {
    if (f.status !== 'open') continue;
    if (f.userId) reasons.set(f.userId, 'open fraud review');
    if (f.relatedUserId) reasons.set(f.relatedUserId, 'open fraud review');
  }
  for (const u of await db.filter('users', u => u.onHold === true)) reasons.set(u.id, 'account on hold');
  return reasons;
}

module.exports = { sweepIdDocumentRetention, accountsOnRetentionHold };
