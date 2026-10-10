import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Real chatbot.css in real Chromium: the right Learning panel is an axis
// independent from the active learner workspace.

const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');
const html = `<!doctype html><html><head><style>${css}</style></head><body class="night ncb-fullbleed" style="margin:0">
<div style="height:800px;display:flex">
 <div id="ncbRoot" class="ncb-root ncb-learner-mode" style="display:flex;flex:1;min-width:0">
  <div class="ncb-card" data-context-open="true">
    <aside class="ncb-sidebar" style="width:240px"></aside>
    <div class="ncb-center" data-testid="center" style="flex:1">chat</div>
    <section class="ncb-practice-panel" data-testid="practice">practice</section>
    <section class="ncb-writing-coach-panel" data-testid="wc">wc</section>
    <div class="ncb-context" data-testid="context"><button class="ncb-context-close-btn">x</button></div>
    <button class="ncb-context-reopen" data-testid="reopen">o</button>
  </div>
 </div></div></body></html>`;

async function withPage(fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.setContent(html);
    await fn(page);
  } finally { await browser.close(); }
}
const vis = (page, id) => page.evaluate((i) => {
  const e = document.querySelector(`[data-testid="${i}"]`);
  const r = e.getBoundingClientRect();
  return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0;
}, id);
const setView = (page, cls) => page.evaluate((c) => {
  const root = document.getElementById('ncbRoot');
  root.className = 'ncb-root ncb-learner-mode ' + c;
}, cls);
const setOpen = (page, open) => page.evaluate((o) => { document.querySelector('.ncb-card').dataset.contextOpen = o ? 'true' : 'false'; }, open);

test('the Learning panel stays visible in chat, every practice skill view and Writing Coach', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    for (const cls of ['', 'ncb-view-practice', 'ncb-view-writing-coach', 'ncb-view-speaking']) {
      await setView(page, cls);
      assert.equal(await vis(page, 'context'), true, `context visible in "${cls || 'chat'}"`);
    }
    await setView(page, 'ncb-view-practice');
    assert.equal(await vis(page, 'center'), false);
    assert.equal(await vis(page, 'practice'), true);
    await setView(page, 'ncb-view-writing-coach');
    assert.equal(await vis(page, 'wc'), true);
  });
});

test('workspace fades never fade the Learning panel', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await setView(page, 'ncb-view-practice ncb-workspace-leaving');
    const o = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="context"]')).opacity);
    assert.equal(o, '1');
  });
});

test('closed state is user-owned: workspace changes keep it closed, and the reopen button appears in every workspace', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await setOpen(page, false);
    for (const cls of ['ncb-view-practice', 'ncb-view-writing-coach', 'ncb-view-practice', 'ncb-view-speaking']) {
      await setView(page, cls);
      assert.equal(await vis(page, 'context'), false, `stays closed in ${cls}`);
      assert.equal(await vis(page, 'reopen'), true, `reopen control reachable in ${cls}`);
    }
    // Center expands into the freed space.
    await setView(page, 'ncb-view-practice');
    const closedW = await page.evaluate(() => document.querySelector('[data-testid="practice"]').getBoundingClientRect().width);
    await setOpen(page, true);
    const openW = await page.evaluate(() => document.querySelector('[data-testid="practice"]').getBoundingClientRect().width);
    assert.ok(closedW > openW + 300, 'workspace shrinks by the panel width when reopened');
    assert.equal(await vis(page, 'reopen'), false, 'reopen control hidden while open');
    // No horizontal overflow
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
});

test('reopen button is not shown in the plain chat view (the header button owns that)', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await setOpen(page, false);
    await setView(page, '');
    assert.equal(await vis(page, 'reopen'), false);
  });
});

test('source: workspace transitions never write data-context-open; active item + no-op re-click exist', () => {
  const em = readFileSync('frontend/js/features/chatbot-new/experience-mode.ts', 'utf8');
  assert.doesNotMatch(em, /contextOpen|data-context-open/);
  assert.match(em, /classList\.toggle\('is-active', active\)/);
  assert.match(em, /_workspaceView === 'writing-coach'\) return;/);
  assert.doesNotMatch(css, /ncb-view-(practice|writing-coach|speaking) \.ncb-context\s*[,{]/);
});
