# Lane B — network/interface optimizations (perf-trial-20260906-030748-net)

Status: COMPLETE. `node --test`: 34 pass / 0 fail.
Note: dispatched subagent completed W7 (http pooling) + the mapLimit helper; the
coordinator took over mid-campaign (2-subagent limit reduced to 1) and finished the rest.

## W7 — Keep-alive HTTP connection pooling (commit bb616b3)

`src/http.mjs`: the secure path used Node's default global agent (`keepAlive: false`),
so every Thunder/stargazer/cover/page call paid a full TLS handshake. Now one pooled
agent per TLS mode: `keepAlive: true, maxSockets: 8, maxFreeSockets: 4,
keepAliveMsecs: 30_000, noDelay: true`, agent-level `timeout` as an idle-socket
backstop. Per-request `timeout` + `req.destroy(...)` handlers are untouched — the
wedge failure mode the file header warns about stays closed.

- Expected win: one RTT+handshake (~50–150 ms to OverDrive hosts) saved per reused
  connection. `libby avail <100 ids>` = 1 POST; `archive` typically makes 5–10 REST
  calls per loan plus every page/asset/cover.
- Tradeoff: up to 4 idle sockets per host linger ≤30 s after the last request; CLI
  exit closes them. Bounded sockets (8) cap parallel-fanout blast radius.

## mapLimit helper (commits 8e81da8, 6be8d36)

`src/pool.mjs`: bounded-concurrency ordered map, fail-fast. The dispatched agent's
version declared `failed` but never set it — its doc comment promised "no further
items are started" but free workers kept pulling. Fixed + added a test that pins the
semantics (a freed worker must not start items after a rejection; the old test passed
only by timing accident).

## W8 — Concurrent audiobook part downloads (commit 6be8d36)

`src/archive.mjs`: spine parts download 3 at a time via `mapLimit` instead of
strictly sequentially. Skip/resume byte-size logic, per-part logs, fail-fast, and
`partFiles` order (spine order → manifest order) preserved. ~3× wall-clock on the
download phase (network-bound; CDN is what the browser hammers with 6+ connections).

Tradeoff: 3 simultaneous connections per title to the CDN — deliberately low.

## W9 — Concurrent page + asset fetching (commit 6be8d36)

`src/archive-read.mjs`: pages fetch+decode 4 at a time (a 300-page magazine was 300
serial RTTs — at ~80 ms RTT that's ~24 s of pure waiting), then assets 4 at a time.
`pageEntries` stay in spine order for EPUB assembly; non-200 assets still log and get
skipped; first page error rejects the loan (fail-fast, same as sequential abort).

- Tradeoffs: in-flight bodies raise steady-state RAM by the concurrency factor
  (bounded, a few MB). Log lines now report *decoded* pages (completion) rather than
  *starting* pages, so numbers under concurrency are truthful. Cosmetic interleave.
- Also removed: dead `width` variable in archive-read step 4.

## What I verified

- `node --test`: 34/34 (incl. new fail-fast pin test).
- Static reasoning only for network wins (no live OverDrive calls from the trial);
  hub integration adds a local-TLS pattern bench to measure keep-alive + concurrency
  against a latency-injecting server.
