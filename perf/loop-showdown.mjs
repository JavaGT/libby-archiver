// W23 loop showdown: alternative inner loops for cfc1 (src/read.mjs) and
// descramble (src/openbook.mjs), measured head-to-head in ONE process.
//
// Every alternative is defined here inline; only winners got promoted into src/.
// Each run's output is verified identical to the reference. The pre-W23 pipelines
// are copied inline; src/read.mjs's exported cfc1 is also benched as "current" so
// the adopted fast path stays honest against the old baseline on every rerun.
//
// Run: node perf/loop-showdown.mjs   (prints a JSON table)

import { randomFillSync } from 'node:crypto';
import { cfc1 as cfc1Src } from '../src/read.mjs';

// ---- inputs ------------------------------------------------------------------

// cfc1: a 2.8 MB base64 blob (2.1 MB of random bytes -> exactly 2,800,000 chars,
// the size W5 measured for a read-host page).
const rawCfc1 = Buffer.alloc(2_100_000);
randomFillSync(rawCfc1);
const BLOB = rawCfc1.toString('base64');

// descramble: ~2 MB of base64-ish text (what eData.join('"') actually carries).
const rawDesc = Buffer.alloc(1_500_000);
randomFillSync(rawDesc);
const DESC_DATA = rawDesc.toString('base64'); // 2,000,000 chars

// Keys: production key = buid reversed. Dense = digits sprinkled through a hex-ish
// buid; sparse = the test fixture's shape; long-sparse = run-slicing's best case.
const KEYS = {
  'dense-8 (9a2f4ed7)': '9a2f4ed7',
  'sparse-5 (dcba9)': 'dcba9',
  'long-sparse-9 (zyx8wvuts)': 'zyx8wvuts',
};

// ---- shared current implementations -------------------------------------------

// Exact copy of the current swapQuads (src/read.mjs) for use as a fallback inside
// string-level variants. Verified against the src export on every bench run.
function swapQuads(s) {
  const n = s.length;
  if (n < 4) return s;
  const u = new Uint16Array(n);
  for (let i = 0; i < n; i++) u[i] = s.charCodeAt(i);
  let i = 0;
  while (i + 4 <= n) {
    let bad = -1;
    if (u[i] === 10 || u[i] === 13 || u[i] === 0x2028 || u[i] === 0x2029) bad = i;
    else if (u[i + 1] === 10 || u[i + 1] === 13 || u[i + 1] === 0x2028 || u[i + 1] === 0x2029) bad = i + 1;
    else if (u[i + 2] === 10 || u[i + 2] === 13 || u[i + 2] === 0x2028 || u[i + 2] === 0x2029) bad = i + 2;
    else if (u[i + 3] === 10 || u[i + 3] === 13 || u[i + 3] === 0x2028 || u[i + 3] === 0x2029) bad = i + 3;
    if (bad !== -1) {
      i = bad + 1;
      continue;
    }
    const a = u[i];
    u[i] = u[i + 3];
    u[i + 3] = a;
    i += 4;
  }
  let out = '';
  for (let k = 0; k < n; k += 8192) {
    out += String.fromCharCode.apply(null, u.subarray(k, Math.min(k + 8192, n)));
  }
  return out;
}

// Exact copy of the current descramble as of pre-W23 (src/openbook.mjs), kept as
// the baseline row and as the expected-output reference for every variant.
function descrambleCurrent(key, data) {
  const klen = key.length;
  const shifts = new Array(klen);
  for (let i = 0; i < klen; i++) shifts[i] = parseFloat(key[i]) || 0;
  const out = new Array(data.length);
  for (let a = 0; a < data.length; a++) {
    let ch = data.charCodeAt(a);
    const d = shifts[a % klen];
    if (d) {
      ch += (a + d) % 94;
      if (ch > 126) ch = (ch % 126) + 32;
    }
    out[a] = String.fromCharCode(ch);
  }
  return out.join('');
}

// ---- cfc1 alternatives ---------------------------------------------------------

// Pre-W23 pipeline (code-unit swapQuads + native base64): exact for any string,
// so the variants below use it as their non-ASCII fallback.
const cfc1PreW23 = (blob) => Buffer.from(swapQuads(blob), 'base64').toString('utf8');

// Pure-ASCII gate: Buffer.byteLength(s,'utf8') === s.length iff every code unit
// is <= 127 — a single native scan. (Probe confirmed latin1 byteLength does NOT
// detect >255 chars, so utf8 length equality is the cheap reliable test.)
const isAscii = (s) => Buffer.byteLength(s, 'utf8') === s.length;

// (a) latin1 byte path, general terminator-skipping swap (mirrors engine retries).
function cfc1Latin1Skip(blob) {
  if (!isAscii(blob)) return cfc1PreW23(blob);
  const buf = Buffer.from(blob, 'latin1');
  const n = buf.length;
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
  return Buffer.from(buf.toString('latin1'), 'base64').toString('utf8');
}

// (b) latin1 byte path + native memchr pre-scan: when the blob holds no \n/\r
// (every real blob), the swap is a branch-free tight loop. \u2028/\u2029 cannot
// reach the byte path (they are >127, so the gate falls back).
function cfc1Latin1Fast(blob) {
  if (!isAscii(blob)) return cfc1PreW23(blob);
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
  return Buffer.from(buf.toString('latin1'), 'base64').toString('utf8');
}

// (c) string-level: skip the terminator checks entirely when a regex pre-scan
// finds none; fall back to the full swapQuads otherwise. Stays in the current
// Uint16Array/fromCharCode shape — isolates the cost of the 4-way branch/quad.
function cfc1U16Tight(blob) {
  if (nosterm(blob)) {
    const n = blob.length;
    if (n < 4) return Buffer.from(blob, 'base64').toString('utf8');
    const u = new Uint16Array(n);
    for (let i = 0; i < n; i++) u[i] = blob.charCodeAt(i);
    for (let i = 0; i + 4 <= n; i += 4) {
      const a = u[i];
      u[i] = u[i + 3];
      u[i + 3] = a;
    }
    let out = '';
    for (let k = 0; k < n; k += 8192) {
      out += String.fromCharCode.apply(null, u.subarray(k, Math.min(k + 8192, n)));
    }
    return Buffer.from(out, 'base64').toString('utf8');
  }
  return Buffer.from(swapQuads(blob), 'base64').toString('utf8');
}
const nosterm = (s) => !/[\n\r\u2028\u2029]/.test(s);

// (d) latin1 byte swap + hand-rolled table base64 decode from the swapped bytes
// (skips the latin1 string round trip; native base64 decode of the string is
// replaced by JS decode of the bytes).
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
    const v = B64REV[buf[i]];
    if (v < 0) continue; // '=' padding and (for clean input) nothing else
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}
function cfc1Latin1JsB64(blob) {
  if (!isAscii(blob)) return cfc1PreW23(blob);
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

// ---- descramble alternatives ---------------------------------------------------

// (a) Uint16Array emit via fromCharCode.apply strides (general, any input).
function descrambleU16(key, data) {
  const klen = key.length;
  const shifts = new Array(klen);
  for (let i = 0; i < klen; i++) shifts[i] = parseFloat(key[i]) || 0;
  const n = data.length;
  const u = new Uint16Array(n);
  let p = 0;
  for (let a = 0; a < n; a++) {
    let ch = data.charCodeAt(a);
    const d = shifts[p];
    if (++p === klen) p = 0;
    if (d) {
      ch += (a + d) % 94;
      if (ch > 126) ch = (ch % 126) + 32;
    }
    u[a] = ch;
  }
  let out = '';
  for (let k = 0; k < n; k += 8192) {
    out += String.fromCharCode.apply(null, u.subarray(k, Math.min(k + 8192, n)));
  }
  return out;
}

// (b) pass-through runs copied via slice (only pays off when the key has long
// non-digit stretches between digits).
function descrambleRunSlice(key, data) {
  const klen = key.length;
  const shifts = new Array(klen);
  for (let i = 0; i < klen; i++) shifts[i] = parseFloat(key[i]) || 0;
  const n = data.length;
  const parts = [];
  let a = 0;
  while (a < n) {
    if (!shifts[a % klen]) {
      let end = a + 1;
      while (end < n && !shifts[end % klen]) end++;
      parts.push(data.slice(a, end)); // shift-0 run: chars pass through unchanged
      a = end;
    } else {
      let ch = data.charCodeAt(a);
      const d = shifts[a % klen];
      ch += (a + d) % 94;
      if (ch > 126) ch = (ch % 126) + 32;
      parts.push(String.fromCharCode(ch));
      a++;
    }
  }
  return parts.join('');
}

// (c) latin1 byte path: pure-ASCII data (always true on the wire) transforms as
// bytes and materializes with one native toString. Values stay <= 127 + 93 and
// after the >126 wrap <= 157, so every result fits a byte exactly.
function descrambleByte(key, data) {
  if (!isAscii(data)) return descrambleU16(key, data); // general fallback
  const klen = key.length;
  const shifts = new Array(klen);
  for (let i = 0; i < klen; i++) shifts[i] = parseFloat(key[i]) || 0;
  const bytes = Buffer.from(data, 'latin1');
  const n = bytes.length;
  let p = 0;
  for (let a = 0; a < n; a++) {
    const d = shifts[p];
    if (++p === klen) p = 0;
    if (d) {
      let ch = bytes[a] + ((a + d) % 94);
      if (ch > 126) ch = (ch % 126) + 32;
      bytes[a] = ch;
    }
  }
  return bytes.toString('latin1');
}

// ---- harness -------------------------------------------------------------------

const time1 = (fn) => {
  const t = process.hrtime.bigint();
  const r = fn();
  return [Number(process.hrtime.bigint() - t) / 1e6, r];
};

// Round-robin timed runs so JIT/GC order effects are shared; median per impl.
// Each implementation is a thunk; output must equal `expected` on every run.
function benchSet(implementations, expected, { warm = 4, runs = 11 } = {}) {
  for (const { name, fn } of implementations) {
    for (let w = 0; w < warm; w++) {
      const [, out] = time1(fn);
      if (out !== expected) throw new Error(`${name}: output mismatch during warmup`);
    }
  }
  const samples = implementations.map(() => []);
  const identical = implementations.map(() => true);
  for (let r = 0; r < runs; r++) {
    implementations.forEach(({ fn }, i) => {
      const [ms, out] = time1(fn);
      samples[i].push(ms);
      if (out !== expected) identical[i] = false;
    });
  }
  const medians = samples.map((s) => [...s].sort((a, b) => a - b)[Math.floor(s.length / 2)]);
  const base = medians[0];
  return implementations.map(({ name }, i) => ({
    name,
    median_ms: +medians[i].toFixed(2),
    speedup: +(base / medians[i]).toFixed(2),
    identical: identical[i],
  }));
}

// Detection-cost micro (how much the ASCII gate itself costs on the 2.8 MB blob).
function benchDetection() {
  const cands = {
    'byteLength utf8 (native)': (s) => Buffer.byteLength(s, 'utf8') === s.length,
    'regex [^\\x00-\\x7F] test': (s) => !/[^\x00-\x7F]/.test(s),
    'charCodeAt loop (JS)': (s) => {
      for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
      return true;
    },
  };
  const out = {};
  for (const [name, fn] of Object.entries(cands)) {
    for (let w = 0; w < 3; w++) fn(BLOB);
    const t = [];
    for (let r = 0; r < 11; r++) t.push(time1(() => fn(BLOB))[0]);
    out[name] = +t.sort((a, b) => a - b)[5].toFixed(3);
  }
  return out; // median ms
}

// ---- run ------------------------------------------------------------------------

console.log(`blob ${(BLOB.length / 1e6).toFixed(2)} MB, data ${(DESC_DATA.length / 1e6).toFixed(2)} MB, node ${process.version}`);

const detection_ms = benchDetection();

const cfc1Variants = [
  { name: 'pre-W23 (u16 swapQuads pipeline)', fn: cfc1PreW23 },
  { name: 'current (src/read.mjs, W23 adopted)', fn: cfc1Src },
  { name: 'latin1 skip-loop', fn: cfc1Latin1Skip },
  { name: 'latin1 indexOf fast', fn: cfc1Latin1Fast },
  { name: 'u16 tight (regex noterm)', fn: cfc1U16Tight },
  { name: 'latin1 + JS base64', fn: cfc1Latin1JsB64 },
];
const cfc1Expected = cfc1Src(BLOB);
const cfc1Results = benchSet(
  cfc1Variants.map(({ name, fn }) => ({ name, fn: () => fn(BLOB) })),
  cfc1Expected,
);

const descrambleVariants = [
  { name: 'pre-W23 (1-char strings + join)', fn: descrambleCurrent },
  { name: 'u16 + fromCharCode strides', fn: descrambleU16 },
  { name: 'run-slice pass-through', fn: descrambleRunSlice },
  { name: 'latin1 bytes in place (W23 adopted)', fn: descrambleByte },
];
const descrambleResults = {};
for (const [kname, key] of Object.entries(KEYS)) {
  const impls = descrambleVariants.map(({ name, fn }) => ({
    name,
    fn: () => fn(key, DESC_DATA),
  }));
  descrambleResults[kname] = benchSet(impls, descrambleCurrent(key, DESC_DATA));
}

console.log(
  JSON.stringify(
    {
      note: 'median of 11 interleaved runs, same process, outputs verified identical per run set',
      detection_cost_ms_on_blob: detection_ms,
      cfc1_blob_2_8MB: cfc1Results,
      descramble_2MB: descrambleResults,
    },
    null,
    2,
  ),
);
