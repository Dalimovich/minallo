import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePersistedChats, normalizeSavedReplySyncState } from '../../frontend/js/features/chatbot-new/chat-store-format.ts';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const workspace = fs.readFileSync('frontend/js/features/chatbot-new/workspace-library.ts', 'utf8');
const chatStoreFormat = fs.readFileSync('frontend/js/features/chatbot-new/chat-store-format.ts', 'utf8');

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

// ── Wiring tests: prove shell.ts's real serializer/loader call the one ───
// ── shared, tested function above, instead of a re-guessed local copy. ───

test('compactChatForStorage persists syncState via the shared normalizer, not a re-guessed shape', () => {
  const compactFn = slice(shell, 'function compactChatForStorage', 'function compactChatsForStorage');
  const savedRepliesMap = slice(compactFn, 'savedReplies: (c.savedReplies || []).map', '})),');
  assert.match(savedRepliesMap, /syncState: normalizeSavedReplySyncState\(r\.syncState\)/);
});

test('loadChatStore migration normalizes syncState via the shared function, not an inline duplicate', () => {
  const migrationBlock = slice(shell, 'c.savedReplies = c.savedReplies.map', 'c.sourceMode = normaliseSourceMode');
  assert.match(migrationBlock, /syncState: normalizeSavedReplySyncState\(reply\.syncState\)/);
});

test('shell.ts imports the normalizer from chat-store-format instead of defining its own', () => {
  assert.match(shell, /import \{[\s\S]{0,120}normalizeSavedReplySyncState[\s\S]{0,120}\} from '\.\/chat-store-format\.js';/);
  // A second, independently-typed local implementation is exactly how the
  // write and read boundaries silently drifted apart before.
  assert.doesNotMatch(shell, /function normalizeSavedReplySyncState/);
});

test('a bookmark whose token is missing at click time is retried, not abandoned', () => {
  const syncFn = slice(shell, 'function syncSavedReplyCreate', 'function flushPendingSavedReplySync');
  // Marking pending happens unconditionally, before the token check — the
  // local artifact and its retry-eligibility both exist even when
  // getSbToken() returns null, so the click-Bookmark-while-signed-out case
  // never silently skips durable persistence forever.
  assert.match(syncFn, /r\.syncState = 'pending';\s*\n\s*const token = getSbToken\(\);/);
  assert.match(syncFn, /if \(!token\) \{\s*\n\s*saveChatStore\(\);\s*\n\s*return;/);
});

test('a failed POST or network error marks the reply failed instead of dropping it', () => {
  const syncFn = slice(shell, 'function syncSavedReplyCreate', 'function flushPendingSavedReplySync');
  assert.match(syncFn, /if \(!response\.ok\) \{\s*\n\s*r\.syncState = 'failed';/);
  assert.match(syncFn, /\}\)\.catch\(\(\) => \{[\s\S]*?r\.syncState = 'failed';/);
  // The reply itself is never removed from chat.savedReplies on failure —
  // only success/duplicate-reconcile paths ever splice it out.
  assert.doesNotMatch(syncFn, /catch\(\(\) => \{[\s\S]{0,200}chat\.savedReplies = chat\.savedReplies\.filter/);
});

test('success and duplicate-reconcile paths mark the reply synced', () => {
  const syncFn = slice(shell, 'function syncSavedReplyCreate', 'function flushPendingSavedReplySync');
  assert.match(syncFn, /r\.syncState = 'synced';\s*\n\s*saveChatStore\(\);\s*\n\s*return;/);
  assert.match(syncFn, /canonical\.syncState = 'synced';/);
  assert.match(syncFn, /local\.syncState = 'synced';/);
});

test('a reply confirmed by a successful server GET is marked synced, never left stale', () => {
  // mergeSavedRepliesFromServer: a row that comes back from the durable API
  // is definitional proof the durable copy exists, regardless of whatever
  // local syncState it happened to carry before this reconciliation ran.
  const mergeFn = slice(shell, 'async function mergeSavedRepliesFromServer', 'function resolveBookmarkCourseId');
  assert.match(mergeFn, /existing\.syncState = 'synced';/);
  assert.match(mergeFn, /syncState: 'synced',/);
});

test('flushPendingSavedReplySync only retries pending/failed replies, is bounded, and needs a token', () => {
  const source = slice(shell, 'function flushPendingSavedReplySync', 'function syncSavedReplyDelete');
  assert.match(source, /if \(!getSbToken\(\)\) return;/);
  assert.match(source, /if \(now - _lastSavedReplyFlushAt < 2000\) return;/);
  assert.match(source, /reply\.syncState === 'pending' \|\| reply\.syncState === 'failed'/);
  assert.match(source, /syncSavedReplyCreate\(reply\.chatId \|\| chat\.id, reply\)/);
});

test('retry triggers are wired: auth ready, back online, Saved panel opened, and startup', () => {
  assert.match(shell, /window\.addEventListener\('online', \(\) => flushPendingSavedReplySync\(\)\)/);
  assert.match(shell, /document\.addEventListener\('minallo:auth:signed-in', \(\) => flushPendingSavedReplySync\(\)\)/);
  assert.match(shell, /document\.addEventListener\('minallo:auth:entered', \(\) => flushPendingSavedReplySync\(\)\)/);
  assert.match(shell, /document\.addEventListener\('minallo:saved-panel-opened', \(\) => flushPendingSavedReplySync\(\)\)/);
  assert.match(shell, /flushPendingSavedReplySync\(\); \/\/ startup reconciliation \/ chat-restored trigger/);
  // No polling: setInterval must never be used for this mechanism.
  assert.doesNotMatch(
    slice(shell, 'function flushPendingSavedReplySync', 'function syncSavedReplyDelete'),
    /setInterval/,
  );
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

test('legacy persisted replies default to synced, not pending, to avoid a startup request storm', () => {
  const migrationBlock = slice(shell, 'c.savedReplies = c.savedReplies.map', 'c.sourceMode = normaliseSourceMode');
  assert.match(migrationBlock, /syncState: normalizeSavedReplySyncState\(reply\.syncState\)/);
});

test('the shared persisted-chat contract documents the sync-state field via the shared type', () => {
  assert.match(chatStoreFormat, /export type SavedReplySyncState = 'pending' \| 'synced' \| 'failed';/);
  assert.match(chatStoreFormat, /syncState\?: SavedReplySyncState;/);
});
