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

test('a chat\'s own bound course wins over a stale open PDF from a different course', () => {
  // Nothing closes the embedded PDF viewer on a chat switch, so an open PDF
  // can outlive the course it belongs to. The chat's own bound course must
  // be resolved before falling back to the open PDF's course, and an open
  // PDF whose course doesn't match the resolved course must be dropped
  // rather than leaking its document context into the wrong course's request.
  assert.match(
    shell,
    /const courseId = namedCourseFiles\[0\]\?\.courseId \|\| requestSources\[0\]\?\.courseId\s*\n\s*\|\| fallbackCourseId \|\| rawActivePdfContext\?\.courseId;/
  );
  assert.match(
    shell,
    /const activePdfContext = rawActivePdfContext && rawActivePdfContext\.courseId === courseId\s*\n\s*\? rawActivePdfContext\s*\n\s*: null;/
  );
});

test('deselectChatbotSource exists and is exposed for the PDF-close path to call', () => {
  assert.match(shell, /export function deselectChatbotSource\(sourceId: string\): void/);
  assert.match(shell, /active\.selectedSourceIds\.splice\(index, 1\)/);
  assert.match(shell, /\.deselectChatbotSource = deselectChatbotSource/);
});

test('request snapshots preserve course identity and file scope', () => {
  assert.match(shell, /requestSnapshot\?: \{[\s\S]*courseFileScope: CourseFileScope;[\s\S]*courseId\?: string;/);
  assert.match(shell, /courseId: resolveRequestCourseId\(originChat\) \|\| undefined/);
  assert.match(shell, /activeChat\.courseId = original\.requestSnapshot\.courseId \|\| null/);
});
