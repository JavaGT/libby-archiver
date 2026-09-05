// Assemble a decoded read-host title (pages + assets) into an EPUB 3, with a tiny
// dependency-free ZIP writer (the mimetype entry is stored first, uncompressed, per spec).
//
// Two output paths share one encoder: zip() / buildEpub() return the archive as a single
// Buffer; writeZip() / writeEpub() stream the identical bytes to disk, holding only the
// largest entry's payload in memory at a time. Entry payloads may also be thunks —
// () => Buffer — resolved only when that entry is encoded, so callers (archive-read) can
// back pages/assets with disk reads instead of holding the whole book resident.
//
// Fixed-layout (magazines / pre-paginated ebooks) get rendition:layout=pre-paginated and a
// per-page viewport so the SVG scans render at their true size; reflowable ebooks omit it.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// ---- minimal ZIP (store + deflate) --------------------------------------------
// Note: zlib.crc32 needs Node >= 20.15 (engines floor raised from >= 20).

/** Payloads that are already compressed — deflate gains nothing, so they are stored verbatim. */
const STORE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'mp3', 'mp4', 'm4a', 'pdf']);

const LOCAL_HDR_LEN = 30; // local file header
const CD_HDR_LEN = 46; // central directory record
const EOCD_LEN = 22; // end of central directory

/**
 * Resolve an entry payload. Payloads may be given eagerly (Buffer/string) or as a
 * zero-argument thunk returning the payload — thunks resolve exactly here, when the
 * entry is encoded (once per entry), so the entry list itself can stay payload-free.
 */
function resolveData(data) {
  const d = typeof data === 'function' ? data() : data;
  return Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8');
}

/** Encode one entry: utf8 name, native CRC, and the compressed payload (stored where useless). */
function encodeEntry(e) {
  const nameBuf = Buffer.from(e.name, 'utf8');
  const raw = resolveData(e.data);
  const store = e.store || raw.length === 0 || STORE_EXT.has(e.name.split('.').pop().toLowerCase());
  // level 6 over 9: ~2x faster, within ~2% on text (xhtml/opf/ncx) — deliberate tradeoff
  const comp = store ? raw : zlib.deflateRawSync(raw, { level: 6 });
  return { nameBuf, comp, method: store ? 0 : 8, crc: zlib.crc32(raw), rawLen: raw.length, compLen: comp.length, offset: 0 };
}

/** Assign each entry its archive offset; returns the data-section and directory sizes. */
function layout(parts) {
  let dataEnd = 0;
  let dirSize = 0;
  for (const p of parts) {
    p.offset = dataEnd;
    dataEnd += LOCAL_HDR_LEN + p.nameBuf.length + p.compLen; // local header + name + payload
    dirSize += CD_HDR_LEN + p.nameBuf.length; // central directory record + name
  }
  return { dataEnd, dirSize };
}

/** Local file header (30 bytes) written at `at`. */
function putLocalHeader(out, at, p) {
  out.writeUInt32LE(0x04034b50, at);
  out.writeUInt16LE(20, at + 4); // version needed
  out.writeUInt16LE(0, at + 6); // flags
  out.writeUInt16LE(p.method, at + 8);
  out.writeUInt16LE(0, at + 10); // mod time
  out.writeUInt16LE(0x21, at + 12); // mod date (arbitrary, valid)
  out.writeUInt32LE(p.crc, at + 14);
  out.writeUInt32LE(p.compLen, at + 18);
  out.writeUInt32LE(p.rawLen, at + 22);
  out.writeUInt16LE(p.nameBuf.length, at + 26);
  out.writeUInt16LE(0, at + 28); // extra len
}

/** Central directory record (46 bytes) written at `at`. */
function putCdRecord(out, at, p) {
  out.writeUInt32LE(0x02014b50, at);
  out.writeUInt16LE(20, at + 4); // version made by
  out.writeUInt16LE(20, at + 6); // version needed
  out.writeUInt16LE(0, at + 8); // flags
  out.writeUInt16LE(p.method, at + 10);
  out.writeUInt16LE(0, at + 12);
  out.writeUInt16LE(0x21, at + 14);
  out.writeUInt32LE(p.crc, at + 16);
  out.writeUInt32LE(p.compLen, at + 20);
  out.writeUInt32LE(p.rawLen, at + 24);
  out.writeUInt16LE(p.nameBuf.length, at + 28);
  out.writeUInt16LE(0, at + 30); // extra
  out.writeUInt16LE(0, at + 32); // comment
  out.writeUInt16LE(0, at + 34); // disk
  out.writeUInt16LE(0, at + 36); // internal attrs
  out.writeUInt32LE(0, at + 38); // external attrs
  out.writeUInt32LE(p.offset, at + 42);
}

/** End-of-central-directory record (22 bytes) written at `at`. */
function putEocd(out, at, count, dirSize, dirStart) {
  out.writeUInt32LE(0x06054b50, at);
  out.writeUInt16LE(0, at + 4); // this disk
  out.writeUInt16LE(0, at + 6); // disk with central directory
  out.writeUInt16LE(count, at + 8);
  out.writeUInt16LE(count, at + 10);
  out.writeUInt32LE(dirSize, at + 12);
  out.writeUInt32LE(dirStart, at + 16);
  out.writeUInt16LE(0, at + 20); // comment length
}

/**
 * @param {{name:string,data:Buffer|string|(()=>Buffer|string),store?:boolean}[]} entries
 * @returns {Buffer} the archive, assembled in one preallocated buffer
 */
export function zip(entries) {
  // Pass 1: encode each entry and measure the archive, so pass 2 can write into a single
  // buffer with no concat copy.
  const parts = entries.map(encodeEntry);
  const { dataEnd, dirSize } = layout(parts);

  // Pass 2: local headers + payloads, then the central directory, then the EOCD.
  // allocUnsafe is safe: every byte below is written exactly once.
  const out = Buffer.allocUnsafe(dataEnd + dirSize + EOCD_LEN);
  for (const p of parts) {
    putLocalHeader(out, p.offset, p);
    p.nameBuf.copy(out, p.offset + LOCAL_HDR_LEN);
    p.comp.copy(out, p.offset + LOCAL_HDR_LEN + p.nameBuf.length);
    p.comp = null; // large media payloads can be collected as soon as they are copied
  }

  let c = dataEnd;
  for (const p of parts) {
    putCdRecord(out, c, p);
    p.nameBuf.copy(out, c + CD_HDR_LEN);
    c += CD_HDR_LEN + p.nameBuf.length;
  }
  putEocd(out, c, parts.length, dirSize, dataEnd);
  return out;
}

/**
 * Yield the exact byte sequence zip() produces — header, name, payload per entry, then the
 * central directory + EOCD — so the archive can be streamed without ever holding the whole
 * thing (or two copies of it) in memory. Each encoded payload is released once consumed.
 * `entries` may be an array or any (async) iterable of {name, data, store?} objects, with
 * `data` eager (Buffer/string) or a thunk resolved once, at this entry's turn to encode.
 */
async function* zipChunks(entries) {
  const dir = []; // small per-entry metadata for the central directory
  let dataEnd = 0;
  let dirSize = 0;
  for await (const e of entries) {
    const p = encodeEntry(e);
    p.offset = dataEnd;
    dataEnd += LOCAL_HDR_LEN + p.nameBuf.length + p.compLen;
    dirSize += CD_HDR_LEN + p.nameBuf.length;
    const head = Buffer.allocUnsafe(LOCAL_HDR_LEN);
    putLocalHeader(head, 0, p);
    yield head;
    yield p.nameBuf;
    yield p.comp;
    p.comp = null; // payload handed to the consumer — the largest entry no longer stays resident
    dir.push(p);
  }
  for (const p of dir) {
    const rec = Buffer.allocUnsafe(CD_HDR_LEN);
    putCdRecord(rec, 0, p);
    yield rec;
    yield p.nameBuf;
  }
  const tail = Buffer.allocUnsafe(EOCD_LEN);
  putEocd(tail, 0, dir.length, dirSize, dataEnd);
  yield tail;
}

/**
 * Stream the same bytes zip() would return to `outPath`, capping memory at the largest
 * entry. Written to `outPath + '.part'` and renamed into place atomically on success
 * (mirrors util.writeFileAtomic); the .part is removed on any failure.
 * @param {Iterable|AsyncIterable} entries {name, data, store?} entries (async sources stream in)
 * @returns {Promise<{bytes:number}>} total archive size
 */
export async function writeZip(entries, outPath) {
  const partPath = `${outPath}.part`;
  let bytes = 0;
  try {
    await pipeline(
      async function* () {
        for await (const chunk of zipChunks(entries)) {
          bytes += chunk.length;
          yield chunk;
        }
      }(),
      fs.createWriteStream(partPath),
    );
    await fs.promises.rename(partPath, outPath);
  } catch (e) {
    await fs.promises.rm(partPath, { force: true }); // never leave a partial file behind
    throw e;
  }
  return { bytes };
}

// ---- EPUB assembly ------------------------------------------------------------

const xml = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // invalid in XML 1.0
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Entry names come from the openbook — refuse anything that could escape OEBPS/. */
const safeZipName = (name) => {
  const n = String(name);
  if (!n || n.startsWith('/') || n.split('/').includes('..')) {
    throw new Error(`unsafe EPUB entry name: ${name}`);
  }
  return n;
};

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml' };
const mimeOf = (name) => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

/** id-safe, unique-per-manifest token from a path. */
function idFor(p, used) {
  let base = 'i' + p.replace(/[^A-Za-z0-9]+/g, '_');
  let id = base;
  let n = 1;
  while (used.has(id)) id = `${base}_${n++}`;
  used.add(id);
  return id;
}

function wrapPage(body, { viewport } = {}) {
  const vp = viewport ? `\n  <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}"/>` : '';
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n` +
    `<head>\n  <meta charset="utf-8"/>\n  <title></title>${vp}\n` +
    `  <style>html,body{margin:0;padding:0}svg,img{display:block;max-width:100%}</style>\n` +
    `</head>\n${body}\n</html>\n`
  );
}

/** A spine page's decoded body as text: `{data}` (Buffer/string/thunk — the on-disk shape) or legacy eager `{body}`. */
function pageBodyOf(p) {
  if (p.data === undefined) return p.body;
  const d = typeof p.data === 'function' ? p.data() : p.data;
  return Buffer.isBuffer(d) ? d.toString('utf8') : String(d);
}

/**
 * Ordered EPUB entry list (mimetype first, container.xml, pages, assets, cover, nav.xhtml,
 * toc.ncx, content.opf) — the single source of truth for assembly, shared by buildEpub()
 * and writeEpub().
 * @param {object} book
 * @param {{title:string,subtitle?:string,creator?:string,language?:string,description?:string,identifier:string}} book.meta
 * @param {{path:string,body:string,viewport?:{width:number,height:number}}|{path:string,data:Buffer|string|(()=>Buffer|string),viewport?:{width:number,height:number}}} book.spine
 *     decoded pages — `{body}` eager text, or `{data}` eager/thunk payload (the archived on-disk shape)
 * @param {{path:string,data:Buffer|(()=>Buffer)}[]} book.assets
 * @param {{path:string,data:Buffer|(()=>Buffer)}|null} [book.cover]
 * @param {{title:string,href:string}[]} [book.nav]  TOC entries (href = a spine path)
 * @param {boolean} [book.fixedLayout]
 * @returns {{name:string,data:Buffer|string|(()=>Buffer|string),store?:boolean}[]}
 */
export function entriesFor(book) {
  const { meta, spine, assets = [], cover = null, nav = [], fixedLayout = false } = book;
  const used = new Set();
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const files = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
        `  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n` +
        `</container>\n`,
    },
  ];

  // page + asset manifest items (ids assigned in order)
  const pageItems = spine.map((p) => ({ id: idFor(p.path, used), href: p.path, part: p }));
  const assetItems = assets.map((a) => ({ id: idFor(a.path, used), href: a.path, data: a.data }));
  const coverItem = cover ? { id: idFor(cover.path, used), href: cover.path, data: cover.data } : null;

  // page XHTML files — the wrapped body is a thunk too, so disk-backed spine payloads
  // ({data: () => read}) resolve only when their entry is encoded
  for (const it of pageItems) {
    files.push({
      name: safeZipName(`OEBPS/${it.href}`),
      data: () => wrapPage(pageBodyOf(it.part), { viewport: it.part.viewport }),
    });
  }
  for (const it of assetItems) files.push({ name: safeZipName(`OEBPS/${it.href}`), data: it.data });
  if (coverItem) files.push({ name: safeZipName(`OEBPS/${coverItem.href}`), data: coverItem.data });

  // nav.xhtml (EPUB3). Map TOC hrefs to real spine pages; drop unresolved.
  const spinePaths = new Set(spine.map((p) => p.path));
  const navList = nav.filter((n) => spinePaths.has(n.href));
  const navBody = navList.length
    ? navList.map((n) => `      <li><a href="${xml(n.href)}">${xml(n.title)}</a></li>`).join('\n')
    : pageItems.map((it) => `      <li><a href="${xml(it.href)}">${xml(it.href)}</a></li>`).join('\n');
  files.push({
    name: 'OEBPS/nav.xhtml',
    data:
      `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n` +
      `<head><meta charset="utf-8"/><title>${xml(meta.title)}</title></head>\n<body>\n` +
      `  <nav epub:type="toc" id="toc">\n    <h1>${xml(meta.title)}</h1>\n    <ol>\n${navBody}\n    </ol>\n  </nav>\n` +
      `</body>\n</html>\n`,
  });

  // toc.ncx (EPUB2 fallback)
  const ncxPoints = (navList.length ? navList : pageItems.map((it) => ({ title: it.href, href: it.href })))
    .map(
      (n, i) =>
        `    <navPoint id="np${i}" playOrder="${i + 1}">\n      <navLabel><text>${xml(n.title)}</text></navLabel>\n      <content src="${xml(n.href)}"/>\n    </navPoint>`,
    )
    .join('\n');
  files.push({
    name: 'OEBPS/toc.ncx',
    data:
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n` +
      `  <head><meta name="dtb:uid" content="${xml(meta.identifier)}"/></head>\n` +
      `  <docTitle><text>${xml(meta.title)}</text></docTitle>\n  <navMap>\n${ncxPoints}\n  </navMap>\n</ncx>\n`,
  });

  // content.opf
  const dc = [
    `    <dc:identifier id="pub-id">${xml(meta.identifier)}</dc:identifier>`,
    `    <dc:title>${xml(meta.title)}${meta.subtitle ? ': ' + xml(meta.subtitle) : ''}</dc:title>`,
    `    <dc:language>${xml(meta.language || 'en')}</dc:language>`,
    meta.creator ? `    <dc:creator>${xml(meta.creator)}</dc:creator>` : '',
    meta.description ? `    <dc:description>${xml(meta.description)}</dc:description>` : '',
    `    <meta property="dcterms:modified">${modified}</meta>`,
    coverItem ? `    <meta name="cover" content="${coverItem.id}"/>` : '',
    fixedLayout ? `    <meta property="rendition:layout">pre-paginated</meta>` : '',
    fixedLayout ? `    <meta property="rendition:orientation">auto</meta>` : '',
    fixedLayout ? `    <meta property="rendition:spread">auto</meta>` : '',
  ].filter(Boolean);

  const manifest = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    coverItem
      ? `    <item id="${coverItem.id}" href="${xml(coverItem.href)}" media-type="${mimeOf(coverItem.href)}" properties="cover-image"/>`
      : '',
    ...pageItems.map(
      (it) => `    <item id="${it.id}" href="${xml(it.href)}" media-type="application/xhtml+xml"/>`,
    ),
    ...assetItems.map((it) => `    <item id="${it.id}" href="${xml(it.href)}" media-type="${mimeOf(it.href)}"/>`),
  ].filter(Boolean);

  const spineRefs = pageItems.map((it) => `    <itemref idref="${it.id}"/>`);

  files.push({
    name: 'OEBPS/content.opf',
    data:
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"` +
      ` prefix="rendition: http://www.idpf.org/vocab/rendition/#">\n` +
      `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n${dc.join('\n')}\n  </metadata>\n` +
      `  <manifest>\n${manifest.join('\n')}\n  </manifest>\n` +
      `  <spine toc="ncx">\n${spineRefs.join('\n')}\n  </spine>\n` +
      `</package>\n`,
  });

  return files;
}

/** @returns {Buffer} the .epub, assembled in memory */
export function buildEpub(book) {
  return zip(entriesFor(book));
}

/** Stream the .epub to `outPath` (see writeZip) instead of materializing it in memory. */
export function writeEpub(book, outPath) {
  return writeZip(entriesFor(book), outPath);
}
