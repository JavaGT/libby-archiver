import test from 'node:test';
import assert from 'node:assert/strict';
import { cfc1, decodePage, namespaceSvg, assetRefs } from '../src/read.mjs';

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
