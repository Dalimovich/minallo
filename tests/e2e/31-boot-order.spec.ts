import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

/**
 * Boot ordering. A restored session must never reach _enterApp() before the
 * auth/profile bridge (installed by app.js) exists, and the Minallo logo cover
 * must be the only thing on screen until the correct interface is ready.
 */
type Debug = { marks: Record<string, number>; bootCoverVisible: boolean };

test.describe('boot order', () => {
  test('slow app.js: ss-ready waits for the bridge; ordering holds; profile resolves; no workspace-loading text', async ({ page }) => {
    // Delay app.js by 2s — the exact race that used to deadlock the role.
    await page.route(/\/js\/app\.js/, async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains('mn-boot-done'), null, { timeout: 60000 });
    const m = await page.evaluate(() => (window as unknown as { __minalloBootDebug: Debug }).__minalloBootDebug.marks);
    expect(m.authBridgeReadyAt).toBeLessThanOrEqual(m.ssReadyAt);
    expect(m.ssReadyAt).toBeLessThanOrEqual(m.enterAppAt);
    expect(m.enterAppAt).toBeLessThanOrEqual(m.profileStartedAt);
    expect(m.profileStartedAt).toBeLessThanOrEqual(m.profileReadyAt);
    expect(m.profileReadyAt).toBeLessThanOrEqual(m.interfaceRevealedAt);
    await expect(page.getByText('Loading your workspace')).toHaveCount(0);
  });

  test('slow profile (3s): only the logo until the role is applied', async ({ page }) => {
    await page.route(/rest\/v1\/profiles\?.*select=\*/, async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await page.reload({ waitUntil: 'commit' });
    await page.waitForTimeout(2000);
    const during = await page.evaluate(() => {
      const c = document.getElementById('minalloBootCover')!;
      return { shown: getComputedStyle(c).display !== 'none', text: c.innerText.trim(), covers: c.contains(document.elementFromPoint(700, 450)) };
    });
    expect(during).toEqual({ shown: true, text: '', covers: true });
    await page.waitForFunction(() => document.documentElement.classList.contains('mn-boot-done'), null, { timeout: 60000 });
    await expect(page.getByText('Loading your workspace')).toHaveCount(0);
  });

  test('profile 503 then success: logo stays, then the interface', async ({ page }) => {
    let calls = 0;
    await page.route(/rest\/v1\/profiles\?.*select=\*/, async (route) => {
      calls += 1;
      if (calls === 1) return route.fulfill({ status: 503, body: '{}' });
      return route.continue();
    });
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    calls = 0;
    await page.reload();
    await page.waitForFunction(() => document.documentElement.classList.contains('mn-boot-done'), null, { timeout: 60000 });
    expect(calls).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('Loading your workspace')).toHaveCount(0);
  });
});
