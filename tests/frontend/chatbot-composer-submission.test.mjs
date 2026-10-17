import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const sendStart = source.indexOf('async function doSend(');
const sendEnd = source.indexOf('\nfunction newChatMessageId', sendStart);
const send = source.slice(sendStart, sendEnd);

test('send creates an immutable snapshot before any attachment persistence', () => {
  assert.match(send, /const submission = createSubmissionSnapshot\(state, textarea\)/);
  assert.ok(send.indexOf('createSubmissionSnapshot') < send.indexOf('await persistMessageAttachments'));
  assert.match(source, /return Object\.freeze\(\{[\s\S]*images: state\.pasted\.map\(clonePendingImage\)[\s\S]*files: files\.map\(clonePendingFile\)/);
});

test('the user message commits and the authoritative composer clears before generation', () => {
  const commit = send.indexOf('state.messages.push(userMessage)');
  const clear = send.indexOf('clearSentComposerDraft(state, stage, textarea, pasteRow, submission)');
  const generation = send.indexOf('await streamAiReply');
  assert.ok(commit >= 0 && clear > commit && generation > clear);
});

test('pre-commit attachment failure preserves the draft', () => {
  const failure = send.slice(send.indexOf('catch (cause)'), send.indexOf('finally'));
  assert.match(failure, /userMessageCommitted: false/);
  assert.doesNotMatch(failure, /clearSentComposerDraft|resetComposerTextarea/);
});

test('post-commit generation failure cannot restore submitted text', () => {
  const afterGeneration = send.slice(send.indexOf('await streamAiReply'));
  assert.doesNotMatch(afterGeneration, /textarea\.value|clearSentComposerDraft|restore/i);
});

test('textarea reset clears value, inline height, and scroll position', () => {
  assert.match(source, /function resetComposerTextarea[\s\S]*textarea\.value = ''[\s\S]*textarea\.style\.height = 'auto'[\s\S]*textarea\.scrollTop = 0/);
});

test('only submitted attachments transfer out of the live draft', () => {
  assert.match(source, /new Set\(submission\.images\.map[\s\S]*new Set\(submission\.files\.map[\s\S]*state\.pasted = state\.pasted\.filter[\s\S]*state\.files = state\.files\.filter/);
});

test('revision checks reject stale autosaves and preserve a newer draft', () => {
  assert.match(source, /draft\.revision !== liveState\.draftRevision\) return/);
  assert.match(source, /submittedDraftIsStillCurrent[\s\S]*else \{\s*scheduleDraftAutosave\(state, textarea\)/);
});

test('successful commit removes the persisted conversation draft', () => {
  assert.match(source, /localStorage\.removeItem\(composerDraftStorageKey\(chatStore\.activeId\)\)/);
  assert.match(source, /readComposerDraft\(chat\.id\)/);
});

test('Enter sends, Shift+Enter remains a newline, and duplicate sends are locked', () => {
  assert.match(source, /ev\.key === 'Enter' && !ev\.shiftKey/);
  assert.match(send, /if \(state\.isSending\) return \{ userMessageCommitted: false/);
  assert.ok(send.indexOf('state.isSending = true') < send.indexOf('await persistMessageAttachments'));
});

test('Stop controls generation without reading or clearing the next draft', () => {
  const abortStart = source.indexOf('function abortSend(');
  const abortEnd = source.indexOf('\n/** Mirror fetch', abortStart);
  const abort = source.slice(abortStart, abortEnd);
  assert.match(abort, /controller\.abort\(\)/);
  assert.doesNotMatch(abort, /textarea|draftRevision|clearSentComposerDraft/);
});
