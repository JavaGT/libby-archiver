# Lane T2-W2C — archive --all loan pipelining + read-path manifest pre-hash

Trial: perf-trial-20260909 · base branch tip: `perf-trial-20260909` (ffae607) · parent: perf meta-coordinator

## Goal (two closely-related changes, one lane)

1. **Loan pipelining.** During `archive --all`, overlap the next loan's setup round
   trips (auth-refresh / loan metadata / page-plan fetches) with the current loan's
   media downloads. Bounded to ONE prefetch in flight. Ordered console logs (same
   output order as today). Identical failure semantics (a failing loan fails the run
   exactly as before; a prefetch failure never poisons the current loan).
2. **Read-path manifest pre-hash.** Hash page/asset/cover bytes while they are in
   hand after download, and feed `writeManifest`'s `known` map, so the integrity pass
   stops re-reading the archive from disk. Call site today: `src/archive.mjs:158`
   already passes `known: partHashes` — find where those hashes are computed; if they
   are computed by re-reading files, move the hashing to the in-hand byte moment
   instead. `src/archive-read.mjs:194` does the same for the read path.

## Evidence baseline (perf/results-t2-baseline.json, fc670da, Apple M4, medians)

- manifest hash 50 MB: 17.36 ms (baseline copy) — target: eliminate the re-read, not the hash
- keep-alive pooling + concurrency already merged in trial 1 (perf-trial-20260906)
- `--all` wall has NO baseline yet → produce one with `node perf/net-sim.mjs src`
  (extend net-sim with a loan-pipeline section if useful; you own perf/net-sim.mjs)

## Ownership (disjoint — hard boundaries)

MAY touch: `bin/libby.mjs` (archive command path only), `src/archive.mjs`,
`src/archive-read.mjs`, `src/download.mjs`, `src/pool.mjs`, `perf/net-sim.mjs`,
your own notes file `perf-notes-t2-w2c.md`, tests under `test/` for owned files.
MUST NOT touch: `src/util.mjs`, `src/epub.mjs`, `src/metadata.mjs`, `src/http.mjs`
(Lane D), `perf/report-data.json`, `PERF-REPORT.html`, `perf/bench.mjs`,
`perf/render.mjs` (meta-coordinator owns report render + bench).

## Method

- Removal-first: prefer deleting a redundant re-read/re-fetch over adding a cache.
- Measure before/after with medians (≥5 runs); record node version + machine.
- Kill criterion (pre-agreed): if ordered logs + identical failure semantics need
  more than a ~100-line diff, reject pipelining and say so with the diff size.
- Adoption bar: ≥10% on the named metric (simulated --all wall; manifest re-read
  elimination counts as a win only if measured e2e, not just isolated).
- Output-identical check: diff CLI stdout/exit codes for an --all run against the
  pre-change binary on a small simulated loan set (use test fixtures / net-sim; do
  NOT hit the real OverDrive network).

## Focused checks

`npm test` (node --test; 80 pass at ffae607) · `node --expose-gc perf/bench.mjs --quick`
(regression sanity) · your net-sim section before/after.

## Worktree rules

Child works in its OWN worktree: `git worktree add ../perf-trial-<YYYYMMDD-HHMMSS>
-b perf-trial-<YYYYMMDD-HHMMSS> perf-trial-20260909` (branch FROM the trial tip).
Commit early/often on that branch only. Never touch the shared checkout or the other
lane's worktree. No Safari. No whole-repository sweeps — this lane's files only.

## Receipt

Manager writes `perf/lanes/T2-W2C-receipt.md` on the child branch: verdict
(adopted / measured-rejected / honest-stop), before/after table, tradeoffs, diff
size, test result, exact commands run. Return a ≤2000-char structured summary.
