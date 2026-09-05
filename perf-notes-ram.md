# W12 — streaming ZIP writer (RAM wave)

## What / why

`src/epub.mjs` used to assemble the whole archive in memory ~2x: every entry's encoded
payload sat in `parts[]` **and** was copied into one final preallocated Buffer, and
`src/archive-read.mjs` then `writeFileSync`'d that Buffer. For a 50 MB magazine that is
roughly entry data + archive size resident at once.

The wave factors the ZIP writer so both output paths share ONE encoder:

- `entriesFor(book)` — the ordered EPUB entry list (mimetype first … content.opf), the
  single source of truth for assembly.
- `encodeEntry()` + `putLocalHeader()` / `putCdRecord()` / `putEocd()` — shared byte
  encoders (same STORE/deflate-6 rules, same fixed fields).
- `zip(entries)` — unchanged sync API; still returns one preallocated Buffer, now written
  through the shared encoders.
- `writeZip(entries, outPath)` (async) — an async generator (`zipChunks`) yields header,
  name, and payload per entry, then central directory + EOCD; `stream.promises.pipeline`
  writes them to `outPath + '.part'` (backpressure-safe) and the `.part` is renamed into
  place atomically (mirrors `util.writeFileAtomic`). Any failure unlinks the `.part` and
  never leaves a partial archive at the target path. Returns `{ bytes }`.
- `writeEpub(book, outPath)` — `writeZip(entriesFor(book), outPath)`.

Each encoded payload is dropped as soon as it is written (`p.comp = null`), so steady-state
memory is the caller's entry list plus one entry's payload. `zipChunks` iterates entries
with `for await`, so a caller can later stream entry data in from a source instead of
holding every payload up front (arrays work unchanged).

`src/archive-read.mjs` now calls `await writeEpub({...}, epubPath)` and logs
`(bytes / 1e6).toFixed(1)` MB — `bytes` is byte-identical to the old `epub.length`.

## Measured (this machine, `node --expose-gc perf/zip-stream-one.mjs <impl>`, fresh process per impl)

Synthetic EPUB from `perf/gen.mjs syntheticEpub()`: 222 entries, 12.7 MB of entry data,
12,682,772 output bytes.

| impl     | wall ms        | peak RSS  | bytes     |
|----------|----------------|-----------|-----------|
| zip      | 9.8 / 11.9     | 82 MB     | 12,682,772 |
| writeZip | 27.1 / 19.8    | **71 MB** | 12,682,772 |

- **RSS delta: −11 MB (82 → 71)** — exactly the final output buffer (12.7 MB) minus
  stream overhead. `writeZip`'s 71 MB floor ≈ Node baseline + the 12.7 MB entry list,
  i.e. the archive is no longer materialized at all. The saving scales with archive size
  (the ~2x → ~1x for a 50 MB magazine), and `perf/zip-one.mjs` still reports ~83 MB for
  the old path on the same input.
- **CPU cost: writeZip is ~2x slower** (≈10–12 ms → ≈20–27 ms for 12.7 MB) — chunked
  event-loop writes vs one memcpy into a preallocated Buffer. Absolute cost is trivial
  next to network fetches; correctness/memory win is worth it.
- Both impls produce the identical byte count; byte-identity is pinned by test.

## Tradeoffs / risks

- **Async API change:** `archiveReadable` now awaits `writeEpub` (it was already async, so
  no caller-facing change). `buildEpub`/`zip` remain exported and sync for any other
  consumer (`src/index.mjs` re-exports `buildEpub, zip` — untouched; adding
  `writeZip/writeEpub/entriesFor` to that re-export is a one-line follow-up for whoever
  owns `src/index.mjs`).
- **Transient per-entry buffers:** header chunks are 30/46/22-byte allocations per entry
  (hundreds max) — negligible; payloads are released immediately after their chunk is
  consumed.
- **Atomicity:** `.part` + `rename` mirrors `util.writeFileAtomic`. `pipeline` destroys the
  stream on error so the fd is closed before the `.part` unlink. No fsync (same as the
  existing helper).
- **Sync `zip()` gets one extra small copy per header** (helpers write 30/46-byte blocks
  into the output buffer instead of raw field writes) — measured no regression on
  `perf/zip-one.mjs` (83 MB vs 80–83 MB stated baseline, ~12.8 ms).

## Verified

- `node --test`: **55 pass / 0 fail** (52 pre-existing + 3 new), no regressions.
- New pins in `test/epub-integrity.test.mjs`:
  - `writeZip` output is **byte-identical** to `zip()` for the same book (shared encoders).
  - `writeEpub` output passes `unzip -t`, mimetype is first and stored.
  - No `.part` remains after success; a mid-write failure (throwing entry source) rejects
    and leaves neither the target nor the `.part`.
- Smoke run before tests: `zip(entries).equals(readFileSync(writeZip(...)))` → true.
