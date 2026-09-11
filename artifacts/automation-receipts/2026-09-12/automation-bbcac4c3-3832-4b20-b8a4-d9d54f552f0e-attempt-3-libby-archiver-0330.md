# Automation receipt — libby-archiver 03:30 run, 2026-09-12 (attempt 3 of automation-bbcac4c3) — FINAL

Scheduler-supplied identity (CronList): run_id = automation-bbcac4c3-3832-4b20-b8a4-d9d54f552f0e
(the 03:30 daily schedule), attempt = runCount = 3. No recovery; single attempt section.
Timeline marks are git-log / `date` ground truth, not clock estimates (per the 8266bda lesson).

```json
{"schema_version":1,"run_id":"automation-bbcac4c3-3832-4b20-b8a4-d9d54f552f0e","attempt":3,
"status":"success","failure_class":"none","time_box":"completed-within-budget",
"started_at":"2026-09-11T15:30:29Z","finished_at":"2026-09-11T16:03:43Z",
"next_action":"Next scheduled run re-audits; owner decides #16 (return --yes sync), #12, #14, and the #15 sim-auth-surface question at leisure",
"evidence":[
{"path":"perf/lanes/T6-W1-report.md","kind":"artifact"},
{"path":"artifacts/automation-receipts/2026-09-12/automation-bbcac4c3-3832-4b20-b8a4-d9d54f552f0e-attempt-3-libby-archiver-0330.md","kind":"artifact"},
{"path":"bin/libby.mjs","kind":"check"},
{"path":"src/auth.mjs","kind":"check"},
{"path":"src/checkout.mjs","kind":"check"},
{"path":"test/cli-lazy.test.mjs","kind":"check"}]}
```

## Status: success

Found and landed one measured performance improvement end-to-end (audit → ticket → implement →
hostile review round 1 FIX-FIRST → fix → round 2 APPROVED → closed with evidence), filed one
evaluate-only ticket, and recorded the audit's no-finding surfaces. Ground truth: commits
a34bf31 (03:51:34 implementation), 80e1fa3 (03:57:04 review fixes + report), a031bdc (04:02:52
ticket-reference corrections); full gate 93/93 at each landing. Tracker states verified from
`gh issue list` after the close (not from command echo output — see incident below).

## Timeline (NZST, git-log ground truth)

- 03:30:29 — start; repo clean at 8266bda; tracker open: #12/#14 (evaluate-only), #1 (auth
  bug). No approved implementation tickets → fresh performance-audit pass.
- 03:33–03:52 — audit: spawn-floor sweep (help / #10 / #11 / #13-gate paths all ~25–49 ms),
  auth cached verify 1665–1905 ms (= existing #12, not admitted), return-sync delta measured,
  search/avail/info single-RTT checks, auth.mjs/archive.mjs/archive-read.mjs/checkout.mjs
  inspection; periods GET sized 917–987 ms cold (fake id, read-only, zero mutation).
- ~03:53 — tickets filed: **#15** (periods-RTT, Strong → admitted, claimed) and **#16**
  (return-sync, evaluate-only).
- 03:51:34 — a34bf31 implementation (kick under cached-session verify); focused 8/8, full
  93/93; owner config.json/session.json shasum+mtime verified unchanged.
- ~03:54 — live A/B at a34bf31: base 2885.1 vs after 1952.9 ms → **932.2 ms median saving**,
  stderr byte-identical, 0 unexpected (fake-id borrow fails at the periods GET in both trees —
  no account POST reachable). Round-1 hostile review dispatched (child 1).
- ~03:56 — round 1 verdict **FIX-FIRST** (HIGH stale-identity kick; MINOR missing-id kick;
  MINOR parity wording; MINOR hermetic pin accepted-deferred). Findings fixed.
- 03:57:04 — 80e1fa3 (fixes + report); tests 8/8 + 93/93; A/B re-run post-fix: **879.5 ms
  saving**, stderr byte-identical. Round-2 delta re-review dispatched (child 2).
- ~04:00 — round 2 verdict **APPROVED** (all findings verified closed, file:line; reviewer
  independently re-ran node --test 93/93 at 80e1fa3).
- 04:02:52 — a031bdc ticket-reference corrections (see incident); #15 closed with evidence;
  #16 reopened + corrective comment; receipt/docs commit follows this file's commit.

## Playbooks

- **performance-audit: complete.** Measured the post-T5 profile. New: periods-GET stacking
  (→ #15 Strong, landed), return-sync fidelity cost (→ #16 evaluate-only), periods-GET sized
  ~950 ms. No-finding surfaces (inspected, not ticketed): search/avail/info are single
  network-bound auth-free RTTs with minimal client work; both archivers already overlap
  catalog/cover with downloads (prior waves); fresh-bootstrap resolveILS overlap immaterial
  (rare path, data-dependent mint chain).
- **implement-fleet: complete.** One file-ownership lane (bin/libby.mjs, src/auth.mjs,
  src/checkout.mjs + report/receipt); milestone commits on owned paths only (`git diff --stat`
  checked before each commit); hostile review by a different model (glm-5.3-flash), findings
  routed to fixes, delta re-review APPROVED; full gate coordinator-run at each landing.
- **abstraction-zoom: skipped** (goal names implement-fleet + performance-audit; 50-min box).

## Tickets

- **#15** (periods-RTT overlap) created → claimed → implemented (a34bf31) → review round 1
  **FIX-FIRST** → fixes 80e1fa3 → round 2 **APPROVED** → **closed with evidence**. Open owner
  question kept on #15: hermetic kick-pinning needs sim auth-surface investment (deny-net
  denies auth.mjs at import; sim has no chip surface) — same shape as #14's net-sim question.
- **#16** (return-sync) created, **open** (evaluate-only: skip the unconditional sync for
  `--yes`? costs one warm /chip/sync RTT ~70–500 ms; removal degrades the success line and
  no-loan error; unhold-precedent noted; implementation NOT the todo).
- **#12**, **#14** open (pre-existing evaluate-only owner decisions — not admitted).
- **#1** open (auth 401 bug — non-perf, untouched).

## Reviews (children via `opencode2 run --auto`, dispatch-table routes exactly)

- Child 1 — hostile review round 1 on a34bf31 (`--agent glm-5.3-flash-z-ai --model
  openrouter/z-ai/glm-5.3-flash`, READ-ONLY): **FIX-FIRST** (1 HIGH, 3 MINOR, file:line).
- Child 2 — delta re-review round 2 on 80e1fa3 (same route): **APPROVED**.
- Child budget: 2 of 3 used; polls bounded ≤120 s; no timeout over 120 s anywhere.

## Focused checks and evidence

- `node --test test/cli-lazy.test.mjs` 8/8; full `node --test` **93/93** at a34bf31, 80e1fa3,
  and a031bdc (also independently re-run by the round-2 reviewer at 80e1fa3).
- Live A/B (fake-id borrow `--format ebook`, session COPY, isolated XDG config dir, 9
  interleaved rounds + warmups, 0 unexpected, stderr byte-identical assertion, exit 1 both
  trees): 932.2 ms saving at a34bf31; 879.5 ms re-confirmed at 80e1fa3.
- Owner config.json/session.json shasum+mtime-identical before/after all probes; session copy
  deleted at cleanup.
- Un-reviewed-commit sweep: prior hour's commits (8801a9a/395d833/bc5a9dc review-approved on
  #13; 8fb39ec/8266bda receipt docs) — nothing un-owned to sweep.

## Incident (tracker numbering mixup — detected from ground truth, repaired)

The two tickets were created in the opposite order from the coordinator's working notes, so
**#15** = periods-RTT implementation ticket, **#16** = return-sync evaluate-only. The claim
comment and the first close were misdirected to #16 (the close confirmation's echoed title
exposed it; verified via `gh issue list`). Repair: #16 reopened with a corrective comment,
the full claim+landing evidence posted on #15, #15 closed; final states verified from
`gh issue list` (#15 CLOSED with the periods title, #16 OPEN with the return-sync title).
No repo impact (implementation commits were always the periods work).

## Blockers / incomplete

- None for the admitted ticket. Open owner decisions: #16 (new), #12, #14, #15 sim question.

## Time box

- completed-within-budget: admission ~03:53 (23 min into the run; cutoff 04:15); last work
  commit 04:02:52; receipt commit (this file) 04:03:43 — the finish mark, well inside the
  04:20 stop. Child polls ≤120 s throughout.
