// Orchestrate archiving one audiobook loan into a self-contained folder:
//
//   <Author> - <Title>/
//     Part 01.mp3 ... Part NN.mp3      raw spine parts (no re-encode)
//     cover.jpg                        max-resolution cover
//     openbook.json                    raw openbook manifest (spine + nav/toc)
//     passport.json                    raw open passport
//     loan.json                        raw loan record from sync
//     thunder.json                     raw Thunder catalog metadata
//     metadata.json                    normalized summary
//     manifest.sha256                  SHA-256 of every file for integrity
//     README.txt                       provenance note
//
// Nothing is re-muxed; the .mp3 files are exactly what OverDrive serves.

import fs from 'node:fs';
import path from 'node:path';
import { openLoan, fetchOpenbook, extractSpine } from './openbook.mjs';
import { downloadPart } from './download.mjs';
import { mapLimit } from './pool.mjs';
import { fetchThunderMedia, maxResCoverUrl, downloadCover } from './metadata.mjs';
import {
  pad,
  sanitize,
  claimBookDir,
  writeJson,
  writeManifest,
  decodeEntities,
  cleanDescription,
  extractIsbns,
  generatorInfo,
} from './util.mjs';

/**
 * @param {object} ctx   { client, identity, cfg, log }
 * @param {Loan} loan
 * @param {string} outDir   base output directory
 */
export async function archiveAudiobook(ctx, loan, outDir) {
  const { client, identity, cfg } = ctx;
  const log = ctx.log ?? (() => {});

  const { bookDir, folder } = claimBookDir(outDir, loan);
  log(`\n=> ${folder}`);

  // 1. open -> passport
  log('   opening loan...');
  const passport = await openLoan(client, identity, loan, cfg);
  writeJson(path.join(bookDir, 'passport.json'), passport, { secret: true });

  // 2. establish listen session, decode the embedded openbook -> spine
  log('   decoding openbook...');
  const { openbook, web, cookie } = await fetchOpenbook(passport, {
    insecureTLS: cfg.insecureTLS,
  });
  writeJson(path.join(bookDir, 'openbook.json'), openbook);
  const spine = extractSpine(openbook, web);
  if (!spine.length) throw new Error('decoded openbook had no spine parts');
  log(`   ${spine.length} spine part(s)`);

  // 3. raw loan record
  writeJson(path.join(bookDir, 'loan.json'), loan.raw, { secret: true });

  // 4. supplementary metadata + cover — started (not awaited) so both catalog round
  // trips run while the parts download below; each is awaited where its result is first
  // needed (thunder at step 6, the cover before the manifest). fetchThunderMedia never
  // throws (null on failure), and cover failures are caught + logged exactly as before.
  log('   fetching catalog metadata...');
  const thunderP = fetchThunderMedia(cfg.library, loan.id, {
    insecureTLS: cfg.insecureTLS,
  }).catch(() => null);
  const coverP = thunderP.then(async (thunder) => {
    const coverUrl = maxResCoverUrl(thunder, loan.coverUrl);
    if (coverUrl) {
      try {
        await downloadCover(coverUrl, path.join(bookDir, 'cover.jpg'), {
          insecureTLS: cfg.insecureTLS,
        });
        log('   cover saved');
      } catch (e) {
        log(`   cover failed: ${e.message}`);
      }
    }
  });

  // 5. download spine parts — 3 at a time (bounded, CDN-polite); parts are independent
  // files, and mapLimit keeps partFiles in spine order for the manifest. downloadPart
  // hashes while streaming, so we keep those digests and the manifest pass (step 7)
  // can skip re-reading the parts — on a large audiobook that's the whole book.
  const partHashes = {};
  const partFiles = await mapLimit(spine, 3, async (part) => {
    const name = `Part ${pad(part.index)}.mp3`;
    const dest = path.join(bookDir, name);
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (have > 0 && (!part.size || have === part.size)) {
      log(`   ${name} already present, skipping`);
      return dest;
    }
    if (have > 0) log(`   ${name} is ${have} bytes (expected ${part.size}), re-downloading`);
    log(`   downloading ${name} ...`);
    const { bytes, sha256 } = await downloadPart(part, dest, {
      cookie,
      insecureTLS: cfg.insecureTLS,
    });
    partHashes[name] = sha256;
    log(`   ${name}: ${(bytes / 1e6).toFixed(1)} MB`);
    return dest;
  });

  // 6. normalized metadata summary (openbook is authoritative for audio structure)
  const thunder = await thunderP; // first result needed here — long since settled
  if (thunder) writeJson(path.join(bookDir, 'thunder.json'), thunder);
  const creators = openbook.creator ?? [];
  const roleNames = (re) => creators.filter((c) => re.test(c.role ?? '')).map((c) => c.name);
  const spineToIndex = spine.map((p) => p.path);
  const chapters = (openbook.nav?.toc ?? []).map((c) => ({
    title: decodeEntities(c.title),
    part: spineToIndex.indexOf((c.path || '').split('#')[0]) + 1 || null,
    // toc paths carry the chapter start time in the URL fragment (e.g.
    // "#0.00000-119.00000") — kept verbatim so future remuxing loses nothing
    offset: (c.path || '').split('#')[1] || null,
  }));
  writeJson(path.join(bookDir, 'metadata.json'), {
    titleId: loan.id,
    cardId: loan.cardId,
    library: cfg.library,
    libraryName: cfg.libraryName ?? cfg.library,
    generator: generatorInfo(),
    title: openbook.title?.main ?? loan.title,
    subtitle: openbook.title?.subtitle ?? loan.subtitle,
    author: roleNames(/author/i).join(', ') || loan.author,
    narrators: roleNames(/narrat/i),
    publisher: thunder?.publisher?.name,
    description: cleanDescription(openbook.description) || thunder?.description,
    language: openbook.language,
    subjects: (thunder?.subjects ?? []).map((s) => s.name),
    isbns: extractIsbns(thunder?.formats),
    durationSeconds: spine.reduce((a, p) => a + (Number(p.duration) || 0), 0),
    parts: spine.length,
    chapters,
    expires: loan.expires,
    archivedAt: new Date().toISOString(),
  });

  // 7. integrity manifest + README — README is written first so the manifest covers
  // every file in the folder; parts arrive pre-hashed (step 5) and the cover is
  // settled (step 4), so only the small sidecars are re-read here
  await coverP; // cover.jpg must be complete before it is hashed
  fs.writeFileSync(
    path.join(bookDir, 'README.txt'),
    readmeText(loan, spine.length),
    'utf8',
  );
  await writeManifest(bookDir, { known: partHashes });

  log(`   done: ${bookDir}`);
  return bookDir;
}

function readmeText(loan, parts) {
  return [
    `Title:   ${loan.title}${loan.subtitle ? ` (${loan.subtitle})` : ''}`,
    `Author:  ${loan.author ?? 'Unknown'}`,
    `TitleId: ${loan.id}   CardId: ${loan.cardId}`,
    `Parts:   ${parts} raw MP3 spine part(s), exactly as served by OverDrive (no re-encode).`,
    ``,
    `Sidecars:`,
    `  openbook.json  - raw openbook manifest (spine, nav/toc, chapter markers)`,
    `  passport.json  - raw open passport (fulfillment URLs, expiry)`,
    `  loan.json      - raw loan record`,
    `  thunder.json   - raw OverDrive catalog metadata`,
    `  metadata.json  - normalized summary`,
    `  cover.jpg      - highest-resolution cover art`,
    `  manifest.sha256 - integrity hashes for every file`,
    ``,
    `Archived ${new Date().toISOString()} by libby-archiver.`,
  ].join('\n');
}
