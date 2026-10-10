import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { chromium } from '@playwright/test';

// Runs the REAL boot cover markup/CSS from app/index.html (the app shell —
// frontend/index.html is the static marketing page at / since the app-move
// split, see commit 1debdce2) and the REAL js/boot-cover.js in Chromium.
// Only the app's readiness signals are driven by hand.

const index = readFileSync('frontend/app/index.html', 'utf8');
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

// ── cached profile unblocking the splash (user-data.ts loadUserData, real) ──
// These drive the REAL bundled user-data.ts (esbuild, same pattern as
// boot-order.test.mjs) alongside the real boot-cover.js, so the splash
// behavior is exercised end to end rather than by poking its globals by hand.

let userDataBundlePromise;
function userDataBundle() {
  userDataBundlePromise ??= esbuild.build({
    entryPoints: ['frontend/js/features/auth/user-data.ts'],
    bundle: true, format: 'iife', globalName: '__ud', platform: 'browser', write: false, logLevel: 'silent',
  }).then((r) => r.outputFiles[0].text);
  return userDataBundlePromise;
}

// `profilesImpl` controls what the mocked `profiles` table query does;
// settings/subscriptions resolve to null immediately (not the focus here).
// Uses a real (route-intercepted) origin, not page.setContent's null-origin
// about:blank — localStorage (the profile cache this is testing) throws
// SecurityError on a null origin, so a real URL is required here.
async function withBootAndProfile(profilesImpl, fn) {
  const ud = await userDataBundle();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://boot-cache.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>body{background:#031323;margin:0}${style}</style></head>
        <body>${cover}<div id="ncbRoot" data-role-resolved="true"></div></body></html>`,
    }));
    await page.goto('https://boot-cache.test/index.html');
    await page.addScriptTag({ content: script });
    await page.addScriptTag({ content: ud });
    await page.exposeFunction('__profilesImpl', profilesImpl);
    await page.evaluate(() => {
      window._ssIsLoggedIn = true;
      window.applyProfile = window.__ud.applyProfile;
      window._sb = {
        from: (table) => ({
          select: () => ({
            eq: () => ({
              single: async () => (table === 'profiles' ? window.__profilesImpl() : null),
            }),
          }),
        }),
      };
      window._currentUser = { id: 'u1', email: 'a@b.c' };
      window.SUPA_URL = 'https://x.invalid';
    });
    await fn(page);
  } finally { await browser.close(); }
}

const LEARNER_ROW = { id: 'u1', user_type: 'learner', german_test: 'telc', german_level: 'C1 Hochschule' };

test('a cached learner role unblocks the splash immediately; the authoritative confirm changes nothing visible', { timeout: 60_000 }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withBootAndProfile(async () => { await gate; return LEARNER_ROW; }, async (page) => {
    await page.evaluate((row) => localStorage.setItem('profile_cache_u1', JSON.stringify(row)), LEARNER_ROW);
    await fire(page, 'ss-ready');
    await page.evaluate(() => { void window.__ud.loadUserData('u1'); });
    // Synchronous within loadUserData's first microtask — no network round
    // trip needed — but poll briefly rather than assume exact scheduling.
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('minalloBootCover')).display === 'none',
      { timeout: 2000 }
    );
    assert.equal(await page.evaluate(() => window._userType), 'learner');
    assert.equal(await page.evaluate(() => window._profileResolutionSource), 'cache');
    assert.equal(await page.evaluate(() => document.getElementById('minalloBootRecovery').hidden), true);

    release();
    await page.waitForFunction(() => window._profileResolutionSource === 'network', { timeout: 2000 });
    assert.equal(await coverShown(page), false, 'still revealed after the authoritative confirm');
    assert.equal(await page.evaluate(() => window._userType), 'learner');
    assert.equal(await page.evaluate(() => document.getElementById('minalloBootRecovery').hidden), true);
  });
});

test('with no cache, the splash stays covered until the real row arrives (unchanged behaviour)', { timeout: 60_000 }, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await withBootAndProfile(async () => { await gate; return LEARNER_ROW; }, async (page) => {
    await fire(page, 'ss-ready');
    await page.evaluate(() => { void window.__ud.loadUserData('u1'); });
    await page.waitForTimeout(300);
    assert.equal(await coverShown(page), true, 'no cache to fall back on: must keep waiting');
    assert.equal(await page.evaluate(() => window._profileResolutionState), 'loading');

    release();
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('minalloBootCover')).display === 'none',
      { timeout: 2000 }
    );
    assert.equal(await page.evaluate(() => window._profileResolutionSource), 'network');
  });
});

test('a cached role survives the authoritative fetch failing through every retry: UI stays visible, no recovery screen', { timeout: 60_000 }, async () => {
  await withBootAndProfile(async () => { throw new Error('503'); }, async (page) => {
    await page.evaluate((row) => localStorage.setItem('profile_cache_u1', JSON.stringify(row)), LEARNER_ROW);
    await fire(page, 'ss-ready');
    await page.evaluate(() => { void window.__ud.loadUserData('u1'); });
    assert.equal(await coverShown(page), false, 'cache unblocks immediately');

    // PROFILE_RETRY_DELAYS_MS = [500, 1500, 4000] — give every bounded retry
    // time to fire and fail before asserting nothing regressed.
    await page.waitForTimeout(7000);
    assert.equal(await coverShown(page), false, 'must stay revealed through every failed retry');
    assert.equal(await page.evaluate(() => document.getElementById('minalloBootRecovery').hidden), true,
      'ss-profile-failed must never fire while a cached role is active');
    assert.equal(await page.evaluate(() => window._userType), 'learner');
    assert.equal(await page.evaluate(() => window._profileResolutionSource), 'cache');
  });
});

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
  const first = index.indexOf('<script src="/js/boot-cover.js');
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
