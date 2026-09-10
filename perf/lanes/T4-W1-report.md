# T4-W1 — validate args before session bootstrap (#10, #11)

## What / why

`libby archive` with no --all/--title, `libby borrow`/`return`/`hold`/`unhold`
with no id, and `libby init --help` all paid a full session bootstrap
(buildConfig + authenticate; cached-session `verify()` = `GET /chip/sync`,
src/auth.mjs:60, 150-157) before printing their usage error, and `libby init
--help` ran the entire interactive wizard as a side effect of asking for help.
The unknown-command gate (bin/libby.mjs:243-244) already established the
principle: validation before any auth/network.

Fix (dispatch-order only, src/ untouched):

- bin/libby.mjs main(): cheap arg validation hoisted above
  `buildConfig`/`authenticate`. `archive` without `--title`/`--all` and the
  borrow family without an id exit 2 with the byte-identical existing usage
  messages before any config/auth work. The in-branch checks remain as defense
  in depth and are now unreachable for these no-target cases.
- bin/libby.mjs init branch: `--help`/`-h` prints a short init usage and exits
  0 before `runInit()` is even imported. `libby init` with no flags still runs
  the wizard unchanged. (`--help` parses as a flag key even with no value;
  `-h` parses as a positional — hence the two checks.)

## Measured (Apple M4 arm64, Node 26.7.0, spawnSync median of 9, interleaved base-vs-after rounds, cwd /tmp)

Base materialized via `git archive 23bd9b7` to /tmp/t4w1-base; both trees run
in one interleaved session (one untimed warmup round). Real saved session
present; all exits matched expectations (archive = 2, init --help / help = 0).

| invocation | base (23bd9b7) | after (6e01dad) | delta |
| --- | ---: | ---: | --- |
| `libby archive` (no --all/--title) | **2785.3 ms** | **28.9 ms** | **−2756 ms (~96x)** |
| `libby init --help` | **2512.4 ms** | **25.5 ms** | **−2487 ms (~98x)** |
| `libby help` (reference) | 50.4 ms | 25.2 ms | — |

After-sides sit within ~3 ms of the `libby help` floor — the error paths do
zero network, matching issue acceptance ("within noise of `libby help`").
Base-side samples (ms): archive 2353 2280 3226 2659 4127 3525 2341 2785 3386;
init --help 2458 2629 2665 2591 2439 2474 3463 2420 2512. Note: the base tree
lives on /tmp, which likely explains its elevated ~50 ms help floor vs 25 ms;
that bias is uniform and immaterial beside the ~2.5 s bootstrap deltas.

Owner config.json/session.json verified byte-identical (shasum + mtime)
before and after the measurement runs, including the base-side wizard runs.

## Pins (test/cli-lazy.test.mjs, hermetic spawnSync, LIBBY_*/NODE_OPTIONS stripped)

- `archive` no-target WITH --card/--library/--website (so buildConfig cannot
  be the early exit) and `--session` at a nonexistent temp path: exit 2 +
  "Specify what to archive", session file never created (authenticate never
  ran), no Missing config/Authenticated/Minting output.
- Same shape for `borrow` with no id: exit 2 + "Usage: libby borrow <id>".
- `init --help` and `init -h` with XDG_CONFIG_HOME at an empty temp dir:
  exit 0, stdout names init/interactive setup, no "Checking connection"/"Saved".

Regression-proof: all three pins copied into the base tree FAIL on 23bd9b7
(archive 870.9/731.0 ms, borrow 743.5 ms, init --help 1631.4 ms — the
bootstrap/wizard really ran there) and pass on the fixed tree.

## Verification

- `node --test test/cli-lazy.test.mjs`: 6 pass / 0 fail.
- `node --test` (full): 89 pass / 0 fail.
- `git diff --stat` at commits: only bin/libby.mjs (+30/−0 across both) and
  test/cli-lazy.test.mjs (+71); report added separately. src/ untouched.
- Commits: 8558af7 (#10), 6e01dad (#11), report commit (this file).
