import { test, expect, Page } from '@playwright/test';
import { AppPage } from './pages/AppPage';

/**
 * Manual live acceptance run for the German-profile-state-ownership fix
 * (6723c8c) — NOT part of the default suite, run explicitly via:
 *   E2E_BASE_URL=https://minallo.de E2E_EMAIL=... E2E_PASSWORD=... \
 *     npx playwright test tests/e2e/28-sprachbausteine-profile-race.spec.ts --project="Desktop Chrome"
 *
 * Confirms the exact reported failure mode: open Minallo, wait at least 30s
 * so delayed modules (music-services.ts's runDelayed init) run, THEN open
 * Sprachbausteine. Before the fix, a stale/empty localStorage read in that
 * delayed init could clobber the already-resolved German profile globals,
 * so this waits deliberately instead of opening immediately — opening right
 * after login would never have reproduced the race.
 *
 * IMPORTANT: this test used to stop at "/generate fired with the right
 * body", which is NOT sufficient — a live rerun (2026-09-18) showed the
 * request can fire correctly and the profile race can be fixed, while the
 * learner-visible workspace still ends up stuck/blank because of a
 * SEPARATE bug (loadUserData's Promise.all aborting on a query rejection,
 * see 6723c8c's follow-up fix). So this now also asserts the actual DOM
 * the learner sees: the generated passage title, all 22 inline gap
 * selects, and the Check-answers button. A test that only checks the
 * network request can pass while the screen is blank — this one can't.
 */

async function realLogin(page: Page): Promise<void> {
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
    { timeout: 30_000 }
  );
}

test.describe('Sprachbausteine profile-state race — live acceptance', () => {
  test('unsupported-profile message does not appear after a 30s delayed-module wait', async ({ page }) => {
    test.setTimeout(5 * 60_000);
    const app = new AppPage(page);
    await realLogin(page);
    await page.evaluate(() => {
      const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
      w._userType = 'learner';
      if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
    });

    // Deliberately wait for music-services.ts's runDelayed init (~20s after
    // boot) and any other delayed-module init to have run before opening
    // Sprachbausteine — this is the exact window the reported race lived in.
    await page.waitForTimeout(30_000);

    await app.navigateTo('chatbot');

    let generateRequestSeen = false;
    let generateRequestBody: Record<string, unknown> | null = null;
    page.on('request', (req) => {
      if (req.url().includes('/api/ai/german-exam/generate')) {
        generateRequestSeen = true;
        try {
          generateRequestBody = JSON.parse(req.postData() || '{}');
        } catch {
          generateRequestBody = null;
        }
      }
    });

    const link = page.locator('[data-testid="german-panel-sprachbausteine"]');
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    await expect(page.locator('#glSprachbausteineView')).toBeVisible();

    const unsupported = page.getByText('Sprachbausteine practice is currently available for the');
    // Give the resolver a moment (profile-updated listener / generate call)
    // to settle before asserting either way.
    await page.waitForTimeout(3_000);
    const isUnsupportedShown = await unsupported.isVisible().catch(() => false);

    console.log('GENERATE_REQUEST_SEEN', generateRequestSeen);
    console.log('GENERATE_REQUEST_BODY', JSON.stringify(generateRequestBody));
    console.log('UNSUPPORTED_MESSAGE_SHOWN', isUnsupportedShown);

    expect(isUnsupportedShown, 'unsupported-profile message must NOT show for telc C1 Hochschule after the 30s delayed-module wait').toBe(false);
    expect(generateRequestSeen, '/api/ai/german-exam/generate must have fired').toBe(true);
    expect((generateRequestBody as Record<string, unknown> | null)?.['profileId']).toBe('telc_c1_hochschule');
    expect((generateRequestBody as Record<string, unknown> | null)?.['module']).toBe('language_elements');
    expect((generateRequestBody as Record<string, unknown> | null)?.['partId']).toBe('sprachbausteine_1');

    // The blind spot: a passing request does not prove the learner sees
    // anything. Wait for generation to actually finish, then assert the
    // real DOM — the "Generating…" placeholder must be gone and either the
    // rendered exercise or an explicit error/Retry card must be present.
    // A page that's just blank (loading text gone, nothing rendered)
    // fails this even if every network call above was perfect.
    await expect(page.locator('.gl-listen-generating')).toHaveCount(0, { timeout: 120_000 });

    const errorCard = page.locator('.gl-listen-error');
    const isErrorShown = await errorCard.isVisible().catch(() => false);
    if (isErrorShown) {
      const errorText = await errorCard.innerText().catch(() => '');
      throw new Error('Sprachbausteine landed on the error/Retry card instead of a rendered exercise: ' + errorText);
    }

    await expect(page.locator('#glSprachbausteineTextPanel .gl-reading-text-title')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#glSprachbausteineTextPanel .gl-reading-gap-select')).toHaveCount(22, { timeout: 10_000 });
    await expect(page.locator('#glSprachbausteineCheck')).toBeVisible({ timeout: 10_000 });

    const textPanelEmpty = (await page.locator('#glSprachbausteineTextPanel').innerHTML()).trim().length === 0;
    const questionPanelEmpty = (await page.locator('#glSprachbausteineQuestionPanel').innerHTML()).trim().length === 0;
    expect(textPanelEmpty && questionPanelEmpty, 'text and question panels must never both be empty once generation has settled').toBe(false);

    await page.screenshot({ path: 'tests/e2e/report/sprachbausteine-profile-race-rendered.png', fullPage: true }).catch(() => {});
  });
});
