// T3-W3 page-scale bench for issue #6: is cfc1's latin1-string round trip
// (Buffer.from(blob,'latin1') -> buf.toString('latin1') -> Buffer.from(str,'base64'))
// worth removing at real spine page sizes, or is it invisible end-to-end?
//
// T2-W1B (perf-notes-t2-loops.md) measured the full pipeline at 3.39 ms on a
// realistic 2.8 MB XHTML blob, ~1.9 ms of it transient-allocation/GC churn from
// that round trip — but never at page scale, and never against a
// decode-base64-straight-from-bytes variant on realistic content. This bench:
//
//   1. builds a realistic magazine spine (500 x ~50 KB XHTML pages via gen.mjs
//      textPage) and a 200-page book variant, each page wrapped in the real
//      `parent.__bif_cfc1(self, '<blob>')` call shape,
//   2. identity-gates everything FIRST: decodePage output must equal the
//      generator truth on every spine page, and the bench-local no-roundtrip
//      variant (JS table base64 straight from the swapped bytes) must equal
//      src cfc1 on the spines plus an adversarial mini fixture set,
//   3. times whole-spine decodePage sweeps (current vs no-roundtrip, round-robin,
//      medians, per-page medians + p90, CPU vs wall), single-page cfc1 at 50 KB,
//      the 2.8 MB blob for continuity with T2-W1B, and a per-stage split
//      isolating the latin1 round-trip share,
//   4. prints the decode totals against the page-download journey they overlap
//      (pages fetch 4-at-a-time; RTT figures cited from perf-notes-net.md —
//      no network is touched here).
//
// src/ is NOT changed by this bench; the no-roundtrip variant lives here.
//
// Run: node perf/cfc1-pages.mjs   (optionally --expose-gc; forced gc between
// timed sets when available, never inside a timed loop — in-loop GC churn IS
// part of what issue #6 asks us to attribute).

import { cfc1, decodePage } from '../src/read.mjs';
import { textPage } from './gen.mjs';

const PAGE_KB = 50;
const MAG_PAGES = 500;
const BOOK_PAGES = 200;
const PAGE_BYTES = PAGE_KB * 1024;

// ---- fixtures ------------------------------------------------------------------

const wrap = (blob) =>
  `<!doctype html><html><body><script>parent.__bif_cfc1(self, '${blob}');</script></body></html>`;

// cfc1 decodes as swap-quads -> base64 -> utf8, and the quad swap is its own
// inverse on aligned groups (base64 output is always a multiple of 4), so an
// encodable fixture blob is swap(base64(text)). Feeding plain base64 instead
// makes cfc1 emit garbage — T2-W1B's "realistic" 2.8 MB blob was plain base64,
// so its utf8 stage ran the error-tolerant slow path on non-XHTML output
// (revised honestly in the report; its 3.39 ms overstates realistic cost).
const swapStr = (s) => {
  const b = Buffer.from(s, 'latin1');
  for (let i = 0; i + 4 <= b.length; i += 4) {
    const t = b[i];
    b[i] = b[i + 3];
    b[i + 3] = t;
  }
  return b.toString('latin1');
};
const encodeBlob = (text) => swapStr(Buffer.from(text, 'utf8').toString('base64'));

/** One spine: realistic XHTML pages wrapped as real read-host pages. */
function buildSpine(pages) {
  const out = [];
  for (let i = 0; i < pages; i++) {
    const text = textPage(PAGE_BYTES, i);
    const blob = encodeBlob(text);
    out.push({ text, blob, html: wrap(blob) });
  }
  return out;
}

console.log(`building spines: magazine ${MAG_PAGES} x ${PAGE_KB} KB, book ${BOOK_PAGES} x ${PAGE_KB} KB, node ${process.version}`);
const MAG = buildSpine(MAG_PAGES);
const BOOK = buildSpine(BOOK_PAGES);

// 2.8 MB realistic blob for continuity with the T2-W1B stage tables: honest
// construction (identity-verified) plus a timing-only row on T2's plain-base64
// fixture shape (see the encodeBlob note above).
const REAL_CHUNK = Buffer.from(
  '<div class="ch"><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></div>\n',
);
const REAL_RAW = Buffer.alloc(2_100_000);
for (let o = 0; o < REAL_RAW.length; o += REAL_CHUNK.length) REAL_CHUNK.copy(REAL_RAW, o);
const REAL_TEXT = REAL_RAW.toString('utf8');
const REAL_BLOB = swapStr(REAL_RAW.toString('base64')); // honest: cfc1 decodes it back to REAL_TEXT
const REAL_BLOB_T2PLAIN = REAL_RAW.toString('base64'); // T2-W1B construction, timing-only continuity row

// ---- the candidate: base64 straight from the swapped bytes ----------------------
// Identical structure to src cfc1 up to the final two stages; only the latin1
// string round trip + native base64-of-string is replaced by a JS table decode
// from the swapped byte buffer. Non-ASCII delegates to src cfc1 (exact).

const B64REV = new Int16Array(256).fill(-1);
{
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) B64REV[A.charCodeAt(i)] = i;
}
function b64DecodeBytes(buf) {
  const n = buf.length;
  const out = Buffer.allocUnsafe(Math.ceil(n / 4) * 3);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 61) break; // '=': Node's decoder stops at the first '=' anywhere (probed)
    const v = B64REV[buf[i]];
    if (v < 0) continue; // outside the alphabet: ignored (never occurs in real blobs)
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

const isAscii = (s) => Buffer.byteLength(s, 'utf8') === s.length;

function cfc1NoRoundtrip(blob) {
  if (!isAscii(blob)) return cfc1(blob); // delegate: src path is exact for any string
  const buf = Buffer.from(blob, 'latin1');
  const n = buf.length;
  if (n >= 4 && buf.indexOf(10) === -1 && buf.indexOf(13) === -1) {
    for (let i = 0; i + 4 <= n; i += 4) {
      const t = buf[i];
      buf[i] = buf[i + 3];
      buf[i + 3] = t;
    }
  } else {
    let i = 0;
    while (i + 4 <= n) {
      let bad = -1;
      if (buf[i] === 10 || buf[i] === 13) bad = i;
      else if (buf[i + 1] === 10 || buf[i + 1] === 13) bad = i + 1;
      else if (buf[i + 2] === 10 || buf[i + 2] === 13) bad = i + 2;
      else if (buf[i + 3] === 10 || buf[i + 3] === 13) bad = i + 3;
      if (bad !== -1) {
        i = bad + 1;
        continue;
      }
      const t = buf[i];
      buf[i] = buf[i + 3];
      buf[i + 3] = t;
      i += 4;
    }
  }
  return b64DecodeBytes(buf).toString('utf8');
}

/** decodePage over the no-roundtrip decoder — same regex + markup canary shape. */
function decodePageNoRoundtrip(html) {
  const m = /parent\.__bif_cfc1\(\s*self\s*,\s*'([^']*)'\s*\)/.exec(html);
  if (!m) throw new Error('page has no __bif_cfc1 component');
  return cfc1NoRoundtrip(m[1]);
}

// ---- identity gates (all timing is gated on these) ------------------------------

function verifyIdentity() {
  let pages = 0;
  for (const spine of [MAG, BOOK]) {
    for (const p of spine) {
      if (decodePage(p.html) !== p.text) throw new Error(`decodePage != generator truth (blob len ${p.blob.length})`);
      if (cfc1(p.blob) !== p.text) throw new Error('src cfc1 != generator truth');
      if (cfc1NoRoundtrip(p.blob) !== p.text) throw new Error('no-roundtrip != generator truth');
      if (decodePageNoRoundtrip(p.html) !== decodePage(p.html)) throw new Error('decodePageNoRoundtrip != decodePage');
      pages++;
    }
  }
  if (cfc1(REAL_BLOB) !== REAL_TEXT || cfc1NoRoundtrip(REAL_BLOB) !== REAL_TEXT) {
    throw new Error('2.8 MB realistic blob identity failed');
  }

  // Adversarial mini set for the variant (same philosophy as loop-showdown's
  // 144-fixture harness, scaled to what this bench changes: the decode tail).
  const printable = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let seed = 0x2545f491;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const asciiOf = (len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += printable[rnd() % printable.length];
    return s;
  };
  const fixtures = [];
  for (const len of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 63, 64, 65, 255, 256, 4095, 4096]) fixtures.push(asciiOf(len));
  for (const term of ['\n', '\r']) for (let p = 0; p < 24; p++) fixtures.push(asciiOf(24).slice(0, p) + term + asciiOf(24).slice(p + 1));
  for (let gap = 0; gap <= 7; gap++) {
    const s = asciiOf(40);
    fixtures.push(s.slice(0, 12) + '\n' + s.slice(13, 13 + gap) + '\r' + s.slice(14 + gap));
  }
  for (const len of [5, 6, 7, 9, 10, 11]) {
    fixtures.push(asciiOf(len - 1) + '\n');
    fixtures.push('\r' + asciiOf(len - 1));
  }
  for (const len of [4, 8, 64]) fixtures.push('\n'.repeat(len));
  fixtures.push(asciiOf(30).slice(0, 10) + '\u2029' + asciiOf(30).slice(11)); // delegation path
  // '=' placement: the variant must mirror Node's stop-at-first-'=' semantics
  for (const s of ['QUJD=', 'QQ==', 'Q=', 'QU=JD', 'AB=C', '=QUJD', 'QUJD=QQ==']) fixtures.push(s);

  for (const [idx, fx] of fixtures.entries()) {
    if (cfc1NoRoundtrip(fx) !== cfc1(fx)) throw new Error(`no-roundtrip fixture #${idx} (len ${fx.length}) != src cfc1`);
  }
  return { spinePagesChecked: pages, miniFixtures: fixtures.length };
}

const identity = verifyIdentity();
console.log(`identity: PASS — ${identity.spinePagesChecked} spine pages vs generator truth + src cfc1, ${identity.miniFixtures} adversarial fixtures`);

// ---- harness (house style: interleaved runs, medians) ---------------------------

const time1 = (fn) => {
  const t = process.hrtime.bigint();
  const r = fn();
  return [Number(process.hrtime.bigint() - t) / 1e6, r];
};
const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => sorted(a)[Math.floor(a.length / 2)];
const p90 = (a) => {
  const s = sorted(a);
  return s[Math.floor(0.9 * (s.length - 1))];
};

// One whole-spine sweep with fn; verifies every page against generator truth and
// returns wall ms, CPU ms, and the pooled per-page samples (ms).
function sweep(spine, fn) {
  const perPage = [];
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  for (const p of spine) {
    const [ms, out] = time1(() => fn(p.html));
    if (out !== p.text) throw new Error('sweep identity failed');
    perPage.push(ms);
  }
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const cpuMs = process.cpuUsage(cpu0).user / 1000;
  return { wallMs, cpuMs, perPage };
}

const WARM = 2;
const RUNS = 11;

function benchSpine(spine, label) {
  const impls = [
    { name: 'decodePage (current)', fn: decodePage },
    { name: 'decodePage no-roundtrip', fn: decodePageNoRoundtrip },
  ];
  for (const { fn } of impls) for (let w = 0; w < WARM; w++) sweep(spine, fn); // warmup + verify
  const samples = impls.map(() => []);
  const perPagePool = impls.map(() => []);
  const cpuSamples = impls.map(() => []);
  for (let r = 0; r < RUNS; r++) {
    impls.forEach(({ fn }, i) => {
      const { wallMs, cpuMs, perPage } = sweep(spine, fn);
      samples[i].push(wallMs);
      cpuSamples[i].push(cpuMs);
      perPagePool[i].push(...perPage);
    });
  }
  const [cur, alt] = impls.map((_, i) => ({
    total_wall_ms: +median(samples[i]).toFixed(2),
    total_cpu_ms: +median(cpuSamples[i]).toFixed(2),
    perPage_us_median: +(median(perPagePool[i]) * 1000).toFixed(1),
    perPage_us_p90: +(p90(perPagePool[i]) * 1000).toFixed(1),
  }));
  return {
    label,
    pages: spine.length,
    page_kb: PAGE_KB,
    decodePage_current: cur,
    decodePage_noRoundtrip: alt,
    roundtrip_saving_ms: +(cur.total_wall_ms - alt.total_wall_ms).toFixed(2),
    roundtrip_saving_pct: +(((cur.total_wall_ms - alt.total_wall_ms) / cur.total_wall_ms) * 100).toFixed(1),
  };
}

// Single-blob pipelines: per-call cost via a batch of calls per sample (page-size
// calls are microseconds; batching keeps timer noise out), 11 samples, median.
function benchBlob(blob, { batch = 200, warm = 4, runs = 11 } = {}) {
  const pairs = [
    { name: 'current', fn: (b) => cfc1(b) },
    { name: 'noRoundtrip', fn: (b) => cfc1NoRoundtrip(b) },
  ];
  const expected = cfc1(blob);
  for (const { fn } of pairs) for (let w = 0; w < warm; w++) fn(blob);
  const res = {};
  for (const { name, fn } of pairs) {
    const s = [];
    for (let r = 0; r < runs; r++) {
      const t = process.hrtime.bigint();
      for (let k = 0; k < batch; k++) fn(blob);
      s.push(Number(process.hrtime.bigint() - t) / 1e6 / batch);
    }
    res[name] = +median(s).toFixed(4);
  }
  if (cfc1NoRoundtrip(blob) !== expected) throw new Error('blob identity failed');
  res.saving_pct = +(((res.current - res.noRoundtrip) / res.current) * 100).toFixed(1);
  return res;
}

// Stage split: cost per call of each stage, batched at page size, single at 2.8 MB.
function stageSplit(blob, { plainB64 = blob, batch = 200, runs = 11 } = {}) {
  const PROBE_HTML = wrap(blob); // regex stage inputs a whole wrapped page, like decodePage
  const bufOf = () => Buffer.from(blob, 'latin1');
  const stages = {
    'regex match (CFC1_RE)': () => /parent\.__bif_cfc1\(\s*self\s*,\s*'([^']*)'\s*\)/.exec(PROBE_HTML),
    'gate isAscii': () => Buffer.byteLength(blob, 'utf8') === blob.length,
    'Buffer.from latin1 (str->bytes)': () => Buffer.from(blob, 'latin1'),
    'indexOf x2 (\\n\\r scan)': () => {
      const b = bufOf();
      return [b.indexOf(10), b.indexOf(13)];
    },
    'swap loop (byte)': () => {
      const b = bufOf();
      for (let i = 0; i + 4 <= b.length; i += 4) {
        const t = b[i];
        b[i] = b[i + 3];
        b[i + 3] = t;
      }
      return b;
    },
    'toString latin1 (bytes->str)': () => bufOf().toString('latin1'),
    'Buffer.from base64 (of str)': () => Buffer.from(blob, 'base64'),
    'utf8 toString (incl b64)': () => Buffer.from(plainB64, 'base64').toString('utf8'), // honest input: what the pipeline's utf8 stage actually sees (restored base64, ASCII output)
    'JS b64 of bytes (variant tail)': () => b64DecodeBytes(bufOf()),
  };
  const out = {};
  for (const [name, fn] of Object.entries(stages)) {
    for (let w = 0; w < 3; w++) fn();
    const s = [];
    for (let r = 0; r < runs; r++) {
      const t = process.hrtime.bigint();
      for (let k = 0; k < batch; k++) fn();
      s.push(Number(process.hrtime.bigint() - t) / 1e6 / batch);
    }
    out[name] = +median(s).toFixed(4);
  }
  return out;
}

// ---- run ------------------------------------------------------------------------

globalThis.gc?.(); // when --expose-gc: start each measurement phase clean
const magBench = benchSpine(MAG, 'magazine 500x50KB');
globalThis.gc?.();
const bookBench = benchSpine(BOOK, 'book 200x50KB');
globalThis.gc?.();
const page50KB = benchBlob(MAG[0].blob, { batch: 200 });
const blob2_8MB = benchBlob(REAL_BLOB, { batch: 1 });
const blob2_8_t2plain = benchBlob(REAL_BLOB_T2PLAIN, { batch: 1 }); // timing-only continuity
globalThis.gc?.();
const split50 = stageSplit(MAG[0].blob, { plainB64: Buffer.from(MAG[0].text, 'utf8').toString('base64'), batch: 200 });
const split2_8 = stageSplit(REAL_BLOB, { plainB64: REAL_BLOB_T2PLAIN, batch: 1 });

// Journey context — numbers cited from perf-notes-net.md (no network here):
// pages fetch 4 at a time; ~80 ms RTT reference (band 50–150 ms incl. handshake).
const rtt = 80;
const netWall = (pages) => Math.ceil(pages / 4) * rtt;
const journey = {
  net_reference: 'perf-notes-net.md: pages 4-at-a-time; ~80 ms RTT (50–150 ms band)',
  magazine_net_wall_ms: { rtt80: netWall(MAG_PAGES), rtt50: Math.ceil(MAG_PAGES / 4) * 50, rtt150: Math.ceil(MAG_PAGES / 4) * 150 },
  decode_share_of_journey_pct: +((magBench.decodePage_current.total_cpu_ms / netWall(MAG_PAGES)) * 100).toFixed(2),
  roundtrip_saving_share_of_journey_pct: +((magBench.roundtrip_saving_ms / netWall(MAG_PAGES)) * 100).toFixed(2),
};

console.log(
  JSON.stringify(
    {
      note: 'medians: whole-spine sweeps interleaved x11 (2 warm), per-page pooled over all timed runs; identity gates run first and abort all timing on any mismatch',
      gc_exposed: typeof globalThis.gc === 'function',
      fixtures: {
        magazine: `${MAG_PAGES} pages x ~${PAGE_KB} KB XHTML (blobs = swap(base64(text)), cfc1-encodable)`,
        book: `${BOOK_PAGES} pages x ~${PAGE_KB} KB XHTML`,
        blob_2_8MB: 'realistic XHTML, honest construction, output identity-verified',
        identity,
      },
      whole_spine: { magazine: magBench, book: bookBench },
      single_page_50KB_cfc1: page50KB,
      blob_2_8MB_cfc1: { ...blob2_8MB, t2_w1b_reference_ms: 3.39 },
      blob_2_8MB_t2w1b_plain_b64_construction_timing_only: {
        ...blob2_8_t2plain,
        note: 'T2-W1B fixture shape: cfc1 output is garbage, so the utf8 stage runs its slow path; not comparable to real pages',
      },
      stage_split_per_call_ms: { page_50KB: split50, blob_2_8MB: split2_8 },
      journey_context: journey,
    },
    null,
    2,
  ),
);
