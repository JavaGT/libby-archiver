// Network-layer regression tests (wave W7 + download.mjs interplay).
//
// These pin the two properties the pooling change (W7) must never break:
//   1. connections ARE reused (that is the whole point of the change), and
//   2. the historic wedge stays closed — a hung socket still times out, and a
//      bounded socket pool still drains when demand exceeds maxSockets.
// downloadPart tests cover the streaming path over pooled connections, including
// redirect following and the truncated-body integrity check.
// The collect() tests (T3-W1) pin the lazy text/json contract: binary drains never
// utf8-decode or JSON.parse, JSON consumers see identical values, getters run once.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { collect, fetchBuffer } from '../src/http.mjs';
import { downloadPart } from '../src/download.mjs';
import { startSimServer, deterministicBytes, sha256 } from './helpers/sim-server.mjs';

test('keep-alive pooling reuses one connection across sequential requests', async (t) => {
  const sim = await startSimServer();
  if (!sim) return t.skip('openssl unavailable');
  try {
    for (let i = 0; i < 5; i++) {
      const res = await fetchBuffer(`${sim.url}/json`, { insecureTLS: true, timeoutMs: 5000 });
      assert.equal(res.status, 200);
    }
    assert.equal(sim.connections, 1, `expected socket reuse, saw ${sim.connections} connections`);
  } finally {
    await sim.close();
  }
});

test('a hung connection still times out with the request-scoped message', async (t) => {
  const sim = await startSimServer();
  if (!sim) return t.skip('openssl unavailable');
  try {
    await assert.rejects(
      fetchBuffer(`${sim.url}/stall`, { insecureTLS: true, timeoutMs: 150 }),
      /timed out after 150ms/,
    );
  } finally {
    await sim.close();
  }
});

test('demand above maxSockets (12 over 8) still drains without deadlock', async (t) => {
  const sim = await startSimServer();
  if (!sim) return t.skip('openssl unavailable');
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fetchBuffer(`${sim.url}/json?i=${i}`, { insecureTLS: true, timeoutMs: 5000 })),
    );
    assert.equal(results.filter((r) => r.status === 200).length, 12);
  } finally {
    await sim.close();
  }
});

test('downloadPart follows a redirect, writes exact bytes, reports sha256, leaves no .part', async (t) => {
  const sim = await startSimServer();
  if (!sim) return t.skip('openssl unavailable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-dl-'));
  try {
    const dest = path.join(dir, 'Part 01.mp3');
    const expected = deterministicBytes(100);
    const { bytes, sha256: got } = await downloadPart(
      { index: 1, url: `${sim.url}/redirect`, size: 100 },
      dest,
      { insecureTLS: true, timeoutMs: 5000 },
    );
    assert.equal(bytes, 100);
    assert.equal(got, sha256(expected));
    assert.ok(fs.readFileSync(dest).equals(expected));
    assert.ok(!fs.existsSync(dest + '.part'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await sim.close();
  }
});

test('downloadPart rejects a truncated body and cleans up the .part temp file', async (t) => {
  const sim = await startSimServer();
  if (!sim) return t.skip('openssl unavailable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-dl-'));
  try {
    const dest = path.join(dir, 'Part 02.mp3');
    // The rejection may be either the pipeline's premature-close or the expected-size
    // check, depending on how the server's socket destroy lands — both are acceptable.
    await assert.rejects(
      downloadPart({ index: 2, url: `${sim.url}/truncated/1000`, size: 1000 }, dest, {
        insecureTLS: true,
        timeoutMs: 5000,
      }),
    );
    assert.ok(!fs.existsSync(dest), 'no file may masquerade as a finished part');
    assert.ok(!fs.existsSync(dest + '.part'), 'temp file must be cleaned up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await sim.close();
  }
});

// --- collect(): the lazy text/json contract (T3-W1, issue #4) ---

/** Minimal stream stub: collect() only needs data/end events plus statusCode/headers. */
function fakeRes({ status = 200, headers = {}, body }) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = headers;
  queueMicrotask(() => {
    res.emit('data', body);
    res.emit('end');
  });
  return res;
}

test('collect: binary body exposes buffer without decoding; text/json decode lazily and once', async () => {
  const bytes = deterministicBytes(4096);
  // Identity-scoped utf8 spy: count decodes of exactly this result's buffer, so the
  // test framework's own string work can't pollute the count.
  const orig = Buffer.prototype.toString;
  let decodes = 0;
  let seen;
  Buffer.prototype.toString = function (enc, ...rest) {
    if (this === seen && enc === 'utf8') decodes++;
    return orig.call(this, enc, ...rest);
  };
  try {
    const out = await collect(fakeRes({ body: bytes }));
    seen = out.buffer;
    // Structural laziness pin: text/json are accessor properties, not eagerly
    // computed values — the getter's existence is what keeps drain time at zero.
    assert.ok(Object.getOwnPropertyDescriptor(out, 'text').get, 'text must be a getter');
    assert.ok(Object.getOwnPropertyDescriptor(out, 'json').get, 'json must be a getter');
    assert.equal(out.status, 200);
    assert.ok(out.buffer.equals(bytes), 'binary bytes arrive intact');
    assert.equal(decodes, 0, 'drain must not utf8-decode the binary body');

    const t1 = out.text;
    assert.equal(decodes, 1, 'reading text decodes exactly once');
    assert.equal(out.text, t1, 'text is cached');
    assert.equal(out.json, undefined, 'binary garbage parses to undefined, as before');
    assert.equal(out.json, undefined, 'repeat json read');
    assert.equal(decodes, 1, 'failed parse is not retried on re-read (compute-once)');
  } finally {
    Buffer.prototype.toString = orig;
  }
});

test('collect: JSON body text/json identical to the eager shape; spread yields plain values', async () => {
  const payload = { ok: true, items: [1, 2, 3], nested: { a: 'b' } };
  const raw = JSON.stringify(payload);
  const out = await collect(
    fakeRes({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(raw) }),
  );
  assert.equal(out.status, 200);
  assert.deepEqual(out.headers, { 'content-type': 'application/json' });
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.equal(out.text, raw);
  assert.deepEqual(out.json, payload);
  // The openbook-style spread ({ url, ...res }) shape: getters evaluate at spread
  // time into plain own enumerable values — same surface the old eager shape had.
  const spread = { url: 'https://example/page', ...out };
  assert.equal(spread.text, raw);
  assert.deepEqual(spread.json, payload);
  assert.equal(Object.getOwnPropertyDescriptor(spread, 'json').get, undefined, 'spread copies values, not getters');
});

test('collect: text/json getters evaluate once (cache identity across reads)', async () => {
  const raw = JSON.stringify({ n: 1, list: ['x'] });
  const out = await collect(fakeRes({ body: Buffer.from(raw) }));
  const j1 = out.json;
  const t1 = out.text;
  assert.ok(j1 && j1 === out.json, 'json must return the same parsed object identity');
  assert.equal(t1, out.text, 'text must return the same string identity');
});

test('fetchBuffer on a binary body returns exact bytes with no utf8 decode and no JSON.parse', async (t) => {
  const sim = await startSimServer();
  if (!sim) return t.skip('openssl unavailable');
  // Window-scoped spies: nothing else in a fetchBuffer round-trip utf8-decodes a
  // 64 KB buffer or calls JSON.parse, so any hit means the drain paid eagerly.
  const origToString = Buffer.prototype.toString;
  const origParse = JSON.parse;
  let decoded = false;
  let parsed = false;
  Buffer.prototype.toString = function (enc, ...rest) {
    if (enc === 'utf8' && this.length >= 64 * 1024) decoded = true;
    return origToString.call(this, enc, ...rest);
  };
  JSON.parse = function (...args) {
    parsed = true;
    return origParse.apply(JSON, args);
  };
  try {
    const expected = deterministicBytes(64 * 1024);
    const out = await fetchBuffer(`${sim.url}/bytes/${expected.length}`, {
      insecureTLS: true,
      timeoutMs: 5000,
    });
    assert.equal(out.status, 200);
    assert.ok(out.body.equals(expected), 'binary body arrives byte-exact');
    assert.equal(decoded, false, 'binary drain must not utf8-decode');
    assert.equal(parsed, false, 'binary drain must not JSON.parse');
  } finally {
    Buffer.prototype.toString = origToString;
    JSON.parse = origParse;
    await sim.close();
  }
});
