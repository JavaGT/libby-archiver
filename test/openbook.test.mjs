import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOpenbook, descramble, extractSpine, openKindFor, probeEData } from '../src/openbook.mjs';

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

// ---- descramble fast path vs the exact character-loop reference ----------------

// Reference: the pre-W23 implementation (array of 1-char strings + join). The W23
// latin1 byte fast path is only lossless for pure ASCII, so anything with a code
// unit > 127 must go down the code-unit fallback — both are pinned against this.
function refDescramble(key, data) {
  const klen = key.length;
  const shifts = new Array(klen);
  for (let i = 0; i < klen; i++) shifts[i] = parseFloat(key[i]) || 0;
  const out = new Array(data.length);
  for (let a = 0; a < data.length; a++) {
    let ch = data.charCodeAt(a);
    const d = shifts[a % klen];
    if (d) {
      ch += (a + d) % 94;
      if (ch > 126) ch = (ch % 126) + 32;
    }
    out[a] = String.fromCharCode(ch);
  }
  return out.join('');
}

test('descramble matches the character-loop reference (fast path and fallback)', () => {
  const cases = [
    ['dcba9', ''], // empty
    ['dcba9', 'abcdefghijklmnopqrstuvwxyz0123456789+/= ABCDEF'], // pure ASCII
    ['9a2f4ed7', 'x'.repeat(5000) + '\x7f tail'], // 0x7f stays inside the ASCII fast path
    ['dcba0', 'digit zero parses to shift 0 — untouched'], // '0' is a no-op like NaN
    ['dcba9', 'é-latin1-range\uffff'], // code units > 127 -> code-unit fallback
    ['9a2f4ed7', 'a\u2028b€c\ud83d\ude00'], // >255 chars incl. surrogates
  ];
  for (const [key, data] of cases) {
    assert.equal(descramble(key, data), refDescramble(key, data), JSON.stringify(data.slice(0, 24)));
  }
});

test('descramble inverts the scramble at scale on the ASCII fast path', () => {
  const payload = Buffer.from(JSON.stringify({ b: { ok: 1 } }))
    .toString('base64')
    .repeat(1000);
  assert.equal(descramble('dcba9', scramble('dcba9', payload)), payload);
});

// ---- obfuscation-drift canaries ------------------------------------------------
// OverDrive changing bifocal's scramble must fail LOUDLY at the named stage,
// never as silent garbage. These encode fixtures with drifted constants to
// simulate exactly that.

// Same shape as `scramble` but with a drifted shift modulus (94 -> 95).
function driftedScramble(key, data) {
  let out = '';
  for (let a = 0; a < data.length; a++) {
    let ch = data.charCodeAt(a);
    const d = parseFloat(key[a % key.length]);
    if (d) {
      ch += (a + d) % 95;
      if (ch > 126) ch = (ch % 126) + 32;
    }
    out += String.fromCharCode(ch);
  }
  return out;
}

function driftedFixture(doc) {
  const json = Buffer.from(JSON.stringify(doc)).toString('base64');
  const scrambled = driftedScramble(BUID.split('').reverse().join(''), json);
  return JSON.stringify(scrambled.split('"'));
}

test('drift: a changed scramble fails loudly, naming the contract', () => {
  assert.throws(
    () => decodeOpenbook(page(driftedFixture({ b: { ok: true } })), BUID),
    /not JSON.*scramble.*drift/is,
  );
});

test('probeEData reports per-stage health and names the drifted stage', () => {
  const healthy = probeEData(page(encodedFixture({ b: { ok: 1 } })), BUID);
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.stages.map((s) => s.stage), [
    'eData-marker', 'eData-literal', 'eData-json', 'openbook-shape',
  ]);
  assert.ok(healthy.stages.every((s) => s.ok));

  const drifted = probeEData(page(driftedFixture({ b: { ok: 1 } })), BUID);
  assert.equal(drifted.ok, false);
  const failed = drifted.stages.find((s) => !s.ok);
  assert.equal(failed.stage, 'eData-json');
  assert.match(failed.drift, /scramble/);

  const noMarker = probeEData('<html>nothing here</html>', BUID);
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.stages[0].stage, 'eData-marker');
});
