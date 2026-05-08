import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

async function openAnyPdf(page: any, app: AppPage): Promise<boolean> {
  await app.goto();
  const hasCourses = await page.locator('#courseList .course-row').first().isVisible({ timeout: 8000 }).catch(() => false);
  if (!hasCourses) return false;
  await app.openFirstCourse();
  await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });
  const hasFile = await page.locator('.co-file').first().isVisible({ timeout: 5000 }).catch(() => false);
  if (!hasFile) return false;
  await app.openFirstFile();
  return true;
}

test.describe('PDF Reader', () => {
  test('PDF viewer renders without JS errors', async ({ page }) => {
    const app = new AppPage(page);
    const errors: string[] = [];
    app.collectErrors(errors);

    const opened = await openAnyPdf(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    await expect(page.locator('#pdfBody canvas, #pdfBody iframe')).toBeVisible({ timeout: 20000 });

    const crashes = errors.filter(e =>
      !e.includes('ResizeObserver') &&
      !e.includes('favicon') &&
      !e.includes('accounts.google.com')
    );
    expect(crashes).toHaveLength(0);
  });

  test('page number input is visible and shows page 1', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openAnyPdf(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    const pageInput = page.locator('#pdfPageInput');
    await expect(pageInput).toBeVisible();
    expect(parseInt(await pageInput.inputValue())).toBe(1);
  });

  test('breadcrumb shows file name', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openAnyPdf(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    await expect(page.locator('#breadcrumb')).toBeVisible();
    const text = await page.locator('#breadcrumb').textContent();
    expect(text?.trim().length).toBeGreaterThan(0);
  });

  test('page bookmark restores after reload', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openAnyPdf(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    const totalEl = page.locator('#pdfTotal, #pdfPageTotal, #pdfAll').first();
    const totalText = await totalEl.textContent().catch(() => '1');
    const total = parseInt(totalText?.replace(/\D/g, '') || '1');
    if (total < 3) { test.skip(true, 'PDF too short to test bookmark'); return; }

    const pageInput = page.locator('#pdfPageInput');
    await pageInput.fill('3');
    await pageInput.dispatchEvent('blur');
    await page.waitForTimeout(1000);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => (window as any).pdfDoc != null, { timeout: 20000 });
    await page.waitForTimeout(1500);

    const restored = parseInt(await page.locator('#pdfPageInput').inputValue());
    expect(restored).toBe(3);
  });

  test('notes panel closes when navigating back to course', async ({ page }) => {
    const app = new AppPage(page);
    const errors: string[] = [];
    app.collectErrors(errors);

    const opened = await openAnyPdf(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    // Open notes panel if the toggle button exists
    const hasToggle = await app.notesToggleBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasToggle) {
      await app.openNotesPanel();
      await expect(app.notesPanel).toBeVisible({ timeout: 5000 });
    }

    // Navigate back via breadcrumb click
    await page.locator('#breadcrumb').click();
    await page.waitForTimeout(600);

    const panelStillVisible = await app.notesPanel.isVisible().catch(() => false);
    expect(panelStillVisible).toBe(false);

    const crashes = errors.filter(e => e.includes('Maximum call stack') || e.includes('RangeError'));
    expect(crashes).toHaveLength(0);
  });
});
