// Trothen: turns one HEIC photo into plain pixels, off the main page so the
// screen doesn't freeze. The decoder is libheif (see LICENSE.txt), unchanged.
// Started fresh for each photo and shut down afterwards, so its memory is
// given back.
importScripts('libheif.js');
self.onmessage = async (ev) => {
  try {
    const wasmBinary = await (await fetch('libheif.wasm')).arrayBuffer();
    const lib = libheif({ wasmBinary });
    if (lib && lib.ready && typeof lib.ready.then === 'function') await lib.ready;
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(new Uint8Array(ev.data.buffer));
    if (!images || !images.length) throw new Error('No picture was found in this file');
    const img = images[0];
    const width = img.get_width(), height = img.get_height();
    if (!width || !height || width * height > 60e6) throw new Error('This photo is too large to convert');
    const out = new Uint8ClampedArray(width * height * 4);
    await new Promise((resolve, reject) => img.display({ data: out, width, height }, (d) => (d ? resolve() : reject(new Error('The photo could not be read')))));
    self.postMessage({ width, height, buffer: out.buffer }, [out.buffer]);
  } catch (e) {
    self.postMessage({ error: String((e && e.message) || e) });
  }
};
