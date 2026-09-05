import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOpenbook, extractSpine, openKindFor } from '../src/openbook.mjs';

// Forward (encode) direction of bifocal's descramble: per position a with key digit d,
// find the printable char whose scrambled output is the target char. The mapping is
// injective per position (the shift is constant there), so this inverts exactly.
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

const page = (literal) =>
  `<!doctype html><script>window.eData = ${literal};SPARK.bifocalPath='bifocal.js';</script>`;

// buid contains a nonzero digit so the scramble actually engages.
const BUID = 'ab9cd';

function encodedFixture(doc, { singleQuoted = false } = {}) {
  const json = Buffer.from(JSON.stringify(doc)).toString('base64');
  const scrambled = scramble(BUID.split('').reverse().join(''), json);
  if (!singleQuoted) return JSON.stringify(scrambled.split('"'));
  // The scramble can emit any printable ASCII, including quotes/backslashes — escape
  // for a single-quoted JS literal (which JSON.parse rejects, exercising the fallback).
  const escaped = scrambled.split('"').map((s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
  return '[' + escaped.map((s) => `'${s}'`).join(',') + ']';
}

test('decodeOpenbook reverses the eData scramble (double-quoted literal)', () => {
  const doc = { b: { spine: [{ path: 'p1.mp3' }], title: { main: 'Dune' } } };
  assert.deepEqual(decodeOpenbook(page(encodedFixture(doc)), BUID), doc.b);
});

test('decodeOpenbook handles a single-quoted JS literal without eval', () => {
  const doc = { b: { ok: true, chars: 'a"b c/d=e+f' } };
  assert.deepEqual(decodeOpenbook(page(encodedFixture(doc, { singleQuoted: true })), BUID), doc.b);
});

test('decodeOpenbook rejects a literal that is not plain strings (no eval)', () => {
  assert.throws(() => decodeOpenbook(page('[process.exit(1)]'), BUID), /non-string token/);
  assert.throws(() => decodeOpenbook(page('[{"evil":1}]'), BUID), /non-string token/);
});

test('decodeOpenbook reports a missing eData block', () => {
  assert.throws(() => decodeOpenbook('<html>nothing here</html>', BUID), /window\.eData not found/);
});

test('extractSpine pairs spine paths with their signed cmpt params', () => {
  const ob = {
    spine: [
      { path: 'a.mp3', '-odread-spine-position': 1, '-odread-file-bytes': 12345 },
      { path: 'b.mp3', '-odread-spine-position': 0 },
    ],
    '-odread-cmpt-params': ['sig=first', 'sig=second'],
  };
  const parts = extractSpine(ob, 'https://dewey-x.listen.libbyapp.com/');
  assert.equal(parts[0].url, 'https://dewey-x.listen.libbyapp.com/a.mp3?sig=second');
  assert.equal(parts[0].size, 12345);
  assert.equal(parts[0].index, 1);
  assert.equal(parts[1].url, 'https://dewey-x.listen.libbyapp.com/b.mp3?sig=first');
});

test('openKindFor maps loan types to gateway open kinds', () => {
  assert.equal(openKindFor({ type: 'audiobook' }), 'audiobook');
  assert.equal(openKindFor({ type: 'ebook' }), 'book');
  assert.equal(openKindFor({ type: 'magazine' }), 'magazine');
  assert.equal(openKindFor({ type: 'video' }), 'book');
});
