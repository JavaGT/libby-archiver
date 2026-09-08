// T2 RAM-wave bench: big-fixture measurements in fresh processes, one impl per
// process so peak RSS is never polluted by fixture generation or another impl
// (same discipline as perf/zip-thunk-one.mjs).
//
//   node perf/ram-big-one.mjs baseline
//       Node's startup floor RSS in this process shape (the constant under every number).
//
//   node --expose-gc perf/ram-big-one.mjs prepare <dir>
//       Write the big-magazine fixture (perf/gen.mjs bigMagazine: 300x6KB pages +
//       260x160KB jpeg-ish assets + 250KB cover ~= 46 MB) to disk ONE payload at a
//       time, in the on-disk shape archive-read produces (pages/, assets/, cover.jpg).
//
//   node --expose-gc perf/ram-big-one.mjs epub <dir> [thunk|eager]
//       Assemble dir/big.epub via writeEpub's exact code path (entriesFor -> writeZip)
//       with disk-backed thunks (what archive-read.mjs does) or eager buffers (the
//       pre-W16 shape, for contrast). RSS is sampled after a forced gc at every entry
//       boundary; gc time is included in wallMs. Theory floor = baseline RSS + largest
//       entry payload + one deflate output (+ entry list).
//
//   node perf/ram-big-one.mjs manifest-prep <dir> <totalMB> [force]
//       Write a realistic archive tree (perf/gen.mjs manifestTree: ~60% 150KB assets,
//       ~25% 5MB parts, ~15% 6KB pages) for the writeManifest sizing bench. Skipped if
//       the marker file matches unless `force`.
//
//   node perf/ram-big-one.mjs manifest <dir> [reps]
//       Time writeManifest's exact algorithm (bench-local parameterized copy, first
//       validated byte-identical against src/util.mjs writeManifest on this tree) at
//       hwm 1 MiB vs 4 MiB x 8 vs 16 workers, reps round-robin per config after one
//       warmup pass (warm page cache; disk-cold numbers would need root purge).
//       Also reports the sync floor (readFileSync + hash, single-threaded): if async
//       passes land on the floor, SHA-on-main-thread is the bound and pool/hwm knobs
//       cannot help — the finding to record. All configs must agree byte-for-byte.

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { bigMagazine, manifestTree, textPage } from './gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [mode, dirArg, arg3] = process.argv.slice(2);
const epub = await import(path.resolve(here, '../src/epub.mjs'));
const util = await import(path.resolve(here, '../src/util.mjs'));

const log = (o) => console.log(JSON.stringify(o));

if (mode === 'baseline') {
  globalThis.gc?.();
  log({ mode, baselineRssMB: Math.round(process.memoryUsage().rss / 1048576) });
} else if (mode === 'prepare') {
  if (!dirArg) throw new Error('usage: ram-big-one.mjs prepare <dir>');
  fs.rmSync(dirArg, { recursive: true, force: true });
  fs.mkdirSync(path.join(dirArg, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(dirArg, 'assets'), { recursive: true });
  let loose = 0;
  let n = 0;
  for (const e of bigMagazine()) {
    fs.writeFileSync(path.join(dirArg, e.name), e.data);
    loose += e.data.length;
    n++;
  }
  fs.writeFileSync(path.join(dirArg, 'book.json'), JSON.stringify({ entries: n, looseBytes: loose }));
  log({ mode, dir: dirArg, entries: n, looseMB: Math.round(loose / 1048576) });
} else if (mode === 'epub') {
  if (!dirArg || !fs.existsSync(path.join(dirArg, 'book.json'))) {
    throw new Error('usage: ram-big-one.mjs epub <dir printed by prepare> [thunk|eager|floor] [probe]');
  }
  const impl = arg3 ?? 'thunk';
  const rels = fs
    .readdirSync(path.join(dirArg, 'pages'), { recursive: false })
    .sort()
    .map((f) => `pages/${f}`);
  const assetRels = fs
    .readdirSync(path.join(dirArg, 'assets'))
    .sort()
    .map((f) => `assets/${f}`);
  const fileOf = (rel) => path.join(dirArg, rel);
  const payload = (rel) => (impl === 'thunk' ? () => fs.readFileSync(fileOf(rel)) : fs.readFileSync(fileOf(rel)));

  if (impl === 'floor') throw new Error('floor is its own mode: ram-big-one.mjs floor <dir>');

  // book shaped exactly like archive-read.mjs step 6 (spine pages keep their paths,
  // fixed-layout viewports, disk-backed payload thunks)
  const book = {
    meta: { identifier: 'bench-big', title: 'Bench Big Magazine', language: 'en' },
    spine: rels.map((rel) => ({ path: rel, viewport: { width: 800, height: 1200 }, data: payload(rel) })),
    assets: assetRels.map((rel) => ({ path: rel, data: payload(rel) })),
    cover: { path: 'cover.jpg', data: payload('cover.jpg') },
    nav: rels.slice(0, 50).map((rel) => ({ title: `Page ${rel}`, href: rel })),
    fixedLayout: true,
  };

  let loose = 0;
  for (const rel of [...rels, ...assetRels, 'cover.jpg']) loose += fs.statSync(fileOf(rel)).size;

  // gc + sample RSS at every entry boundary — the encoder consumes one entry at a
  // time, so each sample is the live set with the previous entry's payload released.
  // `probe` arg: no forced gc (raw V8 high-water) + record which entry sets the peak
  // + a sparse RSS trace, to attribute any overhead above the theory floor.
  const probe = process.argv.includes('probe');
  let peakRss = 0;
  let peakName = '';
  const trace = [];
  let i = 0;
  async function* sampled(entries) {
    for (const e of entries) {
      if (!probe) globalThis.gc?.();
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) {
        peakRss = rss;
        peakName = e.name;
      }
      if (probe && i % 16 === 0) trace.push(Math.round(rss / 1048576));
      i++;
      yield e;
    }
  }

  globalThis.gc?.();
  const t0 = performance.now();
  const { bytes, sha256 } = await epub.writeZip(sampled(epub.entriesFor(book)), path.join(dirArg, 'big.epub'));
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  globalThis.gc?.();
  log({ mode, impl, wallMs: ms, peakRssMB: Math.round(peakRss / 1048576), peakName, bytes, looseBytes: loose, entries: rels.length + assetRels.length + 3, sha256, ...(probe ? { traceMB: trace } : {}) });
} else if (mode === 'floor') {
  // theory floor in the SAME process shape: an entry list of thunks, resolve one
  // payload at a time, hash + write it — no entriesFor wrapping, no zlib, no zip
  // headers. The floor writeZip's big-fixture RSS is judged against.
  if (!dirArg) throw new Error('usage: ram-big-one.mjs floor <dir>');
  const all = [
    ...fs.readdirSync(path.join(dirArg, 'pages')).sort().map((f) => `pages/${f}`),
    ...fs.readdirSync(path.join(dirArg, 'assets')).sort().map((f) => `assets/${f}`),
    'cover.jpg',
  ];
  let looseFloor = 0;
  for (const rel of all) looseFloor += fs.statSync(path.join(dirArg, rel)).size;
  let peak = 0;
  globalThis.gc?.();
  const t0 = performance.now();
  const hash = crypto.createHash('sha256');
  await fs.promises.writeFile(
    path.join(dirArg, 'floor.epub'),
    async function* () {
      for (const rel of all) {
        globalThis.gc?.();
        peak = Math.max(peak, process.memoryUsage().rss);
        const buf = fs.readFileSync(path.join(dirArg, rel));
        hash.update(buf);
        yield buf;
      }
    }(),
  );
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  log({ mode, impl: 'floor', wallMs: ms, peakRssMB: Math.round(peak / 1048576), bytes: looseFloor, looseBytes: looseFloor, entries: all.length, sha256: hash.digest('hex') });
} else if (mode === 'manifest-prep') {
  if (!dirArg || !arg3) throw new Error('usage: ram-big-one.mjs manifest-prep <dir> <totalMB> [force]');
  const totalMB = Number(arg3);
  const marker = path.join(dirArg, `.prepared-${totalMB}mb`);
  if (!process.argv.includes('force') && fs.existsSync(marker)) {
    log({ mode, dir: dirArg, totalMB, skipped: true });
    process.exit(0);
  }
  fs.rmSync(dirArg, { recursive: true, force: true });
  fs.mkdirSync(path.join(dirArg, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(dirArg, 'assets'), { recursive: true });
  const spec = manifestTree(totalMB);
  let written = 0;
  for (const { rel, bytes } of spec) {
    // compressible pages (textPage ~n bytes), incompressible binaries (random bytes)
    const data = rel.endsWith('.xhtml') ? Buffer.from(textPage(bytes, written), 'utf8') : crypto.randomBytes(bytes);
    fs.writeFileSync(path.join(dirArg, rel), data);
    written++;
  }
  fs.writeFileSync(marker, String(written));
  log({ mode, dir: dirArg, totalMB, files: written });
} else if (mode === 'manifest') {
  if (!dirArg) throw new Error('usage: ram-big-one.mjs manifest <dir> [reps]');
  const reps = Number(arg3 ?? 5);

  // rel list exactly as writeManifest's walk produces it (sorted, depth-first, no
  // manifest/.part) — bench-local copy so parameterized passes keep the same order.
  const rels = [];
  const walk = (d, rel = '') => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === util.MANIFEST_NAME || name.endsWith('.part')) continue;
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else rels.push(r);
    }
  };
  walk(dirArg);

  const hashOne = async (rel, hwmMiB) => {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(dirArg, rel), { highWaterMark: hwmMiB << 20 })) {
      hash.update(chunk);
    }
    return `${hash.digest('hex')}  ${rel}`;
  };
  const poolPass = async (hwmMiB, workers) => {
    const lines = new Array(rels.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(workers, rels.length) }, async () => {
        while (next < rels.length) lines[next] = await hashOne(rels[next++], hwmMiB);
      }),
    );
    return lines.join('\n') + '\n';
  };
  const syncFloor = () =>
    rels
      .map((rel) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dirArg, rel))).digest('hex')}  ${rel}`)
      .join('\n') + '\n';

  // faithfulness check: the bench copy at current defaults must reproduce src writeManifest exactly
  await util.writeManifest(dirArg);
  const reference = fs.readFileSync(path.join(dirArg, util.MANIFEST_NAME), 'utf8');
  fs.rmSync(path.join(dirArg, util.MANIFEST_NAME), { force: true });
  const poolDefault = await poolPass(1, 8);
  if (poolDefault !== reference) throw new Error('bench pool (1 MiB, 8 workers) != src/util writeManifest output — bench is unfaithful');
  if (syncFloor() !== reference) throw new Error('sync floor != src/util writeManifest output — bench is unfaithful');

  const configs = [
    { id: 'hwm1_w8', hwmMiB: 1, workers: 8 },
    { id: 'hwm4_w8', hwmMiB: 4, workers: 8 },
    { id: 'hwm1_w16', hwmMiB: 1, workers: 16 },
    { id: 'hwm4_w16', hwmMiB: 4, workers: 16 },
  ];
  await poolPass(1, 8); // warmup: page cache + JIT, not counted
  const times = Object.fromEntries(configs.map((c) => [c.id, []]));
  for (let rep = 0; rep < reps; rep++) {
    for (const c of configs) {
      const t0 = performance.now();
      const text = await poolPass(c.hwmMiB, c.workers);
      times[c.id].push(Math.round((performance.now() - t0) * 10) / 10);
      if (text !== reference) throw new Error(`config ${c.id} output != reference — NOT byte-identical`);
    }
  }
  const floorTimes = [];
  for (let rep = 0; rep < reps; rep++) {
    const t0 = performance.now();
    syncFloor();
    floorTimes.push(Math.round((performance.now() - t0) * 10) / 10);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  log({
    mode,
    dir: dirArg,
    files: rels.length,
    reps,
    configs: Object.fromEntries(configs.map((c) => [c.id, { all: times[c.id], medianMs: med(times[c.id]) }])),
    syncFloor: { all: floorTimes, medianMs: med(floorTimes) },
    byteIdentical: true,
  });
} else {
  throw new Error(`unknown mode: ${mode} (baseline | prepare | epub | manifest-prep | manifest)`);
}
