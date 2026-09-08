// Manifest pre-hash measurement (T2-W2C sub-task 2): archiveReadable writes every
// page body and asset to disk, then writeManifest re-reads + re-hashes all of them.
// Feeding writeManifest's `known` map with digests computed at write time should
// collapse the manifest pass to the small sidecars. This bench builds a synthetic
// bookDir (120 pages × 6 KB + 100 assets × 150 KB ≈ 15.7 MB, like a small
// magazine), then times writeManifest with vs without `known`.
//
// Honesty caveats, by construction:
//   - The fixture files were JUST written, so they are warm in the page cache —
//     the measured win is the syscall/open/stream cost of re-reading, not disk IO.
//   - The hashing work itself is not saved, only moved: inline digest computation
//     is timed here separately as `knownHashMs`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeManifest } from '../src/util.mjs';

const PAGES = 120, PAGE_BYTES = 6 * 1024;
const ASSETS = 100, ASSET_BYTES = 150 * 1024;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-manbench-'));
const pagesDir = path.join(dir, 'pages');
const assetsDir = path.join(dir, 'assets');
fs.mkdirSync(pagesDir);
fs.mkdirSync(assetsDir);

// Build the fixture exactly the way finishReadable writes it: page bodies as utf8
// strings, asset bodies as Buffers — collecting the digests it could feed `known`.
const body = 'x'.repeat(PAGE_BYTES);
const pageTexts = [];
for (let i = 1; i <= PAGES; i++) {
  const text = `<?xml version="1.0"?><html><body>page ${i} ${body}</body></html>`;
  fs.writeFileSync(path.join(pagesDir, `page-${String(i).padStart(3, '0')}.xhtml`), text, 'utf8');
  pageTexts.push([`pages/page-${String(i).padStart(3, '0')}.xhtml`, text]);
}
const assetBufs = [];
for (let i = 0; i < ASSETS; i++) {
  const buf = crypto.randomBytes(ASSET_BYTES);
  fs.writeFileSync(path.join(assetsDir, `asset-${String(i).padStart(3, '0')}.jpg`), buf);
  assetBufs.push([`assets/asset-${String(i).padStart(3, '0')}.jpg`, buf]);
}

const totalBytes = PAGES * PAGE_BYTES + ASSETS * ASSET_BYTES;
const known = {};
let knownHashMs;
{
  const t = performance.now();
  const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
  for (const [rel, text] of pageTexts) known[rel] = sha(text); // utf8 — matches the file bytes
  for (const [rel, buf] of assetBufs) known[rel] = sha(buf);
  knownHashMs = +(performance.now() - t).toFixed(1);
}

await writeManifest(dir); // warm-up (also primes the manifest exclusion path)

const noKnown = [];
const withKnown = [];
for (let r = 0; r < 5; r++) {
  let t = performance.now();
  await writeManifest(dir);
  noKnown.push(performance.now() - t);
  t = performance.now();
  await writeManifest(dir, { known });
  withKnown.push(performance.now() - t);
}
fs.rmSync(dir, { recursive: true, force: true });

const med = (xs) => Math.round([...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1]);
const noMs = med(noKnown);
const knownMs = med(withKnown);
console.log(JSON.stringify({
  bench: 'writeManifest re-read vs pre-hashed known map',
  fixture: `${PAGES} pages × ${(PAGE_BYTES / 1024) | 0} KB + ${ASSETS} assets × ${ASSET_BYTES / 1024 | 0} KB = ${(totalBytes / 1e6).toFixed(1)} MB, ${PAGES + ASSETS + 2} files`,
  manifestReReadMs: noMs,
  manifestWithKnownMs: knownMs,
  savedMs: noMs - knownMs,
  knownHashMsMovedIntoDownloadPhase: knownHashMs,
  runs: { reReadMs: noKnown.map(Math.round), withKnownMs: withKnown.map(Math.round) },
}, null, 2));
