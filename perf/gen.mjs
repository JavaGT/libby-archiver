// Deterministic-ish synthetic data generators shared by the perf benches.
// jpegish(): random bytes — stands in for entropy-coded JPEG scans (incompressible).
// textPages(): tag-heavy XHTML with a small vocabulary — mimics read-host page bodies
// (compressible, repetitive) without shipping real copyrighted content.

import crypto from 'node:crypto';

export function jpegish(n) {
  return crypto.randomBytes(n);
}

const VOCAB = ['page', 'svg', 'image', 'assets', 'urlHash', 'width', 'height', 'viewport',
  'content', 'ref', 'href', 'xhtml', 'section', 'story', 'magazine', 'scan', 'viewBox',
  'preserveAspectRatio', 'rendering', 'class', 'body', 'nav', 'edition'];
const VOCAB_BIT = VOCAB.reduce((a, w) => a + w.length + 1, 0);

/** One synthetic page body ≈ n bytes of compressible XHTML. */
export function textPage(n, seed = 0) {
  let x = seed + 1;
  const rand = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const pick = () => VOCAB[(rand() * VOCAB.length) | 0];
  const words = Math.max(1, Math.round(n / VOCAB_BIT));
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1200">`];
  let len = out[0].length;
  let i = 0;
  while (len < n) {
    const w = pick();
    const chunk = i % 9 === 0 ? `<image href="../assets/urlHash-${w}${i}.jpg" width="800"/>` : `<p>${w}</p>`;
    out.push(chunk);
    len += chunk.length + 1;
    i++;
  }
  out.push('</svg>');
  return out.join('\n').slice(0, Math.max(n, 200));
}

/** Synthetic EPUB entry list: pages + jpeg-ish assets + cover. */
export function syntheticEpub({ pages = 120, pageSize = 6 * 1024, assets = 100, assetSize = 120 * 1024, coverSize = 250 * 1024 } = {}) {
  const files = [{ name: 'mimetype', data: 'application/epub+zip', store: true }];
  for (let i = 0; i < pages; i++) {
    files.push({ name: `OEBPS/pages/${i + 1}.xhtml`, data: Buffer.from(textPage(pageSize, i), 'utf8') });
  }
  for (let i = 0; i < assets; i++) {
    files.push({ name: `OEBPS/assets/urlHash-${i}.jpg`, data: jpegish(assetSize) });
  }
  files.push({ name: 'OEBPS/cover.jpg', data: jpegish(coverSize) });
  return files;
}

/**
 * Big-magazine fixture (T2 RAM wave): ~46 MB of entry data — 300 × 6 KB pages +
 * 260 × 160 KB jpeg-ish assets + 250 KB cover — the scale of a large fixed-layout
 * magazine. A lazy generator so `prepare`-style callers hold ONE payload at a time;
 * array-style consumers spread it (`[...bigMagazine()]`). Entry names mirror the
 * on-disk archive shape archive-read produces (pages/, assets/, cover.jpg).
 */
export function* bigMagazine({ pages = 300, pageSize = 6 * 1024, assets = 260, assetSize = 160 * 1024, coverSize = 250 * 1024 } = {}) {
  for (let i = 0; i < pages; i++) {
    yield { name: `pages/${String(i + 1).padStart(4, '0')}.xhtml`, data: Buffer.from(textPage(pageSize, i), 'utf8'), kind: 'page' };
  }
  for (let i = 0; i < assets; i++) {
    yield { name: `assets/urlHash-${i}.jpg`, data: jpegish(assetSize), kind: 'asset' };
  }
  yield { name: 'cover.jpg', data: jpegish(coverSize), kind: 'cover' };
}

/**
 * Synthetic archive-folder spec for writeManifest benches: a realistic readable
 * tree — ~60% of bytes as 150 KB assets, ~25% as 5 MB audiobook-style parts (the
 * only files that exceed a 1 MiB stream read), ~15% as 6 KB pages — sized to
 * `totalMB`, deterministically (same rel paths + sizes for the same totalMB).
 */
export function manifestTree(totalMB) {
  const total = totalMB * 1024 * 1024;
  const spec = [];
  const nAssets = Math.round((total * 0.6) / (150 * 1024));
  const nParts = Math.max(1, Math.round((total * 0.25) / (5 * 1024 * 1024)));
  const pageBytes = total - nAssets * 150 * 1024 - nParts * 5 * 1024 * 1024;
  const nPages = Math.max(1, Math.round(pageBytes / (6 * 1024)));
  for (let i = 0; i < nPages; i++) spec.push({ rel: `pages/${String(i + 1).padStart(5, '0')}.xhtml`, bytes: 6 * 1024 });
  for (let i = 0; i < nAssets; i++) spec.push({ rel: `assets/urlHash-${i}.jpg`, bytes: 150 * 1024 });
  for (let i = 0; i < nParts; i++) spec.push({ rel: `Part ${String(i + 1).padStart(2, '0')}.mp3`, bytes: 5 * 1024 * 1024 });
  return spec;
}

// ---- bifocal eData fixture (mirrors the forward-scramble in test/openbook.test.mjs) ----

const BUID = 'ab9cd'; // contains a nonzero digit so the scramble engages

function scramble(key, data) {
  let out = '';
  for (let a = 0; a < data.length; a++) {
    const target = data.charCodeAt(a);
    const d = parseFloat(key[a % key.length]);
    if (!d) {
      out += data[a];
      continue;
    }
    let found = data[a];
    for (let c = 32; c <= 126; c++) {
      let y = c + ((a + d) % 94);
      if (y > 126) y = (y % 126) + 32;
      if (y === target) {
        found = String.fromCharCode(c);
        break;
      }
    }
    out += found;
  }
  return out;
}

/** A listen-host player page embedding a ~targetJsonChars openbook as window.eData. */
export function openbookPage(targetJsonChars = 1_500_000) {
  const spine = [];
  const cmpts = [];
  for (let i = 0; i < 400; i++) {
    spine.push({
      path: `res/part${i}.mp3`,
      '-odread-spine-position': i,
      '-odread-original-path': `Part ${i + 1}.mp3`,
      '-odread-file-bytes': 5_000_000 + i,
      'audio-duration': 600 + i,
      'media-type': 'audio/mpeg',
    });
    cmpts.push(`cmpt=${i}`);
  }
  const doc = {
    b: {
      title: { main: 'Bench Openbook' },
      description: { full: 'x'.repeat(Math.max(0, targetJsonChars - 130_000)) },
      spine,
      '-odread-cmpt-params': cmpts,
      nav: { toc: spine.slice(0, 50).map((p, i) => ({ title: `Chapter ${i}`, path: p.path })) },
      creator: [{ name: 'A. Author', role: 'author' }],
    },
  };
  const json = Buffer.from(JSON.stringify(doc)).toString('base64');
  const scrambled = scramble(BUID.split('').reverse().join(''), json);
  const literal = JSON.stringify(scrambled.split('"'));
  return `<!doctype html><script>window.eData = ${literal};SPARK.bifocalPath='bifocal.js';</script>`;
}
