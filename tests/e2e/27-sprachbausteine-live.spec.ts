import { test, expect, Page } from '@playwright/test';
import { AppPage } from './pages/AppPage';

/**
 * Manual live acceptance run for Sprachbausteine (real OpenAI, real
 * Supabase, real Hetzner backend at 82fb9ed+) — NOT part of the default
 * suite, run explicitly via:
 *   E2E_BASE_URL=https://minallo.de E2E_EMAIL=... E2E_PASSWORD=... \
 *     npx playwright test tests/e2e/27-sprachbausteine-live.spec.ts --project="Desktop Chrome"
 *
 * Confirms the c699bd0 profile-loading fix (real /generate call, not the
 * "only available for telc C1 Hochschule" unsupported-profile message),
 * then runs 5 fresh generations + 2 New Test clicks, recording the fields
 * from the user's acceptance checklist that are actually observable from
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
 * The "Desktop Chrome" project already loads a valid session for this same
 * E2E_EMAIL/PASSWORD from tests/e2e/.auth/user.json (written by
 * auth.setup.ts, which runs first as a project dependency). Supabase's
 * session lives in localStorage, not cookies, so page.goto('/') here
 * lands already-authenticated underneath any storageState. Forcing a
 * fresh form login on top of that (clearCookies + click "Sign in") opened
 * a stuck auth modal that never closed and blocked every click for the
 * rest of the run — mirrors auth.setup.ts's own already-authenticated
 * check instead of fighting it.
 */
async function ensureLoggedIn(page: Page): Promise<void> {
  const email = process.env.E2E_EMAIL || '';
  const password = process.env.E2E_PASSWORD || '';
  expect(email && password, 'E2E_EMAIL/E2E_PASSWORD must be set').toBeTruthy();

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const isLoggedIn = await page.waitForFunction(
    () => sessionStorage.getItem('ss_logged_in') === 'true' ||
      !!document.querySelector('#courseAddBtn') ||
      !!document.querySelector('#sdCourseList') ||
      !!document.querySelector('#welcomeState') ||
      !!document.querySelector('#courseOverview'),
    { timeout: 15_000 }
  ).then(() => true).catch(() => false);

  if (isLoggedIn) return;

  const loginBtn = page.locator(
    '#nlNavSignIn, [data-i18n="nav.signIn"], [data-i18n="landing_nav_login"], #landingLoginBtn, button:has-text("Login"), button:has-text("Sign in")'
  ).first();
  await loginBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await loginBtn.click();
  await page.locator('#authEmail').waitFor({ state: 'visible', timeout: 8_000 });
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPassword').fill(password);
  await page.locator('#authSubmit').click();

  await page.waitForFunction(
    () => sessionStorage.getItem('ss_logged_in') === 'true' ||
      !!document.querySelector('#courseAddBtn') ||
      !!document.querySelector('#sdCourseList') ||
      !!document.querySelector('#welcomeState') ||
      !!document.querySelector('#courseOverview'),
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

test.describe('Sprachbausteine — live acceptance run', () => {
  test.describe.configure({ mode: 'serial' });

  test('confirmation + 5-run acceptance + New Test x2', async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const app = new AppPage(page);
    await ensureLoggedIn(page);
    await page.evaluate(() => {
      const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
      w._userType = 'learner';
      if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
    });

    await app.navigateTo('chatbot');

    const calls: GenerateCall[] = [];
    let pendingStart = 0;
    page.on('request', req => {
      if (req.url().includes('/api/ai/german-exam/generate')) pendingStart = Date.now();
    });

    const openSprachbausteine = async () => {
      const link = page.locator('[data-testid="german-panel-sprachbausteine"]');
      await expect(link).toBeVisible({ timeout: 20_000 });
      await link.click();
      await expect(page.locator('#glSprachbausteineView')).toBeVisible();
    };

    const waitForGenerateResponse = async (): Promise<GenerateCall> => {
      const resp = await page.waitForResponse(
        r => r.url().includes('/api/ai/german-exam/generate') && r.request().method() === 'POST',
        { timeout: 120_000 }
      );
      const wallMs = Date.now() - pendingStart;
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
    };

    // --- Step 1: confirmation attempt (proves c699bd0 fix: no unsupported-profile message) ---
    await openSprachbausteine();
    const unsupported = page.getByText('Sprachbausteine practice is currently available for the');
    const isUnsupportedShown = await unsupported.isVisible().catch(() => false);
    expect(isUnsupportedShown, 'unsupported-profile message must NOT show for telc C1 Hochschule').toBe(false);

    const firstCall = await waitForGenerateResponse();
    await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 120_000 });
    console.log('CONFIRMATION_RUN', JSON.stringify(firstCall));
    expect(firstCall.status, 'confirmation run must be HTTP 200').toBe(200);
    calls.push(firstCall);

    // --- Step 2: 4 more fresh generations via full page reload (5 total) ---
    for (let i = 2; i <= 5; i++) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
        w._userType = 'learner';
        if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
      });
      await app.navigateTo('chatbot');
      await openSprachbausteine();
      const call = await waitForGenerateResponse();
      await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 120_000 });
      console.log(`RUN_${i}`, JSON.stringify(call));
      calls.push(call);
    }

    // --- Acceptance rule checks across all 5 runs ---
    const failures: string[] = [];
    calls.forEach((c, idx) => {
      const n = idx + 1;
      if (c.status !== 200) failures.push(`run ${n}: HTTP ${c.status}`);
      if (c.gapCount !== 22) failures.push(`run ${n}: gapCount=${c.gapCount} (expected 22)`);
      const grammar = c.categoryCounts.grammar || 0;
      const lexicon = c.categoryCounts.lexicon || 0;
      const orthography = c.categoryCounts.orthography || 0;
      if (grammar !== 14 || lexicon !== 6 || orthography !== 2) {
        failures.push(`run ${n}: categories grammar=${grammar} lexicon=${lexicon} orthography=${orthography} (expected 14/6/2)`);
      }
      if (c.wordCount < 320 || c.wordCount > 350) failures.push(`run ${n}: wordCount=${c.wordCount} (expected 320-350)`);
      const badOptionCounts = c.optionsDistinctCount.filter(n2 => n2 !== 4);
      if (badOptionCounts.length) failures.push(`run ${n}: ${badOptionCounts.length} gaps did not have 4 distinct options`);
    });

    console.log('ALL_RUNS_SUMMARY', JSON.stringify(calls, null, 2));
    console.log('ACCEPTANCE_FAILURES', JSON.stringify(failures, null, 2));

    // --- New Test x2 ---
    const newTestGenIds: (string | null)[] = [];
    for (let i = 0; i < 2; i++) {
      const beforeState = await page.evaluate(() => (window as unknown as { _glSprachbausteineDebugState: () => { generationId: string | null } })._glSprachbausteineDebugState());
      const newTestBtn = page.locator('#glSprachbausteineNewTest');
      await expect(newTestBtn).toBeVisible({ timeout: 20_000 });
      await newTestBtn.click();
      const call = await waitForGenerateResponse();
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
