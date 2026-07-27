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
