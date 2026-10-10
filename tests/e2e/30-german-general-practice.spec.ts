import { test, expect, Page, Route } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import { mockAiEndpoints } from './utils/mocks';

/**
 * Wortschatz / Grammatik are general German practice: fresh AI generation via
 * POST /api/ai/german-practice/generate, independent of any exam profile.
 * All endpoints are mocked; this never reaches real OpenAI/python-ai.
 */

const note = { focus: 'f', think: 't', why: 'w', mainRule: 'm', example: 'e' };

function vocabItems(seed: number) {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `v${seed}-${i}`,
    type: 'choice',
    promptHtml: `Satz ${seed}-${i} mit ___.`,
    options: ['a', 'b', 'c', 'd'],
    answerIndex: 0,
    note,
    hints: ['h1', 'h2'],
  }));
}

function grammarItems(seed: number) {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `g${seed}-${i}`,
    type: 'gap',
    promptHtml: `Grammatik ${seed}-${i} ___.`,
    accepted: ['ist'],
    rule: note,
    hints: ['h1', 'h2'],
  }));
}

async function asLearner(page: Page, level: string, withExamProfile: boolean) {
  await page.evaluate(
    ({ level, withExamProfile }) => {
      const w = window as unknown as {
        _userType?: string;
        _applyUserTypeUI?: () => void;
        applyProfile?: (row: Record<string, unknown>) => void;
      };
      w._userType = 'learner';
      w.applyProfile?.({
        user_type: 'learner',
        german_test: withExamProfile ? 'telc' : '',
        german_level: level,
        german_exam_profile_id: withExamProfile ? 'telc_c1_hochschule' : null,
      });
      w._applyUserTypeUI?.();
    },
    { level, withExamProfile }
  );
}

function mockPractice(page: Page, mode: 'ok' | 'fail') {
  const bodies: Array<Record<string, unknown>> = [];
  let counter = 0;
  const install = () =>
    page.route('**/api/ai/german-practice/generate', (route: Route) => {
      const body = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>;
      bodies.push(body);
      counter += 1;
      if (mode === 'fail') {
        return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) });
      }
      const items = body.module === 'grammar' ? grammarItems(counter) : vocabItems(counter);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ schema: 'german-practice-v1', module: body.module, generationId: `gen-${counter}`, source: 'ai', items }),
      });
    });
  return { bodies, install };
}

async function openSkill(page: Page, skill: 'vocab' | 'grammar') {
  await page.locator('#psbGerman').click();
  await expect(page.locator('#glHome')).toBeVisible();
  await page.evaluate((s) => (window as unknown as { _glOpenSkill: (s: string) => void })._glOpenSkill(s), skill);
}

test.describe('German general practice (Wortschatz / Grammatik)', () => {
  test.beforeEach(async ({ page }) => {
    await mockAiEndpoints(page, 'success');
  });

  test('B1 learner without an exam profile: Wortschatz generates fresh AI practice on Start (E, G, K)', async ({ page }) => {
    const gen = mockPractice(page, 'ok');
    await gen.install();
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await asLearner(page, 'B1', false);
    await openSkill(page, 'vocab');

    // Opening the tab must NOT spend a generation.
    await expect(page.locator('#glVocabStartBtn')).toBeVisible();
    expect(gen.bodies.length).toBe(0);

    await page.locator('#glVocabStartBtn').click();
    await expect(page.locator('#glVocabExercise')).toContainText('Satz 1-0', { timeout: 10_000 });
    expect(gen.bodies.length).toBe(1);
    expect(gen.bodies[0]).toMatchObject({ module: 'vocabulary', level: 'B1', count: 10 });
    expect(gen.bodies[0]).not.toHaveProperty('profileId');
    expect(gen.bodies[0]).not.toHaveProperty('userId');
  });

  test('B1 learner without an exam profile: Grammatik generates AI practice (F)', async ({ page }) => {
    const gen = mockPractice(page, 'ok');
    await gen.install();
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await asLearner(page, 'B1', false);
    await openSkill(page, 'grammar');

    await expect(page.locator('#glGramStartBtn')).toBeVisible();
    await page.locator('#glGramStartBtn').click();
    await expect(page.locator('#glGramExercise')).toContainText('Grammatik 1-0', { timeout: 10_000 });
    expect(gen.bodies[0]).toMatchObject({ module: 'grammar', level: 'B1' });
  });

  test('New session generates new content and avoids earlier prompts (H)', async ({ page }) => {
    const gen = mockPractice(page, 'ok');
    await gen.install();
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await asLearner(page, 'C1 Hochschule', true);
    await openSkill(page, 'vocab');

    await page.locator('#glVocabStartBtn').click();
    await expect(page.locator('#glVocabExercise')).toContainText('Satz 1-0', { timeout: 10_000 });
    expect(gen.bodies[0]).toMatchObject({ level: 'C1 Hochschule' });

    await page.evaluate(() => {
      // Jump to the end screen, then start a new session.
      const w = window as unknown as { _glOpenVocabularyView?: () => void };
      w._glOpenVocabularyView?.();
    });
    await page.locator('#glVocabStartBtn').click();
    await expect(page.locator('#glVocabExercise')).toContainText('Satz 2-0', { timeout: 10_000 });
    expect(gen.bodies.length).toBe(2);
    expect((gen.bodies[1].avoidPrompts as string[]).length).toBeGreaterThan(0);
  });

  test('AI failure shows a visible Retry, not a silent static bank (I)', async ({ page }) => {
    const gen = mockPractice(page, 'fail');
    await gen.install();
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await asLearner(page, 'B2', false);
    await openSkill(page, 'vocab');

    await page.locator('#glVocabStartBtn').click();
    await expect(page.locator('#glVocabExercise')).toContainText("Couldn't create practice.", { timeout: 10_000 });
    await expect(page.locator('#glVocabRetryBtn')).toBeVisible();

    // Sample practice is an explicit, labelled choice — never automatic.
    await page.locator('#glVocabSampleBtn').click();
    await expect(page.locator('#glVocabExercise .gl-sample-banner')).toContainText('AI generation unavailable');
  });
});
