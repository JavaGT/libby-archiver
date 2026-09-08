# T2-W2C performance notes

Environment: Node v26.7.0, Apple M4, darwin. Baseline commit: 218571c.

## Baseline

`node perf/net-sim.mjs src` was run five times against the unmodified script.
The existing sections had reuse medians around 45 ms and concurrency speedups
around 3.92x. The trial tip had no `--all` wall section.

## Changes

- Added one bounded setup promise handoff to `archive --all`. Each archive starts
  the next loan's `openLoan` + `fetchOpenbook` only after its own setup is ready;
  the next archive consumes that promise and retries synchronously if prefetch
  failed. Prefetch has no logging, so current-loan log order is unchanged.
- Readable pages and assets now hash their exact in-hand bytes before writing and
  pass those digests to `writeManifest`. EPUB was already pre-hashed. Cover
  remains a disk hash because the owned `downloadCover` API returns only its
  destination path (changing it is outside this lane's ownership).

## Measurement

The added local simulated `loan_pipeline_4x` section runs five samples per
variant. Median: sequential 555 ms; one-prefetch pipeline 391 ms; improvement
29.5% (adopts the >=10% bar). This models four loans, three serial setup RTTs,
and eight media requests at bounded concurrency. No real OverDrive network was
used.

`node --expose-gc perf/bench.mjs --quick` completed; focused manifest benchmark
reported 25.3 ms current versus 33.1 ms baseline in its sample, with agreeing
outputs. Baseline `npm test` was 80 passed; after the regression test it is 81
passed, 0 failed.

## Checks and tradeoffs

The e2e archive tests verify manifests still cover every file and match bytes.
The implementation diff is 4 code files, 101 insertions and 18 deletions (5 files,
including these notes, 141 insertions and 18 deletions). No failure
semantics or console output path was intentionally changed. Cover pre-hashing is
not claimed because the current owned boundary prevents receiving cover bytes at
the download moment.

## Hostile review follow-up

Fixed a stale-prefetch bug in `bin/libby.mjs`: the queued setup is now copied to
the current iteration and cleared before archive execution. This prevents a
loan that fails before `onSetupReady` from leaking its setup into the following
loan. Added `test/archive-prefetch.test.mjs`; `npm test` now reports 81 passed.
Also corrected the asset write indentation in `src/archive-read.mjs`.

Five-run e2e wall measurements used the same four-loan simulated listen-host
archive-all harness. Baseline medians were 455 ms (452, 458, 456, 455, 452);
current medians were 445 ms (445, 444, 446, 447, 445), a 2.2% improvement.
This is below the 10% adoption bar for e2e manifest elimination; the 29.5%
simulator model result above remains evidence for the pipeline itself.

The mandated real CLI stdout/exit-code comparison was stopped and not claimed:
the CLI's `sync()` always contacts the hard-coded `sentry.libbyapp.com` gateway
for authentication and loan discovery, while the existing sim only provides
listen/read/catalog hosts. No permitted environment override or fixture config
can redirect that gateway, and editing the gateway/http/auth boundary would
violate this lane's ownership. No real OverDrive request was made.
