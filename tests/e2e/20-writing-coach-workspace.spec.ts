import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import { chatbotSelectors } from './utils/selectors';
import { mockAiEndpoints } from './utils/mocks';

/**
 * Writing Coach as a workspace-mode INSIDE the modern chatbot shell (#ncbRoot)
 * instead of navigating away to the old #psec-german page. See
 * experience-mode.ts's setLearnerWorkspaceView / getLearnerWorkspaceView and
 * writing-coach.ts's openWritingCoach(). No separate application shell is
 * created — the same #ncbRoot stays mounted; only its content toggles.
 */
async function applyProfile(page: import('@playwright/test').Page, profile: Record<string, unknown>) {
  await page.evaluate((p) => {
    const w = window as unknown as { applyProfile?: (row: Record<string, unknown>) => void };
    w.applyProfile?.(p);
  }, profile);
}

test.describe('Writing Coach workspace mode', () => {
  test.beforeEach(async ({ page }) => {
    await mockAiEndpoints(page, 'success');
  });

  test('learner normal mode shows only the Writing Coach sidebar button, not Home/Practice', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });

    await expect(page.locator('[data-testid="chatbot-nav-writing-coach"]')).toBeVisible();
    await expect(page.locator('[data-testid="chatbot-nav-home"]')).toBeHidden();
    // The old three-button nav (Home/Practice/Writing Coach) is gone —
    // Practice now lives only in the right-side Practice panel.
    await expect(page.locator('.ncb-learner-nav button')).toHaveCount(2);

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('learner sidebar has no Course-safe mode or German learning cards, keeps Recent chats and account controls', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });

    // Student-only card must never take sidebar space for a learner.
    await expect(page.locator('.ncb-safe-card.ncb-student-only')).toBeHidden();
    // The old learner "German learning" card was removed entirely, not
    // just hidden — it must not exist anywhere in the DOM at all.
    await expect(page.locator('.ncb-safe-card.ncb-learner-only')).toHaveCount(0);

    await expect(page.locator('[data-testid="chatbot-nav-writing-coach"]')).toBeVisible();
    await expect(page.locator('.ncb-chat-list')).toBeVisible();
    await expect(page.locator('[data-testid="chatbot-notifications"]')).toBeVisible();
    await expect(page.locator('[data-testid="chatbot-account-menu"]')).toBeVisible();

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('student sidebar keeps Course-safe mode exactly as before', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await applyProfile(page, { user_type: 'enrolled' });
    await app.navigateTo('chatbot');

    await expect(page.locator('.ncb-safe-card.ncb-student-only')).toBeVisible();
    await expect(page.locator('.ncb-safe-card.ncb-student-only')).toContainText(/course-safe mode/i);
  });

  test('clicking Writing Coach switches the shell in place, hides chat chrome and the right panel', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });

    const root = page.locator(chatbotSelectors.root);
    await expect(root).toBeVisible();

    await page.locator('[data-testid="chatbot-nav-writing-coach"]').click();

    // Same shell, same sidebar — never left #ncbRoot.
    await expect(root).toBeVisible();
    await expect(root).toHaveClass(/ncb-view-writing-coach/);
    await expect(page.locator('.ncb-sidebar')).toBeVisible();

    // Chat chrome hidden.
    await expect(page.locator('.ncb-widget-launcher')).toBeHidden();
    await expect(page.locator('.ncb-sidebar > .ncb-new-chat-btn')).toBeHidden();
    await expect(page.locator('.ncb-search')).toBeHidden();
    await expect(page.locator('.ncb-chat-list')).toBeHidden();

    // Nav button flips to Home.
    await expect(page.locator('[data-testid="chatbot-nav-writing-coach"]')).toBeHidden();
    await expect(page.locator('[data-testid="chatbot-nav-home"]')).toBeVisible();

    // Writing Coach workspace visible; center chat column and right
    // Practice/Saved panel hidden.
    await expect(page.locator('[data-testid="writing-coach-workspace"]')).toBeVisible();
    await expect(page.locator('.ncb-center')).toBeHidden();
    await expect(page.locator('.ncb-context')).toBeHidden();

    // Account controls remain.
    await expect(page.locator('[data-testid="chatbot-account-menu"]')).toBeVisible();

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('Home restores the chat workspace, chat history, Writing Coach button, and Practice/Saved panel', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });

    await page.locator('[data-testid="chatbot-nav-writing-coach"]').click();
    await expect(page.locator('[data-testid="writing-coach-workspace"]')).toBeVisible();

    await page.locator('[data-testid="chatbot-nav-home"]').click();

    await expect(page.locator(chatbotSelectors.root)).not.toHaveClass(/ncb-view-writing-coach/);
    await expect(page.locator('[data-testid="writing-coach-workspace"]')).toBeHidden();
    await expect(page.locator('.ncb-center')).toBeVisible();
    await expect(page.locator('.ncb-context')).toBeVisible();
    await expect(page.locator('.ncb-chat-list')).toBeVisible();
    await expect(page.locator('.ncb-search')).toBeVisible();
    await expect(page.locator('[data-testid="chatbot-nav-writing-coach"]')).toBeVisible();
    await expect(page.locator('[data-testid="chatbot-nav-home"]')).toBeHidden();

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('a Writing Coach draft survives Home -> Writing Coach navigation', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });

    await page.locator('[data-testid="chatbot-nav-writing-coach"]').click();
    const draftText = 'Ich moechte diesen Absatz ueben.';
    await page.locator('[data-testid="writing-coach-input"]').fill(draftText);

    await page.locator('[data-testid="chatbot-nav-home"]').click();
    await page.locator('[data-testid="chatbot-nav-writing-coach"]').click();

    await expect(page.locator('[data-testid="writing-coach-input"]')).toHaveValue(draftText);

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('the right Practice panel Writing Coach link opens the same modern workspace', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });

    await page.locator('[data-testid="german-panel-writing"]').click();

    await expect(page.locator(chatbotSelectors.root)).toHaveClass(/ncb-view-writing-coach/);
    await expect(page.locator('[data-testid="writing-coach-workspace"]')).toBeVisible();
    await expect(page.locator('[data-testid="chatbot-nav-home"]')).toBeVisible();

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('enrolled/student account is completely unaffected', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await applyProfile(page, { user_type: 'enrolled' });
    await app.navigateTo('chatbot');

    await expect(page.locator('.ncb-learner-nav')).toBeHidden();
    await expect(page.locator('[data-testid="writing-coach-workspace"]')).toBeHidden();
    await expect(page.locator('.ncb-center')).toBeVisible();
    await expect(page.locator('.ncb-context')).toBeVisible();
    await expect(page.locator(chatbotSelectors.root)).not.toHaveClass(/ncb-view-writing-coach/);
  });

  test('mobile/collapsed sidebar: Writing Coach toggle still switches the shell in place', async ({
    page,
  }, testInfo) => {
    test.skip(
      !/Mobile|Tablet/i.test(testInfo.project.name),
      'Collapsed-sidebar layout only runs in the mobile/tablet Playwright projects.'
    );

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });

    await page.locator('[data-testid="chatbot-nav-writing-coach"]').click();
    await expect(page.locator('[data-testid="writing-coach-workspace"]')).toBeVisible();
    await expect(page.locator('.ncb-sidebar')).toBeVisible();

    await page.locator('[data-testid="chatbot-nav-home"]').click();
    await expect(page.locator('.ncb-center')).toBeVisible();

    await applyProfile(page, { user_type: 'enrolled' });
  });
});
