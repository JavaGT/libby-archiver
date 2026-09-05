import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveILS, sessionKey } from '../src/auth.mjs';

const clientFor = (json) => ({
  requestOk: async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/auth/forms/339');
    return { json };
  },
});

test('uses the auth form identifier when it differs from the catalog key', async () => {
  assert.equal(
    await resolveILS(clientFor({ forms: [{ ilsName: 'midcon' }] }), '339', 'mcpl'),
    'midcon',
  );
});

test('keeps a matching library identifier', async () => {
  assert.equal(
    await resolveILS(clientFor({ forms: [{ ilsName: 'auckland' }] }), '339', 'auckland'),
    'auckland',
  );
});

test('rejects ambiguous auth forms', async () => {
  await assert.rejects(
    resolveILS(clientFor({ forms: [{ ilsName: 'one' }, { ilsName: 'two' }] }), '339', 'unknown'),
    /Could not determine the library card system/,
  );
});

test('session keys separate cards and libraries so a cache never crosses accounts', () => {
  assert.equal(sessionKey({ library: 'MyLib', cardNumber: '12345' }), 'mylib|12345');
  assert.notEqual(
    sessionKey({ library: 'mylib', cardNumber: '12345' }),
    sessionKey({ library: 'mylib', cardNumber: '67890' }),
  );
  assert.notEqual(
    sessionKey({ library: 'lib-a', cardNumber: '12345' }),
    sessionKey({ library: 'lib-b', cardNumber: '12345' }),
  );
});
