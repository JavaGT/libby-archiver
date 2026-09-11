# T5-W1 — overlap borrow's auth-free format lookup with session bootstrap (#13)

## What / why

`libby borrow <id>` without `--format` paid the catalog format lookup
(`discover.getTitle`, auth-free: library key + pooled agent only) strictly
AFTER the session bootstrap (`buildConfig` + `authenticate`, whose cached
session verify is `GET /chip/sync`). Stacked, every format-detected borrow
pays `bootstrap + catalog_RTT + catalog_TLS_handshake` serially; overlapped,
the catalog round trip hides entirely under the bootstrap. Ticket #13
(Strong, performance-audit 0300 run 2026-09-12).

Fix (bin/libby.mjs only, dispatch-order change):

- `main()` kicks `formatLookup` right after `buildConfig` (which guarantees
  `library` is set, so `resolveLibraryKey`'s no-library exit stays unreachable
  exactly as before) and before `load.auth()/authenticate`. The borrow branch
  awaits the same promise where it used to start the lookup — identical call
  (`getTitle(library, titleId, { insecureTLS, characteristics: false })`),
  identical try/catch message and exit 1.
- A synchronous `formatLookup.catch(() => {})` keeps the kicked promise from
  ever being unhandled if auth fails or the process exits first.
- Review round 1 additions: invalid `--period` validation hoisted into the
  cheap-gate block (identical message, exit 2 before ANY network — the kick
  can no longer fire its GET on that usage-error path), and `titleId`
  derived once (`args._[1] ?? args.title`) and reused by the kick and the
  borrow-family branches.

Orthogonal to #12 (the ~2.5 s verify decision): even if that verify is
someday skipped, the overlap still removes the catalog RTT from the
critical path.

## Measured (Apple M4 arm64, Node 26.7.0, spawnSync medians, interleaved base-vs-after rounds, cwd /tmp)

Scenario: `libby borrow nonexistent-title-000000` with the real config via
LIBBY_* env and `--session` at a COPY of the real session — the fake title
guarantees failure at the format lookup, so both trees exercise
bootstrap + lookup and exit 1 with the byte-identical "Could not look up the
title's format" message, with zero account mutation. 9 interleaved rounds,
one untimed warmup per side, 0 bad exits:

| tree | median |
| --- | ---: |
| base (9da428f, materialized via `git archive` to /tmp) | **2766.0 ms** |
| after (8801a9a) | **2345.4 ms** |

Median saving **~420 ms** — the catalog RTT+handshake, as predicted. Live
network variance is high (after-side range 1877–3051 ms, base has a 5089 ms
outlier), so the medians rather than tails are the signal; the hermetic
ordering pin below is the structural proof. Owner `config.json`/`session.json`
verified byte-identical (shasum + mtime) before and after all runs; the
session copy was deleted afterwards.

Negative result recorded (audit honesty): Node's V8 compile cache
(`NODE_COMPILE_CACHE` / `module.enableCompileCache()`, supported on this
Node) was measured the same interleaved way for `help`/`where`/usage-error
spawns — deltas within ±0.2 ms of the ~25 ms floor. The floor is Node
runtime bootstrap, not source compilation; not a finding, not ticketed.

## Pins (test/cli-lazy.test.mjs, hermetic, deny-net + new DENY_NET_LOG)

- `test/helpers/deny-net-loader.mjs` gains an optional `DENY_NET_LOG` env:
  each denial is appended before throwing, so a pin can prove WHICH wire
  modules a scenario reached. Off by default; #10/#11 pins unaffected.
- Ordering pin (#13): `borrow <nonexistent-id>` with network denied must log
  a discover→`http.mjs` denial — the lookup is reached without auth. The
  pre-#13 stacked order dies at the `auth.mjs` import and never touches
  `http.mjs`: regression-proven by copying the new test into a `git archive
  9da428f` tree (6 pass / exactly this pin fails on the http.mjs assertion).
- Usage-error pin (#13 review): `borrow <id> --period 0` exits 2 with the
  period message and an EMPTY denial log — no wire module reached.

## Verification

- `node --test test/cli-lazy.test.mjs`: 8 pass / 0 fail.
- Full `node --test`: **92 pass / 0 fail** (91 prior + the ordering pin).
- Commits: 8801a9a (implementation), 395d833 (review round 1), this report.
- `git diff --stat` at each commit: only bin/libby.mjs,
  test/cli-lazy.test.mjs, test/helpers/deny-net-loader.mjs (+ this report).

## Review

- Round 1 (GLM 5.3 Flash via `opencode2 run --auto`, READ-ONLY, on
  8801a9a): **CHANGES REQUESTED** — (1) `--period 0` usage-error path fired
  the kick's GET (FIX-FIRST); (2) MINOR duplicated id expression; (3) MINOR
  pre-existing exit-1-via-double-fault in `main().catch` under denial,
  judged pre-existing and no-action by the reviewer. Fixes: 395d833.
- Round 2 (same route, delta on 395d833): verdict recorded on #13.
