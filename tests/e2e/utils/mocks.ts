import { Page } from '@playwright/test';

type AiScenario = 'success' | 'loading' | 'error' | 'timeout';

export async function mockAiEndpoints(page: Page, scenario: AiScenario = 'success') {
  await page.route('**/api/ai', async route => {
    if (scenario === 'loading') {
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    if (scenario === 'error') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Mocked AI error for E2E' } }),
      });
      return;
    }

    if (scenario === 'timeout') {
      await new Promise(resolve => setTimeout(resolve, 1200));
      await route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Mocked timeout from AI service' } }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: [
          {
            text: 'Mocked QA response from Minallo. No OpenAI tokens were used for this Playwright run.',
          },
        ],
      }),
    });
  });

  await page.route('**/api/ai/**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, text: 'Mocked AI helper response' }),
    })
  );
}
