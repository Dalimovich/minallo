import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeSavedReplyText,
  savedReplyFingerprint
} from '../../backend/functions/chat-saved-replies';

test('saved response normalization is conservative and fingerprints normalized equivalents equally', () => {
  const windows = '  **F = ma**\r\n\r\nKeep $x^2$ intact.  ';
  const unix = '**F = ma**\n\nKeep $x^2$ intact.';
  assert.equal(normalizeSavedReplyText(windows), unix);
  assert.equal(savedReplyFingerprint(windows), savedReplyFingerprint(unix));
  assert.notEqual(savedReplyFingerprint(unix), savedReplyFingerprint(unix.toLowerCase()));
});

test('API computes fingerprints server-side and returns idempotent duplicate results', () => {
  const source = fs.readFileSync('backend/functions/chat-saved-replies.ts', 'utf8');
  assert.match(source, /const fingerprint = savedReplyFingerprint\(normalizedText\)/);
  assert.match(source, /source_message_id=eq\./);
  assert.match(source, /content_fingerprint=eq\./);
  assert.match(source, /duplicate: true, existingId/);
  assert.match(source, /duplicate: false, id/);
});

test('database uniqueness is owner-scoped by message and by course-or-General content', () => {
  const migration = fs.readFileSync(
    'supabase/migrations/20260907_000001_course_aware_saved_ai_responses.sql',
    'utf8'
  );
  assert.match(migration, /\(user_id, source_message_id\)/);
  assert.match(migration, /\(user_id, coalesce\(course_id, ''\), content_fingerprint\)/);
  assert.match(migration, /where source_message_id is not null/);
});
