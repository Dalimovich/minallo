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
  assert.match(css, /body\.ncb-pdf-workspace-open \.ncb-center \{ flex: 1 1 0; \}/);
  assert.match(css, /body\.ncb-pdf-workspace-open \.ncb-context[\s\S]*?max-width: min\(50vw, 760px\)/);
});

test('PDF refits after the asynchronous document open settles', () => {
  assert.match(workspace, /Promise\.resolve\(opened\)\.finally/);
  assert.match(workspace, /requestAnimationFrame\(refitWorkspacePdf\)/);
});

test('wide formulas, tables, and code scroll locally', () => {
  assert.match(css, /\.ncb-bubble-body \.katex-display[\s\S]*?overflow-x: auto/);
  assert.match(css, /\.ncb-bubble-body pre/);
  assert.match(css, /\.ncb-bubble-body \.md-answer-table__scroll/);
  assert.match(css, /\.ncb-learning-journey[\s\S]*?min-width: 0/);
});
