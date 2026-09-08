import test from 'node:test';
import assert from 'node:assert/strict';
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
  auth: { config: ['loadConfig'], auth: ['authenticate'] },
  borrow: {
    config: ['loadConfig'],
    auth: ['authenticate'],
    checkout: ['borrowTitle'],
    discover: ['getTitle'],
    sentry: ['SentryError'],
  },
  return: {
    config: ['loadConfig'],
    auth: ['authenticate'],
    checkout: ['returnTitle'],
    loans: ['sync'],
    sentry: ['SentryError'],
  },
  hold: {
    config: ['loadConfig'],
    auth: ['authenticate'],
    checkout: ['placeHold'],
    sentry: ['SentryError'],
  },
  unhold: {
    config: ['loadConfig'],
    auth: ['authenticate'],
    checkout: ['cancelHold'],
    sentry: ['SentryError'],
  },
  list: {
    config: ['loadConfig'],
    auth: ['authenticate'],
    loans: ['sync', 'audiobookLoans', 'readableLoans'],
  },
  archive: {
    config: ['loadConfig'],
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
