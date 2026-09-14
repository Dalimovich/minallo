import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// This repo has no DOM testing library (no jsdom/happy-dom — see
// notes-intent-flow.test.mjs and notes-intent-resolver.test.mjs for the real
// executable behavioral tests of the parts of this feature that don't touch
// the DOM). renderNotesFileChooser() itself builds and click-wires actual
// DOM nodes, which is why it's kept deliberately thin — its only real job is
// "dispatch the exact same event the working minallo-input mechanism
// already uses," which these assertions verify at the source level.
const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('clicking a Notes file choice reuses the existing minallo-ai-input-submit send path, not a new one', () => {
  const fn = shell.slice(
    shell.indexOf('function renderNotesFileChooser'),
    shell.indexOf('function handleNotesIntent')
  );
  assert.match(fn, /new CustomEvent\('minallo-ai-input-submit', \{ detail: \{ text: filename, surface: 'chatbot' \} \}\)/);
  assert.match(fn, /document\.dispatchEvent/);
  // The listener this reuses already routes through the real composer send
  // path (doSend -> handleIntentRoute -> the pendingNotesAction check) —
  // confirm that listener actually exists and is scoped the same way.
  const listener = shell.slice(
    shell.indexOf("document.addEventListener('minallo-ai-input-submit'")
  ).slice(0, 400);
  assert.match(listener, /ce\.detail\.surface !== 'chatbot'/);
  assert.match(listener, /void doSend\(state, stage, textarea, sendBtn, pasteRow, msgs\)/);
});

test('typing the filename manually is untouched by the chooser — same resolver, same pending check', () => {
  // renderNotesFileChooser must not introduce a second, parallel resolution
  // path: it only dispatches text, exactly like a real typed message would
  // produce, so it flows through the one existing pendingNotesAction check.
  // (Scoped to the function BODY, not its leading doc comment, which
  // legitimately mentions those names in prose.)
  const start = shell.indexOf('function renderNotesFileChooser(bubble: HTMLElement');
  const end = shell.indexOf('bubble.appendChild(card);', start);
  const body = shell.slice(start, end);
  assert.doesNotMatch(body, /runNotesFlow|resolveNotesFileNameFromText|pendingNotesAction/);
});

test('handleNotesIntent renders clickable choices when the flow returns clarifyFiles, plain text otherwise', () => {
  const fn = shell.slice(
    shell.indexOf('async function handleNotesIntent'),
    shell.indexOf('\n}', shell.indexOf('async function handleNotesIntent'))
  );
  assert.match(fn, /outcome\.clarifyFiles\?\.length\) renderNotesFileChooser\(bubble, outcome\.text, outcome\.clarifyFiles\)/);
  assert.match(fn, /else renderRichBubble\(bubble, outcome\.text\)/);
});

test('file choice buttons are disabled immediately on click to prevent a double-submit', () => {
  const fn = shell.slice(
    shell.indexOf('function renderNotesFileChooser'),
    shell.indexOf('function handleNotesIntent')
  );
  assert.match(fn, /\.disabled = true/);
});
