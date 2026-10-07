// Proves the Postgres store behaves exactly like the JSON-file store.
//
//   DATABASE_URL=postgres://...  node scripts/pg-parity-check.js [--data <folder>] [--wipe]
//
// USE A SCRATCH DATABASE. This empties and refills every collection it
// tests. It refuses to start if the database already holds Trothen records
// unless --wipe is given.
//
// --data <folder>  the .json files to test with (default: the repo's data
//                  folder). They are only read; the JSON side of the test
//                  runs in a temporary folder that is deleted afterwards.
//
// What it does, for every collection the app uses:
//   A. loads the data through both stores and compares what comes back
//   B. runs the same insert / update / find / filter / remove steps through
//      both stores and compares every answer
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const args = process.argv.slice(2);
const ROOT = path.join(__dirname, '..');
const dataAt = args.indexOf('--data');
const SOURCE = dataAt !== -1 ? path.resolve(args[dataAt + 1]) : path.join(ROOT, 'data');

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'trothen-parity-'));
process.env.DATA_DIR = TMP; // the JSON store reads this when it loads
process.env.TROTHEN_SKIP_LEGACY_IMPORT = '1';
const js = require('../src/db-json');
const pg = require('../src/db-postgres');

// Every collection name written in the app's code, plus every data file.
function findCollections() {
  const names = new Set();
  const scan = (file) => {
    const text = fs.readFileSync(file, 'utf-8');
    const call = /\b(?:db\.(?:all|find|filter|insert|update|remove|replaceAll)|safeAll|safe)\(\s*['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g;
    let m; while ((m = call.exec(text))) names.add(m[1]);
    // lists of names handed to a loop, e.g. for (const coll of ['proTools', 'proDocs'])
    const lists = /(?:PERSON_COLLECTIONS\s*=|for\s*\(const (?:coll|col|collection) of)\s*\[([^\]]*)\]/g;
    while ((m = lists.exec(text))) for (const q of m[1].match(/['"]([A-Za-z][A-Za-z0-9_]*)['"]/g) || []) names.add(q.slice(1, -1));
  };
  const walk = (dir) => { for (const f of fs.readdirSync(dir)) { const full = path.join(dir, f); if (fs.statSync(full).isDirectory()) walk(full); else if (f.endsWith('.js')) scan(full); } };
  walk(path.join(ROOT, 'src')); scan(path.join(ROOT, 'server.js'));
  if (fs.existsSync(SOURCE)) for (const f of fs.readdirSync(SOURCE)) if (/^[A-Za-z][A-Za-z0-9_]*\.json$/.test(f)) names.add(f.slice(0, -5));
  return [...names].sort();
}

let passed = 0, failed = 0;
const failures = [];
function check(label, fn) {
  try { fn(); passed += 1; }
  catch (e) { failed += 1; failures.push(`${label}: ${String(e.message).split('\n').slice(0, 6).join(' | ')}`); }
}
// Same values, same types (deepStrictEqual) and the same field order (same text).
function identical(label, a, b) {
  check(label, () => { assert.deepStrictEqual(a, b); assert.strictEqual(JSON.stringify(a), JSON.stringify(b)); });
}
// update() stamps the time, and the two stores run a moment apart. Check
// both stamps look right, then make them equal so the rest can be compared.
function alignStamp(label, a, b) {
  if (!a || !b) return;
  check(`${label} updatedAt format`, () => {
    for (const r of [a, b]) assert.match(r.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(new Date(a.updatedAt) - new Date(b.updatedAt)) < 60000);
  });
  b.updatedAt = a.updatedAt;
}

const tricky = (c, n) => ({
  id: `parity_${c}_${n}`,
  zeta: 'field order must be kept', alpha: 1,
  brandNewField: {
    nested: { deep: { deeper: [1, 'two', null, true, false, 3.5, { k: [] }, []] } },
    list: ['a', { b: null }, [1, [2, [3]]]],
    nothing: null, zero: 0, negative: -12.75, big: 9007199254740991, tiny: 1e-7, sci: 1.5e21,
    yes: true, no: false, empty: '', emptyObj: {}, emptyArr: [],
    when: '2026-10-07T14:03:09.120Z', whenNoMs: '2026-10-01T00:00:00Z', day: '2030-01-01', offset: '2026-10-07T10:03:09-04:00',
    text: 'quotes " \' back\\slash \n newline \t tab, emoji 💇🏽, Liberian $ L$, accents éñü, {curly,braces}, NULL',
    looksLikeNumber: '00123', looksLikeBool: 'true', looksLikeNull: 'null',
    'key with spaces': 1, 'key.with.dots': 2, 'snake_case_key': 3, 'UPPER': 4, '10': 'numeric-looking key', '2': 'another',
    control: 'nul:\u0000 bell:\u0007 loneSurrogate:\ud83d end',
  },
  amount: 180, rate: 0.15, flag: false, missing: null,
  createdAt: '2026-10-07T14:03:09.120Z',
});

async function both(label, fn) {
  let a, b, ea = null, eb = null;
  try { a = await fn(js); } catch (e) { ea = e; }
  try { b = await fn(pg); } catch (e) { eb = e; }
  if (ea || eb) { check(label, () => { assert.ok(ea && eb, `one store threw and the other did not: json=${ea && ea.message} postgres=${eb && eb.message}`); }); return [undefined, undefined]; }
  return [a, b];
}

async function testCollection(c) {
  const file = path.join(SOURCE, `${c}.json`);
  let seed = [];
  if (fs.existsSync(file)) { const raw = fs.readFileSync(file, 'utf-8').trim(); seed = raw ? JSON.parse(raw) : []; }

  // ---- A: the real data, in and out ----
  await js.replaceAll(c, seed); await pg.replaceAll(c, seed);
  let [a, b] = await both(`${c} A all`, d => d.all(c));
  identical(`${c} A all() after replaceAll (${seed.length} records)`, b, a);
  identical(`${c} A all() equals the source file`, b, seed);
  // and again one record at a time
  await js.replaceAll(c, []); await pg.replaceAll(c, []);
  for (const r of seed) { await js.insert(c, r); await pg.insert(c, r); }
  [a, b] = await both(`${c} A all 2`, d => d.all(c));
  identical(`${c} A all() after insert one by one`, b, a);

  // ---- B: the same steps through both stores ----
  const step = async (label, fn) => { const [x, y] = await both(`${c} B ${label}`, fn); identical(`${c} B ${label}`, y, x); return [x, y]; };
  const state = async (label) => { const [x, y] = await both(`${c} B state ${label}`, d => d.all(c)); identical(`${c} B contents after ${label}`, y, x); };

  const r1 = tricky(c, 1), r2 = tricky(c, 2);
  const withUndefined = { ...tricky(c, 3), gone: undefined, made: new Date('2026-03-04T05:06:07.089Z') };
  for (const d of [js, pg]) {
    const back = await d.insert(c, r1);
    check(`${c} B insert returns the very record it was given`, () => assert.strictEqual(back, r1));
    await d.insert(c, r2); await d.insert(c, withUndefined);
    await d.insert(c, { note: 'a record with no id' });
    await d.insert(c, { id: 7, note: 'a number id' });
    await d.insert(c, { id: '7', note: 'a text id that looks the same' });
    await d.insert(c, { id: r2.id, note: 'second record with the same id as r2' });
  }
  await state('inserts');

  await step('find by id', d => d.find(c, r => r.id === r1.id));
  await step('find by a nested new field', d => d.find(c, r => r.brandNewField && r.brandNewField.nested.deep.deeper[1] === 'two' && r.id === r2.id));
  await step('find nothing gives null', d => d.find(c, r => r.id === 'no-such-id'));
  await step('filter many', d => d.filter(c, r => typeof r.id === 'string' && r.id.startsWith('parity_')));
  await step('filter by type (number stays number, boolean stays boolean)', d => d.filter(c, r => r.amount === 180 && r.flag === false && r.missing === null));
  await step('filter nothing gives []', d => d.filter(c, () => false));

  const patch = { anotherNewField: { added: ['later', 2, null, { x: true }] }, brandNewField: null, alpha: 2, amount: 199.99, dropMe: undefined };
  let [ua, ub] = await both(`${c} B update`, d => d.update(c, r1.id, patch));
  alignStamp(`${c} B update`, ua, ub);
  identical(`${c} B update returns the merged record`, ub, ua);
  check(`${c} B update keeps a field set to undefined in what it returns, as the JSON store does`, () => assert.deepStrictEqual(Object.keys(ub), Object.keys(ua)));
  // the stored stamps differ by a few ms; line them up through the store itself
  await js.update(c, r1.id, {}); const fixed = (await js.find(c, r => r.id === r1.id)).updatedAt;
  const lineUp = async (id) => { for (const d of [js, pg]) { const all = await d.all(c); for (const r of all) if (r.id === id && r.updatedAt) r.updatedAt = fixed; await d.replaceAll(c, all); } };
  await lineUp(r1.id);
  await state('update');

  [ua, ub] = await both(`${c} B update again`, d => d.update(c, r1.id, { brandNewField: { back: 'again' }, updatedAt: 'the store sets this itself' }));
  alignStamp(`${c} B second update`, ua, ub);
  identical(`${c} B second update (existing fields keep their place, updatedAt is the store's)`, ub, ua);
  [ua, ub] = await both(`${c} B update dup`, d => d.update(c, r2.id, { touched: true }));
  alignStamp(`${c} B update of a duplicated id`, ua, ub);
  identical(`${c} B update of a duplicated id changes only the first`, ub, ua);
  [ua, ub] = await both(`${c} B update num`, d => d.update(c, 7, { touched: 'number id' }));
  alignStamp(`${c} B update by number id`, ua, ub);
  identical(`${c} B update by number id does not touch the text id`, ub, ua);
  [ua, ub] = await both(`${c} B update changes id`, d => d.update(c, withUndefined.id, { id: `parity_${c}_renamed` }));
  alignStamp(`${c} B update that changes the id`, ua, ub);
  identical(`${c} B update that changes the id`, ub, ua);
  await step('the renamed record is found under its new id only', async d => [!!(await d.find(c, r => r.id === `parity_${c}_renamed`)), await d.update(c, withUndefined.id, { x: 1 })]);
  await step('update of an id that is not there gives null', d => d.update(c, 'no-such-id', { x: 1 }));
  for (const id of [r1.id, r2.id, 7, `parity_${c}_renamed`]) await lineUp(id);
  await state('all updates');

  await step('remove gives true', d => d.remove(c, r1.id));
  await step('remove again gives false', d => d.remove(c, r1.id));
  await step('remove of a duplicated id removes both', d => d.remove(c, r2.id));
  await step('remove by text id leaves the number id', d => d.remove(c, '7'));
  await state('removes');
  await step('remove by number id', d => d.remove(c, 7));
  await step('remove with no id removes the records that have none', d => d.remove(c, undefined));
  await step('remove the renamed one', d => d.remove(c, `parity_${c}_renamed`));
  await step('find after remove gives null', d => d.find(c, r => r.id === r1.id));
  [a, b] = await both(`${c} B end`, d => d.all(c));
  identical(`${c} B back to the starting data`, b, a);
  identical(`${c} B starting data untouched`, b, seed);

  // leave the real data in place for the next checks
  await js.replaceAll(c, seed); await pg.replaceAll(c, seed);
}

async function main() {
  await pg.ready;
  const existing = await pg.collections();
  if (existing.length && !args.includes('--wipe')) {
    console.error(`This database already holds Trothen records (${existing.map(c => `${c.collection} ${c.n}`).join(', ')}).\nThis check empties collections. Use a scratch database, or add --wipe if this one may be wiped.`);
    return 1;
  }
  const version = (await pg.pool.query('SELECT version()')).rows[0].version;
  const collections = findCollections();
  console.log(`Database: ${version}`);
  console.log(`Test data: ${SOURCE}`);
  console.log(`Collections (${collections.length}): ${collections.join(', ')}\n`);

  for (const c of collections) {
    const before = failed;
    await testCollection(c);
    console.log(`  ${failed === before ? 'ok  ' : 'FAIL'} ${c}`);
  }

  // A name the app has never used must simply work, as it does with files.
  const fresh = 'somethingAddedNextYear';
  await js.replaceAll(fresh, []); await pg.replaceAll(fresh, []);
  identical('unknown collection: all() of a brand-new name is []', await pg.all(fresh), await js.all(fresh));
  identical('unknown collection: never-written name is []', await pg.all('neverWrittenAtAll'), await js.all('neverWrittenAtAll'));
  await testCollection(fresh);
  await pg.replaceAll(fresh, []);

  // Two changes to one record at the same moment must both land.
  await pg.replaceAll('parityRace', [{ id: 'r', n: 0 }]);
  await Promise.all(Array.from({ length: 20 }, (_, i) => pg.update('parityRace', 'r', { [`f${i}`]: i })));
  const raced = await pg.find('parityRace', r => r.id === 'r');
  check('20 updates at once to one record all land', () => assert.strictEqual(Object.keys(raced).filter(k => /^f\d+$/.test(k)).length, 20));
  // Many inserts at once keep every record.
  await Promise.all(Array.from({ length: 50 }, (_, i) => pg.insert('parityRace', { id: `i${i}` })));
  const count = (await pg.all('parityRace')).length;
  check('50 inserts at once: 51 records', () => assert.strictEqual(count, 51));
  // A big collection goes in whole and in order.
  const many = Array.from({ length: 2345 }, (_, i) => ({ id: `m${i}`, i, pad: 'x'.repeat(i % 50) }));
  await pg.replaceAll('parityRace', many);
  identical('2,345 records come back in the order they went in', await pg.all('parityRace'), many);
  // A failed replaceAll leaves the old records in place.
  const loop = {}; loop.self = loop;
  let threw = false; try { await pg.replaceAll('parityRace', [{ id: 'x' }, loop]); } catch (e) { threw = true; }
  check('replaceAll with a bad record throws', () => assert.ok(threw));
  const still = (await pg.all('parityRace')).length;
  check('old records still there after a failed replaceAll', () => assert.strictEqual(still, 2345));
  await pg.replaceAll('parityRace', []);

  console.log(`\n${passed} checks passed, ${failed} failed.`);
  for (const f of failures.slice(0, 40)) console.log('  FAILED ' + f);
  return failed ? 2 : 0;
}

main()
  .catch((e) => { console.error('Check could not run:', e); return 1; })
  .then(async (code) => {
    try { await pg.pool.end(); } catch (e) { /* closing anyway */ }
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(code);
  });
