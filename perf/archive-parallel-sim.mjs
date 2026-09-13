// Cross-title parallelism measurement for `libby archive --all` (#14).
//   node perf/archive-parallel-sim.mjs [--titles 6] [--parts 12] [--part-kb 200]
//                                      [--latency 150] [--runs 3]
//
// The evaluation question in #14 is whether archiving titles in a bounded-
// concurrent loop (mapLimit(targets, 2|3)) instead of the CLI's strict serial
// for…of loop is worth building. This harness measures exactly that: the REAL
// archiveAudiobook orchestrator (src/archive.mjs) driven over N loans against a
// latency-injected listen host + Thunder catalog — same fixture surface as
// test/e2e.test.mjs (client stubbed at the credential boundary, everything past
// it is unmodified app code: CookieJar handshake, openbook decode, part
// downloads with per-title 3-wide pooling, thunder/cover side trips, manifest).
//
// Fresh output dir per run: downloadPart's resume-skip would otherwise turn
// runs 2+ into no-ops. Serial mode reproduces the production loop shape
// (for…of await); the concurrent modes are the candidate mapLimit(k) loop.
// Connection-count deltas on the listen host quantify the socket multiplication
// that feeds the OverDrive rate-limit ("whoa") risk discussion.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { deterministicBytes, selfSignedCert } from '../test/helpers/sim-server.mjs';
import { startServer, eDataPage } from '../test/helpers/overdrive-sim.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const TITLES = arg('titles', 6);
const PARTS = arg('parts', 12);
const PART_KB = arg('part-kb', 200);
const LATENCY = arg('latency', 150);
const RUNS = arg('runs', 3);

const med = (xs) => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const think = (res) => sleep(LATENCY).then(() => res);

// A P-part audiobook openbook, shaped like the e2e fixture but parameterized.
function perfOpenbook() {
  const partBytes = PART_KB * 1024;
  const parts = Array.from({ length: PARTS }, (_, i) => ({
    path: `res/part${i + 1}.mp3`,
    '-odread-spine-position': i,
    '-odread-original-path': `res/part${i + 1}.mp3`,
    '-odread-file-bytes': partBytes,
    'audio-duration': 600 + i,
    'media-type': 'audio/mpeg',
  }));
  return {
    b: {
      title: { main: 'Perf Title' },
      description: { full: 'Cross-title parallelism fixture.' },
      language: 'en',
      creator: [{ name: 'A. Author', role: 'author' }],
      spine: parts,
      '-odread-cmpt-params': parts.map((_, i) => `cmpt=${i}`),
      nav: { toc: [{ title: 'Chapter 1', path: 'res/part1.mp3#0.00000-119.00000' }] },
    },
  };
}

const cert = selfSignedCert();
if (!cert) {
  console.error('openssl unavailable');
  process.exit(1);
}

const openbook = perfOpenbook();
const playerPage = (req) => eDataPage(openbook, `https://${req.headers.host}/`);
const partBody = deterministicBytes(PART_KB * 1024);

// Listen host: message handshake + player page on /, CDN-style part redirects.
const listen = await startServer(cert, [
  {
    match: (p) => p === '/',
    handler: ({ req, res }) => {
      res.setHeader('set-cookie', 'session=perf; Path=/');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(playerPage(req));
    },
  },
  {
    match: (p) => /^\/res\/part\d+\.mp3$/.test(p),
    handler: ({ res, url }) => think(res).then(() => {
      res.writeHead(302, { location: url.pathname.replace('/res/', '/cdn/') });
      res.end();
    }),
  },
  {
    match: (p) => /^\/cdn\/part\d+\.mp3$/.test(p),
    handler: ({ res }) => think(res).then(() => {
      res.writeHead(200, { 'content-length': partBody.length });
      res.end(partBody);
    }),
  },
]);

// Thunder catalog: media record + characteristics + cover, all with think-time.
const catalog = await startServer(cert, [
  {
    match: (p) => /^\/v2\/libraries\/[^/]+\/media\/\d+$/.test(p),
    handler: ({ res, url }) => think(res).then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: url.pathname.match(/media\/(\d+)/)[1],
        title: 'Perf Title',
        firstCreatorName: 'A. Author',
        type: { id: 'audiobook' },
        publisher: { name: 'Perf Press' },
        subjects: [],
        formats: [],
        covers: { a: { href: `${catalog.url}/covers/big.jpg`, width: 800 } },
      }));
    }),
  },
  {
    match: (p) => /\/characteristics\/title\/\d+$/.test(p),
    handler: ({ res }) => think(res).then(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ characteristics: {} }));
    }),
  },
  {
    match: (p) => p === '/covers/big.jpg',
    handler: ({ res }) => think(res).then(() => {
      const body = deterministicBytes(3000);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
      res.end(body);
    }),
  },
]);

// The catalog host constant is read at module-load time; set it first.
process.env.LIBBY_THUNDER_HOST = catalog.host;
const { archiveAudiobook } = await import(new URL('../src/archive.mjs', import.meta.url).href);
const { mapLimit } = await import(new URL('../src/pool.mjs', import.meta.url).href);

const loans = Array.from({ length: TITLES }, (_, i) => ({
  id: String(900 + i),
  cardId: '77',
  title: `Perf Title ${i + 1}`,
  author: 'A. Author',
  type: 'audiobook',
  expires: '2026-12-31',
  raw: { perf: i },
}));

function prepareTargets(out) {
  return loans.map((loan) => {
    const passport = { urls: { web: `${listen.url}/` }, message: 'msg=perf' };
    const ctx = {
      client: { requestOk: async () => ({ json: passport }) },
      identity: 'perf-identity',
      cfg: { library: 'perflib', libraryName: 'Perf Library', websiteId: '1', insecureTLS: true, out },
      log: () => {},
    };
    return { ctx, loan };
  });
}

async function timedRun(k) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-par-'));
  const targets = prepareTargets(out);
  const connsBefore = listen.connections;
  const t0 = performance.now();
  try {
    // Serial = the production loop shape (bin/libby.mjs); k>1 = the candidate loop.
    if (k > 1) {
      await mapLimit(targets, k, ({ ctx, loan }) => archiveAudiobook(ctx, loan, out));
    } else {
      for (const { ctx, loan } of targets) await archiveAudiobook(ctx, loan, out);
    }
    const wallMs = performance.now() - t0;
    // sanity: every title claimed a folder with a manifest
    for (const { loan } of targets) {
      const dir = path.join(out, `${loan.author} - ${loan.title}`);
      if (!fs.existsSync(path.join(dir, 'manifest.sha256'))) {
        throw new Error(`missing manifest for ${loan.title}`);
      }
    }
    return { wallMs: Math.round(wallMs), listenConnections: listen.connections - connsBefore };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const out = {
  date: new Date().toISOString(),
  config: { titles: TITLES, parts: PARTS, partKb: PART_KB, latencyMs: LATENCY, runs: RUNS },
  modes: {},
};

// untimed warmup: JIT + FS cache, thrown away
await timedRun(1);

for (const k of [1, 2, 3]) {
  const runs = [];
  for (let r = 0; r < RUNS; r++) runs.push(await timedRun(k));
  out.modes[k === 1 ? 'serial' : `mapLimit${k}`] = {
    medianMs: med(runs.map((x) => x.wallMs)),
    runs,
    medianListenConnections: med(runs.map((x) => x.listenConnections)),
  };
}

await Promise.all([listen.close(), catalog.close()]);

const s = out.modes.serial.medianMs;
for (const [name, m] of Object.entries(out.modes)) {
  m.speedupVsSerial = +(s / m.medianMs).toFixed(2);
}

fs.writeFileSync(
  new URL('./results-archive-parallel.json', import.meta.url),
  JSON.stringify(out, null, 2) + '\n',
);
console.log(JSON.stringify(out, null, 2));
