// Network-pattern measurements against a local latency-injecting TLS server.
//   node perf/net-sim.mjs <path-to-src-dir> [label]
//
// Measures (using the REAL http.mjs / pool.mjs from the given src dir):
//   1. reuse   — 30 sequential small JSON GETs: wall time + server-side connection
//                count (no-keepalive baseline pays a TLS handshake per request)
//   2. concur  — 120 GETs at 25 ms server latency: sequential vs mapLimit(4)
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

await sim.close();
console.log(JSON.stringify(out, null, 2));
