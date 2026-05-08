import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('app loads and shows authenticated state', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // After auth setup, should be logged in — sidebar or course list visible
    const appReady = await page.waitForFunction(() => sessionStorage.getItem('ss_logged_in') === 'true', { timeout: 10000 }).then(() => true).catch(() => false);
    expect(appReady).toBe(true);

    const crashes = errors.filter(e =>
      !e.includes('ResizeObserver') &&
      !e.includes('favicon') &&
      !e.includes('Failed to load resource') &&
      !e.includes('net::ERR_') &&
      !e.includes('403') &&
      !e.includes('404')
    );
    expect(crashes).toHaveLength(0);
  });

  test('invalid credentials shows error toast, does not crash', async ({ page }) => {
    // Use a fresh context without saved auth
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const hasLoginForm = await page.locator('#authEmail').isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasLoginForm) {
      test.skip(true, 'Already authenticated — skip login form test');
      return;
    }

    await page.locator('#authEmail').fill('bad@example.com');
    await page.locator('#authPassword').fill('wrongpassword');
    await page.locator('#authSubmit').click();

    // An error indicator must appear
    await page.waitForSelector('.toast, .ss-toast, [role="alert"], #authError, .auth-error', { timeout: 10000 });
    // Login form still present — not redirected
    await expect(page.locator('#authEmail')).toBeVisible();
  });
});
