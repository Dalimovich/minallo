import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePersistedChats } from '../../frontend/js/features/chatbot-new/chat-store-format.ts';

// Regression coverage for the storage-shape bug: shell.ts's compactChatsForStorage
// writes `ss_ncb_chats_v1` as a bare array, but a prior reader assumed
// `{ chats: [...] }` and therefore always saw zero bookmarks. This test exercises
// the actual parser against the actual payload shape shell.ts produces, instead
// of regex-matching source text.

test('parses the real ss_ncb_chats_v1 payload — a bare array — and returns its saved replies', () => {
  const raw = JSON.stringify([
    {
      id: 'chat-1',
      title: 'Thermodynamics',
      savedReplies: [
        { id: 'r1', text: 'Answer', createdAt: 1000, courseId: 'tm2', chatId: 'chat-1' },
      ],
    },
    {
      id: 'chat-2',
      title: 'General chat',
      savedReplies: [],
    },
  ]);

  const chats = parsePersistedChats(raw);
  assert.equal(chats.length, 2);
  assert.equal(chats[0]?.id, 'chat-1');
  assert.equal(chats[0]?.savedReplies?.[0]?.id, 'r1');
  assert.equal(chats[0]?.savedReplies?.[0]?.text, 'Answer');
});

test('still accepts a { chats: [...] } wrapper as defensive back-compat', () => {
  const raw = JSON.stringify({ chats: [{ id: 'chat-1', savedReplies: [{ id: 'r1', text: 'Answer' }] }] });
  const chats = parsePersistedChats(raw);
  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.savedReplies?.[0]?.id, 'r1');
});

test('returns an empty list for missing, empty, or corrupt storage instead of throwing', () => {
  assert.deepEqual(parsePersistedChats(null), []);
  assert.deepEqual(parsePersistedChats(undefined), []);
  assert.deepEqual(parsePersistedChats(''), []);
  assert.deepEqual(parsePersistedChats('{not json'), []);
  assert.deepEqual(parsePersistedChats('"just a string"'), []);
});

test('ignores chats with no savedReplies array', () => {
  const raw = JSON.stringify([{ id: 'chat-1' }]);
  const chats = parsePersistedChats(raw);
  assert.equal(chats.length, 1);
  assert.deepEqual(chats[0]?.savedReplies, undefined);
});
