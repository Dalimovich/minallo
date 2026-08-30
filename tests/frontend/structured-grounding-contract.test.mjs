import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('viewer context never overwrites retrieval document ids', () => {
  assert.doesNotMatch(shell, /if \(activePdfContext\) \{\s*documentIds = \[activePdfContext\.documentId\]/);
  assert.match(shell, /viewerContext MUST NEVER mutate retrievalScope/);
});

test('structured grounding separates course scope and viewer context', () => {
  assert.match(shell, /retrievalScope:[\s\S]*type: 'course'/);
  assert.match(shell, /viewerContext:[\s\S]*documentId: activePdfContext\.documentId/);
  assert.match(shell, /groundingRequest:\s*\(/);
});

test('request snapshot preserves requested and resolved grounding', () => {
  assert.match(shell, /groundingRequest\?: GroundingRequest/);
  assert.match(shell, /groundingResolution\?: GroundingResolution/);
  assert.match(shell, /groundingResolution: streamed\.meta\?\.groundingResolution/);
});
