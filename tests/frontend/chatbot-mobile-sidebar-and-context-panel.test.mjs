import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression coverage for QA 2.0 Session 2 findings QA2-3/QA2-4/QA2-5
// (minallo-qa/report-qa-2-2026-10-14.md §12.1/§12.2): the context panel and
// chat-history sidebar had no proper phone-width (~375px) treatment, and
// two sidebar buttons lost their accessible name once the sidebar collapsed
// to an icon rail at tablet width (~768px).

const html = readFileSync('frontend/views/chatbot/chatbot.html', 'utf8');
const chatbotCss = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');
const mobileCss = readFileSync('frontend/css/mobile-responsive.css', 'utf8');
const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('QA2-3: the ≤480px breakpoint makes the context panel full-width and opaque', () => {
  const block = /@media \(max-width: 480px\) \{[\s\S]*?\n\}/.exec(chatbotCss)?.[0];
  assert.ok(block, 'expected a ≤480px media block in chatbot.css');
  assert.match(block, /\.ncb-context,[\s\S]*?width: 100vw;[\s\S]*?background: #020617;/);
  // Guard against reintroducing the translucent backdrop that let the chat
  // behind the panel bleed through at phone width.
  assert.doesNotMatch(block, /background: rgba\(2, 6, 23, 0\.85\)/);
});

test('QA2-4: the ≤520px breakpoint turns the sidebar into an off-canvas drawer, not display:none', () => {
  const block = /@media \(max-width: 520px\) \{[\s\S]*?\n\}\n(?!\n*@media)/.exec(mobileCss)?.[0]
    ?? mobileCss.slice(mobileCss.indexOf('@media (max-width: 520px)'));
  assert.doesNotMatch(block, /\.ncb-sidebar \{\s*display: none/);
  assert.match(block, /\.ncb-sidebar \{[\s\S]*?position: fixed !important;[\s\S]*?transform: translateX\(-105%\) !important;/);
  assert.match(block, /\.ncb-sidebar\.ncb-mob-open \{\s*transform: translateX\(0\) !important;/);
  assert.match(block, /\.ncb-mobile-sidebar-btn \{\s*display: grid !important;/);
  assert.match(block, /\.ncb-sidebar-scrim\.show \{\s*display: block;/);
});

test('QA2-4: the tablet icon-rail rules are scoped above 520px so they cannot fight the phone drawer', () => {
  assert.match(chatbotCss, /@media \(min-width: 521px\) and \(max-width: 768px\) \{\s*\.ncb-sidebar,/);
  assert.match(chatbotCss, /@media \(min-width: 521px\) and \(max-width: 768px\) \{\s*\.ncb-sidebar \.ncb-clear-all/);
  assert.doesNotMatch(chatbotCss, /@media \(max-width: 768px\) \{\s*\.ncb-sidebar,/);
});

test('QA2-4: the header exposes a mobile sidebar toggle wired to the sidebar id and a scrim exists', () => {
  assert.match(html, /<button type="button" class="ncb-mobile-sidebar-btn"[^>]*aria-controls="ncbSidebar"/);
  assert.match(html, /<aside class="ncb-sidebar" id="ncbSidebar"/);
  assert.match(html, /<div class="ncb-sidebar-scrim"><\/div>/);
});

test('QA2-4: the toggle lives in .ncb-header-right, not the always-hidden .ncb-header-left', () => {
  // .ncb-header-left is unconditionally `display: none` in chatbot.css (a
  // pre-existing, unrelated rule — the header title/icon it contains is
  // dead markup). A toggle button placed inside it would be invisible at
  // every viewport, which is exactly what a manual browser check caught
  // during this fix. Pin it to the sibling container that's actually shown.
  assert.match(chatbotCss, /\.ncb-header-left \{\s*display: none;\s*\}/);
  const rightStart = html.indexOf('<div class="ncb-header-right">');
  const rightEnd = html.indexOf('</div>', rightStart);
  const right = html.slice(rightStart, rightEnd);
  assert.match(right, /class="ncb-mobile-sidebar-btn"/);
  const leftStart = html.indexOf('<div class="ncb-header-left">');
  const left = html.slice(leftStart, rightStart);
  assert.doesNotMatch(left, /class="ncb-mobile-sidebar-btn"/);
});

test('QA2-4: shell.ts binds the toggle/scrim/Escape/item-click to open and close the drawer', () => {
  const fn = shell.slice(shell.indexOf('function bindMobileSidebarToggle('));
  assert.match(fn, /querySelector<HTMLButtonElement>\('\.ncb-mobile-sidebar-btn'\)/);
  assert.match(fn, /querySelector<HTMLElement>\('\.ncb-sidebar-scrim'\)/);
  assert.match(fn, /sidebar\.classList\.add\('ncb-mob-open'\)/);
  assert.match(fn, /scrim!?\.classList\.add\('show'\)/);
  assert.match(fn, /e\.key === 'Escape'/);
  assert.match(fn, /closest\('\.ncb-chat-item, \.ncb-new-chat-btn'\)/);
  assert.match(shell, /bindMobileSidebarToggle\(root, sidebar\)/);
});

test('QA2-5: the New chat / Writing Coach / Home sidebar buttons have a static aria-label fallback', () => {
  assert.match(html, /<button type="button" class="ncb-new-chat-btn" data-i18n-aria="cb_new_chat" aria-label="New chat">/);
  assert.match(html, /class="ncb-new-chat-btn ncb-chat-view-only"[^>]*data-i18n-aria="nav_writing_coach" aria-label="Writing Coach">/);
  assert.match(html, /class="ncb-new-chat-btn ncb-writing-coach-view-only"[^>]*data-i18n-aria="nav_home" aria-label="Home">/);
});

test('QA2-5: the aria-label survives even where the sidebar still visually hides the <span> text', () => {
  // The collapsed-rail CSS hiding .ncb-new-chat-btn span is untouched — the
  // button's own aria-label (not the span) is now the source of truth for
  // its accessible name, so hiding the span no longer removes the name.
  assert.match(chatbotCss, /\.ncb-sidebar\[data-collapsed="true"\][\s\S]*?\.ncb-new-chat-btn span,/);
});

test('regression: the mobile sidebar toggle hides while the context panel is open, so it cannot overlap the panel\'s own close button', () => {
  // Caught live, not by the first version of this test: .ncb-context-close-btn
  // (inside the now full-bleed QA2-3 panel) and .ncb-mobile-sidebar-btn (in
  // the outer header) render close enough in the top-right band to overlap
  // at phone width, stealing taps meant for "close panel". A first attempt
  // fixed this with a `.ncb-card[data-context-open="true"] .ncb-mobile-sidebar-btn`
  // CSS rule — it read correctly and this test's regex matched it, but it
  // can NEVER match in the browser: .ncb-mobile-sidebar-btn lives in
  // .ncb-header, a SIBLING of .ncb-card, not a descendant. Only an actual
  // live-browser check caught that. The real fix mirrors the open state
  // onto the toggle via a MutationObserver instead, which works regardless
  // of which pre-existing control (panel-open-btn, context-close-btn, …)
  // changes the attribute.
  const fn = shell.slice(shell.indexOf('function bindMobileSidebarToggle('));
  assert.match(fn, /querySelector<HTMLElement>\('\.ncb-card'\)/);
  assert.match(fn, /new MutationObserver\(syncContextState\)\.observe\(card, \{/);
  assert.match(fn, /attributeFilter: \['data-context-open'\]/);
  assert.match(fn, /card\.getAttribute\('data-context-open'\) === 'true'/);
  assert.match(fn, /toggle\.style\.setProperty\('display', open \? 'none' : '', open \? 'important' : undefined\)/);
  // The dead selector must not come back.
  assert.doesNotMatch(chatbotCss, /\.ncb-card\[data-context-open="true"\] \.ncb-mobile-sidebar-btn/);
  // Structural guard: the toggle must stay outside <main>/.ncb-card, which
  // is exactly why the CSS descendant-selector approach could never work.
  const mainStart = html.indexOf('<main class="ncb-main">');
  const toggleIndex = html.indexOf('class="ncb-mobile-sidebar-btn"');
  assert.ok(toggleIndex >= 0 && toggleIndex < mainStart, 'toggle must render before <main>, i.e. outside .ncb-card');
});

test('i18n: cb_open_sidebar exists for both English and German', () => {
  const lang = readFileSync('frontend/js/features/settings/language.ts', 'utf8');
  assert.match(lang, /cb_open_sidebar: 'Open chat history'/);
  assert.match(lang, /cb_open_sidebar: 'Chatverlauf öffnen'/);
});
