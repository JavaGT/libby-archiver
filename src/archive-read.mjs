// Orchestrate archiving one ebook / magazine loan into a self-contained folder:
//
//   <Author> - <Title>/
//     <Title>.epub                     assembled, ready-to-read (fixed-layout for magazines)
//     pages/*.xhtml                     decoded page bodies (raw, exactly as decoded)
//     assets/*.jpg                      plaintext page/image assets
//     cover.jpg                         max-resolution cover
//     openbook.json / passport.json / loan.json / thunder.json
//     metadata.json                    normalized summary
//     manifest.sha256                  integrity hashes
//     README.txt                       provenance note
//
// Pages come off the read host ciphered with __bif_cfc1 (see read.mjs); assets are plaintext.
//
// Payloads are never retained in memory: every decoded page/asset/cover is written to
// bookDir first, and the EPUB entries hold disk-backed thunks (data: () => fs.readFileSync)
// that the streaming zip writer resolves one entry at a time. The on-disk copy is the
// source of truth — if a payload file vanishes between write and assembly, the read throws
// and the archive fails loudly (no partial EPUB is left behind).

import fs from 'node:fs';
import path from 'node:path';
import { openLoan, fetchOpenbook, extractSpine, openKindFor } from './openbook.mjs';
import { fetchPage, fetchReadResource, assetRefs } from './read.mjs';
import { writeEpub } from './epub.mjs';
import { fetchThunderMedia, maxResCoverUrl, downloadCover } from './metadata.mjs';
import { mapLimit } from './pool.mjs';
import {
  assetName,
  safeJoin,
  sanitize,
  claimBookDir,
  writeJson,
  writeManifest,
  cleanDescription,
  extractIsbns,
} from './util.mjs';

/**
 * @param {object} ctx   { client, identity, cfg, log }
 * @param {Loan} loan    an ebook or magazine loan
 * @param {string} outDir
 */
export async function archiveReadable(ctx, loan, outDir) {
  const { client, identity, cfg } = ctx;
  const log = ctx.log ?? (() => {});
  const kind = openKindFor(loan); // 'magazine' | 'book'

  const { bookDir, folder } = claimBookDir(outDir, loan);
  const assetsDir = path.join(bookDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true }); // pages create their own dirs from their paths
  log(`\n=> ${folder}  [${loan.type}]`);

  // 1. open -> passport
  log('   opening loan...');
  const passport = await openLoan(client, identity, loan, cfg, kind);
  writeJson(path.join(bookDir, 'passport.json'), passport, { secret: true });

  // 2. read session + embedded openbook -> spine of page components
  log('   decoding openbook...');
  const { openbook, web, cookie } = await fetchOpenbook(passport, { insecureTLS: cfg.insecureTLS });
  writeJson(path.join(bookDir, 'openbook.json'), openbook);
  const spine = extractSpine(openbook, web);
  if (!spine.length) throw new Error('decoded openbook had no spine pages');
  const fixedLayout = (openbook.spine ?? []).some((p) => p['rendition-layout'] === 'pre-paginated');
  log(`   ${spine.length} page(s)${fixedLayout ? ', fixed-layout' : ''}`);

  writeJson(path.join(bookDir, 'loan.json'), loan.raw, { secret: true });

  // 3. catalog metadata + cover — started (not awaited) so both round trips run while
  // the pages/assets download below; thunder is awaited before the EPUB/metadata writes
  // and coverEntry before assembly. fetchThunderMedia never throws (null on failure),
  // and cover failures are caught + logged exactly as before.
  log('   fetching catalog metadata...');
  const thunderP = fetchThunderMedia(cfg.library, loan.id, { insecureTLS: cfg.insecureTLS }).catch(() => null);
  let coverEntry = null;
  const coverP = thunderP.then(async (thunder) => {
    const coverUrl = maxResCoverUrl(thunder, loan.coverUrl);
    if (coverUrl) {
      try {
        const coverPath = path.join(bookDir, 'cover.jpg');
        await downloadCover(coverUrl, coverPath, { insecureTLS: cfg.insecureTLS });
        coverEntry = { path: 'cover.jpg', data: () => fs.readFileSync(coverPath) };
        log('   cover saved');
      } catch (e) {
        log(`   cover failed: ${e.message}`);
      }
    }
  });

  // 4. fetch + decode pages — 4 at a time (otherwise a magazine is hundreds of serial
  // round trips); mapLimit keeps pageEntries in spine order. Logs report decoded pages.
  // Page paths come from the openbook — they are validated to stay inside bookDir.
  // Each body lives only for this callback: written to disk, refs collected, then dropped —
  // assembly re-reads pages off disk via the entry thunks.
  const pageEntries = await mapLimit(spine, 4, async (part) => {
    const body = await fetchPage(part, { cookie, insecureTLS: cfg.insecureTLS });
    // keep each page at its original openbook path so relative ../assets refs stay correct
    const dest = safeJoin(bookDir, part.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
    log(`   decoded page ${part.index}/${spine.length}`);
    return {
      path: part.path,
      viewport: viewportOf(openbook, part),
      data: () => fs.readFileSync(dest),
      refs: [...assetRefs(body)], // asset paths, in body order (kept; bodies are not)
    };
  });

  // assets referenced by any decoded page, in first-seen page order
  const wantedAssets = new Set();
  for (const { refs } of pageEntries) for (const ref of refs) wantedAssets.add(ref); // normalized 'assets/xxx.jpg'

  // 5. fetch each unique asset (plaintext) — 4 at a time; like pages, the body is written
  // to disk and dropped, and the EPUB entry re-reads it lazily
  const assetList = [...wantedAssets];
  const assetEntries = (
    await mapLimit(assetList, 4, async (ref, i) => {
      const name = assetName(ref);
      log(`   fetching asset ${i + 1}/${assetList.length} (${name}) ...`);
      const res = await fetchReadResource(web.replace(/\/$/, '') + '/' + ref, {
        cookie,
        insecureTLS: cfg.insecureTLS,
      });
      if (res.status !== 200) {
        log(`   asset ${ref} -> HTTP ${res.status} (skipped)`);
        return null;
      }
      const dest = path.join(assetsDir, name);
      fs.writeFileSync(dest, res.body);
      return { path: `assets/${name}`, data: () => fs.readFileSync(dest) };
    })
  ).filter(Boolean);

  // 6. assemble the EPUB — streamed to disk entry by entry; each payload thunk reads its
  // page/asset off bookDir, so no more than one entry is resident at a time. The catalog
  // work from step 3 is collected here (it ran concurrently with the downloads above).
  log('   assembling EPUB...');
  const thunder = await thunderP;
  await coverP; // coverEntry must be settled before assembly decides whether it is included
  if (thunder) writeJson(path.join(bookDir, 'thunder.json'), thunder);
  const creators = openbook.creator ?? [];
  const author = creators.find((c) => /aut/i.test(c.role ?? ''))?.name || creators[0]?.name || loan.author;
  const epubName = `${sanitize(openbook.title?.main ?? loan.title)}.epub`;
  const epubPath = path.join(bookDir, epubName);
  const { bytes, sha256 } = await writeEpub({
    meta: {
      identifier: openbook['-odread-buid'] || `libby-${loan.id}`,
      title: openbook.title?.main ?? loan.title,
      subtitle: openbook.title?.subtitle || loan.subtitle,
      creator: author,
      language: Array.isArray(openbook.language) ? openbook.language[0] : openbook.language,
      description: cleanDescription(openbook.description) || cleanDescription(thunder?.description),
    },
    spine: pageEntries,
    assets: assetEntries,
    cover: coverEntry,
    nav: buildNav(openbook, new Set(spine.map((s) => s.path))),
    fixedLayout,
  }, epubPath);
  log(`   ${(bytes / 1e6).toFixed(1)} MB EPUB`);

  // 7. normalized metadata + integrity + README — the EPUB was hashed while streaming
  // (writeZip), so the manifest skips re-reading it; for a big magazine that is the
  // largest file in the archive. The rel path is the EPUB's basename.
  writeJson(path.join(bookDir, 'metadata.json'), {
    titleId: loan.id,
    cardId: loan.cardId,
    type: loan.type,
    title: openbook.title?.main ?? loan.title,
    subtitle: openbook.title?.subtitle || loan.subtitle,
    author,
    publisher: creators.find((c) => /pbl/i.test(c.role ?? ''))?.name || thunder?.publisher?.name,
    description: cleanDescription(openbook.description) || cleanDescription(thunder?.description),
    language: openbook.language,
    pages: spine.length,
    assets: assetEntries.length,
    fixedLayout,
    subjects: (thunder?.subjects ?? []).map((s) => s.name),
    isbns: extractIsbns(thunder?.formats),
    expires: loan.expires,
    archivedAt: new Date().toISOString(),
  });
  await writeManifest(bookDir, { known: { [epubName]: sha256 } });
  fs.writeFileSync(path.join(bookDir, 'README.txt'), readmeText(loan, spine.length, assetEntries.length), 'utf8');

  log(`   done: ${bookDir}`);
  return bookDir;
}

/** Per-page viewport for fixed-layout rendering (from the spine entry). */
function viewportOf(openbook, part) {
  const s = (openbook.spine ?? [])[part.index - 1];
  const vp = s?.['rendition-viewport'];
  return vp?.width && vp?.height ? { width: vp.width, height: vp.height } : undefined;
}

/** Build TOC entries from openbook.nav.toc, resolving each to a real spine page. */
function buildNav(openbook, spinePaths) {
  const out = [];
  for (const e of openbook.nav?.toc ?? []) {
    let href = (e.path || '').split('#')[0];
    if (!spinePaths.has(href)) {
      // magazines anchor TOC to story files; map via the printed page number instead
      const n = String(e.pageRange || '').match(/\d+/)?.[0];
      const guess = n && `pages/${n}.xhtml`;
      href = guess && spinePaths.has(guess) ? guess : null;
    }
    if (href) out.push({ title: e.title || e.sectionName || e.pageRange || href, href });
  }
  return out;
}

function readmeText(loan, pages, assets) {
  return [
    `Title:   ${loan.title}${loan.subtitle ? ` (${loan.subtitle})` : ''}`,
    `Author:  ${loan.author ?? 'Unknown'}`,
    `TitleId: ${loan.id}   CardId: ${loan.cardId}   Type: ${loan.type}`,
    `Content: ${pages} page(s), ${assets} asset(s), decoded from the read host (__bif_cfc1).`,
    ``,
    `Files:`,
    `  <Title>.epub   - assembled EPUB (fixed-layout for magazines)`,
    `  pages/*.xhtml  - decoded page bodies, exactly as decoded`,
    `  assets/*.jpg   - plaintext page/image assets`,
    `  cover.jpg      - highest-resolution cover art`,
    `  openbook.json  - raw openbook manifest (spine, nav/toc)`,
    `  passport.json  - raw open passport`,
    `  loan.json      - raw loan record`,
    `  thunder.json   - raw OverDrive catalog metadata`,
    `  metadata.json  - normalized summary`,
    `  manifest.sha256 - integrity hashes for every file`,
    ``,
    `Archived ${new Date().toISOString()} by libby-archiver.`,
  ].join('\n');
}
