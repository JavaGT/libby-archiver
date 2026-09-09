# T3-W3 — cfc1 latin1 round-trip at page scale (issue #6)

Machine: Apple M4, macOS, Node v26.7.0. Bench: `perf/cfc1-pages.mjs`, run
`node perf/cfc1-pages.mjs`. Base commit `47aaaa0`. Focused identity gate: 700
spine pages checked against generator truth and `src/read.mjs`, plus 98
adversarial fixtures. Runtime: 3.09 s. `src/` was not changed.

## What and why

`cfc1()` currently swaps an ASCII blob through native Buffer/string stages:
`Buffer.from(blob, 'latin1')` → byte swap → `buf.toString('latin1')` →
`Buffer.from(str, 'base64')` → UTF-8. Issue #6 asks whether removing that
latin1-string round trip materially improves real read-host page decoding.

The bench builds cfc1-encodable synthetic XHTML pages at the requested scale:
500 magazine pages and 200 book pages, each approximately 50 KB. It compares
the shipped `decodePage()` with an identity-checked local variant that decodes
base64 directly from swapped bytes. Timing starts only after all identity gates
pass; whole-spine runs are interleaved (11 timed runs, 2 warmups).

## Measured

### Whole-spine decode

| spine | pages | current CPU total | current wall total | current/page median | no-roundtrip CPU total | no-roundtrip wall total | wall change |
|---|---:|---:|---:|---:|---:|---:|---:|
| magazine | 500 × 50 KB | 22.28 ms | 22.00 ms | 41.6 µs | 64.97 ms | 65.02 ms | **+43.02 ms (+195.5%)** |
| book | 200 × 50 KB | 8.76 ms | 8.72 ms | 41.5 µs | 25.79 ms | 25.76 ms | **+17.04 ms (+195.4%)** |

The local no-roundtrip implementation is slower than the native Buffer base64
path, so removing the string round trip is not an optimization as implemented.
The current 500-page magazine decode is 0.22% of the cited 10,000 ms page-fetch
journey (pages fetched four at a time, 80 ms RTT).

### Stage split and continuity checks

| input | current cfc1 | latin1 round-trip stages* | round-trip share of cfc1 |
|---|---:|---:|---:|
| one 50 KB page | 0.0238 ms | 0.0234 ms | 98.3% |
| realistic 2.8 MB blob | 1.7079 ms | 0.3084 ms | 18.1% |

\* `Buffer.from(..., 'latin1')` + `toString('latin1')` + `Buffer.from(..., 'base64')`;
the latter is the native base64-of-string stage that consumes the round-tripped
string. The direct-JS base64 tail measured 0.0951 ms/page and 3.8617 ms/blob,
which explains why this candidate loses despite the round-trip being visible in
the stage accounting.

Single-page A/B: 0.0238 ms current vs 0.1246 ms no-roundtrip. The realistic
2.8 MB blob: 1.7079 ms current vs 4.5391 ms no-roundtrip. Both outputs were
identity-verified. The old T2-W1B 3.39 ms row used a plain-base64 construction
that produces garbage under cfc1 and is retained only as a continuity reference,
not as a comparable page-content result.

## Recommendation for issue #6

**Close as wontfix.** The proposed removal does not improve the real path: the
local no-roundtrip decoder is about 2.95× slower for the 500-page magazine.
Even treating the current decode total as the relevant budget, the entire
magazine decode is only 0.22% of the cited archive page-fetch journey; the
measured “saving” from the proposed change is **−0.43% of that journey**. This
is below the rubric’s 5% threshold and is not a material archive-journey share.
No implementation follow-up is recommended.

## Verification

- `node perf/cfc1-pages.mjs`: identity PASS; 700 spine pages and 98 fixtures;
  timing completed in under 60 seconds.
- `src/read.mjs` and generator truth matched on every spine page.
- `src/` remained byte-identical.
