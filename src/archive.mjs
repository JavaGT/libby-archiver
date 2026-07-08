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
import crypto from 'node:crypto';
import { openLoan, fetchOpenbook, extractSpine } from './openbook.mjs';
import { downloadPart } from './download.mjs';
import { fetchThunderMedia, maxResCoverUrl, downloadCover } from './metadata.mjs';

const pad = (n, w = 2) => String(n).padStart(w, '0');

const sanitize = (s) =>
  (s ?? '')
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'Untitled';

/**
 * @param {object} ctx   { client, identity, cfg, log }
 * @param {Loan} loan
 * @param {string} outDir   base output directory
 */
export async function archiveAudiobook(ctx, loan, outDir) {
  const { client, identity, cfg } = ctx;
  const log = ctx.log ?? (() => {});

  const folder = `${sanitize(loan.author ?? 'Unknown Author')} - ${sanitize(loan.title)}`;
  const bookDir = path.join(outDir, folder);
  fs.mkdirSync(bookDir, { recursive: true });
  log(`\n=> ${folder}`);

  // 1. open -> passport
  log('   opening loan...');
  const passport = await openLoan(client, identity, loan, cfg);
  writeJson(path.join(bookDir, 'passport.json'), passport);

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
  writeJson(path.join(bookDir, 'loan.json'), loan.raw);

  // 4. supplementary metadata + cover
  log('   fetching catalog metadata...');
  const thunder = await fetchThunderMedia(cfg.library, loan.id, {
    insecureTLS: cfg.insecureTLS,
  });
  if (thunder) writeJson(path.join(bookDir, 'thunder.json'), thunder);
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

  // 5. download spine parts
  const partFiles = [];
  for (const part of spine) {
    const name = `Part ${pad(part.index)}.mp3`;
    const dest = path.join(bookDir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      log(`   ${name} already present, skipping`);
      partFiles.push(dest);
      continue;
    }
    process.stdout.write(`   downloading ${name} ...`);
    const { bytes } = await downloadPart(part, dest, {
      cookie,
      insecureTLS: cfg.insecureTLS,
    });
    process.stdout.write(` ${(bytes / 1e6).toFixed(1)} MB\n`);
    partFiles.push(dest);
  }

  // 6. normalized metadata summary (openbook is authoritative for audio structure)
  const creators = openbook.creator ?? [];
  const roleNames = (re) => creators.filter((c) => re.test(c.role ?? '')).map((c) => c.name);
  const spineToIndex = spine.map((p) => p.path);
  const chapters = (openbook.nav?.toc ?? []).map((c) => ({
    title: decodeEntities(c.title),
    part: spineToIndex.indexOf((c.path || '').split('#')[0]) + 1 || null,
  }));
  writeJson(path.join(bookDir, 'metadata.json'), {
    titleId: loan.id,
    cardId: loan.cardId,
    title: openbook.title?.main ?? loan.title,
    subtitle: openbook.title?.subtitle ?? loan.subtitle,
    author: roleNames(/author/i).join(', ') || loan.author,
    narrators: roleNames(/narrat/i),
    publisher: thunder?.publisher?.name,
    description: cleanDescription(openbook.description) || thunder?.description,
    language: openbook.language,
    subjects: (thunder?.subjects ?? []).map((s) => s.name),
    isbns: extractIsbns(thunder),
    durationSeconds: spine.reduce((a, p) => a + (Number(p.duration) || 0), 0),
    parts: spine.length,
    chapters,
    expires: loan.expires,
    archivedAt: new Date().toISOString(),
  });

  // 7. integrity manifest + README
  writeManifest(bookDir);
  fs.writeFileSync(
    path.join(bookDir, 'README.txt'),
    readmeText(loan, spine.length),
    'utf8',
  );

  log(`   done: ${bookDir}`);
  return bookDir;
}

/** openbook.description is { full, short } with HTML; return clean full text. */
function cleanDescription(desc) {
  const raw = typeof desc === 'string' ? desc : desc?.full ?? desc?.short;
  if (!raw) return undefined;
  return decodeEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}

function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractIsbns(thunder) {
  const formats = thunder?.formats ?? [];
  const ids = [];
  for (const f of formats) for (const id of f.identifiers ?? []) {
    if (/ISBN/i.test(id.type ?? '')) ids.push(id.value);
  }
  return [...new Set(ids)];
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/** Write manifest.sha256 covering every file in the dir except itself. */
function writeManifest(dir) {
  const lines = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === 'manifest.sha256') continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    lines.push(`${hash}  ${name}`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.sha256'), lines.join('\n') + '\n', 'utf8');
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
