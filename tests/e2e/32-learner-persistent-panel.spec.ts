import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

/** The right Learning panel persists across every learner workspace and is only opened/closed by the user. */
const SKILLS: Array<[string, string]> = [
  ['vocab', '#glVocabularyView'], ['grammar', '#glGrammarView'], ['reading', '#glReadingView'],
  ['listening', '#glListeningView'], ['sprachbausteine', '#glSprachbausteineView'],
];

test('learner navigation matrix: panel stays, replaces workspace, close is sticky, reopen works', async ({ page }) => {
  const app = new AppPage(page);
  await app.goto();
  expect(await app.loginIfNeeded()).toBeTruthy();
  await page.waitForFunction(() => document.documentElement.classList.contains('mn-boot-done'));
  const context = page.locator('.ncb-context');
  await page.locator('[data-library-tab="german"]').click();
  await expect(context).toBeVisible();

  for (const [skill, view] of SKILLS) {
    await page.locator(`.ncb-german-panel-link[data-workspace-skill="${skill}"]`).click();
    await expect(page.locator(view)).toBeVisible();
    await expect(context).toBeVisible();
    await expect(page.locator(`.ncb-german-panel-link[data-workspace-skill="${skill}"]`)).toHaveClass(/is-active/);
    for (const [, other] of SKILLS.filter(([s]) => s !== skill)) await expect(page.locator(other)).toBeHidden();
  }
  await page.locator('.ncb-german-panel-link[data-workspace-view="writing-coach"]').click();
  await expect(page.locator('[data-testid="writing-coach-workspace"]')).toBeVisible();
  await expect(context).toBeVisible();
  await expect(page.locator('.ncb-german-panel-link[data-workspace-view="writing-coach"]')).toHaveClass(/is-active/);

  await page.locator('.ncb-context-close-btn').click();
  await expect(context).toBeHidden();
  for (const skill of ['grammar', 'reading', 'sprachbausteine']) {
    // panel is closed, so drive the switch through the shell API the panel links use
    await page.evaluate((s) => document.querySelector<HTMLElement>(`[data-workspace-skill="${s}"]`)!.click(), skill);
    await expect(context).toBeHidden();
  }
  await page.locator('.ncb-context-reopen').click();
  await expect(context).toBeVisible();
});
