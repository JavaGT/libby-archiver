// Fetch supplementary metadata + the highest-resolution cover for a title.
//
// Thunder is OverDrive's public catalog API; no auth needed. It carries rich metadata
// (full description, subjects, formats, publisher, ISBNs, sample, etc.) beyond what the
// loan record holds.

import fs from 'node:fs';
import { fetchBuffer, getJson } from './http.mjs';

const THUNDER = 'thunder.api.overdrive.com';

/** Fetch the Thunder media record for a title. Returns parsed JSON (or null on failure). */
export async function fetchThunderMedia(library, titleId, { insecureTLS = false } = {}) {
  const path = `/v2/libraries/${encodeURIComponent(library)}/media/${encodeURIComponent(
    titleId,
  )}?x-client-id=dewey`;
  try {
    const res = await getJson(THUNDER, path, { insecureTLS });
    return res.status === 200 ? res.json : null;
  } catch {
    return null;
  }
}

/**
 * Derive the maximum-resolution cover URL from a Thunder record or loan cover URL.
 * OverDrive cover hrefs embed a resize; we request the original ImageType-100 asset.
 */
export function maxResCoverUrl(thunder, fallbackUrl) {
  const covers = thunder?.covers;
  if (covers) {
    // pick the widest declared cover
    const best = Object.values(covers)
      .filter((c) => c?.href)
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    if (best?.href) return stripResize(best.href);
  }
  return fallbackUrl ? stripResize(fallbackUrl) : undefined;
}

/** Turn a libbyapp.com/covers/resize?...&url=%2FImageType-100%2F... URL into the raw asset. */
function stripResize(url) {
  try {
    const u = new URL(url);
    const inner = u.searchParams.get('url');
    if (inner && u.pathname.includes('/covers/resize')) {
      return 'https://ic.od-cdn.com' + inner; // OverDrive image CDN
    }
  } catch {
    /* not a resize URL */
  }
  return url;
}

/** Download cover art to destPath atomically (temp file + rename). */
export async function downloadCover(url, destPath, { insecureTLS = false } = {}) {
  const res = await fetchBuffer(url, { insecureTLS, headers: { Accept: 'image/*' } });
  if (res.status !== 200) throw new Error(`cover ${url} -> HTTP ${res.status}`);
  const tmp = destPath + '.part';
  try {
    fs.writeFileSync(tmp, res.body);
    fs.renameSync(tmp, destPath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return destPath;
}
