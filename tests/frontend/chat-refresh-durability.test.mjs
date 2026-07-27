import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const auth = fs.readFileSync('frontend/js/supabase.js', 'utf8');

test('refresh keeps the complete local transcript and repairs it from the durable server copy', () => {
  assert.match(shell, /const messages = c\.messages;/);
  assert.doesNotMatch(shell, /c\.messages\.slice\(-NCB_MAX_STORED_MESSAGES_PER_CHAT\)/);
  assert.match(shell, /\/conversations\/.*\/messages/);
  assert.match(shell, /localById = new Map/);
  assert.match(shell, /serverText\.length > \(existing\.text \|\| ''\)\.length/);
});

test('boot uses the canonical single-flight refresh and preserves recoverable sessions', () => {
  assert.match(auth, /return _sb\.auth\.refreshSession\(\)/);
  assert.match(auth, /A temporary auth outage is not a logout/);
  assert.match(auth, /else if \(_sbStoredRefresh\(\)\)/);
  assert.match(auth, /_sbBootRecoveryAttempts < 3/);
});

test('durable hydration cannot oscillate active state or rebuild the whole center', () => {
  const integrity = shell.slice(
    shell.indexOf('function repairConversationIntegrity'),
    shell.indexOf('async function downloadAssistantResponsePdf')
  );
  assert.doesNotMatch(integrity, /completionState = 'failed_recoverable'/);
  assert.match(shell, /body\.revision === chat\.hydrationRevision/);
  assert.match(shell, /changedMessages\.forEach\(\(message\) => updateStoredMessageRow/);
  assert.match(shell, /if \(\(!chat\.persistedId \|\| chat\.durableHydrated\)/);
});

test('scoped recovery identity survives browser compaction and hydration', () => {
  const compact = shell.slice(
    shell.indexOf('function compactMessageForStorage'),
    shell.indexOf('function compactChatForStorage')
  );
  assert.match(compact, /scopedJobId: m\.scopedJobId/);
  assert.match(compact, /scopedManifestId: m\.scopedManifestId/);
  assert.match(compact, /lastScopedEventId: m\.lastScopedEventId/);
  assert.match(shell, /scopedJobId: row\.scoped_job_id/);
  assert.match(shell, /const durablePollTimers = new Map/);
  assert.match(shell, /const scopedPollTimers = new Map/);
});

test('a transient durable-state poll failure cannot strand the continuation card', () => {
  assert.match(shell, /One network\/authorization\/server failure must not permanently stop/);
  assert.match(shell, /needsPoll = true/);
  assert.match(shell, /durablePollFailures/);
  assert.match(shell, /response_worker_stalled|request_state_missing/);
  assert.match(shell, /const delay = Math\.min\(10_000/);
});

test('every active completion state uses the same generic reconciliation path', () => {
  assert.match(shell, /ACTIVE_COMPLETION_STATES[\s\S]*'pending'[\s\S]*'processing'[\s\S]*'streaming'[\s\S]*'recovering'/);
  assert.match(shell, /ACTIVE_COMPLETION_STATES\.has\(m\.completionState\)/);
  assert.match(shell, /ACTIVE_COMPLETION_STATES\.has\(message\.completionState\)/);
});
