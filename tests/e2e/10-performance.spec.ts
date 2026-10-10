import { test, expect } from '@playwright/test';

// Performance budget tests — catch accidental regressions in load time or bundle size.

const LOAD_TIME_BUDGET_MS = 8000;   // page must be interactive within 8 s on a fresh load
const JS_BUNDLE_SIZE_BUDGET = 2 * 1024 * 1024; // 2 MB total JS transferred

test.describe('Performance budget', () => {
  test('page becomes interactive within budget', async ({ page }) => {
    const start = Date.now();

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Wait for any of the app's own "ready" signals
    await page.waitForFunction(
      () =>
        !!document.querySelector('#courseAddBtn') ||
        !!document.querySelector('#sdCourseList') ||
        !!document.querySelector('#welcomeState') ||
        !!document.querySelector('#authEmail') ||
        !!document.querySelector('#nlNavSignIn') ||
        !!document.querySelector('#nlNavStartFree') ||
        !!document.querySelector('#landingLoginBtn') ||
        document.body?.getAttribute('data-ss-ready') === 'true',
      { timeout: LOAD_TIME_BUDGET_MS }
    );

    const elapsed = Date.now() - start;
    expect(elapsed, `Page took ${elapsed} ms — budget is ${LOAD_TIME_BUDGET_MS} ms`).toBeLessThan(LOAD_TIME_BUDGET_MS);
  });

  test('total JS transferred stays under budget', async ({ page }) => {
    const origin = new URL(process.env.E2E_BASE_URL || 'http://localhost:8888').origin;
    let totalJs = 0;

    page.on('response', async resp => {
      const url = resp.url();
      const ct = resp.headers()['content-type'] || '';
      if (url.startsWith(origin) && ct.includes('javascript')) {
        const body = await resp.body().catch(() => Buffer.alloc(0));
        totalJs += body.length;
      }
    });

    await page.goto('/', { waitUntil: 'networkidle' }).catch(() => {});

    expect(
      totalJs,
      `JS transferred ${(totalJs / 1024).toFixed(0)} KB — budget is ${(JS_BUNDLE_SIZE_BUDGET / 1024).toFixed(0)} KB`
    ).toBeLessThan(JS_BUNDLE_SIZE_BUDGET);
  });

  test('no 5xx responses on initial page load', async ({ page }) => {
    const origin = new URL(process.env.E2E_BASE_URL || 'http://localhost:8888').origin;
    const failures: string[] = [];

    page.on('response', resp => {
      const url = resp.url();
      if (resp.status() >= 500 && url.startsWith(origin)) {
        failures.push(`${resp.status()} ${url}`);
      }
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    expect(failures).toHaveLength(0);
  });
});
