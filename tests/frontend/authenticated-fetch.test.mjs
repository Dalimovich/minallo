import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticatedFetchWith,
  authenticatedSupabaseFetch,
  resetAuthRefreshForTests,
} from '../../frontend/js/services/authenticated-fetch.ts';

function jwt(exp) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp })}.x`;
}

test.beforeEach(() => resetAuthRefreshForTests());

test('refreshes before sending an expiring token', async () => {
  let token = jwt(1);
  let refreshes = 0;
  const sent = [];
  globalThis.fetch = async (_input, init) => {
    sent.push(new Headers(init.headers).get('Authorization'));
    return new Response('ok');
  };
  await authenticatedFetchWith({
    getAccessToken: () => token,
    refreshSession: async () => {
      refreshes++;
      token = jwt(9999999999);
      return { accessToken: token, recoverable: true };
    },
    now: () => 10_000,
  }, '/ask', { method: 'POST' });
  assert.equal(refreshes, 1);
  assert.deepEqual(sent, [`Bearer ${token}`]);
});

test('coalesces simultaneous refreshes', async () => {
  let token = jwt(1);
  let refreshes = 0;
  globalThis.fetch = async () => new Response('ok');
  const deps = {
    getAccessToken: () => token,
    refreshSession: async () => {
      refreshes++;
      await Promise.resolve();
      token = jwt(9999999999);
      return { accessToken: token, recoverable: true };
    },
    now: () => 10_000,
  };
  await Promise.all([
    authenticatedFetchWith(deps, '/one'),
    authenticatedFetchWith(deps, '/two'),
  ]);
  assert.equal(refreshes, 1);
});

test('retries a safe 401 once and never loops', async () => {
  let calls = 0;
  let refreshes = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('unauthorized', { status: 401 });
  };
  const response = await authenticatedFetchWith({
    getAccessToken: () => jwt(9999999998),
    refreshSession: async () => {
      refreshes++;
      return { accessToken: jwt(9999999999), recoverable: true };
    },
    now: () => 0,
  }, '/stream', { method: 'POST' }, { safeToRetry: true });
  assert.equal(response.status, 401);
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});

test('extraHeaders are merged in alongside the Authorization header', async () => {
  const sent = [];
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init.headers);
    sent.push({ apikey: headers.get('apikey'), authorization: headers.get('Authorization') });
    return new Response('ok');
  };
  await authenticatedFetchWith({
    getAccessToken: () => jwt(9999999999),
    refreshSession: async () => ({ accessToken: jwt(9999999999), recoverable: true }),
    now: () => 0,
  }, '/rest/v1/some_table', { method: 'GET' }, { extraHeaders: { apikey: 'anon-key-123' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].apikey, 'anon-key-123');
  assert.match(sent[0].authorization, /^Bearer /);
});

test('authenticatedSupabaseFetch attaches apikey from window._SAKEY on top of a fresh token', async () => {
  const originalWindow = globalThis.window;
  const token = jwt(9999999999);
  globalThis.window = { _sbToken: token, _SAKEY: 'anon-key-456' };
  const sent = [];
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init.headers);
    sent.push({ apikey: headers.get('apikey'), authorization: headers.get('Authorization') });
    return new Response('[]');
  };
  try {
    resetAuthRefreshForTests();
    const response = await authenticatedSupabaseFetch(
      'https://example.supabase.co/rest/v1/course_progress?limit=1',
      { method: 'GET' },
      { safeToRetry: true },
    );
    assert.equal(response.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].apikey, 'anon-key-456');
    assert.equal(sent[0].authorization, `Bearer ${token}`);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('does not retry 403 or unsafe POST requests', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    let refreshes = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('no', { status });
    };
    await authenticatedFetchWith({
      getAccessToken: () => jwt(9999999999),
      refreshSession: async () => {
        refreshes++;
        return { accessToken: jwt(9999999999), recoverable: true };
      },
      now: () => 0,
    }, '/mutation', { method: 'POST' });
    assert.equal(calls, 1);
    assert.equal(refreshes, 0);
  }
});
