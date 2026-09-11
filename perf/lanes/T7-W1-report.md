# T7-W1 — reuse the verified /chip/sync payload across authenticate and loans.sync (#17)

## What / why

Every command that authenticates AND syncs paid the identical
`GET /chip/sync` twice serially: once inside `authenticate()`'s
cached-session verify (src/auth.mjs, response used only as a boolean), then
again in `loans.sync()` (src/loans.mjs) for `list`, `archive`, and `return`'s
loan lookup. #17 (Strong, 0300 continuation pass) measured the second fetch
at ~568 ms median.

Fix — REUSE, not removal (smallest sound intervention per the ticket):
commits **8925ccc** (source) and **57c8d94** (pins), +275/−13 across
src/auth.mjs, src/loans.mjs, bin/libby.mjs, test/.

- `src/auth.mjs`: the cached-session verify now returns the verified payload
  (`result === 'synchronized'`) or null via `verifiedSync()`; the boolean
  gate is preserved exactly (`status === 200 && result === 'synchronized'`,
  `!== null` at the call site — same check, same catch-to-false shape).
  `authenticate()` returns it additively as `syncData`; the fresh-mint
  (re-bootstrap) path never syncs and returns no payload, exactly as the
  ticket anticipated — the fallback covers it.
- `src/loans.mjs`: `sync(client, identity, { reuse } = {})` normalizes from
  `reuse` when supplied (`reuse ?? fetch`), else fetches GET /chip/sync as
  before. Same return shape either way (`{ cards, loans, raw }`).
- `bin/libby.mjs`: passes `syncData` at the two sync sites that follow
  authentication in the same invocation — `return`'s loan lookup (confirm
  prompt) and the shared list/archive block. `borrow`/`hold`/`unhold` don't
  call loans.sync; the fresh-mint fallback is untouched. Unlike #15's kick,
  no identity-guard is needed: the payload is not a kicked read — it is the
  verify result itself, produced by the same `authenticate()` call that
  returned the identity in scope.
- `src/index.mjs`: untouched; public surface additive-only (authenticate's
  return gained an optional property; sync gained an optional third
  parameter).

## Acceptance criteria — all four, with evidence

1. **Measured A/B** — see below: `libby list` median 2676.2 → 2121.5 ms
   (−554.7 ms, −21%); the list-vs-auth median delta collapsed 783.9 →
   162.4 ms (residual = lazy module loads + output, not a fetch).
2. **Hermetic pin** — `test/sync-reuse.test.mjs` (request-counting loader):
   cached-session `libby list` logs exactly one `GET /chip/sync` and renders
   the sim loan byte-for-byte; no-session `libby list` runs the full
   fresh-mint chain and fetches exactly once. `test/loans.test.mjs` pins the
   sync() contract: reuse never fetches, fallback fetches once, shapes
   deep-equal. Both CLI pins **fail on the pre-change tree** (two
   `GET /chip/sync` — regression-proven via `git archive a7e7a68` to /tmp,
   the T5 precedent).
3. **Byte-compatibility** — live: `libby list` stdout byte-identical
   base-vs-after in all 9 interleaved rounds (`libby auth` stdout identical
   too); 0 bad exits. Hermetic: the pin asserts the exact rendered line.
   `return`'s confirm flow unchanged (same loan list, same prompt code path;
   no live `return` was run — it mutates the account, forbidden this lane).
   Fresh-mint path still works: exercised end-to-end by the fallback pin.
4. **Full suite green** — `node --test`: **99 pass / 0 fail** at 57c8d94.

## Measured (Apple M4 arm64, Node 26.7.0, spawnSync wall-clock medians, 9 interleaved base-vs-after rounds, order swapped per round, one untimed warmup per side per scenario, cwd in isolated XDG temp)

Real config via a COPY under an isolated `XDG_CONFIG_HOME`; session is a
COPY passed with `--session` (the cached-session path never rewrites it —
verified unchanged after all runs). READ-ONLY commands only (`list`,
`auth`). Owner `config.json`/`session.json` shasum + mtime verified
byte-identical before and after all runs; all temp copies deleted.

| scenario | base (a7e7a68) | after (57c8d94) | median delta |
| --- | ---: | ---: | ---: |
| `libby list` | **2676.2 ms** (2324–3311) | **2121.5 ms** (1854–3359) | **−554.7 ms** |
| `libby auth` (floor) | 1892.3 ms (1844–2206) | 1959.1 ms (1875–2527) | +66.8 ms (noise) |
| list − auth | 783.9 ms | **162.4 ms** | the second sync is gone |

Live network variance is high (as in T5/T6); the medians are the signal and
the hermetic pin is the structural proof. The issue's predicted ~568 ms
second-fetch cost matches the measured −554.7 ms.

## Deviation from the sketch (one, deliberate)

The sketch said "`verify()` keeps its boolean contract". `verify()` was a
module-private helper with exactly one caller (authenticate's cached path);
keeping it boolean alongside a payload-returning path would have meant either
two fetches or dead code. `verify()` became `verifiedSync()` returning the
payload-or-null, with the boolean gate preserved verbatim at the call site
(`syncData ? return… : re-bootstrap`). No other caller existed (grep-verified;
cli-lazy's USAGE table only imports `authenticate`).

## Verification

- `node --test test/sync-reuse.test.mjs test/loans.test.mjs test/cli-lazy.test.mjs test/auth.test.mjs`: 18 pass / 0 fail.
- Full `node --test` (15 files): 99 pass / 0 fail at 57c8d94.
- `git diff --stat` per commit: 8925ccc = bin/libby.mjs + src/auth.mjs +
  src/loans.mjs only; 57c8d94 = test/ only (+ nothing else). No foreign
  files touched; `artifacts/**` and `perf/results-t7-regression.json`
  (foreign untracked) left alone.
