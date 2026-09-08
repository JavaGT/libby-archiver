// archiveLoanQueue (bin/libby.mjs) — the `libby archive --all` orchestration.
// Driven with injected prepare/finish fakes (no network): prepare models the loan
// setup REST round trips, finish models the downloads. Checks the three contracts
// of the pipelined loop against the sequential loop it replaced:
//   1. order + overlap: at most ONE setup in flight, the next loan's setup runs
//      during the active loan's downloads, and the visible log transcript is
//      exactly what a sequential run would print;
//   2. a prefetched setup that fails surfaces as that loan's FAILED line when it
//      becomes active; the other loans continue;
//   3. SentryError 'whoa' exits 3 at the same point in the flow — whether it
//      happens in an active finish or in a prefetched setup — and no further
//      loan is started.

import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveLoanQueue } from '../bin/libby.mjs';

class SentryError extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the queue's collaborators. prepare logs 2 lines into the log it is given
 * (the pipeline buffers prefetched loans' logs); finish logs through ctx.log
 * (finish only ever runs for the active loan, mirroring finishAudiobook).
 * `events` records the real wall-clock order of phase starts/ends.
 */
function fixture({ failPrepare = {}, failFinish = {} } = {}) {
  const events = [];
  const transcript = [];
  const ctx = { log: (m) => transcript.push(m) };
  const inflight = { setups: 0, maxSetups: 0 };

  const prepare = async (loan, log) => {
    inflight.setups++;
    inflight.maxSetups = Math.max(inflight.maxSetups, inflight.setups);
    events.push(`prepare-start:${loan.title}`);
    try {
      log(`setup ${loan.title}`);
      await sleep(5);
      if (failPrepare[loan.title]) throw failPrepare[loan.title];
      return { loan };
    } finally {
      inflight.setups--;
    }
  };
  const finish = async (loan) => {
    events.push(`finish-start:${loan.title}`);
    ctx.log(`download ${loan.title}`);
    await sleep(5);
    if (failFinish[loan.title]) throw failFinish[loan.title];
    ctx.log(`done ${loan.title}`);
    events.push(`finish-end:${loan.title}`);
    return `dir:${loan.title}`;
  };
  return { ctx, events, transcript, inflight, prepare, finish };
}

const loans = (titles) => titles.map((title) => ({ title }));

test('pipeline: one setup in flight, next setup overlaps the active downloads, logs in loan order', async (t) => {
  const f = fixture();
  const done = await archiveLoanQueue(loans(['A', 'B', 'C']), f.ctx, {
    prepare: f.prepare,
    finish: f.finish,
    SentryError,
  });

  assert.deepEqual(done, ['dir:A', 'dir:B', 'dir:C']);
  // never more than one setup in flight
  assert.equal(f.inflight.maxSetups, 1);
  // B's setup started while A's downloads (finish) were the active work
  const idx = (s) => f.events.indexOf(s);
  assert.ok(idx('prepare-start:B') < idx('finish-start:A'), 'prefetch of B must start during A');
  assert.ok(idx('prepare-start:C') < idx('finish-start:B'), 'prefetch of C must start during B');
  // the visible transcript is exactly a sequential run's
  assert.deepEqual(f.transcript, [
    'setup A', // prepared live (first loan)
    'download A',
    'done A',
    'setup B', // buffered while prefetched, replayed when B became active
    'download B',
    'done B',
    'setup C',
    'download C',
    'done C',
  ]);
});

test('pipeline: a prefetched setup that fails surfaces as that loan FAILED, others continue', async (t) => {
  const f = fixture({ failPrepare: { B: new Error('boom') } });
  const consoleError = t.mock.method(console, 'error');
  const exit = t.mock.fn();

  const done = await archiveLoanQueue(loans(['A', 'B', 'C']), f.ctx, {
    prepare: f.prepare,
    finish: f.finish,
    SentryError,
    exit,
  });

  assert.deepEqual(done, ['dir:A', 'dir:C']); // B failed, A and C continue
  assert.equal(exit.mock.callCount(), 0);
  assert.deepEqual(
    consoleError.mock.calls.map((c) => c.arguments[0]),
    ['FAILED "B": boom'],
  );
  // B's buffered setup lines still play, in order, before its FAILED line
  // (console.error); C then prepares live, so its setup line logs directly
  assert.deepEqual(f.transcript, [
    'setup A',
    'download A',
    'done A',
    'setup B', // replayed from the buffer despite the failure, like a live run
    'setup C',
    'download C',
    'done C',
  ]);
});

test('pipeline: whoa in an active finish exits 3 at the same point, no further loans start', async (t) => {
  const f = fixture({ failFinish: { A: new SentryError('whoa there', 'whoa') } });
  const consoleError = t.mock.method(console, 'error');
  const exit = t.mock.fn();

  const done = await archiveLoanQueue(loans(['A', 'B', 'C']), f.ctx, {
    prepare: f.prepare,
    finish: f.finish,
    SentryError,
    exit,
  });

  assert.deepEqual(done, []);
  exit.mock.calls.forEach((c) => assert.equal(c.arguments[0], 3));
  assert.equal(exit.mock.callCount(), 1);
  assert.deepEqual(consoleError.mock.calls.map((c) => c.arguments[0]), [
    'FAILED "A": whoa there',
    'Rate-limited by OverDrive ("whoa"). Stop and retry later.',
  ]);
  // B's prefetch may have been in flight (torn down by the real exit) but B and C
  // must never reach finish, and C's setup must never have been launched.
  assert.ok(!f.events.includes('finish-start:B'));
  assert.ok(!f.events.includes('prepare-start:C'));
});

test('pipeline: whoa in a prefetched setup exits 3 when that loan becomes active', async (t) => {
  const f = fixture({ failPrepare: { B: new SentryError('whoa there', 'whoa') } });
  const consoleError = t.mock.method(console, 'error');
  const exit = t.mock.fn();

  const done = await archiveLoanQueue(loans(['A', 'B', 'C']), f.ctx, {
    prepare: f.prepare,
    finish: f.finish,
    SentryError,
    exit,
  });

  assert.deepEqual(done, ['dir:A']);
  assert.equal(exit.mock.callCount(), 1);
  exit.mock.calls.forEach((c) => assert.equal(c.arguments[0], 3));
  assert.deepEqual(consoleError.mock.calls.map((c) => c.arguments[0]), [
    'FAILED "B": whoa there',
    'Rate-limited by OverDrive ("whoa"). Stop and retry later.',
  ]);
  assert.ok(!f.events.includes('prepare-start:C'), 'nothing starts once whoa is known');
});

test('pipeline: single-loan run prepares live and logs identically (no prefetch machinery)', async (t) => {
  const f = fixture();
  const done = await archiveLoanQueue(loans(['A']), f.ctx, {
    prepare: f.prepare,
    finish: f.finish,
    SentryError,
  });

  assert.deepEqual(done, ['dir:A']);
  assert.equal(f.inflight.maxSetups, 1);
  assert.deepEqual(f.transcript, ['setup A', 'download A', 'done A']);
});
