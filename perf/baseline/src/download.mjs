// Download audiobook spine parts.
//
// Each MP3 is fetched from the listen host at {web}{path}?{cmpt}. The signed `cmpt`
// param authorizes the request on its own: the listen host responds 302 to a signed
// audioclips.cdn.overdrive.com URL, and NO Cookie header is required (confirmed).
// The session cookie is only sent to the listen host itself; it is dropped when the
// redirect crosses to the CDN.
//
// Parts land via a `.part` temp file and are verified against the expected byte size
// (Content-Length, or the openbook's -odread-file-bytes) before being renamed into
// place — a truncated download must never masquerade as a finished part.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { followRedirects } from './http.mjs';

const PART_TIMEOUT_MS = 60_000; // idle socket timeout; slow-but-moving downloads are fine

/**
 * Download one spine part to destPath, following redirects. Returns { bytes, sha256 }.
 * Throws (leaving no temp file behind) on HTTP errors and truncated bodies.
 * @param {object} part   from extractSpine()
 * @param {string} destPath
 * @param {object} opts   { cookie, insecureTLS, onProgress, timeoutMs }
 */
export async function downloadPart(part, destPath, opts = {}) {
  const { cookie, insecureTLS = false, onProgress, timeoutMs = PART_TIMEOUT_MS } = opts;
  const tmp = destPath + '.part';

  try {
    const res = await followRedirects(
      part.url,
      {
        cookie,
        insecureTLS,
        timeoutMs,
        headers: { Accept: '*/*', Range: 'bytes=0-' },
      },
      5,
    );
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      throw new Error(`part ${part.index} -> HTTP ${res.statusCode}`);
    }

    const hash = crypto.createHash('sha256');
    let bytes = 0;
    res.on('data', (c) => {
      bytes += c.length;
      hash.update(c);
      if (onProgress) onProgress(bytes);
    });
    await pipeline(res, fs.createWriteStream(tmp));

    const expected = Number(res.headers['content-length']) || Number(part.size) || 0;
    if (expected && bytes !== expected) {
      throw new Error(`part ${part.index}: received ${bytes} bytes, expected ${expected}`);
    }

    fs.renameSync(tmp, destPath);
    return { bytes, sha256: hash.digest('hex') };
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
