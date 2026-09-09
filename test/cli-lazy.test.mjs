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
    for (const k of Object.keys(env)) if (k.startsWith('LIBBY_')) delete env[k]; // hermetic: no LIBBY_* escapes
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
