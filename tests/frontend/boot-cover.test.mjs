import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Runs the REAL boot cover markup/CSS from index.html and the REAL
// js/boot-cover.js in Chromium. Only the app's readiness signals are driven by
// hand.

const index = readFileSync('frontend/index.html', 'utf8');
const script = readFileSync('frontend/js/boot-cover.js', 'utf8');
const style = index.match(/\/\* Boot cover:[\s\S]*?html\.mn-boot-done #minalloBootCover \{ display: none; \}/)[0];
const cover = index.match(/<div id="minalloBootCover"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)[0];

async function withPage(loggedIn, fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><style>body{background:#031323;margin:0}${style}</style></head>
      <body>${cover}<div id="app">APP CONTENT Loading your files</div></body></html>`);
    await page.evaluate((li) => { window._ssIsLoggedIn = li; }, loggedIn);
    await page.addScriptTag({ content: script });
    await fn(page);
  } finally { await browser.close(); }
}
const coverShown = (page) => page.evaluate(() => {
  const c = document.getElementById('minalloBootCover');
  return getComputedStyle(c).display !== 'none';
});
const fire = (page, name) => page.evaluate((n) => window.dispatchEvent(new Event(n)), name);

test('first frame: the cover is logo only — no text, no spinner — and sits above the app', { timeout: 60_000 }, async () => {
  await withPage(true, async (page) => {
    assert.equal(await coverShown(page), true);
    const info = await page.evaluate(() => {
      const c = document.getElementById('minalloBootCover');
      const r = c.getBoundingClientRect();
      const top = document.elementFromPoint(20, 20);
      return { text: c.innerText.trim(), imgs: c.querySelectorAll('img').length, w: r.width, h: r.height,
        covered: c.contains(top), pos: getComputedStyle(c).position, recoveryHidden: document.getElementById('minalloBootRecovery').hidden,
        anim: c.querySelectorAll('[class*="spin"],progress').length };
    });
    assert.equal(info.text, '');
    assert.equal(info.imgs, 1);
    assert.equal(info.anim, 0);
    assert.equal(info.covered, true, 'app content must be underneath the cover');
    assert.equal(info.pos, 'fixed');
    assert.equal(info.recoveryHidden, true);
  });
});

test('logged-in: stays covered through ss-ready, profile ready and an unapplied role; reveals only when the role UI is applied', { timeout: 60_000 }, async () => {
  for (const role of ['learner', 'enrolled']) {
    await withPage(true, async (page) => {
      await fire(page, 'ss-ready');
      assert.equal(await coverShown(page), true, 'ss-ready alone must not reveal');
      await page.evaluate((r) => { window._profileResolutionState = 'loading'; window._userType = r; }, role);
      await fire(page, 'ss-profile-updated');
      assert.equal(await coverShown(page), true, 'unresolved profile keeps the cover');
      await page.evaluate((r) => {
        window._profileResolutionState = 'ready'; window._userType = r;
        const root = document.createElement('div'); root.id = 'ncbRoot'; root.dataset.roleResolved = 'false';
        document.body.appendChild(root);
      }, role);
      await fire(page, 'ss-profile-updated');
      assert.equal(await coverShown(page), true, 'role known but experience not applied yet keeps the cover');
      await page.evaluate(() => { document.getElementById('ncbRoot').dataset.roleResolved = 'true'; });
      await fire(page, 'ss-experience-applied');
      assert.equal(await coverShown(page), false, `${role}: interface revealed`);
    });
  }
});

test('profile failure with retries running keeps the logo only; exhausted retries show ONE recovery surface inside the cover', { timeout: 60_000 }, async () => {
  await withPage(true, async (page) => {
    await fire(page, 'ss-ready');
    await page.evaluate(() => { window._profileResolutionState = 'error'; });
    await fire(page, 'ss-profile-updated');
    assert.equal(await coverShown(page), true);
    assert.equal(await page.evaluate(() => document.getElementById('minalloBootCover').innerText.trim()), '');
    await fire(page, 'ss-profile-failed');
    const rec = await page.evaluate(() => {
      const r = document.getElementById('minalloBootRecovery');
      return { hidden: r.hidden, text: r.innerText, buttons: r.querySelectorAll('button').length };
    });
    assert.equal(rec.hidden, false);
    assert.match(rec.text, /Couldn’t load your account/);
    assert.equal(rec.buttons, 2);
    assert.equal(await coverShown(page), true, 'still covering the app');
  });
});

test('logged-out and signed-out paths reveal; show() re-covers for the login transition', { timeout: 60_000 }, async () => {
  await withPage(false, async (page) => {
    assert.equal(await coverShown(page), true);
    await fire(page, 'ss-ready');
    assert.equal(await coverShown(page), false, 'logged-out visitor: landing is the interface');
  });
  await withPage(true, async (page) => {
    await page.evaluate(() => window.MinalloBoot.signedOut());
    assert.equal(await coverShown(page), false, 'auth decided: no session');
    await page.evaluate(() => window.MinalloBoot.show());
    assert.equal(await coverShown(page), true, 'login success re-covers immediately');
  });
});

test('"Loading your workspace" is gone from the product entirely', () => {
  for (const f of ['frontend/views/chatbot/chatbot.html', 'frontend/views/chatbot/chatbot.css',
    'frontend/js/features/chatbot-new/experience-mode.ts', 'frontend/index.html', 'frontend/js/boot-cover.js']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /Loading your workspace|cb_loading_workspace|ncb-role-loading|chatbot-role-loading|ncbRoleResolutionRetry/, f);
  }
});

test('the cover is in RAW index.html before any section/app script, and boot-cover.js loads first', () => {
  const coverIdx = index.indexOf('id="minalloBootCover"');
  assert.ok(coverIdx > index.indexOf('<body'), 'cover is inside <body>');
  assert.ok(coverIdx < index.indexOf('id="ss-sections-root"'), 'cover precedes the app root');
  const first = index.indexOf('<script src="js/boot-cover.js');
  assert.ok(first > 0 && first < index.indexOf('js/ss-ready-marker.js') && first < index.indexOf('js/loader.js'));
  assert.match(index, /html\.mn-boot-done #minalloBootCover \{ display: none; \}/);
  assert.match(readFileSync('.gitignore', 'utf8'), /!frontend\/js\/boot-cover\.js/);
});

test('role safety is unchanged: role surfaces stay hidden until the role is resolved', () => {
  const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');
  assert.match(css, /#ncbRoot:not\(\[data-role-resolved="true"\]\) \.ncb-student-only/);
  assert.match(css, /#ncbRoot:not\(\[data-role-resolved="true"\]\) \.ncb-learner-only/);
  assert.match(readFileSync('frontend/js/features/chatbot-new/experience-mode.ts', 'utf8'), /ss-experience-applied/);
});
