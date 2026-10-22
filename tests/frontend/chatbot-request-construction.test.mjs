// QA3-1 / QA3-2 regression tests (2026-10-15).
//
// Root cause (confirmed live against production with the Mechanics 2 test
// course): reconcileChatStoreAccountScope() reloads chatStore.chats with
// freshly-deserialized SavedChat objects but never re-pointed the shell's
// live ConversationState.messages at the new array — see the fix and its
// contract test in auth-storage-contract.test.mjs. The downstream symptom
// was that doSend() kept pushing real user turns into the now-orphaned
// array, so by the time a request reached the transport layer it carried an
// empty or assistant-only history. These tests guard that transport layer
// (ragEligibility, the setBubbleSubtitle badge call) against ever treating
// such a mangled history as a legitimate, sourced answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shellRuntime } from '../helpers/chat-stream-runtime.mjs';

const SHELL_TS = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

function runtime(overrides = {}) {
  return shellRuntime({
    sourceLibrary: { items: [] }, getActivePdfContext: () => null,
    isPdfViewerVisible: () => false, listCourses: () => [],
    resolveRequestCourseId: () => 'course-a', ...overrides,
  }, ['ragEligibility', 'clipboardAttachmentText']);
}

test('an empty message history never resolves to a grounded course-files request', () => {
  const r = runtime();
  const chat = { selectedSourceIds: [], courseFileScope: 'all_course_files',
    sourceMode: 'course_files', courseId: 'course-a' };
  const result = r.ragEligibility([], chat, 'course-a');
  assert.equal(result, null, 'an empty history must never be treated as a real, answerable question');
});

test('a history whose last turn is an orphaned assistant message (no real user question) is rejected', () => {
  // Mirrors the production bug: once the live array is orphaned, the only
  // entries that keep landing in the real chat.messages are the assistant
  // replies pushed by streamAiReply — never the user's actual question.
  const r = runtime();
  const chat = { selectedSourceIds: [], courseFileScope: 'all_course_files',
    sourceMode: 'course_files', courseId: 'course-a' };
  const result = r.ragEligibility(
    [{ role: 'assistant', text: '' }],
    chat, 'course-a',
  );
  assert.equal(result, null, 'a stray assistant-only turn must never be read as the user\'s question');
});

test('a real user question with no course/file scope is rejected, not silently answered generically as if sourced', () => {
  const r = runtime();
  const chat = { selectedSourceIds: [], courseFileScope: 'all_course_files',
    sourceMode: 'auto', courseId: '' };
  const result = r.ragEligibility(
    [{ role: 'user', text: 'Does support A have a moment reaction?' }],
    chat, '',
  );
  assert.equal(result, null, 'with no resolvable course, this must fall through to generic chat, not a fabricated course-files grounding');
});

test('the no-course / no-files short-circuit no longer badge-stamps itself as a sourced course-files answer', () => {
  // Before the fix this branch called setBubbleSubtitle(aiRow, 'course_files')
  // — rendering "Answered using your course files" — even though it never
  // called the backend. Confirmed live: this is exactly the misleading-badge
  // defect from the QA3-1 report.
  const branchStart = SHELL_TS.indexOf("normaliseSourceMode(requestChat.sourceMode) === 'course_files'");
  assert.ok(branchStart >= 0, 'could not locate the no-course/no-files short-circuit branch in streamAiReply');
  const branchEnd = SHELL_TS.indexOf('} else {', branchStart);
  assert.ok(branchEnd > branchStart, 'could not locate the end of the short-circuit branch');
  const body = SHELL_TS.slice(branchStart, branchEnd);

  assert.doesNotMatch(
    body,
    /setBubbleSubtitle\(aiRow, 'course_files'\)/,
    'must not claim the "Answered using your course files" badge for an answer that never reached the backend'
  );
  assert.match(
    body,
    /setBubbleSubtitle\(aiRow, undefined\)/,
    'must hide the source badge instead of showing a false grounding claim'
  );
});

test('the structured-recovery "Try again" action still requires a resolvable parent user message before firing', () => {
  // This guard is what made "Try again" silently do nothing when the real
  // user question never made it into chat.messages (QA3-2): parentIndex < 0
  // and the handler returns without ever calling streamAiReply. The fix is
  // making sure the user message DOES land in chat.messages (see the
  // reconcileChatStoreAccountScope fix) — this test documents the invariant
  // that fix depends on, so a future refactor can't silently drop it.
  const fnStart = SHELL_TS.indexOf('function attachStructuredRecoveryAction(');
  assert.ok(fnStart >= 0, 'attachStructuredRecoveryAction not found');
  const fnEnd = SHELL_TS.indexOf('\nfunction attachErrorRetry', fnStart);
  assert.ok(fnEnd > fnStart, 'could not locate the end of attachStructuredRecoveryAction');
  const body = SHELL_TS.slice(fnStart, fnEnd);

  assert.match(
    body,
    /const parentIndex = chat\.messages\.findIndex\(\(item\) => item\.id === message\.parentUserMessageId\);/,
    'retry must look up the real parent user message by id in chat.messages'
  );
  assert.match(
    body,
    /if \(parentIndex < 0\) return;/,
    'retry must bail out (not silently send a broken request) when the parent user message cannot be found'
  );
});
