// An exam part that is in the profile's structure but not generatable yet (every DSH part today) must be
// rejected by the generate endpoint BEFORE any paid-usage accounting (subscription gate, generation cap,
// rate limit) and before python-ai is asked to generate anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.AI_SERVICE_URL = 'https://ai.example.test';
process.env.INTERNAL_SECRET = 'secret';

const { checkExamPart, checkExamPartAvailability, clearExamManifestCache } = await import('../../backend/lib/german-exam-manifest.ts');
const MANIFESTS = JSON.parse(readFileSync(resolve(ROOT, 'tests/e2e/fixtures/german-exam-manifests.json'), 'utf8'));

function mockManifests(fail = false) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    if (fail) throw new Error('network');
    const body = MANIFESTS[JSON.parse(init.body).profileId] ?? null;
    return { status: body ? 200 : 400, ok: !!body, text: async () => JSON.stringify(body), json: async () => body };
  };
  return () => { globalThis.fetch = original; clearExamManifestCache(); };
}

test('every DSH part is unavailable; telc parts are available; unknown parts never block', async () => {
  const restore = mockManifests();
  try {
    for (const [module, part] of [['listening', 'hv_1'], ['reading', 'lv_1'], ['scientific_structures', 'ws_1'], ['writing', 'tp_1'], ['speaking', 'sprechen_1']]) {
      assert.equal(await checkExamPartAvailability('dsh', module, part), 'unavailable', `${module}/${part}`);
      assert.equal(await checkExamPart('dsh', module, part), 'ok'); // the existing structure check is unchanged
    }
    assert.equal(await checkExamPartAvailability('telc_c1_hochschule', 'language_elements', 'sprachbausteine_1'), 'available');
    assert.equal(await checkExamPartAvailability('dsh', 'language_elements', 'sprachbausteine_1'), 'unverified'); // not a DSH part: the structure check answers that
    assert.equal(await checkExamPart('dsh', 'language_elements', 'sprachbausteine_1'), 'unknown');
  } finally { restore(); }
});

test('an unreachable manifest never blocks (python-ai still validates before any model cost)', async () => {
  const restore = mockManifests(true);
  try {
    assert.equal(await checkExamPartAvailability('dsh', 'reading', 'lv_1'), 'unverified');
  } finally { restore(); }
});

test('the generate endpoint rejects an unavailable part before subscription, cap and rate-limit accounting', () => {
  const src = readFileSync(resolve(ROOT, 'backend/functions/ai-german-exam-generate.ts'), 'utf8');
  const gate = src.indexOf('checkExamPartAvailability(profileId');
  assert.ok(gate > 0, 'availability gate missing');
  for (const accounting of ['requireActiveSubscription(serviceKey', 'enforceGenerationCap(serviceKey', 'enforceEventRateLimit(', "forwardToPython<GenerateResponseBody>('german-exam/generate'"]) {
    const at = src.indexOf(accounting);
    if (at !== -1) assert.ok(gate < at, `${accounting} runs before the availability gate`);
  }
});
