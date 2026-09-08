import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  assert.match(migrationBlock, /reply\.syncState === 'pending' \|\| reply\.syncState === 'failed'\s*\n\s*\? reply\.syncState : 'synced'/);
});

test('the shared persisted-chat contract documents the new sync-state field', () => {
  assert.match(chatStoreFormat, /syncState\?: 'pending' \| 'synced' \| 'failed';/);
});
