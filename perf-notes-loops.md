# W23 — loop showdown: `cfc1` (src/read.mjs) and `descramble` (src/openbook.mjs)

Branch `perf-trial-20260906-104548-loops`, node v26.7.0, Apple M4.
Bench: `perf/loop-showdown.mjs` (self-contained; alternatives defined inline, winners promoted to src/).
Method: all variants in ONE process, 4 warmup runs each, then 11 interleaved timed runs,
median reported; every run's output verified identical to the reference pipeline.
Inputs: cfc1 = 2,800,000-char base64 blob (2.1 MB random bytes); descramble = 2,000,000-char
base64-ish string; descramble keys cover dense digits (9a2f4ed7), the test fixture shape
(dcba9), and run-slicing's best case (zyx8wvuts).

## cfc1 — 2.8 MB blob

| variant | median ms (run 1 / run 2) | speedup | verdict |
|---|---|---|---|
| pre-W23 u16 swapQuads pipeline | 28.12 / 28.63 | 1.00x | baseline |
| **latin1 bytes + indexOf fast swap (ADOPTED)** | **17.81 / 17.89** | **1.58–1.60x** | adopted (bar 15%) |
| latin1 bytes, general skip-loop | 19.28 / 19.34 | 1.46–1.48x | loses to indexOf variant |
| u16 tight loop (regex "no terminators" pre-scan) | 26.90 / 27.59 | 1.04–1.05x | tried, NOT adopted (< 15%) |
| latin1 bytes + hand-rolled JS base64 decoder | 22.14 / 22.37 | 1.27–1.28x | tried, NOT adopted |

Key findings:
- The native `Buffer.from(str,'base64')` beats a table-driven JS decoder over raw bytes by
  more than the latin1 string round trip costs — decode-from-string stays.
- Skipping the per-quad terminator *branches* (via `buf.indexOf(10/13)` pre-scan, which is
  memchr) buys ~8% over the always-checking skip loop. Real blobs never contain terminators,
  so the tight path is the one that matters; the checking loop remains for hostile ASCII.
- ASCII-gate cost (see below) measured separately: `Buffer.byteLength(s,'utf8')` 0.05 ms,
  regex `[^\x00-\x7F]` 0.95–1.37 ms, JS charCodeAt loop 2.5 ms on the 2.8 MB blob.

## descramble — 2 MB string, three key shapes

| variant | dense-8 (9a2f4ed7) | sparse-5 (dcba9) | long-sparse-9 (zyx8wvuts) | verdict |
|---|---|---|---|---|
| pre-W23 char loop (1-char array + join) | 22.64 / 24.28 ms | 23.93 ms | 21.10 ms | baseline |
| **latin1 bytes in place (ADOPTED)** | **5.25 ms (4.3x)** | **3.71 ms (6.5x)** | **3.40 ms (6.2x)** | adopted (bar 15%) |
| u16Array + fromCharCode.apply strides | 10.80 ms (2.1–2.25x) | 9.03 ms (2.65x) | 8.50 ms (2.48x) | adopted as the general fallback |
| run-slice pass-through (shift-0 runs via slice) | 36.85 ms (0.61x) | 19.46 ms (1.23x) | 9.21 ms (2.29x) | tried, NOT adopted |

- Run-slicing only pays when the key has long non-digit stretches (its best case is still
  2.7x slower than the byte path); on realistic digit-dense buids it is a regression.
- The u16-strides emit also clears the 15% bar on every key, so it replaces the old
  array-of-1-char-strings + join as the exact-for-any-string fallback inside `descramble`.

## What was adopted

1. `src/read.mjs cfc1()`: pure-ASCII blobs (the only kind on the wire) swap quads on latin1
   bytes in place; `buf.indexOf` picks a branch-free tight loop when no \n/\r exists, else the
   retry-just-past-the-terminator scan (mirroring the regex engine, byte-exact for 10/13).
   Anything with a code unit > 127 routes to the unchanged `swapQuads()` code-unit path.
2. `src/openbook.mjs descramble()`: pure-ASCII data shifts latin1 bytes in place (rotating key
   index instead of `a % klen`) and materializes with one native `toString('latin1')`;
   non-ASCII data uses the u16-strides code-unit loop. Now exported for tests.

## Equivalence argument / risks

- **ASCII gate**: `Buffer.byteLength(s, 'utf8') === s.length` holds iff every UTF-16 code unit
  is <= 127 (surrogates, U+2028/29, and all non-ASCII fail it). For such strings latin1
  encode/decode is lossless and byte value == code unit, so the swap/shift arithmetic is
  bit-identical. (Probed: latin1 `byteLength` does NOT expose >255 chars — utf8 length equality
  is the reliable cheap test.)
- **Non-ASCII fallback**: gate failure routes to the previous exact implementations (swapQuads
  pipeline / u16 code-unit loop). Pinned by new tests:
  - `test/read.test.mjs` "cfc1 falls back to the code-unit path for any code unit > 127"
    (latin1-range, >latin1, surrogate pair, U+2028, and NUL/0x7f staying on the fast path).
  - `test/openbook.test.mjs` "descramble matches the character-loop reference (fast path and
    fallback)" against the verbatim pre-W23 loop, plus a 1000x-round-trip scale test.
- **Byte-range safety (descramble)**: inputs <= 127, shift <= 93 → pre-wrap <= 220, post-wrap
  `(ch % 126) + 32` <= 157 — every stored value fits a byte; no silent truncation.
  The buffer is a private copy (`Buffer.from(data,'latin1')`); the input string is never aliased.
- **Terminators (cfc1)**: \n/\r are handled in byte space with the same jump-past-the-terminator
  semantics; U+2028/U+2029 are > 127 so they always take the fallback. The pre-existing
  terminator tests now exercise the byte-space skip loop unmodified.
- **API surface**: `descramble` gained `export` (additive; doc-commented "Exported for tests").
- **Memory**: cfc1 fast path transients are ~2.8 MB buf + 2.8 MB string (was a 5.6 MB
  Uint16Array + 2.8 MB rebuilt string) — roughly half.
- **Noise**: baseline medians moved 28.12 → 28.63 ms between runs (~2%); all adoption decisions
  sit at 1.6x+ or 4x+, far outside noise; the closest rejected variant (u16 tight, 1.04x) is
  nowhere near the 15% bar.

## Results

- 68/68 tests pass (`node --test`; 65 pre-existing unmodified + 3 added).
- Numbers above reproducible via `node perf/loop-showdown.mjs`.
