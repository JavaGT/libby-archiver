// Low-level Sentry / OverDrive HTTP client.
//
// Two hosts matter (both currently resolve to the same edge IP):
//   - sentry-read.svc.overdrive.com : headless/mobile API (Bearer JWT auth). Used for
//     chip/auth/sync/open. This is the host odmpy uses.
//   - dewey-<buid>.listen.libbyapp.com : per-loan audiobook host (openbook manifest + MP3s).
//
// Auth is a Bearer identity JWT obtained from POST /chip. The JWT embeds a `chip`
// claim; crucially `chip.cards` must be non-null for `open` to succeed (see auth.mjs).
//
// NOTE on TLS: on some networks sentry-read.svc.overdrive.com is served by an edge whose
// certificate CN is *.odrsre.overdrive.com (name mismatch). `insecureTLS` disables
// verification for that case only. Leave it off unless you hit ERR_TLS_CERT_ALTNAME_INVALID.

import https from 'node:https';

export const READ_HOST = 'sentry-read.svc.overdrive.com';
export const GATEWAY_HOST = 'sentry.libbyapp.com';

// Current live Dewey web-client version. Read from https://libbyapp.com/ ("version: '...'").
// The version is baked into the chip at mint time via the `c=d:<version>` param; a stale
// value causes `403 client_upgrade_required` at open. Bump this if OverDrive updates.
export const CLIENT_VERSION = '22.0.2';

// Default User-Agent mirrors the desktop web client.
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export class SentryError extends Error {
  constructor(message, { status, body, result } = {}) {
    super(message);
    this.name = 'SentryError';
    this.status = status;
    this.body = body;
    this.result = result; // OverDrive's `result` string, e.g. "missing_chip", "whoa"
  }
}

/**
 * A thin request helper bound to one host, with a shared keep-alive agent so a whole
 * flow can travel over a single socket (the browser's chip binding is happier that way).
 */
export class SentryClient {
  constructor({ host = READ_HOST, insecureTLS = false, userAgent = DEFAULT_UA } = {}) {
    this.host = host;
    this.userAgent = userAgent;
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 1,
      rejectUnauthorized: !insecureTLS,
    });
  }

  /**
   * Perform an HTTPS request. Returns { status, headers, text, json }.
   * @param {string} method
   * @param {string} path   path beginning with "/"
   * @param {object} opts   { bearer, body, headers, host, raw }
   */
  request(method, path, opts = {}) {
    const { bearer, body, headers = {}, host = this.host, raw = false } = opts;
    const data =
      body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host,
          path,
          method,
          agent: this.agent,
          headers: {
            Accept: 'application/json',
            'User-Agent': this.userAgent,
            Origin: 'https://libbyapp.com',
            ...(data != null
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(data),
                }
              : {}),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const text = buf.toString('utf8');
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            resolve({ status: res.statusCode, headers: res.headers, text, json, buffer: buf });
          });
        },
      );
      req.on('error', reject);
      if (data != null) req.write(data);
      req.end();
    });
  }

  /** Request that throws on non-2xx and surfaces OverDrive's `result` string. */
  async requestOk(method, path, opts = {}) {
    const res = await this.request(method, path, opts);
    if (res.status < 200 || res.status >= 300) {
      const result = res.json?.result;
      throw new SentryError(
        `${method} ${path} -> ${res.status}${result ? ` (${result})` : ''}`,
        { status: res.status, body: res.text, result },
      );
    }
    return res;
  }
}

/** Decode a JWT payload (no signature verification — we only read claims). */
export function decodeJwt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
