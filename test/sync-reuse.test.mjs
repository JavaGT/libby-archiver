// #17 budget pins, restated for #12: a loans-based invocation must still perform
// exactly ONE /chip/sync. authenticate no longer pre-verifies the cached session
// (the verify round trip is gone), so the single sync is loans.sync's own fetch —
// the request log the #17 pins assert is unchanged, which is the point. Hermetic
// like the #10/#11/#13 pins: the child runs the real CLI with src/sentry.mjs
// redirected to a counting sim (test/helpers/sim-sentry-{preload,loader,stub}.mjs)
// — no live network, no credential. Every HTTP request is logged to
// $SIM_SENTRY_LOG, so the pins assert the exact request set, not just output.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_IDENTITY } from './helpers/sim-sentry-stub.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'libby.mjs');
const PRELOAD = path.join(ROOT, 'test', 'helpers', 'sim-sentry-preload.mjs');

// Spawn the CLI against the simulated sentry surface. Temp XDG config, no
// LIBBY_* env, no NODE_OPTIONS; the session file lives in the temp dir, so
// even a re-bootstrap cannot touch anything real.
function spawnSim(argv, dir, extraEnv = {}) {
  const log = path.join(dir, 'requests.log');
  const env = { ...process.env, XDG_CONFIG_HOME: dir, SIM_SENTRY_LOG: log, ...extraEnv };
  for (const k of Object.keys(env)) if (k.startsWith('LIBBY_')) delete env[k];
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ['--import', PRELOAD, CLI, ...argv], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  const requests = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    : [];
  return { ...r, requests };
}

const seedSession = (dir) => {
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify({
    identity: SIM_IDENTITY,
    cardId: 'card-77',
    key: 'testlib|12345',
    savedAt: 0,
  }, null, 2));
  return file;
};

// The list output the sim's loan payload must produce — the same bytes the
// fetch path prints (criterion 3: byte-identical output, reuse only changes
// WHERE the payload comes from).
const SIM_LIST_OUTPUT = '1 loan(s):\n  101  [ebook] Simulated Loan — S. Author  (due 2026-10-01)';

test('libby list with a cached session performs exactly ONE /chip/sync (#17 budget, #12)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-sync-reuse-'));
  try {
    const session = seedSession(dir);
    const r = spawnSim(['list', '--card', '12345', '--library', 'testlib',
      '--website', '1234', '--session', session], dir);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    assert.deepEqual(r.requests, ['GET /chip/sync'],
      'the cached session must not pre-verify; loans.sync owns the single sync');
    assert.equal(r.stdout, `${SIM_LIST_OUTPUT}\n`,
      'output must be byte-identical to the pre-#12 fetch path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('libby list without a session falls back to fetching: exactly ONE /chip/sync (#17)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-sync-fallback-'));
  try {
    const session = path.join(dir, 'never-minted-session.json');
    const r = spawnSim(['list', '--card', '12345', '--library', 'testlib',
      '--website', '1234', '--session', session], dir);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    // The full fresh-mint chain ran (no cached session): mint + re-mint chips,
    // card link, clone code — and authenticate itself never syncs; the loans
    // sync fetched the payload exactly once.
    assert.deepEqual(r.requests, [
      'POST /chip', // mint primary chip
      'GET /auth/forms/1234', // resolveILS
      'POST /auth/link/1234', // link the card
      'GET /chip/clone/code', // sync code from the primary
      'POST /chip', // mint the clone target
      'POST /chip/clone/code', // clone by code
      'POST /chip', // re-mint the identity with embedded cards
      'GET /chip/sync', // the fallback fetch — exactly one
    ]);
    assert.equal(r.stdout, `${SIM_LIST_OUTPUT}\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #12: a server-side-dead cached token surfaces at the command's first authed
// call; the CLI must re-bootstrap exactly once and complete the command with
// the fresh session — the user sees the same clean recovery message the old
// pre-verify path printed.
test('dead cached session: first authed call fails, re-bootstrap retries once (#12)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-sync-recover-'));
  try {
    const session = seedSession(dir);
    const r = spawnSim(['list', '--card', '12345', '--library', 'testlib',
      '--website', '1234', '--session', session], dir, { SIM_SENTRY_SYNC_FAILS: '1' });
    assert.equal(r.status, 0, `expected exit 0 after recovery, stderr: ${r.stderr}`);
    assert.match(r.stderr, /Cached session no longer valid; re-bootstrapping/);
    assert.deepEqual(r.requests, [
      'GET /chip/sync', // the dead token's liveness proof — 401
      'POST /chip', // forced re-bootstrap: mint primary
      'GET /auth/forms/1234',
      'POST /auth/link/1234',
      'GET /chip/clone/code',
      'POST /chip',
      'POST /chip/clone/code',
      'POST /chip', // re-mint with embedded cards
      'GET /chip/sync', // the fresh session's loans sync — exactly one retry
    ]);
    assert.equal(r.stdout, `${SIM_LIST_OUTPUT}\n`,
      'the recovered command must complete with the fresh session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #12: `auth` on a cached session is the zero-round-trip fast path — the whole
// verify round trip is gone — and reports the cached state truthfully.
test('libby auth with a cached session performs ZERO requests (#12 fast path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-auth-fast-'));
  try {
    const session = seedSession(dir);
    const r = spawnSim(['auth', '--card', '12345', '--library', 'testlib',
      '--website', '1234', '--session', session], dir);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    assert.deepEqual(r.requests, [], 'a cached auth must not touch the wire');
    assert.match(r.stdout, /Authenticated \(cached session/);
    assert.match(r.stdout, /cardId=card-77/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
