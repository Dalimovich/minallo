import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import {
  assertNoCriticalConsoleErrors,
  assertNoCriticalNetworkFailures,
  attachCriticalConsoleCollector,
  attachCriticalNetworkCollector,
  clickAndAssertChanged,
  isDangerous,
  isIntentionallyDisabled,
} from './utils/assertions';
import { clickableAuditSelector } from './utils/selectors';
import { mockAiEndpoints } from './utils/mocks';

test.describe('Human-like button audit', () => {
  test('important visible click targets produce a meaningful UI change', async ({ page }) => {
    await mockAiEndpoints(page, 'success');
    const consoleErrors = attachCriticalConsoleCollector(page);
    const networkFailures = attachCriticalNetworkCollector(page);
    const app = new AppPage(page);

    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.ensureQaCourse();
    await app.navigateTo('home');

    const auditIds = await page.evaluate(selector => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
      let id = 0;

      return candidates
        .filter(el => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            !el.closest('[hidden], [aria-hidden="true"]')
          );
        })
        .map(el => {
          const auditId = `qa-click-${id++}`;
          el.setAttribute('data-qa-audit-id', auditId);
          return {
            auditId,
            label:
              el.getAttribute('data-testid') ||
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) ||
              el.id ||
              el.className.toString(),
          };
        });
    }, clickableAuditSelector);

    expect(auditIds.length).toBeGreaterThan(8);

    const failures: string[] = [];

    for (const item of auditIds.slice(0, 90)) {
      const target = page.locator(`[data-qa-audit-id="${item.auditId}"]`).first();
      if (!(await target.isVisible().catch(() => false))) continue;
      if (await isIntentionallyDisabled(target)) continue;
      if (await isDangerous(target)) continue;

      try {
        await clickAndAssertChanged(target, { label: item.label });
      } catch (error) {
        failures.push(`${item.label}: ${(error as Error).message.split('\n')[0]}`);
      } finally {
        await page.keyboard.press('Escape').catch(() => undefined);
        await page.waitForTimeout(100);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
    await assertNoCriticalConsoleErrors(consoleErrors);
    await assertNoCriticalNetworkFailures(networkFailures);
  });
});
