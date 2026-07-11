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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openLoan, fetchOpenbook, extractSpine, openKindFor } from './openbook.mjs';
import { fetchPage, fetchReadResource, assetRefs } from './read.mjs';
import { buildEpub } from './epub.mjs';
import { fetchThunderMedia, maxResCoverUrl, downloadCover } from './metadata.mjs';

const pad = (n, w) => String(n).padStart(w, '0');

const sanitize = (s) =>
  (s ?? '')
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'Untitled';

/**
 * @param {object} ctx   { client, identity, cfg, log }
 * @param {Loan} loan    an ebook or magazine loan
 * @param {string} outDir
 */
export async function archiveReadable(ctx, loan, outDir) {
  const { client, identity, cfg } = ctx;
  const log = ctx.log ?? (() => {});
  const kind = openKindFor(loan); // 'magazine' | 'book'

  const folder = `${sanitize(loan.author ?? 'Unknown Author')} - ${sanitize(loan.title)}`;
  const bookDir = path.join(outDir, folder);
  const assetsDir = path.join(bookDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true }); // pages create their own dirs from their paths
  log(`\n=> ${folder}  [${loan.type}]`);

  // 1. open -> passport
  log('   opening loan...');
  const passport = await openLoan(client, identity, loan, cfg, kind);
  writeJson(path.join(bookDir, 'passport.json'), passport);

  // 2. read session + embedded openbook -> spine of page components
  log('   decoding openbook...');
  const { openbook, web, cookie } = await fetchOpenbook(passport, { insecureTLS: cfg.insecureTLS });
  writeJson(path.join(bookDir, 'openbook.json'), openbook);
  const spine = extractSpine(openbook, web);
  if (!spine.length) throw new Error('decoded openbook had no spine pages');
  const fixedLayout = (openbook.spine ?? []).some((p) => p['rendition-layout'] === 'pre-paginated');
  log(`   ${spine.length} page(s)${fixedLayout ? ', fixed-layout' : ''}`);

  writeJson(path.join(bookDir, 'loan.json'), loan.raw);

  // 3. catalog metadata + cover
  log('   fetching catalog metadata...');
  const thunder = await fetchThunderMedia(cfg.library, loan.id, { insecureTLS: cfg.insecureTLS });
  if (thunder) writeJson(path.join(bookDir, 'thunder.json'), thunder);
  let coverEntry = null;
  const coverUrl = maxResCoverUrl(thunder, loan.coverUrl);
  if (coverUrl) {
    try {
      const coverPath = path.join(bookDir, 'cover.jpg');
      await downloadCover(coverUrl, coverPath, { insecureTLS: cfg.insecureTLS });
      coverEntry = { path: 'cover.jpg', data: fs.readFileSync(coverPath) };
      log('   cover saved');
    } catch (e) {
      log(`   cover failed: ${e.message}`);
    }
  }

  // 4. fetch + decode every page; gather referenced assets
  const width = String(spine.length).length;
  const pageEntries = [];
  const wantedAssets = new Set();
  for (const part of spine) {
    process.stdout.write(`\r   decoding page ${pad(part.index, width)}/${spine.length} ...`);
    const body = await fetchPage(part, { cookie, insecureTLS: cfg.insecureTLS });
    // keep each page at its original openbook path so relative ../assets refs stay correct
    const dest = path.join(bookDir, part.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
    for (const ref of assetRefs(body)) wantedAssets.add(ref); // normalized 'assets/xxx.jpg'
    pageEntries.push({ path: part.path, body, viewport: viewportOf(openbook, part) });
  }
  process.stdout.write('\n');

  // 5. fetch each unique asset (plaintext)
  const assetEntries = [];
  let i = 0;
  for (const ref of wantedAssets) {
    i++;
    const name = ref.split('/').pop();
    process.stdout.write(`\r   fetching asset ${i}/${wantedAssets.size} ...`);
    const res = await fetchReadResource(web.replace(/\/$/, '') + '/' + ref, {
      cookie,
      insecureTLS: cfg.insecureTLS,
    });
    if (res.status !== 200) {
      log(`\n   asset ${ref} -> HTTP ${res.status} (skipped)`);
      continue;
    }
    fs.writeFileSync(path.join(assetsDir, name), res.body);
    assetEntries.push({ path: `assets/${name}`, data: res.body });
  }
  if (wantedAssets.size) process.stdout.write('\n');

  // 6. assemble the EPUB
  log('   assembling EPUB...');
  const creators = openbook.creator ?? [];
  const author = creators.find((c) => /aut/i.test(c.role ?? ''))?.name || creators[0]?.name || loan.author;
  const epub = buildEpub({
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
  });
  const epubPath = path.join(bookDir, `${sanitize(openbook.title?.main ?? loan.title)}.epub`);
  fs.writeFileSync(epubPath, epub);
  log(`   ${(epub.length / 1e6).toFixed(1)} MB EPUB`);

  // 7. normalized metadata + integrity + README
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
    isbns: extractIsbns(thunder),
    expires: loan.expires,
    archivedAt: new Date().toISOString(),
  });
  writeManifest(bookDir);
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

function cleanDescription(desc) {
  const raw = typeof desc === 'string' ? desc : desc?.full ?? desc?.short;
  if (!raw) return undefined;
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function extractIsbns(thunder) {
  const ids = [];
  for (const f of thunder?.formats ?? []) for (const id of f.identifiers ?? []) {
    if (/ISBN/i.test(id.type ?? '')) ids.push(id.value);
  }
  return [...new Set(ids)];
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function writeManifest(dir) {
  const lines = [];
  const walk = (d, rel = '') => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else if (r !== 'manifest.sha256') {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        lines.push(`${hash}  ${r}`);
      }
    }
  };
  walk(dir);
  fs.writeFileSync(path.join(dir, 'manifest.sha256'), lines.join('\n') + '\n', 'utf8');
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
