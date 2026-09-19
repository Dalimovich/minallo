import { test, expect, Page, Route } from '@playwright/test';
import { AppPage } from './pages/AppPage';

/**
 * Regression coverage for the Lesen/Hören profile-load race: opening either
 * view before applyProfile() (frontend/js/features/auth/user-data.ts) has
 * resolved must NOT fall back to static RD_SETS/LISTEN_SETS. It must show a
 * loading state and retry the generated path once the profile resolves (via
 * the ss-profile-updated listeners added next to _glOpenReadingView /
 * _glOpenListeningView in practice.js).
 *
 * Every real applyProfile() call (both the synchronous cached-profile apply
 * at boot and the later network-fresh one) is held behind a gate installed
 * before the app loads, so the test controls exactly when the profile
 * "arrives" regardless of how fast the real account's own profile fetch
 * happens to be. Releasing the gate feeds a synthetic, deterministic
 * telc/C1 Hochschule profile through the REAL applyProfile() implementation
 * — this exercises the real code path, not a stand-in.
 *
 * /api/ai/german-exam/generate and /api/ai/tts-batch are mocked (not live)
 * so this suite is fast and deterministic enough to run on every push,
 * unlike the live-generation suites in 22/23.
 */

async function installProfileGate(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __profileGateReleased: boolean }).__profileGateReleased = false;
    let real: ((p: unknown) => void) | null = null;
    Object.defineProperty(window, 'applyProfile', {
      configurable: true,
      get() {
        return function gatedApplyProfile(p: unknown) {
          const w = window as unknown as { __profileGateReleased: boolean };
          if (w.__profileGateReleased && real) real(p);
          // While gated, every applyProfile call (cached-at-boot AND the
          // later network-fresh one) is silently swallowed — this is the
          // "profile still loading" window the test wants to hold open.
        };
      },
      set(fn: (p: unknown) => void) {
        real = fn;
      },
    });
    (window as unknown as { __releaseGermanProfileGate: (p: unknown) => void }).__releaseGermanProfileGate = (
      profile: unknown
    ) => {
      (window as unknown as { __profileGateReleased: boolean }).__profileGateReleased = true;
      if (real) real(profile);
    };
  });
}

async function releaseProfileGate(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __releaseGermanProfileGate: (p: unknown) => void }).__releaseGermanProfileGate({
      german_test: 'telc',
      german_level: 'C1 Hochschule',
      german_exam_profile_id: 'telc_c1_hochschule',
    });
  });
}

function mockReadingGenerate(page: Page) {
  const requests: string[] = [];
  return {
    requests,
    install: () =>
      page.route('**/api/ai/german-exam/generate', (route: Route) => {
        requests.push(route.request().url());
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generationId: 'race-test-gen-1',
            module: 'reading',
            part: { id: 'lesen_1' },
            exam: {
              family: 'telc',
              variant: 'C1 Hochschule',
              cefrLevel: 'C1',
              profileId: 'telc_c1_hochschule',
              profileVersion: 1,
            },
            content: {
              text: { title: 'Race test text', paragraphs: ['Erster Absatz {{g1}}.'] },
              candidates: [{ candidateId: 'c1', text: 'Kandidat A' }],
              questions: [],
            },
          }),
        });
      }),
  };
}

function mockSprachbausteineGenerate(page: Page) {
  const requests: string[] = [];
  const CATEGORY_PLAN = [
    ...Array(14).fill('grammar'),
    ...Array(6).fill('lexicon'),
    ...Array(2).fill('orthography'),
  ];
  return {
    requests,
    install: () =>
      page.route('**/api/ai/german-exam/generate', (route: Route) => {
        requests.push(route.request().url());
        const paragraphs: string[] = [];
        let gapN = 1;
        for (let p = 0; p < 8; p++) {
          const words = Array(40).fill('Wort');
          const gapsHere = p < 6 ? 3 : 2;
          for (let g = 0; g < gapsHere && gapN <= 22; g++) {
            words.push(`{{g${gapN}}}`);
            gapN++;
          }
          paragraphs.push(words.join(' '));
        }
        const gaps = Array.from({ length: 22 }, (_, i) => ({ gapId: `g${i + 1}` }));
        const questions = Array.from({ length: 22 }, (_, i) => ({
          questionId: `q${i + 1}`,
          gapId: `g${i + 1}`,
          options: [`opt${i + 1}a`, `opt${i + 1}b`, `opt${i + 1}c`, `opt${i + 1}d`],
          correctIndex: 0,
          category: CATEGORY_PLAN[i],
          skillTags: ['grammar'],
          difficulty: 'c1',
        }));
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generationId: 'race-test-gen-3',
            module: 'language_elements',
            part: { id: 'sprachbausteine_1' },
            exam: {
              family: 'telc',
              variant: 'C1 Hochschule',
              cefrLevel: 'C1',
              profileId: 'telc_c1_hochschule',
              profileVersion: 1,
            },
            content: { text: { title: 'Race test cloze', paragraphs, gaps }, questions },
          }),
        });
      }),
  };
}

function mockListeningEndpoints(page: Page) {
  const generateRequests: string[] = [];
  const ttsRequests: string[] = [];
  return {
    generateRequests,
    ttsRequests,
    install: async () => {
      await page.route('**/api/ai/german-exam/generate', (route: Route) => {
        generateRequests.push(route.request().url());
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            generationId: 'race-test-gen-2',
            module: 'listening',
            part: { id: 'hv1', title: 'Race test listening', taskType: 'sentence_completion_mc3' },
            exam: {
              family: 'telc',
              variant: 'C1 Hochschule',
              cefrLevel: 'C1',
              profileId: 'telc_c1_hochschule',
              profileVersion: 1,
            },
            content: {
              segments: [{ id: 's1', speakerId: 'sp1', spokenText: 'Hallo.', displayText: 'Hallo.' }],
              questions: [],
            },
          }),
        });
      });
      await page.route('**/api/ai/tts-batch', (route: Route) => {
        ttsRequests.push(route.request().url());
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ segments: [{ id: 's1', audioUrl: 'data:audio/mp3;base64,AA==' }] }),
        });
      });
    },
  };
}

async function switchToLearner(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
    w._userType = 'learner';
    if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
  });
}

test.describe('German Practice — profile-load race (Lesen/Hören)', () => {
  test('Lesen: opened before the profile resolves shows a loading state, then generates exactly once and never shows static RD_SETS', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await installProfileGate(page);
    const gen = mockReadingGenerate(page);
    await gen.install();

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await app.navigateTo('chatbot');

    await page.locator('[data-testid="german-panel-reading"]').click();
    await expect(page.locator('#glReadingView')).toBeVisible();

    // Profile is still gated — must show the waiting state, not RD_SETS.
    await expect(page.locator('.gl-listen-loading')).toBeVisible();
    expect(gen.requests.length).toBe(0);
    let debug = await page.evaluate(
      () => (window as unknown as { _glReadingDebugState: () => { usingGenerated: boolean } })._glReadingDebugState()
    );
    expect(debug.usingGenerated).toBe(false);

    await releaseProfileGate(page);

    await expect(page.locator('.gl-listen-loading')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('#glReadingPartSwitcher')).toBeVisible();
    debug = await page.evaluate(
      () => (window as unknown as { _glReadingDebugState: () => { usingGenerated: boolean } })._glReadingDebugState()
    );
    expect(debug.usingGenerated).toBe(true);
    expect(gen.requests.length).toBe(1);
  });

  test('Sprachbausteine: opened before the profile resolves shows a loading state, then generates exactly once, and scoring works after answering all 22 gaps', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await installProfileGate(page);
    const gen = mockSprachbausteineGenerate(page);
    await gen.install();

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await app.navigateTo('chatbot');

    await page.locator('[data-testid="german-panel-sprachbausteine"]').click();
    await expect(page.locator('#glSprachbausteineView')).toBeVisible();

    // Profile is still gated — must show the waiting state, never a generate call.
    await expect(page.locator('.gl-listen-loading')).toBeVisible();
    expect(gen.requests.length).toBe(0);
    let debug = await page.evaluate(
      () => (window as unknown as { _glSprachbausteineDebugState: () => { usingGenerated: boolean; questionCount: number } })._glSprachbausteineDebugState()
    );
    expect(debug.usingGenerated).toBe(false);

    await releaseProfileGate(page);

    await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 15_000 });
    debug = await page.evaluate(
      () => (window as unknown as { _glSprachbausteineDebugState: () => { usingGenerated: boolean; questionCount: number } })._glSprachbausteineDebugState()
    );
    expect(debug.usingGenerated).toBe(true);
    expect(debug.questionCount).toBe(22);
    expect(gen.requests.length).toBe(1);

    const gapSelects = page.locator('#glSprachbausteineTextPanel .gl-reading-gap-select');
    await expect(gapSelects).toHaveCount(22);
    const count = await gapSelects.count();
    for (let i = 0; i < count; i++) {
      await gapSelects.nth(i).selectOption({ index: 1 }); // index 0 in each item's options == correctIndex
    }
    await page.click('#glSprachbausteineCheck');
    await expect(page.locator('.gl-reading-result-summary')).toHaveText('Score: 22 / 22');
  });

  test('Hören: opened before the profile resolves shows a loading state, then generates exactly once, fetches TTS exactly once, and never shows static LISTEN_SETS', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await installProfileGate(page);
    const mocks = mockListeningEndpoints(page);
    await mocks.install();

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);
    await app.navigateTo('chatbot');

    await page.locator('[data-testid="german-panel-listening"]').click();
    await expect(page.locator('#glListeningView')).toBeVisible();

    await expect(page.locator('.gl-listen-generating')).toBeVisible();
    expect(mocks.generateRequests.length).toBe(0);
    expect(mocks.ttsRequests.length).toBe(0);
    let debug = await page.evaluate(
      () => (window as unknown as { _glListenDebugState: () => { usingGenerated: boolean } })._glListenDebugState()
    );
    expect(debug.usingGenerated).toBe(false);

    await releaseProfileGate(page);

    await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 15_000 });
    debug = await page.evaluate(
      () => (window as unknown as { _glListenDebugState: () => { usingGenerated: boolean } })._glListenDebugState()
    );
    expect(debug.usingGenerated).toBe(true);
    expect(mocks.generateRequests.length).toBe(1);
    expect(mocks.ttsRequests.length).toBe(1);
  });

  test('a profile that has definitively loaded and is genuinely unsupported still gets the static fallback (Lesen/Hören) or an explicit unsupported message (Sprachbausteine, which has no static content), with no generate call', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await installProfileGate(page);
    const readingGen = mockReadingGenerate(page);
    await readingGen.install();
    const listeningMocks = mockListeningEndpoints(page);
    await listeningMocks.install();
    const sprachbausteineGen = mockSprachbausteineGenerate(page);
    await sprachbausteineGen.install();

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await switchToLearner(page);

    // Release the gate with a definitively-loaded, unsupported profile
    // (empty test/level, no profile id) BEFORE opening either view.
    await page.evaluate(() => {
      (window as unknown as { __releaseGermanProfileGate: (p: unknown) => void }).__releaseGermanProfileGate({
        german_test: '',
        german_level: '',
        german_exam_profile_id: null,
      });
    });

    await app.navigateTo('chatbot');

    await page.locator('[data-testid="german-panel-reading"]').click();
    await expect(page.locator('#glReadingView')).toBeVisible();
    await expect(page.locator('.gl-listen-loading')).toHaveCount(0);
    let readingDebug = await page.evaluate(
      () => (window as unknown as { _glReadingDebugState: () => { usingGenerated: boolean } })._glReadingDebugState()
    );
    expect(readingDebug.usingGenerated).toBe(false);
    expect(readingGen.requests.length).toBe(0);

    await page.locator('[data-testid="german-panel-listening"]').click();
    await expect(page.locator('#glListeningView')).toBeVisible();
    await expect(page.locator('.gl-listen-generating')).toHaveCount(0);
    const listenDebug = await page.evaluate(
      () => (window as unknown as { _glListenDebugState: () => { usingGenerated: boolean } })._glListenDebugState()
    );
    expect(listenDebug.usingGenerated).toBe(false);
    expect(listeningMocks.generateRequests.length).toBe(0);
    expect(listeningMocks.ttsRequests.length).toBe(1); // static LISTEN_SETS still goes through lsPlayer.setSegments()

    await page.locator('[data-testid="german-panel-sprachbausteine"]').click();
    await expect(page.locator('#glSprachbausteineView')).toBeVisible();
    await expect(page.locator('.gl-listen-loading')).toHaveCount(0);
    await expect(page.locator('.gl-listen-weak-empty')).toBeVisible();
    const sbDebug = await page.evaluate(
      () => (window as unknown as { _glSprachbausteineDebugState: () => { usingGenerated: boolean } })._glSprachbausteineDebugState()
    );
    expect(sbDebug.usingGenerated).toBe(false);
    expect(sprachbausteineGen.requests.length).toBe(0);
  });
});
