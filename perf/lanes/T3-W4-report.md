# T3-W4 — lazy node:crypto in util.mjs: where sheds the last static-import cost (#9)

## What / why

After #5, `libby where` still sat ~2.4 ms above `libby help` because
`config.mjs → util.mjs` statically imported `node:crypto` — the only remaining
heavy builtin in the light-command import graph. Ticket #8's evaluation measured
the crypto chain as the whole residual.

Grep found crypto used at exactly one site in `src/util.mjs`: the sha256 hashing
inside `writeManifest`'s per-file `hashOne`. (The lane brief expected a second
site — a sha256 temp name in `writeFileAtomic` — but the checked-in
`writeFileAtomic` uses a pid-based temp name (`${file}.tmp-${process.pid}`) and
never touches crypto, so the planned `createRequire` fallback was unnecessary.)

The fix (issue #9, smallest shape):

- Static `import crypto from 'node:crypto'` removed from `src/util.mjs`.
- `writeManifest` resolves `const { createHash } = await import('node:crypto')`
  once at function entry — the natural per-run boundary, outside the worker pool
  and the per-file loop. After the first call the builtin import is cached
  (sub-microsecond); the one-time crypto init lands inside an archive run that is
  already doing seconds of I/O + SHA work.
- No new module, no API change, no behavior change. `src/config.mjs` untouched.
- New pin in `test/util.test.mjs`: `writeFileAtomic` renames atomically, leaves
  no `.tmp-` residue on success, and on a failed rename (directory target)
  removes its temp file and rethrows (acceptance criterion 4 — previously
  unpinned). It passed on base `6a021b4` before the lazy edit, so it provably
  pins existing behavior.

## Measured (Apple M4, Node 26.7.0, spawnSync median of 9, same session)

Interleaved base-vs-after A/B (base materialized to /tmp via `git archive
6a021b4`, so both trees run in one interleaved session — 3 repetitions):

| surface | base (6a021b4) | after (41dd556) | delta |
| --- | --- | --- | --- |
| `libby help` | 24.6 / 24.5 / 24.8 | 24.4 / 24.7 / 25.3 | — |
| `libby where` | 27.0 / 26.6 / 27.1 | 25.7 / 24.8 / 25.7 | **−1.3 ms** |
| `libby probe` | 24.5 / 25.5 / 24.2 | 24.3 / 24.4 / 24.8 | — |
| where − help | 2.4 / 2.1 / 2.3 | 1.3 / 0.1 / 0.4 | **−1.9 ms (median)** |

Standalone same-session run (bench §6 style, floor included): base floor 22.1 /
help 23.9 / where 26.2 / probe 25.1 → after floor 22.4 / help 24.5 / where 26.5
/ probe 24.2 (that after-pass caught a noisy stretch; the interleaved A/B above
is the controlled evidence).

In-process import cost of `src/config.mjs` (file-based, fresh process):
**3.40 ms on base (loads crypto) → 1.87 ms after (crypto-free)**.

`writeManifest` sanity (50 × 512 KiB fixture, warm runs): base 9.9 / 9.8 ms vs
after 9.7 / 10.1 ms — unchanged within noise; the per-call `await import` is
free after first resolution.

**Verdict: success.** `where − help` drops from ~2.3 ms to ~0.1–1.3 ms
(median ~0.4 across the three controlled passes), inside the issue's ~1 ms
target. The static graph of `config.mjs` is transitively crypto-free, so
`where`/`init`/`search`/`info` startup no longer pays for crypto at all.

## Measurement-method correction (for future lanes)

The #8/#9 baseline table was taken with `node -e`-style dynamic imports. On
Node 26.7.0, bare `node -e ''` **already loads `NativeModule crypto`** via the
eval bootstrap, so those marginal attributions ("+crypto+os = 24.2") were
partly contaminated. File-based probes are the honest vehicle: bare
`node file.mjs` loads no crypto (`process.moduleLoadList` verified). The true
CLI-level crypto cost was the ~1.3 ms `where` delta above, consistent with the
in-process 3.40 → 1.87 ms config-import measurement.

## Verification

- Static-graph proof (fresh process, file-based probe):
  - base: `import('./src/config.mjs')` → 19 `*crypto*` entries in
    `process.moduleLoadList` (full `NativeModule crypto` chain).
  - after: same probe → `crypto entries: []`.
- `node --test test/util.test.mjs`: 8 pass / 0 fail (incl. new pin + the two
  manifest byte-identity tests).
- `node --test test/cli-lazy.test.mjs`: 3 pass / 0 fail.
- `node --test test/manifest-ref.test.mjs`: 2 pass / 0 fail (manifest
  byte-identity pins).
- `node --test test/http.test.mjs`: 9 pass / 0 fail (regression canary, untouched).
- `git diff --stat` at commit: only `src/util.mjs` (+6/−2) and
  `test/util.test.mjs` (+26).
