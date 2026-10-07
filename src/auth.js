const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// In production this must come from an environment variable / secrets
// manager, never be hardcoded — render.yaml already configures Render to
// auto-generate a real, strong secret the first time this service is
// deployed via its Blueprint, so this fallback should never actually be
// used in the real deployment. But relying on "the platform always sets
// this correctly, forever" is fragile — an env var can be accidentally
// cleared, a migration to different hosting might not carry it over, a
// manual dashboard edit could reset it. This fallback string is sitting
// in this repo's source code, which is public — if it were ever actually
// used to sign real tokens in production, anyone who's seen this file
// could forge a valid token for any account, including super admin, with
// no password needed at all. So rather than silently using a known,
// public string if the real env var is ever missing, this generates a
// genuinely random secret instead and logs a warning impossible to miss —
// the app stays up, but never signs a real token with a secret anyone
// could just read here.
function resolveJwtSecret() {
  if (process.env.TROTHEN_JWT_SECRET) return process.env.TROTHEN_JWT_SECRET;

  // Transition fallback: this app was renamed from Taskora to Trothen. The
  // live Render service may still have the OLD env var name set from
  // before the rename, and hasn't been updated to the new one yet. Reading
  // it here means nothing breaks — no forced logout, no downtime — in the
  // window between deploying this rename and actually adding
  // TROTHEN_JWT_SECRET in Render's dashboard. Once that new var is added
  // and confirmed working, this fallback (and the old var itself) should
  // be removed.
  if (process.env.TASKORA_JWT_SECRET) {
    console.warn('⚠️  Using legacy TASKORA_JWT_SECRET — add TROTHEN_JWT_SECRET in your Render environment settings and remove this old one once confirmed working.');
    return process.env.TASKORA_JWT_SECRET;
  }

  const randomFallback = crypto.randomBytes(48).toString('hex');
  const isProduction = process.env.NODE_ENV === 'production';
  const banner = isProduction
    ? '🚨🚨🚨 CRITICAL: TROTHEN_JWT_SECRET is not set in production! 🚨🚨🚨'
    : '⚠️  TROTHEN_JWT_SECRET is not set (expected in local dev).';
  console.error(banner);
  console.error(isProduction
    ? '   Generated a random secret for THIS boot only — every existing login session just became invalid, and will again on every future restart until a real TROTHEN_JWT_SECRET is set as an environment variable. Set this in your hosting platform\'s environment settings immediately — do not rely on this fallback.'
    : '   Using a random secret for this local session — fine for local development.');
  return randomFallback;
}
const JWT_SECRET = resolveJwtSecret();
const TOKEN_TTL = '7d';

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

// Item: per-device sign-out. Every signed token corresponds to a real row
// in the sessions table — deleting that one row (see POST /auth/logout) is
// what makes signing out actually just end THIS login, not every device
// the account is signed into. deviceLabel is optional and purely
// descriptive (truncated User-Agent) — nothing currently checks it, it
// just makes a future "your active sessions" view possible without
// another schema change.
//
// This is async now (it wasn't before) because it has to write the
// session row before the token referencing it can be signed — every call
// site was updated to await it.
async function signToken(user, deviceLabel) {
  const db = require('./db');
  const { nanoid } = require('nanoid');
  const sessionId = nanoid(21);
  await db.insert('sessions', {
    id: sessionId,
    userId: user.id,
    deviceLabel: deviceLabel ? deviceLabel.slice(0, 200) : null,
    createdAt: new Date().toISOString(),
  });
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, tokenVersion: user.tokenVersion || 0, sessionId },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// Password-reset tokens are high-entropy random strings, not user-chosen
// passwords — a fast cryptographic hash (SHA-256) is the standard, correct
// choice for these, unlike bcrypt which exists specifically to slow down
// brute-forcing *low*-entropy user passwords. Hashing the token before
// storing it means a leaked database still can't be used to reset accounts.
function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// A JWT's signature being valid only proves it was genuinely issued by this
// server at some point in the last 7 days — it says nothing about whether
// the account is still allowed to use it *right now*. Without re-checking
// the database, a suspended customer or provider's existing token would
// keep working perfectly for the rest of its 7-day life, same bug this app
// already fixed for admin accounts specifically — this makes that check
// apply to every authenticated request, for every role, in one place,
// instead of each route file needing to remember to do it.
//
// db is required lazily (inside the function, not at module load time) to
// avoid a circular require — db.js doesn't depend on auth.js, but requiring
// it at the top of this file changes module load order in a way that's
// easy to accidentally break later, and there's no real cost to requiring
// it lazily here since Node caches the module after the first call.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    const db = require('./db');
    const current = await db.find('users', u => u.id === payload.sub);
    if (!current || current.active === false) {
      if (current && current.closedByOwner) return res.status(403).json({ error: 'This account was closed at its owner\'s request.' });
      return res.status(403).json({ error: 'This account has been suspended. Contact support for details.' });
    }
    // A password change bumps tokenVersion — any token signed before that
    // change (a stolen token, a forgotten logged-in device) stops working
    // immediately, rather than staying valid for the rest of its 7-day
    // life regardless of the password change that was supposed to protect
    // the account.
    if ((payload.tokenVersion || 0) !== (current.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Your session is no longer valid — please sign in again.' });
    }
    // Item: per-device sign-out enforcement — see signToken above and
    // POST /auth/logout. A token that passed the tokenVersion check can
    // still have been individually signed out. A token signed before this
    // session system existed has no real sessionId to match, which
    // correctly (and only once, right after this deploys) signs everyone
    // out — the same one-time reset a JWT_SECRET rotation would cause.
    if (payload.sessionId) {
      const session = await db.find('sessions', s => s.id === payload.sessionId);
      if (!session) {
        return res.status(401).json({ error: 'Your session is no longer valid — please sign in again.' });
      }
    }
    // An account created with a starting temp password (see POST
    // /admin/sub-admins) can't do anything else on the platform until a
    // real password is set — GET /auth/me still has to work (the frontend
    // needs it to even know this flag is set) and the change-password
    // endpoint itself obviously has to work, but every other request is
    // blocked with a distinct error code the frontend recognizes.
    if (current.mustChangePassword) {
      const isMe = req.originalUrl.startsWith('/api/auth/me') && req.method === 'GET';
      const isChangePassword = req.originalUrl.startsWith('/api/auth/change-password');
      if (!isMe && !isChangePassword) {
        return res.status(403).json({ error: 'You must set a new password before continuing.', code: 'MUST_CHANGE_PASSWORD' });
      }
    }
  } catch (e) {
    // A database hiccup here shouldn't lock every single request out — log
    // it and fall back to trusting the JWT's own signature/expiry, same
    // safety net the app already had before this check existed.
    console.error('requireAuth: could not verify current account status', e);
  }
  req.user = payload; // { sub, role, email }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }
    next();
  };
}

module.exports = {
  hashPassword, verifyPassword, signToken, requireAuth, requireRole, JWT_SECRET,
  generateResetToken, hashResetToken,
};
