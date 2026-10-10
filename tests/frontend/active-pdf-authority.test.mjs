import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const context = readFileSync('frontend/js/features/pdf-viewer/active-pdf-context.ts', 'utf8');
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

test('viewer capture retains its explicit visual evidence requirement (source wiring)', () => {
  // Actual optional/required evidence behavior is executed in
  // chat-eligibility-runtime and backend test_optional_viewer_evidence.
  assert.match(context, /sectionExtraction[\s\S]*requiresVisualPdfEvidence/);
});

test('opening a file prefers the caller-supplied document id over a fresh filename lookup', () => {
  // Two frontend paths used to resolve a file's document id two different
  // ways: the Study Panel by exact storage path (bindDocumentsToCourseFiles),
  // openFile()'s own lookup by bare filename + first ready match. When a
  // course has two document rows sharing a filename (a re-upload/reindex
  // that created a new row instead of replacing the old one), those two
  // mechanisms could resolve to DIFFERENT rows for the "same" open file —
  // the request's retrievalScope.documentIds (Study Panel's id) and
  // viewerContext.documentId (openFile's own id) would then disagree,
  // which crashed /ask-stream with an unhandled internal_error.
  assert.match(viewer, /_document\?:\s*\{\s*id\?:\s*string\s*\}/);
  assert.match(viewer, /const knownDocumentId = f\._document\?\.id \|\| null/);
  assert.match(viewer, /documentId: knownDocumentId,/);
  assert.match(viewer, /if \(course\.id && !knownDocumentId\)/);
  // The fallback lookup itself must not silently pick one of several
  // same-named documents either — ambiguity must stay unresolved (null)
  // rather than guessing, same principle as the backend's own
  // ambiguous_document_name handling.
  assert.match(viewer, /matches\.length === 1 && matches\[0\]!\.id/);
});
