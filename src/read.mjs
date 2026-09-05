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
//     1. swap chars 1 and 4 of every 4-char group (as /(.)(.)(.)(.)/g + '$4$2$3$1' would;
//        cfc1() below does this with an equivalent hand-rolled loop, ~2.5x faster)
//     2. base64-decode (standard alphabet) the result, then UTF-8 decode the bytes
//        (OverDrive's `base64-utf8-safe` module == Buffer.from(x, 'base64').toString('utf8'))
//
// Verified against every page component captured from libbyapp.com: 100% yield the real
// <body>...</body>. The referenced assets are served as ordinary JPEGs, no cipher.

import { fetchBuffer } from './http.mjs';

const CFC1_RE = /parent\.__bif_cfc1\(\s*self\s*,\s*'([^']*)'\s*\)/;

/**
 * Swap chars 1 and 4 of every 4-char group — a hand-rolled, exactly-regex-equivalent
 * version of `blob.replace(/(.)(.)(.)(.)/g, '$4$2$3$1')`. Regex `.` never matches the
 * four JS line terminators, so — like the engine — the scan jumps to just past the
 * first terminator found inside a would-be window and resumes from there; everything
 * else is a plain code-unit permutation.
 *
 * This is the exact-for-any-string path; cfc1() only routes blobs through it that the
 * latin1 byte fast path cannot guarantee (any code unit > 127).
 */
function swapQuads(s) {
  const n = s.length;
  if (n < 4) return s;
  const u = new Uint16Array(n);
  for (let i = 0; i < n; i++) u[i] = s.charCodeAt(i);
  let i = 0;
  while (i + 4 <= n) {
    let bad = -1;
    if (u[i] === 10 || u[i] === 13 || u[i] === 0x2028 || u[i] === 0x2029) bad = i;
    else if (u[i + 1] === 10 || u[i + 1] === 13 || u[i + 1] === 0x2028 || u[i + 1] === 0x2029) bad = i + 1;
    else if (u[i + 2] === 10 || u[i + 2] === 13 || u[i + 2] === 0x2028 || u[i + 2] === 0x2029) bad = i + 2;
    else if (u[i + 3] === 10 || u[i + 3] === 13 || u[i + 3] === 0x2028 || u[i + 3] === 0x2029) bad = i + 3;
    if (bad !== -1) {
      i = bad + 1; // a window containing a terminator can't match; the engine retries after it
      continue;
    }
    const a = u[i];
    u[i] = u[i + 3];
    u[i + 3] = a;
    i += 4;
  }
  let out = '';
  for (let k = 0; k < n; k += 8192) {
    out += String.fromCharCode.apply(null, u.subarray(k, Math.min(k + 8192, n)));
  }
  return out;
}

/** Pure-ASCII gate: utf8 byteLength equals string length iff every code unit <= 127
 * (single native scan; ~0.05 ms on a 2.8 MB blob — see perf/loop-showdown.mjs). */
const isAscii = (s) => Buffer.byteLength(s, 'utf8') === s.length;

/**
 * Decode one `__bif_cfc1` blob to its cleartext (UTF-8) content.
 *
 * Fast path (every real blob): the blob is pure ASCII, so the quad swap runs on
 * latin1 bytes in place and every encode/decode stage around it is native —
 * measured 1.58x the code-unit loop on a 2.8 MB blob (perf/loop-showdown.mjs).
 * Without \n/\r the windows stay aligned on every 4th char; with one, the scan
 * mirrors the regex engine's retry-just-past-the-terminator. Any blob holding a
 * code unit > 127 (non-ASCII, U+2028/U+2029, lone surrogates) falls back to
 * swapQuads(), which is exact for arbitrary strings.
 */
export function cfc1(blob) {
  if (!isAscii(blob)) return Buffer.from(swapQuads(blob), 'base64').toString('utf8');
  const buf = Buffer.from(blob, 'latin1');
  const n = buf.length;
  if (n >= 4 && buf.indexOf(10) === -1 && buf.indexOf(13) === -1) {
    for (let i = 0; i + 4 <= n; i += 4) {
      const t = buf[i];
      buf[i] = buf[i + 3];
      buf[i + 3] = t;
    }
  } else {
    let i = 0;
    while (i + 4 <= n) {
      let bad = -1;
      if (buf[i] === 10 || buf[i] === 13) bad = i;
      else if (buf[i + 1] === 10 || buf[i + 1] === 13) bad = i + 1;
      else if (buf[i + 2] === 10 || buf[i + 2] === 13) bad = i + 2;
      else if (buf[i + 3] === 10 || buf[i + 3] === 13) bad = i + 3;
      if (bad !== -1) {
        i = bad + 1; // a window containing a terminator can't match; the engine retries after it
        continue;
      }
      const t = buf[i];
      buf[i] = buf[i + 3];
      buf[i + 3] = t;
      i += 4;
    }
  }
  return Buffer.from(buf.toString('latin1'), 'base64').toString('utf8');
}

/**
 * Decode a fetched read-host page into its `<body>…</body>` content.
 * Throws if the page carries no `__bif_cfc1` component (e.g. an error/placeholder page),
 * or if the decoded body is not markup — the latter means the cipher drifted.
 */
export function decodePage(html) {
  const r = probeCfc1(html);
  if (!r.ok) {
    const failed = r.stages.find((s) => !s.ok);
    if (failed.stage === 'cfc1-marker') throw new Error('page has no __bif_cfc1 component');
    throw new Error(`decoded page body is not markup — the __bif_cfc1 cipher appears to have drifted (${failed.detail}); see README → Obfuscation drift`);
  }
  return r.body;
}

/**
 * Decode a read-host page in named stages, so a cipher drift is reported as the
 * exact broken contract. Stages: `cfc1-marker` (the page still calls
 * parent.__bif_cfc1), `content-shape` (the deciphered body is markup).
 *
 * @returns {{ ok: true, stages: object[], body: string } | { ok: false, stages: object[] }}
 */
export function probeCfc1(html) {
  const stages = [];
  const m = String(html).match(CFC1_RE);
  stages.push({
    stage: 'cfc1-marker',
    ok: !!m,
    detail: m ? undefined : "parent.__bif_cfc1(self, '…') call not found in page",
  });
  if (!m) return { ok: false, stages };

  const body = cfc1(m[1]);
  // A cipher drift never throws — it yields base64-ish garbage. Canary on markup-ness.
  const markup = /^\s*</.test(body);
  stages.push({
    stage: 'content-shape',
    ok: markup,
    detail: markup ? undefined : `deciphered body starts with ${JSON.stringify(body[0] ?? '')}, not '<'`,
  });
  return markup ? { ok: true, stages, body } : { ok: false, stages };
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
