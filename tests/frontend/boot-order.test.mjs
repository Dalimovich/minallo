import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as esbuild from 'esbuild';
import { chromium } from '@playwright/test';

const read = (f) => readFileSync(f, 'utf8');

// ── source guards for the structural fixes ─────────────────────────────────

test('main.ts awaits app.js, so main.js cannot finish loading before the auth/profile bridge exists', () => {
  const src = read('frontend/js/main.ts');
  assert.match(src, /window\.__minalloAppInitPromise = import\(/);
  assert.match(src, /await window\.__minalloAppInitPromise/);
  assert.doesNotMatch(src, /^import\(\/\* @vite-ignore \*\/ '\.\/app\.js/m, 'the un-awaited import must be gone');
  const loader = read('frontend/js/loader.ts');
  const mainIdx = loader.indexOf("loadScript('js/main.js', 'app-script'");
  const awaitIdx = loader.indexOf('Promise.resolve(window.__minalloAppInitPromise)');
  const nextIdx = loader.indexOf("loadScript('js/app-storage.js'");
  assert.ok(mainIdx > 0 && awaitIdx > mainIdx && awaitIdx < nextIdx, 'loader must await the app init promise right after main.js loads');
});

test('loader refuses to announce ss-ready without the auth/profile bridge', () => {
  const src = read('frontend/js/loader.ts');
  const bridgeCheck = src.indexOf("typeof window._beginProfileResolution !== 'function'");
  const readyFire = src.search(/window\.dispatchEvent\(new Event\('ss-ready'\)\);\s*const scheduleDashboard/);
  assert.ok(bridgeCheck > 0 && readyFire > bridgeCheck);
  assert.match(src, /typeof window\._ensureUserProfile !== 'function'/);
});

test('auth-bridge self-heals a session restored before the bridge existed, via the shared resolver', () => {
  const src = read('frontend/js/features/auth/auth-bridge.ts');
  assert.match(src, /window\._profileResolutionState !== 'ready'/);
  assert.match(src, /beginProfileResolution\(restoredUser\.id\)/);
  assert.match(src, /void ensureUserProfile\(\)/);
});

// ── the platform guarantee the fix relies on, in a real browser ────────────

async function raceOutcome(awaited) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const mainJs = awaited
      ? `window.__initP = import('./app.js'); await window.__initP;`
      : `import('./app.js');`;
    await page.route('https://boot.test/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/index.html')) {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      }
      if (url.endsWith('/main.js')) return route.fulfill({ contentType: 'text/javascript', body: mainJs });
      if (url.endsWith('/app.js')) {
        await new Promise((r) => setTimeout(r, 800)); // slow app.js / auth bridge
        return route.fulfill({ contentType: 'text/javascript', body: 'window.loadUserData = () => {};' });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('https://boot.test/index.html');
    // loader-style: treat main.js's load event as "app ready", then announce ss-ready.
    return await page.evaluate(() => new Promise((resolve) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = '/main.js';
      // loader-style: after main.js loads, await the exposed init promise (if any).
      s.onload = async () => {
        if (window.__initP) await window.__initP;
        resolve({ bridgeAtSsReady: typeof window.loadUserData === 'function' });
      };
      document.body.appendChild(s);
    }));
  } finally { await browser.close(); }
}

test('reproduced: un-awaited app.js import lets ss-ready fire before the bridge exists', { timeout: 60_000 }, async () => {
  assert.equal((await raceOutcome(false)).bridgeAtSsReady, false);
});

test('fixed: awaited app.js import guarantees the bridge exists when main.js reports loaded', { timeout: 60_000 }, async () => {
  assert.equal((await raceOutcome(true)).bridgeAtSsReady, true);
});

// ── real single-flight profile promise (bundled user-data.ts) ──────────────

test('loadUserData / ensureUserProfile share ONE in-flight promise and one profiles request', { timeout: 60_000 }, async () => {
  const bundle = await esbuild.build({
    entryPoints: ['frontend/js/features/auth/user-data.ts'],
    bundle: true, format: 'iife', globalName: '__ud', platform: 'browser', write: false, logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body></body>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const out = await page.evaluate(async () => {
      let profileCalls = 0;
      let release;
      const gate = new Promise((r) => { release = r; });
      const chain = (table) => ({ select: () => ({ eq: () => ({ single: async () => {
        if (table === 'profiles') { profileCalls += 1; await gate; return { id: 'u1', user_type: 'learner', german_test: 'telc', german_level: 'C1 Hochschule' }; }
        return null;
      } }) }) });
      window._sb = { from: chain };
      window._currentUser = { id: 'u1', email: 'a@b.c' };
      window.SUPA_URL = 'https://x.invalid';
      window.applyProfile = () => {};
      const ud = window.__ud;
      ud.beginProfileResolution('u1');
      const a = ud.loadUserData('u1');
      const b = ud.ensureUserProfile();
      const c = ud.loadUserData('u1');
      const same = a === b && b === c;
      const stateWhileWaiting = window._profileResolutionState;
      release();
      await a;
      return { same, profileCalls, stateWhileWaiting, stateAfter: window._profileResolutionState };
    });
    assert.equal(out.same, true, 'all callers must receive the same promise');
    assert.equal(out.profileCalls, 1, 'exactly one profiles request');
    assert.equal(out.stateWhileWaiting, 'loading');
    assert.equal(out.stateAfter, 'ready');
  } finally { await browser.close(); }
});
