import assert from 'node:assert/strict';
import test from 'node:test';
import { shellRuntime } from '../../tests/helpers/chat-stream-runtime.mjs';

async function resume({ requiredPage = false } = {}) {
  const user = { id: 'u', role: 'user', text: requiredPage ? 'Read this page' : 'Search the Internet for torque examples' };
  const grounding = { retrievalScope: { type: 'course' }, viewerContext: { documentId: 'incidental-pdf', visiblePage: 2 },
    ...(requiredPage ? { documentAccess: { requested: 'visible_page' } } : {}) };
  const assistant = { id: 'a', role: 'assistant', text: '', requestId: 'r', requestSnapshot: {
    userText: user.text, sourceMode: requiredPage ? 'course_files' : 'internet',
    courseFileScope: 'all_course_files', selectedSourceIds: [], courseId: 'course-a',
    activeDocumentId: 'incidental-pdf', groundingRequest: grounding,
  } };
  const chat = { id: 'chat', messages: [user, assistant], selectedSourceIds: [], courseId: 'course-a' };
  const row = { dataset: {}, querySelector: () => null, isConnected: true };
  let reachedDurableBoundary = false;
  const noop = () => {};
  const r = shellRuntime({
    chatStore: { getActive: () => chat, activeId: 'chat' },
    setSendBtnMode: noop, saveChatStore: noop, setBubbleSubtitle: noop,
    createAIThinkingStatus: () => ({ remove: noop }),
    chatbotThinkingContext: noop, chatbotInitialStatus: noop,
    inFlightReplyRows: new Map(), latestUserAllowsDiagrams: () => false,
    latestUserFileLabel: () => '', getActivePdfContext: () => null,
    ensureDurableConversation: async () => {
      reachedDurableBoundary = true;
      // Stop at the independent persistence boundary: this test verifies the
      // production orchestration gate, not HTTP, rendering or model output.
      throw Object.assign(new Error('Synthetic test boundary'), { code: 'audit_boundary_reached' });
    },
    userStoppedControllers: new Set(),
    classifyAiError: e => ({ code: e.code, stage: 'document_access', retryable: true, action: 'retry' }),
    scrollMsgsToBottom: noop,
  }, ['streamAiReply', 'ragEligibility', 'clipboardAttachmentText']);
  await r.streamAiReply({ messages: chat.messages }, {}, {}, {
    targetMessage: assistant, targetRow: row, requestMessages: [user], resumeExistingRequest: true,
  });
  return { reachedDurableBoundary, errorCode: assistant.errorCode };
}

test('Internet retry proceeds after its incidental PDF is closed', async () => {
  const result = await resume();
  assert.equal(result.reachedDurableBoundary, true, `Retry blocked: ${result.errorCode}`);
});

test('required visible-page retry remains blocked when its PDF is closed', async () => {
  const result = await resume({ requiredPage: true });
  assert.equal(result.reachedDurableBoundary, false);
  assert.equal(result.errorCode, 'original_pdf_context_unavailable');
});
