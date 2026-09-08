# T2-W2C lane receipt — archive --all loan pipelining + read-path manifest pre-hash

Trial: perf-trial-20260909 · Ticket: JavaGT/libby-archiver#2
Branch: `perf-trial-20260909-035217` (from tip 218571c) · Worktree: `/Users/server/Development/perf-trial-20260909-035217`
Commits: `58d6d64` (implementation) + `4dafda8` (hostile-review fix + regression test) · Receipt commit: see git log
Environment: Node v26.7.0, Apple M4, macOS (darwin arm64)

## Verdict: MEASURED-REJECTED

Both changes are functionally correct (81/81 tests, manifests byte-identical) but fail the
pre-agreed >=10% adoption bar on the named metric (simulated e2e `--all` wall). Code is left
in the measured-rejected state on this branch for the meta-coordinator to merge or drop.

## Before/after (medians of 5 runs unless noted)

| Metric | Before (218571c) | After (4dafda8) | Delta | Judgement |
|---|---|---|---|---|
| e2e simulated `--all` wall, 4 loans (raw: 452/458/456/455/452 vs 445/444/446/447/445) | 455 ms | 445 ms | −2.2% | FAILS >=10% bar |
| net-sim `loan_pipeline_4x` model (3 serial setup RTTs + 8 media reqs) | 555 ms sequential | 391 ms pipelined | −29.5% | model only; shows the win is latency-dependent |
| `manifest_hash_50mb` bench sample (writeManifest full-hash cost) | 33.1 ms | 25.3 ms | isolated only — does not count per brief | |
| npm test | 80 pass | 81 pass | green | |

## What was built

1. **Loan pipelining** (`bin/libby.mjs` archive path, `src/archive.mjs`, `src/archive-read.mjs`):
   `prepare{Audiobook,Readable}` split out (openLoan + fetchOpenbook); the `--all` loop starts
   ONE next-loan setup promise via `onSetupReady` (fired after current loan's spine extraction,
   before media downloads). No logging in the prefetch path → console order unchanged. A failed
   prefetch is swallowed (`catch(() => null)`) and retried synchronously by the next archive call,
   so it never poisons the current loan and deterministic failures behave exactly as before.
2. **Read-path manifest pre-hash** (`src/archive-read.mjs`): page and asset bytes are sha256-hashed
   in hand after download and fed to `writeManifest`'s `known` map, eliminating the manifest-time
   disk re-read for those entries. Cover excluded: `downloadCover` (src/metadata.mjs, not owned)
   returns only a destination path.

## Tradeoffs and evidence notes

- **Round-1 bug (found in manager hostile review, fixed in 4dafda8):** the loop's `prefetched`
  variable was never cleared after consumption; a loan failing BEFORE `onSetupReady` (e.g.
  `extractSpine` throwing on an empty spine) leaked its passport/openbook into the NEXT loan's
  archive — silent cross-loan content corruption. Fixed with a consume-and-clear state object
  (`takePrefetched`). This bug is itself evidence for rejection: the complexity tax of pipelining
  is real and the sim workload buys only 2.2% for it.
- **Manager caveat:** the regression test (`test/archive-prefetch.test.mjs`) pins the
  `takePrefetched` helper contract, not the full loop failure path; the fix itself was verified
  by diff review.
- **Output-identical CLI check: not run, honestly stopped.** The CLI's `sync()` contacts the
  hard-coded `sentry.libbyapp.com` gateway for auth/loan discovery; the existing sims only cover
  listen/read/catalog hosts, and redirecting the gateway would require editing non-owned
  http/auth files. Content equivalence is covered by the e2e archive tests (folder + manifest
  byte checks) plus the regression test. No real OverDrive network was hit.
- **Pre-hash e2e contribution** is not separable from the combined 2.2% and is negligible on
  sim-sized payloads; the mechanism is proven byte-identical by existing tests
  ("known digests skip the re-read yet yield a manifest identical to a full hash").
- **Ownership respected:** only `bin/libby.mjs` (archive path), `src/archive.mjs`,
  `src/archive-read.mjs`, `perf/net-sim.mjs`, `perf-notes-t2-w2c.md`,
  `test/archive-prefetch.test.mjs` touched. Forbidden files untouched; the shared checkout's
  foreign uncommitted changes were never touched.

## Diff size

6 files, +192/−17 total: bin/libby.mjs +26, src/archive-read.mjs +33/−, src/archive.mjs +18/−,
perf/net-sim.mjs +48 (owned tooling: pipeline model section), perf-notes-t2-w2c.md +63 (notes),
test/archive-prefetch.test.mjs +21. Source-only diff ≈77 lines — under the ~100-line kill
criterion; rejection is on the adoption bar, not the diff budget.

## Exact commands

- `git worktree add ../perf-trial-20260909-035217 -b perf-trial-20260909-035217 perf-trial-20260909`
- `node perf/net-sim.mjs src` (baseline x5 and after x5, incl. new `loan_pipeline_4x` section)
- `npm test` (80 before → 81 after, 0 fail; manager re-ran both rounds)
- `node --expose-gc perf/bench.mjs --quick` (regression sanity, agreeing outputs)
- e2e `--all` wall: four-loan simulated listen-host archive-all harness, 5 runs per variant
  (raw samples in `perf-notes-t2-w2c.md`)
- `git archive 218571c` baseline extraction attempted for the CLI stdout check; abandoned as
  infeasible within ownership (see above)
