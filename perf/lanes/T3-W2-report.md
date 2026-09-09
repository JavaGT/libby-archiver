# T3-W2 — config.mjs split: pure path helpers vs network resolution (#5)

## What / why

`src/config.mjs` statically imported `node:https` + `READ_HOST` (sentry.mjs) +
`getJson` (http.mjs) solely for two functions — `resolveLibrary()` and
`detectInsecureTLS()` — that light commands never call. `libby where` only prints
two paths but paid for the whole network import graph at startup. This is exactly
the headroom the T2-W1A note named ("config.mjs still pulls sentry+http … would
need a config-module split").

The split (issue #5):

- New `src/library.mjs` owns `resolveLibrary` + `detectInsecureTLS`, moved verbatim
  with their doc comments and their imports (`https`, `READ_HOST`, `getJson`).
- `src/config.mjs` keeps only pure path/fs helpers: `configDir`, `configPath`,
  `sessionPath`, `localConfigPath`, `readJson`, `loadConfig`, `saveConfig`
  (imports fs/os/path/writeFileAtomic only). No re-export shim — importers updated:
  - `src/init.mjs`: network pair now from `./library.mjs` (config trio unchanged).
  - `src/index.mjs`: same public export surface, `resolveLibrary`/`detectInsecureTLS`
    now re-exported from `./library.mjs`.
- `bin/libby.mjs` and `test/cli-lazy.test.mjs` needed no change — grep proved the bin
  only destructures `loadConfig`/`sessionPath` from config (`resolveLibraryKey` is a
  local helper that never calls the moved functions), and the USAGE table's config
  entries all still resolve.

## Measured (Apple M4, median of 9 spawnSync runs, same session, bench.mjs §6 method)

| surface | BEFORE (base e6c9314) | AFTER (4 passes) | delta |
| --- | --- | --- | --- |
| `node -e 0` floor | 21.5 ms | 21.2 / 21.5 / 22.0 / 21.3 | — |
| `libby help` | 24.5 ms | 24.8 / 24.5 / 23.8 / 24.2 | — |
| `libby where` | 28.3 ms | 26.7 / 26.7 / 26.7 / 26.8 | **−1.6 ms** |
| `libby probe` (no args) | 24.4 ms | 24.2 / 23.9 / 24.4 / 24.1 | — |
| where − help | 3.8 ms | 1.9 / 2.2 / 2.9 / 2.6 (**~2.4 median**) | **−1.4 ms** |

(Audit numbers on the same base, separate session: floor 22.6, help 24.7,
where 28.8, probe 24.6 → gap 4.1 ms. This pass reproduced it at 3.8 ms.)

**Verdict: meaningful progression, not full acceptance.** The named headroom
(https/sentry/http) is shaved and `where` is now the most stable surface in the set
(26.7–26.8 across four passes), but the residual gap to `help` is ~2.4 ms, above the
~1 ms target. Next blocker isolated: `where`'s remaining cost is its own dynamic
import chain `config.mjs → util.mjs`, and `src/util.mjs` pulls `node:crypto` (line 9)
+ `node:os` — neither used by the `where` path (it calls only `configPath`/`sessionPath`;
crypto serves `writeFileAtomic`). util.mjs was outside this lane's may-touch list.
A future lane could shave the rest by moving `saveConfig`/`writeFileAtomic` out of
config.mjs's static graph or lazy-loading crypto inside util.mjs.

## Tradeoffs

- Two modules instead of one; `init.mjs` now imports config + library separately.
  Dependency edges are clearer (network code no longer hidden in a "config" module).
- No compat shim: any future importer of the network pair must import `library.mjs`,
  keeping the light-command graph honest by construction.
- `index.mjs` export block reformatted (one line per module) — surface identical.

## Verification

- `libby where` output byte-identical vs base: captured on e6c9314 with pinned
  `XDG_CONFIG_HOME`, diffed against post-split output — identical (exit 0 both).
- Public API: `import('./src/index.mjs')` → `typeof m.resolveLibrary` /
  `typeof m.detectInsecureTLS` = `function function`; config.mjs now exports exactly
  `configDir,configPath,loadConfig,saveConfig,sessionPath`; library.mjs exactly
  `resolveLibrary,detectInsecureTLS`.
- `node --test test/cli-lazy.test.mjs`: 3 pass / 0 fail.
- `node --test test/e2e.test.mjs`: 3 pass / 0 fail (run mid-lane before T3-W1's
  http.mjs edits landed in the tree; excluded from final claims — the full gate is
  the coordinator's).
- No other file changed: `git diff --stat` shows only config.mjs (−78 lines of
  network code), index.mjs, init.mjs; + new library.mjs.
