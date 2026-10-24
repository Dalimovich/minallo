import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
const base = process.argv[2] || 'http://127.0.0.1:4178';
const baseline = process.argv[3];
mkdirSync('audit/cinematic', { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  for (const [device, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }]
  ]) {
    if (baseline) {
      const page = await browser.newPage({ viewport });
      await page.goto(baseline);
      await page.screenshot({ path: `audit/cinematic/baseline-${device}.png` });
      await page.close();
    }
    for (const path of ['/', '/student-journey.html', '/german-learning.html']) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [],
        warnings = [],
        failed = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (msg) => {
        if (['warning', 'error'].includes(msg.type())) warnings.push(msg.text());
      });
      page.on('requestfailed', (request) =>
        failed.push({ url: request.url(), error: request.failure()?.errorText })
      );
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
        connectionType: 'cellular4g'
      });
      await page.addInitScript(() => {
        window.__marketingMetrics = { lcp: 0, cls: 0, longTasks: [], interactions: [] };
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__marketingMetrics.lcp = e.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            if (!e.hadRecentInput) window.__marketingMetrics.cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__marketingMetrics.longTasks.push(e.duration);
        }).observe({ type: 'longtask', buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            if (e.interactionId) window.__marketingMetrics.interactions.push(e.duration);
        }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
      });
      await page.goto(base + path);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const slug = path === '/' ? 'home' : path.slice(1, -5);
      await page.screenshot({
        path: `audit/cinematic/${slug}-${device}.png`,
        animations: 'disabled'
      });
      const initial = await page.evaluate(() => ({ ...window.__marketingMetrics }));
      if (path === '/') {
        await page.getByRole('link', { name: 'Choose your journey' }).click();
        await page
          .locator('#choose')
          .screenshot({ path: `audit/cinematic/chooser-${device}.png`, animations: 'disabled' });
      } else {
        await page.locator('#plan').scrollIntoViewIfNeeded();
        await page.getByRole('button', { name: 'Reveal my starting plan' }).click();
        await page.waitForTimeout(150);
      }
      const interactions = await page.evaluate(() => window.__marketingMetrics.interactions);
      results.push({
        device,
        path,
        throttle: '4x CPU; 1.6 Mbps down; 150 ms latency',
        initial,
        longestSampleInteractionMs: interactions.length ? Math.max(...interactions) : null,
        errors,
        warnings,
        failed
      });
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const assets = [
  'css/cinematic-landing.css',
  'css/cinematic-accessibility.css',
  ...['index', 'auth', 'feature-map', 'plan', 'student-demo', 'german-demo'].map(
    (name) => `js/pages/cinematic/${name}.js`
  )
];
const sizes = assets.map((file) => {
  const content = readFileSync(`dist/${file}`);
  return { file, bytes: content.length, gzipBytes: gzipSync(content).length };
});
writeFileSync(
  'audit/cinematic/performance.json',
  JSON.stringify({ results, sizes }, null, 2) + '\n'
);
console.log(JSON.stringify({ results, sizes }, null, 2));
