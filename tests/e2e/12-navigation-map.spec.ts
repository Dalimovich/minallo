import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import {
  assertNoCriticalConsoleErrors,
  attachCriticalConsoleCollector,
} from './utils/assertions';
import { MainSection, sectionSelectors, sidebarSelectors } from './utils/selectors';
import { mockAiEndpoints } from './utils/mocks';

const sections: Array<{ name: MainSection; title: RegExp }> = [
  { name: 'home', title: /dashboard|home/i },
  { name: 'courses', title: /courses/i },
  { name: 'chatbot', title: /chatbot|ai/i },
  { name: 'notes', title: /lecture notes|notes/i },
  { name: 'summaries', title: /lecture notes|summary|summaries/i },
  { name: 'editor', title: /editor/i },
  { name: 'chat', title: /chat/i },
  { name: 'notifications', title: /notifications/i },
  { name: 'games', title: /games/i },
  { name: 'settings', title: /settings/i },
  { name: 'profile', title: /profile/i },
  { name: 'subscription', title: /subscription/i },
];

test.describe('Navigation map', () => {
  test('main app sections open from the real sidebar/menu controls', async ({ page }) => {
    await mockAiEndpoints(page, 'success');
    const consoleErrors = attachCriticalConsoleCollector(page);
    const app = new AppPage(page);

    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();

    for (const section of sections) {
      await app.navigateTo(section.name);

      await expect(page.locator(sectionSelectors[section.name]).first()).toBeVisible({
        timeout: 15000,
      });

      const navItem = page.locator(sidebarSelectors[section.name]).first();
      await expect(navItem).toBeVisible();
      await expect(navItem).toHaveClass(/on|active/);

      const topTitle = page.locator('#topTitle, .tb-title').first();
      if (await topTitle.isVisible().catch(() => false)) {
        await expect(topTitle).toContainText(section.title);
      }
    }

    await assertNoCriticalConsoleErrors(consoleErrors);
  });
});
