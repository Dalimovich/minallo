// QA3-1 regression test (2026-10-16).
//
// Codex's independent review of ce312b88 found that the 5 existing QA3-1
// tests (chatbot-request-construction.test.mjs, auth-storage-contract.test.mjs)
// all assert against shell.ts's SOURCE TEXT (regex over the file contents).
// A mutation test proved none of them actually exercise the bug: reverting
// the fix's in-place liveState reset back to the original `liveState = null`
// left all of them passing.
//
// This test instead executes the REAL loadChatStore() and getOrInitLiveState()
// from shell.ts (via the shellRuntime AST-extraction helper already used by
// chat-stream-runtime.mjs) and asserts on run-time object identity and message
// flow, not source text. It is designed to fail under the exact reverted
// behavior Codex used in its mutation test — see the manual verification
// note at the bottom of this file for how that was confirmed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellRuntime } from '../helpers/chat-stream-runtime.mjs';

// All of this is real shell.ts source, pulled out by name via the TS AST
// (see chat-stream-runtime.mjs) — not reimplemented here.
const EXTRA_NAMES = [
  'ncbCurrentUid', 'ncbScopedKey',
  'NCB_STORE_KEY_BASE', 'NCB_ACTIVE_KEY_BASE', 'NCB_SOURCES_KEY_BASE',
  'NCB_MAX_STORED_CHATS', 'NCB_MAX_STORED_MESSAGE_CHARS', 'NCB_MAX_SOURCE_ITEMS',
  'NCB_MAX_SOURCE_DOCS_PER_ITEM', 'NCB_MAX_SOURCE_DOC_CHARS', 'NCB_RECENT_COURSE_KEY',
  'sourceLibrary', 'liveState', 'chatStore', 'getOrInitLiveState',
  'truncateForStorage', 'compactMessageForStorage', 'compactChatForStorage',
  'chatHasUnresolvedSavedReplyMutation', 'compactChatsForStorage', 'compactSourcesForStorage',
  'selectedSourceIdsFromChats', '_ncbLoadedUid', 'repairConversationIntegrity',
  'newChatMessageId', 'currentVisibleCourseId', 'recentStudyPanelCourseId',
  'loadChatStore',
];

// Top-level `const`/`let` bindings (chatStore, sourceLibrary, liveState) never
// become properties of the vm sandbox object, only `function` declarations
// do — so the only way to hand them back to the test is a real function call
// that returns them. getOrInitLiveState() already does this for liveState;
// these two one-line accessors do the same for the other two.
const EXPOSE_STATE = `
function __qa31_chatStore() { return chatStore; }
function __qa31_sourceLibrary() { return sourceLibrary; }
`;

function fakeLocalStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function runtime() {
  return shellRuntime({
    localStorage: fakeLocalStorage(),
    parsePersistedChats: (raw) => {
      try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
    },
    normalizePendingSavedReplyDeletes: (x) => x || {},
    normalizeSavedReplySyncState: (x) => x,
  }, EXTRA_NAMES, EXPOSE_STATE);
}

test('signing in preserves the composer\'s bound ConversationState object identity and re-points it at the active chat (QA3-1)', () => {
  const r = runtime();

  // Mount as anonymous (uid ''), exactly like the real shell does before
  // sign-in resolves.
  r.loadChatStore();
  const chatStoreRef = r.__qa31_chatStore();
  const anonChat = chatStoreRef.getActive();

  // Simulate the composer's sendBtn/textarea listeners binding `state`
  // ONCE, by reference, at mount time (shell.ts: `const state =
  // getOrInitLiveState()` inside initConversation()).
  const composerState = r.getOrInitLiveState();
  assert.equal(r.getOrInitLiveState(), composerState, 'getOrInitLiveState must be a stable singleton before any account transition');

  // Simulate loadActiveChatIntoCenter's real repoint (shell.ts:8447,
  // `state.messages = chat.messages;`) — this line is unchanged by the
  // QA3-1 fix and already covered elsewhere; it's reproduced here only to
  // reach the realistic pre-condition the bug needs: the bound composer
  // object's `.messages` is the SAME array as the active chat's.
  composerState.messages = anonChat.messages;
  assert.equal(composerState.messages, anonChat.messages);

  // Sign-in resolves with a real uid. This calls the REAL loadChatStore(),
  // which contains the exact branch QA3-1 fixed.
  r.localStorage.setItem('ss_last_uid', 'user-123');
  r.loadChatStore();

  const signedInChat = chatStoreRef.getActive();
  // loadChatStore()'s bare-key migration legitimately adopts the anonymous
  // session's persisted chat under the new uid (same id), but — as the
  // QA3-1 fix comment on reconcileChatStoreAccountScope documents — it does
  // so by deserializing fresh objects, so this is a DIFFERENT object/array
  // graph even when the id matches. That object-identity break is exactly
  // what the composer's bound `state` must survive.
  assert.notEqual(signedInChat, anonChat, 'the post-sign-in active chat must be the freshly (re)loaded object, not the stale in-memory one');

  // The reconciliation hook calls getOrInitLiveState() again right after
  // loadChatStore() (shell.ts: reconcileChatStoreAccountScope -> loadActiveChatIntoCenter).
  const stateAfterReconcile = r.getOrInitLiveState();

  // THE CORE QA3-1 ASSERTION: the composer's originally-bound reference
  // must still be the live object. Under the original bug (`liveState =
  // null`), getOrInitLiveState() allocates a brand-new object here and this
  // assertion fails.
  assert.equal(
    stateAfterReconcile, composerState,
    'loadChatStore() must reset the EXISTING liveState object in place, not null the reference — ' +
    'otherwise the composer\'s already-bound listeners keep writing into an orphaned object forever'
  );
  assert.equal(stateAfterReconcile.messages.length, 0, 'the reset must actually clear the previous account\'s messages');

  // The second repoint (same real loadActiveChatIntoCenter line as above),
  // now against the newly signed-in chat.
  stateAfterReconcile.messages = signedInChat.messages;

  // Send a real user turn THROUGH THE ORIGINALLY CAPTURED REFERENCE — this
  // is exactly what the bound composer listener does via its closed-over
  // `state`, not through any new object.
  const question = {
    id: 'user-msg-1', role: 'user', text: 'Does support A have a moment reaction?',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  composerState.messages.push(question);

  // The real question must be visible in the active chat chatStore itself
  // sends/saves from (not stranded in an orphaned array)...
  assert.ok(signedInChat.messages.includes(question), 'the real user question never reached the active chat\'s message array');
  // ...and findable by id, exactly how "Try again" resolves its retry parent
  // (shell.ts attachStructuredRecoveryAction: chat.messages.findIndex(item => item.id === message.parentUserMessageId)).
  assert.ok(signedInChat.messages.findIndex((m) => m.id === question.id) >= 0, 'the question must be resolvable as a retry parent');
});

test('an account A -> B transition clears the previous account\'s messages and source library (QA3-1/QA2-1)', () => {
  const r = runtime();

  r.localStorage.setItem('ss_last_uid', 'user-A');
  r.loadChatStore();
  const chatStoreRef = r.__qa31_chatStore();
  const sourceLibraryRef = r.__qa31_sourceLibrary();

  const chatA = chatStoreRef.getActive();
  chatA.messages.push({
    id: 'a-msg-1', role: 'user', text: 'Account A question',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  sourceLibraryRef.items.push({
    id: 'course-a:folder-1', name: 'Account A folder', count: 1,
    courseId: 'course-a', courseName: '', documents: [], importedAt: Date.now(),
  });
  assert.equal(chatStoreRef.getActive().messages.length, 1);
  assert.equal(sourceLibraryRef.items.length, 1);

  r.localStorage.setItem('ss_last_uid', 'user-B');
  r.loadChatStore();

  assert.ok(chatStoreRef.chats.every((c) => c.id !== chatA.id), 'account B must never see account A\'s chat');
  assert.equal(chatStoreRef.getActive().messages.length, 0, 'account B\'s active chat must start with no carried-over messages');
  assert.equal(sourceLibraryRef.items.length, 0, 'account B must not inherit account A\'s attached source library');
});

// Manual mutation verification (per Codex's review request, not re-encoded
// as an automated mutation test to keep this file a normal regression
// suite): temporarily reverting shell.ts's loadChatStore() QA3-1 branch from
//   if (liveState) { liveState.messages = []; ...; liveState.draftAutosaveTimer = null; }
// back to the original buggy
//   liveState = null;
// and re-running this file makes the first test fail at the
// `stateAfterReconcile === composerState` assertion above (object identity
// broken), exactly reproducing the production bug. Restoring the fix makes
// it pass again. No repo state is left mutated by this comment — it
// documents a local, reverted-before-commit check.
