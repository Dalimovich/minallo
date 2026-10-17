import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authenticatedFetchWith, resetAuthRefreshForTests } from '../../frontend/js/services/authenticated-fetch.ts';

const legacy = fs.readFileSync('frontend/js/ai.js', 'utf8');

function jwt(exp) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp })}.x`;
}

test.beforeEach(() => resetAuthRefreshForTests());

// ai.js is a classic script (no `type="module"` on its <script> tag), so it
// cannot be `import`ed and executed directly here the way an ES module can —
// it references dozens of undeclared DOM/app globals (pdfFullText, aiMsgs,
// getTime, renderMarkdown, ...) that only exist once the full app has
// booted in a browser. Its fetch call sites are verified two ways instead:
// (1) static assertions that the legacy vision path now routes through
// authenticatedFetch with a 401/ok check ahead of the "No response"
// fallback, and (2) a behavioral test that authenticatedFetchWith — the
// exact function the dynamically-imported module exposes — really does
// refresh-and-retry a safe-to-retry 401 with the same options ai.js passes.

test('ai.js legacy vision path routes /api/ai calls through authenticatedFetch, not raw fetch', () => {
  assert.doesNotMatch(legacy, /fetch\(BACKEND_URL/);
  assert.doesNotMatch(legacy, /Authorization:\s*'Bearer '\s*\+\s*\(window\._sbToken/);
  assert.match(legacy, /_getAuthFetchModule\(\)/);
  assert.match(legacy, /import\('\.\/services\/authenticated-fetch\.js'\)/);
  assert.match(legacy, /mod\.authenticatedFetch\(url, init, \{ safeToRetry: true \}\)/);
});

test('ai.js checks response status before falling through to "No response"', () => {
  const askAiFetch = legacy.slice(legacy.indexOf('let askAI = function'), legacy.indexOf('window._legacyAskAI'));
  assert.match(askAiFetch, /_aiAuthFetch\(BACKEND_URL \+ '\/api\/ai'/);
  assert.match(askAiFetch, /if \(r\.status === 401\)/);
  assert.match(askAiFetch, /sessionErr\.sessionExpired = true/);
  assert.match(askAiFetch, /if \(!r\.ok\)/);
  // The 401/error branches must appear before the json() parse that feeds
  // the "No response" fallback, otherwise a 401 body would still reach it.
  const errorCheckIdx = askAiFetch.indexOf('if (r.status === 401)');
  const jsonParseIdx = askAiFetch.indexOf('return r.json();');
  assert.ok(errorCheckIdx > -1 && jsonParseIdx > -1 && errorCheckIdx < jsonParseIdx);
});

test('ai.js surfaces a distinct session-expired message instead of a generic error', () => {
  assert.match(legacy, /_isSessionExpiredError\(e\)/);
  assert.match(legacy, /Your session has expired\. Please sign in again to continue\./);
});

test('runMultiSummary also routes through authenticatedFetch with the same 401 handling', () => {
  const multiSummaryFetch = legacy.slice(
    legacy.indexOf('async function runMultiSummary'),
    legacy.indexOf('window.runMultiSummary'),
  );
  assert.match(multiSummaryFetch, /_aiAuthFetch\(BACKEND_URL \+ '\/api\/ai'/);
  assert.match(multiSummaryFetch, /if \(r\.status === 401\)/);
});

test('behavioral: a safe-to-retry 401 on /api/ai refreshes once and retries (the exact policy ai.js requests)', async () => {
  // Token looks unexpired (far-future exp) so this exercises the *reactive*
  // 401 path, not the proactive expiry-skew refresh — mirrors the real-world
  // case: server rejects a token the client still believes is valid.
  let calls = 0;
  let refreshes = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('unauthorized', { status: 401 });
    return new Response(JSON.stringify({ content: [{ text: 'hi' }] }), { status: 200 });
  };
  const response = await authenticatedFetchWith(
    {
      getAccessToken: () => jwt(9999999998),
      refreshSession: async () => {
        refreshes++;
        return { accessToken: jwt(9999999999), recoverable: true };
      },
      now: () => 0,
    },
    'https://backend.example/api/ai',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    { safeToRetry: true },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
  const data = await response.json();
  assert.equal(data.content[0].text, 'hi');
});
