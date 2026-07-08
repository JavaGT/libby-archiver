// Interactive quickstart: `libby init`.
//
// Walks a new user from nothing to a working setup in under a minute:
//   1. auto-detect the TLS quirk on this network
//   2. resolve their library (key -> name + websiteId) against the public catalog
//   3. collect the card number (+ optional PIN)
//   4. verify it actually authenticates
//   5. save config to ~/.config/libby-archiver/config.json
//
// After this, `libby list` and `libby archive` just work.

import readline from 'node:readline';
import { resolveLibrary, detectInsecureTLS, saveConfig, configPath, loadConfig } from './config.mjs';
import { authenticate } from './auth.mjs';
import { sessionPath } from './config.mjs';

function ask(rl, question, { def } = {}) {
  const suffix = def ? ` [${def}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (a) => resolve((a || '').trim() || def || ''));
  });
}

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

export async function runInit() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const existing = loadConfig();
  try {
    console.log(c.b('\n  libby-archiver — setup\n'));
    console.log(
      c.dim('  Archives audiobooks you have on loan in Libby, with full metadata.\n') +
        c.dim('  You need: your library card number and your library’s Libby key.\n'),
    );

    // 1. TLS auto-detect
    process.stdout.write('  Checking connection to OverDrive… ');
    let insecureTLS = false;
    try {
      insecureTLS = await detectInsecureTLS();
      console.log(
        insecureTLS
          ? c.cyan('mismatched edge cert — will use insecure TLS for the API host')
          : c.green('ok'),
      );
    } catch {
      console.log(c.dim('skipped'));
    }

    // 2. Library
    console.log(
      c.dim(
        '\n  Your library key is the slug in your Libby URL, e.g. "your-library" in\n' +
          '  libbyapp.com/library/your-library (also shown in your library’s share links).',
      ),
    );
    let library;
    for (;;) {
      const key = await ask(rl, '\n  Library key', { def: existing.library });
      if (!key) {
        console.log(c.red('  A library key is required.'));
        continue;
      }
      process.stdout.write('  Looking up… ');
      try {
        library = await resolveLibrary(key, { insecureTLS });
        console.log(c.green(`${library.name}`) + c.dim(`  (websiteId ${library.websiteId})`));
        break;
      } catch (e) {
        console.log(c.red(e.message));
      }
    }

    // 3. Card
    const cardNumber = await ask(rl, '\n  Library card number', { def: existing.cardNumber });
    const pin = await ask(rl, '  Card PIN (blank if none)', { def: existing.pin });

    // 4. Verify
    const cfg = {
      library: library.key,
      libraryName: library.name,
      websiteId: library.websiteId,
      cardNumber,
      pin: pin || '',
      out: existing.out || './archive',
      insecureTLS,
      sessionFile: sessionPath(),
      log: () => {},
    };
    process.stdout.write('\n  Verifying card… ');
    try {
      const { cardId } = await authenticate(cfg);
      console.log(c.green('authenticated') + c.dim(`  (cardId ${cardId})`));
    } catch (e) {
      console.log(c.red('failed'));
      console.log(c.dim(`  ${e.message}`));
      console.log(
        c.dim(
          '\n  Saving config anyway so you can retry. Check the card number/PIN and\n' +
            "  that this card is registered at the library you selected.",
        ),
      );
    }

    // 5. Save (never persist the runtime log fn)
    const { log, sessionFile, ...persist } = cfg;
    const file = saveConfig(persist);
    console.log(c.green('\n  ✓ Saved ') + c.dim(file));
    console.log(
      '\n  Next:\n' +
        c.b('    libby list') +
        c.dim('              show your current audiobook loans\n') +
        c.b('    libby archive --all') +
        c.dim('     download every audiobook loan\n'),
    );
  } finally {
    rl.close();
  }
}
