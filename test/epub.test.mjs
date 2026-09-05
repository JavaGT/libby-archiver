import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { zip, buildEpub } from '../src/epub.mjs';

/** Structural ZIP parse: walk the central directory, inflate each entry, verify offsets. */
function parseZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'missing end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'bad central directory signature');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, `bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(start, start + compSize);
    const data = method === 0 ? comp : zlib.inflateRawSync(comp);
    entries.push({ name, method, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('zip produces a structurally valid archive with stored mimetype first', () => {
  const entries = parseZip(
    zip([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'a/b.txt', data: 'hello & <world>' },
      { name: 'bin.dat', data: Buffer.from([0, 255, 1, 254]) },
    ]),
  );
  assert.equal(entries[0].name, 'mimetype');
  assert.equal(entries[0].method, 0); // stored, per the EPUB spec
  assert.equal(entries[0].data.toString(), 'application/epub+zip');
  assert.equal(entries[1].name, 'a/b.txt');
  assert.equal(entries[1].method, 8); // deflated
  assert.equal(entries[1].data.toString(), 'hello & <world>');
  assert.equal(entries[2].data.subarray(0, 4).readUInt32BE(0), 0x00ff01fe);
});

function sampleEpub({ fixedLayout = false, evilPath } = {}) {
  return buildEpub({
    meta: {
      identifier: 'test-id',
      title: 'Sample <Book> & More',
      creator: 'A. Author',
      language: 'en',
      description: 'desc with \u0007 control char',
    },
    spine: [
      { path: evilPath ?? 'pages/1.xhtml', body: '<svg viewBox="0 0 1 1"/>' },
      { path: 'pages/2.xhtml', body: '<p>hi</p>' },
    ],
    assets: [{ path: 'assets/a.jpg', data: Buffer.from([0xde, 0xad]) }],
    cover: { path: 'cover.jpg', data: Buffer.from([0xca, 0xfe]) },
    nav: [{ title: 'Chapter 1', href: 'pages/1.xhtml' }],
    fixedLayout,
  });
}

test('buildEpub assembles the expected EPUB 3 structure', () => {
  const entries = parseZip(sampleEpub());
  const names = entries.map((e) => e.name);
  assert.deepEqual(names.slice(0, 2), ['mimetype', 'META-INF/container.xml']);
  for (const expected of [
    'OEBPS/pages/1.xhtml',
    'OEBPS/pages/2.xhtml',
    'OEBPS/assets/a.jpg',
    'OEBPS/cover.jpg',
    'OEBPS/nav.xhtml',
    'OEBPS/toc.ncx',
    'OEBPS/content.opf',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
  const opf = entries.find((e) => e.name === 'OEBPS/content.opf').data.toString();
  assert.match(opf, /Sample &lt;Book&gt; &amp; More/); // XML-escaped
  assert.ok(!/[\u0000-\u0008]/.test(opf)); // control chars stripped
  const nav = entries.find((e) => e.name === 'OEBPS/nav.xhtml').data.toString();
  assert.match(nav, /href="pages\/1\.xhtml"/);
});

test('buildEpub marks fixed-layout books for pre-paginated rendition', () => {
  const opf = parseZip(sampleEpub({ fixedLayout: true })).find((e) => e.name === 'OEBPS/content.opf').data.toString();
  assert.match(opf, /<meta property="rendition:layout">pre-paginated<\/meta>/);
});

test('buildEpub refuses entry names that could escape OEBPS/', () => {
  assert.throws(() => sampleEpub({ evilPath: '../../evil.xhtml' }), /unsafe EPUB entry name/);
});
