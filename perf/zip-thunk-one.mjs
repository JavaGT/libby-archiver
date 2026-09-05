// Isolated peak-memory comparison of writeZip entry payloads: buffer entries (every
// payload resident in the entry list — the pre-W16 shape) vs disk-backed thunk entries
// (payloads read off disk one at a time as each entry is encoded — the W16 shape).
// Mirrors perf/zip-stream-one.mjs: one impl per fresh process so peak RSS is not polluted
// by the other impl's retained payloads.
//
// Fixture generation runs in its own process (`prepare`): generating payloads in the
// measuring process would set an RSS high-water of its own, masking the difference under
// test. Each impl then starts fresh and only reads the shared fixture dir:
//   node perf/zip-thunk-one.mjs prepare [<fixtureDir>]
//   node --expose-gc perf/zip-thunk-one.mjs buffer <fixtureDir>
//   node --expose-gc perf/zip-thunk-one.mjs thunk  <fixtureDir>
//
// peakRssMB is sampled after a forced gc at every entry boundary. This matters: freed
// payload buffers are only collected when V8 next feels pressure, and macOS never hands
// freed pages back to the OS — without the sampling, garbage accumulation during the run
// looks identical to residency and the comparison is meaningless. gc time is included in
// wallMs, so compare wallMs between the two impls here, but not with zip-stream-one.
//
// Default sizes match syntheticEpub() (120x6KB pages, 100x120KB jpegs, 250KB cover) so
// the buffer impl stays comparable with zip-stream-one's writeZip floor.

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { textPage, jpegish } from './gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? 'buffer'; // prepare | buffer | thunk
const epub = await import(path.resolve(here, '../src/epub.mjs'));

const PAGES = 120;
const PAGE_SIZE = 6 * 1024;
const ASSETS = 100;
const ASSET_SIZE = 120 * 1024;
const COVER_SIZE = 250 * 1024;

/** Write the synthetic book to `dir`, one generated payload in memory at a time. */
function prepare(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const put = (name, payload) => {
    const file = `p${n++}`;
    fs.writeFileSync(path.join(dir, file), payload);
    return { name, file };
  };
  const files = [{ name: 'mimetype', data: 'application/epub+zip', store: true }];
  for (let i = 0; i < PAGES; i++) files.push(put(`OEBPS/pages/${i + 1}.xhtml`, Buffer.from(textPage(PAGE_SIZE, i), 'utf8')));
  for (let i = 0; i < ASSETS; i++) files.push(put(`OEBPS/assets/urlHash-${i}.jpg`, jpegish(ASSET_SIZE)));
  files.push(put('OEBPS/cover.jpg', jpegish(COVER_SIZE)));
  fs.writeFileSync(path.join(dir, 'files.json'), JSON.stringify(files));
  return dir;
}

if (mode === 'prepare') {
  const dir = process.argv[3] ?? path.join(os.tmpdir(), 'libby-zip-thunk-fixture');
  prepare(dir);
  console.log(dir);
} else {
  const dir = process.argv[3];
  if (!dir || !fs.existsSync(path.join(dir, 'files.json'))) {
    throw new Error(`usage: zip-thunk-one.mjs prepare | (${mode} <fixtureDir printed by prepare>)`);
  }
  const files = JSON.parse(fs.readFileSync(path.join(dir, 'files.json'), 'utf8'));

  // the entry list under test: eager buffers (pre-W16) vs disk-backed thunks (W16)
  const entries = files.map((f) =>
    f.file
      ? mode === 'thunk'
        ? { name: f.name, data: () => fs.readFileSync(path.join(dir, f.file)) }
        : { name: f.name, data: fs.readFileSync(path.join(dir, f.file)) }
      : f, // mimetype: tiny string, identical in both impls
  );

  // gc + sample RSS at every entry boundary; the encoder consumes entries one at a time,
  // so each sample is the live set with the previous entry's payload already released
  let peakRss = 0;
  async function* sampled() {
    for (const e of entries) {
      globalThis.gc?.();
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      yield e;
    }
  }

  globalThis.gc?.();
  const t0 = performance.now();
  const { bytes } = await epub.writeZip(sampled(), path.join(dir, `synthetic-${mode}.epub`));
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  globalThis.gc?.();
  console.log(JSON.stringify({
    impl: mode,
    wallMs: ms,
    peakRssMB: Math.round(peakRss / 1048576),
    bytes,
  }));
}
