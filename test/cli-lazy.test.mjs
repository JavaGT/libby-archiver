import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, load } from '../bin/libby.mjs';

// command → lazy modules its branch awaits, and the named exports it destructures.
// Catches typos in bin/libby.mjs's loader map and renames in src/ that would
// otherwise only surface when the command actually runs against OverDrive.
const USAGE = {
  init: { init: ['runInit'] },
  where: { config: ['configPath', 'sessionPath'] },
  probe: { read: ['probeCfc1'], openbook: ['probeEData'] },
  help: {},
  search: { config: ['loadConfig'], search: ['searchCatalog'] },
  info: { config: ['loadConfig'], discover: ['getTitle'] },
  avail: { config: ['loadConfig'], discover: ['getAvailability'] },
  auth: { config: ['loadConfig', 'sessionPath'], auth: ['authenticate'] },
  borrow: {
    config: ['loadConfig', 'sessionPath'],
    auth: ['authenticate'],
    checkout: ['borrowTitle'],
    discover: ['getTitle'],
    sentry: ['SentryError'],
  },
  return: {
    config: ['loadConfig', 'sessionPath'],
    auth: ['authenticate'],
    checkout: ['returnTitle'],
    loans: ['sync'],
    sentry: ['SentryError'],
  },
  hold: {
    config: ['loadConfig', 'sessionPath'],
    auth: ['authenticate'],
    checkout: ['placeHold'],
    sentry: ['SentryError'],
  },
  unhold: {
    config: ['loadConfig', 'sessionPath'],
    auth: ['authenticate'],
    checkout: ['cancelHold'],
    sentry: ['SentryError'],
  },
  list: {
    config: ['loadConfig', 'sessionPath'],
    auth: ['authenticate'],
    loans: ['sync', 'audiobookLoans', 'readableLoans'],
  },
  archive: {
    config: ['loadConfig', 'sessionPath'],
    auth: ['authenticate'],
    loans: ['sync', 'audiobookLoans', 'readableLoans'],
    archive: ['archiveAudiobook'],
    archiveRead: ['archiveReadable'],
    sentry: ['SentryError'],
  },
};

test('USAGE table covers the COMMANDS set exactly', () => {
  assert.deepEqual([...COMMANDS].sort(), Object.keys(USAGE).sort());
});

test('every command resolves its lazy modules to the functions the CLI destructures', async () => {
  for (const [command, modules] of Object.entries(USAGE)) {
    for (const [key, names] of Object.entries(modules)) {
      assert.ok(load[key], `libby ${command}: no lazy loader for "${key}"`);
      const mod = await load[key]();
      for (const name of names) {
        assert.equal(typeof mod[name], 'function', `libby ${command}: src/${key}.mjs must export ${name}()`);
      }
    }
  }
});

// An authed command with nothing configured must exit 2 through the normal
// missing-config path. Guards against lazy-loader destructure drift like the
// sessionPath ReferenceError (#7), which the USAGE table alone can miss when
// a helper destructures more than its command's entry pins.
test('authed command with empty config exits 2 via missing-config help (no ReferenceError)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-cfg-'));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    // hermetic: no LIBBY_* env, no NODE_OPTIONS overrides leaking into the child
    for (const k of Object.keys(env)) if (k.startsWith('LIBBY_')) delete env[k];
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'libby.mjs'), 'list'], {
      cwd: dir, // no local ./config.json either
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, `expected exit 2, stderr: ${r.stderr}`);
    assert.match(r.stderr, /Missing config/);
    assert.doesNotMatch(`${r.stderr}${r.stdout}`, /ReferenceError/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #10: a no-target `libby archive` must exit 2 with usage BEFORE any config or
// session work. --card/--library/--website are supplied so buildConfig cannot
// be the early exit, and --session points at a nonexistent path: if validation
// were ordered behind authenticate, the child would bootstrap chips over the
// network (creating that session file) or fail with a network error instead —
// so the exit code, message, and absent session file together pin the order.
test('archive without --all/--title exits 2 before session bootstrap (#10)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-args-'));
  try {
    const session = path.join(dir, 'never-created-session.json');
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    for (const k of Object.keys(env)) if (k.startsWith('LIBBY_')) delete env[k];
    delete env.NODE_OPTIONS;
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'libby.mjs');
    const r = spawnSync(process.execPath, [cli, 'archive',
      '--card', '123456', '--library', 'some-library', '--website', '1234',
      '--session', session], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 2, `expected exit 2, stderr: ${r.stderr}`);
    assert.match(r.stderr, /Specify what to archive/);
    assert.ok(!fs.existsSync(session), 'authenticate must not run: session file was created');
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Missing config|Authenticated|Minting/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #10: same shape for the borrow family — a missing id exits 2 with usage
// before authenticate's network round trip.
test('borrow without an id exits 2 before session bootstrap (#10)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-args-'));
  try {
    const session = path.join(dir, 'never-created-session.json');
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    for (const k of Object.keys(env)) if (k.startsWith('LIBBY_')) delete env[k];
    delete env.NODE_OPTIONS;
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'libby.mjs');
    const r = spawnSync(process.execPath, [cli, 'borrow',
      '--card', '123456', '--library', 'some-library', '--website', '1234',
      '--session', session], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 2, `expected exit 2, stderr: ${r.stderr}`);
    assert.match(r.stderr, /Usage: libby borrow <id>/);
    assert.ok(!fs.existsSync(session), 'authenticate must not run: session file was created');
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Missing config|Authenticated|Minting/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #11: `libby init --help` must print usage and never run the wizard, which
// network-probes and re-authenticates. XDG_CONFIG_HOME points at an empty temp
// dir so even a regression cannot touch any real config; the wizard's progress
// strings ("Checking connection", "Saved") must never appear.
test('init --help prints usage without running the wizard (#11)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-init-help-'));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    for (const k of Object.keys(env)) if (k.startsWith('LIBBY_')) delete env[k];
    delete env.NODE_OPTIONS;
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'libby.mjs');
    for (const flag of ['--help', '-h']) {
      const r = spawnSync(process.execPath, [cli, 'init', flag], { cwd: dir, env, encoding: 'utf8' });
      assert.equal(r.status, 0, `init ${flag}: expected exit 0, stderr: ${r.stderr}`);
      assert.match(r.stdout, /libby init/);
      assert.match(r.stdout, /interactive setup/);
      assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Checking connection|Saved/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
