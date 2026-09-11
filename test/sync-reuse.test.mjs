// #17 pins: a loans-based invocation must perform exactly ONE /chip/sync per
// invocation — authenticate's cached-session verify reuses its verified
// payload in loans.sync (no second identical fetch), and the fresh-mint path
// (which never syncs inside authenticate) still fetches exactly once via the
// fallback. Hermetic like the #10/#11/#13 pins: the child runs the real CLI
// with src/sentry.mjs redirected to a counting sim
// (test/helpers/sim-sentry-{preload,loader,stub}.mjs) — no live network, no
// credential. Every HTTP request is logged to $SIM_SENTRY_LOG, so the pin
// asserts the exact request set, not just output.

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
function spawnSim(argv, dir) {
  const log = path.join(dir, 'requests.log');
  const env = { ...process.env, XDG_CONFIG_HOME: dir, SIM_SENTRY_LOG: log };
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

test('libby list with a cached session performs exactly ONE /chip/sync (#17)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-sync-reuse-'));
  try {
    const session = seedSession(dir);
    const r = spawnSim(['list', '--card', '12345', '--library', 'testlib',
      '--website', '1234', '--session', session], dir);
    assert.equal(r.status, 0, `expected exit 0, stderr: ${r.stderr}`);
    assert.deepEqual(r.requests, ['GET /chip/sync'],
      'verify and loans sync must share one /chip/sync request');
    assert.equal(r.stdout, `${SIM_LIST_OUTPUT}\n`,
      'the reused payload must render exactly like the fetched one');
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
