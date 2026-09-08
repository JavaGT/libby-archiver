# T2-W1A — CLI startup: lazy per-command loading (T2 wave)

## What / why

`bin/libby.mjs` statically imported 12 src modules at startup (auth, loans, archive,
archive-read, search, discover, checkout, sentry, openbook, read, init, config). The
archive/openbook/read/epub subgraph is heavy, yet `libby help`, `where`, `search`,
`info`, `avail` never touch it — every invocation paid to parse modules it would never
use (measured ~7.7 ms above the bare-node floor).

The bin now lazy-loads per command via one exported loader map:

- `export const load` — `load.<module>()` arrows (`() => import('../src/<mod>.mjs')`),
  one entry per former static import. Each command branch awaits only what it needs:
  `where` → config; `search` → config + search; `probe` → read (always) + openbook
  (only with `--buid`); authenticated commands → config + auth, then checkout / loans /
  archive / archive-read at the point of use; `SentryError` is imported inside the three
  catch sites (borrow/return/hold/unhold, archive) and the top-level `main().catch`.
- The COMMANDS gate and unknown-command handling still run before any import, so a typo
  never pays (or risks) module loading. `probe` with no args still exits 2 import-free.
- `resolveLibraryKey`, `buildConfig`, `runProbe` became async (they now await
  `load.config()` / `load.read()`); callers already sat in `async main()`.
- The bottom of the file guards `main()` with a realpath "invoked directly" check
  (`fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)`), so importing
  the bin (tests) is side-effect-free while symlinked bin shims still auto-run.
- `COMMANDS` and `load` are exported; `test/cli-lazy.test.mjs` guards them (see below).

Help text, all console output, exit codes, and error behavior are byte-identical —
verified by diffing `help` / `where` / `probe` (no args) / unknown-command output against
the pre-change binary (all identical; exits 0 / 0 / 2 / 2).

## Measured (Apple M4, median of 9 spawnSync runs, same session, bench.mjs §6 method)

| surface | before | after | delta |
| --- | --- | --- | --- |
| `node -e` floor | 24.4 ms | 24.4 ms | — |
| `libby help` | 32.1 ms | 26.4 ms | **−5.7 ms** (2.0 ms above floor, was 7.7) |
| `libby where` | 32.1 ms | 30.0 ms | **−2.1 ms** (config.mjs still pulls sentry+http) |

First measurement pass (separate session): floor 22.9, help 30.6, where 30.3 — consistent
with the table above. Remaining `help` overhead is node builtins + the bin itself; the
remaining `where` overhead is `config.mjs → sentry.mjs → node:https + http.mjs`, which
would need a config-module split (e.g. pure path helpers vs. network resolution) to shave
further. `search` / `info` / `avail` also stop paying for the archive/openbook/read/epub
subgraph (not benchmarked — they go straight to the network).

## Tradeoffs

- One extra `await import()` per command dispatch: ~0.05–0.3 ms warm (module-cache hit);
  cold first run pays an fs stat per module. Negligible next to the ~6 ms saved.
- Typo risk in the `load` map (wrong path or renamed export would only surface when that
  command runs). Mitigated by `test/cli-lazy.test.mjs`, which asserts, for every command
  in the COMMANDS set, that each loader resolves and exposes exactly the functions the
  branch destructures — also catches renames in `src/` that would silently break a branch.
- Module-level side effects in src would now be deferred to command use; none of the 12
  modules have any (verified), so behavior is unchanged.

## Verification

- `npm test`: **80 pass / 0 fail** (78 baseline + 2 new in `test/cli-lazy.test.mjs`).
- Byte-diff vs pre-change binary: `help`, `where`, `probe` (no args → usage + exit 2),
  unknown command (`exit 2`) — all identical.
- Guard sanity: `node /abs/path/bin/libby.mjs where` from a foreign cwd still runs;
  `npm test` output shows no help-text leakage from importing the bin.
