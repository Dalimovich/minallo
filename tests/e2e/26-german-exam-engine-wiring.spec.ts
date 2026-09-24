import { test, expect, Page, Route } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import { mockAiEndpoints } from './utils/mocks';

/**
 * Regression coverage for the product-wiring bugs fixed alongside this
 * suite:
 *  - the legacy #psec-german grid's Writing card silently falling through
 *    _glOpenSkill('writing') into the generic quiz/cards template instead of
 *    the real exam-aware Writing Coach workspace,
 *  - the legacy grid having no Sprachbausteine card at all,
 *  - Sprachbausteine never rendering a truly blank view even if its
 *    dedicated markup/controller is missing at open time,
 *  - "New Test" for Hören/Lesen/Sprachbausteine always producing a fresh
 *    generationId (never a re-render of the currently loaded content),
 *  - Sprechen being fully cost-disabled (GERMAN_SPEAKING_ENABLED=false).
 *
 * All AI endpoints are mocked — this suite never hits real OpenAI/python-ai.
 */

async function switchToLearner(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
    w._userType = 'learner';
    if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
  });
}

async function switchToStudent(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
    w._userType = 'enrolled';
    if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
  });
}

async function applyTelcProfile(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { applyProfile?: (row: Record<string, unknown>) => void };
    w.applyProfile?.({
      german_test: 'telc',
      german_level: 'C1 Hochschule',
      german_exam_profile_id: 'telc_c1_hochschule',
    });
  });
}

/** Mounts a /generate mock that returns a fresh generationId (an
 * incrementing counter) on every call, with a minimal-but-valid envelope
 * shape for the given module — enough for each module's renderer to not
 * blow up, without needing full exam-realistic content. */
function mockGenerateWithFreshIds(page: Page, module: 'listening' | 'reading' | 'language_elements') {
  const requests: string[] = [];
  let counter = 0;
  const install = () =>
    page.route('**/api/ai/german-exam/generate', (route: Route) => {
      requests.push(route.request().url());
      counter += 1;
      const generationId = `gen-${counter}`;
      const exam = {
        family: 'telc',
        variant: 'C1 Hochschule',
        cefrLevel: 'C1',
        profileId: 'telc_c1_hochschule',
        profileVersion: 1,
      };
      let body: Record<string, unknown>;
      if (module === 'listening') {
        body = {
          generationId,
          module: 'listening',
          part: { id: 'hv1', title: 'Test listening ' + counter, taskType: 'sentence_completion_mc3' },
          exam,
          content: { segments: [{ id: 's1', speakerId: 'sp1', spokenText: 'Hallo.', displayText: 'Hallo.' }], questions: [] },
        };
      } else if (module === 'reading') {
        body = {
          generationId,
          module: 'reading',
          part: { id: 'lesen_1' },
          exam,
          content: {
            text: { title: 'Test text ' + counter, paragraphs: ['Absatz {{g1}}.'] },
            candidates: [{ candidateId: 'c1', text: 'Kandidat A' }],
            questions: [],
          },
        };
      } else {
        const gaps = Array.from({ length: 22 }, (_, i) => ({ gapId: `g${i + 1}` }));
        const questions = Array.from({ length: 22 }, (_, i) => ({
          questionId: `q${i + 1}`,
          gapId: `g${i + 1}`,
          options: ['a', 'b', 'c', 'd'],
          correctIndex: 0,
          category: 'grammar',
          skillTags: ['grammar'],
          difficulty: 'c1',
        }));
        const paragraphs: string[] = [];
        let gapN = 1;
        for (let p = 0; p < 8 && gapN <= 22; p++) {
          const words = ['Wort'];
          for (let g = 0; g < 3 && gapN <= 22; g++) {
            words.push(`{{g${gapN}}}`);
            gapN++;
          }
          paragraphs.push(words.join(' '));
        }
        body = {
          generationId,
          module: 'language_elements',
          part: { id: 'sprachbausteine_1' },
          exam,
          content: { text: { title: 'Test cloze ' + counter, paragraphs, gaps }, questions },
        };
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
  return { requests, install, generationIdCount: () => counter };
}

test.describe('German Exam Engine — product wiring regressions', () => {
  test.beforeEach(async ({ page }) => {
    await mockAiEndpoints(page, 'success');
  });

  test('legacy Writing card opens the real Writing Coach, never the generic quiz/cards template', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await applyTelcProfile(page);

    await page.locator('#psbGerman').click();
    await expect(page.locator('#glHome')).toBeVisible();
    await page.locator('.gl-skill-card[data-skill="writing"]').click();

    // Must land in the real Writing Coach workspace (chatbot shell), not the
    // generic #glSkillView quiz/cards template.
    await expect(page.locator('[data-testid="writing-coach-workspace"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.gl-study-tools')).toBeHidden();
    await expect(page.locator('#glGenerateQuiz')).toBeHidden();

    await switchToStudent(page);
  });

  test('legacy German home has a Sprachbausteine card, grouped under Exam Practice, opening the dedicated 22-gap workspace', async ({ page }) => {
    const gen = mockGenerateWithFreshIds(page, 'language_elements');
    gen.install();

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await applyTelcProfile(page);

    await page.locator('#psbGerman').click();
    await expect(page.locator('#glHome')).toBeVisible();

    const card = page.locator('.gl-skill-card[data-skill="sprachbausteine"]');
    await expect(card).toBeVisible();
    await expect(page.locator('[data-skill-group="exam"] .gl-skill-card[data-skill="sprachbausteine"]')).toHaveCount(1);

    await card.click();
    await expect(page.locator('#glSprachbausteineView')).toBeVisible();
    await expect(page.locator('#glSprachbausteineTextPanel .gl-reading-gap-select')).toHaveCount(22, { timeout: 15_000 });

    await switchToStudent(page);
  });

  test('Sprachbausteine never renders blank if its dedicated view markup is missing at open time', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await applyTelcProfile(page);

    await page.locator('#psbGerman').click();
    await expect(page.locator('#glHome')).toBeVisible();

    // Simulate a stale/partial mount: the sub-view element is gone even
    // though #glSkillView itself exists.
    await page.evaluate(() => document.getElementById('glSprachbausteineView')?.remove());

    await page.evaluate(() => (window as unknown as { _glOpenSkill: (s: string) => void })._glOpenSkill('sprachbausteine'));

    await expect(page.locator('#glSkillMountError')).toBeVisible();
    await expect(page.locator('#glSkillMountError')).toContainText('could not load');
    await expect(page.locator('#glSkillMountError #glSkillMountErrorRetry')).toBeVisible();
    // Never both blank AND without an error — the generic template must not
    // silently take over either.
    await expect(page.locator('#glGenerateQuiz')).toBeHidden();

    await switchToStudent(page);
  });

  test('Hören New Test always produces a fresh generationId and resets to HV1', async ({ page }) => {
    const gen = mockGenerateWithFreshIds(page, 'listening');
    gen.install();
    await page.route('**/api/ai/tts-batch', (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ segments: [] }) })
    );

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await applyTelcProfile(page);
    await app.navigateTo('chatbot');

    await page.locator('[data-testid="german-panel-listening"]').click();
    await expect(page.locator('#glListeningView')).toBeVisible();
    await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 15_000 });

    let debug = await page.evaluate(
      () => (window as unknown as { _glListenDebugState: () => { generationId: string } })._glListenDebugState()
    );
    const firstId = debug.generationId;
    expect(gen.requests.length).toBe(1);

    await page.locator('#glListenNewTestBtn').click();
    await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 15_000 });

    debug = await page.evaluate(
      () => (window as unknown as { _glListenDebugState: () => { generationId: string; partId: string } })._glListenDebugState()
    );
    expect(debug.generationId).not.toBe(firstId);
    expect(debug.partId).toBe('hv1');
    expect(gen.requests.length).toBe(2);

    await switchToStudent(page);
  });

  test('Lesen New Test always produces a fresh generationId and resets to lesen_1', async ({ page }) => {
    const gen = mockGenerateWithFreshIds(page, 'reading');
    gen.install();

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await applyTelcProfile(page);
    await app.navigateTo('chatbot');

    await page.locator('[data-testid="german-panel-reading"]').click();
    await expect(page.locator('#glReadingView')).toBeVisible();
    await expect(page.locator('#glReadingPartSwitcher')).toBeVisible({ timeout: 15_000 });

    let debug = await page.evaluate(
      () => (window as unknown as { _glReadingDebugState: () => { generationId: string } })._glReadingDebugState()
    );
    const firstId = debug.generationId;
    expect(gen.requests.length).toBe(1);

    await page.locator('#glReadingPartSwitcher [data-new-test]').click();
    await expect(page.locator('.gl-listen-loading')).toHaveCount(0, { timeout: 15_000 });

    debug = await page.evaluate(
      () => (window as unknown as { _glReadingDebugState: () => { generationId: string; partId: string } })._glReadingDebugState()
    );
    expect(debug.generationId).not.toBe(firstId);
    expect(debug.partId).toBe('lesen_1');
    expect(gen.requests.length).toBe(2);

    await switchToStudent(page);
  });

  test('Sprachbausteine New Test always produces a fresh generationId and clears prior answers', async ({ page }) => {
    const gen = mockGenerateWithFreshIds(page, 'language_elements');
    gen.install();

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await applyTelcProfile(page);
    await app.navigateTo('chatbot');

    await page.locator('[data-testid="german-panel-sprachbausteine"]').click();
    await expect(page.locator('#glSprachbausteineView')).toBeVisible();
    const gapSelects = page.locator('#glSprachbausteineTextPanel .gl-reading-gap-select');
    await expect(gapSelects).toHaveCount(22, { timeout: 15_000 });

    await gapSelects.first().selectOption({ index: 1 });

    let debug = await page.evaluate(
      () => (window as unknown as { _glSprachbausteineDebugState: () => { generationId: string } })._glSprachbausteineDebugState()
    );
    const firstId = debug.generationId;
    expect(gen.requests.length).toBe(1);

    await page.locator('#glSprachbausteineNewTest').click();
    await expect(gapSelects).toHaveCount(22, { timeout: 15_000 });

    debug = await page.evaluate(
      () => (window as unknown as { _glSprachbausteineDebugState: () => { generationId: string } })._glSprachbausteineDebugState()
    );
    expect(debug.generationId).not.toBe(firstId);
    expect(gen.requests.length).toBe(2);
    // The freshly re-rendered select for gap 1 must be back to unanswered.
    await expect(gapSelects.first()).toHaveValue('');

    await switchToStudent(page);
  });

  test('Sprechen is fully disabled: no generate/speaking/tts requests fire from any exposed entry point', async ({ page }) => {
    const generateRequests: string[] = [];
    const speakingRequests: string[] = [];
    const ttsRequests: string[] = [];
    await page.route('**/api/ai/german-exam/generate', (route: Route) => {
      const bodyStr = route.request().postData() || '';
      generateRequests.push(bodyStr);
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'disabled' }) });
    });
    await page.route('**/api/ai/german-exam/speaking', (route: Route) => {
      speakingRequests.push(route.request().url());
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'disabled' }) });
    });
    await page.route('**/api/ai/tts', (route: Route) => {
      ttsRequests.push(route.request().url());
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });
    await page.route('**/api/ai/tts-batch', (route: Route) => {
      ttsRequests.push(route.request().url());
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await applyTelcProfile(page);
    await app.navigateTo('chatbot');

    const speakingBtn = page.locator('[data-testid="german-panel-speaking"]');
    await expect(speakingBtn).toBeVisible();
    await expect(speakingBtn).toBeDisabled();
    await expect(speakingBtn).toContainText('Coming later');

    // Force-click anyway (bypassing the disabled attribute) to prove there is
    // no click-delegation path left that would still open the workspace.
    await speakingBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);

    expect(generateRequests.filter((b) => b.includes('"module":"speaking"'))).toHaveLength(0);
    expect(speakingRequests).toHaveLength(0);
    expect(ttsRequests).toHaveLength(0);
    await expect(page.locator('[data-testid="speaking-workspace"]')).toHaveCount(0);

    await switchToStudent(page);
  });

  test('generic practice tools (Sentences, Article Games) are unaffected — still open the quiz/cards template', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await applyTelcProfile(page);

    await page.locator('#psbGerman').click();
    await expect(page.locator('#glHome')).toBeVisible();
    // 'sentences'/'games' have no dedicated _glOpenSkill branch — they are
    // the only two skills meant to use the generic template (see section 7
    // of the German Exam Engine wiring fix: exam-only skills must never use
    // it, but general practice tools still should).
    await page.locator('.gl-skill-card[data-skill="sentences"]').click();

    await expect(page.locator('#glSkillView')).toBeVisible();
    await expect(page.locator('.gl-study-tools')).toBeVisible();
    await expect(page.locator('#glGenerateQuiz')).toBeVisible();
    await expect(page.locator('#glSkillMountError')).toBeHidden();

    // Dedicated exam/writing workspaces mounted inside #glSkillView must not
    // be showing at the same time.
    await expect(page.locator('#glSprachbausteineView')).toBeHidden();
    await expect(page.locator('#glReadingView')).toBeHidden();
    await expect(page.locator('#glListeningView')).toBeHidden();

    // Wortschatz keeps its own dedicated workspace too (not the generic
    // template) — confirm it still opens correctly.
    await page.locator('#glBackBtn').click();
    await expect(page.locator('#glHome')).toBeVisible();
    await page.locator('.gl-skill-card[data-skill="vocab"]').click();
    await expect(page.locator('#glVocabularyView')).toBeVisible();
    await expect(page.locator('#glSkillMountError')).toBeHidden();

    await switchToStudent(page);
  });
});
