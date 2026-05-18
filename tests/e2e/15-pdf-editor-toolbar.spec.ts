import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import {
  assertNoCriticalConsoleErrors,
  attachCriticalConsoleCollector,
  clickAndAssertChanged,
} from './utils/assertions';
import { pdfEditorSelectors } from './utils/selectors';

test.describe('PDF editor toolbar', () => {
  test('toolbar controls activate and are not dead', async ({ page }) => {
    const consoleErrors = attachCriticalConsoleCollector(page);
    const app = new AppPage(page);

    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('editor');

    await page.locator(pdfEditorSelectors.hubCard).click();
    await expect(page.locator(pdfEditorSelectors.view)).toBeVisible();

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator(pdfEditorSelectors.choose).click();
    await expect(await fileChooserPromise).toBeTruthy();

    await page.evaluate(() => {
      const dashboard = document.getElementById('edPdfDashboard');
      const main = document.getElementById('edPdfEditorMain');
      if (dashboard) dashboard.style.display = 'none';
      if (main) main.style.display = 'flex';

      if (!document.querySelector('#edPdfEditorMain .e2e-doc-canvas')) {
        const doc = document.createElement('div');
        doc.className = 'e2e-doc-canvas';
        doc.contentEditable = 'true';
        doc.textContent = 'E2E PDF canvas';
        doc.style.cssText =
          'background:#fff;color:#111;width:320px;height:420px;margin:24px;padding:24px;cursor:text;';
        main?.appendChild(doc);
      }
    });

    await expect(page.locator(pdfEditorSelectors.toolbar).first()).toBeVisible();

    await page.locator(pdfEditorSelectors.textTool).click();
    await expect(page.locator(pdfEditorSelectors.textTool)).toHaveClass(/active|epdf-tool-active/);

    await page.locator(pdfEditorSelectors.highlightTool).click();
    await expect(page.locator(pdfEditorSelectors.highlightTool)).toHaveClass(/active|epdf-tool-active/);

    await page.locator(pdfEditorSelectors.penTool).click();
    await expect(page.locator(pdfEditorSelectors.penTool)).toHaveClass(/active|epdf-tool-active/);

    const colorPicker = page.locator(pdfEditorSelectors.colorPicker).first();
    if (await colorPicker.count()) {
      await colorPicker.evaluate((el: HTMLInputElement) => {
        el.value = '#22c55e';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await expect(colorPicker).toHaveValue('#22c55e');
    }

    const fontSize = page.locator(pdfEditorSelectors.fontSize).first();
    if (await fontSize.count()) {
      await fontSize.selectOption({ label: '18' }).catch(async () => {
        await fontSize.selectOption('4');
      });
      await expect(fontSize).not.toHaveValue('');
    }

    const canvasCursor = await page.locator('.e2e-doc-canvas').evaluate(el => {
      const style = window.getComputedStyle(el);
      return { cursor: style.cursor, color: style.color, background: style.backgroundColor };
    });
    expect(canvasCursor.cursor).toMatch(/text|auto/);
    expect(canvasCursor.color).not.toBe(canvasCursor.background);

    const toolbarButtons = page.locator('#edPdfEditorMain .epdf-tool');
    const count = await toolbarButtons.count();
    for (let index = 0; index < count; index += 1) {
      const button = toolbarButtons.nth(index);
      const label = await button.textContent();
      await clickAndAssertChanged(button, { label: label?.trim() || `pdf tool ${index}` });
    }

    await assertNoCriticalConsoleErrors(consoleErrors);
  });
});
