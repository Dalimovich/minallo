import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const statusSource = await readFile(
  new URL('../../frontend/js/features/ai-chat/ai-thinking-status.ts', import.meta.url),
  'utf8',
);
const askSource = await readFile(
  new URL('../../frontend/js/features/ai-chat/ai-ask.ts', import.meta.url),
  'utf8',
);

test('document-wide extraction progress events have user-facing text', () => {
  assert.match(statusSource, /scanning_document:\s*[\r\n\s]*"I'm scanning every page/);
  assert.match(statusSource, /extracting_items:\s*[\r\n\s]*"I'm extracting the questions/);
  assert.match(statusSource, /checking_completeness:\s*[\r\n\s]*"I'm checking the full document/);
});

test('long extraction answers retain ordinary copy and export finalization', () => {
  assert.match(askSource, /function finalize\(/);
  assert.match(askSource, /bindMessageActionButtons/);
  assert.match(askSource, /window\._aiResponseActions/);
  assert.doesNotMatch(askSource, /wrong_output_language[^]*fallbackToRag/);
});
