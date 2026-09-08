import test from 'node:test';
import assert from 'node:assert/strict';
import { takePrefetched } from '../bin/libby.mjs';
import { audiobookOpenbook } from './helpers/overdrive-sim.mjs';

test('archive all consumes a prefetched loan after an early prior-loan failure', async () => {
  const state = { promise: Promise.resolve({ loanId: 'loan-i', openbook: { b: audiobookOpenbook().b } }) };

  // The current loan fails before its setup-ready callback can launch another prefetch.
  await assert.rejects(Promise.reject(new Error('decoded openbook had no spine')));

  const stale = takePrefetched(state);
  assert.equal(state.promise, null);
  assert.equal((await stale).loanId, 'loan-i');

  // The following loan gets its own setup, rather than the failed loan's setup.
  state.promise = Promise.resolve({ loanId: 'loan-i+1', openbook: { b: audiobookOpenbook().b } });
  const next = takePrefetched(state);
  assert.equal((await next).loanId, 'loan-i+1');
  assert.equal(state.promise, null);
});
