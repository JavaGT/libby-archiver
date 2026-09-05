// Open an audiobook loan -> passport -> player page -> decode the embedded openbook.
//
// The openbook (spine + signed `cmpt` params) is NOT served as a fetchable manifest.
// The listen-host player page embeds it as an obfuscated `window.eData` array, which
// OverDrive's bifocal bundle decodes client-side and then deletes. We reproduce that
// decode in pure Node (reverse-engineered from bifocal-9.1.0 `theme.js`):
//
//   key   = buid reversed        (buid = the dewey-<buid> subdomain of the listen host)
//   data  = eData.join('"')
//   descrambled = for each char c at index a:
//               k = key[a % key.len]; if k is a nonzero digit d:
//                 c += (a + d) % 94; if c > 126: c = c % 126 + 32
//   openbook = JSON.parse( base64utf8_decode(descrambled) ).b
//
// The listen-host session is established by following the signed `message` redirect
// dance (no Bearer needed); the resulting cookie authorizes the player-page fetch.
// The MP3 parts themselves are fetched with the signed `cmpt` param (see download.mjs).

import https from 'node:https';
import { GATEWAY_HOST } from './sentry.mjs';
import { DEFAULT_TIMEOUT_MS } from './http.mjs';

/** Build the `t=` codex blob the web client sends with `open` (unsigned base64 JSON). */
export function buildCodex(loan, cfg) {
  const codex = {
    codex: {
      title: { titleId: String(loan.id), slug: String(loan.id) },
      loan: { psnKey: `${loan.cardId}-${loan.id}`, slug: `${loan.cardId}-${loan.id}` },
      library: { key: cfg.library, name: cfg.libraryName ?? cfg.library },
    },
    'dewey-url': 'https://libbyapp.com',
    spec: 'V31',
  };
  return Buffer.from(JSON.stringify(codex)).toString('base64');
}

/**
 * Map a loan's type to the `/open/<kind>/` segment the gateway expects.
 * audiobook -> audiobook (listen host); ebook -> book, magazine -> magazine (read host).
 */
export function openKindFor(loan) {
  const t = (loan.type ?? '').toLowerCase();
  if (t === 'audiobook') return 'audiobook';
  if (t === 'magazine') return 'magazine';
  return 'book'; // ebook and anything else the read host serves
}

/** Open a loan on the gateway and return the passport JSON. */
export async function openLoan(client, identity, loan, cfg, kind = openKindFor(loan)) {
  const t = encodeURIComponent(buildCodex(loan, cfg));
  const path =
    `/open/${kind}/card/${loan.cardId}/title/${loan.id}` + `?t=${t}&website_id=${cfg.websiteId}`;
  const res = await client.requestOk('GET', path, {
    bearer: identity,
    host: GATEWAY_HOST,
    headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors' },
  });
  return res.json;
}

// ---- The bifocal eData decoder (pure Node) -------------------------------------

/** Pure-ASCII gate: utf8 byteLength equals string length iff every code unit <= 127
 * (single native scan — see perf/loop-showdown.mjs for the cost/uptake numbers). */
const isAscii = (s) => Buffer.byteLength(s, 'utf8') === s.length;

/**
 * Undo bifocal's per-position scramble. Exported for tests.
 *
 * Fast path (the wire data is always printable ASCII): shift the latin1 bytes in
 * place and materialize once with a native toString — measured 4.3–6.5x the
 * character-loop version on a 2 MB string across mixed keys. Arithmetic is
 * unchanged and byte-exact: inputs are <= 127, so shifted values are <= 220 and
 * wrap to <= 157, which still fits a byte; the rotating key index (p) is just
 * `a % klen` without the division. Data holding any code unit > 127 falls back
 * to a Uint16Array code-unit loop that is exact for arbitrary strings.
 */
export function descramble(key, data) {
  const klen = key.length;
  const shifts = new Array(klen);
  for (let i = 0; i < klen; i++) shifts[i] = parseFloat(key[i]) || 0;
  if (!isAscii(data)) {
    const n = data.length;
    const u = new Uint16Array(n);
    for (let a = 0; a < n; a++) {
      let ch = data.charCodeAt(a);
      const d = shifts[a % klen];
      if (d) {
        ch += (a + d) % 94;
        if (ch > 126) ch = (ch % 126) + 32;
      }
      u[a] = ch;
    }
    let out = '';
    for (let k = 0; k < n; k += 8192) {
      out += String.fromCharCode.apply(null, u.subarray(k, Math.min(k + 8192, n)));
    }
    return out;
  }
  const bytes = Buffer.from(data, 'latin1');
  const n = bytes.length;
  let p = 0;
  for (let a = 0; a < n; a++) {
    const d = shifts[p];
    if (++p === klen) p = 0;
    if (d) {
      let ch = bytes[a] + ((a + d) % 94);
      if (ch > 126) ch = (ch % 126) + 32;
      bytes[a] = ch;
    }
  }
  return bytes.toString('latin1');
}

// Inside a string literal, copying runs is O(runs) instead of O(chars): stop at a
// backslash (escape) or the active quote (end of string). Global + lastIndex gives
// "next occurrence at or after i" (sticky would only try exactly at i).
const RUN_END = { '"': /["\\]/g, "'": /['\\]/g };
const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };
const SEPARATOR = /[\s,]/;

/**
 * Parse the eData array literal WITHOUT evaluating it — this text comes off the wire,
 * and eval would hand OverDrive's page (or anything on that path) a JS interpreter
 * inside a process holding the user's card credentials.
 *
 * Fast path: strict JSON. Fallback: a character-level parser that accepts only an
 * array of single- or double-quoted strings with JS escapes — the two shapes bifocal
 * actually emits. Anything else (identifiers, calls, objects) is rejected.
 */
function parseArrayLiteral(literal) {
  try {
    const j = JSON.parse(literal);
    if (Array.isArray(j) && j.every((s) => typeof s === 'string')) return j;
  } catch {
    /* fall through to the strict string-array parser */
  }
  const out = [];
  let cur = '';
  let inString = false;
  let quote = '';
  let seenOpen = false;
  let i = 0;
  const len = literal.length;
  while (i < len) {
    if (!inString) {
      const c = literal[i];
      if (c === '"' || c === "'") {
        inString = true;
        quote = c;
        i++;
      } else if (SEPARATOR.test(c)) {
        i++; // separators outside strings are structural, nothing to record
      } else if (c === '[' && !seenOpen && out.length === 0) {
        seenOpen = true;
        i++;
      } else if (c === ']') {
        i++; // closing bracket
      } else {
        throw new Error(`eData literal contains a non-string token near ${JSON.stringify(c)}`);
      }
      continue;
    }
    const run = RUN_END[quote];
    run.lastIndex = i;
    const m = run.exec(literal);
    const end = m ? m.index : len;
    if (end > i) {
      cur += literal.slice(i, end);
      i = end;
      continue;
    }
    if (literal[i] === quote) {
      inString = false;
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    // backslash escape (the run regex can only have stopped on quote or backslash)
    const e = literal[++i];
    if (e === 'x') {
      cur += String.fromCharCode(parseInt(literal.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (e === 'u') {
      cur += String.fromCharCode(parseInt(literal.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (e in SIMPLE_ESCAPES) cur += SIMPLE_ESCAPES[e];
    else if (e === undefined) throw new Error('eData literal ends mid-escape');
    else cur += e; // \' \" \\ and similar
    i++;
  }
  if (inString) throw new Error('unterminated string in eData literal');
  if (!seenOpen) throw new Error('eData literal is not an array');
  return out;
}

/**
 * Decode the player page's window.eData in named stages, so a wire-format drift
 * (OverDrive changing bifocal's scramble or page structure) is reported as the
 * exact broken contract instead of an opaque crash.
 *
 * Stages, in order: `eData-marker` (the page still embeds eData), `eData-literal`
 * (the array of strings parses), `eData-json` (descramble + base64 + JSON.parse
 * yield an object), `openbook-shape` (the object carries `.b`).
 *
 * @returns {{ ok: true, stages: object[], openbook: object } | { ok: false, stages: object[] }}
 */
export function probeEData(playerHtml, buid) {
  const stages = [];
  const m = playerHtml.match(/window\.eData\s*=\s*(\[[\s\S]*?\])\s*;\s*SPARK\.bifocalPath/);
  stages.push({
    stage: 'eData-marker',
    ok: !!m,
    detail: m ? undefined : 'window.eData = [...];SPARK.bifocalPath block not found in page',
  });
  if (!m) return { ok: false, stages };

  let parts;
  try {
    parts = parseArrayLiteral(m[1]);
    stages.push({ stage: 'eData-literal', ok: true });
  } catch (e) {
    stages.push({ stage: 'eData-literal', ok: false, detail: e.message, drift: 'eData array literal shape changed' });
    return { ok: false, stages };
  }

  const key = buid.split('').reverse().join('');
  const json = Buffer.from(descramble(key, parts.join('"')), 'base64').toString('utf8');
  // A scramble drift never throws — it produces garbage text. Canary on JSON-ness.
  if (!/^[\s{\[]/.test(json)) {
    stages.push({
      stage: 'eData-json',
      ok: false,
      detail: `decoded payload starts with ${JSON.stringify(json[0] ?? '')}, not JSON`,
      drift: 'scramble changed (shift %94 / wrap %126+32 / reversed-buid key)',
    });
    return { ok: false, stages };
  }
  let doc;
  try {
    doc = JSON.parse(json);
    stages.push({ stage: 'eData-json', ok: true });
  } catch (e) {
    stages.push({ stage: 'eData-json', ok: false, detail: e.message, drift: 'scramble changed (shift %94 / wrap %126+32 / reversed-buid key)' });
    return { ok: false, stages };
  }

  stages.push({ stage: 'openbook-shape', ok: !!doc.b, detail: doc.b ? undefined : 'decoded openbook missing `.b`' });
  if (!doc.b) return { ok: false, stages };
  return { ok: true, stages, openbook: doc.b };
}

/**
 * Decode the player page's window.eData array into the openbook (`.b`).
 * Stages and their drift hints: see probeEData.
 */
export function decodeOpenbook(playerHtml, buid) {
  const r = probeEData(playerHtml, buid);
  const failed = r.stages.find((s) => !s.ok);
  if (!r.ok) {
    if (failed.stage === 'eData-marker') throw new Error('window.eData not found in player page');
    if (failed.stage === 'openbook-shape') throw new Error('decoded openbook missing `.b`');
    if (failed.stage === 'eData-json') {
      throw new Error(`decoded eData payload is not JSON — the bifocal scramble appears to have drifted (${failed.detail}); see README → Obfuscation drift`);
    }
    throw new Error(`${failed.stage} failed: ${failed.detail}`);
  }
  return r.openbook;
}

/**
 * Establish the listen-host session and fetch the decoded openbook.
 * @returns {Promise<{ openbook: object, web: string, buid: string, cookie: string }>}
 */
export async function fetchOpenbook(passport, { insecureTLS = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const web = passport?.urls?.web; // https://dewey-<buid>.listen.libbyapp.com/
  if (!web) throw new Error('open passport carries no web URL — the loan may not be openable');
  const host = new URL(web).host;
  const buid = host.split('.')[0].replace(/^[^-]+-/, ''); // everything after "dewey-"
  const jar = new CookieJar(insecureTLS, timeoutMs);

  // 1. Follow the signed `message` handshake (no Bearer) to set the listen cookie.
  await jar.follow(web + '?' + passport.message);

  // 2. Fetch the player page (carries window.eData).
  const res = await jar.request(host, 'GET', '/', { headers: { Accept: 'text/html' } });
  if (res.status !== 200) throw new Error(`player page -> ${res.status}`);
  const openbook = decodeOpenbook(res.body.toString('utf8'), buid);
  return { openbook, web, buid, cookie: jar.cookieFor(host) };
}

/**
 * Turn a decoded openbook into ordered downloadable parts.
 * URL = {web}{part.path}?{cmpt[spinePosition]}  (part.path is already URL-encoded).
 */
export function extractSpine(openbook, web) {
  const spine = openbook.spine ?? [];
  const cmpts = openbook['-odread-cmpt-params'] ?? [];
  const base = web.replace(/\/$/, '');
  return spine.map((part, i) => {
    const pos = part['-odread-spine-position'] ?? i;
    const cmpt = cmpts[pos] ?? '';
    return {
      index: i + 1,
      path: part['-odread-original-path'] ?? part.path,
      url: `${base}/${part.path}${cmpt ? '?' + cmpt : ''}`,
      cmpt,
      duration: part['audio-duration'],
      size: part['-odread-file-bytes'],
      mediaType: part['media-type'],
    };
  });
}

// ---- minimal cookie-jar HTTPS client with redirect following -------------------

class CookieJar {
  constructor(insecureTLS, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
    this.agent = new https.Agent({ keepAlive: true, rejectUnauthorized: !insecureTLS });
    this.jar = {}; // host -> {name: value}
  }
  set(host, setCookie) {
    if (!setCookie) return;
    this.jar[host] ??= {};
    for (const c of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const nv = c.split(';')[0];
      const i = nv.indexOf('=');
      if (i > 0) this.jar[host][nv.slice(0, i).trim()] = nv.slice(i + 1);
    }
  }
  cookieFor(host) {
    return Object.entries(this.jar[host] || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  request(host, method, path, { headers } = {}) {
    const ck = this.cookieFor(host);
    // `host` is URL.host and may carry a port (any non-443 deployment); https.request
    // does not parse it, so split before connecting.
    const colon = host.indexOf(':');
    const target = { host: colon === -1 ? host : host.slice(0, colon) };
    if (colon !== -1) target.port = Number(host.slice(colon + 1));
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          ...target,
          path,
          method,
          agent: this.agent,
          timeout: this.timeoutMs,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Origin: 'https://libbyapp.com',
            ...(ck ? { Cookie: ck } : {}),
            ...(headers || {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            this.set(host, res.headers['set-cookie']);
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(new Error(`${method} ${host}${path}: timed out after ${this.timeoutMs}ms`)),
      );
      req.on('error', reject);
      req.end();
    });
  }
  async follow(url, max = 8) {
    let cur = new URL(url);
    let method = 'GET';
    for (let i = 0; i < max; i++) {
      const res = await this.request(cur.host, method, cur.pathname + cur.search);
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        cur = new URL(res.headers.location, cur);
        method = 'GET';
        continue;
      }
      return { url: cur.toString(), ...res };
    }
    throw new Error('too many redirects establishing listen session');
  }
}
