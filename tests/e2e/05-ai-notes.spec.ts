import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

const REQUIRED_TERMS = ['Kokillenguss', 'Schlichte', 'Trägerflüssigkeit', 'Bindemittel', 'Regulierstoffe'];
const FORBIDDEN_TERMS = ['Platzhalter', 'Titelfolie', 'Bild einsetzen', 'hinter das Logo'];

async function openPdfForNotes(page: any, app: AppPage): Promise<boolean> {
  await app.goto();
  const hasCourses = await page.locator('#courseList .course-row').first().isVisible({ timeout: 8000 }).catch(() => false);
  if (!hasCourses) return false;
  await app.openFirstCourse();
  const hasFile = await page.locator('.co-file').first().isVisible({ timeout: 5000 }).catch(() => false);
  if (!hasFile) return false;
  await app.openFirstFile();
  return true;
}

test.describe('AI Notes', () => {
  test('notes toggle button is visible when PDF is open', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openPdfForNotes(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    await expect(app.notesToggleBtn).toBeVisible({ timeout: 5000 });
  });

  test('notes panel opens with Generate button', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openPdfForNotes(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    const hasToggle = await app.notesToggleBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasToggle) { test.skip(true, 'Notes toggle not found'); return; }

    await app.openNotesPanel();
    await expect(app.notesPanel).toBeVisible({ timeout: 5000 });
    await expect(app.generateBtn).toBeVisible();
  });

  test('range scope inputs accept page numbers', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openPdfForNotes(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    const hasToggle = await app.notesToggleBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasToggle) { test.skip(true, 'No notes toggle'); return; }
    await app.openNotesPanel();

    const rangeBtn = app.notesPanel.locator('[data-scope="range"]');
    const hasRange = await rangeBtn.isVisible().catch(() => false);
    if (!hasRange) { test.skip(true, 'Range scope not found'); return; }

    await rangeBtn.click();

    const fromInput = page.locator('#npRangeFrom');
    const toInput = page.locator('#npRangeTo');
    await expect(fromInput).toBeVisible();
    await expect(toInput).toBeVisible();

    await fromInput.fill('1');
    await toInput.fill('3');
    expect(await fromInput.inputValue()).toBe('1');
    expect(await toInput.inputValue()).toBe('3');
  });

  test('notes generation completes and produces content (no 504)', async ({ page }) => {
    test.setTimeout(90000);
    const app = new AppPage(page);
    const failures: string[] = [];
    app.collectNetworkFailures(failures);

    const opened = await openPdfForNotes(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    const hasToggle = await app.notesToggleBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasToggle) { test.skip(true, 'No notes toggle'); return; }
    await app.openNotesPanel();

    // Use Range 1–3 to keep it fast
    const rangeBtn = app.notesPanel.locator('[data-scope="range"]');
    if (await rangeBtn.isVisible().catch(() => false)) {
      await rangeBtn.click();
      const from = page.locator('#npRangeFrom');
      const to = page.locator('#npRangeTo');
      if (await from.isVisible()) await from.fill('1');
      if (await to.isVisible()) await to.fill('3');
    }

    await app.generateBtn.click();

    await page.waitForFunction(() => {
      return !document.querySelector('#npGenOverlay[style*="flex"]');
    }, { timeout: 80000 });

    const text = await page.locator('#npPreview').textContent().catch(() => '');
    expect(text?.trim().length).toBeGreaterThan(50);

    expect(failures.filter(f => f.startsWith('504'))).toHaveLength(0);
  });

  test('Kokillenguss notes quality: required terms present, no template garbage', async ({ page }) => {
    test.setTimeout(120000);
    const app = new AppPage(page);
    await app.goto();

    const courseRow = page.locator('#courseList .course-row').filter({ hasText: /gieß|guss|fertigungs|werkstoff/i }).first();
    if (!await courseRow.isVisible().catch(() => false)) { test.skip(true, 'Kokillenguss course not available'); return; }

    await courseRow.click();
    await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });

    const fileItem = page.locator('.co-file').filter({ hasText: /kokillen|gieß/i }).first();
    if (!await fileItem.isVisible().catch(() => false)) { test.skip(true, 'Kokillenguss file not found'); return; }

    const openBtn = fileItem.locator('.co-open-btn');
    if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
    else await fileItem.click();
    await page.waitForFunction(() => (window as any).pdfDoc != null, { timeout: 20000 });

    await app.openNotesPanel();

    await app.generateBtn.click();
    await page.waitForFunction(() => !document.querySelector('#npGenOverlay[style*="flex"]'), { timeout: 100000 });

    const text = (await page.locator('#npPreview').textContent()) || '';
    for (const term of REQUIRED_TERMS) {
      expect(text, `Missing: "${term}"`).toContain(term);
    }
    for (const bad of FORBIDDEN_TERMS) {
      expect(text, `Found garbage: "${bad}"`).not.toContain(bad);
    }
  });

  test('saved notes tab renders without crash', async ({ page }) => {
    const app = new AppPage(page);
    const opened = await openPdfForNotes(page, app);
    if (!opened) { test.skip(true, 'No PDF available'); return; }

    const hasToggle = await app.notesToggleBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasToggle) { test.skip(true, 'No notes toggle'); return; }
    await app.openNotesPanel();

    const savedTab = app.notesPanel.locator('.np-tab[data-tab="saved"]');
    if (!await savedTab.isVisible().catch(() => false)) { test.skip(true, 'No Saved tab'); return; }

    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    await savedTab.click();
    await page.waitForTimeout(1000);

    const crashes = errors.filter(e => e.includes('Maximum call stack') || e.includes('TypeError'));
    expect(crashes).toHaveLength(0);
  });
});
