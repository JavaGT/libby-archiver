# T2-W1B — cfc1 quad-swap: word-at-a-time (u32) variants

Worktree: perf-trial-20260909-030719. Bench: `perf/loop-showdown.mjs` (T2 section
added; W23 rows kept for continuity). Node v26.7.0, same process, interleaved
medians. **src/read.mjs NOT changed** — nothing cleared the 15% adoption bar.

## Verdict: MEASURED, REJECTED

The u32 view swap is real (1.60x on the isolated loop, byte-identical output on
144 adversarial fixtures), but the swap loop is only ~0.5 ms of an ~18 ms
pipeline on the trial blob (~3%). End-to-end it buys 1.01x on the 2.8 MB blob —
nowhere near 15%. The pipeline's ceiling is the native **utf8 decode of the
random-bytes fixture: 17.26 ms of ~18.1 ms (95%)**. No swap variant can move it.

## Variants (median ms)

Swap loop only (2.8 MB latin1 buffer, fresh copy per run, output `.equals`-verified
outside the timed window):

| variant                        | median | vs byte loop |
|--------------------------------|-------:|-------------:|
| byte loop (current)            | 0.533  | 1.00x        |
| **u32 view +shift/mask**       | 0.334  | **1.60x**    |
| u32 view unrolled x2           | 0.335  | 1.59x        |
| u16 halfword pairs             | 0.541  | 0.99x        |
| byte unrolled x2               | 0.594  | 0.90x        |
| u32 readUInt32LE/writeUInt32LE | 3.638  | 0.15x        |

Full cfc1 pipeline (identity-verified per run vs src export):

| variant                  | random blob | realistic XHTML blob |
|--------------------------|------------:|---------------------:|
| byte loop (current)      | 18.11 ms    | 3.39 ms              |
| u32 view +shift/mask     | 17.97 (1.01x) | 3.15 (1.08x)      |
| u32 view unrolled x2     | 17.89 (1.01x) | 3.27 (1.04x)      |
| u16 halfword pairs       | 18.17 (1.00x) | 3.37 (1.01x)      |
| byte unrolled x2         | 18.13 (1.00x) | 3.51 (0.97x)      |
| u32 readUInt32LE/write   | 21.31 (0.85x) | 6.53 (0.52x)      |

Word math that works (LE): `w' = (w >>> 24) | (w & 0x00ffff00) | (w << 24)` —
old m3 lands in byte 0, m1/m2 stay, old m0 (`w << 24` keeps only the low byte)
lands in byte 3. The u16 halfword trick nets nothing (4 ops + 2 stores per quad
on smaller words ≈ the byte loop). Method-call u32 (`readUInt32LE`/`writeUInt32LE`)
is 6.8x *slower* than the byte loop — never again. Note: the first u32 draft had
the top byte sourced wrong (`w & 0xffffff00` keeps old m3 at the top instead of
moving old m0 there); the adversarial identity harness caught it on len-4/5
fixtures before anything was timed — the harness is doing its job.

## Identity checks

`verifyT2Identity()` in the bench runs every variant against the src `cfc1`
export on **144 fixtures, all pass**: random printable ASCII at lengths
0–9, 15, 16, 63–65, 255–257, 4095–4097 (n%4 != 0 covered); `\n` and `\r`
planted at every offset of a 48-char base (window offsets 0..7 and beyond);
`\n`+`\r` pairs at gaps 0..7; terminators at the start and in the final
partial-window region for n%4 != 0; all-terminator strings; one U+2029 fixture
through the swapQuads fallback. Terminators keep the proven byte skip-loop in
all variants (only the clean inner loop varies); the byte-realignment
resume-just-past-the-first-terminator semantics are untouched and verified.

## Stage split (the ceiling, per fixture)

| stage                        | random bytes | realistic XHTML |
|------------------------------|-------------:|----------------:|
| gate isAscii                 | 0.05 ms      | 0.05 ms         |
| Buffer.from latin1           | 0.19 ms      | 0.11 ms         |
| indexOf x2 (\n\r scan)       | 0.28 ms      | 0.24 ms         |
| swap loop (byte)             | 0.59 ms      | 0.53 ms         |
| toString latin1              | 0.21 ms      | 0.15 ms         |
| Buffer.from base64           | 0.30 ms      | 0.17 ms         |
| **utf8 toString (incl b64)** | **17.26 ms** | **0.22 ms**     |
| TextDecoder utf8 (incl b64)  | 17.24 ms     | 0.26 ms         |

Base64 does NOT dominate — it is ~0.3 ms. The utf8 stage does, but only because
the trial fixture decodes 2.1 MB of *random bytes*: almost every sequence is
invalid/multi-byte UTF-8, so the native decoder runs its error-tolerant slow
path (17 ms). On realistic ASCII page content the same stage is 0.1–0.2 ms and
the whole pipeline drops 18.1 → 3.4 ms. `TextDecoder` is bit-identical and
identically fast — not a lever.

On the realistic fixture the stage sums (~1.5 ms) fall ~1.9 ms short of the
3.39 ms full-pipeline median: that gap is the pipeline's large transients
(2.8 MB buf + 2.8 MB latin1 string + 2.1 MB bytes + output string) showing up
as allocation/GC time that per-stage isolation hides.

## Where the next trial's headroom is

1. **Fixture honesty first.** "~19.4 ms for a 2.8 MB blob" is an artifact of
   random bytes; a real 2.8 MB ASCII page blob runs the current pipeline in
   ~3.4 ms (~820 MB/s). Decide which number the trial gates on.
2. **Transient allocations** (~1.9 ms on realistic content) are then the
   biggest single item — e.g. decode base64 straight from bytes without the
   latin1 string round trip. W23 measured a JS table decoder slower (22.1 vs
   17.8 ms), but that was on the random fixture where utf8 dominates; its
   economics on the realistic fixture are unmeasured and now look different.
3. **u32 swap is adopted-ready** if ever needed: byte-identical on all 144
   fixtures, 1.60x on the loop, ~1% end-to-end on the trial blob. Promotion is
   a 6-line change to the clean path in `cfc1()` (alignment-guarded
   Uint32Array view); leave it out until something above makes the swap matter.

Verification: `npm test` — 80 pass / 0 fail (baseline intact, src untouched).
Bench rerun: `node perf/loop-showdown.mjs` (identity checks gate all timing).
