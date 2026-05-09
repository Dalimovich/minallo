import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

test.describe('Authentication', () => {
  test('app loads and shows authenticated state', async ({ page }) => {
    const app = new AppPage(page);
    const errors: string[] = [];

    page.on('pageerror', e => errors.push(e.message));

    await app.goto();
    await app.loginIfNeeded();

    const crashes = errors.filter(
      e =>
        !e.includes('ResizeObserver') &&
        !e.includes('favicon') &&
        !e.includes('Failed to load resource') &&
        !e.includes('net::ERR_') &&
        !e.includes('403') &&
        !e.includes('404') &&
        !e.includes("Provider's accounts list is empty") &&
        !e.includes('GSI_LOGGER') &&
        !e.includes('FedCM') &&
        !e.includes('gsi/client') &&
        !e.includes('Not signed in with the identity provider')
    );

    expect(crashes).toHaveLength(0);
  });

  test('invalid credentials shows error toast, does not crash', async ({ page }) => {
    // This project normally runs with saved auth. If already authenticated,
    // this test is not meaningful, so skip.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(
      () =>
        !!document.querySelector('#authEmail') ||
        !!document.querySelector('#landingLoginBtn') ||
        !!document.querySelector('[data-i18n="landing_nav_login"]') ||
        !!document.querySelector('#courseAddBtn') ||
        !!document.querySelector('#sdCourseList') ||
        sessionStorage.getItem('ss_logged_in') === 'true',
      { timeout: 30000 }
    );

    const alreadyAuthenticated = await page
      .evaluate(
        () =>
          sessionStorage.getItem('ss_logged_in') === 'true' ||
          !!document.querySelector('#courseAddBtn') ||
          !!document.querySelector('#sdCourseList')
      )
      .catch(() => false);

    if (alreadyAuthenticated) {
      test.skip(true, 'Already authenticated — skip invalid login form test');
      return;
    }

    const loginBtn = page
      .locator(
        '[data-i18n="landing_nav_login"], #landingLoginBtn, button:has-text("Login"), button:has-text("Sign in")'
      )
      .first();

    if (await loginBtn.isVisible().catch(() => false)) {
      await loginBtn.click();
    }

    await page.waitForSelector('#authEmail', { timeout: 15000 });
    await page.locator('#authEmail').fill('bad@example.com');
    await page.locator('#authPassword').fill('wrongpassword');
    await page.locator('#authSubmit').click();

    await page.waitForSelector('.toast, .ss-toast, [role="alert"], #authError, .auth-error', {
      timeout: 15000,
    });

    await expect(page.locator('#authEmail')).toBeVisible();
  });
});
