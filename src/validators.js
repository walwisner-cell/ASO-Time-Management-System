// Shared input validation helpers used across every route that accepts
// user-provided data. Centralized here so every endpoint enforces the same
// rules consistently, rather than each route re-implementing its own ad hoc
// checks (which is how the app ended up with signup accepting a 1-character
// password while change-password required 6 — inconsistencies like that are
// exactly what this module exists to prevent).

// Closer to the WHATWG HTML5 living-standard email pattern than a naive
// "has an @ and a dot" check — catches things like leading/trailing dots,
// consecutive dots, and missing a real domain segment, without going all
// the way to a full RFC 5322 grammar (which rejects some real-world
// addresses people actually use). Combined with a practical max length
// (RFC 5321 caps a full email address at 254 characters).
// v79: also accepts addresses written in other alphabets or with accented
// letters (josé@correo.es, user@münchen.de). Any provider and any domain
// ending were already accepted; this was the one kind of real address
// being turned away. \p{L} is "any letter", \p{N} is "any digit".
const EMAIL_RE = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+$/u;

function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (trimmed.includes('..')) return false; // consecutive dots are never valid
  const atIndex = trimmed.indexOf('@');
  if (atIndex === -1) return false;
  const localPart = trimmed.slice(0, atIndex);
  if (localPart.startsWith('.') || localPart.endsWith('.')) return false; // leading/trailing dot in local part
  return EMAIL_RE.test(trimmed);
}

function isNonEmptyString(value, { min = 1, max = 500 } = {}) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

// A simple, honest heuristic for "does this look like real language" —
// not true gibberish detection (that's a much bigger, fuzzier problem),
// just catching the obvious keyboard-mashing case: real descriptions,
// even short ones ("AC repair", "fix leaky sink"), almost always have at
// least a couple of actual word-like tokens with a vowel in them.
// Something like "dghhjnjjjkkll;;''''''''" never does. A false rejection
// here is a minor annoyance (re-word your description); a false
// acceptance means a nonsense job sits in the system generating
// nonsense "AI match" notifications for real providers, which is worse.
function looksLikeRealText(str) {
  const words = str.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2) return false;
  const wordLikeCount = words.filter(w => /[a-zA-Z]{3,}/.test(w) && /[aeiouAEIOU]/.test(w)).length;
  return wordLikeCount >= 2;
}

// A short, well-known list of the most common breached/weak passwords
// (per guidance like NIST 800-63B, which recommends checking against known-
// compromised passwords over arbitrary complexity rules). This is not
// exhaustive — it exists to catch the most obvious "password123"-style
// choices, not to replace a real breached-password database at scale.
const COMMON_WEAK_PASSWORDS = new Set([
  // This app's own published demo passwords (current and Taskora-era) —
  // written in the source code, so never acceptable as a real password.
  'trothen123', 'taskora123',

  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', 'letmein123', 'welcome123', 'admin1234', 'iloveyou1',
  'abc123456', '11111111', '00000000', 'trothen123', // yes, even our own demo password shouldn't be reused for a real account
]);

// NIST 800-63B-aligned: length is the real signal, not forced composition
// (a long passphrase like "correct horse battery staple" is stronger than
// "Aa1!aaaaa" but would fail an old digit/letter/symbol quota). The only
// thing this still actively rejects, besides length, is a known-weak
// password — never an arbitrary character-mix rule that mostly just
// locks legitimate accounts out of the very passwords they're used to.
function isValidPassword(password) {
  if (typeof password !== 'string') return false;
  if (password.length < 8 || password.length > 72) return false;
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) return false;
  return true;
}

// Deliberately permissive on exact format — Trothen operates across the US,
// Nigeria, Ghana, and Liberia, and phone formats vary a lot by country. This
// checks for "plausible," not one country's exact pattern: digits (with
// optional +, spaces, dashes, parens), a realistic length, and rejects
// obvious junk like every digit being the same.
function isValidPhone(phone) {
  if (typeof phone !== 'string') return false;
  const trimmed = phone.trim();
  if (!/^[0-9+()\-\s]+$/.test(trimmed)) return false;
  const digitsOnly = trimmed.replace(/[^0-9]/g, '');
  if (digitsOnly.length < 8 || digitsOnly.length > 15) return false;
  if (/^(\d)\1+$/.test(digitsOnly)) return false; // e.g. "0000000000" or "1111111111"
  return true;
}

// Same "plausible across many countries" philosophy as phone — supports US
// ZIP (5 or 9 digit), Canadian/UK-style alphanumeric postcodes, and simpler
// numeric postal codes (Nigeria, Ghana, etc.), while rejecting obvious junk
// like a single character repeated the whole way through.
// Real, strict postal code formats — one entry per country that actually
// has a formal, standardized postal code system. Sources: the standard,
// publicly documented national postal formats (USPS, Royal Mail, Canada
// Post, India Post, Universal Postal Union country profiles, etc.) — the
// same references most real-world address-validation libraries use.
const POSTAL_CODE_PATTERNS = {
  'United States': /^\d{5}(-\d{4})?$/,
  'Canada': /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/,
  'United Kingdom': /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/,
  'Nigeria': /^\d{6}$/,
  'Liberia': /^\d{4}$/,
  'India': /^\d{6}$/,
  'Germany': /^\d{5}$/,
  'France': /^\d{5}$/,
  'Australia': /^\d{4}$/,
  'Brazil': /^\d{5}-?\d{3}$/,
  'Japan': /^\d{3}-?\d{4}$/,
  'China': /^\d{6}$/,
  'South Africa': /^\d{4}$/,
  'Mexico': /^\d{5}$/,
  'Kenya': /^\d{5}$/,
  'Italy': /^\d{5}$/,
  'Spain': /^\d{5}$/,
  'Netherlands': /^\d{4}\s?[A-Za-z]{2}$/,
  'Sweden': /^\d{3}\s?\d{2}$/,
  'Switzerland': /^\d{4}$/,
  'Poland': /^\d{2}-\d{3}$/,
  'Portugal': /^\d{4}-\d{3}$/,
  'Russia': /^\d{6}$/,
  'South Korea': /^\d{5}$/,
  'Singapore': /^\d{6}$/,
  'Indonesia': /^\d{5}$/,
  'Philippines': /^\d{4}$/,
  'Vietnam': /^\d{6}$/,
  'Thailand': /^\d{5}$/,
  'Turkey': /^\d{5}$/,
  'Egypt': /^\d{5}$/,
  'Chile': /^\d{7}$/,
  'Colombia': /^\d{6}$/,
  'Peru': /^\d{5}$/,
  'New Zealand': /^\d{4}$/,
  'Ireland': /^[A-Za-z]\d{2}\s?[A-Za-z0-9]{4}$/, // Eircode
  'Israel': /^\d{5,7}$/,
  'Saudi Arabia': /^\d{5}$/,
  'Austria': /^\d{4}$/,
  'Belgium': /^\d{4}$/,
  'Denmark': /^\d{4}$/,
  'Norway': /^\d{4}$/,
  'Finland': /^\d{5}$/,
  'Czechia': /^\d{3}\s?\d{2}$/,
  'Romania': /^\d{6}$/,
  'Hungary': /^\d{4}$/,
  'Greece': /^\d{3}\s?\d{2}$/,
  'Malaysia': /^\d{5}$/,
  'Bangladesh': /^\d{4}$/,
  'Pakistan': /^\d{5}$/,
  'Sri Lanka': /^\d{5}$/,
  'Morocco': /^\d{5}$/,
  'Tunisia': /^\d{4}$/,
  'Ecuador': /^\d{6}$/,
  'Venezuela': /^\d{4}$/,
  'Ukraine': /^\d{5}$/,
  'Argentina': /^([A-Za-z]\d{4}[A-Za-z]{3}|\d{4})$/,
  // Extended coverage — every other country with a real, standardized format:
  'Afghanistan': /^\d{4}$/,
  'Albania': /^\d{4}$/,
  'Algeria': /^\d{5}$/,
  'Andorra': /^AD\d{3}$/i,
  'Armenia': /^\d{4}$/,
  'Azerbaijan': /^AZ\d{4}$/i,
  'Bahrain': /^\d{3,4}$/,
  'Barbados': /^BB\d{5}$/i,
  'Belarus': /^\d{6}$/,
  'Bhutan': /^\d{5}$/,
  'Bosnia and Herzegovina': /^\d{5}$/,
  'Brunei': /^[A-Za-z]{2}\d{4}$/i,
  'Bulgaria': /^\d{4}$/,
  'Cabo Verde': /^\d{4}$/,
  'Cambodia': /^\d{5}$/,
  'Costa Rica': /^\d{5}$/,
  'Croatia': /^\d{5}$/,
  'Cuba': /^\d{5}$/,
  'Cyprus': /^\d{4}$/,
  'Dominican Republic': /^\d{5}$/,
  'El Salvador': /^\d{4}$/,
  'Estonia': /^\d{5}$/,
  'Eswatini': /^[A-Za-z]\d{3}$/i,
  'Ethiopia': /^\d{4}$/,
  'Georgia': /^\d{4}$/,
  'Guatemala': /^\d{5}$/,
  'Haiti': /^(HT)?\d{4}$/i,
  'Honduras': /^\d{5}$/,
  'Iceland': /^\d{3}$/,
  'Iran': /^\d{5}-?\d{5}$/,
  'Iraq': /^\d{5}$/,
  'Jordan': /^\d{5}$/,
  'Kazakhstan': /^\d{6}$/,
  'Kosovo': /^\d{5}$/,
  'Kuwait': /^\d{5}$/,
  'Kyrgyzstan': /^\d{6}$/,
  'Laos': /^\d{5}$/,
  'Latvia': /^LV-?\d{4}$/i,
  'Lebanon': /^\d{4}\s?\d{4}$/,
  'Lesotho': /^\d{3}$/,
  'Liechtenstein': /^\d{4}$/,
  'Lithuania': /^LT-?\d{5}$/i,
  'Luxembourg': /^\d{4}$/,
  'Madagascar': /^\d{3}$/,
  'Maldives': /^\d{5}$/,
  'Malta': /^[A-Za-z]{3}\s?\d{4}$/i,
  'Marshall Islands': /^\d{5}$/,
  'Mauritius': /^\d{5}$/,
  'Micronesia': /^\d{5}$/,
  'Moldova': /^MD-?\d{4}$/i,
  'Monaco': /^980\d{2}$/,
  'Mongolia': /^\d{5}$/,
  'Montenegro': /^\d{5}$/,
  'Myanmar': /^\d{5}$/,
  'Nepal': /^\d{5}$/,
  'Nicaragua': /^\d{5}$/,
  'Niger': /^\d{4}$/,
  'North Macedonia': /^\d{4}$/,
  'Oman': /^\d{3}$/,
  'Palau': /^\d{5}$/,
  'Panama': /^\d{4}$/,
  'Papua New Guinea': /^\d{3}$/,
  'Paraguay': /^\d{4}$/,
  'Saint Vincent and the Grenadines': /^VC\d{4}$/i,
  'San Marino': /^4789\d$/,
  'Senegal': /^\d{5}$/,
  'Serbia': /^\d{5,6}$/,
  'Slovakia': /^\d{3}\s?\d{2}$/,
  'Slovenia': /^(SI-)?\d{4}$/i,
  'Somalia': /^[A-Za-z]{2}\s?\d{5}$/i,
  'Sudan': /^\d{5}$/,
  'Taiwan': /^\d{3}(\d{2})?$/,
  'Tajikistan': /^\d{6}$/,
  'Turkmenistan': /^\d{6}$/,
  'Uruguay': /^\d{5}$/,
  'Uzbekistan': /^\d{6}$/,
  'Vatican City': /^00120$/,
  'Zambia': /^\d{5}$/,
};

// Countries with no formal, standardized postal code system in wide use.
// Requiring a made-up format here would just block real people who
// genuinely have nothing to enter — so for these, the zip/postal code
// field is treated as optional rather than validated against a pattern
// that doesn't really exist. (Ghana is deliberately here too: GhanaPostGPS
// digital addresses exist but aren't universally adopted yet, so enforcing
// that format would incorrectly block real users who don't have one.)
const NO_POSTAL_CODE_COUNTRIES = new Set([
  'Angola', 'Antigua and Barbuda', 'Bahamas', 'Belize', 'Benin', 'Bolivia', 'Botswana',
  'Burkina Faso', 'Burundi', 'Cameroon', 'Central African Republic', 'Chad', 'Comoros',
  "Congo (Brazzaville)", 'Congo (DRC)', "Cote d'Ivoire", 'Djibouti', 'Dominica',
  'Equatorial Guinea', 'Eritrea', 'Fiji', 'Gabon', 'Gambia', 'Ghana', 'Grenada', 'Guinea',
  'Guinea-Bissau', 'Guyana', 'Jamaica', 'Kiribati', 'Libya', 'Malawi', 'Mali', 'Mauritania',
  'Mozambique', 'Namibia', 'Nauru', 'North Korea', 'Palestine', 'Qatar', 'Rwanda',
  'Saint Kitts and Nevis', 'Saint Lucia', 'Samoa', 'Sao Tome and Principe', 'Seychelles',
  'Sierra Leone', 'Solomon Islands', 'South Sudan', 'Suriname', 'Syria', 'Tanzania',
  'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tuvalu', 'Uganda',
  'United Arab Emirates', 'Vanuatu', 'Yemen', 'Zimbabwe',
]);

// A country genuinely having no formal postal system is different from a
// country whose format we simply haven't verified — for the former,
// requiring the field at all would be asking for something that doesn't
// exist, so an empty value is valid there. Everywhere else, a specific
// pattern is checked if we have one; otherwise the permissive generic
// check still guards against obvious junk.
function isValidPostalCode(code, country) {
  const trimmed = typeof code === 'string' ? code.trim() : '';

  if (country && NO_POSTAL_CODE_COUNTRIES.has(country)) {
    // Optional here: empty is fine, but if they did enter something, it
    // should at least be reasonable free text, not garbage.
    if (!trimmed) return true;
    return trimmed.length <= 20 && /^[a-zA-Z0-9\s-]*$/.test(trimmed);
  }

  if (typeof code !== 'string') return false;

  if (country && POSTAL_CODE_PATTERNS[country]) {
    return POSTAL_CODE_PATTERNS[country].test(trimmed);
  }

  // Generic fallback for countries without a listed strict format (or when
  // no country was supplied): permissive but still rejects obvious junk.
  if (trimmed.length < 3 || trimmed.length > 10) return false;
  if (!/^[a-zA-Z0-9\s-]+$/.test(trimmed)) return false;
  const alnumOnly = trimmed.replace(/[\s-]/g, '');
  if (/^(.)\1+$/.test(alnumOnly)) return false; // e.g. "00000" or "AAAAA"
  return true;
}

function postalCodeIsOptionalFor(country) {
  return !!(country && NO_POSTAL_CODE_COUNTRIES.has(country));
}

// Human-readable format hints for the countries with a strict pattern above
// — telling someone "enter 5 digits" is a lot more useful than a generic
// "invalid postal code" when we actually know the real expected format.
const POSTAL_CODE_HINTS = {
  'United States': '5 digits (e.g. 30301), optionally +4 (30301-1234)',
  'Canada': 'the format A1A 1A1 (letter-digit-letter, space, digit-letter-digit)',
  'United Kingdom': 'a valid UK postcode (e.g. SW1A 1AA)',
  'Nigeria': '6 digits',
  'Liberia': '4 digits',
  'India': '6 digits (PIN code)',
  'Germany': '5 digits',
  'France': '5 digits',
  'Australia': '4 digits',
  'Brazil': '8 digits (CEP), optionally as 12345-678',
  'Japan': '7 digits, optionally as 123-4567',
  'China': '6 digits',
  'South Africa': '4 digits',
  'Mexico': '5 digits',
  'Kenya': '5 digits',
  'Ireland': 'a valid Eircode (e.g. D02 AF30)',
};

function postalCodeErrorMessage(country) {
  const hint = POSTAL_CODE_HINTS[country];
  return hint ? `Enter a valid postal/zip code — ${country} uses ${hint}` : 'Enter a valid postal/zip code';
}

// Real people's names: letters (Unicode-aware, so "José", "Chidinma", "Åsa"
// all work), spaces, hyphens, apostrophes, and periods (for "Jr.", "St."),
// but never digits or other symbols.
const NAME_RE = /^[\p{L}][\p{L}\s'.\-]*$/u;

function isValidName(name, { min = 2, max = 100 } = {}) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length < min || trimmed.length > max) return false;
  return NAME_RE.test(trimmed);
}

// MM/YY card expiry format, with a plausible (not-already-expired,
// not-absurdly-far-future) year range. This validates the FORMAT and basic
// plausibility of what was entered — not whether it's a real card, which is
// out of scope until a real payment processor is wired in.
function isValidCardExpiry(expiry) {
  if (typeof expiry !== 'string') return false;
  const match = expiry.trim().match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!match) return false;
  const month = parseInt(match[1], 10);
  const year = parseInt('20' + match[2], 10);
  if (month < 1 || month > 12) return false;
  const now = new Date();
  const currentYear = now.getFullYear();
  if (year < currentYear || year > currentYear + 20) return false;
  if (year === currentYear && month < now.getMonth() + 1) return false; // already expired this year
  return true;
}

// Category/country/plan names: real words, not "123" or "!!!" — allows
// letters, digits (e.g. "24/7 Support" as a plan feature), spaces, and a
// small set of common punctuation (&, /, -) without being so permissive
// that pure symbol/number spam gets through.
function isValidLabel(value, { min = 2, max = 60 } = {}) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return false;
  if (!/[a-zA-Z]/.test(trimmed)) return false; // must contain at least one real letter
  return /^[\p{L}0-9\s&/'.\-]+$/u.test(trimmed);
}

// Collects every failing rule instead of stopping at the first one, so the
// client can show all problems at once rather than one at a time.
function validate(rules) {
  const errors = [];
  for (const [field, check, message] of rules) {
    if (!check) errors.push(message || `${field} is invalid`);
  }
  return errors;
}

// Item 7 / ID Name Matching — a real, honest comparison, not exact-string
// equality (which would falsely flag "Jon Smith Jr." vs "Jon Smith" or a
// stray extra space as a mismatch). Normalizes case, punctuation, and
// whitespace, then checks whether one name's words are a subset of the
// other's — genuine legal-name variations (middle name present on one but
// not the other, a suffix, a hyphenated surname split differently) pass;
// a name that's actually a different person doesn't share enough words to
// pass. This is deliberately permissive toward false negatives over false
// positives — flagging a legitimate difference for a human's controlled
// manual review (see the country-aware docType flow in misc.routes.js) is
// the right failure mode, not silently auto-rejecting a real applicant.
function normalizeNameForMatch(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(w));
}

function namesLikelyMatch(accountName, idLegalName) {
  const a = new Set(normalizeNameForMatch(accountName));
  const b = normalizeNameForMatch(idLegalName);
  if (a.size === 0 || b.length === 0) return false;
  const overlap = b.filter(w => a.has(w)).length;
  // At least half of the ID name's words need to show up in the account
  // name (or vice versa isn't required — a full legal name on an ID
  // reasonably has more words than a casual account display name).
  return overlap / b.length >= 0.5;
}

module.exports = {
  isValidEmail, isNonEmptyString, isValidPassword, isValidPhone, isValidPostalCode,
  isValidName, isValidCardExpiry, isValidLabel, validate, EMAIL_RE, postalCodeErrorMessage,
  postalCodeIsOptionalFor, looksLikeRealText, namesLikelyMatch,
};
