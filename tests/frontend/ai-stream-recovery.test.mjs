import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { beginSafeStreamRecovery } from '../../frontend/js/features/ai-chat/stream-recovery.ts';
import { userFacingStreamError } from '../../frontend/js/features/ai-chat/stream-error-message.ts';

test('stream recovery cancels and aborts exactly once', async () => {
  let cancellations = 0;
  const reader = { async cancel() { cancellations += 1; } };
  const controller = new AbortController();
  const state = { started: false };

  assert.equal(beginSafeStreamRecovery(state, reader, controller), true);
  await Promise.resolve();
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancellations, 1);

  assert.equal(beginSafeStreamRecovery(state, reader, controller), false);
  await Promise.resolve();
  assert.equal(cancellations, 1);
});

test('typed visual errors are not collapsed into the generic retry loop', () => {
  const message = userFacingStreamError({
    error: true,
    code: 'visual_verification_timeout',
    retryable: false,
  });
  assert.match(message, /verification-service issue/i);
  assert.doesNotMatch(message, /question is preserved|please retry/i);
});

test('typed stream error messages contain no common mojibake sequences', () => {
  const messages = [
    userFacingStreamError({ error: true, code: 'visual_evidence_unreadable' }),
    userFacingStreamError({ error: true, code: 'vision_model_unavailable' }),
    userFacingStreamError({ error: true, code: 'stream_interrupted' }),
  ].join('\n');
  assert.doesNotMatch(messages, /Ãƒ.|Ã¢â‚¬|Ã‚./);
});

test('chatbot persists assistant lifecycle and retries the same row', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /completionState: 'processing'/);
  assert.match(shell, /parentUserMessageId/);
  assert.match(shell, /saveChatStore\(\);[\s\S]{0,500}const aiRow/);
  assert.match(shell, /targetMessage: message, targetRow: aiRow/);
  assert.doesNotMatch(shell, /aiRow\.remove\(\);\s*void streamAiReply/);
});

test('chat reload repairs orphaned user turns with recovery cards', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /repairOrphanedAssistantMessages\(chat\)/);
  assert.match(shell, /errorCode: 'orphaned_response'/);
  assert.match(shell, /This response did not complete/);
});
