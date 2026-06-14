import { test as setup, expect } from '@playwright/test';
import path from 'path';

const AUTH_FILE = path.join(__dirname, '.auth/user.json');

setup('authenticate', async ({ page }) => {
  const email = process.env.E2E_EMAIL || '';
  const password = process.env.E2E_PASSWORD || '';

  if (!email || !password) {
    throw new Error(
      '[auth.setup] E2E_EMAIL and E2E_PASSWORD must be set.\n' +
        'PowerShell example:\n' +
        '$env:E2E_EMAIL="test.e2e@minallo.test"; ' +
        '$env:E2E_PASSWORD="test.test.123"; npm run test:e2e'
    );
  }

  await page.addInitScript(() => {
    try {
      const hasSupabaseToken =
        !!localStorage.getItem('sb_token') ||
        Object.keys(localStorage).some(
          key =>
            key.startsWith('sb-') ||
            key.includes('supabase') ||
            key.includes('auth-token')
        );

      if (hasSupabaseToken) {
        sessionStorage.setItem('ss_logged_in', 'true');
        sessionStorage.setItem('ss_last_active', String(Date.now()));
      }
    } catch {
      // Ignore storage errors.
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(
    () => {
      return (
        !!document.querySelector('#authEmail') ||
        !!document.querySelector('#authModal') ||
        !!document.querySelector('#nlNavSignIn') ||
        !!document.querySelector('#nlNavStartFree') ||
        !!document.querySelector('#landingLoginBtn') ||
        !!document.querySelector('[data-i18n="landing_nav_login"]') ||
        sessionStorage.getItem('ss_logged_in') === 'true' ||
        !!document.querySelector('#courseAddBtn') ||
        !!document.querySelector('#sdCourseList') ||
        !!document.querySelector('#welcomeState')
      );
    },
    { timeout: 30000 }
  );

  const isLoggedIn = await page
    .evaluate(() => {
      const hasAuthenticatedUi =
        !!document.querySelector('#courseAddBtn') ||
        !!document.querySelector('#sdCourseList') ||
        !!document.querySelector('#welcomeState');

      return sessionStorage.getItem('ss_logged_in') === 'true' || hasAuthenticatedUi;
    })
    .catch(() => false);

  if (!isLoggedIn) {
    const loginBtn = page
      .locator(
        '#nlNavSignIn, [data-i18n="nav.signIn"], [data-i18n="landing_nav_login"], #landingLoginBtn, button:has-text("Login"), button:has-text("Sign in")'
      )
      .first();

    if (await loginBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
      await loginBtn.click();
    }

    await page.waitForSelector('#authEmail', { timeout: 15000 });
    await page.locator('#authEmail').fill(email);
    await page.locator('#authPassword').fill(password);
    await page.locator('#authSubmit').click();

    await page.waitForFunction(
      () => {
        const hasAuthenticatedUi =
          !!document.querySelector('#courseAddBtn') ||
          !!document.querySelector('#sdCourseList') ||
          !!document.querySelector('#welcomeState');

        return sessionStorage.getItem('ss_logged_in') === 'true' || hasAuthenticatedUi;
      },
      { timeout: 40000 }
    );
  } else {
    console.log('[auth.setup] Already authenticated — saving existing session');
  }

  await expect(page.locator('body')).toBeVisible();
  await page.context().storageState({ path: AUTH_FILE });
  console.log('[auth.setup] Session saved');
});
