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

test('the account-wide GET is stably paginated instead of a single 200-row cap, and single-id lookup bypasses it', () => {
  const source = fs.readFileSync('backend/functions/chat-saved-replies.ts', 'utf8');
  // A total order (created_at desc, then id desc as a tiebreaker) is what
  // makes offset pagination safe to page through without skipping/repeating
  // rows — order=created_at.desc alone was the old 200-row cliff.
  assert.match(source, /order=created_at\.desc,id\.desc/);
  assert.match(source, /&limit=' \+ limit \+ '&offset=' \+ offset/);
  assert.match(source, /nextOffset/);
  // Exact single-row lookup must be a distinct path, not a slice of the
  // paginated listing — a response older than the caller's loaded pages
  // still has to resolve by id.
  assert.match(source, /if \(params\.id\) \{/);
  assert.match(source, /'&id=eq\.' \+ encodeURIComponent\(params\.id\)/);
});

test('DELETE only reports success when Supabase actually confirms the delete', () => {
  const source = fs.readFileSync('backend/functions/chat-saved-replies.ts', 'utf8');
  const deleteBlock = source.slice(source.indexOf("event.httpMethod === 'DELETE'"));
  assert.match(deleteBlock, /const result = await supaRequest\('DELETE',/);
  assert.match(deleteBlock, /if \(result\.status < 200 \|\| result\.status >= 300\)/);
  assert.match(deleteBlock, /return fail\(502, 'Could not delete saved reply'\)/);
});

test('a 409 conflict with no resolvable canonical id stays retryable instead of claiming success', () => {
  const source = fs.readFileSync('backend/functions/chat-saved-replies.ts', 'utf8');
  const conflictBlock = source.slice(
    source.indexOf("result.status === 409"),
    source.indexOf("if (result.status < 200 || result.status >= 300) {\n      return fail(502, 'Could not save reply')")
  );
  assert.match(conflictBlock, /if \(!existingId\) \{/);
  assert.match(conflictBlock, /return fail\(409, 'Could not resolve saved reply conflict'\)/);
  // The success path must remain gated behind a resolved id — this line
  // should only be reached once existingId is known truthy.
  assert.match(conflictBlock, /return jsonResponse\(200, \{ ok: true, duplicate: true, existingId \}\);/);
});
