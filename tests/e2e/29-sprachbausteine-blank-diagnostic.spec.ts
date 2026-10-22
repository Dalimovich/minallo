import { test, expect, Page } from '@playwright/test';
import { AppPage } from './pages/AppPage';

/**
 * Diagnostic-only run (not an acceptance gate) for the reported blank-
 * workspace state: Sprachbausteine title + New Test button but no
 * generating/passage/error content. Dumps DOM + globals state at several
 * points so the actual failure mode can be read off directly instead of
 * guessed from source.
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

function dumpState(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const byId = (id: string) => document.getElementById(id);
    const disp = (id: string) => {
      const el = byId(id);
      return el ? getComputedStyle(el).display : '(missing)';
    };
    const dupCount = (sel: string) => document.querySelectorAll(sel).length;
    return {
      activeSkill: w['_glActiveSkill'],
      profileLoaded: w['_germanProfileLoaded'],
      profileId: w['_germanExamProfileId'],
      germanTest: w['_germanTest'],
      germanLevel: w['_germanLevel'],
      debug: typeof w['_glSprachbausteineDebugState'] === 'function'
        ? (w['_glSprachbausteineDebugState'] as () => unknown)()
        : null,
      viewExists: !!byId('glSprachbausteineView'),
      viewDisplay: disp('glSprachbausteineView'),
      textPanelExists: !!byId('glSprachbausteineTextPanel'),
      textPanelHtmlLen: (byId('glSprachbausteineTextPanel')?.innerHTML || '').length,
      textPanelHtmlSnippet: (byId('glSprachbausteineTextPanel')?.innerHTML || '').slice(0, 300),
      questionPanelExists: !!byId('glSprachbausteineQuestionPanel'),
      questionPanelHtmlLen: (byId('glSprachbausteineQuestionPanel')?.innerHTML || '').length,
      questionPanelHtmlSnippet: (byId('glSprachbausteineQuestionPanel')?.innerHTML || '').slice(0, 300),
      tabsDisplay: disp('glSprachbausteineTabs'),
      dupView: dupCount('#glSprachbausteineView'),
      dupTextPanel: dupCount('#glSprachbausteineTextPanel'),
      dupQuestionPanel: dupCount('#glSprachbausteineQuestionPanel'),
      dupSkillView: dupCount('#glSkillView'),
    };
  });
}

test.describe('Sprachbausteine blank-state diagnostic', () => {
  test('dump DOM/globals state at 0s/2s/10s/after-response', async ({ page }) => {
    test.setTimeout(3 * 60_000);
    const app = new AppPage(page);
    await realLogin(page);
    await page.evaluate(() => {
      const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
      w._userType = 'learner';
      if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.log('CONSOLE_' + msg.type().toUpperCase(), msg.text());
      }
    });

    let generateReqBody: unknown = null;
    let generateRespStatus: number | null = null;
    let generateRespBodyShape: unknown = null;
    page.on('request', (req) => {
      if (req.url().includes('/api/ai/german-exam/generate')) {
        try { generateReqBody = JSON.parse(req.postData() || '{}'); } catch { generateReqBody = null; }
        console.log('GENERATE_REQUEST_FIRED', JSON.stringify(generateReqBody));
      }
    });
    page.on('response', async (resp) => {
      if (resp.url().includes('/api/ai/german-exam/generate')) {
        generateRespStatus = resp.status();
        try {
          const json = await resp.json();
          generateRespBodyShape = {
            hasGenerationId: !!json?.generationId,
            hasContent: !!json?.content,
            paragraphCount: (json?.content?.text?.paragraphs || []).length,
            questionCount: (json?.content?.questions || []).length,
          };
        } catch {
          generateRespBodyShape = '(non-JSON or parse error)';
        }
        console.log('GENERATE_RESPONSE', generateRespStatus, JSON.stringify(generateRespBodyShape));
      }
    });

    await page.waitForTimeout(30_000); // let delayed modules settle, matching prior repro

    await app.navigateTo('chatbot');
    const link = page.locator('[data-testid="german-panel-sprachbausteine"]');
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();

    console.log('STATE_AT_CLICK', JSON.stringify(await dumpState(page)));
    await page.waitForTimeout(2000);
    console.log('STATE_AT_2s', JSON.stringify(await dumpState(page)));
    await page.waitForTimeout(8000);
    console.log('STATE_AT_10s', JSON.stringify(await dumpState(page)));

    // Wait up to 110 more seconds (120s total) for a /generate response,
    // then dump final state regardless of outcome.
    await page.waitForResponse(
      (r) => r.url().includes('/api/ai/german-exam/generate'),
      { timeout: 110_000 }
    ).catch(() => console.log('NO_GENERATE_RESPONSE_WITHIN_120s'));

    await page.waitForTimeout(500);
    console.log('STATE_AFTER_RESPONSE', JSON.stringify(await dumpState(page)));
    await page.screenshot({ path: 'tests/e2e/report/sprachbausteine-diagnostic.png', fullPage: true }).catch(() => {});
  });
});
