import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requiresVisualPdfEvidence } from '../../frontend/js/features/pdf-viewer/active-pdf-context.ts';

function fakeContext(overrides = {}) {
  return {
    courseId: 'course-1',
    documentId: 'doc-1',
    fileName: 'lecture.pdf',
    visiblePage: 1,
    pageCount: 10,
    pageText: 'a'.repeat(600),
    pageTextStatus: 'ready',
    ...overrides,
  };
}

test('a visual keyword always requires the page image, even inside a "?" question', () => {
  // This is the exact shape of question that used to be misclassified: it
  // contains a "?" (so isSelfContainedExplicitQuestionRequest alone would
  // call it self-contained) but it's asking about something only visible on
  // the rendered page (a checkmark), not something answerable from text alone.
  assert.equal(requiresVisualPdfEvidence('Welche Antwort ist angekreuzt?', fakeContext()), true);
  assert.equal(requiresVisualPdfEvidence('Which answer is checked?', fakeContext()), true);
  assert.equal(requiresVisualPdfEvidence('What does the green arrow point to?', fakeContext()), true);
});

test('an ordinary self-answerable question does not require the page image', () => {
  assert.equal(
    requiresVisualPdfEvidence('how many machining steps are necessary?', fakeContext()),
    false
  );
});

test('low-confidence or missing page text still requires the page image', () => {
  assert.equal(
    requiresVisualPdfEvidence('Explain this.', fakeContext({ pageTextStatus: 'empty_scanned_page' })),
    true
  );
  assert.equal(
    requiresVisualPdfEvidence('Explain this.', fakeContext({ pageText: 'short' })),
    true
  );
});
