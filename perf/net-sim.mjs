// Network-pattern measurements against a local latency-injecting TLS server.
//   node perf/net-sim.mjs <path-to-src-dir> [label]
//
// Measures (using the REAL http.mjs / pool.mjs from the given src dir):
//   1. reuse   — 30 sequential small JSON GETs: wall time + server-side connection
//                count (no-keepalive baseline pays a TLS handshake per request)
//   2. concur  — 120 GETs at 25 ms server latency: sequential vs mapLimit(4)
//   3. loans   — archive --all loan pipelining: N loans × (setup RTTs then parts
//                at mapLimit(3)); pipelined keeps ONE next-loan setup in flight
// Loopback handshake cost understates the real-world win (~50–150 ms/RTT against
// OverDrive); the connection COUNT is the transferable evidence.

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { startSimServer } from '../test/helpers/sim-server.mjs';

const srcDir = process.argv[2];
const label = process.argv[3] ?? srcDir.split('/').filter(Boolean).pop();
const { fetchBuffer } = await import(new URL('http.mjs', pathToFileURL(srcDir + '/')).href);
let mapLimit = null;
try {
  ({ mapLimit } = await import(new URL('pool.mjs', pathToFileURL(srcDir + '/')).href));
} catch {}

const sim = await startSimServer();
if (!sim) {
  console.error('openssl unavailable');
  process.exit(1);
}

const med = (xs) => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1];
const out = { label, date: new Date().toISOString(), sections: {} };

// 1. connection reuse
{
  const runs = [];
  let connections = 0;
  for (let r = 0; r < 3; r++) {
    sim.connections = 0;
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) await fetchBuffer(`${sim.url}/json`, { insecureTLS: true, timeoutMs: 5000 });
    runs.push(performance.now() - t0);
    connections = sim.connections;
  }
  out.sections.reuse_30_gets = { wallMs: Math.round(med(runs)), serverConnections: connections };
}

// 2. concurrency pattern (25 ms simulated server think-time per request)
{
  const url = `${sim.url}/slow`;
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) await fetchBuffer(url, { insecureTLS: true, timeoutMs: 10_000 });
  const seqMs = performance.now() - t0;

  let parMs = null;
  if (mapLimit) {
    const t1 = performance.now();
    await mapLimit(
      Array.from({ length: 120 }, (_, i) => i),
      4,
      (i) => fetchBuffer(`${url}?i=${i}`, { insecureTLS: true, timeoutMs: 10_000 }),
    );
    parMs = performance.now() - t1;
  }
  out.sections.concurrency_120x25ms = {
    sequentialMs: Math.round(seqMs),
    mapLimit4Ms: parMs == null ? null : Math.round(parMs),
    speedup: parMs == null ? null : +(seqMs / parMs).toFixed(2),
  };
}

// 3. loan pipeline pattern (archiveLoanQueue in bin/libby.mjs): each loan pays
//    SETUP_RTT sequential setup round trips (gateway/listen API) before its
//    PARTS downloads run at PART_CONC (CDN, 3 spine parts / 4 pages). Latencies
//    are injected client-side over the real fetch/pool stack (the sim's /json is
//    instant), so keepalive connection reuse stays in play. Pipelining overlaps
//    exactly ONE next-loan setup with the active loan's downloads — nothing else
//    changes, so the expected win is (N-1) × setup time.
{
  const LOANS = 5, SETUP_RTT = 4, SETUP_MS = 60, PARTS = 6, PART_CONC = 3, PART_MS = 400;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const op = (ms) =>
    fetchBuffer(`${sim.url}/json`, { insecureTLS: true, timeoutMs: 10_000 }).then(() => sleep(ms));
  const setupLoan = async () => {
    for (let i = 0; i < SETUP_RTT; i++) await op(SETUP_MS);
  };
  const downloadLoan = () =>
    mapLimit
      ? mapLimit(Array.from({ length: PARTS }, (_, i) => i), PART_CONC, () => op(PART_MS))
      : Promise.reject(new Error('pool.mjs unavailable'));

  if (mapLimit) {
    const sequential = async () => {
      for (let i = 0; i < LOANS; i++) {
        await setupLoan();
        await downloadLoan();
      }
    };
    // The real shape: adopt loan i's setup, start loan i+1's setup, then download loan i.
    const pipelined = async () => {
      let pending = setupLoan();
      for (let i = 0; i < LOANS; i++) {
        await pending; // resolves to an Error only if setup failed (held for FAILED handling)
        pending = i + 1 < LOANS ? setupLoan().catch((e) => e) : null;
        await downloadLoan();
      }
    };

    const seqRuns = [];
    const pipeRuns = [];
    for (let r = 0; r < 2; r++) {
      let t = performance.now();
      await sequential();
      seqRuns.push(performance.now() - t);
      t = performance.now();
      await pipelined();
      pipeRuns.push(performance.now() - t);
    }

    const downloadMs = Math.ceil(PARTS / PART_CONC) * PART_MS;
    const setupMs = SETUP_RTT * SETUP_MS;
    out.sections.loan_pipeline_5x = {
      model: `${LOANS} loans × (${SETUP_RTT} setup RTTs × ${SETUP_MS}ms + ${PARTS} parts × ${PART_MS}ms @${PART_CONC})`,
      sequentialMs: Math.round(med(seqRuns)),
      pipelinedMs: Math.round(med(pipeRuns)),
      speedup: +(med(seqRuns) / med(pipeRuns)).toFixed(2),
      expectedSequentialMs: LOANS * (setupMs + downloadMs),
      expectedPipelinedMs: setupMs + downloadMs + (LOANS - 1) * Math.max(downloadMs, setupMs),
      runs: { sequentialMs: seqRuns.map(Math.round), pipelinedMs: pipeRuns.map(Math.round) },
    };
  }
}

await sim.close();
console.log(JSON.stringify(out, null, 2));
