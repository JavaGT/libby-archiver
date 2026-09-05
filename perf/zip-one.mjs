// Isolated peak-memory + wall-time measurement for one zip implementation.
// Run in a fresh process (node --expose-gc) so RSS is not polluted by other sections:
//   node --expose-gc perf/zip-one.mjs baseline   (or: current)

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { syntheticEpub } from './gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const which = process.argv[2] === 'baseline' ? path.join(here, 'baseline/src/epub.mjs') : path.resolve(here, '../src/epub.mjs');
const { zip } = await import(which);

const entries = syntheticEpub();
globalThis.gc?.();
globalThis.gc?.();
const t0 = performance.now();
const out = zip(entries);
const ms = Math.round((performance.now() - t0) * 100) / 100;
globalThis.gc?.();
console.log(JSON.stringify({
  impl: which.includes('baseline') ? 'baseline' : 'current',
  outputBytes: out.length,
  crcCheck: out.readUInt32LE(14) !== 0,
  wallMs: ms,
  peakRssMB: Math.round(process.memoryUsage().rss / 1048576),
}));
