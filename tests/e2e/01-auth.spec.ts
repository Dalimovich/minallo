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
        !!document.querySelector('#nlNavSignIn') ||
        !!document.querySelector('#nlNavStartFree') ||
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
        '#nlNavSignIn, [data-i18n="nav.signIn"], [data-i18n="landing_nav_login"], #landingLoginBtn, button:has-text("Login"), button:has-text("Sign in")'
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

  test('Google Identity Services script loads from index.html, independent of the landing fetch', async ({
    page,
  }) => {
    // Regression guard: gsi/client used to be injected by loader.ts only after
    // the landing partial finished rendering, so Google auth depended on
    // landing-fetch succeeding. It must now be a static <script> tag.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const gsiTags = page.locator('script[src*="accounts.google.com/gsi/client"]');
    await expect(gsiTags).toHaveCount(1);
    const src = await gsiTags.first().getAttribute('src');
    expect(src).toBe('https://accounts.google.com/gsi/client');
  });

  test('manual Google sign-in stays usable when GIS is blocked (network failure, extension, etc.)', async ({
    page,
  }) => {
    await page.route('**/accounts.google.com/gsi/client**', (route) => route.abort());

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () =>
        !!document.querySelector('#landingLoginBtn') ||
        sessionStorage.getItem('ss_logged_in') === 'true',
      { timeout: 30000 }
    );

    const alreadyAuthenticated = await page
      .evaluate(() => sessionStorage.getItem('ss_logged_in') === 'true')
      .catch(() => false);
    if (alreadyAuthenticated) {
      test.skip(true, 'Already authenticated — skip GIS-blocked fallback test');
      return;
    }

    await page.locator('#landingLoginBtn').click();
    await page.waitForSelector('#googleSignIn', { timeout: 15000 });

    // Custom fallback button must remain visible/usable — GIS never loaded,
    // so renderGoogleSignInButton() never had a chance to hide it.
    await expect(page.locator('#googleSignIn')).toBeVisible();

    const [navRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/auth/v1/authorize?provider=google'), {
        timeout: 10000,
      }),
      page.locator('#googleSignIn').click(),
    ]);
    expect(navRequest.url()).toContain('provider=google');
  });
});
