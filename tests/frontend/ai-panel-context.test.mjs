import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const APP = read('frontend/js/app.ts');
const DOCUMENT_RAIL = read('frontend/js/features/document-rail/document-rail.ts');
const MAIN = read('frontend/js/main.ts');
const CONFIG = read('frontend/js/config.js');
const INDEX = read('frontend/index.html');
const PORTAL = read('frontend/pages/portal.html');
const AI_ASK = read('frontend/js/features/ai-chat/ai-ask.ts');
const CSS = read('frontend/css/styles.css');
const DOCUMENT_RAIL_CSS = read('frontend/css/document-rail.css');

test('Ctrl/Cmd + wheel resizing works across the complete AI drawer', () => {
  assert.match(DOCUMENT_RAIL, /drawer\.addEventListener\(['"]wheel['"]/);
  assert.match(DOCUMENT_RAIL, /drawer\.addEventListener\(['"]mousewheel['"]/);
  assert.match(DOCUMENT_RAIL, /classList\.contains\(['"]dr-mode-ai['"]\)/);
  assert.match(DOCUMENT_RAIL, /event\.preventDefault\(\)/);
  assert.match(DOCUMENT_RAIL, /modifierHeld/);
  assert.match(DOCUMENT_RAIL, /passive:\s*false,\s*capture:\s*true/);
  assert.match(DOCUMENT_RAIL, /document\.documentElement\.style\.setProperty\(['"]--ai-panel-font-scale/);
  assert.match(DOCUMENT_RAIL, /panel\?\.style\.setProperty\(['"]--ai-panel-font-scale/);
  assert.match(DOCUMENT_RAIL, /messages\?\.style\.setProperty\(['"]--ai-panel-font-scale/);
  assert.doesNotMatch(APP, /minallo_ai_font_scale/);
  assert.match(CSS, /--ai-panel-font-scale/);
});

test('production app bundle uses the deployment asset version instead of a fixed cache key', () => {
  assert.match(MAIN, /appAssetVersion/);
  assert.match(MAIN, /\.\/app\.js\?v=['"] \+ encodeURIComponent\(appAssetVersion\)/);
  assert.doesNotMatch(MAIN, /app\.js\?v=12/);
  assert.match(CONFIG, /assetVersion:\s*['"]20260722-ai-typography-menu-v2['"]/);
  assert.match(INDEX, /config\.js\?v=20260722-ai-typography-menu-v2/);
});

test('AI drawer exposes a persisted typography menu beside its header actions', () => {
  assert.match(PORTAL, /id="drTypeBtn"/);
  assert.match(PORTAL, /id="drFontMinus"/);
  assert.match(PORTAL, /id="drFontPlus"/);
  assert.match(PORTAL, /id="drFontFamily"/);
  assert.match(DOCUMENT_RAIL, /minallo_ai_font_family/);
  assert.match(DOCUMENT_RAIL, /familySelect\.addEventListener\(['"]change['"]/);
  assert.match(DOCUMENT_RAIL, /querySelectorAll<HTMLElement>\(['"]\.ai-bubble['"]\)/);
  assert.match(DOCUMENT_RAIL_CSS, /\.dr-type-menu/);
  assert.match(DOCUMENT_RAIL_CSS, /--ai-panel-font-family/);
});

test('questions about the visible professor solution attach the visible PDF page', () => {
  assert.match(AI_ASK, /_asksAboutVisibleSolution/);
  assert.match(AI_ASK, /_visibleTextWeak \|\| _asksAboutVisibleSolution \? pdfToImages\(1\)/);
  assert.match(AI_ASK, /\(_visibleTextWeak \|\| _asksAboutVisibleSolution\) && pageImages\[0\]/);
  assert.match(AI_ASK, /task\|exercise\|problem\|question\|aufgabe/);
});
