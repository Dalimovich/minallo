// Server-side German learner profile for the TS endpoints: the DB profile is
// authoritative; client-supplied levels / exam profile ids never win.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

process.env.SUPABASE_URL = 'https://example.supabase.co';
const mod = await import('../../backend/lib/german-learner-profile.ts');
const { getGermanLearnerProfile, resolveGermanExamProfileId, unsupportedExamProfileMessage } = mod;

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init);
  return () => { globalThis.fetch = original; };
}
const json = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });

test('registry: telc C1 Hochschule resolves, telc B2 is simply null', () => {
  assert.equal(resolveGermanExamProfileId('telc', 'C1 Hochschule'), 'telc_c1_hochschule');
  assert.equal(resolveGermanExamProfileId('telc', 'B2'), null);
  assert.equal(resolveGermanExamProfileId('TestDaF', 'TDN 4'), null);
  assert.equal(resolveGermanExamProfileId(null, null), null);
});

test('registry mirrors the Python exam registry (same ids)', () => {
  const dir = resolve(ROOT, 'backend/python-ai/app/services/german_exams');
  const ids = readdirSync(dir)
    .filter((f) => f.endsWith('.py') && !['__init__.py', 'shared.py', 'registry.py'].includes(f))
    .flatMap((f) => [...readFileSync(resolve(dir, f), 'utf8').matchAll(/^    profile_id="(\w+)",/gm)].map((m) => m[1]));
  assert.ok(ids.length >= 1, 'no exam profile files found');
  const ts = read('backend/lib/german-learner-profile.ts');
  for (const id of ids) assert.ok(ts.includes(`'${id}'`), `TS registry is missing ${id}`);
});

test('getGermanLearnerProfile reads the saved row and derives the exam profile', async () => {
  let requested = '';
  const restore = mockFetch((url) => {
    requested = url;
    return json(200, [{ user_type: 'learner', german_test: 'telc', german_level: 'C1 Hochschule' }]);
  });
  try {
    const p = await getGermanLearnerProfile('service-key', 'user-1');
    assert.deepEqual(p, {
      userType: 'learner', testFamily: 'telc', targetLevel: 'C1 Hochschule', examProfileId: 'telc_c1_hochschule',
    });
    assert.match(requested, /profiles\?id=eq\.user-1&select=user_type,german_test,german_level/);
  } finally { restore(); }
});

test('a stale/contradictory persisted exam-profile column cannot win (id is always derived)', async () => {
  const restore = mockFetch(() => json(200, [{
    user_type: 'learner', german_test: 'telc', german_level: 'B2', german_exam_profile_id: 'telc_c1_hochschule',
  }]));
  try {
    const p = await getGermanLearnerProfile('k', 'u');
    assert.equal(p.examProfileId, null);
  } finally { restore(); }
});

test('an unreadable profile is null (unknown), never an invented level', async () => {
  let restore = mockFetch(() => json(500, { message: 'boom' }));
  try { assert.equal(await getGermanLearnerProfile('k', 'u'), null); } finally { restore(); }
  restore = mockFetch(() => json(200, []));
  try { assert.equal(await getGermanLearnerProfile('k', 'u'), null); } finally { restore(); }
  restore = mockFetch(() => { throw new Error('network'); });
  try { assert.equal(await getGermanLearnerProfile('k', 'u'), null); } finally { restore(); }
});

test('unsupported exam profile copy is neutral product copy', () => {
  const msg = unsupportedExamProfileMessage({ testFamily: 'telc', targetLevel: 'B2' });
  assert.equal(msg, 'Exam-format practice for telc B2 is not available yet.');
});

test('writing-coach endpoint no longer validates the client level', () => {
  const src = read('backend/functions/ai-writing-coach.ts');
  assert.doesNotMatch(src, /ALLOWED_LEVELS/);
  assert.doesNotMatch(src, /fail\(400,\s*'profileLevel is invalid'\)/);
});

test('german-exam generate derives the profile from the server, not body.profileId', () => {
  const src = read('backend/functions/ai-german-exam-generate.ts');
  assert.match(src, /getGermanLearnerProfile\(serviceKey, user\.id\)/);
  assert.match(src, /const profileId = learner\.examProfileId/);
  assert.doesNotMatch(src, /invalid or unsupported profileId/);
  // derivation happens before any paid accounting so an unsupported profile costs nothing
  assert.ok(src.indexOf('getGermanLearnerProfile(serviceKey') < src.indexOf('requireActiveSubscription('));
});
