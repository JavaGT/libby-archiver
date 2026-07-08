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

/** Open a loan on the gateway and return the passport JSON. */
export async function openLoan(client, identity, loan, cfg) {
  const t = encodeURIComponent(buildCodex(loan, cfg));
  const path =
    `/open/audiobook/card/${loan.cardId}/title/${loan.id}` + `?t=${t}&website_id=${cfg.websiteId}`;
  const res = await client.requestOk('GET', path, {
    bearer: identity,
    host: GATEWAY_HOST,
    headers: { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors' },
  });
  return res.json;
}

// ---- The bifocal eData decoder (pure Node) -------------------------------------

function descramble(key, data) {
  const out = new Array(data.length);
  const klen = key.length;
  for (let a = 0; a < data.length; a++) {
    let ch = data.charCodeAt(a);
    const d = parseFloat(key[a % klen]); // NaN for non-digits, 0 falsy for '0'
    if (d) {
      ch += (a + d) % 94;
      if (ch > 126) ch = (ch % 126) + 32;
    }
    out[a] = String.fromCharCode(ch);
  }
  return out.join('');
}

/** Decode the player page's window.eData array into the openbook (`.b`). */
export function decodeOpenbook(playerHtml, buid) {
  const m = playerHtml.match(/window\.eData\s*=\s*(\[[\s\S]*?\])\s*;\s*SPARK\.bifocalPath/);
  if (!m) throw new Error('window.eData not found in player page');
  // The array literal is plain JSON-compatible once its JS escapes are honored; eval is
  // the faithful way to reproduce the browser's own parse of the literal.
  // eslint-disable-next-line no-eval
  const eData = (0, eval)(m[1]);
  const key = buid.split('').reverse().join('');
  const json = Buffer.from(descramble(key, eData.join('"')), 'base64').toString('utf8');
  const doc = JSON.parse(json);
  if (!doc.b) throw new Error('decoded openbook missing `.b`');
  return doc.b;
}

/**
 * Establish the listen-host session and fetch the decoded openbook.
 * @returns {Promise<{ openbook: object, web: string, buid: string, cookie: string }>}
 */
export async function fetchOpenbook(passport, { insecureTLS = false } = {}) {
  const web = passport.urls.web; // https://dewey-<buid>.listen.libbyapp.com/
  const host = new URL(web).host;
  const buid = host.split('.')[0].split('-')[1];
  const jar = new CookieJar(insecureTLS);

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
  constructor(insecureTLS) {
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
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host,
          path,
          method,
          agent: this.agent,
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
