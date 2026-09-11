# Automation receipt — libby-archiver 03:00 run, 2026-09-12 (attempt 2 of automation-7c035e05) — FINAL

Scheduler field note: the schedule prompt carries no per-run run_id/attempt; `run_id` is the
scheduler's automationId and `attempt` its runCount (=2, this invocation), both scheduler-supplied
via CronList. No recovery occurred; no prior attempt section exists.

```json
{"schema_version":1,"run_id":"automation-7c035e05-af0d-4496-b80a-51b912d63137","attempt":2,
"status":"success","failure_class":"none","time_box":"overrun-with-reason",
"started_at":"2026-09-11T15:00:31Z","finished_at":"2026-09-11T15:56:30Z",
"next_action":"Owner decides #12 (skip/keep the ~2.5s cached-session verify) and #14 (evaluate cross-title parallelism for archive --all); next scheduled run re-audits",
"evidence":[
{"path":"perf/lanes/T5-W1-report.md","kind":"artifact"},
{"path":"artifacts/automation-receipts/2026-09-12/automation-7c035e05-af0d-4496-b80a-51b912d63137-attempt-2-libby-archiver-0300.md","kind":"artifact"},
{"path":"bin/libby.mjs","kind":"check"},
{"path":"test/cli-lazy.test.mjs","kind":"check"},
{"path":"test/helpers/deny-net-loader.mjs","kind":"check"}]}
```

## Status: success

Found and landed one measured performance improvement end-to-end (ticket → implement → hostile
review ×2 → APPROVED → closed), filed one evaluate-only ticket, and recorded one measured
negative result. Ground truth: commits 8801a9a, 395d833, bc5a9dc on main; #13 closed with
evidence; full gate 93/93 at HEAD.

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

- **#13** created 03:26 → claimed → implemented (8801a9a) → review round 1 **CHANGES REQUESTED**
  (--period-0 usage-error path fired the kick's GET; MINOR dup id expr; MINOR pre-existing
  double-fault exit, reviewer judged no-action) → fixes 395d833 (period gate hoisted above
  buildConfig, byte-identical message, empty-denial-log pin; single titleId derivation) →
  round 2 delta **APPROVED** → **closed with evidence**.
- **#14** created, **open** (evaluate-only: cross-title parallelism for `archive --all`; owner
  questions: whoa-rate-limit tradeoff, net-sim harness funding; implementation NOT the todo).
- **#12** open (pre-existing speculative owner decision — not admitted, per its evaluate-only todo).
- **#1** open (auth 401 bug — not performance; untouched).

## Commits (main)

- 8801a9a — T5-W1: overlap borrow's auth-free format lookup with session bootstrap (#13)
- 395d833 — T5-W1 review round 1: hoist --period validation above the #13 kick; single titleId (#13)
- bc5a9dc — T5-W1: measurement report for #13 (perf/lanes/T5-W1-report.md)

## Reviews dispatched (children via `opencode2 run --auto`, exact dispatch-table routes)

- Child 1 — hostile review round 1 on 8801a9a (`--agent glm-5.3-flash-z-ai --model
  openrouter/z-ai/glm-5.3-flash`, READ-ONLY): **CHANGES REQUESTED** (findings with file:line).
- Child 2 — delta re-review on 395d833 (same route): **APPROVED** (all claims verified with
  file:line; 8/8 hermetic focused run by the reviewer).
- Child budget: 2 of 3 used, max 1 active at a time; no polling window exceeded 120 s.
- Un-reviewed-commit sweep: the prior hour's commits (9da428f docs, 2ab7719/c174a38 review
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

- Admission cutoff (03:45 NZST) respected: last admission (#13 lane) at 03:26.
- time_box: **overrun-with-reason** — finished 03:56 NZST (~6 min past the 03:50 nominal stop):
  review round 1 returned CHANGES REQUESTED at ~03:44; implement-fleet requires routing findings
  back and re-reviewing until APPROVE, and stopping mid-loop would have ended the run with the
  admitted ticket in a non-landed state.

## Blockers / incomplete

- None for this run's goal. Open owner decisions: #12, #14. Next action: next scheduled run
  re-audits; owner decides #12/#14 at leisure.
