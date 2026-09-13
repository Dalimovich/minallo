import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import { chatbotSelectors } from './utils/selectors';
import { mockAiEndpoints } from './utils/mocks';

/**
 * Reproduces the real production bug: _enterApp() (supabase.js) mounts the
 * modern chatbot shell (#ncbRoot) BEFORE loadUserData()/applyProfile() has
 * resolved the account's real user_type, so a German learner briefly (or,
 * without the experience-mode fix, permanently) sees the full student shell
 * — Courses, course files, Course-safe mode — with no role logic at all.
 *
 * These tests exercise the ACTUAL profile-arrival path via window.applyProfile
 * (the same function loadUserData() calls with the server row), not a manual
 * window._userType assignment, so they prove the mounted shell reacts to
 * 'ss-profile-updated' rather than only proving a helper function can flip a
 * class. See also 18-german-learner.spec.ts for the legacy portal sidebar.
 */
async function applyProfile(page: import('@playwright/test').Page, profile: Record<string, unknown>) {
  await page.evaluate((p) => {
    const w = window as unknown as { applyProfile?: (row: Record<string, unknown>) => void };
    w.applyProfile?.(p);
  }, profile);
}

test.describe('Chatbot shell role mode (production timing)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAiEndpoints(page, 'success');
  });

  test('mounted while enrolled/unknown, then switches to learner mode once the real profile arrives — no reload', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();

    // Reproduce the real boot race: the shell is already mounted (as it is
    // in production, before the profile round-trip resolves) while the
    // account is still 'enrolled' — the default until a profile says otherwise.
    await applyProfile(page, { user_type: 'enrolled' });
    await app.navigateTo('chatbot');
    await expect(page.locator(chatbotSelectors.root)).toBeVisible();

    const root = page.locator(chatbotSelectors.root);
    const boundBefore = await root.getAttribute('data-ncb-experience-bound');
    expect(boundBefore).toBe('1');

    // Student baseline: course chrome visible, learner chrome absent.
    await expect(page.locator('.ncb-safe-card.ncb-student-only')).toBeVisible();
    await expect(page.locator('[data-library-tab="courses"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="german"]')).toBeHidden();
    await expect(page.locator('.ncb-actions.ncb-learner-only')).toBeHidden();
    await expect(page.locator('.ncb-empty-title.ncb-learner-only')).toBeHidden();

    // The real profile arrives asynchronously — exactly like loadUserData()
    // calling applyProfile(serverRow) after the shell has already mounted.
    await applyProfile(page, { user_type: 'learner', german_test: 'TestDaF', german_level: 'B1' });

    // No reload anywhere in this test — the mounted shell must react live.
    await expect(page.locator('.ncb-safe-card.ncb-student-only')).toBeHidden();
    await expect(page.locator('[data-library-tab="courses"]')).toBeHidden();
    await expect(page.locator('.ncb-library-panel[data-library-panel="courses"]')).toBeHidden();
    await expect(page.locator('.ncb-actions.ncb-student-only')).toBeHidden();

    await expect(page.locator('[data-library-tab="german"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="german"]')).toHaveClass(/ncb-library-tab--active/);
    await expect(page.locator('.ncb-german-panel')).toBeVisible();
    await expect(page.locator('#ncbGermanLevelValue')).toHaveText('B1');
    await expect(page.locator('[data-testid="quick-german-practice"]')).toBeVisible();
    await expect(page.locator('[data-testid="quick-writing-coach"]')).toBeVisible();
    await expect(page.locator('.ncb-empty-title.ncb-learner-only')).toBeVisible();
    await expect(page.locator('.ncb-empty-title.ncb-learner-only')).toContainText(/practice/i);

    // Import-from-Course / course-context pill / course-specific placeholder
    // must be gone, not merely relabeled — #ncbImportModal's own trigger is
    // outside #ncbRoot, so this also proves the document-scoped toggle works.
    await expect(page.locator('[data-testid="import-course"]')).toBeHidden();
    await expect(page.locator('.ncb-chat-context-pill.ncb-student-only')).toBeHidden();
    await expect(page.locator('.ncb-chat-context-pill.ncb-learner-only')).toBeVisible();
    await expect(page.locator(chatbotSelectors.input)).not.toHaveAttribute('placeholder', /course files/i);
    await expect(page.locator(chatbotSelectors.input)).toHaveAttribute('placeholder', /German|grammar|vocabulary|writing/i);

    // Course-only source choices must not be offered in the Add-files menu.
    await page.locator('.ncb-add-files-trigger').click();
    await page.locator('.ncb-add-files-source-trigger').click();
    await expect(page.locator('.ncb-add-files-source-list')).toBeVisible();
    await expect(page.locator('[data-source-mode="course_files"]')).toHaveCount(0);
    await expect(page.locator('[data-source-mode="course_plus_general"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Same shell instance — not torn down/remounted to switch modes.
    const boundAfter = await root.getAttribute('data-ncb-experience-bound');
    expect(boundAfter).toBe('1');
    await expect(root).toHaveAttribute('data-testid', 'chatbot-root');

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('Practice/Writing Coach quick actions in learner mode navigate into the existing German subviews', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });

    await page.locator('[data-testid="quick-german-practice"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glHome')).toBeVisible();

    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });
    await page.locator('[data-testid="quick-writing-coach"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#wcView')).toBeVisible({ timeout: 15000 });

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('German panel links (Vocabulary/Grammar/Reading/Writing Coach) deep-link into their own Practice skill', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });

    await page.locator('[data-testid="german-panel-vocab"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glSkillView')).toHaveAttribute('data-active-skill', 'vocab');

    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });
    await page.locator('[data-testid="german-panel-grammar"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glSkillView')).toHaveAttribute('data-active-skill', 'grammar');

    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });
    await page.locator('[data-testid="german-panel-reading"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glSkillView')).toHaveAttribute('data-active-skill', 'reading');

    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });
    await page.locator('[data-testid="german-panel-writing"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#wcView')).toBeVisible({ timeout: 15000 });

    // Listening has no real Practice content behind it yet — it must stay
    // hidden rather than silently opening vocab content under a "Hörverstehen"
    // label (see practice.js's _glSampleTools, which has no 'listening' entry).
    await expect(page.locator('[data-testid="german-panel-listening"]')).toBeHidden();

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('German level renders from the profile even when the account has no full_name set', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');

    // Regression: loadUserData() used to skip applying the ENTIRE fresh
    // profile row (user_type, german_level, ...) whenever full_name was
    // falsy, so a learner mid-onboarding without a display name would be
    // stuck showing "Level –" forever, never just transiently.
    await applyProfile(page, { user_type: 'learner', german_level: 'B2', full_name: '' });

    await expect(page.locator('#ncbGermanLevelValue')).toHaveText('B2');

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('learner mode never forwards a lingering university courseId/scope to /ask-stream', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.ensureQaCourse();
    await app.navigateTo('chatbot');

    // Simulate the exact production leak vector this fix closes: an old
    // university course context lingering on the page (window.activeCourseId
    // is the real fallback resolveRequestCourseId()/currentVisibleCourseId()
    // read when the chat itself has no explicit courseId) from before the
    // account was switched to learner mode. Nothing about the chat/library
    // data is deleted — the guard must simply refuse to read it back.
    await page.evaluate(() => {
      (window as unknown as { activeCourseId?: string }).activeCourseId = 'e2e-course';
    });

    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });

    let capturedBody: Record<string, unknown> | null = null;
    await page.route('**/ask-stream', async (route) => {
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"type":"done","text":"Mocked German practice answer."}\n\n',
      });
    });

    await page.locator(chatbotSelectors.input).fill('Erkläre mir den deutschen Dativ.');
    await page.locator(chatbotSelectors.send).click();

    await expect.poll(() => capturedBody, { timeout: 10000 }).not.toBeNull();
    const body = capturedBody as unknown as {
      courseId?: string;
      documentIds?: string[];
      documentNames?: string[];
      courseFileScope?: string;
    };
    expect(body.courseId || '').toBe('');
    expect(body.documentIds || []).toEqual([]);
    expect(body.documentNames || []).toEqual([]);
    expect(body.courseFileScope).not.toBe('specific_files');

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('enrolled account keeps the current student chatbot shell completely unchanged', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await applyProfile(page, { user_type: 'enrolled' });
    await app.navigateTo('chatbot');

    await expect(page.locator(chatbotSelectors.root)).toBeVisible();
    await expect(page.locator('.ncb-safe-card.ncb-student-only')).toBeVisible();
    await expect(page.locator('.ncb-actions.ncb-student-only')).toBeVisible();
    await expect(page.locator('[data-library-tab="courses"]')).toBeVisible();
    await expect(page.locator('.ncb-empty-title.ncb-student-only')).toBeVisible();

    await expect(page.locator('.ncb-safe-card.ncb-learner-only')).toBeHidden();
    await expect(page.locator('.ncb-actions.ncb-learner-only')).toBeHidden();
    await expect(page.locator('[data-library-tab="german"]')).toBeHidden();
    await expect(page.locator('.ncb-learner-nav')).toBeHidden();

    // Import-from-Course, the course-context pill, and course-only source
    // choices must all remain exactly as before for students.
    await expect(page.locator('[data-testid="import-course"]')).toBeVisible();
    await expect(page.locator('.ncb-chat-context-pill.ncb-student-only')).toBeVisible();
    await expect(page.locator('.ncb-chat-context-pill.ncb-learner-only')).toBeHidden();
    await expect(page.locator(chatbotSelectors.input)).toHaveAttribute('placeholder', /course files/i);

    await page.locator('.ncb-add-files-trigger').click();
    await page.locator('.ncb-add-files-source-trigger').click();
    await expect(page.locator('[data-source-mode="course_files"]')).toBeVisible();
    await expect(page.locator('[data-source-mode="course_plus_general"]')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
