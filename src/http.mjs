// Shared HTTP plumbing for the plain REST calls (Thunder, stargazer, covers, downloads).
//
// Every helper takes `insecureTLS` (for the mismatched-cert read edge) and enforces a
// socket timeout — a hung connection must never wedge the whole CLI, which is exactly
// what happens with a keep-alive agent and no timeout. Timeouts are therefore enforced
// twice: per-request (`timeout` option + req.destroy handler, the authoritative one while
// a request is in flight) and on the agent itself as a backstop (covers idle pooled
// sockets, which the per-request timeout never sees).
//
// REST traffic shares pooled keep-alive agents (one per TLS mode) so Thunder calls,
// covers, pages, and spine parts reuse TLS connections instead of re-handshaking.
//
// The Sentry client (sentry.mjs) and the per-loan cookie jar (openbook.mjs) keep their
// own specialized agents (chip/session binding) but inherit the same timeout defaults.

import https from 'node:https';

export const DEFAULT_TIMEOUT_MS = 30_000;

const agents = new Map();
/** Pooled keep-alive agent per TLS mode; bounded so parallel work can't explode sockets. */
function agentFor(insecureTLS) {
  const key = !!insecureTLS;
  let agent = agents.get(key);
  if (!agent) {
    agent = new https.Agent({
      keepAlive: true,
      maxSockets: 8,
      maxFreeSockets: 4,
      keepAliveMsecs: 30_000,
      noDelay: true,
      timeout: DEFAULT_TIMEOUT_MS, // backstop; per-request timeout overrides while in flight
      ...(insecureTLS ? { rejectUnauthorized: false } : {}),
    });
    agents.set(key, agent);
  }
  return agent;
}

/** Drain a response into { status, headers, buffer, text, json }. */
export function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const text = buffer.toString('utf8');
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      resolve({ status: res.statusCode, headers: res.headers, buffer, text, json });
    });
    res.on('error', reject);
  });
}

/** JSON request to a host+path. Returns { status, headers, text, json }. */
export function jsonRequest({
  host,
  path,
  method = 'GET',
  body,
  headers = {},
  insecureTLS = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const data = body === undefined ? null : JSON.stringify(body);
  // `host` may carry an explicit port (`host:port`); https.request does not parse it.
  const colon = host.indexOf(':');
  const target = { host: colon === -1 ? host : host.slice(0, colon) };
  if (colon !== -1) target.port = Number(host.slice(colon + 1));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        ...target,
        path,
        method,
        agent: agentFor(insecureTLS),
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          ...headers,
          ...(data != null
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => collect(res).then(resolve, reject),
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${host}${path}: timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

export function getJson(host, path, { insecureTLS = false, timeoutMs, headers } = {}) {
  return jsonRequest({ host, path, headers, insecureTLS, timeoutMs });
}

export function postJson(host, path, body, { insecureTLS = false, timeoutMs, headers } = {}) {
  return jsonRequest({ host, path, method: 'POST', body, headers, insecureTLS, timeoutMs });
}

/**
 * GET a URL, following up to `max` redirects, resolving to the response stream (the
 * caller streams or buffers it). The `cookie`, if given, is only sent to the original
 * host and same-host redirects — a session cookie never leaks to a CDN.
 */
export function followRedirects(
  url,
  { headers = {}, cookie, insecureTLS = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
  max = 5,
) {
  return new Promise((resolve, reject) => {
    const attempt = (u, left, ck) => {
      const req = https.get(
        u,
        {
          agent: agentFor(insecureTLS),
          timeout: timeoutMs,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Origin: 'https://libbyapp.com',
            ...headers,
            ...(ck ? { Cookie: ck } : {}),
          },
        },
        (res) => {
          const { statusCode, headers: h } = res;
          if (statusCode >= 300 && statusCode < 400 && h.location && left > 0) {
            res.resume(); // discard the redirect body
            const next = new URL(h.location, u);
            attempt(next.toString(), left - 1, next.host === new URL(u).host ? ck : undefined);
            return;
          }
          resolve(res);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`GET ${u}: timed out after ${timeoutMs}ms`)));
      req.on('error', reject);
    };
    attempt(url, max, cookie);
  });
}

/** GET a URL (following redirects) and buffer the body. Returns { status, headers, body }. */
export async function fetchBuffer(url, opts = {}) {
  const res = await followRedirects(url, opts, opts.max);
  const out = await collect(res);
  return { status: out.status, headers: out.headers, body: out.buffer };
}
