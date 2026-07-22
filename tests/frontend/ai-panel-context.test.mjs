import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const APP = read('frontend/js/app.ts');
const AI_ASK = read('frontend/js/features/ai-chat/ai-ask.ts');
const CSS = read('frontend/css/styles.css');

test('Ctrl/Cmd + wheel resizing works across the complete AI drawer', () => {
  assert.match(APP, /document\.addEventListener\(\s*['"]wheel['"]/);
  assert.match(APP, /closest\(['"]#aiPanel, #drDrawer\.dr-mode-ai['"]\)/);
  assert.match(APP, /event\.preventDefault\(\)/);
  assert.match(APP, /passive:\s*false,\s*capture:\s*true/);
  assert.match(CSS, /--ai-panel-font-scale/);
});

test('questions about the visible professor solution attach the visible PDF page', () => {
  assert.match(AI_ASK, /_asksAboutVisibleSolution/);
  assert.match(AI_ASK, /_visibleTextWeak \|\| _asksAboutVisibleSolution \? pdfToImages\(1\)/);
  assert.match(AI_ASK, /\(_visibleTextWeak \|\| _asksAboutVisibleSolution\) && pageImages\[0\]/);
});
