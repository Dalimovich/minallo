import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import {
  assertNoCriticalConsoleErrors,
  attachCriticalConsoleCollector,
} from './utils/assertions';
import { chatbotSelectors } from './utils/selectors';
import { mockAiEndpoints } from './utils/mocks';

test.describe('Chatbot real user flow', () => {
  test.beforeEach(async ({ page }) => {
    await mockAiEndpoints(page, 'loading');
  });

  test('opens, accepts a prompt, mocks AI, imports files, and quick cards prefill', async ({
    page,
  }) => {
    const consoleErrors = attachCriticalConsoleCollector(page);
    const app = new AppPage(page);

    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.ensureQaCourse();
    await app.navigateTo('chatbot');

    await expect(page.locator(chatbotSelectors.root)).toBeVisible();

    const input = page.locator(chatbotSelectors.input);
    const send = page.locator(chatbotSelectors.send);

    await input.click();
    await expect(input).toBeFocused();
    await input.fill('Explain eigenvalues like I am preparing for an exam.');
    await expect(input).toHaveValue(/eigenvalues/);

    await input.fill('');
    const userMessagesBeforeEmptySend = await page.locator(chatbotSelectors.userMessage).count();
    await send.click();
    await expect(page.locator(chatbotSelectors.userMessage)).toHaveCount(userMessagesBeforeEmptySend);

    await input.fill('Give me a concise study plan for linear algebra.');
    await send.click();
    await expect(page.locator(chatbotSelectors.userMessage).last()).toContainText(/study plan/i);
    await expect(page.locator(chatbotSelectors.loading)).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.ncb-msg-row--ai').last()).toContainText(/Mocked QA response/i, {
      timeout: 10000,
    });

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator(chatbotSelectors.upload).click();
    await expect(await fileChooserPromise).toBeTruthy();

    await page.locator(chatbotSelectors.importCourse).click();
    await expect(page.locator(chatbotSelectors.importModal)).toBeVisible();
    await page.keyboard.press('Escape');

    const quickCards = [
      { selector: chatbotSelectors.quickSummarize, value: /Summarize/i },
      { selector: chatbotSelectors.quickSolve, value: /Solve/i },
      { selector: chatbotSelectors.quickExamAnswer, value: /exam-style/i },
      { selector: chatbotSelectors.quickFlashcards, value: /flashcards/i },
    ];

    for (const card of quickCards) {
      await input.fill('');
      await page.locator(card.selector).click();
      await expect(input).toHaveValue(card.value);
    }

    await assertNoCriticalConsoleErrors(consoleErrors);
  });

  test('controlled AI errors render inside the response area', async ({ page }) => {
    await page.unroute('**/api/ai').catch(() => undefined);
    await mockAiEndpoints(page, 'error');

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');

    await page.locator(chatbotSelectors.input).fill('Trigger a controlled mocked error.');
    await page.locator(chatbotSelectors.send).click();
    await expect(page.locator('.ncb-msg-row--ai').last()).toContainText(/error|failed/i, {
      timeout: 10000,
    });
  });
});
