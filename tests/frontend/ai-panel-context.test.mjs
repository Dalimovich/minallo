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
const TYPOGRAPHY = read('frontend/css/typography.css');
const STYLES = read('frontend/css/styles.css');
const PORTAL = read('frontend/pages/portal.html');
const LOADER = read('frontend/js/loader.ts');
const AI_ASK = read('frontend/js/features/ai-chat/ai-ask.ts');
const CSS = read('frontend/css/styles.css');
const DOCUMENT_RAIL_CSS = read('frontend/css/document-rail.css');
const MESSAGE_NAVIGATOR = read('frontend/js/features/message-navigator/message-navigator.ts');

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
  assert.match(DOCUMENT_RAIL, /style\.setProperty\(['"]font-size['"],\s*`\$\{0\.82 \* scale\}rem`,\s*['"]important['"]\)/);
  assert.doesNotMatch(APP, /minallo_ai_font_scale/);
  assert.match(CSS, /--ai-panel-font-scale/);
});

test('production app bundle uses the deployment asset version instead of a fixed cache key', () => {
  assert.match(MAIN, /appAssetVersion/);
  assert.match(MAIN, /\.\/app\.js\?v=['"] \+ encodeURIComponent\(appAssetVersion\)/);
  assert.doesNotMatch(MAIN, /app\.js\?v=12/);
  assert.match(CONFIG, /assetVersion:\s*['"]20260726-chatbot-only-shell-v2['"]/);
  assert.match(INDEX, /config\.js\?v=20260726-chatbot-only-shell-v2/);
});

test('Manrope is the single shared interface font while technical text stays monospace', () => {
  assert.match(INDEX, /family=manrope:400,500,600,700,800&display=swap/);
  assert.match(TYPOGRAPHY, /--font-main:\s*'Manrope',\s*system-ui/);
  assert.match(STYLES, /--font-main:\s*'Manrope',\s*system-ui/);
  assert.match(TYPOGRAPHY, /--font-mono:\s*'JetBrains Mono'/);
  assert.match(TYPOGRAPHY, /code,[\s\S]*pre,[\s\S]*font-family:\s*var\(--font-mono\)/);
  assert.doesNotMatch(TYPOGRAPHY, /'Inter'/);
});

test('AI drawer exposes a persisted typography menu beside its header actions', () => {
  assert.match(PORTAL, /id="drSizeBtn"/);
  assert.match(PORTAL, /id="drFamilyBtn"/);
  assert.match(PORTAL, /id="drSizeMenu"/);
  assert.match(PORTAL, /id="drFamilyMenu"/);
  assert.match(PORTAL, /id="drFontMinus"/);
  assert.match(PORTAL, /id="drFontPlus"/);
  assert.match(PORTAL, /data-font-family="modern"/);
  assert.match(DOCUMENT_RAIL, /minallo_ai_font_family/);
  assert.match(DOCUMENT_RAIL, /familyOptions\.forEach/);
  assert.match(DOCUMENT_RAIL, /querySelectorAll<HTMLElement>\(['"]\.ai-bubble['"]\)/);
  assert.match(DOCUMENT_RAIL_CSS, /\.dr-type-menu/);
  assert.match(DOCUMENT_RAIL_CSS, /--ai-panel-font-family/);
  assert.match(DOCUMENT_RAIL_CSS, /\.dr-header\s*\{[\s\S]*?z-index:\s*60/);
  assert.match(DOCUMENT_RAIL_CSS, /\.dr-type-menu\s*\{[\s\S]*?z-index:\s*100/);
  assert.match(DOCUMENT_RAIL_CSS, /--dr-rail-w:\s*66px/);
  assert.doesNotMatch(MESSAGE_NAVIGATOR, /width:\s*calc\(var\(--dr-rail-w[^\n]+\+\s*24px\)/);
  assert.match(MESSAGE_NAVIGATOR, /width:\s*var\(--dr-rail-w,\s*66px\)/);
  assert.match(LOADER, /document-rail\.css\?v=35/);
  assert.match(INDEX, /loader\.js\?v=50/);
});

test('AI drawer composer uses the compact rounded two-row shell', () => {
  assert.match(
    DOCUMENT_RAIL_CSS,
    /\.dr-drawer\.dr-mode-ai \.dr-host-ai \.ai-input-box\s*\{[\s\S]*?margin:\s*7px 9px 9px;[\s\S]*?padding:\s*9px 11px 7px;[\s\S]*?border-radius:\s*26px;/,
  );
  assert.match(
    DOCUMENT_RAIL_CSS,
    /\.dr-drawer\.dr-mode-ai \.dr-host-ai \.ai-textarea\s*\{[\s\S]*?min-height:\s*34px;[\s\S]*?max-height:\s*92px;/,
  );
  assert.match(
    DOCUMENT_RAIL_CSS,
    /\.dr-drawer \.dr-host-ai \.ai-bottom-row\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*nowrap;/,
  );
  assert.match(
    DOCUMENT_RAIL_CSS,
    /body\.night #portal #app \.dr-drawer \.dr-host-ai \.ai-textarea:focus\s*\{[\s\S]*?background:\s*transparent !important;/,
  );
});

test('questions about the visible professor solution attach the visible PDF page', () => {
  assert.match(AI_ASK, /_asksAboutVisibleSolution/);
  assert.match(AI_ASK, /_visibleTextWeak \|\| _asksAboutVisibleSolution \? pdfToImages\(1,\s*_denseVisualTask\)/);
  assert.match(AI_ASK, /\(_visibleTextWeak \|\| _asksAboutVisibleSolution\) && pageImages\[0\]/);
  assert.match(AI_ASK, /task\|exercise\|problem\|question\|aufgabe/);
});
