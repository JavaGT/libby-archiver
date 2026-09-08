# T2-W2D — RAM/storage audit on BIG fixtures

Machine: Apple M4 (10 cores), 16 GB, macOS, Node v26.7.0. Fresh process per measurement
(`--expose-gc` where RSS is sampled; gc time is inside wallMs — compare within a bench,
not across benches, per the W12 note). Bench: `perf/ram-big-one.mjs` (modes: `baseline`,
`prepare`, `epub`, `floor`, `manifest-prep`, `manifest`), fixtures from `perf/gen.mjs`
(`bigMagazine`, `manifestTree`). Repo default `npm test`: 85 pass / 0 fail before and after.

## Sub-task 1 — big-fixture EPUB assembly (writeEpub, current code)

**What.** 561-entry magazine fixture: 300 × 6 KB pages + 260 × 160 KB jpeg-ish assets +
250 KB cover = 44,697,600 B (44.7 MB) loose. `prepare` writes it to disk one payload at a
time in the archive-read on-disk shape; `epub` assembles via the exact production path
(`entriesFor` → `writeZip`, disk-backed payload thunks, fixed-layout viewports).

**Measured (fresh process per run, gc + RSS sample at every entry boundary).**

| impl | peak RSS | real wall (no forced gc) | bytes |
|---|---|---|---|
| Node baseline (same imports) | 49–51 MB | — | — |
| floor: thunk list, hash + stream bytes, no zip | **57 MB** | — | 44,697,600 |
| **writeZip, disk-backed thunks (current)** | **69–70 MB** | 57.6–60.3 ms | 43,273,337 |
| writeZip, eager buffers (pre-W16 shape, for contrast) | 113 MB | — | 43,273,337 |

- Eager − thunk = 113 − 69.5 ≈ **43.5 MB = exactly the entry data**: the streaming path
  really does hold only one payload at a time. No double-buffer exists in `src/epub.mjs`:
  `encodeEntry` resolves the thunk once, stored media yield the read buffer to the stream
  zero-copy (`comp === raw`), every payload is nulled after its chunk is written, and the
  sha256 is incremental.
- writeZip sits **12–13 MB above the measured floor**. Probe runs (no forced gc, RSS
  traced every 16 entries) show a monotonic ramp 57→83 MB across the asset phase ending
  97–98 MB at the last entry — allocator retention + lazy young-gen sweep of transient
  deflate/string garbage, not residency: the gc-per-entry runs prove ~28 MB of it is
  collectable on demand (macOS also never returns freed pages to the OS — W12 note).
  Per-entry transients are bounded at one entry's worth (~340 KB max: 160 KB payload +
  page Body string→Buffer churn for 6 KB text). No retained reference anywhere.
- Audited non-fix: `pageBodyOf`+`wrapPage` make 3 representations of each 6 KB page
  (Buffer→string→wrapped string→Buffer) — ~25 KB transient per page, invisible at peak.
  Not adoptable under the bar.

**Verdict: no src change — clean measured bill of health.** Assembly of a 45 MB magazine
costs ~58 ms and ~69 MB peak (≈ baseline + floor churn + one payload); nothing meets the
"concrete avoidable double-buffer" test, let alone a ≥10 % RSS win. For scale: the W12
streaming writer already took this fixture's peak from ~2× archive size (eager 113 MB
here) to 69 MB; the remaining overhead is deflate context churn inherent to the format.

## Sub-task 2 — writeManifest read sizing (src/util.mjs) — ADOPTED (different fix than the named knobs)

**What.** Sweep of the named knobs on realistic trees (`manifestTree`: ~60 % 150 KB
assets / ~25 % 5 MB parts / ~15 % 6 KB pages; 1057 and 5955 files), bench-local
parameterized copy of the exact pool algorithm, validated byte-identical against
`src/util.mjs` writeManifest + a single-threaded readFileSync floor before timing;
reps round-robin after a warmup pass (warm page cache).

| config (median ms) | 50 MB tree | 200 MB tree |
|---|---|---|
| hwm 1 MiB, 8 workers (current) | 51.6 | 272.2 |
| hwm 4 MiB, 8 workers | 84.5 (**worse**) | 478.3 (**worse**) |
| hwm 1 MiB, 16 workers | 53.5 (worse) | 251.8 (−7.5 %) |
| hwm 4 MiB, 16 workers | 79.5 (worse) | 442.6 (worse) |
| sync floor (readFileSync + hash) | 30.3 | 137.0 |

- **hwm 4 MiB is strictly worse**: `createReadStream` allocates the full hwm buffer per
  read regardless of file size, so 4 MiB means 4 MiB churn for 150 KB files. Rejected.
- **16 workers is noise** (−0…7.5 %): the async pool overlaps IO, not SHA — hashing runs
  on the single main thread; reads from a warm cache leave nothing to overlap.
- **SHA is NOT the floor — the stream pump was.** The single-threaded floor beats the
  current 8-worker streaming path ~1.8–2×: per file, `createReadStream` pays open +
  fresh 1 MiB buffer per chunk + stream machinery + close, and none of it parallelizes.
- **Adopted fix (root cause, within the file):** each pool worker now allocates ONE
  1 MiB buffer and reuses it across all its files via explicit pread
  (`fs.promises.open/read/close`, short read = EOF; regular files only — walk recursed
  dirs). Same 8 MiB total read cap (better: zero per-chunk allocations), same worker
  pool and line order, keeps true parallel IO for cold-cache resume runs.

**Measured, real `writeManifest` after the change (7 runs, median):**
- 50 MB tree: **32.2 ms** (was 51.6) → **−37.6 %**
- 200 MB tree: **147.5 ms** (was 272.2) → **−45.8 %**

Lands on the sync floor (30.3 / 137.0) — the async overhead is now ~zero; SHA + read is
the irreducible cost, exactly the "SHA is the floor" end state the wave predicted, just
reached by removing pump overhead instead of by declaring defeat.

**Byte-identity:** verified three ways — new writeManifest == bench copy of the OLD
algorithm == sync floor, on both trees; `test/util.test.mjs` + `test/manifest-ref.test.mjs`
pins pass; `npm test` 85/85.

**Tradeoff:** none material. Error behavior unchanged (open/read failures reject, same as
a failed stream). Cold-cache resume runs keep 8-way IO overlap via the threadpool.

## Sub-task 3 — downloadCover path (src/metadata.mjs) — considered, NOT adopted

**What.** `downloadCover` buffers the whole cover via `fetchBuffer`→`collect`, then
`writeFileSync` + rename. `collect` also unconditionally does `buffer.toString('utf8')` +
a `JSON.parse` attempt on the binary body.

**Measured** (collect-path sequence on cover-sized binary bodies):

| body | wasted transient alloc | wasted CPU (incl. failed JSON.parse) |
|---|---|---|
| 250 KB cover | ~1.55 MB | 3.4 ms |
| 1 MB cover | ~6.35 MB | 14.2 ms |

**Verdict: considered-not-adopted.** A stream-to-disk port of `downloadPart` would save
at most ~2–3 cover copies (≤6 MB transient, sub-noise in a ~70–100 MB process; <10 % bar)
and ~3–14 ms per title (network RTT dominates). The architecturally real win — hashing
while streaming so `archive-read`'s `known` map skips its post-write `readFileSync`
re-hash of the cover — needs the `src/archive-read.mjs` call site + a return-shape change
on a public export (`src/index.mjs`), both outside this wave's ownership. Numbers recorded
for the owner; not changed.

## Sub-task 4 — storage accounting (numbers only, owner's product decision)

**(a) Readable duplication ratio (big fixture, measured).**
- Loose content (pages + assets + cover): 44,697,600 B
- Assembled EPUB (same content + zip shell): 43,273,337 B — **96.8 % of loose** (media is
  stored verbatim; only the 1.8 MB of page text deflates away)
- Folder total: 87,970,937 B for 44.7 MB unique content → **1.97× duplication**; the EPUB
  copy is 49.2 % of folder bytes. For a 45 MB magazine, archiving costs ~88 MB on disk.
- Options for the owner (not implemented): drop `pages/`+`assets/` for readables and keep
  only the EPUB (halves storage, loses the "raw decoded bytes" provenance), or keep both
  and document the cost. Current shape trades ~2× disk for provenance + resume simplicity.

**(b) Pretty (2-space) vs compact JSON sidecars** (existing `perf/storage-sidecars.mjs`):
- openbook.json (magazine-scale, 1,801,847 B pretty): compact saves **1 %** (the body is a
  base64 string; whitespace is nothing)
- thunder.json (5,692 B pretty): compact saves 45 % relative — **2.6 KB absolute**
- Absolute cost of pretty-printing per title ≈ tens of KB against ~45–90 MB of content.
**Verdict: rejected** — human-readable archives are a product goal; the bytes are noise.

## Files touched

- `perf/gen.mjs` — `bigMagazine()` (lazy generator, archive-shaped names), `manifestTree()`
- `perf/ram-big-one.mjs` (new) — baseline / prepare / epub (+probe) / floor / manifest-prep / manifest
- `src/util.mjs` — writeManifest: reused 1 MiB per-worker pread buffer (ADOPTED)
- `src/epub.mjs`, `src/metadata.mjs`, `src/http.mjs` — audited, unchanged (findings above)

## Verified

- `npm test`: **85 pass / 0 fail** (baseline before any change: 85/85).
- Manifest output byte-identical (tree-level vs old algorithm + sync floor, both trees; test pins).
- EPUB outputs untouched: `src/epub.mjs` not modified.
