// Local HTTPS fixture server for tests that exercise the real network stack
// (pooling, timeouts, redirects, streamed downloads) without touching OverDrive.
//
// Uses a throwaway self-signed cert (openssl) + insecureTLS:true on the client side.
// Returns null when openssl is unavailable so callers can skip gracefully.

import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

let certCache;

export function selfSignedCert() {
  if (certCache) return certCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-sim-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key'),
      '-out', path.join(dir, 'cert'), '-days', '2', '-nodes', '-subj', '/CN=localhost',
    ], { stdio: 'ignore' });
    certCache = {
      key: fs.readFileSync(path.join(dir, 'key')),
      cert: fs.readFileSync(path.join(dir, 'cert')),
    };
  } catch {
    return null;
  }
  return certCache;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a simulated OverDrive-ish host.
 * Routes:
 *   GET /json            -> { ok: true } after opts.jsonDelay ms
 *   GET /stall           -> accepts, never responds (timeout tests)
 *   GET /redirect        -> 302 to /bytes/100 (same host)
 *   GET /bytes/:n        -> n deterministic bytes, truthful Content-Length
 *   GET /truncated/:n    -> promises n bytes, sends ~n/4, destroys the socket
 * The server counts accepted connections in `state.connections`.
 */
export async function startSimServer({ jsonDelay = 0 } = {}) {
  const cert = selfSignedCert();
  if (!cert) return null;
  const state = { connections: 0 };

  const server = https.createServer(cert, (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    const bytesMatch = url.pathname.match(/^\/bytes\/(\d+)$/);
    const truncMatch = url.pathname.match(/^\/truncated\/(\d+)$/);
    if (url.pathname === '/json') {
      sleep(jsonDelay).then(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: url.pathname }));
      });
    } else if (url.pathname === '/stall') {
      /* never respond */
    } else if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/bytes/100' });
      res.end();
    } else if (bytesMatch) {
      const body = deterministicBytes(Number(bytesMatch[1]));
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
    } else if (truncMatch) {
      const n = Number(truncMatch[1]);
      res.writeHead(200, { 'content-length': n });
      res.end(deterministicBytes(Math.max(1, Math.floor(n / 4))));
      socketOf(res)?.destroy();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('connection', () => state.connections++);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  state.url = `https://localhost:${state.port}`;
  state.close = () => new Promise((resolve) => server.close(resolve));
  return state;
}

function socketOf(res) {
  return res.socket;
}

/** Deterministic pseudo-random bytes (reproducible across runs and processes). */
export function deterministicBytes(n) {
  const out = Buffer.alloc(n);
  let x = 0x2545f491;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** sha256 hex of a Buffer (mirrors what downloadPart reports). */
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
