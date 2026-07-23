import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const askSource = await readFile(
  new URL('../../frontend/js/features/ai-chat/ai-ask.ts', import.meta.url),
  'utf8',
);
const regionSource = await readFile(
  new URL('../../frontend/js/features/ai-chat/region-provenance.ts', import.meta.url),
  'utf8',
);

test('PDF text selections send stable normalized region provenance', () => {
  assert.match(askSource, /regionFromSelection/);
  assert.match(askSource, /selectedRegion:\s*_selectedRegion/);
  assert.match(regionSource, /\.pdf-page-wrap/);
  assert.match(regionSource, /documentRevision/);
  assert.match(regionSource, /nearbyQuestionLabel/);
  assert.match(regionSource, /cropHash/);
});

test('each request sends a conversation generation and stale finalizers are ignored', () => {
  assert.match(askSource, /conversationGeneration:\s*myGenId/);
  assert.match(askSource, /myGenId !== state\.currentGenId/);
  assert.match(askSource, /window\._abortCurrentStream\(\)/);
});
