// Copies Trothen's records from the JSON files into Postgres, then checks
// the copy. Run it once when moving from files to a database. It is safe
// to run again.
//
//   DATABASE_URL=postgres://...  DATA_DIR=/var/data  node scripts/json-to-postgres.js
//
//   (no option)      Copy every <name>.json in DATA_DIR. If Postgres already
//                    holds records for any of them, nothing is changed and
//                    the script says which ones.
//   --replace        Overwrite those collections with what is in the files.
//   --check          Change nothing. Only compare the files with Postgres.
//   --export <dir>   The other way: write what is in Postgres out as JSON
//                    files into an empty folder (a readable copy, or a way back).
//
// Uploaded photos and ID documents are files on the disk, not records.
// This does not touch them and they stay where they are.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

function fail(message) { console.error(message); process.exit(1); }

// Exactly the same text means exactly the same record: same fields, same
// order, same values.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set. Nothing was done.');
  // The files are the source here, so don't also pull in rows from the old pre-v108 tables.
  process.env.TROTHEN_SKIP_LEGACY_IMPORT = '1';
  const pg = require('../src/db-postgres');
  await pg.ready;

  const exportAt = args.indexOf('--export');
  if (exportAt !== -1) {
    const out = args[exportAt + 1];
    if (!out || out.startsWith('--')) fail('Give a folder after --export.');
    fs.mkdirSync(out, { recursive: true });
    if (fs.readdirSync(out).some(f => f.endsWith('.json'))) fail(`${out} already has .json files in it. Choose an empty folder.`);
    let total = 0;
    for (const { collection } of await pg.collections()) {
      const records = await pg.all(collection);
      fs.writeFileSync(path.join(out, `${collection}.json`), JSON.stringify(records, null, 2));
      console.log(`  ${collection}: ${records.length}`);
      total += records.length;
    }
    console.log(`Wrote ${total} records to ${out}`);
    return 0;
  }

  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fail(`${dir} does not exist. Set DATA_DIR to the folder that holds the .json files.`);
  const source = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isFile()) continue;
    const name = f.slice(0, -5);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) { console.log(`  skipped ${f}: not a collection name`); continue; }
    let records;
    try { const raw = fs.readFileSync(full, 'utf-8').trim(); records = raw ? JSON.parse(raw) : []; }
    catch (e) { fail(`${f} could not be read as JSON (${e.message}). Nothing was done.`); }
    if (!Array.isArray(records)) { console.log(`  skipped ${f}: not a list of records`); continue; }
    source.push({ name, records });
  }
  if (!source.length) fail(`No .json files found in ${dir}. Nothing was done.`);

  const counts = new Map((await pg.collections()).map(c => [c.collection, c.n]));

  if (!has('--check')) {
    const inTheWay = source.filter(s => (counts.get(s.name) || 0) > 0);
    if (inTheWay.length && !has('--replace')) {
      console.error('Postgres already holds records for these collections:');
      for (const s of inTheWay) console.error(`  ${s.name}: ${counts.get(s.name)} in Postgres, ${s.records.length} in the file`);
      fail('Nothing was changed. Run with --check to compare, or with --replace to overwrite them with the files.');
    }
    console.log(`Copying ${source.length} collections from ${dir} into Postgres${inTheWay.length ? ' (replacing what is there)' : ''}...`);
    for (const s of source) await pg.replaceAll(s.name, s.records);
  }

  // Check: read everything back and compare with the files.
  let bad = 0, total = 0;
  for (const s of source) {
    const back = await pg.all(s.name);
    const ok = back.length === s.records.length && back.every((r, i) => same(r, s.records[i]));
    console.log(`  ${ok ? 'OK       ' : 'DIFFERENT'} ${s.name}: ${s.records.length} in the file, ${back.length} in Postgres`);
    if (!ok) bad += 1;
    total += s.records.length;
  }
  const inFiles = new Set(source.map(s => s.name));
  const extra = (await pg.collections()).filter(c => !inFiles.has(c.collection));
  if (extra.length) console.log(`Only in Postgres (no file for these, left alone): ${extra.map(c => `${c.collection} ${c.n}`).join(', ')}`);
  if (bad) { console.error(`${bad} of ${source.length} collections do NOT match the files.`); return 2; }
  console.log(`${has('--check') ? 'Checked' : 'Copied and checked'}: ${source.length} collections, ${total} records. Postgres matches the files exactly.`);
  return 0;
}

main()
  .then(async (code) => { try { await require('../src/db-postgres').pool.end(); } catch (e) { /* closing anyway */ } process.exit(code); })
  .catch((e) => { console.error('Failed:', e.message); process.exit(1); });
