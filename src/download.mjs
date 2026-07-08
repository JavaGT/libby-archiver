// Download audiobook spine parts.
//
// Each MP3 is fetched from the listen host at {web}{path}?{cmpt}. The signed `cmpt`
// param authorizes the request on its own: the listen host responds 302 to a signed
// audioclips.cdn.overdrive.com URL, and NO Cookie header is required (confirmed).
// We still pass the primed cookie if we have one — harmless, and future-proof.

import fs from 'node:fs';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

/**
 * Download one spine part to destPath, following redirects. Returns { bytes, sha256 }.
 * @param {object} part   from extractSpine()
 * @param {string} destPath
 * @param {object} opts   { cookie, insecureTLS, onProgress }
 */
export async function downloadPart(part, destPath, opts = {}) {
  const { cookie, insecureTLS = false, onProgress } = opts;
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: !insecureTLS });

  const tmp = destPath + '.part';
  const out = fs.createWriteStream(tmp);
  const hash = (await import('node:crypto')).createHash('sha256');
  let bytes = 0;

  const res = await getFollowing(part.url, {
    agent,
    headers: {
      Accept: '*/*',
      Range: 'bytes=0-',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw new Error(`part ${part.index} -> HTTP ${res.statusCode}`);
  }
  res.on('data', (c) => {
    bytes += c.length;
    hash.update(c);
    if (onProgress) onProgress(bytes);
  });
  await pipeline(res, out);
  fs.renameSync(tmp, destPath);
  return { bytes, sha256: hash.digest('hex') };
}

/** GET that transparently follows up to `max` redirects, resolving to the response stream. */
function getFollowing(url, opts, max = 5) {
  return new Promise((resolve, reject) => {
    const attempt = (u, left) => {
      const req = https.get(u, opts, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && left > 0) {
          res.resume(); // discard body
          const next = new URL(headers.location, u).toString();
          attempt(next, left - 1);
        } else {
          resolve(res);
        }
      });
      req.on('error', reject);
    };
    attempt(url, max);
  });
}
