// Release-readiness audit (2026-10-14), Section 3: behaviorally execute the
// REAL refreshSession() body (not a structural regex) to prove both halves
// of the account-change fix: (a) a refresh that resolves to a DIFFERENT user
// than this tab last knew about wipes the old account's local state before
// adopting the new identity, and (b) an ORDINARY same-user refresh does NOT
// pay that cost — active work (open course/PDF/chat state) must survive it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function extractRefreshSession() {
  const src = fs.readFileSync(new URL('../../frontend/js/supabase.js', import.meta.url), 'utf8');
  const start = src.indexOf('refreshSession: function ()');
  const end = src.indexOf('restoreSession: function ()');
  assert.ok(start >= 0 && end > start, 'refreshSession: function () not found in supabase.js');
  let body = src.slice(start, end);
  body = body.replace(/^refreshSession: function \(\)/, 'function refreshSession()');
  // Drop the trailing property-separator comma (and any trailing whitespace)
  // left over from slicing an object-literal method out of its literal.
  body = body.replace(/,\s*$/, '');
  return body;
}

function makeContext({ storedRefreshToken, fetchImpl }) {
  const store = {};
  const context = {
    console,
    JSON,
    Date,
    Promise,
    SUPA_URL: 'https://example.invalid',
    fetch: fetchImpl,
    window: {},
    localStorage: {
      setItem: (k, v) => { store[k] = String(v); },
      getItem: (k) => (k in store ? store[k] : null),
      removeItem: (k) => { delete store[k]; },
    },
    _sbRefreshInFlight: null,
    _sbHeaders: () => ({ apikey: 'anon' }),
    _sbStoredRefresh: () => storedRefreshToken,
    _sbStoreSession: () => {},
    _sbClearStoredSession: () => {},
    _ssAuth: () => {},
    _sbAuthCallbacks: [],
    _sbToken: 'old-token',
    _currentUser: null,
    _sbClearAccountScopedState: null, // set per-test as a spy
  };
  vm.createContext(context);
  vm.runInContext(extractRefreshSession(), context);
  return context;
}

test('refreshSession wipes account-scoped state when the refreshed user id differs from the known one', async () => {
  let wipeCalls = 0;
  const context = makeContext({
    storedRefreshToken: 'refresh-token-for-account-b',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        access_token: 'token-b',
        refresh_token: 'refresh-b-2',
        user: { id: 'user-B' },
      }),
    }),
  });
  context._sbClearAccountScopedState = () => { wipeCalls += 1; };
  context._currentUser = { id: 'user-A' }; // this tab last knew about account A

  const result = await context.refreshSession();

  assert.equal(wipeCalls, 1, 'a different-user refresh must wipe the old account-scoped state exactly once');
  assert.equal(result.id, 'user-B');
  assert.equal(context._currentUser.id, 'user-B');
});

test('an ordinary same-user refresh does NOT wipe account-scoped state (active work survives)', async () => {
  let wipeCalls = 0;
  const context = makeContext({
    storedRefreshToken: 'refresh-token-for-account-a',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        access_token: 'token-a-2',
        refresh_token: 'refresh-a-3',
        user: { id: 'user-A' },
      }),
    }),
  });
  context._sbClearAccountScopedState = () => { wipeCalls += 1; };
  context._currentUser = { id: 'user-A' };
  // Simulate "active work" the wipe would otherwise destroy.
  context.window.activeCourseId = 'uc_active_course';
  context.localStorage.setItem('minallo:chatbot-recent-course', JSON.stringify({ id: 'uc_active_course' }));

  const result = await context.refreshSession();

  assert.equal(wipeCalls, 0, 'a same-user refresh must not pay the account-wipe cost on every refresh cycle');
  assert.equal(result.id, 'user-A');
  // Active work untouched by this refresh.
  assert.equal(context.window.activeCourseId, 'uc_active_course');
  assert.equal(context.localStorage.getItem('minallo:chatbot-recent-course'), JSON.stringify({ id: 'uc_active_course' }));
});

test('the very first refresh of a session (no _currentUser known yet) does not wipe anything', async () => {
  // _currentUser is null before the first successful auth of this tab —
  // there is no "old account" to wipe yet; must not misfire on boot.
  let wipeCalls = 0;
  const context = makeContext({
    storedRefreshToken: 'refresh-token',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ access_token: 'token', refresh_token: 'refresh-2', user: { id: 'user-A' } }),
    }),
  });
  context._sbClearAccountScopedState = () => { wipeCalls += 1; };
  context._currentUser = null;

  await context.refreshSession();

  assert.equal(wipeCalls, 0);
});
