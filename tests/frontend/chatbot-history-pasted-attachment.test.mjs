import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression test for a gap where a long pasted block (see
// addPastedMarkdownAttachment / chatbot-pasted-markdown.test.mjs) is stored
// on a user message's `files` array rather than its `text`. The CURRENT turn
// already merges that attachment text back in via ragEligibility() before
// building the /ask-stream question, but the history builder that turns past
// turns into `previousTurns` only ever read `m.text` — so once that turn
// scrolled out of "current", its pasted content vanished from history
// entirely (not truncated, just gone), and a later "why is X missing from
// what I pasted" question was answered with zero knowledge of the paste.

const source = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

const helperStart = source.indexOf('function clipboardAttachmentText(');
const helperEnd = source.indexOf('\n}', helperStart) + 2;
const helper = source.slice(helperStart, helperEnd);

const priorTurnsStart = source.indexOf('const priorTurns = requestMessages');
const priorTurnsEnd = source.indexOf('\n      const followUpDoc', priorTurnsStart);
const priorTurns = source.slice(priorTurnsStart, priorTurnsEnd);

const ragEligibilityStart = source.indexOf('function ragEligibility(');
const ragEligibility = source.slice(ragEligibilityStart, ragEligibilityStart + 1200);

test('a shared helper extracts clipboard-pasted attachment text from a message', () => {
  assert.ok(helperStart >= 0, 'clipboardAttachmentText helper must exist');
  assert.match(helper, /file\.kind === 'text' && file\.source === 'clipboard' && !!file\.textContent\?\.trim\(\)/);
  assert.match(helper, /\.map\(\(file\) => file\.textContent!\.trim\(\)\)/);
});

test('the current-turn RAG question still merges clipboard attachment text', () => {
  assert.match(ragEligibility, /clipboardAttachmentText\(last\)/);
});

test('previousTurns merges a past user turn\'s clipboard attachment text, not just m.text', () => {
  assert.ok(priorTurnsStart >= 0, 'priorTurns construction must exist');
  // The fix: past user turns must call the same clipboard-merge helper used
  // for the current turn, so pasted content survives into history.
  assert.match(priorTurns, /clipboardAttachmentText\(m\)/);
  assert.match(priorTurns, /\[\.\.\.clipboardAttachmentText\(m\), m\.text\.trim\(\)\]\.filter\(Boolean\)\.join\('\\n\\n'\)/);
});

test('regression guard: priorTurns no longer filters past turns solely on truthy m.text', () => {
  // This was the actual bug: an attachment-only turn (short instruction +
  // long clipboard file, or no typed text at all) with a non-empty `files`
  // array but whatever `m.text` value would previously be represented in
  // previousTurns using ONLY m.text, silently dropping the pasted content.
  // Guard against reintroducing that naive filter/map.
  assert.doesNotMatch(
    priorTurns,
    /\.filter\(\(m\) => \(m\.role === 'user' \|\| m\.role === 'assistant'\) && m\.text\)/
  );
});

test('previousTurns still preserves assistant routing provenance after the merge refactor', () => {
  assert.match(priorTurns, /answerMode: m\.answerMode/);
  assert.match(priorTurns, /groundingMode: m\.groundingMode/);
  assert.match(priorTurns, /sourceScope: m\.sourceScope/);
  assert.match(priorTurns, /sanitizeChatbotDiagrams\(text, !!m\.allowDiagrams\)/);
});

test('a turn that merges to empty text (no typed text, no attachment) is dropped, not sent blank', () => {
  assert.match(priorTurns, /\.filter\(\(\{ text \}\) => !!text\)/);
});
