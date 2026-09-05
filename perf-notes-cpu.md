# perf-notes-cpu — Lane A (CPU/library)

Branch `perf-trial-20260906-030748-cpu` (from `be863fd`). Node v26.7.0, Apple M4.
All changes keep exported names/signatures/return types and output semantics.
`node --test`: 32 pass, 0 fail (6 test files, includes the focused additions below).

## 1. src/epub.mjs — `zip(entries)` (commits 557d97d, 781979d)

What:

- Pure-JS table CRC32 (and `CRC_TABLE`) deleted; replaced with native `zlib.crc32` (Node >= 20.15 — see "engines floor" below).
- Entries whose extension is an already-compressed media type (jpg, jpeg, png, gif, webp, avif, mp3, mp4, m4a, pdf — case-insensitive) are now STORE (method 0) instead of deflated. `store: true` (mimetype) and empty payloads stay stored as before.
- All remaining entries (xhtml/opf/ncx/xml) deflate at level 6 instead of 9.
- The archive is built into ONE preallocated `Buffer.allocUnsafe` buffer: pass 1 encodes each entry (crc/compressed bytes/lengths) and totals the size; pass 2 writes local headers + payloads, central directory, EOCD. Chunk array and the final full-output `Buffer.concat` are gone. Compressed payload references are dropped as soon as they are copied, so large media buffers can be collected during the write loop.

Why / measured (synthetic 12 MB incompressible media + 300 text entries, fresh process per side):

| | baseline | new |
|---|---|---|
| zip wall time | 189 ms | 5 ms (~38x) |
| peak RSS | 124 MB | 93 MB (−25%) |
| output size | 12.1 MB | 12.0 MB |

Hub's real-world baseline for comparison: 12.7 MB EPUB → 109 MB peak RSS; direction and magnitude are consistent.

Tradeoffs / risks:

- Output bytes intentionally change (stored media, level-6 text, ~0.5% smaller here; text ~2% larger per-entry than level 9 in the hub's measurement — accepted CPU tradeoff). Zip remains spec-valid: mimetype first and stored, correct offsets/CRC.
- Verified with `unzip -t` (all entries OK, no warnings) and the structural `parseZip` test.
- Bug caught during verification and fixed in 781979d: with `allocUnsafe`, the EOCD disk-number/comment-length fields would have been garbage (old code zeroed them via `Buffer.alloc`). EOCD now zeroes all reserved fields, and `parseZip` in test/epub.test.mjs asserts the full EOCD field set so this can't regress.
- **engines floor**: `zlib.crc32` requires Node >= 20.15.0; package declares `>=20`. package.json is not mine to edit — integrator must bump engines (e.g. `>=20.15`) at integration.

Test additions (test/epub.test.mjs): stored `.jpg` entry asserted via central directory AND local-header method field 0 + byte-identical payload + case-insensitive extension; deflate sanity for text (method 8, compresses, round-trips).

## 2. src/read.mjs — `cfc1(blob)` (commit 9883873)

What: the regex `blob.replace(/(.)(.)(.)(.)/g, '$4$2$3$1')` is replaced by `swapQuads`, a hand-rolled code-unit loop: fill a `Uint16Array` from `charCodeAt`, swap `u[i] <-> u[i+3]` per 4-code-unit window, rebuild the string in 8192-unit chunks via `String.fromCharCode`.

Exactness with the regex (the subtle part): regex `.` never matches the four JS line terminators (`\n`, `\r`, `\u2028`, `\u2029`), and the engine retries at the next code unit — so when a window contains a terminator, the scan resumes just past the FIRST terminator inside it, not at the next 4-boundary. `swapQuads` reproduces this: it checks the four code units, and on a hit sets `i = bad + 1`. Alignment therefore shifts after terminators exactly like the engine. Surrogates are code units to both (no `u` flag), so behavior matches there too.

Measured: ~60 ms → 8.6 ms end-to-end per 2.8 MB blob (the pure swap is ~20 ms vs 47 ms for the regex; the rest is the shared base64+utf8 decode). ~7x on the hot decode path.

Risk: low — equivalence is property-tested against the original regex (kept as a reference inside test/read.test.mjs) on: lengths 4n and 4n+k, blobs with terminators inside would-be groups (including a hand-computed expected value locking the "resume after terminator" semantics), and a 600-case seeded sweep over a hostile alphabet (base64 chars, `=`, all four terminators, lengths 0–63).

## 3. src/util.mjs — `writeManifest(dir)` (commit 085f64b)

What: hashing runs on a fixed pool of up to 8 workers pulling from a shared index (`next` is claimed synchronously before each `await`, so no double-claim), each stream with `highWaterMark: 1 MiB` instead of 64 KB. Results are written into `lines[idx]`, preserving the walk's sorted relative-path order — manifest bytes are identical.

Measured: on 40 x 1 MB files fully in page cache the gain is small (18 ms → 17 ms, 1.1x) — warm-cache hashing is bound by M4 hardware SHA, not I/O. The win is structural for the real archiving path (cold cache / just-written files), where 8 overlapped readers keep the disk busy instead of one 64 KB stream at a time.

Tradeoff / risk: peak in-flight read buffers rise from 64 KB to 8 MB (bounded, fine next to multi-hundred-MB audiobook parts). Output byte-identical — tested on a 13-file tree with nesting, a 2.5 MB file spanning several 1 MiB reads, >8 files to engage the pool, and excluded `.part` files, compared against an independently built expected string.

## Verified

- `node --test` — 32 pass / 0 fail.
- `unzip -t` on a built EPUB — no errors, no warnings.
- A/B benches above vs `git show be863fd:src/epub.mjs` in fresh processes.
- cfc1 property-equivalence vs the original regex (600 seeded cases + hand-computed edge cases).
- writeManifest byte-identical output vs independently computed expected manifest.

## Integrator notes

- Bump `engines.node` to at least `>=20.15` for `zlib.crc32` (not done here — package.json is owned by another lane).
- EPUB bytes differ from baseline by design (stored media, level-6 text); existing archives are unaffected (writing only).
