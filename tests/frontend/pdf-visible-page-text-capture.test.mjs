// Regression test for the "explain this" wrong-page bug (QA run 2,
// 2026-10-12): MinalloPdfViewerState.pageTexts was reset on every file open
// but never actually populated anywhere in the codebase, so
// getActivePdfContext().pageText was ALWAYS '' and pageTextStatus was ALWAYS
// 'loading' — for every page, of every document, forever. shell.ts then
// built a non-empty-but-content-free "[CURRENTLY VISIBLE PDF PAGE]\nFile:
// X\nPage: N of M\n\n" string from that empty pageText, which fooled every
// backend ".strip()"-truthy evidence check into treating it as real content
// — including an authoritative-override step that overwrote the correct
// DB-indexed page text with that boilerplate. The fix: pdf-viewer.ts's
// existing per-page getTextContent() extraction now also writes into
// pageTexts via setActivePdfViewerState, not just the joined pdfFullText.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// active-pdf-context.ts is a real browser module (reads window/document) —
// this plain Node test run has neither. A plain `getElementById: () => null`
// is enough: isPdfViewerVisible() and regionFromSelection() both already
// handle "no DOM element found" as their normal not-applicable case.
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;

const {
  setActivePdfViewerState, clearActivePdfViewerState, getActivePdfContext,
} = await import('../../frontend/js/features/pdf-viewer/active-pdf-context.ts');

const PDF_VIEWER_SOURCE = readFileSync(
  new URL('../../frontend/js/features/pdf-viewer/pdf-viewer.ts', import.meta.url), 'utf8',
);

function openFakePdf(pageCount = 10) {
  clearActivePdfViewerState();
  setActivePdfViewerState({
    courseId: 'course-1', fileName: 'Mechanics_lecture_03.pdf',
    pdfDoc: { numPages: pageCount },
    documentId: 'doc-1', visiblePage: 1,
  });
}

test('pdf-viewer.ts writes per-page extracted text into pageTexts, not just the joined pdfFullText', () => {
  // Both extraction sites (uploaded-file path and demo/PDF_DATA path) must
  // call setActivePdfViewerState with a pageTexts map built from the SAME
  // `pages` array each already produces — not a parallel, easier-to-forget
  // mechanism.
  const occurrences = [...PDF_VIEWER_SOURCE.matchAll(
    /setActivePdfViewerState\(\{\s*pageTexts:\s*Object\.fromEntries\(pages\.map\(\(text, i\) => \[i \+ 1, text\]\)\),?\s*\}\);/g,
  )];
  assert.equal(occurrences.length, 2, 'both text-extraction code paths (uploaded-file and demo/PDF_DATA) must populate pageTexts');
});

test('getActivePdfContext reports pageTextStatus "loading" before extraction has reached this page — never silently empty-but-ready', () => {
  openFakePdf();
  // No pageTexts entry at all yet for page 1 — mirrors the real window
  // between openFile() resetting pageTexts and the 400/800ms-delayed
  // Promise.all(...) resolving.
  const ctx = getActivePdfContext();
  assert.equal(ctx.pageText, '');
  assert.equal(ctx.pageTextStatus, 'loading');
});

test('getActivePdfContext reports the REAL extracted text for the visible page once extraction completes', () => {
  openFakePdf();
  setActivePdfViewerState({
    pageTexts: { 1: 'Erste Seite: Reibung und Normalkraft.', 2: 'Zweite Seite: Impulserhaltung.' },
  });
  const ctx = getActivePdfContext();
  assert.equal(ctx.pageText, 'Erste Seite: Reibung und Normalkraft.');
  assert.equal(ctx.pageTextStatus, 'ready');
});

test('changing the visible page picks up THAT page\'s text, never a stale one from before the scroll', () => {
  openFakePdf();
  setActivePdfViewerState({
    pageTexts: { 1: 'Seite 1 Inhalt', 9: 'Seite 9: Arabische Reibungsaufgabe.', 10: 'Seite 10: 28 m²' },
  });
  setActivePdfViewerState({ visiblePage: 9 });
  assert.equal(getActivePdfContext().pageText, 'Seite 9: Arabische Reibungsaufgabe.');

  setActivePdfViewerState({ visiblePage: 10 });
  assert.equal(getActivePdfContext().pageText, 'Seite 10: 28 m²');
  // Page 9's text must not leak into page 10's result just because it was
  // captured first, or because of an off-by-one in how `pages[]` indices
  // map to 1-based page numbers.
  assert.doesNotMatch(getActivePdfContext().pageText, /Reibungsaufgabe/);
});

test('a genuinely scanned page (extraction ran, found no text) is reported distinctly from "not extracted yet"', () => {
  openFakePdf();
  // Extraction DID reach page 3 (the key exists) but getTextContent()
  // legitimately found nothing — a real scanned page, not a loading gap.
  setActivePdfViewerState({ pageTexts: { 3: '' } });
  setActivePdfViewerState({ visiblePage: 3 });
  const ctx = getActivePdfContext();
  assert.equal(ctx.pageText, '');
  assert.equal(ctx.pageTextStatus, 'empty_scanned_page', 'must be distinguishable from "loading" — both have an empty pageText, but only one means extraction genuinely found nothing');
});

test('a missing documentId (still indexing / ambiguous duplicate) does not block sending the visible page text', () => {
  // See active-pdf-context.ts's own comment: documentId is legitimately
  // empty sometimes, and must not make the AI blind to the rendered page.
  clearActivePdfViewerState();
  setActivePdfViewerState({
    courseId: 'course-1', fileName: 'Mechanics_lecture_03.pdf',
    pdfDoc: { numPages: 10 }, documentId: '', visiblePage: 5,
    pageTexts: { 5: 'Seite 5 Inhalt' },
  });
  const ctx = getActivePdfContext();
  assert.equal(ctx.documentId, '');
  assert.equal(ctx.pageText, 'Seite 5 Inhalt');
  assert.equal(ctx.pageTextStatus, 'ready');
});
