import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const context = readFileSync('frontend/js/features/pdf-viewer/active-pdf-context.ts', 'utf8');
const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const sourceLink = readFileSync('frontend/js/features/pdf-viewer/source-link.ts', 'utf8');
const viewer = readFileSync('frontend/js/features/pdf-viewer/pdf-viewer.ts', 'utf8');
const panes = readFileSync('frontend/js/features/pdf-viewer/pdf-panes.ts', 'utf8');
const tabs = readFileSync('frontend/js/features/pdf-viewer/pdf-tabs.ts', 'utf8');
const course = readFileSync('frontend/js/features/courses/course-view.ts', 'utf8');

test('all PDF routes converge on the authoritative viewer state', () => {
  assert.match(viewer, /setActivePdfViewerState\(\{/);
  assert.match(panes, /setActivePdfViewerState\(\{/);
  assert.match(sourceLink, /setActivePdfViewerState\(\{ visiblePage: page \}\)/);
  assert.match(tabs, /clearActivePdfViewerState\(\)/);
  assert.match(course, /clearActivePdfViewerState\(\)/);
  assert.match(context, /active_pdf_state_incomplete/);
});

test('document requests cannot silently lose a visibly open PDF', () => {
  assert.match(shell, /isPdfViewerVisible\(\) && !openPdf/);
  assert.match(shell, /code: 'active_pdf_state_incomplete'/);
  assert.match(shell, /activePdfVisible: isPdfViewerVisible\(\)/);
  assert.match(context, /sectionExtraction[\s\S]*requiresVisualPdfEvidence/);
});
