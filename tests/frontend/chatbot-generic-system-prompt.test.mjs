import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('the generic /chat system prompt no longer forces a fixed reply language', () => {
  assert.doesNotMatch(shell, /Always reply in ['"]?\s*\+?\s*lang/);
  assert.match(shell, /Reply in the language of the user/);
  assert.match(shell, /latest message/);
  assert.match(shell, /only default to ['"]?\s*\+\s*lang/);
});
