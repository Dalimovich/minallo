import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression coverage for the single-row composer redesign: an earlier pass
// (410000e) added the new Add-files bar but only HID the legacy tutor-mode
// pills / source-mode picker via `.ncb-composer-modes { display: none; }` —
// a second, later `.ncb-composer-modes { display: flex; ... }` rule further
// down the same stylesheet won on cascade order and silently revived the old
// toolbar in the browser even though the tests (which only checked markup
// presence, not the CSS cascade) were green. This test asserts the actual
// HTML/CSS contract instead: the legacy controls are gone from the DOM
// entirely (not just hidden), and no rule anywhere in the stylesheet can
// bring them back.

const html = readFileSync('frontend/views/chatbot/chatbot.html', 'utf8');
const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');

const inputStart = html.indexOf('<div class="ncb-input">');
const inputEnd = html.indexOf('<div class="ncb-actions">', inputStart);
if (inputStart < 0 || inputEnd < 0) throw new Error('composer markup not found in chatbot.html');
const composer = html.slice(inputStart, inputEnd);

test('idle composer contains only Add files, textarea, and Send', () => {
  assert.match(composer, /class="ncb-add-files-trigger"/);
  assert.match(composer, /class="ncb-input-textarea"/);
  assert.match(composer, /class="ncb-send-btn"/);
});

test('the legacy tutor-mode pills and source-mode picker are removed from the DOM, not hidden', () => {
  assert.doesNotMatch(composer, /ncb-tutor-mode/);
  assert.doesNotMatch(composer, /ncb-source-trigger/);
  assert.doesNotMatch(composer, /ncb-source-popup/);
  assert.doesNotMatch(composer, /ncb-composer-modes/);
  // Whole-document check too — these controls must not exist anywhere in
  // chatbot.html, not just outside the extracted composer slice.
  assert.doesNotMatch(html, /ncb-tutor-mode/);
  assert.doesNotMatch(html, /ncb-source-trigger/);
  assert.doesNotMatch(html, /ncb-composer-modes/);
});

test('no stylesheet rule can revive the removed toolbar', () => {
  // The exact regression: a second, later `.ncb-composer-modes` rule with
  // `display: flex` overriding an earlier `display: none`. Assert the
  // selector is entirely gone from the stylesheet, not merely hidden once.
  assert.doesNotMatch(css, /\.ncb-composer-modes\s*\{/);
  assert.doesNotMatch(css, /\.ncb-tutor-mode\b/);
  assert.doesNotMatch(css, /\.ncb-source-control\b/);
  assert.doesNotMatch(css, /\.ncb-source-trigger\b/);
  assert.doesNotMatch(css, /\.ncb-source-popup\b/);
});

test('the Add files popup reuses the existing upload/import elements, not a duplicate control', () => {
  assert.match(composer, /class="ncb-add-files-option ncb-upload-btn" data-testid="chatbot-upload"/);
  assert.match(composer, /class="ncb-add-files-option ncb-import-btn" data-testid="import-course"/);
});
