# libby-archiver automation receipt — 2026-09-12 attempt 1 (0300 run)

- status: in-progress
- started: (local run start)
- scope: implement-fleet — drive admitted perf tickets to landed-and-approved; perf-audit / abstraction-zoom as capacity allows
- time_box: (pending)
- failure_class: none

## Attempt 1 — 0800 NZST continuation run (this file's owner)

- 08:26 — start; repo clean at 9b202bb except this receipt (untracked, mine). Open tracker:
  #12/#14/#16 (evaluate-only, complete in-body, owner-gated), #1 (external auth bug, out of scope).
- 08:27 — perf-audit discovery: prior waves cover startup (T2-W1A), lazy crypto (T3-W4),
  keep-alive (W7), EPUB RAM thunks (W12/W16), borrow/periods overlaps (#13/#15). Uncovered:
  avail/info/search post-bootstrap, archive-read sequencing, loans/metadata.
- 08:29 — `node --expose-gc perf/bench.mjs --quick --label t7-regression` (perf/results-t7-regression.json):
  NO performance regressions — current ≤ baseline on every timing (zip 207→14.6ms, cfc1
  67.9→21.7ms, openbook 62.1→10.7ms, manifest 51.9→19.8ms, help spawn 34.3→31.6ms vs 27.1ms
  node floor). Qualification (Luna docs sweep returned FIX-FIRST; fixed here): zip_assembly
  `outputBytesAgree:false` is the known intentional W12 streaming-zip layout difference —
  present identically in perf/results-merged-waves.json and perf/results-t2-final.json — not a
  new regression; output correctness is pinned by test/epub-integrity.test.mjs (93/93 green).
- 08:31 — candidates inspected and DECLINED (not material, evidence in-repo):
  (a) `getAvailability` sequential chunks — AVAILABILITY_CHUNK=100 (src/discover.mjs:19); only
  >100 ids per call affected; unrealistic for a personal CLI. (b) archive-read two-phase
  page→asset fetch (src/archive-read.mjs:105-133) — arithmetic equivalent to interleaving under
  the shared mapLimit cap (4 in-flight continuously either way; total wall = (P+A)/4 RTT slots);
  overlap saves only phase-boundary microseconds. Not a finding; recorded here to prevent
  re-derivation. (c) hold/unhold pay no unconditional sync — #16's scope is complete as written.
- 08:29-08:38 — peer automation run (attempt-2, 7c035e05) filed #17 (Strong, ~568ms duplicate
  /chip/sync) in this shared checkout and committed its own receipt addendum (a7e7a68). No path
  collisions; its receipt explicitly acknowledges mine as mine. Full node --test 93/0 at its HEAD.
- 08:39 — ADMITTED #17 for implementation (unclaimed; its "#12-conditional" caution is satisfied
  by the sketch's fallback design — reuse when payload exists, fetch otherwise, correct under
  either #12 outcome). Claim comment posted (issuecomment-5640314982). Native implementer lane
  T7-W1 dispatched (src/auth.mjs, src/loans.mjs, bin/libby.mjs, test/, perf/lanes/T7-W1-report.md).
- Next: milestone commits from T7-W1 → hostile review via opencode2 (different model, read-only)
  → reconcile → close #17 → final receipt.
