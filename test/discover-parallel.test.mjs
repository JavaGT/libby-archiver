// W22: getTitle fetches the Thunder record and the stargazer characteristics
// CONCURRENTLY. The sim gives both catalog routes a fixed 100 ms think-time, so a
// serial implementation takes >=200 ms and the parallel one ~100 ms — the timing
// assertion below distinguishes them with margin. Correctness assertions pin that
// the parallel result is identical to what the serial flow produced (record fields
// parsed, characteristics flattened, characteristics failure still -> []).

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { startOverdriveSim } from './helpers/overdrive-sim.mjs';

const sim = await startOverdriveSim();
if (!sim) {
  test('discover parallel skipped (openssl unavailable)', () => {});
} else {
  process.env.LIBBY_THUNDER_HOST = sim.catalog.host;
  process.env.LIBBY_STARGAZER_HOST = sim.catalog.host;
  const { getTitle, getCharacteristics } = await import('../src/discover.mjs');

  test('getTitle resolves record + characteristics in one round-trip time', async () => {
    const t0 = performance.now();
    const detail = await getTitle('testlib', '101', { insecureTLS: true });
    const ms = performance.now() - t0;

    assert.equal(detail.title, 'E2E Audiobook');
    assert.deepEqual(detail.isbns, ['978-0-000-00000-1']);
    assert.deepEqual(detail.characteristics, ['space opera']);
    // two serial 100 ms responses would be >=200 ms; concurrent, ~100 ms
    assert.ok(ms < 190, `getTitle took ${Math.round(ms)} ms — characteristics look serialized`);
  });

  test('characteristics failure still degrades to [] without failing the title', async (t) => {
    // point stargazer at a dead port: getTitle must still return the parsed record
    process.env.LIBBY_STARGAZER_HOST = 'localhost:9'; // nothing listens here
    const { getTitle: fresh } = await import('../src/discover.mjs');
    const detail = await fresh('testlib', '101', { insecureTLS: true });
    assert.equal(detail.title, 'E2E Audiobook');
    assert.deepEqual(detail.characteristics, []);
    process.env.LIBBY_STARGAZER_HOST = sim.catalog.host;
  });

  test('getCharacteristics flattens the emoji tree', async () => {
    const tags = await getCharacteristics('testlib', '101', { insecureTLS: true });
    assert.deepEqual(tags, ['space opera']);
  });

  test('cleanup: close sim servers', async () => {
    await sim.close();
  });
}
