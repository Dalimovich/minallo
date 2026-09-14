import assert from 'node:assert/strict';
import test from 'node:test';
import { shellRuntime } from '../helpers/chat-stream-runtime.mjs';

test('durable cache recovery restores answer provenance and the original retry snapshot', async () => {
  const provenance = { answerMode: 'course', groundingMode: 'relevance', sourceScope: 'course_files' };
  const snapshot = { sourceMode: 'course_files', courseFileScope: 'specific_files', selectedSourceIds: ['source-a'] };
  const runtime = shellRuntime({
    durableTranscriptHydrations: new Set(),
    authenticatedFetch: async () => ({ ok: true, json: async () => ({ messages: [{
      client_message_id: 'answer', role: 'assistant', content: 'Grounded explanation',
      completion_state: 'complete', answer_provenance: provenance, request_snapshot: snapshot,
      parent_user_message_id: 'question', request_id: 'request',
    }] }) }),
    repairOrphanedAssistantMessages: () => false, repairConversationIntegrity: () => {},
    saveChatStore: () => {}, chatStore: { activeId: 'other-chat' },
  }, ['hydrateDurableTranscript']);
  const chat = { id: 'chat-a', persistedId: 'conversation', messages: [] };
  await runtime.hydrateDurableTranscript(chat, null);
  const restored = chat.messages[0];
  for (const [key, value] of Object.entries(provenance)) assert.equal(restored[key], value);
  assert.equal(restored.requestSnapshot, snapshot);
  assert.equal(restored.parentUserMessageId, 'question');
});
