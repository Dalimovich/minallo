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

test('regenerate inserts a new stable assistant variant without removing history', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /regeneratedFromMessageId: original\.id/);
  assert.match(shell, /state\.messages\.splice\(insertionIndex, 0, alternative\)/);
  assert.match(shell, /previousIds\.some\(\(id\) => !state\.messages\.some/);
  assert.match(shell, /appendAiBubble\(msgs, alternative\.id, anchorRow \|\| aiRow\)/);
  assert.doesNotMatch(shell, /state\.messages\.pop\(\)/);
});

test('every useful assistant variant uses the shared idempotent PDF action', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /dataset\.assistantActions = 'true'/);
  assert.match(shell, /data-action="download-pdf"/);
  assert.match(shell, /message\.completionState === 'complete'.*message\.completionState === 'interrupted'/s);
  assert.match(shell, /activeAssistantPdfExports\.has\(key\)/);
  assert.match(shell, /learningJourneyPdfText\(message\.learningJourney\)/);
  assert.match(shell, /appendBubbleActions\(row, m\.text, m\)/);
});

test('durable tutor turns persist the assistant placeholder and request snapshot atomically', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /assistantMessageId: context\.assistantMessage\?\.id/);
  assert.match(shell, /requestId: context\.assistantMessage\?\.requestId/);
  assert.match(shell, /requestSnapshot: context\.assistantMessage\?\.requestSnapshot/);
  assert.match(shell, /assistantMessage\.requestId, assistantMessage\s*\n\s*\)/);
});

test('inactivity checks durable request state before abandoning the stream', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /loadDurableRequestState/);
  assert.match(shell, /\/requests\/.*encodeURIComponent\(streamRequestId\)/);
  assert.match(shell, /durableState\?\.status === 'completed'/);
  assert.match(shell, /\['queued', 'running', 'recovering'\]\.includes/);
  assert.match(shell, /request_state_unavailable/);
});

test('Continue preserves partial text and uses the existing logical request', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /failure\.action === 'continue' \? message\.text\.trim\(\) : ''/);
  assert.match(shell, /continuationText, resumeExistingRequest: true/);
  assert.match(shell, /text: continuationBase, completionState: continuationBase \? 'recovering'/);
  assert.doesNotMatch(shell, /aiRow\.remove\(\);\s*void streamAiReply/);
});

test('refresh restores scoped jobs before rendering a generic failure', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /record\.scoped_job_id/);
  assert.match(shell, /\/scoped-jobs\/.*record\.scoped_job_id/s);
  assert.match(shell, /Discovering all Kurzfragen/);
  assert.match(shell, /!message\.requestId && message\.completionState/);
});

test('early scoped job event is saved before a Learning Journey exists', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /evt\.event === 'scope\.job\.created'/);
  assert.match(shell, /assistantMessage\.scopedJobId = evt\.jobId/);
  assert.match(shell, /scope_job_created_event_received/);
});

test('an offline scoped result restores text and Learning Journey', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /else if \(job\.finalText\)/);
  assert.match(shell, /learningJourney: job\.learningJourney/);
  assert.match(shell, /scoped_job_completed_while_offline/);
});

test('scoped restoration suppresses generic request failure state', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /let scopedStateRestored = false/);
  assert.match(shell, /scopedStateRestored = true/);
  assert.match(shell, /else if \(!scopedStateRestored\)/);
});

test('ask-stream body carries the same durable identity as its headers', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /'X-Request-ID': requestId/);
  assert.match(shell, /'X-Idempotency-Key': requestId/);
  assert.match(shell, /clientMessageId: assistantMessage\?\.parentUserMessageId/);
  assert.match(shell, /assistantMessageId: assistantMessage\?\.id/);
  assert.match(shell, /requestId,\s*\n\s*requestSnapshot: assistantMessage\?\.requestSnapshot/);
});

test('non-2xx ask-stream responses preserve typed preflight failures', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /ask_stream_preflight_failed/);
  assert.match(shell, /failureStage: detail\.stage \|\| 'request_preflight'/);
});

test('error references are validated and never truncated to ncb_msg_', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /function durableErrorReference/);
  assert.match(shell, /invalid_error_reference_id/);
  assert.doesNotMatch(shell, /requestId\.slice\(0, 8\)/);
});

test('page-reading recovery reopens the exact saved PDF page before retrying', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /activeDocumentName: pdf\?\.fileName/);
  assert.match(shell, /failure\.action === 'read_current_page'/);
  assert.match(shell, /handleSourceClick\(\{[\s\S]*documentId: message\.requestSnapshot\.activeDocumentId[\s\S]*page: message\.requestSnapshot\.visiblePage/);
});

test('Stop immediately releases foreground ownership and persists a terminal stopped message', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /userStoppedControllers\.add\(controller\)/);
  assert.match(shell, /completionState: 'stopped'/);
  assert.match(shell, /controller\.abort\(\);[\s\S]{0,200}state\.controller = null;[\s\S]{0,200}state\.isSending = false;/);
  assert.match(shell, /setSendBtnMode\(sendBtn, 'send'\);[\s\S]{0,100}saveChatStore\(\)/);
});

test('stopped turns preserve partial output and cannot be restored as running', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /if \(stoppedByUser && !partialText\) partialText = assistantMessage\.text/);
  assert.match(shell, /m\.completionState === 'stopped'/);
  assert.match(shell, /Response stopped\./);
  assert.match(shell, /\['pending', 'processing', 'streaming', 'recovering'\]/);
});

test('aborted streams reject late events and a later request keeps its own state', () => {
  const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
  assert.match(shell, /if \(controller\.signal\.aborted\) throw new DOMException\('Aborted', 'AbortError'\)/);
  assert.match(shell, /if \(state\.controller === controller\)/);
  assert.match(shell, /if \(state\.activeAssistantMessage === assistantMessage\)/);
  assert.match(shell, /requestId: newChatMessageId\(\)/);
});
