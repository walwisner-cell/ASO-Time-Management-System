// PostgreSQL-backed datastore (rewritten in v108).
//
// Same seven actions as the JSON-file store in db-json.js: all, find,
// filter, insert, update, remove, replaceAll. db.js picks this file when
// DATABASE_URL is set. Nothing else in the app knows which one is in use.
//
// How records are kept: whole, as JSON, one row each, in one table (see
// schema.sql). This is deliberately the same shape as the JSON files.
// The version before this had a fixed column list for every kind of
// record; it stored only the fields on that list and quietly dropped the
// rest, so it fell behind every time the app gained a field or a new kind
// of record. This one cannot fall behind, because it has no list: any
// collection name and any field just works.
//
// find and filter read the whole collection and apply the caller's test
// in Node, exactly as the JSON store does. At Trothen's size that is fast
// and it keeps every route working unchanged. If a collection grows very
// large, the busiest reads are the ones to give real SQL first.
const { Pool, types } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false } // Render's managed Postgres requires SSL but uses a cert chain `pg` doesn't verify by default
    : (process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false),
  max: Number(process.env.PG_POOL_MAX) || 10,
});
// A dropped idle connection must not take the whole server down.
pool.on('error', (err) => console.error('[postgres] idle connection error:', err.message));

const T = 'trothen_records';
const SEQ = 'trothen_records_pos_seq';
const LOCK_KEY = 7468301; // any fixed number; stops two starting servers preparing the tables at once

// Collection names come from the app's own code, never from a visitor, but
// they are still passed as values ($1), never written into the SQL text.
function checkName(collection) {
  if (typeof collection !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(collection)) throw new Error(`Unknown collection: ${collection}`);
  return collection;
}
// The id column is only a quick way to find rows. The real id is the one
// inside the record, and that is what gets compared (see sameId).
const idText = (id) => (id !== undefined && id !== null) ? String(id) : null;
const idOf = (record) => idText(record ? record.id : undefined);
// The JSON store matches ids with ===, so the number 5 is not the text "5".
const sameId = (record, id) => !!record && typeof record === 'object' && record.id === id;
// What a record looks like after being written to a JSON file: fields set
// to undefined are gone, dates have become text.
const asJson = (record) => { const s = JSON.stringify(record); return s === undefined ? 'null' : s; };

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* the first error is the one that matters */ }
    throw e;
  } finally { client.release(); }
}

// Adds records at the end of a collection, in the order given. The
// position numbers are taken first so the order is certain.
async function appendRows(client, collection, records) {
  for (let start = 0; start < records.length; start += 500) {
    const chunk = records.slice(start, start + 500);
    const got = await client.query(`SELECT nextval('${SEQ}')::text AS pos FROM generate_series(1, $1::int)`, [chunk.length]);
    const positions = got.rows.map(r => BigInt(r.pos)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);
    await client.query(
      `INSERT INTO ${T} (pos, collection, id, data)
       SELECT p, $1, i, d::json FROM unnest($2::bigint[], $3::text[], $4::text[]) AS t(p, i, d)`,
      [collection, positions, chunk.map(idOf), chunk.map(asJson)]
    );
  }
}

// ---- Moving data over from the old layout ---------------------------------
// Before v108 each kind of record had its own table with fixed columns.
// If this database still has those tables with rows in them, and the new
// table is empty, the rows are copied across once at start-up. The old
// tables are left exactly as they were. Set TROTHEN_SKIP_LEGACY_IMPORT=1
// to turn this off.
const LEGACY_COLLECTIONS = ['users', 'categories', 'countries', 'cities', 'jobs', 'matches', 'contracts', 'platformSettings', 'homepageImages', 'categoryImages', 'escrowTransactions', 'payouts', 'disputes', 'reviews', 'notifications', 'messages', 'verifications', 'referrals', 'accessLogs', 'promotions', 'favoriteProviders', 'scopeChangeRequests', 'paymentMethods', 'passwordResets', 'phoneVerifications', 'portfolioPhotos', 'pendingRegistrations', 'categoryRequests', 'pendingLogins', 'fraudFlags', 'contactSubmissions', 'careersInquiries', 'advertisingInquiries', 'salesInquiries', 'organizations', 'organizationInvites', 'planPricingBase', 'membershipPricingBase', 'planPricingOverrides', 'exchangeRates', 'disputeAuditLog', 'disputeEvidence', 'announcements', 'dataCleanupAuditLog', 'goLiveAuditLog', 'pushSubscriptions', 'sessions'];
const camelToSnake = (s) => s.replace(/[A-Z]/g, (l) => '_' + l.toLowerCase());
const snakeToCamel = (s) => s.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
// Read old columns the way the app expects them: money and counts as
// numbers, a plain date as the text it was saved as. Times come back as
// dates and turn into the usual "2026-01-31T12:00:00.000Z" text when saved.
const legacyTypes = {
  getTypeParser(oid, format) {
    if (oid === 1700) return (v) => parseFloat(v); // NUMERIC
    if (oid === 20) return (v) => Number(v);       // BIGINT
    if (oid === 1082) return (v) => v;             // DATE
    return types.getTypeParser(oid, format);
  },
};

async function importLegacyTables(client) {
  if (process.env.TROTHEN_SKIP_LEGACY_IMPORT === '1') return [];
  if ((await client.query(`SELECT 1 FROM ${T} LIMIT 1`)).rows.length) return [];
  const tableOf = new Map(LEGACY_COLLECTIONS.map(c => [camelToSnake(c), c]));
  const found = await client.query(
    `SELECT table_name, bool_or(column_name = 'created_at') AS has_created
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
      GROUP BY table_name HAVING bool_or(column_name = 'id')`,
    [[...tableOf.keys()]]
  );
  if (!found.rows.length) return [];
  const done = [];
  await client.query('BEGIN');
  try {
    for (const collection of LEGACY_COLLECTIONS) { // fixed order, so every run does the same thing
      const hit = found.rows.find(r => r.table_name === camelToSnake(collection));
      if (!hit) continue;
      // table names here come from the fixed list above, never from outside
      const { rows } = await client.query({ text: `SELECT * FROM "${hit.table_name}" ORDER BY ${hit.has_created ? 'created_at NULLS LAST, ' : ''}ctid`, types: legacyTypes });
      if (!rows.length) continue;
      const records = rows.map(row => { const o = {}; for (const [k, v] of Object.entries(row)) o[snakeToCamel(k)] = v; return o; });
      await appendRows(client, collection, records);
      done.push({ collection, table: hit.table_name, count: records.length });
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* keep the first error */ }
    throw e;
  }
  if (done.length) console.log(`[postgres] Copied records from the old tables into ${T}: ${done.map(d => `${d.collection} ${d.count}`).join(', ')}. The old tables were left untouched.`);
  return done;
}

// Creates the table if it is missing (schema.sql is safe to run again and
// again), then moves old data over if there is any.
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
      module.exports.legacyImported = await importLegacyTables(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally { client.release(); }
}
// Runs once at start-up and every action below waits for it. If it fails
// (say the database was not reachable yet) the next action tries again.
let schemaPromise = null;
function ready() {
  if (!schemaPromise) schemaPromise = ensureSchema().catch((e) => { schemaPromise = null; throw e; });
  return schemaPromise;
}
const firstReady = ready();
firstReady.catch((e) => console.error('❌ Could not prepare the Postgres table:', e.message));

const db = {
  async all(collection) {
    await ready();
    const { rows } = await pool.query(`SELECT data FROM ${T} WHERE collection = $1 ORDER BY pos`, [checkName(collection)]);
    return rows.map(r => r.data);
  },

  async find(collection, predicate) {
    return (await db.all(collection)).find(predicate) || null;
  },

  async filter(collection, predicate) {
    return (await db.all(collection)).filter(predicate);
  },

  async insert(collection, record) {
    await ready();
    await pool.query(`INSERT INTO ${T} (collection, id, data) VALUES ($1, $2, $3::json)`, [checkName(collection), idOf(record), asJson(record)]);
    return record;
  },

  // Changes the fields in `patch` and leaves the rest, the same way the
  // JSON store does: the first record with that id, the new fields laid
  // over the old ones, and updatedAt set. The row is locked while this
  // happens so two changes to one record can't overwrite each other.
  async update(collection, id, patch) {
    await ready();
    const name = checkName(collection);
    return inTransaction(async (client) => {
      const found = await client.query(`SELECT pos, data FROM ${T} WHERE collection = $1 AND id IS NOT DISTINCT FROM $2 ORDER BY pos FOR UPDATE`, [name, idText(id)]);
      const row = found.rows.find(r => sameId(r.data, id));
      if (!row) return null;
      const merged = { ...row.data, ...patch, updatedAt: new Date().toISOString() };
      await client.query(`UPDATE ${T} SET data = $1::json, id = $2, updated_at = now() WHERE pos = $3`, [asJson(merged), idOf(merged), row.pos]);
      return merged;
    });
  },

  // Removes every record with that id. True if anything was removed.
  async remove(collection, id) {
    await ready();
    const name = checkName(collection);
    return inTransaction(async (client) => {
      const found = await client.query(`SELECT pos, data FROM ${T} WHERE collection = $1 AND id IS NOT DISTINCT FROM $2 FOR UPDATE`, [name, idText(id)]);
      const gone = found.rows.filter(r => sameId(r.data, id)).map(r => r.pos);
      if (!gone.length) return false;
      await client.query(`DELETE FROM ${T} WHERE pos = ANY($1::bigint[])`, [gone]);
      return true;
    });
  },

  // Swaps the whole collection in one step: either all of the new records
  // are in, or the old ones are still there.
  async replaceAll(collection, records) {
    await ready();
    const name = checkName(collection);
    const list = Array.isArray(records) ? records : [];
    await inTransaction(async (client) => {
      await client.query(`DELETE FROM ${T} WHERE collection = $1`, [name]);
      await appendRows(client, name, list);
    });
  },
};

module.exports = db;
// For the copy scripts and for tests: not used by the app's routes.
module.exports.pool = pool;
module.exports.ready = firstReady;
module.exports.legacyImported = [];
module.exports.collections = async () => { await ready(); return (await pool.query(`SELECT collection, count(*)::int AS n FROM ${T} GROUP BY collection ORDER BY collection`)).rows; };
