import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspaceLibrary = fs.readFileSync(path.join(root, 'frontend/js/features/chatbot-new/workspace-library.ts'), 'utf8');
const courseFilesWorkspace = fs.readFileSync(path.join(root, 'frontend/js/features/chatbot-new/course-files-workspace.ts'), 'utf8');
const aiMarkdown = fs.readFileSync(path.join(root, 'frontend/js/features/ai-chat/ai-markdown.ts'), 'utf8');
const courseViewPath = 'frontend/js/features/courses/course-view.ts';
const appPath = 'frontend/js/app.ts';
const pdfControlsPath = 'frontend/js/features/pdf-viewer/pdf-controls.ts';
const pdfTabsPath = 'frontend/js/features/pdf-viewer/pdf-tabs.ts';

function gitShowHead(relativePath) {
  return execFileSync('git', ['show', `HEAD:${relativePath}`], { cwd: root, encoding: 'utf8' });
}

test('openStudyToolWorkspace("files", ...) mounts mountCourseFilesWorkspace via a dynamic import of course-files-workspace.js', () => {
  assert.match(workspaceLibrary, /export type StudyWorkspaceKind = 'examforge' \| 'flashcards' \| 'deep_learn' \| 'cheatsheet' \| 'files';/);
  assert.match(workspaceLibrary, /kind === 'files'/);
  assert.match(workspaceLibrary, /await import\('\.\/course-files-workspace\.js'\)/);
  assert.match(workspaceLibrary, /filesModule\.mountCourseFilesWorkspace\(staging, course, options\)/);
  // 'files' is a native chatbot-new module like 'deep_learn' — no legacy
  // portal-feature bundle should be requested for it.
  assert.match(workspaceLibrary, /kind !== 'deep_learn' && kind !== 'files'/);
});

test('course-files-workspace.ts exports a synchronous mountCourseFilesWorkspace(target, course, options) that reuses renderCourseDetail (no duplicated upload/delete/reindex logic)', () => {
  assert.match(courseFilesWorkspace, /export function mountCourseFilesWorkspace\(\s*\n?\s*target: HTMLElement,\s*\n?\s*course: LibraryCourse,\s*\n?\s*options: Record<string, unknown>/);
  assert.match(courseFilesWorkspace, /import \{ renderCourseDetail, type LibraryCourse \} from '\.\/workspace-library\.js';/);
  assert.match(courseFilesWorkspace, /void renderCourseDetail\(root, course\)/);
  // Reused engine only — this module must not reimplement upload/delete/reindex.
  assert.doesNotMatch(courseFilesWorkspace, /_ufUpload|_ufDeleteRemote|indexExistingDocument/);
});

test('renderCourseDetail is exported from workspace-library.ts for reuse by the Files popup', () => {
  assert.match(workspaceLibrary, /export async function renderCourseDetail\(panel: HTMLElement, course: LibraryCourse\): Promise<void>/);
});

test('the "Open course files" AI action prefers the popup-native Course Files workspace and falls back to the legacy tab navigation, never removing it', () => {
  assert.match(aiMarkdown, /async function _launchCourseFilesWorkspace/);
  assert.match(aiMarkdown, /mod\.openStudyToolWorkspace\('files', targetCourseId, \{\}\)/);
  assert.match(aiMarkdown, /action === 'open_files' && btn\.closest\('\.ncb-root'\) && targetCourseId/);
  // Fallback to the existing tab-navigation path must remain intact.
  assert.match(aiMarkdown, /_runCourseTabAction\(tab, targetCourseId\)/);
  assert.match(aiMarkdown, /open_files: 'files',/);
});

function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

test('the legacy Course Overview Files tab and core PDF-viewer navigation files are unchanged from HEAD (content-identical, ignoring line-ending normalization)', () => {
  for (const relativePath of [courseViewPath, appPath, pdfControlsPath, pdfTabsPath]) {
    const head = normalizeEol(gitShowHead(relativePath));
    const working = normalizeEol(fs.readFileSync(path.join(root, relativePath), 'utf8'));
    assert.equal(working, head, `${relativePath} must be unchanged from HEAD — Files-popup work must not touch it`);
  }
});

test('#coFilesPanel and the Files tab button still exist in course-view.ts, unchanged', () => {
  const courseView = fs.readFileSync(path.join(root, courseViewPath), 'utf8');
  assert.match(courseView, /coFilesPanel/);
  assert.match(courseView, /data-course-tab="files"/);
});
