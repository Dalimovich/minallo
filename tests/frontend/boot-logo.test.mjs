import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Runs the REAL boot cover markup/CSS from app/index.html, the REAL
// js/boot-logo.js and the REAL logo + timing-map images in Chromium, and
// checks the pen-written logo animation end to end.

const index = readFileSync('frontend/app/index.html', 'utf8');
const script = readFileSync('frontend/js/boot-logo.js', 'utf8');
const style = index.match(/\/\* Boot cover:[\s\S]*?html\.mn-boot-done #minalloBootCover \{ display: none; \}/)[0];
const cover = index.match(/<div id="minalloBootCover"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)[0];
const LOGO = readFileSync('frontend/assets/minallo-boot-logo.png');
const TIMEMAP = readFileSync('frontend/assets/minallo-boot-timemap.png');

async function withPage({ reducedMotion = 'no-preference', missingTimemap = false, manualClock = false } = {}, fn) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ reducedMotion });
    if (manualClock) {
      // Freeze before the animation starts: image decoding and runner load must
      // not consume any of the interval whose pixel delta we measure below.
      await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
      await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    }
    await page.route('https://boot-logo.test/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/assets/minallo-boot-logo.png') return route.fulfill({ contentType: 'image/png', body: LOGO });
      if (path === '/assets/minallo-boot-timemap.png') {
        return missingTimemap ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ contentType: 'image/png', body: TIMEMAP });
      }
      if (path === '/js/boot-logo.js') return route.fulfill({ contentType: 'text/javascript', body: script });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><style>body{background:#031323;margin:0}${style}</style></head>
          <body>${cover}<script src="/js/boot-logo.js"></script></body></html>`,
      });
    });
    await page.goto('https://boot-logo.test/app/');
    await fn(page);
  } finally { await browser.close(); }
}

// Alpha of the "m" canvas compared with the logo image (dot area excluded).
const revealed = (page) => page.evaluate(async () => {
  const m = document.querySelector('[data-boot-m]');
  const got = m.getContext('2d').getImageData(0, 0, 512, 512).data;
  const img = document.querySelector('.mn-boot-logo img');
  await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0, 512, 512);
  const want = x.getImageData(0, 0, 512, 512).data;
  let have = 0, total = 0, worst = 0;
  for (let y = 0; y < 512; y++) for (let xx = 0; xx < 512; xx++) {
    if (y < 189 && xx >= 376) continue; // the dot has its own layer
    const i = (y * 512 + xx) * 4 + 3;
    total += want[i]; have += got[i];
    worst = Math.max(worst, want[i] - got[i]);
  }
  return { fraction: have / total, worst };
});
const visible = (page, sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).visibility === 'visible', sel);

test('the m is written gradually and ends as the exact logo, with no piece popping in at the end', { timeout: 60_000 }, async () => {
  await withPage({ manualClock: true }, async (page) => {
    await page.waitForSelector('.mn-boot-logo.go', { state: 'attached' });
    assert.equal(await visible(page, '.mn-boot-logo img'), false, 'static logo hidden while animating');
    assert.equal(await visible(page, '[data-boot-m]'), true);

    const samples = [];
    for (let i = 0; i < 9; i++) {
      await page.clock.runFor(200);
      samples.push((await revealed(page)).fraction);
    }
    for (let i = 1; i < samples.length; i++) assert.ok(samples[i] >= samples[i - 1] - 1e-6, `never un-writes: ${samples}`);
    assert.ok(samples.some((f) => f > 0.15 && f < 0.85), `has a visible in-between state: ${samples}`);
    // Exactly 200ms of animation between samples, regardless of wall-clock
    // time spent reading pixels or scheduling this test alongside other tests.
    const jumps = samples.slice(1).map((f, i) => f - samples[i]);
    assert.ok(Math.max(...jumps) < 0.45, `no sudden chunk: ${jumps}`);

    await page.clock.runFor(1200);
    const end = await revealed(page);
    assert.ok(end.fraction > 0.999, `fully written: ${end.fraction}`);
    assert.ok(end.worst <= 1, `every pixel matches the logo: worst alpha gap ${end.worst}`);
    assert.equal(await page.evaluate(() => document.querySelector('.mn-boot-logo').classList.contains('done')), true);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.mn-boot-spark').length), 8);
  });
});

test('reduced motion: the static logo shows and nothing animates', { timeout: 60_000 }, async () => {
  await withPage({ reducedMotion: 'reduce' }, async (page) => {
    await page.waitForTimeout(300);
    assert.equal(await visible(page, '.mn-boot-logo img'), true);
    assert.equal(await visible(page, '[data-boot-m]'), false);
    assert.equal(await page.evaluate(() => document.getElementById('minalloBootCover').classList.contains('mn-boot-anim')), false);
  });
});

test('if an animation image fails to load, the static logo comes back', { timeout: 60_000 }, async () => {
  await withPage({ missingTimemap: true }, async (page) => {
    await page.waitForFunction(() => !document.getElementById('minalloBootCover').classList.contains('mn-boot-anim'), { timeout: 3000 });
    assert.equal(await visible(page, '.mn-boot-logo img'), true);
  });
});

test('the loading screen no longer uses the old 128px favicon as its logo', () => {
  assert.doesNotMatch(cover, /favicon\.png/);
  assert.match(cover, /\/assets\/minallo-boot-logo\.png/);
  assert.match(readFileSync('.gitignore', 'utf8'), /!frontend\/js\/boot-logo\.js/);
});
