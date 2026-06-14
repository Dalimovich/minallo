import { expect, Locator, Page } from '@playwright/test';
import { appSelectors, destructivePattern } from './selectors';

const ignoredConsolePatterns = [
  /favicon/i,
  /ResizeObserver loop/i,
  /Failed to load resource.*(?:analytics|sentry|posthog|fonts)/i,
];

const ignoredNetworkPatterns = [
  /favicon/i,
  /google-analytics|googletagmanager|sentry|posthog|clarity/i,
  /hot-update/i,
];

export function attachCriticalConsoleCollector(page: Page) {
  const errors: string[] = [];

  page.on('console', msg => {
    if (!['error', 'warning'].includes(msg.type())) return;
    const text = msg.text();
    if (ignoredConsolePatterns.some(pattern => pattern.test(text))) return;
    errors.push(`${msg.type()}: ${text}`);
  });

  page.on('pageerror', err => {
    errors.push(`pageerror: ${err.message}`);
  });

  return errors;
}

export function attachCriticalNetworkCollector(page: Page) {
  const failures: string[] = [];

  page.on('response', response => {
    const status = response.status();
    const url = response.url();
    if (status < 400) return;
    if (ignoredNetworkPatterns.some(pattern => pattern.test(url))) return;
    failures.push(`${status} ${url}`);
  });

  page.on('requestfailed', request => {
    const url = request.url();
    if (ignoredNetworkPatterns.some(pattern => pattern.test(url))) return;
    failures.push(`${request.failure()?.errorText || 'request failed'} ${url}`);
  });

  return failures;
}

export async function assertNoCriticalConsoleErrors(errors: string[]) {
  expect(errors, `Critical console errors:\n${errors.join('\n')}`).toEqual([]);
}

export async function assertNoCriticalNetworkFailures(failures: string[]) {
  expect(failures, `Critical network failures:\n${failures.join('\n')}`).toEqual([]);
}

export async function visibleCount(page: Page, selector: string) {
  return page.locator(selector).evaluateAll(elements =>
    elements.filter(element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0
      );
    }).length
  );
}

export async function snapshotInteractionState(page: Page) {
  return page.evaluate(() => {
    const visibleText = Array.from(document.querySelectorAll('main, #portal, body'))
      .slice(0, 1)
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000))
      .join(' ');
    const active = document.activeElement as HTMLElement | null;
    const openish = Array.from(
      document.querySelectorAll(
        '[role="dialog"], .modal, .ncb-modal-overlay:not([hidden]), .pdf-notes-panel, .st-overlay, [aria-expanded="true"], .on, .active'
      )
    ).map(el => {
      const html = el as HTMLElement;
      const rect = html.getBoundingClientRect();
      const style = window.getComputedStyle(html);
      return [
        html.id,
        html.className,
        html.getAttribute('data-testid'),
        html.getAttribute('aria-expanded'),
        style.display,
        Math.round(rect.width),
        Math.round(rect.height),
      ].join('|');
    });

    return {
      url: location.href,
      hash: location.hash,
      title: document.title,
      activeTag: active?.tagName || '',
      activeId: active?.id || '',
      activeClass: active?.className?.toString() || '',
      activeText: active?.textContent?.trim().slice(0, 80) || '',
      visibleText,
      openish,
    };
  });
}

export async function detectModalOrPanel(page: Page) {
  const modalCount = await visibleCount(page, appSelectors.modal);
  const panelCount = await visibleCount(page, appSelectors.panel);
  return { modalCount, panelCount };
}

export async function isIntentionallyDisabled(locator: Locator) {
  return locator.evaluate(el => {
    const html = el as HTMLElement;
    return (
      html.hasAttribute('disabled') ||
      html.getAttribute('aria-disabled') === 'true' ||
      html.classList.contains('disabled') ||
      html.closest('[disabled],[aria-disabled="true"],.disabled') != null
    );
  });
}

export async function isDangerous(locator: Locator) {
  return locator.evaluate((el, patternSource) => {
    const pattern = new RegExp(patternSource, 'i');
    const html = el as HTMLElement;
    const label = [
      html.textContent,
      html.id,
      html.className,
      html.getAttribute('aria-label'),
      html.getAttribute('title'),
      html.getAttribute('data-testid'),
    ].join(' ');
    return pattern.test(label);
  }, destructivePattern.source);
}

export async function safeClick(locator: Locator, options: { allowDangerous?: boolean } = {}) {
  await expect(locator).toBeVisible({ timeout: 10000 });
  await locator.scrollIntoViewIfNeeded();

  if (await isIntentionallyDisabled(locator)) {
    return { clicked: false, reason: 'disabled' };
  }

  if (!options.allowDangerous && (await isDangerous(locator))) {
    return { clicked: false, reason: 'dangerous' };
  }

  const page = locator.page();
  const fileChooser = page.waitForEvent('filechooser', { timeout: 750 }).catch(() => null);
  await locator.click({ timeout: 10000 });
  const chooser = await fileChooser;
  return { clicked: true, fileChooser: !!chooser };
}

export async function clickAndAssertChanged(
  locator: Locator,
  options: { label?: string; allowDangerous?: boolean } = {}
) {
  const page = locator.page();
  const before = await snapshotInteractionState(page);
  const beforeOpen = await detectModalOrPanel(page);
  const result = await safeClick(locator, { allowDangerous: options.allowDangerous });

  if (!result.clicked) return result;

  await page.waitForTimeout(250);

  const after = await snapshotInteractionState(page);
  const afterOpen = await detectModalOrPanel(page);

  const changed =
    result.fileChooser ||
    before.url !== after.url ||
    before.hash !== after.hash ||
    before.activeId !== after.activeId ||
    before.activeClass !== after.activeClass ||
    before.activeText !== after.activeText ||
    before.visibleText !== after.visibleText ||
    JSON.stringify(before.openish) !== JSON.stringify(after.openish) ||
    beforeOpen.modalCount !== afterOpen.modalCount ||
    beforeOpen.panelCount !== afterOpen.panelCount ||
    (await visibleCount(page, appSelectors.toast)) > 0;

  expect(
    changed,
    `Clickable element did not produce a visible state change: ${options.label || 'unknown'}`
  ).toBeTruthy();

  return result;
}
