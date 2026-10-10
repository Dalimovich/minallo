import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import { mockAiEndpoints } from './utils/mocks';

/**
 * Phase 1 of the German Learner UI migration: learners get the same portal
 * shell/sidebar/workspace as students, with Practice/Writing Coach mounted
 * as subviews inside the shared #psec-german root (not a separate app).
 *
 * There is no dedicated learner test account, so these tests flip the real
 * test account into learner mode client-side (window._userType + the same
 * _applyUserTypeUI() the profile loader calls) rather than requiring backend
 * seeding — this mirrors how the product owner plans to test it manually.
 */
async function switchToLearner(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      _userType?: string;
      _applyUserTypeUI?: () => void;
    };
    w._userType = 'learner';
    if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
  });
}

async function switchToStudent(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      _userType?: string;
      _applyUserTypeUI?: () => void;
    };
    w._userType = 'enrolled';
    if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
  });
}

test.describe('German learner shared shell', () => {
  test('student account keeps the student sidebar/navigation unchanged', async ({ page }) => {
    await mockAiEndpoints(page, 'success');
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();

    await expect(page.locator('#psbDashboard')).toBeVisible();
    await expect(page.locator('#pcStudip')).toBeVisible();
    await expect(page.locator('#psbChat')).toBeVisible();

    // Learner-only destinations must stay hidden for a student account.
    await expect(page.locator('#psbLearnerHome')).toBeHidden();
    await expect(page.locator('#psbGerman')).toBeHidden();
    await expect(page.locator('#psbWritingCoach')).toBeHidden();
  });

  test('learner account gets the shared shell with learner navigation, no course controls', async ({
    page,
  }) => {
    await mockAiEndpoints(page, 'success');
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();

    await switchToLearner(page);

    // Same shell markup — just a different visible item set.
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#psbLearnerHome')).toBeVisible();
    await expect(page.locator('#psbGerman')).toBeVisible();
    await expect(page.locator('#psbWritingCoach')).toBeVisible();
    await expect(page.locator('#psbAIPage')).toBeVisible();
    await expect(page.locator('#psbProfile')).toBeVisible();

    // Student-only course controls must disappear for the learner role.
    await expect(page.locator('#pcStudip')).toBeHidden();
    await expect(page.locator('#psbDashboard')).toBeHidden();
    await expect(page.locator('#psbChat')).toBeHidden();

    await switchToStudent(page);
  });

  test('learner Home shows the shared workspace welcome view', async ({ page }) => {
    await mockAiEndpoints(page, 'success');
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);

    await page.locator('#psbLearnerHome').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glLearnerHome')).toBeVisible();
    await expect(page.locator('#glHomeGreeting')).not.toBeEmpty();

    await switchToStudent(page);
  });

  test('learner Practice mounts inside the shared workspace', async ({ page }) => {
    await mockAiEndpoints(page, 'success');
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);

    await page.locator('#psbGerman').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glHome')).toBeVisible();
    await expect(page.locator('#glLearnerHome')).toBeHidden();

    await switchToStudent(page);
  });

  test('learner Writing Coach mounts inside the shared workspace', async ({ page }) => {
    await mockAiEndpoints(page, 'success');
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);

    await page.locator('#psbWritingCoach').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#wcView')).toBeVisible({ timeout: 15000 });

    await switchToStudent(page);
  });

  test('learner Profile shows German learner fields', async ({ page }) => {
    await mockAiEndpoints(page, 'success');
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);

    await page.locator('#psbProfile').click();
    await expect(page.locator('#psec-profile')).toBeVisible();
    await expect(page.locator('.pf-learner-field').first()).toBeVisible();
    await expect(page.locator('.pf-enrolled-field').first()).toBeHidden();

    await switchToStudent(page);
  });

  test('learner mobile layout: nav opens Practice inside the workspace', async ({
    page,
  }, testInfo) => {
    test.skip(
      !/Mobile|Tablet/i.test(testInfo.project.name),
      'Mobile learner layout only runs in the mobile/tablet Playwright projects.'
    );

    await mockAiEndpoints(page, 'success');
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);

    const hamburger = page.locator('[data-testid="portal-hamburger"], #portalHamburger');
    if (await hamburger.isVisible().catch(() => false)) {
      await hamburger.click();
    }

    await expect(page.locator('#psbGerman')).toBeVisible();
    await page.locator('#psbGerman').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glHome')).toBeVisible();

    await switchToStudent(page);
  });
});
