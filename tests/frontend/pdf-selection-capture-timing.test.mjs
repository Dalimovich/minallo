// Regression test for V6 (QA continuation, 2026-10-13): "select a region,
// Minallo uses exactly the selection" did nothing live. Root cause #1:
// getActivePdfContext() read window.getSelection() lazily at send time, but
// clicking into the chat textarea to type the question (unavoidable — there
// is no way to send without it) collapses the browser's Selection first, so
// the read always came back empty. Live-reproduced: select sentence A, ask
// "Explain this formula.", get an answer; select a DIFFERENT sentence B, ask
// the identical question again, got the IDENTICAL answer — selection
// completely ignored both times.
//
// Fix: captureSelectedPdfRegion() runs from the viewer's own mouseup handler
// (app.ts), while the Selection is still live, and stores the result keyed
// by documentId. getActivePdfContext() now reads that stored value instead
// of window.getSelection() directly.
import test from 'node:test';
import assert from 'node:assert/strict';

// active-pdf-context.ts is a real browser module (reads window/document) —
// this plain Node test run has neither, so stub just enough for
// regionFromSelection()'s own containment/geometry checks to succeed.
const pageWrapEl = {
  dataset: { pageNum: '3', rotation: '0' },
  textContent: 'Moment of a force: M = F×d',
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 800 }),
};
const anchorEl = {
  nodeType: 1,
  closest: (sel) => (sel === '.pdf-page-wrap' ? pageWrapEl : null),
};
const viewerWrapEl = { contains: () => true };

globalThis.window = globalThis;
globalThis.document = {
  getElementById: (id) => (id === 'pdfViewerWrap' ? viewerWrapEl : null),
};
globalThis.Node = { ELEMENT_NODE: 1 };

let currentSelection = null;
window.getSelection = () => currentSelection;

function liveSelection(text) {
  return {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: anchorEl,
    focusNode: anchorEl,
    toString: () => text,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20 }) }),
  };
}

function collapsedSelection() {
  return { rangeCount: 0, isCollapsed: true, toString: () => '' };
}

const {
  setActivePdfViewerState, clearActivePdfViewerState, getActivePdfContext, captureSelectedPdfRegion,
} = await import('../../frontend/js/features/pdf-viewer/active-pdf-context.ts');

function openFakePdf(documentId) {
  clearActivePdfViewerState();
  setActivePdfViewerState({
    courseId: 'course-1', fileName: 'mechanics2.pdf',
    pdfDoc: { numPages: 10 }, documentId, visiblePage: 3, revision: 'rev-1',
  });
}

test('a selection captured at mouseup survives to send time even after the browser collapses it', () => {
  openFakePdf('doc-a');
  currentSelection = liveSelection('Moment of a force: M = F×d');
  captureSelectedPdfRegion(); // fires at mouseup, selection still live
  currentSelection = collapsedSelection(); // clicking the textarea collapsed it

  const ctx = getActivePdfContext();
  assert.equal(ctx.selectedRegion?.text, 'Moment of a force: M = F×d');
});

test('two different selections for the identical question produce distinct grounding evidence', () => {
  openFakePdf('doc-b');
  currentSelection = liveSelection('Moment of a force: M = F×d');
  captureSelectedPdfRegion();
  currentSelection = collapsedSelection();
  const first = getActivePdfContext().selectedRegion?.text;

  currentSelection = liveSelection('Friction: Fs <= mu_s * N');
  captureSelectedPdfRegion();
  currentSelection = collapsedSelection();
  const second = getActivePdfContext().selectedRegion?.text;

  assert.equal(first, 'Moment of a force: M = F×d');
  assert.equal(second, 'Friction: Fs <= mu_s * N');
  assert.notEqual(first, second, 'the identical question must not get the identical cached grounding for two different selections');
});

test('a selection captured on one document never leaks onto a different document opened afterward', () => {
  openFakePdf('doc-c');
  currentSelection = liveSelection('doc-c selected text');
  captureSelectedPdfRegion();

  openFakePdf('doc-d'); // user closes doc-c, opens an unrelated doc-d
  currentSelection = collapsedSelection();
  const ctx = getActivePdfContext();
  assert.equal(ctx.documentId, 'doc-d');
  assert.equal(ctx.selectedRegion, undefined, "doc-c's selection must never attach to doc-d");
});

test('no selection made at all produces no selectedRegion (ordinary question, not stale)', () => {
  openFakePdf('doc-e');
  currentSelection = collapsedSelection();
  captureSelectedPdfRegion(); // nothing to capture
  const ctx = getActivePdfContext();
  assert.equal(ctx.selectedRegion, undefined);
});
