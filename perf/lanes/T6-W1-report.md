# T6-W1 — overlap default-borrow's periods GET under the cached-session verify (#16)

## What / why

`libby borrow <id>` without `--period` paid `getLoanPeriods`
(`GET /card/{cardId}/loan/{titleId}/periods`, gateway host) strictly AFTER
the session bootstrap, and the borrow POST depends on its result, so the
whole RTT sat on the critical path. Measured cold (session COPY, fake title
id → 400, zero mutation): **917–987 ms per call** (fresh TLS handshake to
the gateway host + RTT). Ticket #16 (Strong, performance-audit 0330 run
2026-09-12).

The cached-session path knows `identity` + `cardId` (after key + expiry
checks) BEFORE the verify `GET /chip/sync` (~1.9 s), so the periods GET can
hide under it — the #13 overlap pattern, one layer deeper (authed, not
auth-free).

Fix (three files, +35/−2, commit a34bf31):

- `src/auth.mjs`: `authenticate(cfg)` invokes optional
  `cfg.onCachedSession(client, cached.identity, cached.cardId)` right before
  `verify`, only when the cached session passed the card/library key and
  expiry checks; sync throws swallowed (caller owns the promise).
- `bin/libby.mjs`: the hook kicks the SAME `getLoanPeriods` call
  borrowTitle would make (only `borrow` without `--period`), with the #13
  `p.catch(() => {})` unhandled-rejection guard; the borrow branch awaits it
  and passes the settled result to `borrowTitle` via `opts.periods`. A kick
  failure surfaces the same error object through the same bin catch.
- `src/checkout.mjs`: `borrowTitle` accepts `opts.periods`
  (`opts.periods ?? await getLoanPeriods(...)`); preference extraction is
  unchanged and remains in the single original site.

Correctness: lending periods are (cardId, titleId) properties, not session
state — same sessionKey ⇒ same card ⇒ the kicked result stays valid even if
the verify fails and a fresh identity is minted for the same card. The
`--period N` and fresh-bootstrap paths never kick (exactly today's behavior);
non-borrow commands' hook is a no-op.

## Measured (Apple M4 arm64, Node 26.7.0, spawnSync medians, interleaved base-vs-after rounds, cwd with isolated XDG config, session COPY)

Scenario: `borrow fake-0330 --format ebook` (no `--period` → kick active in
the after tree) with the real config via an isolated `XDG_CONFIG_HOME` and
`--session` at a COPY of the real session. The fake title guarantees failure
at the periods GET (HTTP 400) in BOTH trees, so the borrow POST is never
reached and zero account mutation is possible; both trees exit 1 with the
byte-identical `borrow failed: GET /card/…/loan/fake-0330/periods -> 400
(upstream_failure)`. 9 interleaved rounds, one untimed warmup per side,
0 unexpected outcomes:

| tree | median |
| --- | ---: |
| base (8266bda, `git archive` to /tmp) | **2885.1 ms** |
| after (a34bf31) | **1952.9 ms** |

Median saving **~932 ms** — the gateway TLS+RTT, as predicted. stderr
byte-identical across trees (asserted every round). Owner
`config.json`/`session.json` shasum+mtime-verified byte-identical before and
after all runs; the session copy is deleted after the run.

## Audit context (same run, same probe harness)

- Cheap-gate regression sweep all at the ~25–49 ms spawn floor: `help`,
  `archive` no-flags (#10), `init --help` (#11), `borrow --period 0`
  (post-#13 gate).
- `auth` cached-verify median 1665–1905 ms across probes (= existing
  evaluate-only #12; not admitted).
- New evaluate-only #15: `return`'s unconditional loan sync costs one warm
  `/chip/sync` RTT (~70–500 ms) purely for output fidelity (confirm title +
  friendly no-loan error) — removal changes user-visible output, so owner
  decision, not implemented.
- No-finding (inspected, not ticketed): `search`/`avail`/`info` are single
  auth-free RTTs (measured 900–2450 ms, network-bound; client-side minimal);
  both archivers already overlap thunder/cover with downloads (T3/T5 waves);
  fresh-bootstrap `resolveILS` overlap judged immaterial (rare path, and
  bootstrap is a chain of data-dependent mints); `avail` chunks only exceed
  one POST beyond 100 ids.

## Hermetic-pinning gap (pre-agreed on #16)

The deny-net loader denies `auth.mjs` at import, so `authenticate` never
runs under it and the kick is invisible to the existing pins; the sim
(`test/helpers/overdrive-sim.mjs`) has no chip/auth surface. Hermetic
kick-pinning needs sim auth-surface investment — deferred as an owner
question on #16 (same shape as #14's net-sim funding question). This run's
behavioral proof is the live A/B above + the byte-identical stderr pin.

## Verification

- `node --test test/cli-lazy.test.mjs`: 8 pass / 0 fail; full `node --test`:
  **93 pass / 0 fail** at a34bf31 (coordinator-run).
- `git diff --stat` at the commit: only bin/libby.mjs, src/auth.mjs,
  src/checkout.mjs.
- Live A/B as above; hostile review dispatched on a34bf31 (GLM 5.3 Flash,
  READ-ONLY) — verdict recorded on #16.
