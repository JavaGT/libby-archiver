// Assemble a decoded read-host title (pages + assets) into an EPUB 3, with a tiny
// dependency-free ZIP writer (the mimetype entry is stored first, uncompressed, per spec).
//
// Fixed-layout (magazines / pre-paginated ebooks) get rendition:layout=pre-paginated and a
// per-page viewport so the SVG scans render at their true size; reflowable ebooks omit it.

import zlib from 'node:zlib';

// ---- minimal ZIP (store + deflate) --------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{name:string,data:Buffer,store?:boolean}[]} entries */
export function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const crc = crc32(raw);
    const store = e.store || raw.length === 0;
    const comp = store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const method = store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (arbitrary, valid)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---- EPUB assembly ------------------------------------------------------------

const xml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

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
    files.push({ name: `OEBPS/${it.href}`, data: wrapPage(it.part.body, { viewport: it.part.viewport }) });
  }
  for (const it of assetItems) files.push({ name: `OEBPS/${it.href}`, data: it.data });
  if (coverItem) files.push({ name: `OEBPS/${coverItem.href}`, data: coverItem.data });

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
