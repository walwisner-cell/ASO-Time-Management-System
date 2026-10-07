// v82: a nightly copy of the data files.
//
// Trothen's records live in JSON files in the data folder. Until now there
// was no copy: one bad write, bug or mistaken delete and there was nothing
// to go back to. Once a day this copies every data file into
// <data folder>/backups/<date>/ and keeps the newest 14 days.
//
// What this is NOT: it is on the same disk as the data, so it doesn't
// protect against losing the disk itself. That needs Render's own disk
// snapshots or a copy kept somewhere else. Uploaded photos and ID files
// are not included.
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 14;
function dataDir() { return process.env.DATA_DIR || path.join(__dirname, '..', 'data'); }
function backupsDir() { return path.join(dataDir(), 'backups'); }

function runBackup(now = new Date()) {
  const src = dataDir();
  const day = now.toISOString().slice(0, 10);
  const dest = path.join(backupsDir(), day);
  fs.mkdirSync(dest, { recursive: true });
  let files = 0, bytes = 0;
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith('.json')) continue;
    const from = path.join(src, f);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(dest, f));
    files += 1; bytes += fs.statSync(from).size;
  }
  // keep the newest KEEP_DAYS folders
  const days = fs.readdirSync(backupsDir()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) {
    fs.rmSync(path.join(backupsDir(), old), { recursive: true, force: true });
  }
  console.log(`[backup] Copied ${files} data files (${Math.round(bytes / 1024)} KB) to backups/${day}.`);
  return { day, files, bytes };
}

function listBackups() {
  let days = [];
  try { days = fs.readdirSync(backupsDir()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch (e) { /* none yet */ }
  return days.map(d => {
    const dir = path.join(backupsDir(), d);
    const names = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    return { day: d, files: names.length, bytes: names.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) };
  });
}

// Only when using the file store. With a database, backups are the database's job.
// v99: one backup as a single .tar.gz file, so a copy can be kept OFF the
// server (the nightly copies sit on the same disk as the data, so they
// don't survive losing that disk). Built with nothing but Node itself:
// a tar file is a list of 512-byte headers each followed by the file's
// bytes, then gzip over the whole thing. Opens with any unzip tool, or
// "tar -xzf file.tar.gz" in the Windows command prompt.
function buildBackupArchive(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error('bad day');
  const dir = path.join(backupsDir(), day);
  if (!fs.existsSync(dir)) throw new Error('no such backup');
  const zlib = require('zlib');
  const blocks = [];
  const header = (name, size, mtime) => {
    const h = Buffer.alloc(512, 0);
    h.write(name.slice(0, 99), 0, 'utf8');
    h.write('0000644\0', 100, 'ascii'); h.write('0000000\0', 108, 'ascii'); h.write('0000000\0', 116, 'ascii');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
    h.write('        ', 148, 'ascii'); // checksum placeholder
    h.write('0', 156, 'ascii');
    h.write('ustar\0' + '00', 257, 'ascii');
    let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return h;
  };
  let files = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const full = path.join(dir, f);
    const data = fs.readFileSync(full);
    blocks.push(header(`trothen-backup-${day}/${f}`, data.length, fs.statSync(full).mtimeMs), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
    files += 1;
  }
  blocks.push(Buffer.alloc(1024, 0));
  return { buffer: zlib.gzipSync(Buffer.concat(blocks)), files, filename: `trothen-backup-${day}.tar.gz` };
}

function backupsApply() { return !process.env.DATABASE_URL; }

module.exports = { runBackup, listBackups, backupsApply, buildBackupArchive, KEEP_DAYS };
