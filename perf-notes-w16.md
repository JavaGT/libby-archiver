# W16 — EPUB assembly reads payloads from disk lazily (no whole-book residency)

Branch: `perf-trial-20260906-093914-epub` (W16 of the perf campaign)
Scope: `src/epub.mjs`, `src/archive-read.mjs`, `test/ram-thunk.test.mjs` (new),
`test/epub-integrity.test.mjs` (flake fix), `perf/zip-thunk-one.mjs` (new).

## What and why

W12 made `writeZip` stream the zip structure, but `archiveReadable` still handed it
entry objects holding every decoded payload: `pageEntries[].body`,
`assetEntries[].data`, `coverEntry.data`. For a 300-page magazine that is the entire
decoded book resident in memory during assembly — and it is duplicate data, since
every page is already written to `bookDir/pages/*.xhtml`, every asset to
`bookDir/assets/*`, and the cover to `bookDir/cover.jpg` before assembly starts.

Changes:

- **src/epub.mjs** — entry `data` may be a zero-argument thunk returning a payload
  (Buffer, or string for text). `encodeEntry` resolves it exactly once, when that
  entry is encoded, so both `zip()` (buffer path) and `zipChunks`/`writeZip`
  (streaming path) share the same resolution point; the per-entry CRC is computed
  from the resolved bytes as before. `entriesFor` now emits page entries as lazy
  thunks too (`() => wrapPage(pageBodyOf(part), …)`), and spine pages accept
  `{path, data: thunk|Buffer|string, viewport}` next to the legacy eager
  `{path, body}`. Buffer/string entries are untouched — output is byte-identical.
- **src/archive-read.mjs** — payloads are never retained. Each page body lives only
  inside its fetch callback (written to disk, asset refs collected, then dropped);
  entries become `{path, viewport, data: () => fs.readFileSync(dest), refs}`.
  Assets and the cover likewise read `bookDir` lazily. Asset refs ride along on the
  page entries (`refs`, tiny strings) so `wantedAssets` keeps its exact
  first-seen-page order — collection order would otherwise depend on fetch
  completion order. Logs, sidecars, skip-on-non-200, and fail-fast are unchanged.

## Measured RSS (perf/zip-thunk-one.mjs)

Fresh process per impl over a shared on-disk fixture (same synthetic book as
`syntheticEpub()`: 120x6KB pages + 100x120KB jpegs + 250KB cover = 12,682,772
archived bytes — byte-identical outputs verified with `cmp`):

| impl   | peakRssMB (3 runs) | note                                          |
|--------|--------------------|-----------------------------------------------|
| buffer | 69, 69, 69         | entries list holds all payloads (pre-W16)      |
| thunk  | 55, 55, 55         | entries hold closures; one payload at a time   |

Context: bare `node` floor on this machine is ~46–48 MB; after imports ~51–52 MB.
So the thunk path sits ~3 MB above the import floor (one payload + deflate copy +
stream buffers) versus +14 MB of whole-book residency for the buffer path — a
14 MB drop on a 12.7 MB book, scaling with book size. The buffer impl reproduces
the W12 `writeZip` floor (71 MB cited for this shape).

Bench methodology notes (both visible in the script header):

- Fixture generation runs in its own `prepare` process; generating payloads inside
  the measuring process sets an RSS high-water of its own and masks the result.
- `peakRssMB` is sampled after a forced `gc()` at every entry boundary. Without
  that, V8 lets uncollected payload garbage pile up until it next feels pressure
  and macOS never returns freed pages to the OS, so garbage accumulation is
  indistinguishable from residency (one-shot post-run RSS measured 62–70 MB on the
  *thunk* path — meaningless). `wallMs` includes that gc time: compare it between
  the two impls, not with `zip-stream-one` (uncounted gc). It is noisy (208–351 ms
  thunk, 230–950 ms buffer); memory is the signal, as in prior RAM waves.

## Tradeoffs and risks

- **Sync `readFileSync` per entry during streaming.** Each entry does one blocking
  read + `deflateRawSync` on the event loop. Fine for the CLI archiver (assembly
  is a serial tail phase; nothing else is being starved). An async
  (`createReadStream`) payload source would need the writer to accept stream
  entries — a larger change, noted as a future option, not needed for the win.
- **A payload file vanishing between write and assembly throws** (ENOENT from the
  thunk inside `encodeEntry`), which rejects `writeZip`'s pipeline, removes the
  `.part`, and fails the archive loudly — a missing payload can never ship
  silently. The already-written `pages/`/`assets/`/sidecars remain in `bookDir`
  for diagnosis (same failure surface as any mid-archive throw). Pinned by
  "a throwing thunk (payload file vanished) fails the write loudly" in
  test/ram-thunk.test.mjs.
- **Thunks must be pure** (same bytes on every call): entriesFor page thunks are
  pure closures; archive-read thunks close over a fixed `dest` path. A reused
  entry list is encoded twice across `zip()` + `writeZip()` calls — safe for pure
  thunks; impure thunks were never supported.
- `entriesFor` output now contains function `data` for pages: callers who inspect
  entries (none in-repo; `index.mjs` only re-exports) should resolve before use.

## Verified

- `node --test`: **63/63 pass** (59 pre-existing + 4 new in test/ram-thunk.test.mjs),
  including test/e2e.test.mjs end-to-end (decoded page contents, `unzip -t` on the
  streamed EPUB, manifest hashes) and manifest-ref.
- New pins: thunk vs buffer byte identity through `zip()` AND `writeZip()`;
  exactly-once, at-encode-time thunk invocation; spine `{data: thunk}` output
  identical to `{body}`; loud failure with no `.part` left.
- Flake fixed in test/epub-integrity.test.mjs: the writeZip/zip byte-identity pin
  built `entriesFor(book())` twice; `content.opf` stamps `dcterms:modified` at
  whole-second precision, so a clock rollover between the two calls (observed
  ~1-in-10 runs) flipped the comparison. Both writers now consume one shared
  entry list — a strictly stronger pin. 30 consecutive full-suite runs green after.
- `perf/zip-thunk-one.mjs buffer|thunk` outputs byte-identical (`cmp`), and the
  byte count matches wave2-w13's recorded `currentBytes` for the same shape.

## Integrator notes

Merge-order safe: epub.mjs thunk support is purely additive for old callers;
archive-read.mjs depends on it, so both commits land together (or epub first).
No changes to files owned by other waves.
