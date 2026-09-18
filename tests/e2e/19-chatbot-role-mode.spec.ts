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
    await expect(page.locator('.ncb-safe-card')).toHaveCount(0);
    await expect(page.locator('[data-library-tab="courses"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="files"]')).toBeHidden();
    await expect(page.locator('[data-library-tab="german"]')).toBeHidden();
    await expect(page.locator('.ncb-actions.ncb-learner-only')).toBeHidden();
    await expect(page.locator('.ncb-empty-title.ncb-learner-only')).toBeHidden();

    // The real profile arrives asynchronously — exactly like loadUserData()
    // calling applyProfile(serverRow) after the shell has already mounted.
    await applyProfile(page, { user_type: 'learner', german_test: 'TestDaF', german_level: 'B1' });

    // No reload anywhere in this test — the mounted shell must react live.
    // Courses (the university course registry) is STUDENT ONLY — a German
    // learner is a separate product surface with its own Files tab (the
    // learner's own uploaded documents, never SEMS/course data). The
    // learner arriving must move the user OFF Courses onto Files, since
    // Courses is now invalid for this role — that's the corrected product
    // rule (see the commit that reverted af5bcb2's "share Courses with
    // learners" mistake).
    await expect(page.locator('.ncb-safe-card')).toHaveCount(0);
    await expect(page.locator('[data-library-tab="courses"]')).toBeHidden();
    await expect(page.locator('.ncb-library-panel[data-library-panel="courses"]')).toBeHidden();
    await expect(page.locator('.ncb-actions.ncb-student-only')).toBeHidden();

    await expect(page.locator('[data-library-tab="files"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="files"]')).toHaveClass(/ncb-library-tab--active/);
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="german"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="saved"]')).toBeVisible();
    await expect(page.locator('.ncb-empty-title.ncb-learner-only')).toBeVisible();
    await expect(page.locator('.ncb-empty-title.ncb-learner-only')).toContainText(/practice/i);

    // Switching to the Practice tab still works exactly as before — this is
    // a normal tab click now, not an automatic redirect.
    await page.locator('[data-library-tab="german"]').click();
    await expect(page.locator('[data-library-tab="german"]')).toHaveClass(/ncb-library-tab--active/);
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).toBeHidden();
    await expect(page.locator('.ncb-german-panel')).toBeVisible();
    await expect(page.locator('#ncbGermanLevelValue')).toHaveText('B1');
    await expect(page.locator('[data-testid="quick-german-practice"]')).toBeVisible();
    await expect(page.locator('[data-testid="quick-writing-coach"]')).toBeVisible();

    // And switching back to Files returns the flat personal file library,
    // not a remount or a course tree.
    await page.locator('[data-library-tab="files"]').click();
    await expect(page.locator('[data-library-tab="files"]')).toHaveClass(/ncb-library-tab--active/);
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeHidden();
    await expect(page.locator('[data-library-panel="files"]')).toHaveCount(1);
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).not.toContainText('Add subject');

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

    // The German panel links live inside the Practice tab's panel, which is
    // no longer auto-active for a learner (Files is — see the corrected
    // af5bcb2 product rule) — switch to it explicitly first each time.
    await page.locator('[data-library-tab="german"]').click();
    await page.locator('[data-testid="german-panel-vocab"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glSkillView')).toHaveAttribute('data-active-skill', 'vocab');

    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });
    await page.locator('[data-library-tab="german"]').click();
    await page.locator('[data-testid="german-panel-grammar"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glSkillView')).toHaveAttribute('data-active-skill', 'grammar');

    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });
    await page.locator('[data-library-tab="german"]').click();
    await page.locator('[data-testid="german-panel-reading"]').click();
    await expect(page.locator('#psec-german')).toBeVisible();
    await expect(page.locator('#glSkillView')).toHaveAttribute('data-active-skill', 'reading');

    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B2' });
    await page.locator('[data-library-tab="german"]').click();
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

  test('enrolled account keeps course controls without the sidebar banner', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await applyProfile(page, { user_type: 'enrolled' });
    await app.navigateTo('chatbot');

    await expect(page.locator(chatbotSelectors.root)).toBeVisible();
    await expect(page.locator('.ncb-safe-card')).toHaveCount(0);
    await expect(page.locator('.ncb-actions.ncb-student-only')).toBeVisible();
    await expect(page.locator('[data-library-tab="courses"]')).toBeVisible();
    await expect(page.locator('.ncb-empty-title.ncb-student-only')).toBeVisible();

    await expect(page.locator('.ncb-safe-card')).toHaveCount(0);
    await expect(page.locator('.ncb-actions.ncb-learner-only')).toBeHidden();
    await expect(page.locator('[data-library-tab="files"]')).toBeHidden();
    await expect(page.locator('[data-library-tab="german"]')).toBeHidden();
    await expect(page.locator('.ncb-learner-nav')).toBeHidden();

    // Import-from-Course, the course-context pill, and course-only source
    // choices must all remain exactly as before for students.
    await expect(page.locator('.ncb-chat-context-pill.ncb-student-only')).toBeVisible();
    await expect(page.locator('.ncb-chat-context-pill.ncb-learner-only')).toBeHidden();
    await expect(page.locator(chatbotSelectors.input)).toHaveAttribute('placeholder', /course files/i);

    // import-course lives inside the "+ Add files" popup, closed by default.
    await page.locator('.ncb-add-files-trigger').click();
    await expect(page.locator('[data-testid="import-course"]')).toBeVisible();
    await page.locator('.ncb-add-files-source-trigger').click();
    await expect(page.locator('[data-source-mode="course_files"]')).toBeVisible();
    await expect(page.locator('[data-source-mode="course_plus_general"]')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('learner sees exactly Files/Practice/Saved (never Courses) and switching between them never remounts or reloads', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_test: 'telc', german_level: 'C1 Hochschule' });

    // Courses stays in the DOM (student-only, .ncb-role-hidden) so the tab
    // count itself is 4 — assert the VISIBLE set instead.
    const visibleTabs = page.locator('[data-library-tab]:visible');
    await expect(visibleTabs).toHaveCount(3);
    await expect(page.locator('[data-library-tab="courses"]')).toBeHidden();
    await expect(page.locator('[data-library-tab="files"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="german"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="saved"]')).toBeVisible();

    // Files must be the landing tab — the learner equivalent of the
    // student's main content library, not Practice.
    await expect(page.locator('[data-library-tab="files"]')).toHaveClass(/ncb-library-tab--active/);

    const root = page.locator(chatbotSelectors.root);
    const boundBefore = await root.getAttribute('data-ncb-experience-bound');

    await page.locator('[data-library-tab="german"]').click();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).toBeHidden();

    await page.locator('[data-library-tab="files"]').click();
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeHidden();

    await page.locator('[data-library-tab="saved"]').click();
    await expect(page.locator('.ncb-library-panel[data-library-panel="saved"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).toBeHidden();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeHidden();

    // Back to Files — the flat personal library, not a blank/re-fetched shell.
    await page.locator('[data-library-tab="files"]').click();
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).toBeVisible();
    await expect(page.locator('[data-library-panel="files"]')).toHaveCount(1);

    const boundAfter = await root.getAttribute('data-ncb-experience-bound');
    expect(boundAfter).toBe(boundBefore);
    expect(boundAfter).toBe('1');

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('video regression: learner lands on Files (never Courses) through the enrolled→learner transition, even after delayed modules settle', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();

    // Shell mounts while the account is still the "enrolled" default —
    // this is the real boot race from the video, not a manual override.
    await applyProfile(page, { user_type: 'enrolled' });
    await app.navigateTo('chatbot');
    await expect(page.locator('[data-library-tab="courses"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="courses"]')).toHaveClass(/ncb-library-tab--active/);

    // The authoritative learner profile arrives asynchronously, exactly like
    // loadUserData()'s real fetch completing after the shell already mounted.
    await applyProfile(page, { user_type: 'learner', german_test: 'telc', german_level: 'C1 Hochschule' });

    // Give every ss-profile-updated listener (this module, music-services.ts,
    // etc.) a full delayed-module window to run — the video's bug only
    // showed up once boot had fully settled, not immediately on arrival.
    await page.waitForTimeout(30_000);

    // Final state must be Files | Practice | Saved — NOT Courses, and
    // certainly not any university course names (see the data-isolation
    // test below for the stronger, content-level version of this check).
    await expect(page.locator('[data-library-tab="courses"]')).toBeHidden();
    await expect(page.locator('[data-library-tab="files"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="files"]')).toHaveClass(/ncb-library-tab--active/);
    await expect(page.locator('.ncb-library-panel[data-library-panel="files"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="german"]')).toBeVisible();
    await expect(page.locator('[data-library-tab="saved"]')).toBeVisible();

    await page.screenshot({ path: 'tests/e2e/report/chatbot-role-mode-video-regression.png', fullPage: true }).catch(() => {});

    await applyProfile(page, { user_type: 'enrolled' });
  });

  test('data isolation: learner Files never shows a university course, student Courses never shows a learner file', async ({
    page,
  }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();

    const STUDENT_COURSE_NAME = 'Grundlagen des Konstruierens';
    const LEARNER_FILE_NAME = 'telc-c1-modelltest.pdf';

    // Seed a real student course (SEMS — the university course registry)
    // and a learner file (via the documented _ufMerge test seam) BEFORE the
    // chatbot shell mounts — renderCourses() reads courses() once at mount
    // time, not reactively, so seeding after navigateTo('chatbot') would
    // miss the initial paint.
    await page.evaluate((courseName) => {
      const w = window as unknown as { SEMS?: Record<string, unknown>; _SEMS?: Record<string, unknown> };
      const sems = { sem1: { courses: [{ id: 'e2e-real-course', name: courseName, files: [] }] } };
      w.SEMS = sems;
      w._SEMS = sems;
    }, STUDENT_COURSE_NAME);
    await page.evaluate((fileName) => {
      const w = window as unknown as {
        _ufMerge?: (course: { id: string; files?: unknown[] }) => Promise<void>;
      };
      w._ufMerge = async (course) => {
        if (course.id === 'german-files') {
          course.files = [{ name: fileName, _storageName: fileName, _uploaded: true }];
        } else {
          course.files = [];
        }
        return Promise.resolve();
      };
    }, LEARNER_FILE_NAME);
    await page.route('**/api/documents/list*', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ documents: [] }),
    }));

    await app.navigateTo('chatbot');

    // Learner profile: Files must show the learner's own file, never the
    // student course.
    await applyProfile(page, { user_type: 'learner', german_test: 'telc', german_level: 'C1 Hochschule' });
    await expect(page.locator('[data-library-tab="files"]')).toHaveClass(/ncb-library-tab--active/);
    const filesPanel = page.locator('.ncb-library-panel[data-library-panel="files"]');
    await expect(filesPanel.getByText(LEARNER_FILE_NAME)).toBeVisible();
    await expect(filesPanel.getByText(STUDENT_COURSE_NAME)).toHaveCount(0);
    await expect(page.locator('[data-library-tab="courses"]')).toBeHidden();

    // Switch to the enrolled/student profile: the learner file must never
    // leak into Courses, and the learner Files tab must not exist at all.
    // (Courses' own content is populated by the real, async SEMS load —
    // production account state, not asserted here by exact name to avoid
    // racing that real network fetch; the isolation invariant that matters
    // is the learner file's absence.)
    await applyProfile(page, { user_type: 'enrolled' });
    await expect(page.locator('[data-library-tab="courses"]')).toBeVisible();
    const coursesPanel = page.locator('.ncb-library-panel[data-library-panel="courses"]');
    await expect(coursesPanel.getByText(LEARNER_FILE_NAME)).toHaveCount(0);
    await expect(page.locator('[data-library-tab="files"]')).toBeHidden();
  });
});
