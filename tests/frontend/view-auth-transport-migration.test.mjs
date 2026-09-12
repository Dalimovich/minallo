import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authenticatedFetchWith, resetAuthRefreshForTests } from '../../frontend/js/services/authenticated-fetch.ts';

const practice = fs.readFileSync('frontend/views/practice/practice.js', 'utf8');
const examforge = fs.readFileSync('frontend/views/examforge/examforge.js', 'utf8');
const flashcards = fs.readFileSync('frontend/views/flashcards/flashcards.js', 'utf8');

function jwt(exp) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp })}.x`;
}

test.beforeEach(() => resetAuthRefreshForTests());

// practice.js, examforge.js and flashcards.js are classic-script IIFEs (no
// type="module" on their <script> tags in loader.ts) that read
// window._sbToken directly and call raw fetch() — a point-in-time token
// snapshot with no refresh-on-401 and no single-flight coordination, unlike
// authenticated-fetch.ts's authenticatedFetch/authenticatedSupabaseFetch
// (already used by workspace-library.ts and study-tool-workflow.ts for the
// same exam_sessions/flashcard_decks tables). None of these three files can
// be `import`ed and executed directly in this Node test environment — they
// depend on dozens of undeclared DOM/app globals that only exist once the
// full app has booted in a browser (matching the existing static-assertion
// pattern used for these same files in examforge-inline.test.mjs). Each
// file's fetch call sites are verified statically here, and the shared
// transport's actual refresh-and-retry behavior is verified behaviorally
// against the exact call shape (safeToRetry: true) these files now use.

for (const [name, src] of [
  ['practice.js', practice],
  ['examforge.js', examforge],
  ['flashcards.js', flashcards],
]) {
  test(`${name} no longer builds a raw Authorization header or calls fetch() directly against Supabase/backend endpoints`, () => {
    assert.doesNotMatch(src, /fetch\(BACKEND_URL/);
    assert.doesNotMatch(src, /fetch\(_supaUrl\(\)/);
    assert.doesNotMatch(src, /fetch\(_backendUrl\(\)/);
    assert.doesNotMatch(src, /headers:\s*Object\.assign\(\{\},\s*_supaHeaders\(\)/);
    assert.doesNotMatch(src, /headers:\s*\{\s*Authorization:\s*'Bearer '\s*\+\s*token/);
  });

  test(`${name} reaches authenticated-fetch.ts via dynamic import() (classic script, no static import)`, () => {
    assert.match(src, /import\(['"]\/js\/services\/authenticated-fetch\.js['"]\)/);
  });
}

test('practice.js routes flashcard/quiz persistence and AI generation through the auth-aware transport with safeToRetry', () => {
  assert.match(practice, /mod\.authenticatedSupabaseFetch\(url, init, \{ safeToRetry: true \}\)/);
  assert.match(practice, /mod\.authenticatedFetch\(url, init, \{ safeToRetry: true \}\)/);
  assert.match(practice, /_authSupaFetch\(_supaUrl\(\) \+ '\/rest\/v1\/quiz_runs'/);
  assert.match(practice, /_authSupaFetch\(_supaUrl\(\) \+ '\/rest\/v1\/flashcard_decks'/);
  assert.match(practice, /_authFetch\(BACKEND_URL \+ '\/api\/documents\/list/);
  assert.match(practice, /_authFetch\(BACKEND_URL \+ '\/api\/ai\/generate'/);
  assert.match(practice, /_authFetch\(BACKEND_URL \+ '\/api\/ai'/);
});

test('examforge.js routes exam_sessions delete/list through authenticatedSupabaseFetch', () => {
  assert.match(examforge, /mod\.authenticatedSupabaseFetch\(url, init, \{ safeToRetry: true \}\)/);
  assert.match(examforge, /_authSupaFetch\(url, \{\s*method: 'DELETE'/);
  assert.match(examforge, /_authSupaFetch\(_supaUrl\(\) \+ '\/rest\/v1\/exam_sessions\?course_id=eq\./);
});

test('flashcards.js routes flashcard_decks CRUD and flashcard-review through the auth-aware transport', () => {
  assert.match(flashcards, /mod\.authenticatedSupabaseFetch\(url, init, \{ safeToRetry: true \}\)/);
  assert.match(flashcards, /mod\.authenticatedFetch\(url, init, \{ safeToRetry: true \}\)/);
  assert.match(flashcards, /_authSupaFetch\(url, \{\}\)/); // _dbLoadDecks
  assert.match(flashcards, /_authSupaFetch\(_supaUrl\(\) \+ '\/rest\/v1\/flashcard_decks', \{/); // _dbSaveDeck
  assert.match(flashcards, /_authFetch\(_backendUrl\(\) \+ '\/api\/study\/flashcard-review/);
  assert.match(flashcards, /_authFetch\(BACKEND_URL \+ '\/api\/documents\/list/);
});

test('behavioral: a safe-to-retry 401 on a PostgREST call (flashcard_decks/exam_sessions/quiz_runs shape) refreshes once and retries', async () => {
  let calls = 0;
  let refreshes = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('unauthorized', { status: 401 });
    return new Response('[]', { status: 200 });
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
    'https://project.supabase.co/rest/v1/flashcard_decks?course_id=eq.abc',
    { method: 'GET' },
    { safeToRetry: true, extraHeaders: { apikey: 'anon-key' } },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});

test('behavioral: a safe-to-retry 401 on a first-party /api/study/flashcard-review POST also refreshes once and retries', async () => {
  let calls = 0;
  let refreshes = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('unauthorized', { status: 401 });
    return new Response(JSON.stringify({ review: { card_index: 0 } }), { status: 200 });
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
    'https://backend.example/api/study/flashcard-review',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    { safeToRetry: true },
  );
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
  const data = await response.json();
  assert.equal(data.review.card_index, 0);
});
