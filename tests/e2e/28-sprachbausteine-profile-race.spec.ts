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
 * after login would never have reproduced the race. Only checks that the
 * unsupported-profile message does not appear and that the generate request
 * fires with the right params; does not wait for generation to finish (that
 * pipeline's own correctness is covered by the acceptance run in
 * 27-sprachbausteine-live.spec.ts).
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
    test.setTimeout(3 * 60_000);
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
  });
});
