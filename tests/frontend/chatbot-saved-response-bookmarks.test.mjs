import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const workspace = fs.readFileSync('frontend/js/features/chatbot-new/workspace-library.ts', 'utf8');
const api = fs.readFileSync('backend/functions/chat-saved-replies.ts', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260907_000001_course_aware_saved_ai_responses.sql', 'utf8');

test('bookmark provenance is captured from the assistant request, not the currently selected course', () => {
  const resolver = shell.slice(shell.indexOf('function resolveBookmarkCourseId'), shell.indexOf('function findExistingSavedReply'));
  assert.match(resolver, /message\.requestSnapshot\?\.courseId/);
  assert.match(resolver, /message\.generatedDoc\?\.courseId/);
  assert.match(shell, /sourceMessageId/);
  assert.match(shell, /sourcePrompt: \(message\.requestSnapshot\?\.userText \|\| parent\?\.text/);
});

test('client dedupe is source-message first and otherwise course-scoped normalized content', () => {
  const dedupe = shell.slice(shell.indexOf('function findExistingSavedReply'), shell.indexOf('function bookmarkAssistantResponse'));
  assert.match(dedupe, /reply\.sourceMessageId === candidate\.sourceMessageId/);
  assert.match(dedupe, /sameSavedReplyScope\(reply\.courseId, candidate\.courseId\)/);
  assert.match(dedupe, /normalizedSavedReplyText\(reply\.text\)/);
});

test('server computes the fingerprint and enforces both durable uniqueness identities', () => {
  assert.match(api, /createHash\('sha256'\)/);
  assert.match(api, /const fingerprint = savedReplyFingerprint\(normalizedText\)/);
  assert.match(migration, /unique index if not exists uq_chat_saved_replies_source_message/);
  assert.match(migration, /unique index if not exists uq_chat_saved_replies_scoped_content/);
  assert.match(migration, /coalesce\(course_id, ''\), content_fingerprint/);
});

test('Saved groups responses by course with one General fallback and keeps chat provenance in metadata', () => {
  const loader = workspace.slice(workspace.indexOf('async function loadBookmarkedResponses'), workspace.indexOf('function authToken'));
  assert.match(loader, /const groupId = courseId \|\| 'responses:general'/);
  assert.match(loader, /name: courseId \? \(cachedCourseNames\.get\(courseId\) \|\| courseId\) : 'General'/);
  assert.match(loader, /titles\.get\(chatId\) \|\| 'AI conversation'/);
  assert.match(loader, /row\.source_prompt \? responseTitle/);
});

test('legacy local bookmarks migrate safely to General and sync all provenance fields', () => {
  assert.match(shell, /courseId: typeof reply\.courseId === 'string' && reply\.courseId \? reply\.courseId : null/);
  assert.match(workspace, /course_id: reply\.courseId \|\| null/);
  assert.match(workspace, /sourceMessageId: row\.source_message_id, sourcePrompt: row\.source_prompt/);
  assert.match(migration, /having count\(distinct course_id\) = 1/);
});
