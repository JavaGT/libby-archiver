# T2-W2D Receipt — EPUB assembly RAM/storage audit

**Verdict**: MEASURED, NO CHANGES ADOPTED

## Per-change verdict

| Item | Finding | Verdict |
|------|---------|---------|
| writeEpub streaming (no hidden full copy) | Confirmed streaming: +30 MB RSS delta, no full copy | No change needed |
| writeManifest HWM/workers | 1 MB HWM + 8 workers already optimal | Measured-rejected |
| downloadCover buffering | <2 MB double-buffer, negligible for cover sizes | No change needed |
| Storage duplication | 0.91× (EPUB < raw due to deflation) | Record only |
| Sidecar pretty vs compact | +86.5% for readability | Record only |

## Before/After (no code changes — BEFORE = AFTER)

| Metric | Median |
|--------|-------:|
| writeZip wall (42.5 MB fixture) | 64.7 ms |
| writeZip peak RSS | 133.0 MB |
| buildEpub wall (same fixture) | 38.1 ms |
| buildEpub peak RSS | 172.5 MB |
| Process RSS baseline (entries resident) | 102.7 MB |
| Manifest hash (48 MB) wall | 18.36 ms |
| EPUB output | 38.6 MB |
| EPUB SHA256 | d2bda4331ebe33ef08266f262263c422ef6fecc118ebe856364c097dfdf597d1 |
| Manifest SHA256 | 7090322b81733feb3c309ef5ae831db1880fd93ce83796129f09a5aa464c359e |
| Storage duplication ratio | 0.91 |
| Sidecar pretty/compact delta | +86.5% |

## Method

- Fixture: 42.5 MB synthetic magazine (922 entries: 600 pages, 320 JPEG assets, cover)
- RSS: 1 ms polling of `process.memoryUsage().rss` during operation, 7 runs, median
- Wall: `hrtime.bigint()`, 7 runs, median
- Manifest HWM sweep: 64 KB–4 MB × 7 runs; concurrency sweep: 1–16 workers × 7 runs
- `--expose-gc` forced before each measurement

## Diff size

0 lines changed in src/ files. Bench/gen additions only.

## npm test

85 pass / 0 fail

## Digest match

Yes — EPUB and manifest digests recorded and byte-identical across all runs.

## Tradeoffs

The streaming writeZip (64.7 ms) is ~1.7× slower than in-memory zip (38.1 ms)
due to disk I/O and SHA256 hashing, but uses 39.5 MB less peak RSS — the
correct tradeoff for large archives.

## Storage accounting (for product owner)

- Pages/assets + EPUB: the EPUB is 9% smaller than raw input (deflation wins on
  text). In real archives with disk-backed source files, expect ~1.0× duplication.
- Sidecar JSON: pretty-print costs +86.5% vs compact. Recommendation: keep
  pretty-print (debuggability > ~1.5 KB per sidecar).

## Blockers

None.
