// v96: who should be told about something that happens in a place.
//
// Regional admins can cover one city or a whole country (v90). The code
// that sends admins a notice ("new contact message from Monrovia", "this
// pro's license expires soon") still only looked for an admin whose city
// matched, so a country-wide admin was never told. This is the one place
// that answers "which regional admins look after this city / country".
const db = require('./db');
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

async function regionalAdminsFor({ city, country } = {}) {
  const admins = await db.filter('users', u => u.role === 'admin' && !u.isSuperAdmin && !u.adminDepartment && u.active !== false);
  if (!admins.length) return [];
  // When only a city is known (a public form), work out which countries
  // have a city by that name, from the cities list and from accounts.
  let countriesOfCity = null;
  if (!country && city) {
    countriesOfCity = new Set();
    try { for (const c of await db.filter('cities', c => same(c.name, city))) if (c.country) countriesOfCity.add(String(c.country).toLowerCase()); } catch (e) { /* no cities list */ }
    for (const u of await db.filter('users', u => u.role !== 'admin' && same(u.city, city) && u.country)) countriesOfCity.add(String(u.country).toLowerCase());
  }
  return admins.filter(a => {
    if (a.adminScope === 'country' && a.country) {
      if (country) return same(a.country, country);
      return !!countriesOfCity && countriesOfCity.has(String(a.country).toLowerCase());
    }
    return !!city && same(a.city, city);
  });
}

// v105: "may this admin look after this person?" for screens outside
// admin.routes.js (the store and skills review). Same rules as myRegion()
// there: a super admin sees everyone; a regional admin sees their city or
// their whole country; a department admin sees everyone unless their
// account was created as region-scoped.
function adminScopeFor(admin) {
  if (!admin || admin.role !== 'admin' || admin.active === false) return () => false;
  if (admin.isSuperAdmin) return () => true;
  const scoped = (person) => {
    if (!person) return false;
    if (admin.adminScope === 'country' && admin.country) return same(person.country, admin.country);
    return same(person.city, admin.region || admin.city);
  };
  if (!admin.adminDepartment) return scoped;
  if (admin.adminDepartment !== 'sales' && admin.regionScoped) return scoped;
  return () => true;
}

module.exports = { regionalAdminsFor, adminScopeFor };
