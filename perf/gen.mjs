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
