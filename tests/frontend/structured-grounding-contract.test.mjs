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

test('replaying a durable-conversation snapshot never reconstructs an empty documents scope', () => {
  // The backend's RetrievalScope model rejects {type:'documents',
  // documentIds:[]} with a 422 ("documents retrieval scope requires
  // documentIds") — a previous turn's groundingResolution can legitimately
  // carry an empty documentIds array (e.g. it resolved to general
  // knowledge), so replaying that snapshot must check length and fall back
  // to {type:'course'} rather than always forcing 'documents'.
  const replaySection = shell.slice(
    shell.indexOf('requestSnapshot: assistantMessage?.requestSnapshot'),
    shell.indexOf('requestSnapshot: assistantMessage?.requestSnapshot') + 1400,
  );
  assert.doesNotMatch(replaySection, /retrievalScope:\s*\{\s*type:\s*'documents',\s*documentIds:\s*assistantMessage\.requestSnapshot\.groundingResolution\.documentIds\s*\}/);
  assert.match(replaySection, /groundingResolution\.documentIds\?\.length/);
  assert.match(replaySection, /\{\s*type:\s*'course'\s*\}/);
});
