// v82: optional extra encryption for stored ID files.
//
// When ID_FILE_ENCRYPTION_KEY is set on the server (64 hex characters, made
// once and kept safe), every ID photo, back-of-ID and face photo is
// scrambled with AES-256-GCM before it rests on the disk, and unscrambled
// only at the moment a reviewer opens it. A copy of the disk on its own is
// then unreadable.
//
// When the key is NOT set, nothing changes: files are stored as before.
// Files stored before the key was set stay as they were and still open.
//
// THE KEY MATTERS. If it is lost or changed, every file encrypted with it
// is gone for good. Keep a copy somewhere safe that isn't Render.
const fs = require('fs');
const crypto = require('crypto');

function getKey() {
  const hex = (process.env.ID_FILE_ENCRYPTION_KEY || '').trim();
  if (!hex) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    console.error('[file-crypto] ID_FILE_ENCRYPTION_KEY is set but is not 64 hex characters. ID files are NOT being encrypted.');
    return null;
  }
  return Buffer.from(hex, 'hex');
}
function isEnabled() { return !!getKey(); }

const MAGIC = Buffer.from('TRENC1'); // marks a file this module encrypted

// Replaces the file's contents with: MAGIC | 12-byte iv | 16-byte tag | ciphertext
function encryptFileInPlace(filePath) {
  const key = getKey();
  if (!key) return false;
  const plain = fs.readFileSync(filePath);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const tmp = filePath + '.enc-tmp';
  fs.writeFileSync(tmp, Buffer.concat([MAGIC, iv, tag, enc]));
  fs.renameSync(tmp, filePath);
  return true;
}

// Returns the readable bytes, whether or not the file was encrypted.
// Throws a plain-language error if it was encrypted and can't be opened.
function readPossiblyEncrypted(filePath) {
  const raw = fs.readFileSync(filePath);
  if (raw.length < MAGIC.length + 28 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return raw;
  const key = getKey();
  if (!key) throw new Error('This file is encrypted and the server has no ID_FILE_ENCRYPTION_KEY set, so it can\'t be opened.');
  const iv = raw.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = raw.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(raw.subarray(MAGIC.length + 28)), decipher.final()]); }
  catch (e) { throw new Error('This file can\'t be opened with the current ID_FILE_ENCRYPTION_KEY. The key may have been changed.'); }
}

module.exports = { isEnabled, encryptFileInPlace, readPossiblyEncrypted };
