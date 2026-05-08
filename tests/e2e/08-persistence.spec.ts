import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

test.describe('State persistence', () => {
  test('course overview survives page reload', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();

    const hasCourses = await page.locator('#courseList .course-row').first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!hasCourses) { test.skip(true, 'No courses'); return; }

    await app.openFirstCourse();
    await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });
    const courseName = await page.locator('#breadcrumb b').first().textContent().catch(() => '');

    await page.reload();
    await page.waitForLoadState('networkidle');

    await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });
    const restoredName = await page.locator('#breadcrumb b').first().textContent().catch(() => '');
    expect(restoredName).toBe(courseName);
  });

  test('PDF view survives page reload', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();

    const hasCourses = await page.locator('#courseList .course-row').first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!hasCourses) { test.skip(true, 'No courses'); return; }

    await app.openFirstCourse();
    const hasFile = await page.locator('.co-file').first().isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasFile) { test.skip(true, 'No files'); return; }

    await app.openFirstFile();
    const fileName = await page.locator('#pdfFileName').textContent().catch(() => '');

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => (window as any).pdfDoc != null, { timeout: 20000 });

    const restoredName = await page.locator('#pdfFileName').textContent().catch(() => '');
    expect(restoredName).toBe(fileName);
  });

  test('no 404 or 500 on static assets at load', async ({ page }) => {
    const origin = new URL(process.env.E2E_BASE_URL || 'http://localhost:8888').origin;
    const failures: string[] = [];

    page.on('response', resp => {
      const url = resp.url();
      const status = resp.status();
      if (status >= 400 && url.startsWith(origin) && !url.includes('/api/') && !url.includes('functions')) {
        failures.push(`${status} ${url}`);
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    expect(failures).toHaveLength(0);
  });

  test('no unhandled JS errors on initial load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          !text.includes('favicon') &&
          !text.includes('ResizeObserver') &&
          !text.includes('accounts.google.com') &&
          !text.includes('fonts.googleapis') &&
          !text.includes('Non-Error promise rejection')
        ) {
          errors.push(text);
        }
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });
});
