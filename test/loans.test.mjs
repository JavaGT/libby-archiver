import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLoan, audiobookLoans, readableLoans, sync } from '../src/loans.mjs';

test('normalizeLoan keeps unknown types unknown instead of relabeling them ebook', () => {
  const video = normalizeLoan({ id: 1, cardId: 7, title: 'A Film', type: { id: 'video' } });
  assert.equal(video.type, 'video'); // regression: this used to become 'ebook'
  assert.deepEqual(readableLoans([video]), []); // and must not be routed to the read host

  for (const type of ['audiobook', 'ebook', 'magazine']) {
    const loan = normalizeLoan({ id: 2, cardId: 7, title: 'T', type: { id: type } });
    assert.equal(loan.type, type);
  }
});

test('normalizeLoan picks the largest cover and stringifies ids', () => {
  const loan = normalizeLoan({
    id: 42,
    cardId: 9,
    title: 'Dune',
    firstCreatorName: 'Frank Herbert',
    expires: '2026-10-01',
    covers: {
      cover150Wide: { href: 'https://x/150.jpg' },
      cover510Wide: { href: 'https://x/510.jpg' },
    },
  });
  assert.equal(loan.id, '42');
  assert.equal(loan.cardId, '9');
  assert.equal(loan.coverUrl, 'https://x/510.jpg');
  assert.equal(loan.author, 'Frank Herbert');

  const bare = normalizeLoan({ id: 3, cardId: 1, title: 'No covers' });
  assert.equal(bare.coverUrl, undefined);
  assert.equal(bare.type, 'unknown');
});

test('loan filters partition by type', () => {
  const loans = [
    { type: 'audiobook' },
    { type: 'ebook' },
    { type: 'magazine' },
    { type: 'video' },
  ];
  assert.equal(audiobookLoans(loans).length, 1);
  assert.deepEqual(readableLoans(loans).map((l) => l.type), ['ebook', 'magazine']);
});

// #12: authenticate no longer pre-fetches /chip/sync, so sync() always fetches —
// exactly once — and normalizes whatever the server returns.
test('sync() fetches /chip/sync exactly once and normalizes the payload', async () => {
  const payload = {
    result: 'synchronized',
    cards: [{ id: 7 }],
    loans: [{ id: 9, cardId: 7, title: 'Fetched', type: { id: 'audiobook' } }],
  };
  let fetches = 0;
  const r = await sync({
    requestOk: async (method, reqPath) => {
      fetches++;
      assert.equal(method, 'GET');
      assert.equal(reqPath, '/chip/sync');
      return { json: payload };
    },
  }, 'identity');
  assert.equal(fetches, 1, 'exactly one fetch per sync() call');
  assert.deepEqual(r, {
    cards: payload.cards,
    loans: [r.loans[0]],
    raw: payload,
  });
  assert.equal(r.loans[0].title, 'Fetched');
});
