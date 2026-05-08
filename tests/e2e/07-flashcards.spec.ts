import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

async function openCourse(page: any, app: AppPage): Promise<boolean> {
  await app.goto();
  const hasCourses = await page.locator('#sdCourseList .sd-course-card').first().isVisible({ timeout: 8000 }).catch(() => false);
  if (!hasCourses) return false;
  await app.openFirstCourse();
  await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });
  return true;
}

test.describe('Flashcards', () => {
  test('flashcards tab is accessible', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openCourse(page, app);
    if (!opened) { test.skip(true, 'No courses available'); return; }

    await expect(app.flashcardsTab).toBeVisible();
    await app.flashcardsTab.click();
    await expect(app.flashcardsPanel).toHaveClass(/active/, { timeout: 3000 });
  });

  test('flashcards panel shows grid (not auto-selected deck)', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openCourse(page, app);
    if (!opened) { test.skip(true, 'No courses available'); return; }

    await app.flashcardsTab.click();
    await expect(app.flashcardsPanel).toHaveClass(/active/, { timeout: 3000 });

    // Generate cards button should be visible — not jumped into a deck
    const genBtn = app.flashcardsPanel.locator('button:has-text("Generate cards"), button:has-text("Generate")').first();
    await expect(genBtn).toBeVisible({ timeout: 5000 });
  });

  test('flashcard generation completes without 504', async ({ page }) => {
    test.setTimeout(60000);
    const app = new AppPage(page);
    const failures: string[] = [];
    app.collectNetworkFailures(failures);
    const opened = await openCourse(page, app);
    if (!opened) { test.skip(true, 'No courses available'); return; }

    await app.flashcardsTab.click();
    await expect(app.flashcardsPanel).toHaveClass(/active/, { timeout: 3000 });

    const genBtn = app.flashcardsPanel.locator('button:has-text("Generate cards"), button:has-text("Generate")').first();
    if (!await genBtn.isVisible().catch(() => false)) { test.skip(true, 'No generate button'); return; }

    await genBtn.click();

    // Source picker modal
    const confirmBtn = page.locator('#fcspConfirm, button:has-text("Generate from selected")').first();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) await confirmBtn.click();

    await page.waitForFunction(() => !document.getElementById('fcGenOverlay'), { timeout: 55000 });

    expect(failures.filter(f => f.startsWith('504'))).toHaveLength(0);

    const deckCards = app.flashcardsPanel.locator('.fc-deck-card, .deck-card');
    await expect(deckCards.first()).toBeVisible({ timeout: 5000 });
  });
});
