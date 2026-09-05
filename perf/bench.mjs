// Comparative benchmark: baseline snapshot (perf/baseline = code at campaign start)
// vs the current hub worktree. Run:  node perf/bench.mjs [--label <name>] [--quick]
//
// Sections with no perf-relevant code changes yet still run — they establish the
// noise floor so later deltas are interpretable.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jpegish, textPage, syntheticEpub } from './gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(here, 'baseline');
const CUR = path.resolve(here, '..');
const quick = process.argv.includes('--quick');
const label = process.argv.includes('--label')
  ? process.argv[process.argv.indexOf('--label') + 1]
  : 'run';

const oldEpub = await import(path.join(BASE, 'src/epub.mjs'));
const newEpub = await import(path.join(CUR, 'src/epub.mjs'));
const oldRead = await import(path.join(BASE, 'src/read.mjs'));
const newRead = await import(path.join(CUR, 'src/read.mjs'));
const oldUtil = await import(path.join(BASE, 'src/util.mjs'));
const newUtil = await import(path.join(CUR, 'src/util.mjs'));
const oldOpenbook = await import(path.join(BASE, 'src/openbook.mjs'));
const newOpenbook = await import(path.join(CUR, 'src/openbook.mjs'));

const gc = globalThis.gc ?? (() => {});
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
};
const time = async (fn, runs) => {
  const xs = [];
  for (let i = 0; i < runs; i++) {
    gc();
    const t0 = process.hrtime.bigint();
    await fn();
    xs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return Math.round(med(xs) * 100) / 100;
};

// Vendored copy of the baseline CRC32 (not exported by epub.mjs) for standalone comparison.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32js(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const results = { label, date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model, sections: {} };

// ---- 1. crc32: vendored JS loop vs native zlib.crc32 --------------------------
{
  const buf = jpegish(4 * 1024 * 1024);
  const js = await time(() => crc32js(buf), quick ? 3 : 11);
  const nat = await time(() => zlib.crc32(buf), quick ? 3 : 11);
  const agree = crc32js(buf) === zlib.crc32(buf);
  results.sections.crc32_4mb = { jsMs: js, nativeMs: nat, outputsAgree: agree };
}

// ---- 2. zip assembly wall time -------------------------------------------------
{
  const entries = syntheticEpub();
  const totalMB = Math.round(entries.reduce((a, e) => a + (e.data?.length ?? 0), 0) / 1048576);
  const oldMs = await time(() => oldEpub.zip(entries), quick ? 1 : 3);
  const newMs = await time(() => newEpub.zip(entries), quick ? 1 : 3);
  const a = oldEpub.zip(entries);
  const b = newEpub.zip(entries);
  results.sections.zip_assembly = {
    inputMB: totalMB,
    baselineMs: oldMs,
    currentMs: newMs,
    outputBytesAgree: a.equals(b),
    baselineBytes: a.length,
    currentBytes: b.length,
  };
}

// ---- 3. deflate level tradeoffs (informs the store/level decision) -------------
{
  const text = Buffer.concat(Array.from({ length: 40 }, (_, i) => Buffer.from(textPage(16 * 1024, i), 'utf8')));
  const jpeg = jpegish(1024 * 1024);
  const row = async (buf) => {
    const l9 = zlib.deflateRawSync(buf, { level: 9 });
    const l6 = zlib.deflateRawSync(buf, { level: 6 });
    const t9 = await time(() => zlib.deflateRawSync(buf, { level: 9 }), quick ? 2 : 5);
    const t6 = await time(() => zlib.deflateRawSync(buf, { level: 6 }), quick ? 2 : 5);
    return {
      level9Ms: t9, level6Ms: t6,
      level9Ratio: +(l9.length / buf.length).toFixed(3),
      level6Ratio: +(l6.length / buf.length).toFixed(3),
    };
  };
  results.sections.deflate_levels = { text1mb: await row(text), jpeg1mb: await row(jpeg) };
}

// ---- 4. cfc1 page-blob decode ---------------------------------------------------
{
  const blob = jpegish(2 * 1024 * 1024).toString('base64'); // 2.7MB ASCII, realistic size for a big page
  const a = oldRead.cfc1(blob);
  const b = newRead.cfc1(blob);
  const oldMs = await time(() => oldRead.cfc1(blob), quick ? 2 : 5);
  const newMs = await time(() => newRead.cfc1(blob), quick ? 2 : 5);
  results.sections.cfc1_decode = { blobChars: blob.length, baselineMs: oldMs, currentMs: newMs, outputsAgree: a === b };
}

// ---- 4b. openbook decode (player page -> openbook) -------------------------------
{
  const { openbookPage } = await import('./gen.mjs');
  const page = openbookPage(1_500_000);
  const oldDoc = oldOpenbook.decodeOpenbook(page, 'ab9cd');
  const newDoc = newOpenbook.decodeOpenbook(page, 'ab9cd');
  const oldMs = await time(() => oldOpenbook.decodeOpenbook(page, 'ab9cd'), quick ? 1 : 5);
  const newMs = await time(() => newOpenbook.decodeOpenbook(page, 'ab9cd'), quick ? 1 : 5);
  results.sections.openbook_decode = {
    pageChars: page.length,
    baselineMs: oldMs,
    currentMs: newMs,
    outputsAgree: JSON.stringify(oldDoc) === JSON.stringify(newDoc),
  };
}

// ---- 5. manifest hashing (whole-archive integrity pass) -------------------------
{
  // One identical source dir for both impls, so the manifests must match byte-for-byte.
  const src = path.join(here, '.tmp-manifest-src');
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(src, `Part ${String(i + 1).padStart(2, '0')}.mp3`), jpegish(4 * 1024 * 1024));
  fs.writeFileSync(path.join(src, 'metadata.json'), Buffer.from(textPage(8 * 1024, 42), 'utf8'));
  const mk = (dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(src, dir, { recursive: true });
    return dir;
  };
  const dOld = mk(path.join(here, '.tmp-manifest-old'));
  const dNew = mk(path.join(here, '.tmp-manifest-new'));
  const oldMs = await time(() => oldUtil.writeManifest(dOld), quick ? 1 : 3);
  const newMs = await time(() => newUtil.writeManifest(dNew), quick ? 1 : 3);
  const sameManifest =
    fs.readFileSync(path.join(dOld, 'manifest.sha256'), 'utf8') ===
    fs.readFileSync(path.join(dNew, 'manifest.sha256'), 'utf8');
  results.sections.manifest_hash_50mb = { baselineMs: oldMs, currentMs: newMs, manifestsAgree: sameManifest };
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dOld, { recursive: true, force: true });
  fs.rmSync(dNew, { recursive: true, force: true });
}

// ---- 6. CLI startup (import graph) ----------------------------------------------
{
  const run = (bin) => {
    const xs = [];
    for (let i = 0; i < (quick ? 3 : 9); i++) {
      const t0 = process.hrtime.bigint();
      spawnSync(process.execPath, [bin, 'help'], { stdio: 'ignore' });
      xs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return Math.round(med(xs) * 10) / 10;
  };
  const floor = run('-e');
  results.sections.cli_startup_help = {
    baselineMs: run(path.join(BASE, 'bin/libby.mjs')),
    currentMs: run(path.join(CUR, 'bin/libby.mjs')),
    nodeFloorMs: floor,
  };
}

console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(here, `results-${label}.json`), JSON.stringify(results, null, 2));
