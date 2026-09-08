// Shared small helpers used by both archive orchestrators (and discovery).
//
// These used to live as near-identical copies in archive.mjs / archive-read.mjs /
// discover.mjs and had already drifted apart (each with a different entity decoder,
// one of them double-decoding). One copy each, here.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANIFEST_NAME = 'manifest.sha256';
const MARKER_NAME = '.libby-archive.json';

export const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Make arbitrary title/author text safe as a single path segment. */
export const sanitize = (s) =>
  (s ?? '')
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'Untitled';

/**
 * Decode HTML entities in one pass — `&amp;` is a plain named replacement here, never
 * a second round of decoding, so `&amp;lt;` correctly stays `&lt;`.
 */
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const safeCodePoint = (n) =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';

export function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));/gi, (all, hex, dec, name) => {
    if (hex) return safeCodePoint(parseInt(hex, 16));
    if (dec) return safeCodePoint(Number(dec));
    return NAMED_ENTITIES[name.toLowerCase()] ?? all;
  });
}

/** Strip HTML tags and decode entities from a catalog description. */
export function cleanHtml(raw) {
  if (typeof raw !== 'string') return undefined;
  const stripped = raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  return stripped ? decodeEntities(stripped).trim() : undefined;
}

/** openbook/thunder descriptions arrive as a string or { full, short } with HTML. */
export function cleanDescription(desc) {
  if (typeof desc === 'string') return cleanHtml(desc);
  return cleanHtml(desc?.full ?? desc?.short);
}

/** ISBN values from Thunder format records, deduplicated. */
export function extractIsbns(formats = []) {
  const ids = [];
  for (const f of formats ?? []) for (const id of f.identifiers ?? []) {
    if (/ISBN/i.test(id.type ?? '')) ids.push(id.value);
  }
  return [...new Set(ids)];
}

/** Last path segment of an asset reference, rejecting anything unusable as a filename. */
export function assetName(ref) {
  const last = String(ref ?? '').split('/').pop();
  if (!last || last === '.' || last === '..' || last.includes('\0')) {
    throw new Error(`unsafe asset reference: ${ref}`);
  }
  return last;
}

/**
 * Join a server-supplied relative path (e.g. an openbook page path) onto a base
 * directory, refusing absolute paths, drive letters, and anything that escapes base.
 */
export function safeJoin(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const rel = String(relPath ?? '');
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rel) || rel.includes('\0')) {
    throw new Error(`unsafe path: ${relPath}`);
  }
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`path escapes the archive folder: ${relPath}`);
  }
  return resolved;
}

/** Write a file via a temp file + rename so a crash never leaves a truncated file. */
export function writeFileAtomic(file, data, { mode } = {}) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data, mode != null ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  if (mode != null) fs.chmodSync(file, mode);
}

// JSON sidecars go through temp-file + rename: a crash mid-write must never leave
// a truncated record masquerading as a complete one.

export function writeJson(file, data, { secret = false } = {}) {
  writeFileAtomic(file, JSON.stringify(data, null, 2), secret ? { mode: 0o600 } : {});
  if (secret) fs.chmodSync(file, 0o600); // passport/loan sidecars carry credentials
}

/**
 * Generator provenance for archive sidecars: which tool version produced the
 * folder. Read once from the package manifest; `unknown` if unreadable.
 */
let generator;
export function generatorInfo() {
  generator ??= (() => {
    try {
      return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    } catch {
      return {};
    }
  })();
  return { name: 'libby-archiver', version: generator.version ?? 'unknown' };
}

/**
 * Hash every file in dir (recursively) into manifest.sha256. Temp files from
 * interrupted downloads (*.part) are excluded — they are not content. Files are
 * hashed with bounded concurrency (up to 8 workers, 1 MiB reads) but the manifest
 * lines keep the same sorted relative-path order, so output is byte-identical.
 *
 * Each worker reuses one 1 MiB read buffer across all its files (explicit pread
 * loop, short read = EOF) instead of pumping a fresh-buffered createReadStream per
 * file — measured ~2x faster on 50-200 MB trees (the stream machinery dominated,
 * not SHA) while keeping the same 8 MiB total read cap.
 *
 * `known` maps a relative path to a sha256 hex digest that a writer already
 * computed while producing the file (e.g. downloadPart hashes while streaming).
 * Matching files skip the re-read entirely, so the integrity pass only re-reads
 * content that no one hashed yet. Callers must pass exact digests — they are
 * trusted as-is; a wrong digest would produce a wrong manifest.
 */
export async function writeManifest(dir, { known = {} } = {}) {
  const rels = [];
  const walk = (d, rel = '') => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === MANIFEST_NAME || name.endsWith('.part')) continue;
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else rels.push(r);
    }
  };
  walk(dir);

  const lines = new Array(rels.length);
  let next = 0;
  const hashOne = async (r, buf) => {
    const pre = known[r];
    if (pre) return `${pre}  ${r}`;
    const hash = crypto.createHash('sha256');
    const fh = await fs.promises.open(path.join(dir, r), 'r');
    try {
      // regular files only (walk recursed the directories): a short read is EOF
      for (let pos = 0; ; ) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        hash.update(buf.subarray(0, bytesRead));
        if (bytesRead < buf.length) break;
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
    return `${hash.digest('hex')}  ${r}`;
  };
  // Fixed worker pool over the shared index: `next` is claimed synchronously before
  // each await, so workers never collide; results land at their original index.
  await Promise.all(
    Array.from({ length: Math.min(8, rels.length) }, async () => {
      const buf = Buffer.allocUnsafe(1 << 20); // one reused 1 MiB read buffer per worker
      while (next < rels.length) lines[next] = await hashOne(rels[next++], buf);
    }),
  );

  fs.writeFileSync(path.join(dir, MANIFEST_NAME), lines.join('\n') + '\n', 'utf8');
}

/** Which loan owns an existing archive folder — the marker file, or legacy metadata. */
function folderOwner(bookDir) {
  for (const name of [MARKER_NAME, 'metadata.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(bookDir, name), 'utf8'));
      if (j?.titleId != null) return String(j.titleId);
    } catch {
      /* not this folder's owner record */
    }
  }
  return null;
}

/**
 * Create (or resume) the archive folder for a loan: `<Author> - <Title>`. If a
 * different loan already owns that folder, the title id is appended, so two loans
 * with identical names can never mix their files. Folders from older versions with
 * no marker are adopted as-is (preserves resume for pre-marker archives).
 */
export function claimBookDir(outDir, loan) {
  const base = `${sanitize(loan.author ?? 'Unknown Author')} - ${sanitize(loan.title)}`;
  const candidates = [base, `${base} [${loan.id}]`, `${base} [${loan.id}]-2`];
  for (const folder of candidates) {
    const bookDir = path.join(outDir, folder);
    const owner = fs.existsSync(bookDir) ? folderOwner(bookDir) : null;
    if (owner === null || owner === String(loan.id)) {
      fs.mkdirSync(bookDir, { recursive: true });
      if (owner === null) {
        fs.writeFileSync(
          path.join(bookDir, MARKER_NAME),
          JSON.stringify({ titleId: String(loan.id), claimedAt: new Date().toISOString() }, null, 2) + '\n',
          'utf8',
        );
      }
      return { bookDir, folder };
    }
  }
  throw new Error(`could not claim an archive folder for "${base}"`);
}
