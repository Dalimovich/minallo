import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');
const workspace = readFileSync('frontend/js/features/chatbot-new/workspace-library.ts', 'utf8');

test('chat and PDF flex chain permits both panes to shrink inside the viewport', () => {
  for (const selector of ['.ncb-main', '.ncb-card', '.ncb-center-inner', '.ncb-context']) {
    assert.match(css, new RegExp(selector.replace('.', '\\\.') + '[\\s\\S]{0,320}min-width: 0'));
  }
  assert.match(css, /@media \(min-width: 1025px\)[\s\S]*?\.ncb-card \{[\s\S]*?overflow: hidden/);
  assert.match(css, /body\.ncb-pdf-workspace-open \.ncb-center \{[\s\S]*?width: 0;[\s\S]*?flex: 1 1 0/);
  // The pane's default/initial width may still be capped at min(38vw, 680px)
  // — that's just the opening size — but it must NOT also be a permanent
  // max-width, or the drag-resize JS can shrink the pane but never widen it
  // back past its opening size. See chatbot-pdf-resize-behavior.test.mjs for
  // the real behavioral regression test of that bug.
  assert.match(css, /body\.ncb-pdf-workspace-open \.ncb-context \{[\s\S]*?max-width: none/);
  assert.doesNotMatch(css, /body\.ncb-pdf-workspace-open \.ncb-context \{[\s\S]*?max-width: min\(38vw, 680px\)/);
});

test('PDF waits for its rendered canvas before fitting to the hosted pane', () => {
  assert.match(workspace, /function refitWorkspacePdfAfterRender/);
  assert.match(workspace, /new MutationObserver/);
  assert.match(workspace, /\.pdf-page-wrap canvas/);
  assert.match(workspace, /viewer\.renderPages\?\.\(\)/);
});

test('exam-driven workspace width changes trigger a settled PDF rerender', () => {
  assert.match(workspace, /new ResizeObserver/);
  assert.match(workspace, /Math\.abs\(width - lastObservedWidth\) < 1/);
  assert.match(workspace, /window\.setTimeout\(\(\) => \{/);
  assert.match(workspace, /viewer\.renderPages\?\.\(\)/);
});

test('PDF pane resize bounds are not derived from the pane\'s own moving left edge', () => {
  // Regression guard for the one-way-resize bug: `workspaceRect.right -
  // paneRect.left` is self-referential (it shrinks as the pane shrinks,
  // ratcheting the max width down every drag). The real behavioral test of
  // the fix lives in chatbot-pdf-resize-behavior.test.mjs; this just keeps
  // the broken formula from silently coming back.
  assert.doesNotMatch(workspace, /workspaceRect\.right - paneRect\.left/);
  assert.match(workspace, /Math\.min\(bounds\.max, Math\.max\(bounds\.min, width\)\)/);
  assert.match(workspace, /observer\?\.observe\(workspace\)/);
  assert.match(workspace, /requestAnimationFrame\(\(\) => \{\s*requestAnimationFrame\(\(\) => applyWidth\(initialWidth\)\)/);
});

test('saved PDF widths are restored through the same live geometry clamp', () => {
  assert.match(workspace, /localStorage\.getItem\(PDF_WIDTH_KEY\)/);
  assert.match(workspace, /if \(Number\.isFinite\(saved\)\) initialWidth = saved/);
  assert.doesNotMatch(workspace, /cardWidth - \(sidebar\?\.offsetWidth \|\| 0\) - 420/);
});

test('PDF geometry test ids identify the outer pane, viewer shell, and viewer', () => {
  assert.match(workspace, /context\.dataset\.testid = 'pdf-pane'/);
  assert.match(workspace, /pdfHost\.dataset\.testid = 'pdf-viewer-shell'/);
  assert.match(workspace, /wrap\.dataset\.testid = 'pdf-viewer'/);
});

test('wide formulas, tables, and code scroll locally', () => {
  assert.match(css, /\.ncb-bubble-body \.katex-display[\s\S]*?overflow-x: auto/);
  assert.match(css, /\.ncb-bubble-body pre/);
  assert.match(css, /\.ncb-bubble-body \.md-answer-table__scroll/);
  assert.match(css, /\.ncb-learning-journey[\s\S]*?min-width: 0/);
});
