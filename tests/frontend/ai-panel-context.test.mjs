import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const APP = read('frontend/js/app.ts');
const MAIN = read('frontend/js/main.ts');
const CONFIG = read('frontend/js/config.js');
const AI_ASK = read('frontend/js/features/ai-chat/ai-ask.ts');
const CSS = read('frontend/css/styles.css');

test('Ctrl/Cmd + wheel resizing works across the complete AI drawer', () => {
  assert.match(APP, /document\.addEventListener\(\s*['"]wheel['"]/);
  assert.match(APP, /closest\(['"]#aiPanel, #drDrawer\.dr-mode-ai['"]\)/);
  assert.match(APP, /event\.preventDefault\(\)/);
  assert.match(APP, /passive:\s*false,\s*capture:\s*true/);
  assert.match(APP, /document\.documentElement\.style\.setProperty\(['"]--ai-panel-font-scale/);
  assert.match(CSS, /--ai-panel-font-scale/);
});

test('production app bundle uses the deployment asset version instead of a fixed cache key', () => {
  assert.match(MAIN, /appAssetVersion/);
  assert.match(MAIN, /\.\/app\.js\?v=['"] \+ encodeURIComponent\(appAssetVersion\)/);
  assert.doesNotMatch(MAIN, /app\.js\?v=12/);
  assert.match(CONFIG, /assetVersion:\s*['"]20260722-pdf-ai-panel-fixes['"]/);
});

test('questions about the visible professor solution attach the visible PDF page', () => {
  assert.match(AI_ASK, /_asksAboutVisibleSolution/);
  assert.match(AI_ASK, /_visibleTextWeak \|\| _asksAboutVisibleSolution \? pdfToImages\(1\)/);
  assert.match(AI_ASK, /\(_visibleTextWeak \|\| _asksAboutVisibleSolution\) && pageImages\[0\]/);
});
