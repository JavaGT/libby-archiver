# T3-W1 — lazy text/json in collect() (issue #4)

Machine: Apple M4, macOS, Node v26.7.0. Bench: `/tmp/t3w1-bench.mjs` (end-stage A/B, median of
200 fresh-buffer runs per size) + `/tmp/t3w1-real-verify.mjs` (the shipped `collect()` module,
same protocol). Focused check: `node --test test/http.test.mjs` — 9 pass / 0 fail before and after.
Base commit e6c9314; fix commit b631fd7.

## What and why

`collect()` (src/http.mjs) drained every response into
`{ status, headers, buffer, text, json }` and unconditionally ran `buffer.toString('utf8')` +
a `JSON.parse` attempt on every body. Binary consumers (`fetchBuffer` → cover downloads in
src/metadata.mjs:59, magazine asset downloads in src/read.mjs:180) never read text/json, so
every binary body paid a full error-tolerant UTF-8 decode of random bytes, a doomed
JSON.parse, and a body-sized transient string — always discarded. A ~260-asset magazine burned
~340 ms CPU + ~420 MB transient churn on that alone.

## Design decision (measured both, adopted (a))

- **(a) ADOPTED — lazy compute-once getters** for text/json on the resolve object. Callers
  unchanged; JSON responses pay exactly the work they paid before (getters evaluate once,
  cached), binary responses pay nothing.
- (b) Fallback — a text/json-free drain used only by fetchBuffer — measured identical on the
  binary path (both ~0; drain-only is drain-only), so (a) wins: one code path, no duplicated
  drain implementation. JSON-path measurement confirmed no regression (below).

Sentinel detail: `undefined` cannot be the compute-once sentinel for `json` — a failed parse
legitimately yields `undefined`, and every re-read would re-run the parse. Both getters use
flag sentinels (`textDone`/`jsonDone`), pinned by the once-only test on a non-JSON body.

Watch-out from the issue, verified: src/openbook.mjs:406 spreads `{ url, ...res }` — but `res`
there is the result of `jar.request()` (openbook.mjs:380-386), which has its own inline drain
returning `{ status, headers, body }`. It never routes through `collect()`, so no getter object
reaches that spread. Getter objects in general spread fine anyway (object-literal getters are
own enumerable properties; spread evaluates them into plain values — pinned by a test).

## Measured (median of 200, fresh buffer per run, jpeg-ish random bytes)

Binary end-stage (what fetchBuffer's drain pays; before = e6c9314 logic inline):

| body | eager (before) | lazy getters (a) | drain-only (b) | win |
|---|---:|---:|---:|---:|
| 160 KB asset | 1.184 ms | 0.0003 ms | ~0.000 ms | ~4000x |
| 250 KB cover | 1.886 ms | 0.0003 ms | ~0.000 ms | ~6500x |
| 1 MB cover | 8.278 ms | 0.0003 ms | ~0.000 ms | ~28000x |

Real shipped `collect()` end-to-end (chunk collect + concat + promise overhead included) —
binary drain median: 0.0139 ms @160 KB / 0.0216 ms @250 KB / 0.0291 ms @1 MB, i.e. **85x /
87x / 285x** over eager, reproducing the issue's eager numbers (1.30/2.05/8.35 ms).
Acceptance bar was >=2x; cleared by two orders of magnitude.

JSON path unchanged (same decode+parse work, moved to first read):

| body | eager (before) | lazy, spread (a) | lazy, .json read (a) |
|---|---:|---:|---:|
| 4.6 KB thunder-ish JSON (parses) | 0.010 ms | 0.011 ms (108%) | 0.010 ms (103%) |
| 8.1 KB html error page (parse fails) | 0.004 ms | 0.005 ms (125%) | 0.004 ms (118%) |

Sub-microsecond getter dispatch noise on identical decode+parse work; cached re-reads are free
(~0.0001 ms). Callers read plain properties (metadata.mjs:21 `res.json`) or destructure — all
getter-safe; the one spread site doesn't involve collect() at all (verified above).

## Tradeoffs

- Debug output of a collect result shows `[Getter]` for text/json until read (cosmetic, inspector-only).
- A caller reading `.text` but never `.json` now skips the doomed parse — a small bonus win, not a regression.
- None material otherwise: same object surface, same values, same error behavior (parse failures
  still yield `json === undefined`).

## Verification

- `node --test test/http.test.mjs`: **9 pass / 0 fail** (5 pre-existing + 4 new).
- New tests pin: (i) binary drain performs no utf8 decode (identity-scoped `Buffer.prototype.toString`
  spy + structural getter assertion), decode happens once on first text read, failed parse not
  retried (compute-once via flag sentinels); (ii) JSON text/json identical to the eager shape,
  openbook-style spread yields plain values; (iii) cache identity across re-reads; (iv) end-to-end
  `fetchBuffer` on the sim server's 64 KB `/bytes` route: byte-exact body, zero utf8 decodes,
  zero JSON.parse calls (window-scoped spies).
- Full `npm test` intentionally not run here (coordinator owns the final gate).

## Files touched

- `src/http.mjs` — collect(): lazy compute-once text/json getters (flag sentinels), doc comment
- `test/http.test.mjs` — 4 new collect()/fetchBuffer laziness + equivalence pins
- `perf/lanes/T3-W1-report.md` — this report
