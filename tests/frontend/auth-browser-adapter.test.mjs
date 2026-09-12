import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedFetch, resetAuthRefreshForTests } from '../../frontend/js/services/authenticated-fetch.ts';

const jwt = exp => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;
test.beforeEach(() => resetAuthRefreshForTests());

test('server rejection of an unexpired JWT forces real browser refresh and uses the replacement', async () => {
  const old = jwt(9999999999), fresh = jwt(9999999998);
  let refreshes = 0;
  const sent = [];
  globalThis.window = { _sbToken: old, _sb: { auth: { refreshSession: async () => {
    refreshes++; window._sbToken = fresh;
  } } } };
  globalThis.fetch = async (_input, init) => {
    const authorization = new Headers(init.headers).get('Authorization');
    sent.push(authorization);
    return new Response('result', { status: authorization === `Bearer ${fresh}` ? 200 : 401 });
  };
  const response = await authenticatedFetch('/api/study');
  assert.equal(response.status, 200);
  assert.equal(refreshes, 1);
  assert.deepEqual(sent, [`Bearer ${old}`, `Bearer ${fresh}`]);
});

test('five rejected-token requests with delayed 401s share one real refresh', async () => {
  const old = jwt(9999999999), fresh = jwt(9999999998);
  let refreshes = 0, count = 0;
  globalThis.window = { _sbToken: old, _sb: { auth: { refreshSession: async () => {
    refreshes++; window._sbToken = fresh;
  } } } };
  globalThis.fetch = async (_input, init) => {
    const rejected = new Headers(init.headers).get('Authorization') === `Bearer ${old}`;
    if (rejected) await new Promise(resolve => setTimeout(resolve, ++count * 5));
    return new Response('', { status: rejected ? 401 : 200 });
  };
  const responses = await Promise.all(Array.from({ length: 5 }, () => authenticatedFetch('/api/study')));
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200, 200, 200]);
  assert.equal(refreshes, 1);
});

test('revoked refresh surfaces a session error and never retries without authentication', async () => {
  let calls = 0;
  globalThis.window = { _sbToken: jwt(9999999999), _sb: { auth: { refreshSession: async () => {
    window._sbToken = null;
  } } } };
  globalThis.fetch = async () => { calls++; return new Response('', { status: 401 }); };
  await assert.rejects(authenticatedFetch('/api/study'), /SESSION_INVALID/);
  assert.equal(calls, 1);
});
