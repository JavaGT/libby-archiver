// Simulated OverDrive surface for end-to-end archive tests: three small TLS hosts
// standing in for the listen host (audiobook player + spine parts), the read host
// (magazine player + pages + assets), and the Thunder catalog (media + covers).
//
// Serves the real wire formats the app decodes: a `window.eData` player page
// (scrambled with the forward direction of bifocal's descramble, keyed to the Host
// the app will derive the buid from) and `parent.__bif_cfc1(...)` page bodies
// (encoded with the inverse of read.mjs's cfc1 — the swap is an involution).
// No real network, no credentials.

import https from 'node:https';
import { deterministicBytes, selfSignedCert } from './sim-server.mjs';

/** The listen/read buid the app derives from a sim hostname, and its scramble key. */
export function scrambleKeyFor(webUrl) {
  const host = new URL(webUrl).host;
  const buid = host.split('.')[0].replace(/^[^-]+-/, ''); // mirrors openbook.mjs
  return buid.split('').reverse().join('');
}

/** Forward direction of bifocal's descramble (mirrors test/openbook.test.mjs). */
function scramble(key, data) {
  let out = '';
  for (let a = 0; a < data.length; a++) {
    const target = data.charCodeAt(a);
    const d = parseFloat(key[a % key.length]);
    if (!d) {
      out += data[a];
      continue;
    }
    let found = data[a];
    for (let c = 32; c <= 126; c++) {
      let y = c + ((a + d) % 94);
      if (y > 126) y = (y % 126) + 32;
      if (y === target) {
        found = String.fromCharCode(c);
        break;
      }
    }
    out += found;
  }
  return out;
}

/** Player page embedding the openbook as window.eData, scrambled for this host. */
export function eDataPage(doc, webUrl) {
  const key = scrambleKeyFor(webUrl);
  const json = Buffer.from(JSON.stringify(doc)).toString('base64');
  const scrambled = scramble(key, json);
  const literal = JSON.stringify(scrambled.split('"'));
  return `<!doctype html><script>window.eData = ${literal};SPARK.bifocalPath='bifocal.js';</script>`;
}

/** Encode a page body into the `parent.__bif_cfc1(self, '<blob>')` wire format. */
export function cfc1Encode(content) {
  const b64 = Buffer.from(content, 'utf8').toString('base64'); // length is a multiple of 4
  let out = '';
  for (let i = 0; i < b64.length; i += 4) out += b64[i + 3] + b64[i + 1] + b64[i + 2] + b64[i];
  return out;
}

export function cfc1Page(content) {
  return `<!doctype html><script>parent.__bif_cfc1(self, '${cfc1Encode(content)}');</script>`;
}

export const partBytes = (i) => 1000 + i * 137; // i is the 0-based part index

/** A listen-host openbook for a 3-part audiobook, sizes matching the part routes. */
export function audiobookOpenbook() {
  const parts = [0, 1, 2].map((i) => ({
    path: `res/part${i + 1}.mp3`,
    '-odread-spine-position': i,
    '-odread-original-path': `res/part${i + 1}.mp3`,
    '-odread-file-bytes': partBytes(i),
    'audio-duration': 600 + i,
    'media-type': 'audio/mpeg',
  }));
  return {
    b: {
      title: { main: 'E2E Audiobook', subtitle: 'A Simulated Saga' },
      description: { full: 'An <i>archived</i> test &amp; verification title.' },
      language: 'en',
      creator: [
        { name: 'A. Author', role: 'author' },
        { name: 'N. Narrator', role: 'narrator' },
      ],
      spine: parts,
      '-odread-cmpt-params': parts.map((_, i) => `cmpt=${i}`),
      'nav': { toc: [{ title: 'Chapter 1', path: 'res/part1.mp3' }] },
    },
  };
}

/** A read-host openbook for a 2-page fixed-layout magazine sharing one asset. */
export function magazineOpenbook() {
  const page = (n) => ({
    path: `pages/${n}.xhtml`,
    '-odread-spine-position': n - 1,
    '-odread-original-path': `pages/${n}.xhtml`,
    'rendition-layout': 'pre-paginated',
    'rendition-viewport': { width: 800, height: 1200 },
  });
  return {
    b: {
      title: { main: 'E2E Magazine' },
      description: 'A fixed-layout test magazine.',
      language: ['en'],
      creator: [{ name: 'M. Editor', role: 'author' }, { name: 'Test Press', role: 'pbl' }],
      spine: [page(1), page(2)],
      '-odread-cmpt-params': [],
      'nav': { toc: [{ title: 'Front', path: 'pages/1.xhtml' }] },
    },
  };
}

export function pageBody(n) {
  // both pages reference the SAME asset (urlHash-1) so the e2e can pin asset dedupe
  return (
    `<svg viewBox="0 0 800 1200">` +
    `<image href="../assets/urlHash-1.jpg" width="800"/>` +
    `<text>page ${n}</text>` +
    `</svg>`
  );
}

function startServer(cert, matchers) {
  const state = { connections: 0, playerHadCookie: false };
  const server = https.createServer(cert, (req, res) => {
    const url = new URL(req.url, 'https://localhost');
    const hit = matchers.find((m) => m.match(url.pathname));
    if (!hit) {
      res.writeHead(404);
      res.end();
      return;
    }
    hit.handler({ req, res, url, state });
  });
  server.on('connection', () => state.connections++);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      state.url = `https://localhost:${port}`;
      state.host = `localhost:${port}`;
      state.close = () => new Promise((r) => server.close(r));
      resolve(state);
    });
  });
}

const playerPageFor = (req, doc) =>
  eDataPage(doc, `https://${req.headers.host}/`); // key derives from the Host the app sees

/**
 * Start the three sim hosts. Feed `sim.catalog.host` to LIBBY_THUNDER_HOST
 * before importing the app modules that talk to Thunder.
 */
export async function startOverdriveSim() {
  const cert = selfSignedCert();
  if (!cert) return null;

  const listen = await startServer(cert, [
    {
      match: (p) => p === '/',
      handler: ({ req, res, state }) => {
        if (req.headers.cookie) state.playerHadCookie = true;
        res.setHeader('set-cookie', 'session=e2e; Path=/');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(playerPageFor(req, audiobookOpenbook()));
      },
    },
    {
      match: (p) => /^\/res\/part[123]\.mp3$/.test(p),
      handler: ({ res, url }) => {
        const n = Number(url.pathname.match(/part(\d)/)[1]);
        res.writeHead(302, { location: `/cdn/part${n}.mp3` }); // parts redirect, as the CDN does
        res.end();
      },
    },
    {
      match: (p) => /^\/cdn\/part[123]\.mp3$/.test(p),
      handler: ({ res, url }) => {
        const n = Number(url.pathname.match(/part(\d)/)[1]);
        const body = deterministicBytes(partBytes(n - 1));
        res.writeHead(200, { 'content-length': body.length });
        res.end(body);
      },
    },
  ]);

  const read = await startServer(cert, [
    {
      match: (p) => p === '/',
      handler: ({ req, res, state }) => {
        if (req.headers.cookie) state.playerHadCookie = true;
        res.setHeader('set-cookie', 'session=e2e; Path=/');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(playerPageFor(req, magazineOpenbook()));
      },
    },
    {
      match: (p) => /^\/pages\/[12]\.xhtml$/.test(p),
      handler: ({ res, url }) => {
        const n = Number(url.pathname.match(/pages\/(\d)/)[1]);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(cfc1Page(pageBody(n)));
      },
    },
    {
      match: (p) => /^\/assets\/urlHash-[12]\.jpg$/.test(p),
      handler: ({ res, url }) => {
        const n = Number(url.pathname.match(/urlHash-(\d)/)[1]);
        const body = deterministicBytes(2048 + n * 31);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
        res.end(body);
      },
    },
  ]);

  const catalog = await startServer(cert, [
    {
      match: (p) => p === '/covers/big.jpg',
      handler: ({ res }) => {
        const body = deterministicBytes(3000);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
        res.end(body);
      },
    },
    {
      match: (p) => /^\/v2\/libraries\/[^/]+\/media\/\d+$/.test(p),
      handler: ({ res, url }) => {
        const record = {
          id: url.pathname.match(/media\/(\d+)/)[1],
          publisher: { name: 'Test Press' },
          subjects: [{ name: 'space' }, { name: 'testing' }],
          formats: [{ id: 'audiobook', identifiers: [{ type: 'ISBN', value: '978-0-000-00000-1' }] }],
          covers: { a: { href: `${catalog.url}/covers/big.jpg`, width: 800 } },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(record));
      },
    },
  ]);

  return {
    listen,
    read,
    catalog,
    close: async () => {
      await Promise.all([listen.close(), read.close(), catalog.close()]);
    },
  };
}
