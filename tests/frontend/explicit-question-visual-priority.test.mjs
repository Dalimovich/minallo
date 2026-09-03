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
  assert.match(shell, /const attachedClipboardText = \(last\.files \|\| \[\]\)/);
  assert.match(shell, /file\.source === 'clipboard'/);
  assert.match(shell, /const currentQuestion = \[\.\.\.attachedClipboardText, last\.text\.trim\(\)\]/);
  assert.match(shell, /question: currentQuestion/);
});
