import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

async function openCourseWithFiles(page: any, app: AppPage): Promise<boolean> {
  await app.goto();
  const hasCourses = await page.locator('#courseList .course-row').first().isVisible({ timeout: 8000 }).catch(() => false);
  if (!hasCourses) return false;
  await app.openFirstCourse();
  await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });
  return true;
}

test.describe('Quiz', () => {
  test('quiz tab is accessible', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openCourseWithFiles(page, app);
    if (!opened) { test.skip(true, 'No courses available'); return; }

    await expect(app.quizTab).toBeVisible();
    await app.quizTab.click();
    await expect(app.quizPanel).toHaveClass(/active/, { timeout: 3000 });
  });

  test('quiz panel shows grid (not auto-selected quiz)', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openCourseWithFiles(page, app);
    if (!opened) { test.skip(true, 'No courses available'); return; }

    await app.quizTab.click();
    await expect(app.quizPanel).toHaveClass(/active/, { timeout: 3000 });

    // Should NOT jump straight into a quiz — study pane should be empty or grid is visible
    const studyPane = app.quizPanel.locator('#qzStudyPane, .qz-card-stage');
    const cardStageClass = await studyPane.first().getAttribute('class').catch(() => '');
    // Either no active quiz in study pane, or deck grid is shown
    const genBtn = app.quizPanel.locator('#qzGenerateBtn, button:has-text("Generate quiz")').first();
    await expect(genBtn).toBeVisible({ timeout: 5000 });
  });

  test('quiz generation returns questions without 504', async ({ page }) => {
    test.setTimeout(60000);
    const app = new AppPage(page);
    const failures: string[] = [];
    app.collectNetworkFailures(failures);
    const opened = await openCourseWithFiles(page, app);
    if (!opened) { test.skip(true, 'No courses available'); return; }

    await app.quizTab.click();
    await expect(app.quizPanel).toHaveClass(/active/, { timeout: 3000 });

    const genBtn = app.quizPanel.locator('#qzGenerateBtn').first();
    if (!await genBtn.isVisible().catch(() => false)) { test.skip(true, 'No generate button'); return; }

    await genBtn.click();

    // Settings modal appears — confirm with defaults
    const confirmBtn = page.locator('#qzspConfirm, button:has-text("Generate from selected"), button:has-text("Generate")').last();
    if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) await confirmBtn.click();

    await page.waitForFunction(() => !document.getElementById('qzGenOverlay'), { timeout: 55000 });

    expect(failures.filter(f => f.startsWith('504'))).toHaveLength(0);

    const cards = app.quizPanel.locator('.qz-deck-card');
    await expect(cards.first()).toBeVisible({ timeout: 5000 });
  });
});
