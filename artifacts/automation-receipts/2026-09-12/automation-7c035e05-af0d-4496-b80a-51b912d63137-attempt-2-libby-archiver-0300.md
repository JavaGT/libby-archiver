# Automation receipt — libby-archiver 03:00 run, 2026-09-12 (attempt 2 of automation-7c035e05) — FINAL

Scheduler field note: the schedule prompt carries no per-run run_id/attempt; `run_id` is the
scheduler's automationId and `attempt` its runCount (=2, this invocation), both scheduler-supplied
via CronList. No recovery occurred; no prior attempt section exists.

```json
{"schema_version":1,"run_id":"automation-7c035e05-af0d-4496-b80a-51b912d63137","attempt":2,
"status":"success","failure_class":"none","time_box":"completed-within-budget",
"started_at":"2026-09-11T15:00:31Z","finished_at":"2026-09-11T15:27:00Z",
"next_action":"Owner decides #12 (skip/keep the ~2.5s cached-session verify) and #14 (evaluate cross-title parallelism for archive --all); next scheduled run re-audits",
"evidence":[
{"path":"perf/lanes/T5-W1-report.md","kind":"artifact"},
{"path":"artifacts/automation-receipts/2026-09-12/automation-7c035e05-af0d-4496-b80a-51b912d63137-attempt-2-libby-archiver-0300.md","kind":"artifact"},
{"path":"bin/libby.mjs","kind":"check"},
{"path":"test/cli-lazy.test.mjs","kind":"check"},
{"path":"test/helpers/deny-net-loader.mjs","kind":"check"}]}
```

Correction note: the first committed copy of this receipt (8fb39ec) said `overrun-with-reason`
with a 03:56 finish — that was the coordinator's unverified running clock estimate. `date` and
git commit timestamps are ground truth: the run started 03:00:52 NZST and its last commit landed
03:26:23 NZST (~26 of 50 minutes). time_box corrected to completed-within-budget.

## Status: success

Found and landed one measured performance improvement end-to-end (ticket → implement → hostile
review ×2 → APPROVED → closed), filed one evaluate-only ticket, and recorded one measured
negative result. Ground truth: commits 8801a9a (03:14:49), 395d833 (03:21:25), bc5a9dc (03:25:17),
receipt 8fb39ec (03:26:23) on main; #13 closed with evidence; full gate 93/93 at HEAD.

## Timeline (NZST, from git log + session start)

- 03:00:52 — run start; repo clean at 9da428f; tracker: #12 open (evaluate-only), #1 open (auth bug)
- ~03:05–03:11 — performance-audit measurements: compile-cache A/B (negative), import-graph and
  keep-alive verification, borrow-ordering finding
- ~03:11 — tickets #13 (Strong, admitted) and #14 (Speculative) filed; #13 claimed
- 03:14:49 — implementation commit 8801a9a (focused 7/7)
- ~03:15 — hostile review round 1 dispatched in background (child 1); regression proof + live A/B
  + full gate run concurrently
- ~03:19 — round 1 verdict CHANGES REQUESTED → findings routed back
- 03:21:25 — fix commit 395d833 (focused 8/8); delta re-review dispatched (child 2)
- ~03:24 — round 2 verdict **APPROVED**
- 03:25:17 — measurement report committed; #13 closed with evidence
- 03:26:23 — receipt committed (8fb39ec); correction commit follows

## Playbooks

- **performance-audit: complete.** Measured the post-T4 profile. New findings: borrow's
  auth-free format lookup stacked after the session bootstrap (→ #13, Strong, admitted);
  `archive --all` downloads titles strictly sequentially (→ #14, Speculative/evaluate-only).
  Negative result (measured, not ticketed): Node V8 compile cache is within ±0.2 ms of the
  ~25 ms floor — the floor is runtime bootstrap, not compilation. Already-covered surfaces
  verified, not re-opened: keep-alive pooling (W7), light-command import graphs, validation
  error paths (#10/#11), auth-path 2.5 s (= existing #12, not admitted).
- **implement-fleet: complete.** One file-ownership lane (bin/libby.mjs + test/cli-lazy.test.mjs
  + test/helpers/deny-net-loader.mjs); milestone commits on owned paths only; hostile review per
  lane by a different model (glm-5.3-flash), findings routed back, delta re-review APPROVED;
  coordinator ran the full gate.
- **abstraction-zoom: skipped** (goal names implement-fleet + performance-audit; 50-min box).

## Tickets

- **#13** created ~03:11 → claimed → implemented (8801a9a) → review round 1 **CHANGES REQUESTED**
  (--period-0 usage-error path fired the kick's GET; MINOR dup id expr; MINOR pre-existing
  double-fault exit, reviewer judged no-action) → fixes 395d833 (period gate hoisted above
  buildConfig, byte-identical message, empty-denial-log pin; single titleId derivation) →
  round 2 delta **APPROVED** → **closed with evidence**.
- **#14** created, **open** (evaluate-only: cross-title parallelism for `archive --all`; owner
  questions: whoa-rate-limit tradeoff, net-sim harness funding; implementation NOT the todo).
- **#12** open (pre-existing speculative owner decision — not admitted, per its evaluate-only todo).
- **#1** open (auth 401 bug — not performance; untouched).

## Reviews dispatched (children via `opencode2 run --auto`, exact dispatch-table routes)

- Child 1 — hostile review round 1 on 8801a9a (`--agent glm-5.3-flash-z-ai --model
  openrouter/z-ai/glm-5.3-flash`, READ-ONLY): **CHANGES REQUESTED** (findings with file:line).
- Child 2 — delta re-review on 395d833 (same route): **APPROVED** (all claims verified with
  file:line; 8/8 hermetic focused run by the reviewer).
- Child budget: 2 of 3 used, max 1 active at a time; no polling window exceeded 120 s.
- Un-reviewed-commit sweep: the prior hours' commits (9da428f docs, 2ab7719/c174a38 review
  artifacts) were already review-approved/committed by the previous run — nothing un-owned to sweep.

## Focused checks and evidence

- `node --test test/cli-lazy.test.mjs`: 8 pass / 0 fail; full `node --test`: **93 pass / 0 fail**
  at bc5a9dc (coordinator-run).
- Live A/B (safe failed-borrow scenario, real config via LIBBY_* env, session COPY, 9 interleaved
  rounds + warmups, 0 bad exits): base 2766.0 ms vs after 2345.4 ms → **~420 ms saved** per
  format-detected borrow. Owner config.json/session.json shasum+mtime-verified byte-identical
  before/after; session copy deleted.
- Regression proof: ordering pin fails exactly as designed on a `git archive 9da428f` tree
  (6 pass / 1 fail, on the http.mjs-denial assertion).
- Evidence paths: perf/lanes/T5-W1-report.md (committed), #13 close comment, this receipt.

## Incident (logged, corrected, no retry loop)

The first live A/B used a dummy card; the session is card+library-bound, so those 20 runs each hit
`POST /auth/link` → 401 credentials_rejected / captcha_required with invalid credentials before I
stopped the script and corrected the setup. No session was minted or written (owner session.json
byte-identical throughout), no further auth attempts were made — the corrected run reuses the
cached session read-only. Same 401 surface as existing issue #1; no new ticket (already tracked).

## Time box

- completed-within-budget: admission (~03:11) well before the 03:45 cutoff; last commit 03:26:23,
  ~24 minutes before the 03:50 stop. Child polls bounded at ≤120 s throughout.

## Blockers / incomplete

- None for this run's goal. Open owner decisions: #12, #14. Next action: next scheduled run
  re-audits; owner decides #12/#14 at leisure.

---

## Continuation addendum (owner "continue" directive, after the final block above)

The owner directed "continue" after this run's receipt was already finalized at 03:27 NZST. One
further discovery pass was executed; no new work was admitted for implementation (this run's
50-minute box had already closed — the continuation produced evidence and tickets only).

- New finding, measured: `list`/`archive`/`return` fetch the identical `GET /chip/sync` twice per
  invocation (cached-session verify at src/auth.mjs:161 discards the payload; loans.sync at
  src/loans.mjs:8 re-fetches it). Interleaved medians, session COPY, owner files byte-identical:
  `auth` 1952.0 ms vs `list` 2520.2 ms → **~568 ms** second-fetch cost. Filed as **#17** (Strong)
  with a reuse fix sketch and acceptance criteria; deliberately NOT admitted — a 3-file auth-path
  change cannot land plus hostile review before this run's hard stop, and it is conditional on the
  #12 owner call.
- Duplicate-reconciliation: the 03:30 wave's #16 (speculative, return-focused) targets the same
  redundancy from the removal-first angle. #16 ↔ #17 cross-linked with comments; reconciliation
  guidance recorded on both (reuse answers #16; both conditional on #12).
- Observed, untouched: the 03:30 wave (T6-W1) landed a34bf31/80e1fa3/a031bdc + receipt 9b202bb
  (#15 closed, ~880–930 ms measured) in this shared checkout after this run finalized. Its
  `artifacts/automation-receipts/2026-09-12/libby-archiver-0300.md` is untracked and NOT mine —
  left untouched per shared-checkout file-safety rules.
- Full `node --test` re-run at T6's HEAD (9b202bb): **93 pass / 0 fail** — both waves' pins coexist.

Continuation status: meaningful-progression (one Strong measured finding ticketed with a
next-wave-ready sketch; nothing admitted past the box). Receipt file commits: 8fb39ec, 8266bda,
plus the addendum commit.
