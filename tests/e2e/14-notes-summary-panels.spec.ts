import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import {
  assertNoCriticalConsoleErrors,
  attachCriticalConsoleCollector,
} from './utils/assertions';
import { notesSelectors } from './utils/selectors';
import { mockAiEndpoints } from './utils/mocks';

test.describe('Notes and summary panels', () => {
  test('lecture notes page and PDF notes panel expose the right controls', async ({ page }) => {
    await mockAiEndpoints(page, 'success');
    const consoleErrors = attachCriticalConsoleCollector(page);
    const app = new AppPage(page);

    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();

    await app.navigateTo('notes');
    await expect(page.locator(notesSelectors.notesPage)).toBeVisible();
    await expect(page.locator('#lnSyncBtn, button:has-text("Sync")').first()).toBeVisible();
    await expect(page.locator('#extHowToBtn, button:has-text("How")').first()).toBeVisible();
    await expect(page.locator(notesSelectors.deleteButton)).toHaveCount(0);

    await page.evaluate(() => {
      const w = window as any;
      w.activeCourseId = w.activeCourseId || 'e2e-course';
      w.activeFileName = w.activeFileName || 'qa-lecture.pdf';
      w.pdfDoc = w.pdfDoc || { numPages: 3 };
      w.pdfPage = w.pdfPage || 1;
      const pdfView = document.getElementById('pdfView');
      if (pdfView) pdfView.style.display = 'flex';
      const wrap = document.getElementById('pdfViewerWrap');
      if (wrap) wrap.style.display = 'flex';
      w._notesPanel?.ensure?.();
      w._notesPanel?.open?.();
    });

    await expect(page.locator(notesSelectors.notesPanel)).toBeVisible();
    await expect(page.locator(notesSelectors.generate)).toBeVisible();
    await expect(page.locator(notesSelectors.summaryPanel)).toBeVisible();

    await page.locator(notesSelectors.summaryPanel).click();
    await expect(page.locator(notesSelectors.summaryPanel)).toHaveClass(/active/);
    await expect(page.locator(notesSelectors.generate)).toContainText(/generate/i);

    await page.locator(notesSelectors.savedTab).click();
    await expect(page.locator(notesSelectors.savedTab)).toHaveClass(/active/);
    await expect(page.locator(notesSelectors.deleteButton)).toHaveCount(0);

    const panelBox = await page.locator(notesSelectors.notesPanel).boundingBox();
    const viewport = page.viewportSize();
    expect(panelBox?.width || 0).toBeGreaterThan(240);
    expect(panelBox?.width || 0).toBeLessThanOrEqual(viewport?.width || 2000);

    await assertNoCriticalConsoleErrors(consoleErrors);
  });
});
