// Shared by build.mjs (Node) and the zip-maker page (browser).
// build.mjs inlines this file into docs/index.html with `export` removed, so
// keep it dependency-free and limited to plain function declarations.

export const HOST_PLACEHOLDER = '__CANVAS_HOST__';

/**
 * Accepts a Canvas Calendar Feed link, any Canvas page link, or a bare
 * address ("canvas.myschool.edu") and returns just the hostname.
 * Throws an Error with a student-friendly message otherwise.
 */
export function parseCanvasHost(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('Paste your Calendar Feed link or type your Canvas address.');
  value = value.replace(/^webcals?:\/\//i, 'https://');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'https://' + value;
  let host;
  try {
    host = new URL(value).hostname;
  } catch (_e) {
    throw new Error('That does not look like a web address.');
  }
  host = host.toLowerCase().replace(/\.$/, '');
  const isHostname =
    host.length <= 253 &&
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
  if (!isHostname) {
    throw new Error('That does not look like a Canvas address (e.g. canvas.myschool.edu).');
  }
  return host;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP writer (stored entries, no compression). Files land at the zip
 * root, which is what Super Productivity's plugin upload expects.
 * @param {{name: string, text: string}[]} files
 * @returns {Uint8Array}
 */
export function createZip(files) {
  const enc = new TextEncoder();
  // Fixed timestamp (2026-01-01 00:00) so identical input gives identical zips.
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const data = enc.encode(file.text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/**
 * Puts the Canvas host into the plugin files and zips them.
 * @param {{name: string, text: string}[]} templateFiles
 */
export function buildPluginZip(templateFiles, host) {
  const files = templateFiles.map((f) => ({
    name: f.name,
    text: f.text.split(HOST_PLACEHOLDER).join(host),
  }));
  const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json').text);
  if (!manifest.allowedHosts || manifest.allowedHosts.join() !== host) {
    throw new Error('Could not set the Canvas address in the plugin.');
  }
  return createZip(files);
}
