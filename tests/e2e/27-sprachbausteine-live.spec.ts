import { test, expect, Page } from '@playwright/test';
import { AppPage } from './pages/AppPage';

/**
 * Manual live validation for Sprachbausteine (real OpenAI, real Supabase,
 * real Hetzner backend) — NOT part of the default suite. Two independently
 * runnable tests, per the staged validation plan (canary before the paid
 * 5-run acceptance batch):
 *
 *   Canary (1 generation):
 *     E2E_BASE_URL=https://minallo.de E2E_EMAIL=... E2E_PASSWORD=... \
 *       npx playwright test tests/e2e/27-sprachbausteine-live.spec.ts \
 *       --project="Desktop Chrome" --grep "canary"
 *
 *   Full acceptance (5 generations + New Test x2, only after canaries pass):
 *     ... --grep "5-run acceptance"
 *
 * Confirms the c699bd0 profile-loading fix (real /generate call, not the
 * "only available for telc C1 Hochschule" unsupported-profile message) and
 * records the fields from the acceptance checklist that are observable from
 * the browser: success/no-5xx, gap count, category split (grammar/lexicon/
 * orthography via skillTags), word count, 4-distinct-options, wall time,
 * and generationId uniqueness across New Test clicks.
 */

type GenerateCall = {
  status: number;
  wallMs: number;
  gapCount: number;
  categoryCounts: Record<string, number>;
  wordCount: number;
  optionsDistinctCount: number[]; // distinct option count per gap
  generationId: string | null;
};

/**
 * Always does a full real-form login, bypassing the "Desktop Chrome"
 * project's storageState entirely — mirrors 22-german-exam-engine-live.spec.ts's
 * realLogin(), which this codebase already relies on for the same reason:
 * Supabase rotates the refresh token on every use, so the SAME static
 * tests/e2e/.auth/user.json (written once by auth.setup.ts) is only valid
 * for the FIRST consumer of it — any later test loading that same
 * storageState gets an already-stale token and never reaches an
 * authenticated UI state.
 *
 * An earlier version of this function tried to detect "already logged in"
 * via page.waitForFunction(fn, {timeout}) — a real bug: waitForFunction's
 * signature is (pageFunction, arg, options), so a 2-argument call puts
 * {timeout} into the `arg` slot (silently ignored, since the predicate
 * takes no parameter) and leaves `options` empty, i.e. NO timeout is ever
 * actually applied. Combined with the stale-token problem above (the
 * predicate never became true), that call hung for the full remainder of
 * the test's own timeout, every single time.
 */
async function ensureLoggedIn(page: Page): Promise<void> {
  const email = process.env.E2E_EMAIL || '';
  const password = process.env.E2E_PASSWORD || '';
  expect(email && password, 'E2E_EMAIL/E2E_PASSWORD must be set').toBeTruthy();

  await page.context().clearCookies();
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const loginBtn = page.locator(
    '#nlNavSignIn, [data-i18n="nav.signIn"], [data-i18n="landing_nav_login"], #landingLoginBtn, button:has-text("Login"), button:has-text("Sign in")'
  ).first();

  let modalOpen = false;
  for (let attempt = 0; attempt < 3 && !modalOpen; attempt++) {
    await loginBtn.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await loginBtn.click().catch(() => {});
    modalOpen = await page.locator('#authEmail').waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
  }
  expect(modalOpen, 'sign-in modal never opened after retries').toBeTruthy();

  await page.locator('#authEmail').fill(email);
  await page.locator('#authPassword').fill(password);
  await page.locator('#authSubmit').click();

  await page.waitForFunction(
    () => sessionStorage.getItem('ss_logged_in') === 'true' ||
      !!document.querySelector('#courseAddBtn') ||
      !!document.querySelector('#sdCourseList') ||
      !!document.querySelector('#welcomeState') ||
      !!document.querySelector('#courseOverview'),
    undefined,
    { timeout: 30_000 }
  );
}

function categorize(skillTags: string[]): string {
  const joined = (skillTags || []).join(' ').toLowerCase();
  if (joined.includes('orth')) return 'orthography';
  if (joined.includes('lex')) return 'lexicon';
  return 'grammar';
}

function wordCount(paragraphs: string[]): number {
  const text = (paragraphs || []).join(' ').replace(/\{\{g\d+\}\}/g, ' ');
  return text.split(/\s+/).filter(Boolean).length;
}

async function loginAndOpenChatbot(page: Page): Promise<AppPage> {
  const app = new AppPage(page);
  await ensureLoggedIn(page);
  await page.evaluate(() => {
    const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
    w._userType = 'learner';
    if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
  });
  await app.navigateTo('chatbot');
  return app;
}

async function openSprachbausteine(page: Page): Promise<void> {
  const link = page.locator('[data-testid="german-panel-sprachbausteine"]');
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.click();
  await expect(page.locator('#glSprachbausteineView')).toBeVisible();
}

function trackGenerateRequestStart(page: Page): { get: () => number } {
  let pendingStart = 0;
  page.on('request', req => {
    if (req.url().includes('/api/ai/german-exam/generate')) pendingStart = Date.now();
  });
  return { get: () => pendingStart };
}

async function waitForGenerateResponse(page: Page, getStart: () => number): Promise<GenerateCall> {
  const resp = await page.waitForResponse(
    r => r.url().includes('/api/ai/german-exam/generate') && r.request().method() === 'POST',
    { timeout: 120_000 }
  );
  const wallMs = Date.now() - getStart();
  const status = resp.status();
  if (status !== 200) {
    return { status, wallMs, gapCount: 0, categoryCounts: {}, wordCount: 0, optionsDistinctCount: [], generationId: null };
  }
  const envelope = await resp.json();
  const questions = (envelope?.content?.questions || []) as Array<{ options: string[]; skillTags: string[] }>;
  const paragraphs = (envelope?.content?.text?.paragraphs || []) as string[];
  const categoryCounts: Record<string, number> = {};
  for (const q of questions) {
    const c = categorize(q.skillTags || []);
    categoryCounts[c] = (categoryCounts[c] || 0) + 1;
  }
  return {
    status,
    wallMs,
    gapCount: questions.length,
    categoryCounts,
    wordCount: wordCount(paragraphs),
    optionsDistinctCount: questions.map(q => new Set(q.options || []).size),
    generationId: envelope?.generationId || null,
  };
}

function acceptanceFailuresFor(c: GenerateCall, label: string): string[] {
  const failures: string[] = [];
  if (c.status !== 200) failures.push(`${label}: HTTP ${c.status}`);
  if (c.gapCount !== 22) failures.push(`${label}: gapCount=${c.gapCount} (expected 22)`);
  const grammar = c.categoryCounts.grammar || 0;
  const lexicon = c.categoryCounts.lexicon || 0;
  const orthography = c.categoryCounts.orthography || 0;
  if (grammar !== 14 || lexicon !== 6 || orthography !== 2) {
    failures.push(`${label}: categories grammar=${grammar} lexicon=${lexicon} orthography=${orthography} (expected 14/6/2)`);
  }
  if (c.wordCount < 320 || c.wordCount > 350) failures.push(`${label}: wordCount=${c.wordCount} (expected 320-350)`);
  const badOptionCounts = c.optionsDistinctCount.filter(n2 => n2 !== 4);
  if (badOptionCounts.length) failures.push(`${label}: ${badOptionCounts.length} gaps did not have 4 distinct options`);
  return failures;
}

test.describe('Sprachbausteine — live validation', () => {
  test.describe.configure({ mode: 'serial' });

  test('canary: one generation, records timing and acceptance fields', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    await loginAndOpenChatbot(page);
    const tracker = trackGenerateRequestStart(page);

    await openSprachbausteine(page);
    const unsupported = page.getByText('Sprachbausteine practice is currently available for the');
    const isUnsupportedShown = await unsupported.isVisible().catch(() => false);
    expect(isUnsupportedShown, 'unsupported-profile message must NOT show for telc C1 Hochschule').toBe(false);

    const call = await waitForGenerateResponse(page, tracker.get);
    await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 120_000 });
    console.log('CANARY_RUN', JSON.stringify(call));

    const failures = acceptanceFailuresFor(call, 'canary');
    console.log('CANARY_FAILURES', JSON.stringify(failures));
    expect(call.status, `canary run must be HTTP 200 (got ${call.status})`).toBe(200);
    expect(failures, `Canary acceptance failures:\n${failures.join('\n')}`).toEqual([]);
  });

  test('5-run acceptance + New Test x2', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const app = await loginAndOpenChatbot(page);
    const tracker = trackGenerateRequestStart(page);
    const calls: GenerateCall[] = [];

    for (let i = 1; i <= 5; i++) {
      if (i > 1) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.evaluate(() => {
          const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
          w._userType = 'learner';
          if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
        });
        await app.navigateTo('chatbot');
      }
      await openSprachbausteine(page);
      const call = await waitForGenerateResponse(page, tracker.get);
      await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 120_000 });
      console.log(`RUN_${i}`, JSON.stringify(call));
      calls.push(call);
    }

    const failures: string[] = [];
    calls.forEach((c, idx) => failures.push(...acceptanceFailuresFor(c, `run ${idx + 1}`)));

    console.log('ALL_RUNS_SUMMARY', JSON.stringify(calls, null, 2));
    console.log('ACCEPTANCE_FAILURES', JSON.stringify(failures, null, 2));

    // --- New Test x2 ---
    const newTestGenIds: (string | null)[] = [];
    for (let i = 0; i < 2; i++) {
      const beforeState = await page.evaluate(() => (window as unknown as { _glSprachbausteineDebugState: () => { generationId: string | null } })._glSprachbausteineDebugState());
      const newTestBtn = page.locator('#glSprachbausteineNewTest');
      await expect(newTestBtn).toBeVisible({ timeout: 20_000 });
      await newTestBtn.click();
      const call = await waitForGenerateResponse(page, tracker.get);
      await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 120_000 });
      console.log(`NEW_TEST_${i + 1}`, JSON.stringify(call));
      newTestGenIds.push(call.generationId);
      if (call.generationId === beforeState.generationId) {
        failures.push(`New Test ${i + 1}: generationId did not change (${call.generationId})`);
      }
      calls.push(call);
    }
    if (newTestGenIds[0] && newTestGenIds[1] && newTestGenIds[0] === newTestGenIds[1]) {
      failures.push('New Test 1 and New Test 2 produced the same generationId');
    }

    console.log('NEW_TEST_GENERATION_IDS', JSON.stringify(newTestGenIds));
    console.log('FINAL_FAILURES', JSON.stringify(failures, null, 2));

    expect(failures, `Acceptance failures:\n${failures.join('\n')}`).toEqual([]);
  });
});
