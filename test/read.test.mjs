import test from 'node:test';
import assert from 'node:assert/strict';
import { cfc1, decodePage, namespaceSvg, assetRefs, probeCfc1 } from '../src/read.mjs';

test('cfc1 reverses the swapped-base64 blob', () => {
  const s = 'The quick brown fox — ünïcodé & <tags>';
  // Encode: base64 the UTF-8 text, then swap chars 1<->4 of every 4-char group.
  const blob = Buffer.from(s, 'utf8').toString('base64').replace(/(.)(.)(.)(.)/g, '$4$2$3$1');
  assert.equal(cfc1(blob), s);
});

test('decodePage extracts the __bif_cfc1 body and throws without one', () => {
  const body = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const blob = Buffer.from(body, 'utf8').toString('base64').replace(/(.)(.)(.)(.)/g, '$4$2$3$1');
  const html = `<html><script>parent.__bif_cfc1(self, '${blob}');</script></html>`;
  assert.equal(decodePage(html), body);
  assert.throws(() => decodePage('<html>error page</html>'), /no __bif_cfc1 component/);
});

test('namespaceSvg adds namespaces only when missing', () => {
  const bare = '<svg viewBox="0 0 2 2">';
  const patched = namespaceSvg(bare);
  assert.match(patched, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink=/);
  assert.match(patched, /viewBox="0 0 2 2">$/);

  const withNs = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  assert.equal(namespaceSvg(withNs), withNs); // regression: the old guard never matched
});

test('assetRefs collects asset hrefs/srcs normalized to assets/', () => {
  const body =
    '<svg><image xlink:href="../assets/urlHash-1.jpg"/><use href="assets/x.png"/></svg>';
  assert.deepEqual(assetRefs(body), ['assets/urlHash-1.jpg', 'assets/x.png']);
  assert.deepEqual(assetRefs('<p>no assets here</p>'), []);
});

// ---- cfc1 swap-loop equivalence with the original regex -----------------------

// Reference: exactly what cfc1 did before the hand-rolled loop.
const refCfc1 = (s) => Buffer.from(s.replace(/(.)(.)(.)(.)/g, '$4$2$3$1'), 'base64').toString('utf8');

test('cfc1 handles 4n and 4n+k lengths like the regex', () => {
  const blob = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // distinct base64 chars
  for (const len of [0, 4, 8, 16, 1, 2, 3, 5, 6, 7, 9, 13, 31]) {
    const s = blob.slice(0, len);
    assert.equal(cfc1(s), refCfc1(s), `length ${len}`);
  }
});

test('cfc1 skips groups containing line terminators, resuming after them', () => {
  // '.': the swap window cannot contain \n \r \u2028 \u2029; the regex engine retries
  // just past the terminator, so alignment shifts rather than staying on 4s.
  assert.equal(
    Buffer.from('AB\nCDEFGH'.replace(/(.)(.)(.)(.)/g, '$4$2$3$1'), 'base64').toString('hex'),
    Buffer.from('AB\nFDECGH', 'base64').toString('hex'), // 'CDEF' -> 'FDEC', then tail 'GH'
  );
  const cases = [
    'ab\ncdefgh',
    'a\nbcdefg',
    '\n\n\n\nABCDEFGH',
    'ABCDEFGH\n\n\n\n',
    'AB\rC\u2028DE\u2029FGH',
    '\u2028abc',
    'abc\u2029',
  ];
  for (const s of cases) assert.equal(cfc1(s), refCfc1(s), JSON.stringify(s));
});

test('cfc1 matches the regex on a deterministic sweep of hostile inputs', () => {
  // Seeded LCG so failures reproduce; alphabet covers base64 chars, all four
  // terminators, and '=' padding at arbitrary offsets. Lengths include 4n and 4n+k.
  let seed = 0x9e3779b9;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000;
  const alphabet = ['A', 'B', 'C', 'D', '=', '\n', '\r', '\u2028', '\u2029'];
  for (let iter = 0; iter < 600; iter++) {
    const len = Math.floor(next() * 64);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(next() * alphabet.length)];
    assert.equal(cfc1(s), refCfc1(s), `iter ${iter}: ${JSON.stringify(s)}`);
  }
});

test('cfc1 falls back to the code-unit path for any code unit > 127', () => {
  // The latin1 byte fast path is only lossless for pure ASCII (all code units
  // <= 127); anything above — including lone surrogates and U+2028/U+2029 — must
  // take the exact code-unit path. Pin the gate by comparing to the regex reference.
  const cases = [
    'QUJD\xe9RA*', // latin1-range char (U+00E9, 233) -> fallback, though latin1-lossless
    'QUJD\u20ac', // U+20AC (8364), above the latin1 range entirely
    'aA=\ud83d\ude00bcdef', // astral char = surrogate pair (both units > 127)
    '\u2028abc\r\nQUJD', // U+2028 is itself above 127 -> fallback, not the byte path
    'ab\x00cd\x7fef', // NUL and 0x7f stay INSIDE the fast path (pure ASCII)
  ];
  for (const s of cases) assert.equal(cfc1(s), refCfc1(s), JSON.stringify(s));
  // and a longer mixed blob so the fallback handles multi-quad content
  const big = Buffer.from('VGVzdCBibG9i', 'base64').toString('latin1') + '\xe9'.repeat(9);
  assert.equal(cfc1(big), refCfc1(big));
});

// ---- obfuscation-drift canaries ------------------------------------------------
// OverDrive changing the __bif_cfc1 permutation must fail LOUDLY at the named
// stage, never as silent garbage pages.

// A drifted cipher: swap chars 1<->2 instead of 1<->4 — what a changed
// permutation looks like from our side.
const driftedEncode = (s) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/(.)(.)(.)(.)/g, '$2$1$4$3');

test('drift: a changed cipher permutation fails loudly, naming the contract', () => {
  const body = '<svg viewBox="0 0 2 2"><rect/></svg>';
  const html = `<html><script>parent.__bif_cfc1(self, '${driftedEncode(body)}');</script></html>`;
  assert.throws(() => decodePage(html), /not markup.*__bif_cfc1 cipher appears to have drifted/is);
});

test('probeCfc1 reports per-stage health on healthy and drifted pages', () => {
  const encode = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.)(.)(.)(.)/g, '$4$2$3$1');

  const healthy = probeCfc1(`<html><script>parent.__bif_cfc1(self, '${encode('<svg/>')}');</script></html>`);
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.stages.map((s) => s.stage), ['cfc1-marker', 'content-shape']);
  assert.ok(healthy.stages.every((s) => s.ok));

  const drifted = probeCfc1(`<html><script>parent.__bif_cfc1(self, '${driftedEncode('<svg/>')}');</script></html>`);
  assert.equal(drifted.ok, false);
  const failed = drifted.stages.find((s) => !s.ok);
  assert.equal(failed.stage, 'content-shape');
  assert.match(failed.detail, /not '/);

  const noMarker = probeCfc1('<html>error page</html>');
  assert.equal(noMarker.ok, false);
  assert.equal(noMarker.stages[0].stage, 'cfc1-marker');
});
