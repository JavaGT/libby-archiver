# T2-W2C — wall-clock orchestration (loan pipelining + read-path manifest pre-hash)

Date: 2026-09-09 · branch `perf-trial-20260909` · baseline 5fe5d0b lineage · `npm test` 85 pass / 0 fail (80 baseline + 5 new).

## Sub-task 1 — `libby archive --all` loan pipelining — ADOPTED

**What.** The archive loop is extracted to `archiveLoanQueue(targets, ctx, io)` in `bin/libby.mjs`. Loans still archive strictly one at a time in order, but the NEXT loan's setup — `openLoan` + `fetchOpenbook`, the gateway/listen-API REST round trips — runs while the active loan's downloads (spine parts at mapLimit(3), pages/assets at 4) are in flight. Exactly one setup may be in flight, ever.

**Mechanics.**
- `src/archive.mjs` / `src/archive-read.mjs`: each orchestrator split into `prepareX(ctx, loan, outDir, log)` (claim folder → open → decode openbook → sidecars) and `finishX(state)` (downloads → EPUB/metadata → manifest). `archiveAudiobook` / `archiveReadable` remain exported as `finishX(await prepareX(...))` — the single-title path, the library API (`src/index.mjs`), and the e2e tests use the identical code as before.
- The prefetch launches only after the current loan's setup resolves (never two setups concurrent) and runs during `finish()`; a prefetched setup logs into a buffer replayed, in order, when the loan becomes active, so the per-loan log blocks are byte-identical to a sequential run (asserted in `test/archive-pipeline.test.mjs`).
- Failure semantics unchanged: a held prefetch error re-throws when the loan becomes active → same `FAILED "<title>": <msg>` line, others continue; `SentryError` result `'whoa'` exits 3 at the same point in the flow (from an active finish or a surfacing prefetch). The `process.exit(3)` also tears down any in-flight prefetch; no new setup is launched once whoa is known.
- One observable (non-network) difference: a prefetched loan's folder is claimed (mkdir + marker) slightly earlier — during its predecessor's downloads instead of after. Resume semantics are unaffected (the marker adopts on the next run).

**Measured.** `perf/net-sim.mjs` section `loan_pipeline_5x` — 5 loans × (4 sequential setup RTTs @60 ms + 6 parts @400 ms at concurrency 3), client-injected latencies over the real `http.mjs`/`pool.mjs` stack:

| pattern | simulated wall | analytic |
|---|---|---|
| sequential | 5332 ms | 5200 ms |
| pipelined (1 setup ahead) | 4306 ms | 4240 ms |

1.24x, ≈1.0 s saved per 5 loans — exactly (N−1) setup times, as designed. Loopback understates the real win: a setup is 4+ REST round trips against the gateway (~50–150 ms/RTT against OverDrive), so each of loans 2..N hides roughly 0.2–0.6 s. Single-loan archives are untouched (same composition; e2e green).

**Tradeoffs.** One extra openbook/passport resident in memory during the overlap (a few MB worst case). Overlap adds gateway requests slightly ahead of need — if OverDrive ever whoas on setup volume, the prefetch could contribute; bounded at one, and the whoa exit still lands in the same place.

**Verdict.** Adopt. ~60 net lines across three files, ordering and failure contracts test-covered.

## Sub-task 2 — read-path manifest pre-hash — ADOPTED

**What.** `finishReadable` now hashes each page body / asset at write time (`crypto.createHash('sha256')` — the utf8 string / Buffer in hand is exactly the file's bytes) and feeds the digests into `writeManifest`'s `known` map (`src/util.mjs`, untouched). Cover: one small `readFileSync` + hash right after `downloadCover` resolves. The EPUB was already pre-hashed (W18/T1). Resume/skip semantics preserved: only files actually written this run get `known` entries — skipped assets (HTTP ≠ 200), a failed/absent cover, and all previous-run files are re-read by `writeManifest` as before.

**Measured.** `perf/manifest-prehash-one.mjs` — synthetic bookDir of 120 pages × 6 KB + 100 assets × 150 KB = 16.1 MB / 222 files, median of 5 alternating rounds:

| pass | wall |
|---|---|
| writeManifest re-read (today) | 15 ms |
| writeManifest with `known` | 1 ms |
| digest computation (moved into the download phase) | 5.7 ms |

**Honesty note:** the fixture files were just written, so they are warm in the page cache — the win is the open/read/stream syscall cost of re-reading ~16 MB, not disk IO, and the hashing work is moved (into the download phase, where it overlaps 400 ms-class network waits), not eliminated. Absolute win on this fixture is ~14 ms/book; it scales with payload, so a real fixed-layout magazine (assets can be 10–100× this fixture) saves proportionally more. The distributions do not overlap (14–17 ms vs 1 ms).

**Verdict.** Adopt. ~8 lines in `archive-read.mjs`, manifest pass drops 15x on the fixture, and the e2e suite (which recomputes every manifest hash from disk) passes — digests are byte-correct.
