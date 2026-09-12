import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldAttachVisiblePdfPage } from '../../frontend/js/features/ai-chat/visible-page-gate.ts';

test('attaches the visible PDF page for ordinary exercise and marked-answer questions', () => {
  const prompts = [
    'answer this question',
    'how many machining steps are necessary?',
    'what did the professor mark?',
    'solve Aufgabe 13.11',
    'Welche Antwort ist angekreuzt?',
    'Berechne das Ergebnis',
  ];

  for (const prompt of prompts) {
    assert.equal(shouldAttachVisiblePdfPage(prompt), true, prompt);
  }
});

test('does not render a page image for unrelated conceptual chat by default', () => {
  assert.equal(shouldAttachVisiblePdfPage('Explain the general history of grinding'), false);
});
