import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import { chatbotSelectors } from './utils/selectors';
import { mockAiEndpoints } from './utils/mocks';

test.describe('Responsive app shell', () => {
  test('mobile and tablet navigation keeps chatbot usable', async ({ page }, testInfo) => {
    test.skip(
      !/Mobile|Tablet/i.test(testInfo.project.name),
      'Responsive checks run in the mobile and tablet Playwright projects.'
    );

    await mockAiEndpoints(page, 'success');
    const app = new AppPage(page);

    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();

    await page.locator('[data-testid="portal-hamburger"], #portalHamburger').click();
    await expect(page.locator('[data-testid="sidebar-chatbot"], #psbAIPage')).toBeVisible();

    await app.navigateTo('chatbot');
    await expect(page.locator(chatbotSelectors.input)).toBeVisible();
    await page.locator(chatbotSelectors.input).fill('Mobile input check');
    await expect(page.locator(chatbotSelectors.input)).toHaveValue(/Mobile input check/);

    const actions = page.locator('.ncb-actions');
    if (await actions.isVisible().catch(() => false)) {
      const box = await actions.boundingBox();
      const viewport = page.viewportSize();
      expect(box?.x || 0).toBeGreaterThanOrEqual(0);
      expect((box?.x || 0) + (box?.width || 0)).toBeLessThanOrEqual((viewport?.width || 0) + 1);
    }

    await expect(page.locator('[data-testid="portal-hamburger"], #portalHamburger')).toBeVisible();
  });
});
