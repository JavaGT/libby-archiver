// Cross-title parallelism measurement for `libby archive --all` (#14).
//   node perf/archive-parallel-sim.mjs [--kind audio|read] [--titles 6] [--parts 12]
//                                      [--part-kb 200] [--pages 20] [--latency 150]
//                                      [--runs 3]
//
// The evaluation question in #14 is whether archiving titles in a bounded-
// concurrent loop (mapLimit(targets, 2|3)) instead of the CLI's strict serial
// for…of loop is worth building. This harness measures exactly that: the REAL
// orchestrator (archiveAudiobook, or archiveReadable with --kind read) driven
// over N loans against a latency-injected listen/read host + Thunder catalog —
// same fixture surface as test/e2e.test.mjs (client stubbed at the credential
// boundary, everything past it is unmodified app code: CookieJar handshake,
// openbook decode, per-title bounded pooling, side trips, manifest).
//
// Fresh output dir per run: downloadPart's resume-skip would otherwise turn
// runs 2+ into no-ops. Serial mode reproduces the production loop shape
// (for…of await); the concurrent modes are the candidate mapLimit(k) loop.
// Connection-count deltas quantify the socket multiplication that feeds the
// OverDrive rate-limit ("whoa") risk discussion. Results land in
// results-archive-parallel.json (audio) / …-read.json (read).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { deterministicBytes, selfSignedCert } from '../test/helpers/sim-server.mjs';
import { startServer, eDataPage, cfc1Page } from '../test/helpers/overdrive-sim.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const argStr = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const KIND = argStr('kind', 'audio'); // 'audio' -> archiveAudiobook, 'read' -> archiveReadable
const TITLES = arg('titles', 6);
const PARTS = KIND === 'read' ? 0 : arg('parts', 12);
const PART_KB = KIND === 'read' ? 0 : arg('part-kb', 200);
const PAGES = KIND === 'read' ? arg('pages', 20) : 0;
const ASSETS = KIND === 'read' ? Math.max(2, Math.floor(PAGES / 2)) : 0;
const LATENCY = arg('latency', 150);
const RUNS = arg('runs', 3);

const med = (xs) => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const think = (res) => sleep(LATENCY).then(() => res);

// A P-part audiobook or P-page readable openbook, shaped like the e2e fixtures
// but parameterized.
const partBytes = PART_KB * 1024;
function perfOpenbook() {
  if (KIND === 'read') {
    const pages = Array.from({ length: PAGES }, (_, i) => ({
      path: `pages/${i + 1}.xhtml`,
      '-odread-spine-position': i,
      '-odread-original-path': `pages/${i + 1}.xhtml`,
      'rendition-layout': 'pre-paginated',
      'rendition-viewport': { width: 800, height: 1200 },
    }));
    return {
      b: {
        title: { main: 'Perf Title' },
        description: 'Cross-title parallelism fixture.',
        language: ['en'],
        creator: [{ name: 'A. Author', role: 'author' }, { name: 'Perf Press', role: 'pbl' }],
        spine: pages,
        '-odread-cmpt-params': [],
        nav: { toc: [{ title: 'Front', path: 'pages/1.xhtml' }] },
      },
    };
  }
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
const partBody = KIND === 'read' ? null : deterministicBytes(partBytes);
const assetBody = (k) => deterministicBytes(2048 + k * 31);
const pageBody = (n) =>
  `<svg viewBox="0 0 800 1200">` +
  `<image href="../assets/urlHash-${(n % ASSETS) + 1}.jpg" width="800"/>` +
  `<text>page ${n}</text></svg>`;

// Media host: message handshake + player page on /, then per-kind payloads —
// CDN-style part redirects (audio) or cfc1 pages + assets (read).
const listen = KIND === 'read'
  ? await startServer(cert, [
      {
        match: (p) => p === '/',
        handler: ({ req, res }) => {
          res.setHeader('set-cookie', 'session=perf; Path=/');
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(playerPage(req));
        },
      },
      {
        match: (p) => /^\/pages\/\d+\.xhtml$/.test(p),
        handler: ({ res, url }) => think(res).then(() => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(cfc1Page(pageBody(Number(url.pathname.match(/(\d+)\.xhtml/)[1]))));
        }),
      },
      {
        match: (p) => /^\/assets\/urlHash-\d+\.jpg$/.test(p),
        handler: ({ res, url }) => think(res).then(() => {
          const k = Number(url.pathname.match(/urlHash-(\d+)/)[1]);
          const body = assetBody(k);
          res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
          res.end(body);
        }),
      },
    ])
  : await startServer(cert, [
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
const srcUrl = new URL('../src/', import.meta.url);
const { mapLimit } = await import(new URL('pool.mjs', srcUrl).href);
const archive = KIND === 'read'
  ? (await import(new URL('archive-read.mjs', srcUrl).href)).archiveReadable
  : (await import(new URL('archive.mjs', srcUrl).href)).archiveAudiobook;

const loans = Array.from({ length: TITLES }, (_, i) => ({
  id: String(900 + i),
  cardId: '77',
  title: `Perf Title ${i + 1}`,
  author: 'A. Author',
  type: KIND === 'read' ? 'magazine' : 'audiobook',
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
      await mapLimit(targets, k, ({ ctx, loan }) => archive(ctx, loan, out));
    } else {
      for (const { ctx, loan } of targets) await archive(ctx, loan, out);
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
  config: { kind: KIND, titles: TITLES, parts: PARTS || undefined, partKb: PART_KB || undefined, pages: PAGES || undefined, latencyMs: LATENCY, runs: RUNS },
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
  new URL(`./results-archive-parallel${KIND === 'read' ? '-read' : ''}.json`, import.meta.url),
  JSON.stringify(out, null, 2) + '\n',
);
console.log(JSON.stringify(out, null, 2));
