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

test('an in-flight Saved preload cannot hide a newly created offline bookmark', () => {
  const handler = workspace.slice(
    workspace.indexOf('const handleSavedRepliesChanged'),
    workspace.indexOf("document.addEventListener('minallo:saved-replies-changed'")
  );
  assert.match(handler, /localBookmarkedResponses\(\)\.find/);
  assert.match(handler, /state\.savedItems =/);
  assert.match(handler, /paintSavedState\(savedPanel/);

  const loader = workspace.slice(
    workspace.indexOf('async function loadBookmarkedResponses'),
    workspace.indexOf('function authToken')
  );
  assert.match(loader, /const localRowsAtStart = localBookmarkedResponses\(\)/);
  assert.match(loader, /const localRows = localBookmarkedResponses\(\)/);
  assert.ok(loader.indexOf('const localRows = localBookmarkedResponses()') > loader.indexOf("await fetch('/api/chat-saved-replies'"));
});

test('Saved reads localStorage through the shared canonical parser, not a re-guessed shape', () => {
  assert.match(workspace, /import \{ parsePersistedChats,.*\} from '\.\/chat-store-format\.js'/);
  assert.match(workspace, /function readPersistedChats\(\): PersistedChat\[\] \{/);
  assert.doesNotMatch(workspace, /parsed\?\.chats/);
  const localReader = workspace.slice(
    workspace.indexOf('function localBookmarkedResponses'),
    workspace.indexOf('function savedChatTitles')
  );
  assert.match(localReader, /readPersistedChats\(\)\.flatMap/);
});

test('the saved-replies-changed event carries the bookmark payload; the Saved panel must not need a localStorage re-read to show a fresh bookmark', () => {
  const bookmarkFn = shell.slice(shell.indexOf('function bookmarkAssistantResponse'), shell.indexOf('function renderNotesTab'));
  assert.match(bookmarkFn, /dispatchSavedReplyChanged\(\{ action: 'created', bookmark: bookmarkEventPayload\(reply, chat\.id\) \}\)/);

  const handler = workspace.slice(
    workspace.indexOf('const handleSavedRepliesChanged'),
    workspace.indexOf("document.addEventListener('minallo:saved-replies-changed'")
  );
  assert.match(handler, /detail\?\.bookmark/);
  assert.match(handler, /cachedBookmarkedResponse\(\{\s*id: b\.id/);
  // The bookmark-carrying branch must come before the localStorage fallback
  // so a fresh bookmark is never gated on the debounced write.
  assert.ok(handler.indexOf('detail?.bookmark') < handler.indexOf('localBookmarkedResponses().find'));
});

test('re-clicking Bookmark on an already-saved response repairs it instead of dead-ending', () => {
  const bookmarkFn = shell.slice(shell.indexOf('function bookmarkAssistantResponse'), shell.indexOf('function renderNotesTab'));
  const alreadyBranch = bookmarkFn.slice(bookmarkFn.indexOf('if (already)'), bookmarkFn.indexOf("flashAck(btn, tStr('cb_act_already_saved'"));
  assert.match(alreadyBranch, /syncSavedReplyCreate\(already\.chatId \|\| chat\.id, already\)/);
  assert.match(alreadyBranch, /dispatchSavedReplyChanged\(\{ action: 'created', bookmark: bookmarkEventPayload\(already, chat\.id\) \}\)/);
});

test('server GET distinguishes a query/schema failure from a genuine empty result', () => {
  const getHandler = api.slice(api.indexOf("if (event.httpMethod === 'GET')"), api.indexOf("if (event.httpMethod === 'POST')"));
  assert.match(getHandler, /if \(result\.status < 200 \|\| result\.status >= 300\)/);
  assert.match(getHandler, /return fail\(502, 'Could not load saved AI responses'\)/);
});

test('a 409 on save resolves the canonical id regardless of which uniqueness constraint fired', () => {
  const postHandler = api.slice(api.indexOf("if (result.status === 409)"), api.indexOf("if (result.status < 200 || result.status >= 300) {\n      return fail(502, 'Could not save reply')"));
  assert.match(postHandler, /sourceQuery \? supaRequest.*sourceQuery/s);
  assert.match(postHandler, /supaRequest<Array<\{ id\?: string \}>>\('GET', fingerprintQuery/);
});
