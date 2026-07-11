#!/usr/bin/env node
// libby — browser-free CLI for your Libby / OverDrive audiobooks.
//
//   libby init                     interactive setup (run this first)
//   libby search <terms>           search the catalog
//   libby info <id>                show full catalog detail for a title
//   libby avail <id...>            check real-time availability
//   libby borrow <id>              check out a title
//   libby return <id>              give a title back
//   libby hold <id>                place a hold
//   libby unhold <id>              cancel a hold
//   libby list                     list your current audiobook loans
//   libby archive --all            archive every audiobook loan
//   libby archive --title <id>     archive one title
//   libby auth                     verify authentication only
//   libby where                    print config + session file locations
//
// Config resolution: flags > env > local ./config.json > ~/.config/libby-archiver/config.json
//   --card <n>      library card number      (env LIBBY_CARD)
//   --pin <n>       card PIN, if any         (env LIBBY_PIN)
//   --library <k>   library key, e.g your-library (env LIBBY_LIBRARY)
//   --website <id>  website id, e.g. 123     (env LIBBY_WEBSITE)
//   --out <dir>     output directory         (env LIBBY_OUT)   default ./archive
//   --session <f>   session cache file
//   --insecure-tls  disable TLS verification (for the mismatched-cert edge)

import process from 'node:process';
import { authenticate } from '../src/auth.mjs';
import { sync, audiobookLoans } from '../src/loans.mjs';
import { archiveAudiobook } from '../src/archive.mjs';
import { searchCatalog } from '../src/search.mjs';
import { getAvailability, getTitle } from '../src/discover.mjs';
import { borrowTitle, returnTitle, placeHold, cancelHold } from '../src/checkout.mjs';
import { SentryError } from '../src/sentry.mjs';
import { runInit } from '../src/init.mjs';
import { loadConfig, configPath, sessionPath } from '../src/config.mjs';

const HELP = `libby — search, borrow, and archive Libby / OverDrive audiobooks (browser-free)

Usage:
  libby init                     interactive setup — run this first
  libby search <terms>           search your library's catalog
  libby info <id>                full catalog detail for a title
  libby avail <id...>            real-time availability (copies, holds, wait)
  libby borrow <id>              check out a title (id from search)
  libby return <id>              return a loan early
  libby hold <id>                place a hold on an unavailable title
  libby unhold <id>              cancel a hold
  libby list                     list your current audiobook loans
  libby archive --all            archive every audiobook loan
  libby archive --title <id>     archive a single title by id
  libby auth                     verify authentication only
  libby where                    show config + session locations
  libby help                     show this help

Search/borrow options:
  --format <audiobook|ebook|magazine|all>   filter/borrow format (default audiobook)
  --available                               search: only titles available now
  --lucky-day                               borrow: take a Lucky Day copy if offered
  --period <days>                           borrow: lending period (default: preferred)

Config options (override saved config):
  --card <n>  --pin <n>  --library <key>  --website <id>
  --out <dir>  --session <file>  --insecure-tls

First time? Run  libby init`;

function parseArgs(argv) {
  const args = { _: [] };
  const flags = new Set(['insecure-tls', 'all', 'available', 'lucky-day']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && flags.has(a.slice(2))) {
      args[a.slice(2) === 'insecure-tls' ? 'insecureTLS' : a.slice(2).replace(/-/g, '')] = true;
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

/** Word-wrap text to `width` columns, prefixing each line with `indent`. */
function wrap(text, width = 78, indent = '') {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line && (line + ' ' + word).length > width) {
        out.push(indent + line);
        line = word;
      } else line = line ? line + ' ' + word : word;
    }
    out.push(indent + line);
  }
  return out.join('\n');
}

/** Resolve just the library key (for auth-free commands like search). */
function resolveLibraryKey(args) {
  const file = loadConfig();
  const library = args.library ?? process.env.LIBBY_LIBRARY ?? file.library;
  if (!library) {
    console.error('No library configured. Run `libby init`, or pass --library <key>.');
    process.exit(2);
  }
  return { library, insecureTLS: args.insecureTLS ?? file.insecureTLS ?? false };
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

  // search needs no card / auth — just the library key.
  if (command === 'search') {
    const terms = args._.slice(1).join(' ').trim();
    if (!terms) {
      console.error('Usage: libby search <terms>  [--format audiobook|ebook|all] [--available]');
      process.exit(2);
    }
    const { library, insecureTLS } = resolveLibraryKey(args);
    const { total, items } = await searchCatalog(library, terms, {
      format: args.format ?? 'audiobook',
      availableOnly: !!args.available,
      insecureTLS,
    });
    if (!items.length) return console.log(`No results for "${terms}".`);
    console.log(`${items.length} of ${total} result(s) for "${terms}":\n`);
    for (const it of items) {
      const avail = it.available
        ? 'available now'
        : `${it.holds} hold(s)` + (it.ownedCopies ? ` on ${it.ownedCopies} cop(y/ies)` : '');
      console.log(`  ${it.id}  ${it.title}${it.author ? ` — ${it.author}` : ''}`);
      console.log(`        ${it.type}${it.year ? `, ${it.year}` : ''} · ${avail}`);
    }
    console.log(`\nBorrow one with:  libby borrow <id>`);
    return;
  }

  // info <id> — full catalog detail (auth-free).
  if (command === 'info') {
    const id = args._[1] ?? args.title;
    if (!id) {
      console.error('Usage: libby info <id>   (id from `libby search`)');
      process.exit(2);
    }
    const { library, insecureTLS } = resolveLibraryKey(args);
    const t = await getTitle(library, String(id), { insecureTLS });
    const a = t.availability;
    const availLine = a.available
      ? `available now (${a.availableCopies}/${a.ownedCopies} copies)`
      : `${a.holds} hold(s) on ${a.ownedCopies} cop(y/ies)` +
        (a.estimatedWaitDays ? `, ~${a.estimatedWaitDays} day wait` : '');
    console.log(`\n${t.title}${t.subtitle ? `: ${t.subtitle}` : ''}`);
    if (t.author) console.log(`  by ${t.author}`);
    const meta = [t.type, t.year, t.edition, t.languages.join('/')].filter(Boolean).join(' · ');
    if (meta) console.log(`  ${meta}`);
    if (t.publisher) console.log(`  ${t.publisher}`);
    if (t.starRating) console.log(`  ★ ${t.starRating} (${t.starRatingCount ?? 0} ratings)`);
    console.log(`  ${availLine}`);
    if (t.formats.length) console.log(`  formats: ${t.formats.join(', ')}`);
    if (t.subjects.length) console.log(`  subjects: ${t.subjects.slice(0, 8).join(', ')}`);
    if (t.characteristics?.length) console.log(`  themes: ${t.characteristics.join(', ')}`);
    if (t.isbns.length) console.log(`  ISBN: ${t.isbns.join(', ')}`);
    if (t.description) console.log(`\n${wrap(t.description, 78, '  ')}`);
    console.log(`\nBorrow with:  libby borrow ${t.id}`);
    return;
  }

  // avail <id...> — real-time availability for one or more titles (auth-free).
  if (command === 'avail') {
    const ids = args._.slice(1);
    if (!ids.length) {
      console.error('Usage: libby avail <id> [<id> ...]');
      process.exit(2);
    }
    const { library, insecureTLS } = resolveLibraryKey(args);
    const rows = await getAvailability(library, ids, { insecureTLS });
    for (const r of rows) {
      const status = r.available
        ? `available now — ${r.availableCopies}/${r.ownedCopies} copies` +
          (r.luckyDayAvailableCopies ? ` (+${r.luckyDayAvailableCopies} Lucky Day)` : '')
        : `${r.holds} hold(s) on ${r.ownedCopies} cop(y/ies)` +
          (r.estimatedWaitDays ? `, ~${r.estimatedWaitDays} day wait` : '') +
          (r.isHoldable ? '' : ' · not holdable');
      console.log(`  ${r.id}  ${status}`);
    }
    return;
  }

  const cfg = buildConfig(args);
  const { client, identity, cardId } = await authenticate(cfg);

  if (command === 'auth') {
    console.log(`Authenticated. cardId=${cardId}`);
    return;
  }

  // Account-mutating commands: borrow / return / hold / unhold. Each takes a title id.
  if (['borrow', 'return', 'hold', 'unhold'].includes(command)) {
    const titleId = args._[1] ?? args.title;
    if (!titleId) {
      console.error(`Usage: libby ${command} <id>   (find ids with \`libby search\`)`);
      process.exit(2);
    }
    try {
      if (command === 'borrow') {
        const loan = await borrowTitle(client, identity, cardId, String(titleId), {
          titleFormat: args.format ?? 'audiobook',
          luckyDay: !!args.luckyday,
          period: args.period ? Number(args.period) : undefined,
          units: args.period ? 'days' : undefined,
        });
        console.log(`Borrowed: ${loan.title}${loan.firstCreatorName ? ` — ${loan.firstCreatorName}` : ''}`);
        console.log(`  due ${loan.expireDate ?? loan.expires ?? '?'}  (checkoutId ${loan.checkoutId})`);
        console.log(`\nArchive it with:  libby archive --title ${titleId}`);
      } else if (command === 'return') {
        await returnTitle(client, identity, cardId, String(titleId));
        console.log(`Returned title ${titleId}.`);
      } else if (command === 'hold') {
        const hold = await placeHold(client, identity, cardId, String(titleId));
        const pos = hold?.holdListPosition;
        console.log(`Hold placed on title ${titleId}${pos ? ` (position ${pos})` : ''}.`);
      } else {
        await cancelHold(client, identity, cardId, String(titleId));
        console.log(`Hold cancelled on title ${titleId}.`);
      }
    } catch (e) {
      console.error(`${command} failed: ${e.message}`);
      if (e instanceof SentryError && e.result === 'whoa') {
        console.error('Rate-limited by OverDrive ("whoa"). Stop and retry later.');
      }
      process.exit(1);
    }
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
