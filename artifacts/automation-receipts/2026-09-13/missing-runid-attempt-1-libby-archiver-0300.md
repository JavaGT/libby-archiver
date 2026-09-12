# Automation receipt — libby-archiver 0300 slot, 2026-09-13 (local)

{"schema_version":1,"run_id":"missing-runid","attempt":1,"status":"meaningful-progression","failure_class":"none","time_box":"completed-within-budget","started_at":"2026-09-13T09:05:08+12:00","finished_at":"2026-09-13T09:30:00+12:00","next_action":"owner decides #12 (verify-skip on borrow/hold/unhold) and #14 (multi-title net-sim harness + rate-limit call); next run re-audits","evidence":[{"path":"artifacts/automation-receipts/2026-09-13/ab-probe-0300.mjs","kind":"artifact"},{"path":"artifacts/automation-receipts/2026-09-13/bench-quick-0300.json","kind":"check"},{"path":"artifacts/automation-receipts/2026-09-13/review-0300-16-evidence.md","kind":"check"},{"path":"perf/results-run-0300-2026-09-13.json","kind":"check"},{"path":"github:JavaGT/libby-archiver#16","kind":"ticket"},{"path":"github:JavaGT/libby-archiver#12","kind":"ticket"}]}

## Attempt 1 log (coordinator: ZCode/GLM, implement-fleet playbook)

- 09:05 — start. Repo clean at d5a9e6d. No run_id/attempt supplied by scheduler →
  missing-runid / attempt 1 per the 2026-09-12 manifest convention.
- Admission decision: open perf tickets are #12, #14, #16 (all evaluate-only,
  owner-gated per 0800 receipt) and #1 (external auth bug, out of scope). No
  implementation-approved tickets exist to admit as lanes.
  - #16: ADMITTED for closure — its own last comment sets the resolution condition
    ("if #17's reuse fix lands, return's sync becomes free … reconcile the two"),
    and #17 landed + review-approved (d349786/57c8d94/8925ccc, closed 09:18 0800 run).
    Deliverable: fresh A/B measurement proving return's marginal sync cost is now ~0,
    then close with the reconciliation evidence.
  - #12/#14: NOT admitted for implementation (owner-gated evaluate-only; in-body
    evaluations complete). #12 gets a fresh post-#17 measurement as a comment so the
    owner decides on current numbers; #14 unchanged (harness + rate-limit owner call).
  - Re-audit (performance-audit playbook): the recorded next_action from the 0800
    receipt ("next scheduled run re-audits"). Bounded: regression sweep + focused
    checks + serial-RTT journey review of the current tree. File tickets for any
    material finding; no-finding is an acceptable result.
- Child budget: max 3 total. Plan: 1 opencode2 review seat for the closure evidence;
  2 reserved for an implementation lane + hostile review only if the re-audit finds a
  safe, landable fix.

## Evidence

- 09:12 — #16 closure A/B (probe: ab-probe-0300.mjs, methodology per T6/T7 lane
  reports): auth median 1929.5 ms vs return-fake-id median 1956.6 ms → marginal
  delta **27.1 ms** (was ~496 ms marginal pre-#17). Per-side stdout/stderr
  byte-identical, exits 0/1 as expected, owner config/session sha256+mtime
  untouched. ⇒ code path proves return's sync reuses the verify payload; the
  27.1 ms delta (≈ the ~28 ms node startup floor) is consistent with no extra
  round trip (reviewer-adjusted wording: timing supports, code path proves).
- 09:16 — re-audit no-finding evidence: bench --quick sweep clean, every section
  baseline-or-better, outputs agree (bench-quick-0300.json; cfc1 64→18.9 ms,
  openbook 79.4→7.3 ms, manifest 48.3→26.5 ms, startup 33.9→28.1 ms at the 28 ms
  node floor). node --test: **100 pass / 0 fail** (563 ms).
- 09:16 — journey review: all four overlap mechanisms verified in place (#13
  formatLookup kick bin/libby.mjs:386-395; #15 periods kick 408-417; #17 sync
  reuse at list/archive/return bin/libby.mjs:479,515 + src/auth.mjs:75-88 +
  src/loans.mjs:14-20 identity-gated). Remaining serial verify = #12 owner call;
  hold/unhold declined 0800 with evidence. No new landable finding; audit = no-finding.
- 09:20 — #12 refreshed with post-#17 owner-input numbers (comment
  5648731297); ticket stays open, owner decision. #14 untouched (harness +
  rate-limit owner call still outstanding).
- 09:20 — dispatched 1 background review seat (openai-gpt-5.6-luna, ordinary-review
  route) over the #16 closure evidence; child 1 of 3. #16 close awaits its verdict.
- 09:22 — review verdict: **MINOR** (no blocker). All three code claims verified
  (bin/libby.mjs:474-483, src/auth.mjs:62-88, src/loans.mjs:14-19); caveat accepted
  verbatim: timing alone doesn't prove zero requests — receipt + close comment
  wording softened to "code path proves reuse; delta ≈ node startup floor is
  consistent with no extra round trip". Residual accepted per the non-blocking rule
  (exactly the reviewer's suggested fix, verified locally). Children used: 1 of 3.
- 09:26 — #16 CLOSED as completed (evaluation answered: not worth doing — superseded
  by #17; drop-fetch variant rejected: saves nothing, loses the loan-lookup check).

## Final block

- status: meaningful-progression
- implement-fleet: complete within scope — no implementation-approved tickets existed
  to admit (#12/#14 owner-gated evaluate-only; #1 out of scope); #16 admitted for
  closure under its own reconciliation condition, closed with reviewed evidence.
- performance-audit: complete — re-audit (the 0800 run's recorded next action)
  no-finding: journey review found all overlap mechanisms in place (#13/#15/#17),
  bench --quick regression sweep clean, node --test 100/100, prior declined
  candidates (avail chunk, archive-read two-phase, hold/unhold no-sync) not
  re-litigated. No-finding is a result; no ticket manufactured.
- abstraction-zoom: skipped — no admitted target (audit found no landable change;
  no budget-worthy surface remained within this box).
- tickets: #16 closed (completed, reconciliation + A/B evidence, review MINOR
  reconciled); #12 commented with post-#17 owner-input numbers, stays open
  (owner decision); #14 untouched (harness + rate-limit owner call outstanding);
  #1 out of scope.
- commits: (this run) receipt + probe + bench evidence — see git log; no source
  changes (no-finding audit).
- reviews: 1 dispatched (openai-gpt-5.6-luna, ordinary-review route) → MINOR,
  reconciled and closed out. Children: 1 of 3 used.
- checks: ab-probe-0300.mjs A/B (auth 1929.5 ms vs return-fake-id 1956.6 ms, delta
  27.1 ms, 9 interleaved rounds, assertions green); bench --quick clean
  (bench-quick-0300.json, perf/results-run-0300-2026-09-13.json); node --test
  100 pass / 0 fail.
- failure_class: none
- time_box: completed-within-budget (started 09:05, finished ~09:30 local; cutoff
  09:50 admit-stop not reached)
- incomplete: none. next_action: owner decides #12 (skip verify on
  borrow/hold/unhold — refreshed numbers) and #14 (cross-title parallelism —
  needs net-sim multi-title harness + rate-limit call); next scheduled run re-audits.

