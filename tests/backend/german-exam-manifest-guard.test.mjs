// Profile-aware edge validation: no flat TELC-era module/part allowlists; structure is
// checked against the learner's exam manifest (authoritative in python-ai).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.AI_SERVICE_URL = 'https://ai.example.test';
process.env.INTERNAL_SECRET = 'secret';

const { resolveGermanExamProfileId, isRegisteredExamProfileId } = await import('../../backend/lib/german-learner-profile.ts');
const { checkExamPart, checkExamModule, fetchExamManifest, clearExamManifestCache } = await import('../../backend/lib/german-exam-manifest.ts');

const GOETHE = {
  schemaVersion: 'german-exam-manifest-v1', profileId: 'goethe_c1', profileVersion: 1, displayName: 'Goethe-Zertifikat C1',
  cefrLevel: 'C1',
  modules: [
    { id: 'reading', label: 'Lesen', parts: ['lesen_1', 'lesen_2', 'lesen_3', 'lesen_4'].map((id) => ({ id, taskType: 'x', implemented: false })) },
    { id: 'listening', label: 'Hören', parts: ['hoeren_1'].map((id) => ({ id, taskType: 'x', implemented: false })) },
  ],
};
const TELC = {
  ...GOETHE, profileId: 'telc_c1_hochschule', displayName: 'telc',
  modules: [{ id: 'language_elements', label: 'Sprachbausteine', parts: [{ id: 'sprachbausteine_1', taskType: 'x', implemented: true }] }],
};

function mockManifests(counter = { n: 0 }, fail = false) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    counter.n += 1;
    if (fail) throw new Error('network');
    const { profileId } = JSON.parse(init.body);
    const body = profileId === 'goethe_c1' ? GOETHE : profileId === 'telc_c1_hochschule' ? TELC : null;
    const status = body ? 200 : 400;
    return { status, ok: status === 200, text: async () => JSON.stringify(body ?? { detail: 'unknown' }), json: async () => body };
  };
  return () => { globalThis.fetch = original; clearExamManifestCache(); };
}

test('goethe_c1 resolves only from Goethe + C1', () => {
  assert.equal(resolveGermanExamProfileId('Goethe', 'C1'), 'goethe_c1');
  assert.equal(resolveGermanExamProfileId('goethe', 'C1'), 'goethe_c1');
  for (const [f, l] of [['Goethe', 'B2'], ['Goethe', 'C2'], ['Goethe', 'B1'], ['telc', 'C1'], ['OESD', 'C1']]) {
    assert.equal(resolveGermanExamProfileId(f, l), null, `${f} ${l}`);
  }
  assert.equal(resolveGermanExamProfileId('telc', 'C1 Hochschule'), 'telc_c1_hochschule');
  assert.equal(isRegisteredExamProfileId('goethe_c1'), true);
  assert.equal(isRegisteredExamProfileId('made_up'), false);
});

test('a Goethe learner cannot request a TELC-only part; parts are profile-scoped', async () => {
  const restore = mockManifests();
  try {
    assert.equal(await checkExamPart('goethe_c1', 'language_elements', 'sprachbausteine_1'), 'unknown');
    assert.equal(await checkExamModule('goethe_c1', 'language_elements'), 'unknown');
    assert.equal(await checkExamPart('goethe_c1', 'reading', 'lesen_4'), 'ok');
    assert.equal(await checkExamPart('goethe_c1', 'listening', 'hv1'), 'unknown');
    // and the reverse: a TELC learner cannot request a Goethe-only part
    assert.equal(await checkExamPart('telc_c1_hochschule', 'language_elements', 'sprachbausteine_1'), 'ok');
    assert.equal(await checkExamPart('telc_c1_hochschule', 'reading', 'lesen_4'), 'unknown');
  } finally { restore(); }
});

test('manifest is cached; an unavailable manifest is unverified (python still validates)', async () => {
  const counter = { n: 0 };
  let restore = mockManifests(counter);
  try {
    await fetchExamManifest('goethe_c1');
    await fetchExamManifest('goethe_c1');
    assert.equal(counter.n, 1);
  } finally { restore(); }
  restore = mockManifests({ n: 0 }, true);
  try {
    assert.equal(await checkExamPart('goethe_c1', 'reading', 'lesen_1'), 'unverified');
  } finally { restore(); }
});

test('no edge function keeps a flat exam module/part allowlist', () => {
  for (const f of ['generate', 'results', 'consume', 'weaknesses', 'grade-writing']) {
    const src = read(`backend/functions/ai-german-exam-${f}.ts`);
    assert.doesNotMatch(src, /VALID_PART_IDS|VALID_MODULES|VALID_PROFILE_IDS/, f);
    assert.doesNotMatch(src, /'sprachbausteine_1'/, f);
  }
});

test('generate checks the part against the profile BEFORE any paid accounting', () => {
  const src = read('backend/functions/ai-german-exam-generate.ts');
  assert.ok(src.indexOf('checkExamPart(') < src.indexOf('requireActiveSubscription('));
  assert.ok(src.indexOf('checkExamPart(') < src.indexOf('enforceGenerationCap('));
  assert.match(src, /const profileId = learner\.examProfileId/);
});

test('manifest endpoint ignores client profileId and resolves from the saved profile', () => {
  const src = read('backend/functions/ai-german-exam-manifest.ts');
  assert.match(src, /getGermanLearnerProfile\(/);
  assert.doesNotMatch(src, /body\.profileId|event\.body/);
});
