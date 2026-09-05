// Read-host (ebook / magazine) content decode + fetch.
//
// Ebooks and magazines open on the *read* host (dewey-<buid>.read.libbyapp.com) instead of
// the listen host, but the session handshake and the window.eData -> openbook decode are
// identical to audiobooks (see openbook.mjs / fetchOpenbook, reused as-is). What differs is
// the spine: each part is an XHTML page whose <body> is a single call
//
//     parent.__bif_cfc1(self, '<blob>')
//
// The blob holds the real page content (for magazines, an <svg> that references plaintext
// assets/urlHash-*.jpg scans; for reflowable ebooks, the text). `__bif_cfc1` is OverDrive's
// per-component cipher, reversed here in pure Node from bifocal's `dervish/src/rumi` module:
//
//     1. swap chars 1 and 4 of every 4-char group:  blob.replace(/(.)(.)(.)(.)/g, '$4$2$3$1')
//     2. base64-decode (standard alphabet) the result, then UTF-8 decode the bytes
//        (OverDrive's `base64-utf8-safe` module == Buffer.from(x, 'base64').toString('utf8'))
//
// Verified against every page component captured from libbyapp.com: 100% yield the real
// <body>...</body>. The referenced assets are served as ordinary JPEGs, no cipher.

import { fetchBuffer } from './http.mjs';

const CFC1_RE = /parent\.__bif_cfc1\(\s*self\s*,\s*'([^']*)'\s*\)/;

/** Decode one `__bif_cfc1` blob to its cleartext (UTF-8) content. */
export function cfc1(blob) {
  const shuffled = blob.replace(/(.)(.)(.)(.)/g, '$4$2$3$1');
  return Buffer.from(shuffled, 'base64').toString('utf8');
}

/**
 * Decode a fetched read-host page into its `<body>…</body>` content.
 * Throws if the page carries no `__bif_cfc1` component (e.g. an error/placeholder page).
 */
export function decodePage(html) {
  const m = String(html).match(CFC1_RE);
  if (!m) throw new Error('page has no __bif_cfc1 component');
  return cfc1(m[1]);
}

/**
 * SVG produced by the decoder omits the SVG/xlink namespace declarations (the browser
 * infers them when injecting into an HTML document). Add them to any <svg> open tag
 * that doesn't already declare namespaces, so the page is valid standalone XHTML.
 */
export function namespaceSvg(body) {
  return body.replace(/<svg\b[^>]*>/gi, (tag) =>
    /xmlns=/i.test(tag)
      ? tag
      : `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"${tag.slice(4)}`,
  );
}

/** Pull the distinct `assets/…` references (images) out of a decoded page body. */
export function assetRefs(body) {
  const refs = new Set();
  for (const m of body.matchAll(/(?:href|src)="([^"]*assets\/[^"]+)"/gi)) {
    refs.add(m[1].replace(/^(\.\.\/)+/, '')); // normalize ../assets/x -> assets/x
  }
  return [...refs];
}

/**
 * GET a resource from the read host with the primed session cookie, following redirects.
 * Returns { status, headers, body:Buffer }.
 */
export async function fetchReadResource(url, { cookie, insecureTLS = false, timeoutMs } = {}, max = 5) {
  const res = await fetchBuffer(url, {
    cookie,
    insecureTLS,
    timeoutMs,
    headers: { Accept: '*/*' },
    max,
  });
  return { status: res.status, headers: res.headers, body: res.body };
}

/** Fetch one spine page (from extractSpine) and return its decoded, namespaced body. */
export async function fetchPage(part, { cookie, insecureTLS = false } = {}) {
  const res = await fetchReadResource(part.url, { cookie, insecureTLS });
  if (res.status !== 200) throw new Error(`page ${part.path} -> HTTP ${res.status}`);
  return namespaceSvg(decodePage(res.body.toString('utf8')));
}
