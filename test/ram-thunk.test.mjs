// W16 RAM wave: entry payloads may be thunks (() => payload), resolved exactly when that
// entry is encoded, so archive-read can re-read pages/assets off disk instead of holding
// the whole decoded book resident while the EPUB is assembled. Pins:
//   - byte identity : thunk entries encode to the exact bytes of buffer entries (both writers)
//   - laziness      : a thunk runs exactly once per entry, only when the archive is encoded
//   - compat        : buffer/string entries and eager `{body}` pages keep working unchanged
//                     (test/epub.test.mjs, test/epub-integrity.test.mjs cover those paths)
//   - loud failure  : a thunk that throws (e.g. its payload file vanished) fails the write
//                     and leaves no .part behind — a missing payload must never ship silently

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zip, buildEpub, entriesFor, writeZip } from '../src/epub.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'libby-thunk-'));

/** One incompressible pseudo-random payload, shared by the buffer and thunk variants. */
const media = () => {
  const b = Buffer.alloc(4096);
  for (let i = 0; i < b.length; i++) b[i] = (i * 2654435761) >>> 24; // Knuth hash bits
  return b;
};

const payload = () => ({ text: '<p>hello & <world></p>\n', media: media() });

/** Same bytes twice: once eager, once behind thunks (stored media + deflated text). */
const entriesForPayload = (p, thunk) => [
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  thunk
    ? { name: 'OEBPS/p.xhtml', data: () => Buffer.from(p.text, 'utf8') }
    : { name: 'OEBPS/p.xhtml', data: Buffer.from(p.text, 'utf8') },
  thunk ? { name: 'OEBPS/a.jpg', data: () => p.media } : { name: 'OEBPS/a.jpg', data: p.media },
];

test('thunk entries encode byte-identically to buffer entries (zip and writeZip)', async () => {
  const eager = zip(entriesForPayload(payload(), false));
  assert.ok(eager.equals(zip(entriesForPayload(payload(), true))), 'zip(): thunk bytes == buffer bytes');

  const dir = tmp();
  try {
    const file = path.join(dir, 'thunk.epub');
    const { bytes } = await writeZip(entriesForPayload(payload(), true), file);
    const streamed = fs.readFileSync(file);
    assert.equal(bytes, eager.length);
    assert.ok(streamed.equals(eager), 'writeZip(): thunk bytes == zip() buffer bytes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('thunks are lazy: invoked exactly once per entry, only when encoding', async () => {
  const calls = [];
  const tracked = (name, data) => ({
    name,
    data: () => {
      calls.push(name);
      return data;
    },
  });
  const entries = [
    tracked('a.xhtml', '<p>aaa</p>'),
    tracked('b.xhtml', '<p>bbb</p>'),
    tracked('c.jpg', media()),
  ];
  assert.equal(calls.length, 0, 'building the entry list must not resolve anything');

  zip(entries);
  assert.deepEqual(calls.sort(), ['a.xhtml', 'b.xhtml', 'c.jpg'], 'zip() resolves each entry exactly once');

  calls.length = 0;
  const dir = tmp();
  try {
    await writeZip(entries, path.join(dir, 'out.epub'));
    assert.equal(calls.length, 3, 'writeZip() also resolves each entry exactly once (at its turn)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('entriesFor accepts disk-backed spine pages ({data: thunk}) with `{body}`-identical output', () => {
  const book = (spine) => ({
    meta: { identifier: 'urn:t', title: 'Thunk Book', language: 'en' },
    spine,
    assets: [],
    cover: null,
    fixedLayout: false,
  });
  const eager = buildEpub(book([{ path: 'pages/1.xhtml', body: '<svg>one</svg>', viewport: { width: 800, height: 1200 } }]));
  const lazy = buildEpub(book([{ path: 'pages/1.xhtml', data: () => Buffer.from('<svg>one</svg>'), viewport: { width: 800, height: 1200 } }]));
  assert.ok(eager.equals(lazy), 'spine {data: thunk} pages must encode exactly like {body} pages');

  // and the produced page entries are themselves lazy (safe to hold; nothing read yet)
  const entries = entriesFor(book([{ path: 'pages/1.xhtml', data: () => Buffer.from('x') }]));
  assert.equal(typeof entries.find((e) => e.name === 'OEBPS/pages/1.xhtml').data, 'function');
});

test('a throwing thunk (payload file vanished) fails the write loudly, leaving no .part', async () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'gone.epub');
    const vanished = () => {
      throw new Error('ENOENT: payload file vanished between write and read');
    };
    await assert.rejects(
      () => writeZip([{ name: 'OEBPS/p.xhtml', data: vanished }], out),
      /payload file vanished/,
    );
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(`${out}.part`), false, 'the partial archive is cleaned up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
