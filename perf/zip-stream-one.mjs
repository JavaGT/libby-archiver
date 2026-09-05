// Isolated peak-memory comparison of the two zip output paths: sync zip() (whole archive
// resident ~2x: encoded payloads + final buffer) vs writeZip() (streams to disk, holding
// only the largest entry's payload). Mirrors perf/zip-one.mjs: one impl per fresh process
// so peak RSS is not polluted by the other impl's retained pages:
//   node --expose-gc perf/zip-stream-one.mjs zip       (or: writeZip)

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { syntheticEpub } from './gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const impl = process.argv[2] === 'writeZip' ? 'writeZip' : 'zip';
const epub = await import(path.resolve(here, '../src/epub.mjs'));

const entries = syntheticEpub();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-zip-stream-'));
try {
  globalThis.gc?.();
  globalThis.gc?.();
  const t0 = performance.now();
  let bytes;
  if (impl === 'zip') {
    bytes = epub.zip(entries).length;
  } else {
    ({ bytes } = await epub.writeZip(entries, path.join(dir, 'synthetic.epub')));
  }
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  globalThis.gc?.();
  console.log(JSON.stringify({
    impl,
    wallMs: ms,
    peakRssMB: Math.round(process.memoryUsage().rss / 1048576),
    bytes,
  }));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
