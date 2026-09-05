// End-to-end archive tests against a simulated OverDrive surface
// (test/helpers/overdrive-sim.mjs). These drive the REAL orchestrators —
// archiveAudiobook / archiveReadable — through loan open → session handshake →
// openbook decode → downloads → EPUB/sidecars → integrity manifest, with only the
// credential boundary (authenticate/sentry) faked. No real network, no card.
//
// Only `authenticate` is out of scope: the sentry chip protocol cannot be pointed
// at a sim without faking the very logic under test, so `client` is a stub that
// returns the fixture passport — everything past it is the unmodified app code.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startOverdriveSim, audiobookOpenbook, magazineOpenbook, pageBody, partBytes } from './helpers/overdrive-sim.mjs';
import { deterministicBytes, sha256 } from './helpers/sim-server.mjs';

const sim = await startOverdriveSim();
if (!sim) {
  // No openssl: the whole file's preconditions are unavailable.
  test('e2e skipped (openssl unavailable)', () => {});
} else {
  // The catalog host must be overridden before the app modules load their constants.
  process.env.LIBBY_THUNDER_HOST = sim.catalog.host;
  const { archiveAudiobook } = await import('../src/archive.mjs');
  const { archiveReadable } = await import('../src/archive-read.mjs');
  const { namespaceSvg } = await import('../src/read.mjs');

  const tmpOut = () => fs.mkdtempSync(path.join(os.tmpdir(), 'libby-e2e-'));
  const fakeClient = (passport) => ({
    requestOk: async () => ({ json: passport }),
    request: async () => {
      throw new Error('e2e stub: only openLoan (requestOk) is faked');
    },
  });
  const ctxFor = (passport, out) => ({
    client: fakeClient(passport),
    identity: 'e2e-identity',
    cfg: { library: 'testlib', libraryName: 'Test Library', websiteId: '123', insecureTLS: true, out },
    log: () => {},
  });
  const walkFiles = (dir, rel = '') =>
    fs.readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      return fs.statSync(full).isDirectory() ? walkFiles(full, r) : [r];
    });

  const assertManifestCovers = (bookDir) => {
    const lines = fs.readFileSync(path.join(bookDir, 'manifest.sha256'), 'utf8').trim().split('\n');
    const rels = walkFiles(bookDir).filter((r) => r !== 'manifest.sha256');
    assert.deepEqual(lines.map((l) => l.split('  ')[1]).sort(), rels.sort());
    for (const line of lines) {
      const [hash, rel] = line.split('  ');
      const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(bookDir, rel))).digest('hex');
      assert.equal(actual, hash, `manifest hash for ${rel}`);
    }
  };

  test('e2e: audiobook loan archives to a complete, verified folder', async () => {
    const out = tmpOut();
    try {
      const loan = {
        id: '101',
        cardId: '77',
        title: 'E2E Audiobook',
        author: 'A. Author',
        type: 'audiobook',
        expires: '2026-09-20',
        raw: { someLoanField: true },
      };
      const passport = { urls: { web: `${sim.listen.url}/` }, message: 'msg=e2e' };
      const bookDir = await archiveAudiobook(ctxFor(passport, out), loan, out);

      // folder claim + marker
      assert.equal(path.basename(bookDir), 'A. Author - E2E Audiobook');
      const marker = JSON.parse(fs.readFileSync(path.join(bookDir, '.libby-archive.json'), 'utf8'));
      assert.equal(marker.titleId, '101');

      // spine parts: byte-for-byte as served, after the CDN-style redirect
      for (let i = 0; i < 3; i++) {
        const p = path.join(bookDir, `Part ${String(i + 1).padStart(2, '0')}.mp3`);
        assert.ok(fs.readFileSync(p).equals(deterministicBytes(partBytes(i))), `Part ${i + 1} bytes`);
        assert.ok(!fs.existsSync(p + '.part'));
      }

      // cover
      assert.ok(fs.readFileSync(path.join(bookDir, 'cover.jpg')).equals(deterministicBytes(3000)));

      // session cookie from the message handshake reached the player fetch
      assert.ok(sim.listen.playerHadCookie, 'player page fetch must carry the session cookie');

      // raw sidecars
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bookDir, 'openbook.json'), 'utf8')), audiobookOpenbook().b);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bookDir, 'passport.json'), 'utf8')), passport);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bookDir, 'loan.json'), 'utf8')), loan.raw);
      const passportMode = fs.statSync(path.join(bookDir, 'passport.json')).mode & 0o777;
      assert.equal(passportMode, 0o600, 'credential sidecars are 0600');

      // normalized metadata
      const meta = JSON.parse(fs.readFileSync(path.join(bookDir, 'metadata.json'), 'utf8'));
      assert.equal(meta.titleId, '101');
      assert.equal(meta.title, 'E2E Audiobook');
      assert.equal(meta.author, 'A. Author');
      assert.deepEqual(meta.narrators, ['N. Narrator']);
      assert.deepEqual(meta.chapters, [{ title: 'Chapter 1', part: 1, offset: '0.00000-119.00000' }]);
    assert.equal(meta.library, 'testlib');
    assert.equal(meta.libraryName, 'Test Library');
    assert.equal(meta.generator.name, 'libby-archiver');
    assert.match(meta.generator.version, /^\d+\.\d+\.\d+/);
      assert.equal(meta.durationSeconds, 600 + 601 + 602);
      assert.deepEqual(meta.isbns, ['978-0-000-00000-1']);
      assert.equal(meta.publisher, 'Test Press');
      assert.equal(meta.language, 'en');

      assert.ok(fs.existsSync(path.join(bookDir, 'README.txt')));
      assert.ok(fs.existsSync(path.join(bookDir, 'thunder.json')));
      assertManifestCovers(bookDir); // every file, README.txt included
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  test('e2e: magazine loan archives to verified pages, assets and a valid fixed-layout EPUB', async (t) => {
    let unzip;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
      unzip = true;
    } catch {
      unzip = false;
    }
    const out = tmpOut();
    try {
      const loan = {
        id: '202',
        cardId: '77',
        title: 'E2E Magazine',
        author: 'M. Editor',
        type: 'magazine',
        expires: '2026-09-20',
        raw: { loanField: 'x' },
      };
      const passport = { urls: { web: `${sim.read.url}/` }, message: 'msg=e2e' };
      const bookDir = await archiveReadable(ctxFor(passport, out), loan, out);

      assert.equal(path.basename(bookDir), 'M. Editor - E2E Magazine');

      // decoded pages land at their openbook paths, exactly as decoded
      // (decodePage runs namespaceSvg, so the plain fixture svg gains its namespaces)
      assert.equal(fs.readFileSync(path.join(bookDir, 'pages/1.xhtml'), 'utf8'), namespaceSvg(pageBody(1)));
      assert.equal(fs.readFileSync(path.join(bookDir, 'pages/2.xhtml'), 'utf8'), namespaceSvg(pageBody(2)));

      // one shared asset, fetched once and stored plainly
      assert.ok(fs.readFileSync(path.join(bookDir, 'assets/urlHash-1.jpg')).equals(deterministicBytes(2048 + 1 * 31)));
      assert.ok(!fs.existsSync(path.join(bookDir, 'assets/urlHash-2.jpg')), 'shared asset is deduplicated');
      assert.ok(sim.read.playerHadCookie, 'read-host player fetch must carry the session cookie');

      // EPUB: present, spec-valid, carries the pages and fixed-layout markers
      const epubPath = path.join(bookDir, 'E2E Magazine.epub');
      const epub = fs.readFileSync(epubPath);
      assert.ok(epub.length > 1000);
      if (unzip) execFileSync('unzip', ['-t', epubPath], { stdio: 'pipe' });
      assert.equal(epub.readUInt16LE(8), 0, 'mimetype entry is stored (method 0)');
      const meta = JSON.parse(fs.readFileSync(path.join(bookDir, 'metadata.json'), 'utf8'));
      assert.equal(meta.type, 'magazine');
      assert.equal(meta.fixedLayout, true);
      assert.equal(meta.pages, 2);
      assert.equal(meta.assets, 1);
      assert.equal(meta.publisher, 'Test Press'); // from openbook creator role pbl
    assert.equal(meta.library, 'testlib');
    assert.equal(meta.generator.name, 'libby-archiver');

      assertManifestCovers(bookDir); // every file, README.txt included
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  test('cleanup: close sim servers', async () => {
    await sim.close();
  });
}
