import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parsePersistedChats, normalizeSavedReplySyncState, normalizePendingSavedReplyDeletes,
} from '../../frontend/js/features/chatbot-new/chat-store-format.ts';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const workspace = fs.readFileSync('frontend/js/features/chatbot-new/workspace-library.ts', 'utf8');
const chatStoreFormat = fs.readFileSync('frontend/js/features/chatbot-new/chat-store-format.ts', 'utf8');
const syncEngine = fs.readFileSync('frontend/js/features/chatbot-new/saved-reply-sync.ts', 'utf8');

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

// ── Real behavioral round-trip tests ────────────────────────────────────
// These import and execute the actual functions shell.ts uses at both the
// write boundary (compactChatForStorage) and the read boundary
// (loadChatStore's migration) — normalizeSavedReplySyncState and
// parsePersistedChats — through a real JSON.stringify/JSON.parse cycle.
// This is the exact class of bug a source-regex test cannot catch: the type
// declared `syncState` as persisted, but the object literal that actually
// built the stored JSON simply omitted the field, so a real localStorage
// round-trip silently discarded it. Regex assertions further below prove
// shell.ts's serializer and loader actually call this one shared function
// (instead of re-guessing their own copy of the same check); these round-trip
// tests prove the shared function itself is correct through real JSON I/O.

function roundTrip(syncState) {
  const persistedReply = {
    id: 'rep_1', text: 'hello', createdAt: 1, courseId: null, chatId: 'chat_1',
    syncState: normalizeSavedReplySyncState(syncState),
  };
  const raw = JSON.stringify([{ id: 'chat_1', title: 'Test', savedReplies: [persistedReply] }]);
  const [loadedChat] = parsePersistedChats(raw);
  return normalizeSavedReplySyncState(loadedChat.savedReplies[0].syncState);
}

test('a pending sync state survives a real JSON localStorage round-trip', () => {
  assert.equal(roundTrip('pending'), 'pending');
});

test('a failed sync state survives a real JSON localStorage round-trip', () => {
  assert.equal(roundTrip('failed'), 'failed');
});

test('a synced sync state survives a real JSON localStorage round-trip', () => {
  assert.equal(roundTrip('synced'), 'synced');
});

test('a legacy reply with no syncState field at all normalizes to synced, not pending', () => {
  const raw = JSON.stringify([{
    id: 'chat_1', title: 'Test', savedReplies: [{
      id: 'rep_1', text: 'hello', createdAt: 1, courseId: null, chatId: 'chat_1',
      // no syncState key — simulates data persisted before this feature existed
    }],
  }]);
  const [loadedChat] = parsePersistedChats(raw);
  assert.equal(normalizeSavedReplySyncState(loadedChat.savedReplies[0].syncState), 'synced');
});

test('an unrecognized/corrupt syncState value normalizes to synced rather than being trusted', () => {
  assert.equal(normalizeSavedReplySyncState('literally anything else'), 'synced');
  assert.equal(normalizeSavedReplySyncState(null), 'synced');
  assert.equal(normalizeSavedReplySyncState(undefined), 'synced');
});

// Same durability contract as syncState, for the delete tombstone map — see
// tests/frontend/saved-reply-sync-engine.test.mjs for the engine behavior
// (create/delete/flush) that consumes this once loaded.

function tombstoneRoundTrip(pendingSavedReplyDeletes) {
  const raw = JSON.stringify([{ id: 'chat_1', title: 'Test', savedReplies: [], pendingSavedReplyDeletes }]);
  const [loadedChat] = parsePersistedChats(raw);
  return normalizePendingSavedReplyDeletes(loadedChat.pendingSavedReplyDeletes);
}

test('a pending-delete tombstone survives a real JSON localStorage round-trip', () => {
  assert.deepEqual(tombstoneRoundTrip({ rep_1: 1700000000000 }), { rep_1: 1700000000000 });
});

test('a missing pendingSavedReplyDeletes field normalizes to an empty map, not a crash', () => {
  assert.deepEqual(tombstoneRoundTrip(undefined), {});
});

test('a corrupt pendingSavedReplyDeletes value (wrong type, non-numeric timestamp) is dropped, not trusted', () => {
  assert.deepEqual(normalizePendingSavedReplyDeletes('not an object'), {});
  assert.deepEqual(normalizePendingSavedReplyDeletes(null), {});
  assert.deepEqual(normalizePendingSavedReplyDeletes({ rep_1: 'not-a-number', rep_2: 42 }), { rep_2: 42 });
});

// ── Wiring tests: prove shell.ts's real serializer/loader/UI call the one ─
// ── shared, tested functions above instead of a re-guessed local copy. ───

test('compactChatForStorage persists syncState and pendingSavedReplyDeletes via the shared normalizers', () => {
  const compactFn = slice(shell, 'function compactChatForStorage', 'function chatHasUnresolvedSavedReplyMutation');
  const savedRepliesMap = slice(compactFn, 'savedReplies: (c.savedReplies || []).map', '})),');
  assert.match(savedRepliesMap, /syncState: normalizeSavedReplySyncState\(r\.syncState\)/);
  assert.match(compactFn, /pendingSavedReplyDeletes: \{ \.\.\.\(c\.pendingSavedReplyDeletes \|\| \{\}\) \}/);
});

test('loadChatStore migration normalizes syncState and pendingSavedReplyDeletes via the shared functions', () => {
  const migrationBlock = slice(shell, 'c.savedReplies = c.savedReplies.map', 'c.sourceMode = normaliseSourceMode');
  assert.match(migrationBlock, /syncState: normalizeSavedReplySyncState\(reply\.syncState\)/);
  assert.match(shell, /c\.pendingSavedReplyDeletes = normalizePendingSavedReplyDeletes\(c\.pendingSavedReplyDeletes\);/);
});

test('shell.ts imports the sync-state normalizers from chat-store-format instead of defining its own', () => {
  const importBlock = slice(shell, "import {", "} from './chat-store-format.js';");
  assert.match(importBlock, /normalizeSavedReplySyncState/);
  assert.match(importBlock, /normalizePendingSavedReplyDeletes/);
  // A second, independently-typed local implementation is exactly how the
  // write and read boundaries silently drifted apart before.
  assert.doesNotMatch(shell, /function normalizeSavedReplySyncState/);
  assert.doesNotMatch(shell, /function normalizePendingSavedReplyDeletes/);
});

test('the create/delete/flush mutation queue lives in saved-reply-sync.ts, not duplicated inline in shell.ts', () => {
  // shell.ts must wire the real engine instead of redefining the logic —
  // the engine's own behavior (in-flight dedupe, tombstones, coalesced
  // retry, success-over-stale-failure) is covered by real execution tests
  // in tests/frontend/saved-reply-sync-engine.test.mjs.
  assert.match(shell, /import \{ createSavedReplySyncEngine \} from '\.\/saved-reply-sync\.js';/);
  const wiring = slice(shell, 'const { syncSavedReplyCreate, syncSavedReplyDelete, flushPendingSavedReplySync }', 'apiUrl: SAVED_REPLIES_API,');
  assert.match(wiring, /getChats: \(\) => chatStore\.chats,/);
  assert.match(wiring, /saveChatStore,/);
  assert.match(wiring, /getToken: getSbToken,/);
  assert.match(wiring, /dispatchChanged: dispatchSavedReplyChanged,/);
  assert.doesNotMatch(shell, /function syncSavedReplyCreate\(/);
  assert.doesNotMatch(shell, /function syncSavedReplyDelete\(/);
  assert.doesNotMatch(shell, /function flushPendingSavedReplySync\(/);
});

test('a reply confirmed by a successful server GET is marked synced, never left stale', () => {
  // mergeSavedRepliesFromServer: a row that comes back from the durable API
  // is definitional proof the durable copy exists, regardless of whatever
  // local syncState it happened to carry before this reconciliation ran.
  const mergeFn = slice(shell, 'async function mergeSavedRepliesFromServer', 'function resolveBookmarkCourseId');
  assert.match(mergeFn, /existing\.syncState = 'synced';/);
  assert.match(mergeFn, /syncState: 'synced',/);
});

test('mergeSavedRepliesFromServer pages through the server set via a real cursor, not OFFSET', () => {
  const mergeFn = slice(shell, 'async function mergeSavedRepliesFromServer', 'function resolveBookmarkCourseId');
  assert.match(mergeFn, /for \(let page = 0; page < SAVED_REPLY_MAX_PAGES; page\+\+\)/);
  assert.match(mergeFn, /cursorCreatedAt=' \+ encodeURIComponent\(cursor\.createdAt\)/);
  assert.match(mergeFn, /if \(!data\.nextCursor\) break;/);
  assert.doesNotMatch(mergeFn, /&offset=/);
});

test('a stale server row cannot resurrect a reply the user is still trying to delete', () => {
  const mergeFn = slice(shell, 'async function mergeSavedRepliesFromServer', 'function resolveBookmarkCourseId');
  const tombstoneCheck = slice(mergeFn, 'if (Object.prototype.hasOwnProperty.call(chat.pendingSavedReplyDeletes, row.id)) {', '}');
  assert.match(tombstoneCheck, /syncSavedReplyDelete\(chatId, row\.id\);/);
  assert.match(tombstoneCheck, /continue;/);
});

test('retry triggers are wired: auth ready, back online, Saved panel opened, and startup, with no polling', () => {
  const triggerBlock = slice(shell, '// Durable bookmark sync retry triggers', 'flushPendingSavedReplySync(); // startup');
  assert.match(triggerBlock, /window\.addEventListener\('online', \(\) => flushPendingSavedReplySync\(\)\)/);
  assert.match(triggerBlock, /document\.addEventListener\('minallo:auth:signed-in', \(\) => flushPendingSavedReplySync\(\)\)/);
  assert.match(triggerBlock, /document\.addEventListener\('minallo:auth:entered', \(\) => flushPendingSavedReplySync\(\)\)/);
  assert.match(triggerBlock, /document\.addEventListener\('minallo:saved-panel-opened', \(\) => flushPendingSavedReplySync\(\)\)/);
  // No polling: setInterval must never be used for this mechanism, in
  // either shell.ts's wiring or the engine module itself.
  assert.doesNotMatch(triggerBlock, /setInterval/);
  assert.doesNotMatch(syncEngine, /setInterval/);
});

test('opening the Saved panel dispatches the retry trigger', () => {
  const selectTab = slice(workspace, 'const selectTab = (selected: string)', 'tabs.forEach((tab) =>');
  assert.match(selectTab, /if \(selected === 'saved'\) \{/);
  assert.match(selectTab, /document\.dispatchEvent\(new CustomEvent\('minallo:saved-panel-opened'\)\)/);
});

test('re-clicking Bookmark on an already-saved reply re-enters the same retry path', () => {
  const bookmarkFn = slice(shell, 'function bookmarkAssistantResponse', 'function renderNotesTab');
  const alreadyBranch = bookmarkFn.slice(
    bookmarkFn.indexOf('if (already)'),
    bookmarkFn.indexOf("flashAck(btn, tStr('cb_act_already_saved'"),
  );
  // syncSavedReplyCreate unconditionally resets syncState to 'pending' at
  // entry, so a manual re-click is itself a valid (if not the only) retry.
  assert.match(alreadyBranch, /syncSavedReplyCreate\(already\.chatId \|\| chat\.id, already\)/);
});

test('deleting a saved reply persists a tombstone before the network attempt, keyed off the reply id', () => {
  const notesFn = slice(shell, 'function renderNotesTab', 'function generateChatTitle');
  const deleteHandler = slice(notesFn, "'.ncb-saved-remove'", "'.ncb-saved-copy'");
  assert.match(deleteHandler, /chat\.savedReplies = chat\.savedReplies\.filter\(\(r\) => r\.id !== id\);/);
  assert.match(deleteHandler, /chat\.pendingSavedReplyDeletes\[id\] = Date\.now\(\);/);
  assert.match(deleteHandler, /syncSavedReplyDelete\(chat\.id, id\);/);
  // The tombstone must be written and persisted before the network call is
  // made, not after — a page unload immediately after the click must not
  // lose the delete intent.
  const tombstoneIdx = deleteHandler.indexOf('pendingSavedReplyDeletes[id]');
  const saveIdx = deleteHandler.indexOf('saveChatStore();');
  const syncIdx = deleteHandler.indexOf('syncSavedReplyDelete(chat.id, id);');
  assert.ok(tombstoneIdx > -1 && saveIdx > tombstoneIdx && syncIdx > saveIdx);
});

test('a chat holding an unresolved Saved mutation is kept in storage ahead of the recency cap', () => {
  const compactChatsFn = slice(shell, 'function compactChatsForStorage', 'return Array.from(picked.values())');
  assert.match(compactChatsFn, /byRecent\.filter\(chatHasUnresolvedSavedReplyMutation\)\.forEach\(add\);/);
  const guardFn = slice(shell, 'function chatHasUnresolvedSavedReplyMutation', 'function compactChatsForStorage');
  assert.match(guardFn, /Object\.keys\(c\.pendingSavedReplyDeletes \|\| \{\}\)\.length > 0/);
  assert.match(guardFn, /r\.syncState === 'pending' \|\| r\.syncState === 'failed'/);
});

test('legacy persisted replies default to synced, not pending, to avoid a startup request storm', () => {
  const migrationBlock = slice(shell, 'c.savedReplies = c.savedReplies.map', 'c.sourceMode = normaliseSourceMode');
  assert.match(migrationBlock, /syncState: normalizeSavedReplySyncState\(reply\.syncState\)/);
});

test('the shared persisted-chat contract documents both the sync-state and tombstone fields via shared types', () => {
  assert.match(chatStoreFormat, /export type SavedReplySyncState = 'pending' \| 'synced' \| 'failed';/);
  assert.match(chatStoreFormat, /syncState\?: SavedReplySyncState;/);
  assert.match(chatStoreFormat, /pendingSavedReplyDeletes\?: Record<string, number>;/);
});

// ── Workspace-library (account-wide Saved panel) pagination + tombstones ──

test('loadBookmarkedResponses pages through saved responses via a real cursor instead of a single 200-row request or OFFSET', () => {
  const loadFn = slice(workspace, 'async function loadBookmarkedResponses', 'function authToken');
  assert.match(loadFn, /for \(let page = 0; page < SAVED_REPLY_MAX_PAGES; page\+\+\)/);
  assert.match(loadFn, /cursorCreatedAt=\$\{encodeURIComponent\(cursor\.createdAt\)\}/);
  assert.match(loadFn, /if \(!body\.nextCursor\) break;/);
  assert.doesNotMatch(loadFn, /[?&]offset=/);
});

test('loadBookmarkedResponses excludes rows with an unresolved durable delete tombstone, and never re-pushes them', () => {
  const loadFn = slice(workspace, 'async function loadBookmarkedResponses', 'function authToken');
  assert.match(loadFn, /!deletedResponseIds\.has\(row\.id\) && !pendingDeleteIds\.has\(row\.id\)/);
  assert.match(loadFn, /!serverIds\.has\(row\.id\) && !pendingDeleteIds\.has\(row\.id\)/);
});

test('opening an older saved response resolves it by exact id, not by scanning the first page of the listing', () => {
  const resolveFn = slice(workspace, 'async function resolveCachedSavedItem', 'const rendererLoads');
  assert.match(resolveFn, /authenticatedFetch\(`\/api\/chat-saved-replies\?id=\$\{encodeURIComponent\(item\.id\)\}`/);
});

test('all first-party Saved network calls go through authenticatedFetch, not raw fetch with a captured token', () => {
  const mergeFn = slice(shell, 'async function mergeSavedRepliesFromServer', 'function resolveBookmarkCourseId');
  assert.match(mergeFn, /authenticatedFetch\(url, \{ method: 'GET' \}, \{ safeToRetry: true \}\)/);
  assert.doesNotMatch(mergeFn, /Authorization: 'Bearer ' \+ token/);

  const loadFn = slice(workspace, 'async function loadBookmarkedResponses', 'function authToken');
  assert.match(loadFn, /authenticatedFetch\(url, \{ method: 'GET' \}, \{ safeToRetry: true \}\)/);
  assert.match(loadFn, /authenticatedFetch\('\/api\/chat-saved-replies', \{/);
  assert.doesNotMatch(loadFn, /Authorization: `Bearer \$\{token\}`/);

  const syncEngineSource = syncEngine;
  assert.match(syncEngineSource, /import \{ authenticatedFetch \} from '\.\.\/\.\.\/services\/authenticated-fetch\.js';/);
  assert.match(syncEngineSource, /deps\.fetchImpl \|\| authenticatedFetch/);
  assert.doesNotMatch(syncEngineSource, /Authorization: 'Bearer ' \+ token/);
});

test('legacy pre-durable-sync bookmarks get a one-time real reconciliation pass, not permanent silent trust', () => {
  const reconcileFn = slice(
    shell, 'async function reconcileLegacySavedRepliesOnce', 'function resolveBookmarkCourseId',
  );
  // Gated by a persisted, account-scoped flag — runs once ever, not once per
  // page load like flushPendingSavedReplySync's pending/failed sweep (which
  // never revisits a reply the loader already normalized to 'synced').
  assert.match(reconcileFn, /localStorage\.getItem\(flagKey\) === '1'/);
  assert.match(reconcileFn, /localStorage\.setItem\(flagKey, '1'\)/);
  // Must not mark itself done before a session exists — otherwise a user who
  // opens the app signed out would permanently skip their own reconciliation.
  assert.match(reconcileFn, /if \(!getSbToken\(\)\) return;/);
  // Reuses mergeSavedRepliesFromServer's real match-by-id/sourceMessageId/
  // course+content logic and its synced-or-repush outcome — no second,
  // independently-guessed reconciliation algorithm.
  assert.match(reconcileFn, /mergeSavedRepliesFromServer\(root, c\.id\)/);
  assert.match(reconcileFn, /chatStore\.chats\.filter\(\(c\) => c\.savedReplies\.length > 0\)/);
});

test('the legacy reconciliation pass runs at startup and retries once auth becomes available', () => {
  const initFn = slice(shell, 'export function initNewChatbotShell', 'function applyChatbotI18n');
  assert.match(initFn, /void reconcileLegacySavedRepliesOnce\(newRoot\); \/\/ one-time historical repair/);
  assert.match(
    initFn,
    /document\.addEventListener\('minallo:auth:signed-in', \(\) => void reconcileLegacySavedRepliesOnce\(newRoot\)\)/,
  );
  assert.match(
    initFn,
    /document\.addEventListener\('minallo:auth:entered', \(\) => void reconcileLegacySavedRepliesOnce\(newRoot\)\)/,
  );
});
