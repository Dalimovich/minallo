import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const context = fs.readFileSync('frontend/js/features/pdf-viewer/active-pdf-context.ts', 'utf8');
const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('self-contained text questions suppress passive visual capture', () => {
  assert.match(context, /if \(isSelfContainedExplicitQuestionRequest\(question\)\) return false/);
  assert.match(context, /questionCount > 0 && !EXPLICIT_VISUAL_REFERENCE_RE\.test\(question\)/);
});

test('selected PDF region is attached only when the current message refers to it', () => {
  assert.match(shell, /const attachSelectedRegion = currentMessageUsesSelectedRegion\(question\)/);
  assert.match(shell, /selectedRegion: attachSelectedRegion \? payloadPdf\.selectedRegion : undefined/);
  assert.match(shell, /selectedText: attachSelectedRegion \? payloadPdf\.selectedRegion\?\.text : undefined/);
});

test('long-paste Markdown is merged with the composer instruction before RAG routing', () => {
  // The extraction moved into a shared clipboardAttachmentText() helper (also
  // reused when serializing past turns into previousTurns — see
  // chatbot-history-pasted-attachment.test.mjs) but the current-turn RAG
  // question must still merge it in exactly as before.
  assert.match(shell, /function clipboardAttachmentText\(message: ChatMessage\): string\[\] \{/);
  assert.match(shell, /file\.kind === 'text' && file\.source === 'clipboard' && !!file\.textContent\?\.trim\(\)/);
  assert.match(shell, /const attachedClipboardText = clipboardAttachmentText\(last\)/);
  assert.match(shell, /const currentQuestion = \[\.\.\.attachedClipboardText, last\.text\.trim\(\)\]/);
  assert.match(shell, /question: currentQuestion/);
});
