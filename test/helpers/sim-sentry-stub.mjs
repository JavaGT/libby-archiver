// Simulated sentry wire surface for the #17 sync-reuse pins. The loader
// (test/helpers/sim-sentry-loader.mjs) redirects src/sentry.mjs here in
// children spawned with test/helpers/sim-sentry-preload.mjs, so a real CLI
// invocation runs the unmodified auth/loans code against this fake — no live
// network, no credential. Every request is appended as "METHOD /pathname" to
// $SIM_SENTRY_LOG so a pin can count exactly what hit the wire.
//
// The GET /chip/sync response carries one ebook loan; the bootstrap chain
// (POST /chip, /auth/forms, /auth/link, /chip/clone/code) is served so the
// fresh-mint fallback path can run end to end.
import fs from 'node:fs';

export const READ_HOST = 'sim-read';
export const GATEWAY_HOST = 'sim-gateway';
export const CLIENT_VERSION = 'test.0.0';

export class SentryError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.status = opts.status;
    this.result = opts.result;
  }
}

/** Same claim-only JWT decode as the real src/sentry.mjs. */
export function decodeJwt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const jwt = (claims) =>
  `sim-header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sim-sig`;

// Never expires within a test run; chip.cards[0][1] is the cardId (src/auth.mjs).
export const SIM_IDENTITY = jwt({
  exp: Math.floor(Date.now() / 1000) + 3600,
  chip: { prbn: 'v', cards: [['puid', 'card-77', null, true, '1234', 'testlib']] },
});

const SIM_LOAN = {
  id: 101,
  cardId: 77,
  title: 'Simulated Loan',
  firstCreatorName: 'S. Author',
  expires: '2026-10-01',
  type: { id: 'ebook' },
  overDriveFormat: { id: 'ebook' },
};

function record(method, path) {
  const log = process.env.SIM_SENTRY_LOG;
  if (log) fs.appendFileSync(log, `${method} ${new URL(path, 'https://sim').pathname}\n`);
}

// SIM_SENTRY_SYNC_FAILS: reject the first N GET /chip/sync calls with 401
// unauthorized — the shape a server-side-dead cached token produces — to pin
// the #12 first-authed-call recovery.
let syncFails = Number(process.env.SIM_SENTRY_SYNC_FAILS ?? 0);

export class SentryClient {
  // eslint-disable-next-line no-unused-vars
  constructor(opts) { /* host/TLS options are irrelevant to the sim */ }

  async request(method, path) {
    record(method, path);
    const { pathname } = new URL(path, 'https://sim');
    if (pathname === '/chip/sync') {
      if (syncFails > 0) {
        syncFails--;
        return { status: 401, json: { result: 'unauthorized' } };
      }
      return { status: 200, json: { result: 'synchronized', cards: [], loans: [SIM_LOAN] } };
    }
    if (pathname === '/chip' && method === 'POST') {
      return { status: 200, json: { chip: 'simchip0001', identity: SIM_IDENTITY } };
    }
    if (pathname === '/auth/forms/1234') {
      return { status: 200, json: { forms: [{ ilsName: 'testlib' }] } };
    }
    if (pathname.startsWith('/auth/link/')) return { status: 200, json: {} };
    if (pathname === '/chip/clone/code' && method === 'GET') {
      return { status: 200, json: { code: 'SIM-CODE' } };
    }
    if (pathname === '/chip/clone/code' && method === 'POST') return { status: 200, json: {} };
    throw new Error(`sim-sentry-stub: unexpected ${method} ${path}`);
  }

  async requestOk(method, path, opts = {}) {
    const res = await this.request(method, path, opts);
    if (res.status < 200 || res.status >= 300) {
      throw new SentryError(`${method} ${path} -> ${res.status}`, {
        status: res.status,
        result: res.json?.result,
      });
    }
    return res;
  }
}
