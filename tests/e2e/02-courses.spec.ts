import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

test.describe('Course management', () => {
  test('course list loads after auth', async ({ page }) => {
    const app = new AppPage(page);
    const errors: string[] = [];
    app.collectErrors(errors);

    await app.goto();

    // #courseList exists in the sidebar; may be empty for new test account
    await expect(page.locator('#courseList, #welcomeState')).toBeVisible({ timeout: 10000 });

    const crashes = errors.filter(e =>
      !e.includes('ResizeObserver') &&
      !e.includes('favicon') &&
      !e.includes('accounts.google.com') &&
      !e.includes('fonts.googleapis')
    );
    expect(crashes).toHaveLength(0);
  });

  test('first course opens course overview', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();

    const hasCourses = await page.locator('#courseList .course-row').first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!hasCourses) {
      test.skip(true, 'No courses in test account yet');
      return;
    }

    await app.openFirstCourse();
    await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#breadcrumb')).toBeVisible();
  });

  test('course tabs switch without recursion crash', async ({ page }) => {
    const app = new AppPage(page);
    const errors: string[] = [];
    app.collectErrors(errors);

    await app.goto();

    const hasCourses = await page.locator('#courseList .course-row').first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!hasCourses) {
      test.skip(true, 'No courses available');
      return;
    }

    await app.openFirstCourse();
    await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });

    // Click through tabs 3 times — must never throw Maximum call stack exceeded
    for (let i = 0; i < 3; i++) {
      await app.quizTab.click();
      await page.waitForTimeout(300);
      await app.flashcardsTab.click();
      await page.waitForTimeout(300);
      await app.filesTab.click();
      await page.waitForTimeout(300);
    }

    const crashes = errors.filter(e => e.includes('Maximum call stack') || e.includes('RangeError'));
    expect(crashes).toHaveLength(0);
  });
});
