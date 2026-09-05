// Network-layer regression tests (wave W7 + download.mjs interplay).
//
// These pin the two properties the pooling change (W7) must never break:
//   1. connections ARE reused (that is the whole point of the change), and
//   2. the historic wedge stays closed — a hung socket still times out, and a
//      bounded socket pool still drains when demand exceeds maxSockets.
// downloadPart tests cover the streaming path over pooled connections, including
// redirect following and the truncated-body integrity check.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchBuffer } from '../src/http.mjs';
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
