// v81: one place for the agreement version, and a server-side check.
//
// Until now, agreeing to the terms was only enforced by the page: the
// agreement screen appears at sign-in and can't be closed. But the server
// itself never checked, so a request sent straight to the server (not
// through the page) could post a job or take a booking without ever
// agreeing. requireCurrentTerms closes that: the actions that create a
// commitment between two people, or move money, are refused until the
// account has agreed to the current version.
const db = require('./db');

const CURRENT_TERMS_VERSION = 'v2-2026'; // v76: checkbox agreement, and customers now need a reviewed ID

async function requireCurrentTerms(req, res, next) {
  try {
    const user = await db.find('users', u => u.id === req.user.sub);
    if (!user || user.role === 'admin') return next(); // staff accounts don't sign the customer/pro agreement
    if (user.termsVersion === CURRENT_TERMS_VERSION) return next();
    return res.status(403).json({ code: 'ACCEPT_TERMS', error: 'Please read and agree to the Trothen terms first. The agreement opens when you sign in.' });
  } catch (e) { next(e); }
}

module.exports = { CURRENT_TERMS_VERSION, requireCurrentTerms };
