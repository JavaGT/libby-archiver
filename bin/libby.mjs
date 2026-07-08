#!/usr/bin/env node
// libby — browser-free CLI to archive your Libby / OverDrive audiobook loans.
//
//   libby init                     interactive setup (run this first)
//   libby list                     list your current audiobook loans
//   libby archive --all            archive every audiobook loan
//   libby archive --title <id>     archive one title
//   libby auth                     verify authentication only
//   libby where                    print config + session file locations
//
// Config resolution: flags > env > local ./config.json > ~/.config/libby-archiver/config.json
//   --card <n>      library card number      (env LIBBY_CARD)
//   --pin <n>       card PIN, if any         (env LIBBY_PIN)
//   --library <k>   library key, e.g your-library(env LIBBY_LIBRARY)
//   --website <id>  website id, e.g. 123     (env LIBBY_WEBSITE)
//   --out <dir>     output directory         (env LIBBY_OUT)   default ./archive
//   --session <f>   session cache file
//   --insecure-tls  disable TLS verification (for the mismatched-cert edge)

import process from 'node:process';
import { authenticate } from '../src/auth.mjs';
import { sync, audiobookLoans } from '../src/loans.mjs';
import { archiveAudiobook } from '../src/archive.mjs';
import { SentryError } from '../src/sentry.mjs';
import { runInit } from '../src/init.mjs';
import { loadConfig, configPath, sessionPath } from '../src/config.mjs';

const HELP = `libby — archive your Libby / OverDrive audiobook loans (browser-free)

Usage:
  libby init                     interactive setup — run this first
  libby list                     list your current audiobook loans
  libby archive --all            archive every audiobook loan
  libby archive --title <id>     archive a single title by id
  libby auth                     verify authentication only
  libby where                    show config + session locations
  libby help                     show this help

Options (override saved config):
  --card <n>  --pin <n>  --library <key>  --website <id>
  --out <dir>  --session <file>  --insecure-tls

First time? Run  libby init`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--insecure-tls') args.insecureTLS = true;
    else if (a === '--all') args.all = true;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function buildConfig(args) {
  const file = loadConfig();
  const cfg = {
    cardNumber: args.card ?? process.env.LIBBY_CARD ?? file.cardNumber,
    pin: args.pin ?? process.env.LIBBY_PIN ?? file.pin ?? '',
    library: args.library ?? process.env.LIBBY_LIBRARY ?? file.library,
    websiteId: args.website ?? process.env.LIBBY_WEBSITE ?? file.websiteId,
    libraryName: file.libraryName,
    out: args.out ?? process.env.LIBBY_OUT ?? file.out ?? './archive',
    sessionFile: args.session ?? file.sessionFile ?? sessionPath(),
    insecureTLS: args.insecureTLS ?? file.insecureTLS ?? false,
    log: (m) => console.error(m),
  };
  const missing = ['cardNumber', 'library', 'websiteId'].filter((k) => !cfg[k]);
  if (missing.length) {
    console.error(`Missing config: ${missing.join(', ')}.`);
    console.error('Run `libby init`, or pass --card/--library/--website.');
    process.exit(2);
  }
  return cfg;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === 'init') return runInit();
  if (command === 'where') {
    console.log(`config:  ${configPath()}`);
    console.log(`session: ${sessionPath()}`);
    return;
  }

  const cfg = buildConfig(args);
  const { client, identity, cardId } = await authenticate(cfg);

  if (command === 'auth') {
    console.log(`Authenticated. cardId=${cardId}`);
    return;
  }

  const { loans } = await sync(client, identity);
  const books = audiobookLoans(loans);

  if (command === 'list') {
    if (!books.length) return console.log('No audiobook loans.');
    console.log(`${books.length} audiobook loan(s):`);
    for (const b of books) {
      console.log(
        `  ${b.id}  ${b.title}${b.author ? ` — ${b.author}` : ''}  (due ${b.expires ?? '?'})`,
      );
    }
    return;
  }

  if (command === 'archive') {
    let targets;
    if (args.title) targets = books.filter((b) => b.id === String(args.title));
    else if (args.all) targets = books;
    else {
      console.error('Specify what to archive: --all, or --title <id>.');
      console.error('See your loans with `libby list`.');
      process.exit(2);
    }
    if (!targets.length) {
      console.error('No matching audiobook loans to archive.');
      process.exit(1);
    }
    const ctx = { client, identity, cfg, log: cfg.log };
    const done = [];
    for (const loan of targets) {
      try {
        done.push(await archiveAudiobook(ctx, loan, cfg.out));
      } catch (e) {
        console.error(`FAILED "${loan.title}": ${e.message}`);
        if (e instanceof SentryError && e.result === 'whoa') {
          console.error('Rate-limited by OverDrive ("whoa"). Stop and retry later.');
          process.exit(3);
        }
      }
    }
    console.log(`\nArchived ${done.length}/${targets.length} title(s) to ${cfg.out}`);
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  console.log(HELP);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof SentryError ? `Sentry error: ${e.message}` : e.message || e);
  process.exit(1);
});
