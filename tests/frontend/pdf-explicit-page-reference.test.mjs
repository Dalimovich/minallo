import { test } from 'node:test';
import assert from 'node:assert/strict';

// ai-ask.ts transitively imports several browser-only modules that attach
// themselves to `window` at module scope (source-link.ts, progress-sync.ts,
// ai-message-actions.ts…). Stub just enough of `window` for those top-level
// assignments to run under Node so the real resolveQuestionPage() can be
// exercised directly instead of regex-matching source text.
globalThis.window = globalThis.window || {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});

const { resolveQuestionPage } = await import('../../frontend/js/features/ai-chat/ai-ask.ts');

// Regression coverage for the FACTORY-illustration incident: a student asked
// about "the illustration on this page", the AI couldn't see it, and even
// after the student clarified "page 13" it still failed. The viewer's own
// scroll position (window.pdfPage) was always used for page-image capture —
// an explicit page number typed into the chat was never read at all.

test('an explicit "page N" mention overrides the viewer scroll position', () => {
  assert.equal(resolveQuestionPage('explain page 13', 40, 304), 13);
  assert.equal(resolveQuestionPage('Erklär mir Seite 13 bitte', 40, 304), 13);
  assert.equal(resolveQuestionPage('s. 13', 40, 304), 13);
});

test('an out-of-range explicit page falls back to the viewer position', () => {
  assert.equal(resolveQuestionPage('what is on page 999', 40, 304), 40);
});

test('no explicit page mention keeps the viewer scroll position', () => {
  assert.equal(
    resolveQuestionPage('Can you explain the illustration on this page?', 40, 304),
    40,
  );
});

test('falls back to page 1 when nothing else is known', () => {
  assert.equal(resolveQuestionPage('explain the illustration on this page', 0, 304), 1);
});
