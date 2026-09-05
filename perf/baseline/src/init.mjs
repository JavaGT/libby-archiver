// Interactive quickstart: `libby init`.
//
// Walks a new user from nothing to a working setup in under a minute:
//   1. auto-detect the TLS quirk on this network
//   2. resolve their library (key -> name + websiteId) against the public catalog
//   3. collect the card number (+ optional PIN, entered without echo)
//   4. verify it actually authenticates
//   5. save config to ~/.config/libby-archiver/config.json
//
// After this, `libby list` and `libby archive` just work.

import readline from 'node:readline';
import { Writable } from 'node:stream';
import { resolveLibrary, detectInsecureTLS, saveConfig, loadConfig, sessionPath } from './config.mjs';
import { authenticate } from './auth.mjs';

// One readline per question, so a muted-output interface (secrets) is the only stdin
// listener while it waits. A blank answer falls back to `def` without displaying it —
// that's how an existing PIN is kept without echoing it to the screen.
function prompt(question, { def = '', muted = false } = {}) {
  return new Promise((resolve) => {
    const suffix = def ? ` [${def}]` : '';
    if (muted) process.stdout.write(`${question}: `);
    const out = muted
      ? new Writable({ write(_chunk, _enc, cb) { cb(); } })
      : process.stdout;
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    let settled = false;
    const settle = (a) => {
      if (settled) return;
      settled = true;
      rl.close();
      if (muted) process.stdout.write('\n');
      resolve(String(a ?? '').trim() || def || '');
    };
    rl.question(muted ? '' : `${question}${suffix}: `, settle);
    rl.on('close', () => settle(''));
  });
}

const c = (() => {
  const on = Boolean(process.stdout.isTTY);
  const wrap = (code) => (on ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s);
  return {
    b: wrap('1'),
    dim: wrap('2'),
    green: wrap('32'),
    red: wrap('31'),
    cyan: wrap('36'),
  };
})();

export async function runInit() {
  const existing = loadConfig();
  try {
    console.log(c.b('\n  libby-archiver — setup\n'));
    console.log(
      c.dim('  Archives audiobook, ebook, and magazine loans from Libby, with full metadata.\n') +
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
      const key = await prompt('\n  Library key', { def: existing.library });
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

    // 3. Card (PIN entered without echo; a blank entry keeps any saved PIN)
    const cardNumber = await prompt('  Library card number', { def: existing.cardNumber });
    const pin = await prompt('  Card PIN (blank if none)', { def: existing.pin, muted: true });

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
        c.dim('              show your current loans\n') +
        c.b('    libby archive --all') +
        c.dim('     download every loan\n'),
    );
  } catch (e) {
    console.log(c.red(`\n  init failed: ${e.message}`));
    process.exitCode = 1;
  }
}
