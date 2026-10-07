// v106: is this guarantor really someone else?
//
// A guarantor vouches for a pro when there is no background-check service
// to use. If the "guarantor" has the pro's own phone number or the pro's
// own name, a call to them proves nothing. This is the one place that
// decides that, used when a pro saves guarantors and when the team reviews
// ones saved before this check existed.
const normalizeNameForMatch = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 0 && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(w));

// Phone numbers are compared by their last 9 digits, so "+231 77 000 0000",
// "0770000000" and "231770000000" count as the same number.
function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-9) : digits;
}
function sameName(a, b) {
  const key = (n) => { const t = normalizeNameForMatch(String(n || '')); return (Array.isArray(t) ? t.slice().sort().join(' ') : String(t)).trim(); };
  const x = key(a), y = key(b);
  return x.length >= 4 && x === y;
}
// Returns 'phone', 'name' or null.
function guarantorProblem(pro, g) {
  if (!pro || !g) return null;
  const k = phoneKey(g.phone);
  if (k && k.length >= 7 && k === phoneKey(pro.phone)) return 'phone';
  if (sameName(g.name, pro.name)) return 'name';
  return null;
}
module.exports = { phoneKey, sameName, guarantorProblem };
