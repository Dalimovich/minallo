import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shellRuntime, streamResponse, ask } from '../helpers/chat-stream-runtime.mjs';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('viewer context never overwrites retrieval document ids', () => {
  assert.doesNotMatch(shell, /if \(activePdfContext\) \{\s*documentIds = \[activePdfContext\.documentId\]/);
  assert.match(shell, /viewerContext MUST NEVER mutate retrievalScope/);
});

test('structured grounding separates course scope and viewer context', () => {
  assert.match(shell, /retrievalScope:[\s\S]*type: 'course'/);
  assert.match(shell, /viewerContext:[\s\S]*documentId: activePdfContext\.documentId/);
  assert.match(shell, /groundingRequest: effectiveGroundingRequest/);
});

test('request snapshot preserves requested and resolved grounding', () => {
  assert.match(shell, /groundingRequest\?: GroundingRequest/);
  assert.match(shell, /groundingResolution\?: GroundingResolution/);
  assert.match(shell, /groundingResolution: streamed\.meta\?\.groundingResolution/);
});

test('empty previous resolution never broadens the original document-only request on replay', async () => {
  let payload;
  const runtime = shellRuntime({ authenticatedFetch: async (_url, init) => {
    payload = JSON.parse(init.body);
    return streamResponse([{ t: 'Answer' }, { done: true }]);
  } });
  const groundingRequest = { retrievalScope: { type: 'documents', documentIds: ['doc-a'] } };
  await ask(runtime, { durable: true, message: { id: 'assistant', requestSnapshot: {
    sourceMode: 'course_files', courseFileScope: 'specific_files', groundingRequest,
    groundingResolution: { documentIds: [] },
  } } });
  assert.deepEqual(payload.groundingRequest, groundingRequest);
});
