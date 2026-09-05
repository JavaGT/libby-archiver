import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/pool.mjs';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('preserves result order regardless of completion order', async () => {
  const out = await mapLimit([30, 5, 20, 1], 4, async (ms, i) => {
    await tick(ms); // later items finish first
    return i * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30]);
});

test('respects the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await mapLimit(items, 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await tick(5);
    active--;
    return n * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, items.map((n) => n * 2));
});

test('limit 1 runs strictly sequentially in input order', async () => {
  const seen = [];
  const out = await mapLimit(['a', 'b', 'c'], 1, async (x) => {
    seen.push(x);
    return x.toUpperCase();
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual(out, ['A', 'B', 'C']);
});

test('fails fast: rejects with the first error and starts no new items', async () => {
  let started = 0;
  let releaseBlocked;
  const blocked = new Promise((r) => (releaseBlocked = r)); // keeps one worker busy
  const run = mapLimit([0, 1, 2, 3], 2, (n) => {
    started++;
    if (n === 0) return blocked;
    return tick(1).then(() => {
      throw new Error(`boom ${n}`);
    });
  });
  await assert.rejects(run, /boom 1/);
  assert.equal(started, 2); // items 2 and 3 never started
  releaseBlocked(); // let the blocked worker wind down
});

test('after a rejection, a freed worker starts no further items', async () => {
  let started = 0;
  const run = mapLimit([0, 1, 2, 3], 2, async (n) => {
    started++;
    await tick(n === 0 ? 20 : 1); // item 0 keeps one worker busy past the rejection
    if (n === 1) throw new Error('boom');
    return n;
  });
  await assert.rejects(run, /boom/);
  await tick(50); // without the stop flag, the free worker would pull items 2 and 3 here
  assert.equal(started, 2);
});

test('empty input resolves to an empty array without calling fn', async () => {
  let calls = 0;
  const out = await mapLimit([], 4, async (x) => (calls++, x));
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test('rejects an invalid limit instead of silently misbehaving', async () => {
  await assert.rejects(mapLimit([1], 0, async () => {}), RangeError);
});
