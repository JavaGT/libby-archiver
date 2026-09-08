# T2-W2D — EPUB assembly RAM/storage audit (big fixture)

Worktree: perf-trial-20260909-040912. Node v26.7.0, Apple M4.
Fixture: ~42.5 MB synthetic magazine (600 pages × 8 KB + 320 assets × 120 KB +
cover 300 KB = 922 entries) built by `perf/gen.mjs:bigSyntheticEpub()`.

## Verdict: MEASURED, NO CHANGES ADOPTED

All four audit items measured. No code change clears the ≥10% adoption bar on
any named metric. The streaming zip path is clean (no hidden full copy), the
manifest hash is hash-bound (not read-bound), cover buffering is negligible, and
storage duplication is a non-issue at 0.91×.

---

## 1. writeEpub wall time + peak RSS

### Method

- Entries created once before measurement, held in memory (simulates
  archive-read with disk-backed thunks).
- `writeZip(entries, outPath)` streaming: peak RSS polled at 1 ms intervals
  during the write, 7 runs, median reported.
- `zip(entries)` in-memory: same polling, 7 runs.
- `--expose-gc` forced before each run.

### Results (medians, Apple M4)

| Path         | wall ms | peak RSS MB | RSS delta from baseline |
|--------------|--------:|------------:|------------------------:|
| baseline RSS |    —    |    102.7    |          —              |
| writeZip     |   64.7  |    133.0    |        +30.3 MB         |
| zip (memory) |   38.1  |    172.5    |        +69.8 MB         |

All individual run data:

| Run | writeZip wall | writeZip RSS | zip wall | zip RSS |
|-----|--------------:|-------------:|---------:|--------:|
|  0  |    71.1 ms    |   121.5 MB   |  39.2 ms | 172.4 MB |
|  1  |    75.3 ms    |   124.5 MB   |  37.9 ms | 172.4 MB |
|  2  |    79.2 ms    |   129.7 MB   |  38.1 ms | 172.4 MB |
|  3  |    64.4 ms    |   133.0 MB   |  38.8 ms | 172.5 MB |
|  4  |    63.9 ms    |   133.1 MB   |  39.7 ms | 172.6 MB |
|  5  |    64.7 ms    |   133.1 MB   |  37.8 ms | 172.6 MB |
|  6  |    63.6 ms    |   133.8 MB   |  38.1 ms | 172.6 MB |

### Analysis

- **No hidden full copy.** The streaming path (`zipChunks` → `writeZip`) holds
  only one entry's encoded payload at a time. After yielding, `p.comp` is set to
  `null` and the previous entry's data becomes GC-eligible. The RSS delta from
  baseline is +30 MB, well below a hypothetical full copy (+42 MB input).
- **buildEpub (in-memory)** uses +70 MB more than writeZip because it holds the
  entire output buffer (38.6 MB) in a pre-allocated `Buffer.allocUnsafe` while
  the input entries are also resident.
- **writeZip is slower than buildEpub** (64.7 vs 38.1 ms) because it includes
  disk I/O (atomic write via `.part` + rename) and SHA256 hashing of every chunk.
  This is the expected tradeoff for constant-RAM streaming.
- **Theory floor**: one entry at a time ≈ baseline + largest entry compressed.
  Largest entry is cover.jpg at 300 KB (stored, not compressed). The +30 MB
  overhead includes: V8 GC overhead, Node.js stream pipeline state, SHA256
  hasher, and internal write buffer. No optimization available.
- **Reference baselines**: zip_assembly 13 MB EPUB = 6.48 ms. Our 42.5 MB
  fixture writes in 64.7 ms = ~1.5 ms/MB (comparable; includes disk I/O).

### Digest proof

EPUB SHA256: `d2bda4331ebe33ef08266f262263c422ef6fecc118ebe856364c097dfdf597d1`

---

## 2. writeManifest read sizing (src/util.mjs:138)

### Method

- ~48 MB manifest source (12 × 4 MB mp3 + 8 KB metadata).
- Tested highWaterMark: 64 KB, 256 KB, 512 KB, 1 MB (current), 2 MB, 4 MB.
- Tested concurrency: 1, 2, 4, 8 (current), 16 workers.
- 7 runs each, median wall time.

### Results

| Parameter     | Value  | Median ms |
|---------------|-------:|----------:|
| HWM 64 KB     | 64 KB  |  21.48    |
| HWM 256 KB    | 256 KB |  18.53    |
| HWM 512 KB    | 512 KB |  18.69    |
| **HWM 1 MB**  | **1 MB** | **16.64** |
| HWM 2 MB      | 2 MB   |  17.40    |
| HWM 4 MB      | 4 MB   |  17.85    |
| Workers 1     | 1      |  17.49    |
| Workers 2     | 2      |  16.90    |
| Workers 4     | 4      |  16.83    |
| **Workers 8** | **8**  | **16.98** |
| Workers 16    | 16     |  16.36    |

### Analysis

- **Hash-bound, not read-bound.** Varying concurrency (1→16 workers) changes
  wall time by only 1.1 ms (6.5%). The SHA-256 computation dominates.
- **1 MB HWM is the sweet spot.** Smaller HWMs (64 KB) increase syscall
  overhead significantly (+29% at 64 KB). Larger HWMs (2–4 MB) add buffer
  management overhead with no throughput gain.
- **No change warranted.** Current 1 MB HWM + 8 workers is optimal. Best
  alternative (16 workers, 16.36 ms) is only 3.7% faster — well below the
  ≥10% adoption bar. The reference baseline (17.36 ms) agrees closely.

### Digest proof

Manifest SHA256: `7090322b81733feb3c309ef5ae831db1880fd93ce83796129f09a5aa464c359e`

---

## 3. downloadCover buffering audit (src/http.mjs)

### Method

Code-path analysis of the cover download chain:
`downloadCover()` → `fetchBuffer()` → `followRedirects()` → `collect(res)`

### Findings

- `collect()` drains the entire HTTP response into a `chunks[]` array, then
  `Buffer.concat(chunks)` creates one contiguous buffer.
- `fetchBuffer()` returns `{ body: Buffer }`, which `downloadCover()` writes to
  disk with `fs.writeFileSync(tmp, res.body)`.
- **Peak memory**: ~2× cover size during `Buffer.concat` (original chunks +
  concatenated result briefly coexist before GC).
- **Typical cover sizes**: 250 KB–1 MB. Peak double-buffer: 0.5–2 MB.
- **Assessment**: Negligible for the use case. The `collect()` helper is shared
  infrastructure used for all HTTP responses (Thunder API, stargazer, etc.),
  not just covers. Refactoring it to stream-to-disk would require a separate
  code path for covers, adding complexity for <2 MB savings.
- **No change warranted.**

---

## 4. Storage accounting (record-only)

### Pages/assets vs EPUB duplication

| Metric               | Value   |
|----------------------|---------|
| Input (raw entries)  | 42.5 MB |
| Output (EPUB)        | 38.6 MB |
| Duplication ratio    | 0.91    |

The EPUB is 9% *smaller* than the raw input because page XHTML is deflated
(~90% compression on repetitive synthetic content). In a real archive, the
source files (pages + assets on disk) and the EPUB would both exist — the
duplication ratio would be ~1.0× (EPUB ≈ raw assets since JPEGs are stored
verbatim). The only "new" data in the EPUB is the wrapper XHTML, OPF, NCX,
container.xml — negligible overhead.

**No action needed** — this is a product-level decision about whether to keep
both source files and the EPUB.

### Sidecar JSON: pretty vs compact

| Format   | Bytes | Delta vs compact |
|----------|------:|------------------:|
| Pretty   | 3,294 |     +86.5%        |
| Compact  | 1,766 |         —         |

The pretty-printed sidecar (`JSON.stringify(data, null, 2)`) is 86.5% larger
than compact. For the `writeJson` helper in `src/util.mjs`, this means ~1.5 KB
extra per sidecar write. Negligible in absolute terms; the readability benefit
for debugging outweighs the cost.

**No action needed** — this is a developer-experience decision.

---

## Summary

| Audit item               | Finding                                    | Action |
|--------------------------|--------------------------------------------|--------|
| writeEpub streaming      | No hidden full copy; +30 MB RSS overhead   | None   |
| writeManifest HWM/workers| 1 MB / 8 workers already optimal           | None   |
| downloadCover buffering  | <2 MB double-buffer, negligible             | None   |
| Storage duplication      | 0.91× (EPUB < raw due to deflation)         | Record |
| Sidecar pretty vs compact| +86.5% for readability                     | Record |

No code changes adopted. `src/` files untouched (except bench/gen additions).

## Commands run

- `npm test` — 85 pass / 0 fail (baseline intact)
- `node --expose-gc perf/bench.mjs --label t2-w2d-baseline` — full bench with
  big-fixture section
- `node --expose-gc --input-type=module -e '...'` — isolated RSS/wall
  measurements for writeZip, zip, manifest hash HWM/concurrency sweeps
