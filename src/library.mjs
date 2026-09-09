// Library discovery against OverDrive's public catalog, plus TLS-quirk detection.
//
// Split out of config.mjs (#5) so light commands (`where`, `search`, `info`, `avail`)
// can import pure config helpers without paying for the node:https + sentry + http
// network import graph at startup. `src/init.mjs` and the public API (src/index.mjs)
// are the only consumers.

import https from 'node:https';
import { READ_HOST } from './sentry.mjs';
import { getJson } from './http.mjs';

/**
 * Resolve a library's numeric websiteId and canonical name from its Libby key
 * (the "your-library" in libbyapp.com/library/your-library, or your library's share links).
 * Uses OverDrive's public Thunder catalog — no auth required.
 * @returns {Promise<{key:string,name:string,websiteId:string}>}
 */
export async function resolveLibrary(key, { insecureTLS = false } = {}) {
  const clean = String(key).trim().toLowerCase();
  const res = await getJson(
    'thunder.api.overdrive.com',
    `/v2/libraries/${encodeURIComponent(clean)}`,
    { insecureTLS, timeoutMs: 10_000 },
  );
  if (res.status === 404) {
    throw new Error(
      `No library found for key "${clean}". Use the slug from your ` +
        `libbyapp.com library URL (e.g. "your-library").`,
    );
  }
  if (res.status !== 200) {
    throw new Error(`Library lookup for "${clean}" failed: HTTP ${res.status}.`);
  }
  if (!res.json?.websiteId) {
    throw new Error(`Library "${clean}" has no websiteId in the catalog.`);
  }
  return {
    key: res.json.preferredKey || clean,
    name: res.json.name || clean,
    websiteId: String(res.json.websiteId),
  };
}

/**
 * Detect whether the OverDrive read edge on this network presents a mismatched
 * certificate (some edges serve *.odrsre.overdrive.com). If a strict TLS HEAD fails
 * with a cert-name error but an insecure one succeeds, callers should set insecureTLS.
 * @returns {Promise<boolean>} true if insecure TLS is required to reach the API.
 */
export function detectInsecureTLS() {
  const probe = (rejectUnauthorized) =>
    new Promise((resolve) => {
      const req = https.request(
        {
          host: READ_HOST,
          path: '/chip',
          method: 'HEAD',
          rejectUnauthorized,
          timeout: 8000,
        },
        (res) => {
          res.resume();
          resolve({ ok: true });
        },
      );
      req.on('error', (e) => resolve({ ok: false, code: e.code }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, code: 'ETIMEDOUT' });
      });
      req.end();
    });

  return probe(true).then((strict) => {
    if (strict.ok) return false;
    if (strict.code && /ALTNAME|CERT|TLS/i.test(strict.code)) {
      return probe(false).then((insecure) => insecure.ok === true);
    }
    return false; // some other failure — don't silently weaken TLS
  });
}
