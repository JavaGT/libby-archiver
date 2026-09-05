import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  sanitize,
  decodeEntities,
  cleanHtml,
  assetName,
  safeJoin,
  writeManifest,
  claimBookDir,
} from '../src/util.mjs';

test('decodeEntities decodes in one pass — no double decoding', () => {
  assert.equal(decodeEntities('&amp;lt;'), '&lt;'); // regression: was decoded twice
  assert.equal(decodeEntities('&amp;'), '&');
  assert.equal(decodeEntities('&lt;tag&gt; &amp; &quot;stuff&quot; &apos;'), `<tag> & "stuff" '`);
  assert.equal(decodeEntities('&#9829; &#x2665;'), '♥ ♥');
  assert.equal(decodeEntities('&bogus;'), '&bogus;'); // unknown entities preserved
  assert.equal(decodeEntities(42), 42); // non-strings pass through
});

test('sanitize strips path-hostile characters and caps length', () => {
  assert.equal(sanitize('A/B\\C:D?E*F"G<H>I|'), 'ABCDEFGHI');
  assert.equal(sanitize('  lots   of    spaces  '), 'lots of spaces');
  assert.equal(sanitize('x'.repeat(200)), 'x'.repeat(150));
  assert.equal(sanitize(''), 'Untitled');
  assert.equal(sanitize(null), 'Untitled');
});

test('assetName keeps the last segment and rejects traversal', () => {
  assert.equal(assetName('assets/foo/bar.jpg'), 'bar.jpg');
  assert.equal(assetName('x.jpg'), 'x.jpg');
  assert.throws(() => assetName('assets/..'), /unsafe asset reference/);
  assert.throws(() => assetName(''), /unsafe asset reference/);
});

test('safeJoin refuses paths that escape the base directory', () => {
  const base = '/tmp/archive/Some Book';
  assert.equal(safeJoin(base, 'pages/1.xhtml'), path.resolve(base, 'pages/1.xhtml'));
  assert.throws(() => safeJoin(base, '../evil.xhtml'), /escapes the archive folder/);
  assert.throws(() => safeJoin(base, 'a/../../evil'), /escapes the archive folder/);
  assert.throws(() => safeJoin(base, '/etc/passwd'), /unsafe path/);
  assert.throws(() => safeJoin(base, 'C:\\evil'), /unsafe path/);
  assert.throws(() => safeJoin(base, ''), /unsafe path/);
});

test('writeManifest hashes everything except itself and .part temp files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-manifest-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'aaa');
    fs.writeFileSync(path.join(dir, 'junk.mp3.part'), 'partial garbage');
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.writeFileSync(path.join(dir, 'pages', '1.xhtml'), '<p/>');

    await writeManifest(dir);

    const lines = fs.readFileSync(path.join(dir, 'manifest.sha256'), 'utf8').trim().split('\n');
    assert.deepEqual(
      lines.map((l) => l.split('  ')[1]),
      ['a.mp3', 'pages/1.xhtml'],
    );
    const [hash] = lines[0].split('  ');
    assert.equal(hash, crypto.createHash('sha256').update('aaa').digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeManifest output is byte-identical when hashing concurrently', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-manifest2-'));
  try {
    // >8 files (worker pool engages), a nested dir, a >1 MiB file (spans several
    // highWaterMark reads), and files that must be excluded.
    const big = Buffer.alloc(2.5 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff; // deterministic content
    fs.writeFileSync(path.join(dir, 'big.bin'), big);
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.mkdirSync(path.join(dir, 'pages', 'sub'));
    fs.writeFileSync(path.join(dir, 'pages', '9.xhtml'), '<p>nine</p>');
    fs.writeFileSync(path.join(dir, 'pages', '1.xhtml'), '<p>one</p>');
    fs.writeFileSync(path.join(dir, 'pages', 'sub', 'n.dat'), Buffer.from([0, 1, 2, 255]));
    for (const n of ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3', 'f.mp3', 'g.mp3', 'h.mp3', 'i.mp3']) {
      fs.writeFileSync(path.join(dir, n), `payload-${n}`);
    }
    fs.writeFileSync(path.join(dir, 'junk.mp3.part'), 'partial garbage');

    await writeManifest(dir);

    // Expected built independently: depth-first walk, per-directory lexicographic order.
    const entries = [
      ['a.mp3', 'payload-a.mp3'],
      ['b.mp3', 'payload-b.mp3'],
      ['big.bin', big],
      ['c.mp3', 'payload-c.mp3'],
      ['d.mp3', 'payload-d.mp3'],
      ['e.mp3', 'payload-e.mp3'],
      ['f.mp3', 'payload-f.mp3'],
      ['g.mp3', 'payload-g.mp3'],
      ['h.mp3', 'payload-h.mp3'],
      ['i.mp3', 'payload-i.mp3'],
      ['pages/1.xhtml', '<p>one</p>'],
      ['pages/9.xhtml', '<p>nine</p>'],
      ['pages/sub/n.dat', Buffer.from([0, 1, 2, 255])],
    ];
    const expected =
      entries
        .map(([r, content]) => `${crypto.createHash('sha256').update(content).digest('hex')}  ${r}`)
        .join('\n') + '\n';
    assert.equal(fs.readFileSync(path.join(dir, 'manifest.sha256'), 'utf8'), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claimBookDir resumes the same loan folder but separates colliding loans', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-claim-'));
  try {
    const loanA = { id: '111', author: 'Frank Herbert', title: 'Dune' };
    const loanB = { id: '222', author: 'Frank Herbert', title: 'Dune' };

    const first = claimBookDir(out, loanA);
    assert.equal(path.basename(first.bookDir), 'Frank Herbert - Dune');

    // Same loan again -> same folder (resume).
    assert.equal(claimBookDir(out, loanA).bookDir, first.bookDir);

    // Different loan, same name -> suffixed folder, original untouched.
    const second = claimBookDir(out, loanB);
    assert.equal(path.basename(second.bookDir), 'Frank Herbert - Dune [222]');

    // Legacy folder without a marker but with metadata.json is adopted by its owner.
    const legacyDir = path.join(out, 'Legacy Author - Legacy Title');
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, 'metadata.json'), JSON.stringify({ titleId: '333' }));
    assert.equal(claimBookDir(out, { id: '333', author: 'Legacy Author', title: 'Legacy Title' }).bookDir, legacyDir);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
