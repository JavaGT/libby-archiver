// Manifest reference test (wave W6): the concurrent writeManifest must produce
// byte-identical output to the original sequential implementation — same sorted
// relative paths, same `sha256  path` line format. This is the exactness guarantee
// behind the "hash files concurrently" change; determinism alone doesn't prove it.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeManifest } from '../src/util.mjs';

/** The original sequential implementation, kept here as the behavioral reference. */
async function sequentialManifest(dir) {
  const rels = [];
  const walk = (d, rel = '') => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === 'manifest.sha256' || name.endsWith('.part')) continue;
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else rels.push(r);
    }
  };
  walk(dir);
  const lines = [];
  for (const r of rels) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(dir, r))) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${r}`);
  }
  return lines.join('\n') + '\n';
}

test('concurrent writeManifest is byte-identical to the sequential reference', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-man-'));
  try {
    fs.writeFileSync(path.join(dir, 'Part 01.mp3'), Buffer.alloc(300 * 1024, 1));
    fs.writeFileSync(path.join(dir, 'Part 02.mp3'), Buffer.alloc(64, 2));
    fs.writeFileSync(path.join(dir, 'æ Ø — Part 03.mp3'), Buffer.alloc(1024, 3)); // unicode names
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.writeFileSync(path.join(dir, 'pages', '1.xhtml'), '<svg/>'.repeat(500));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'a.jpg'), Buffer.alloc(200 * 1024, 4));
    fs.writeFileSync(path.join(dir, 'index.part'), 'interrupted download — excluded');
    fs.writeFileSync(path.join(dir, 'manifest.sha256'), 'stale manifest — excluded');

    await writeManifest(dir);
    const got = fs.readFileSync(path.join(dir, 'manifest.sha256'), 'utf8');
    assert.equal(got, await sequentialManifest(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('known digests skip the re-read yet yield a manifest identical to a full hash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libby-man-'));
  try {
    fs.writeFileSync(path.join(dir, 'Part 01.mp3'), Buffer.alloc(200 * 1024, 1));
    fs.writeFileSync(path.join(dir, 'Part 02.mp3'), Buffer.alloc(200 * 1024, 2));
    fs.writeFileSync(path.join(dir, 'metadata.json'), '{"small":true}');

    // Digests a streaming writer would have produced while writing the files.
    const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
    const known = { 'Part 01.mp3': sha('Part 01.mp3'), 'Part 02.mp3': sha('Part 02.mp3') };

    await writeManifest(dir, { known });
    const got = fs.readFileSync(path.join(dir, 'manifest.sha256'), 'utf8');
    assert.equal(got, await sequentialManifest(dir));

    // The known-path lines are exactly the provided digests (they were trusted, not recomputed).
    assert.ok(got.includes(`${known['Part 01.mp3']}  Part 01.mp3`));
    assert.ok(got.includes(`${known['Part 02.mp3']}  Part 02.mp3`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
