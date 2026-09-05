// EPUB integrity + tradeoff pins for the optimized zip writer (waves W1–W4).
//
// The optimization trades CPU for storage (store already-compressed media, deflate
// text at level 6 instead of 9). These tests notice if that trade drifts:
//   - unzip -t  : the writer stays spec-valid end-to-end (offsets, CRCs, EOCD)
//   - method pin: media stays STORED (the CPU win), text stays DEFLATED (the size win)
//   - crc pin   : stored entries still carry correct CRCs (integrity is not skipped)
//   - size pins : text still compresses hard, stored media adds no bloat
//   - streaming : writeZip emits byte-identical output and never leaves a .part behind

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { buildEpub, zip, entriesFor, writeZip, writeEpub } from '../src/epub.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'libby-epub-'));
const hasUnzip = () => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Parse local file headers: [{name, method, crc, compressedSize, uncompressedSize}] */
function localEntries(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break; // stop at central directory
    const method = buf.readUInt16LE(i + 8);
    const crc = buf.readUInt32LE(i + 14);
    const compressedSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    out.push({ name: buf.toString('utf8', i + 30, i + 30 + nameLen), method, crc, compressedSize });
    i += 30 + nameLen + extraLen + compressedSize;
  }
  return out;
}

const book = (overrides = {}) => ({
  meta: {
    identifier: 'urn:test:1',
    title: 'Perf Trial',
    creator: 'Tester',
    language: 'en',
  },
  spine: [
    { path: 'pages/1.xhtml', body: '<svg xmlns="http://www.w3.org/2000/svg"><image href="../assets/a.jpg"/></svg>' },
    { path: 'pages/2.xhtml', body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
  ],
  assets: [{ path: 'assets/a.jpg', data: Buffer.alloc(2048, 7) }],
  cover: null,
  nav: [{ title: 'One', href: 'pages/1.xhtml' }],
  fixedLayout: false,
  ...overrides,
});

test('buildEpub output passes unzip -t (spec-valid: offsets, CRCs, EOCD)', { skip: !hasUnzip() && 'unzip unavailable' }, () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'book.epub');
    fs.writeFileSync(file, buildEpub(book()));
    execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimetype is the first entry and stored uncompressed (spec requirement)', () => {
  // Callers (buildEpub) always list mimetype first; the writer must keep it there
  // and store it uncompressed — readers sniff it as the first bytes of the archive.
  const entries = localEntries(zip([{ name: 'mimetype', data: 'application/epub+zip', store: true }, { name: 'x.xhtml', data: 'hello' }]));
  const first = entries[0];
  assert.equal(first.name, 'mimetype');
  assert.equal(first.method, 0);
});

test('method pin: media payloads STORED (CPU win), text DEFLATED (size win)', () => {
  const media = Buffer.alloc(1024, 9);
  const out = zip([
    { name: 'OEBPS/assets/a.jpg', data: media },
    { name: 'OEBPS/assets/b.PNG', data: media },
    { name: 'OEBPS/assets/c.mp3', data: media },
    { name: 'OEBPS/assets/d.pdf', data: media },
    { name: 'OEBPS/pages/p.xhtml', data: '<p>'.repeat(500) },
    { name: 'OEBPS/content.opf', data: '<package>'.repeat(100) },
  ]);
  const byName = Object.fromEntries(localEntries(out).map((e) => [e.name, e]));
  for (const m of ['OEBPS/assets/a.jpg', 'OEBPS/assets/b.PNG', 'OEBPS/assets/c.mp3', 'OEBPS/assets/d.pdf']) {
    assert.equal(byName[m].method, 0, `${m} must be stored`);
  }
  for (const t of ['OEBPS/pages/p.xhtml', 'OEBPS/content.opf']) {
    assert.equal(byName[t].method, 8, `${t} must be deflated`);
  }
});

test('crc pin: stored entries still carry the correct CRC32 (integrity is not skipped)', () => {
  const raw = Buffer.alloc(4096, 3);
  const entry = localEntries(zip([{ name: 'OEBPS/assets/a.jpg', data: raw }]))[0];
  assert.equal(entry.crc, zlib.crc32(raw));
});

test('size pin: XHTML entries still compress to under 40% (deflate did not get skipped)', () => {
  const pages = Array.from({ length: 20 }, (_, i) => ({
    path: `pages/${i + 1}.xhtml`,
    body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1200">` + '<image href="../assets/x.jpg" width="800"/>'.repeat(30) + '</svg>',
  }));
  const epub = buildEpub(book({ spine: pages, assets: [] }));
  const textBytes = pages.reduce((a, p) => a + p.body.length, 0);
  assert.ok(epub.length < textBytes * 0.4, `epub ${epub.length} should be well under 40% of ${textBytes} text bytes`);
});

test('size pin: storing a media payload must not inflate the archive beyond raw + overhead', () => {
  const media = Buffer.alloc(100 * 1024, 5);
  const epub = zip([{ name: 'OEBPS/assets/a.jpg', data: media }]);
  assert.ok(epub.length <= media.length + 1024, `epub ${epub.length} vs raw ${media.length} — stored media must not grow`);
});

// ---- streaming writer (writeZip / writeEpub) ----------------------------------
// The streaming path shares its encoders with zip(); byte-identity is the pin that
// it can never silently diverge from the in-memory writer.

test('writeZip output is byte-identical to zip() (shared encoders — the strong pin)', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'book.epub');
    const { bytes } = await writeZip(entriesFor(book()), file);
    const streamed = fs.readFileSync(file);
    assert.equal(bytes, streamed.length, 'reported byte count must match the file');
    assert.ok(streamed.equals(buildEpub(book())), 'streamed bytes must equal the in-memory buffer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeEpub output passes unzip -t, mimetype first + stored', { skip: !hasUnzip() && 'unzip unavailable' }, async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'book.epub');
    await writeEpub(book(), file);
    execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
    const first = localEntries(fs.readFileSync(file))[0];
    assert.equal(first.name, 'mimetype');
    assert.equal(first.method, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeZip leaves no .part behind — after success and after a mid-write failure', async () => {
  const dir = tmp();
  try {
    const ok = path.join(dir, 'ok.epub');
    const { bytes } = await writeZip([{ name: 'a.xhtml', data: 'hi' }], ok);
    assert.equal(fs.existsSync(ok), true, 'renamed into place on success');
    assert.equal(fs.existsSync(`${ok}.part`), false);
    assert.equal(bytes, fs.statSync(ok).size);

    const bad = path.join(dir, 'bad.epub');
    const flaky = async function* () {
      yield { name: 'a.xhtml', data: 'first' };
      throw new Error('injected mid-write failure');
    };
    await assert.rejects(() => writeZip(flaky(), bad), /injected mid-write failure/);
    assert.equal(fs.existsSync(bad), false, 'no partial archive left at the target path');
    assert.equal(fs.existsSync(`${bad}.part`), false, '.part removed on failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
