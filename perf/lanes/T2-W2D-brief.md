# Lane T2-W2D — EPUB assembly RAM/storage audit on big fixtures

Trial: perf-trial-20260909 · base branch tip: `perf-trial-20260909` (ffae607) · parent: perf meta-coordinator

## Goal

Bill of health on a ~45 MB synthetic magazine fixture (build it with/extend
`perf/gen.mjs`):

1. `writeEpub` wall time + **peak RSS** vs the theory floor (entry + one payload
   resident at a time; trial 1 made assembly single-pass streaming — verify no
   hidden full-copy remains).
2. `writeManifest` read sizing (`src/util.mjs:138`): highWaterMark, worker
   concurrency of the hashing read path — is the 50 MB manifest hash
   (17.36 ms baseline) read-bound or hash-bound?
3. `downloadCover` buffering audit (`src/http.mjs`): does the cover path buffer
   more than needed?
4. Storage accounting (record-only, product decision): pages/assets vs EPUB
   duplication ratio; pretty vs compact sidecar JSON size delta.

## Evidence baseline (perf/results-t2-baseline.json, fc670da, Apple M4, medians)

- zip_assembly 13 MB EPUB: 6.48 ms (was 177 pre-trial-1) — assembly is near-floor,
  so RAM is the open question, not wall
- manifest hash 50 MB: 17.36 ms

## Ownership (disjoint — hard boundaries)

MAY touch: `src/epub.mjs`, `src/util.mjs`, `src/metadata.mjs`, `src/http.mjs`,
`perf/bench.mjs` (add a big-fixture RSS section), `perf/gen.mjs`, your own notes
file `perf-notes-t2-w2d.md`, tests under `test/` for owned files.
MUST NOT touch: `bin/libby.mjs`, `src/archive.mjs`, `src/archive-read.mjs`,
`src/download.mjs`, `src/pool.mjs` (Lane C), `perf/net-sim.mjs`,
`perf/report-data.json`, `PERF-REPORT.html`, `perf/render.mjs` (meta-coordinator).

## Method

- Removal-first: prefer deleting a redundant buffer/copy over tuning a flag.
- Measure with `node --expose-gc perf/bench.mjs` (extend with your section) +
  `process.resourceUsage().maxRSS` / `--max-old-space-size` probes; medians ≥5 runs.
- Adoption bar ≥10% improvement on the named metric (peak RSS or wall) for any code
  change; storage duplication findings are RECORDED for the owner, never changed.
- Byte-identical outputs required for any adopted change (EPUB + manifest digests
  must match pre-change on the same fixture).

## Focused checks

`npm test` (node --test; 80 pass at ffae607) · your bench.mjs big-fixture section
before/after.

## Worktree rules

Child works in its OWN worktree: `git worktree add ../perf-trial-<YYYYMMDD-HHMMSS>
-b perf-trial-<YYYYMMDD-HHMMSS> perf-trial-20260909` (branch FROM the trial tip).
Commit early/often on that branch only. Never touch the shared checkout or the other
lane's worktree. No Safari. No whole-repository sweeps — this lane's files only.

## Receipt

Manager writes `perf/lanes/T2-W2D-receipt.md` on the child branch: verdict
(adopted / measured-rejected / honest-stop), before/after table, tradeoffs, diff
size, test result, exact commands run, storage-accounting numbers for the owner.
Return a ≤2000-char structured summary.
