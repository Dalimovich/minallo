import assert from 'node:assert/strict';
import test from 'node:test';
import { setActivePdfViewerState, getActivePdfContext, captureStablePdfSnapshot, requiresVisualPdfEvidence } from '../../frontend/js/features/pdf-viewer/active-pdf-context.ts';

const view = { hidden: false };
globalThis.window = { getSelection: () => null };
globalThis.document = { getElementById: id => id === 'pdfView' ? view : null };
globalThis.getComputedStyle = () => ({ display: view.hidden ? 'none' : 'block' });
function init(getPage = async () => { throw new Error('injected renderer failure'); }) {
  view.hidden = false;
  setActivePdfViewerState({courseId:'course-a', documentId:'doc-a', fileName:'lecture.pdf', pdfDoc:{numPages:10,getPage}, visiblePage:7, pageTexts:{7:'Context '.repeat(100)},pageTextErrors:{},openSequence:1});
}
test('observed: unrelated self-contained formula query requires failed PDF capture', async () => {
  init();
  const q = 'What is the quadratic formula?';
  assert.equal(requiresVisualPdfEvidence(q, getActivePdfContext()), true);
  assert.deepEqual(await captureStablePdfSnapshot(q, 'whole_course'), {status:'capture_failed',reason:'injected renderer failure'});
});
test('observed: hidden viewer still supplies active context', () => {
  init(); view.hidden = true;
  assert.equal(getActivePdfContext().documentId, 'doc-a');
});
