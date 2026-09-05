// Assemble a decoded read-host title (pages + assets) into an EPUB 3, with a tiny
// dependency-free ZIP writer (the mimetype entry is stored first, uncompressed, per spec).
//
// Fixed-layout (magazines / pre-paginated ebooks) get rendition:layout=pre-paginated and a
// per-page viewport so the SVG scans render at their true size; reflowable ebooks omit it.

import zlib from 'node:zlib';

// ---- minimal ZIP (store + deflate) --------------------------------------------
// Note: zlib.crc32 needs Node >= 20.15 (engines floor raised from >= 20).

/** Payloads that are already compressed — deflate gains nothing, so they are stored verbatim. */
const STORE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'mp3', 'mp4', 'm4a', 'pdf']);

/**
 * @param {{name:string,data:Buffer|string,store?:boolean}[]} entries
 * @returns {Buffer} the archive, assembled in one preallocated buffer
 */
export function zip(entries) {
  // Pass 1: encode each entry (native CRC + deflate at level 6; stored where useless) and
  // measure the archive, so pass 2 can write into a single buffer with no concat copy.
  const parts = entries.map((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const store = e.store || raw.length === 0 || STORE_EXT.has(e.name.split('.').pop().toLowerCase());
    // level 6 over 9: ~2x faster, within ~2% on text (xhtml/opf/ncx) — deliberate tradeoff
    const comp = store ? raw : zlib.deflateRawSync(raw, { level: 6 });
    return { nameBuf, comp, method: store ? 0 : 8, crc: zlib.crc32(raw), rawLen: raw.length, compLen: comp.length, offset: 0 };
  });

  let dataEnd = 0;
  let dirSize = 0;
  for (const p of parts) {
    p.offset = dataEnd;
    dataEnd += 30 + p.nameBuf.length + p.comp.length; // local header + name + payload
    dirSize += 46 + p.nameBuf.length; // central directory record + name
  }

  // Pass 2: local headers + payloads, then the central directory, then the EOCD.
  // allocUnsafe is safe: every byte below is written exactly once.
  const out = Buffer.allocUnsafe(dataEnd + dirSize + 22);
  for (const p of parts) {
    const at = p.offset;
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
    p.nameBuf.copy(out, at + 30);
    p.comp.copy(out, at + 30 + p.nameBuf.length);
    p.comp = null; // large media payloads can be collected as soon as they are copied
  }

  let c = dataEnd;
  for (const p of parts) {
    out.writeUInt32LE(0x02014b50, c);
    out.writeUInt16LE(20, c + 4); // version made by
    out.writeUInt16LE(20, c + 6); // version needed
    out.writeUInt16LE(0, c + 8); // flags
    out.writeUInt16LE(p.method, c + 10);
    out.writeUInt16LE(0, c + 12);
    out.writeUInt16LE(0x21, c + 14);
    out.writeUInt32LE(p.crc, c + 16);
    out.writeUInt32LE(p.compLen, c + 20);
    out.writeUInt32LE(p.rawLen, c + 24);
    out.writeUInt16LE(p.nameBuf.length, c + 28);
    out.writeUInt16LE(0, c + 30); // extra
    out.writeUInt16LE(0, c + 32); // comment
    out.writeUInt16LE(0, c + 34); // disk
    out.writeUInt16LE(0, c + 36); // internal attrs
    out.writeUInt32LE(0, c + 38); // external attrs
    out.writeUInt32LE(p.offset, c + 42);
    p.nameBuf.copy(out, c + 46);
    c += 46 + p.nameBuf.length;
  }

  out.writeUInt32LE(0x06054b50, c);
  out.writeUInt16LE(entries.length, c + 8);
  out.writeUInt16LE(entries.length, c + 10);
  out.writeUInt32LE(dirSize, c + 12);
  out.writeUInt32LE(dataEnd, c + 16);
  return out;
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

/**
 * @param {object} book
 * @param {{title:string,subtitle?:string,creator?:string,language?:string,description?:string,identifier:string}} book.meta
 * @param {{path:string,body:string,viewport?:{width:number,height:number}}[]} book.spine  decoded page bodies
 * @param {{path:string,data:Buffer}[]} book.assets
 * @param {{path:string,data:Buffer}|null} [book.cover]
 * @param {{title:string,href:string}[]} [book.nav]  TOC entries (href = a spine path)
 * @param {boolean} [book.fixedLayout]
 * @returns {Buffer} the .epub
 */
export function buildEpub(book) {
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

  // page XHTML files
  for (const it of pageItems) {
    files.push({ name: safeZipName(`OEBPS/${it.href}`), data: wrapPage(it.part.body, { viewport: it.part.viewport }) });
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

  return zip(files);
}
