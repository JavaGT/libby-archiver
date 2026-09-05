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
