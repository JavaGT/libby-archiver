// Capture real OverDrive payloads for payload-documentation purposes.
//   node perf/collect-payloads.mjs [--out sample-data] [--limit 3]
//
// Requires a working config (`libby init`). Picks up to one loan per format
// (audiobook, ebook, magazine), opens each, and saves EVERY raw payload we
// receive — sync, loan, passport, player page, openbook (+ siblings), thunder —
// WITHOUT downloading any MP3/page content. Output stays out of git (see
// .gitignore): loan/passport records carry account identifiers.

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { authenticate } from '../src/auth.mjs';
import { sync } from '../src/loans.mjs';
import { openLoan, fetchOpenbook, probeEData } from '../src/openbook.mjs';
import { fetchThunderMedia } from '../src/metadata.mjs';
import { loadConfig, sessionPath } from '../src/config.mjs';
import { generatorInfo } from '../src/util.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
};
const outDir = path.resolve(arg('out', 'sample-data'));
const limit = Number(arg('limit', 3));
const insecureTLS = process.argv.includes('--insecure-tls');

const cfg = loadConfig();
if (!cfg.cardNumber || !cfg.library || !cfg.websiteId) {
  console.error('No working config — run `libby init` first.');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const save = (dir, name, data) => {
  fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.log(`   saved ${name}`);
};

const { client, identity, cardId } = await authenticate({ ...cfg, sessionFile: sessionPath() });
console.log(`authenticated (card ${cardId})`);

// 1. the whole account sync payload
const syncRaw = (await sync(client, identity)).raw;
save(outDir, '_sync.json', syncRaw);

// 2. pick loans: first of each format, up to --limit
const picks = [];
for (const type of ['audiobook', 'ebook', 'magazine']) {
  const loan = (syncRaw.loans ?? []).find((l) => l.type?.id === type);
  if (loan) picks.push(loan);
}
const chosen = picks.slice(0, limit);
if (!chosen.length) {
  console.error('No loans on this account to sample.');
  process.exit(1);
}
console.log(`sampling ${chosen.length} loan(s): ${chosen.map((l) => l.title).join(' | ')}`);

const probe = {
  captured: new Date().toISOString(),
  generator: generatorInfo(),
  note: 'CONTAINS ACCOUNT DATA — never commit this directory.',
  items: [],
};

for (const loanRaw of chosen) {
  const loan = {
    id: String(loanRaw.id),
    cardId: String(loanRaw.cardId),
    title: loanRaw.title,
    subtitle: loanRaw.subtitle,
    author: loanRaw.firstCreatorName,
    type: loanRaw.type?.id ?? 'unknown',
    expires: loanRaw.expires,
    coverUrl: (loanRaw.covers?.cover510Wide ?? loanRaw.covers?.cover300Wide)?.href,
    raw: loanRaw,
  };
  const dir = path.join(outDir, `${loan.type}-${loan.id}`);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n=> ${loan.type}: ${loan.title}`);

  const passport = await openLoan(client, identity, loan, cfg);
  save(dir, 'passport.json', passport);

  const { openbook, extra, web, buid, html } = await fetchOpenbook(passport, {
    insecureTLS: cfg.insecureTLS,
  });
  save(dir, 'player-page.html', html);
  save(dir, 'openbook.json', openbook);
  if (extra && Object.keys(extra).length) save(dir, 'openbook-extra.json', extra);

  const item = { type: loan.type, id: loan.id, web, buid, playerPageBytes: html.length };
  // validate the drift probe against the real page while we have it
  const stages = probeEData(html, buid);
  item.eDataProbe = { ok: stages.ok, stages: stages.stages.map((s) => ({ stage: s.stage, ok: s.ok, ...(s.detail ? { detail: s.detail } : {}) })) };

  const thunder = await fetchThunderMedia(cfg.library, loan.id, { insecureTLS });
  if (thunder) save(dir, 'thunder.json', thunder);
  else item.thunderMissing = true;

  save(dir, 'loan.json', loan.raw);
  probe.items.push(item);
}

save(outDir, '_probe.json', probe);
console.log(`\ndone — payloads in ${outDir} (gitignored; contains account data)`);
