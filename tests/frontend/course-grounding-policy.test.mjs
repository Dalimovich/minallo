import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const html = readFileSync('frontend/views/chatbot/chatbot.html', 'utf8');

test('course files are the visible and persisted default', () => {
  assert.match(html, /ncb-source-mode--active" data-source-mode="course_files"/);
  assert.match(shell, /sourceMode: 'course_files'/);
});

test('outside-knowledge modes require explicit source choices', () => {
  assert.match(html, /data-source-mode="course_plus_general"/);
  assert.match(html, /data-source-mode="general"/);
  assert.match(html, /data-source-mode="internet"/);
});

test('an open PDF is a priority hint unless selected-files-only is active', () => {
  assert.match(shell, /courseFileScope: effectiveCourseFileScope/);
  assert.match(shell, /effectiveCourseFileScope === 'specific_files' && documentIds\.length/);
  assert.match(shell, /activeDocumentId: payloadPdf\.documentId/);
});

test('all-course mode omits hard document filters', () => {
  assert.doesNotMatch(shell, /documentIds\.length \|\| documentNames\.length \? 'specific_files'/);
});
