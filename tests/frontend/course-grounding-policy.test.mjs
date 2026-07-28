import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const html = readFileSync('frontend/views/chatbot/chatbot.html', 'utf8');

test('auto is the visible and persisted default for missing or invalid modes', () => {
  assert.match(html, /ncb-source-mode--active" data-source-mode="auto"/);
  assert.match(shell, /\? v : 'auto'/);
  assert.match(shell, /sourceMode: 'auto'/);
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

test('bound active course reaches whole-course retrieval without selected files', () => {
  assert.match(shell, /courseId: string \| null/);
  assert.match(shell, /const fallbackCourseId = resolveRequestCourseId\(active\)/);
  assert.match(shell, /effectiveCourseFileScope === 'specific_files' && documentIds\.length/);
  assert.doesNotMatch(shell, /no course files are attached to this chat/i);
  assert.match(shell, /No active course is bound to this chat/);
  assert.match(shell, /No files are selected for this request/);
  assert.match(shell, /normaliseCourseFileScope\(active\.courseFileScope\) === 'specific_files'[\s\S]*documentIds\.length === 0[\s\S]*return null/);
});

test('request snapshots preserve course identity and file scope', () => {
  assert.match(shell, /requestSnapshot\?: \{[\s\S]*courseFileScope: CourseFileScope;[\s\S]*courseId\?: string;/);
  assert.match(shell, /courseId: resolveRequestCourseId\(originChat\) \|\| undefined/);
  assert.match(shell, /activeChat\.courseId = original\.requestSnapshot\.courseId \|\| null/);
});
