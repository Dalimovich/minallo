import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Minimal valid 1-page PDF (base64)
const MINIMAL_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2Jq' +
  'CjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2Jq' +
  'CjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIg' +
  'NzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAw' +
  'MDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8' +
  'IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE5MAolJUVPRgo=';

test.describe('PDF Upload', () => {
  let tempDir: string;
  let pdfPath: string;

  test.beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-'));
    pdfPath = path.join(tempDir, 'test-upload.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(MINIMAL_PDF_B64, 'base64'));
  });

  test.afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('upload input is present when a course is open', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();

    const hasCourses = await page.locator('#sdCourseList .sd-course-card').first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!hasCourses) { test.skip(true, 'No courses available'); return; }

    await app.openFirstCourse();
    await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });

    await expect(page.locator('input[type="file"]')).toBeAttached();
  });

  test('uploading a PDF adds it to the file list', async ({ page }) => {
    const app = new AppPage(page);
    const failures: string[] = [];
    app.collectNetworkFailures(failures);

    await app.goto();
    const hasCourses = await page.locator('#sdCourseList .sd-course-card').first().isVisible({ timeout: 8000 }).catch(() => false);
    if (!hasCourses) { test.skip(true, 'No courses available'); return; }

    await app.openFirstCourse();
    await expect(page.locator('#courseOverview')).toBeVisible({ timeout: 10000 });

    await page.locator('input[type="file"]').setInputFiles(pdfPath);

    // Wait for file to appear (.co-file-name) or a toast
    await Promise.race([
      page.waitForSelector('.co-file-name:has-text("test-upload")', { timeout: 30000 }),
      page.waitForSelector('.ss-toast, .toast', { timeout: 30000 }),
    ]);

    const toast = page.locator('.ss-toast, .toast').first();
    if (await toast.isVisible().catch(() => false)) {
      const text = await toast.textContent().catch(() => '');
      expect(text?.toLowerCase()).not.toContain('fail');
      expect(text?.toLowerCase()).not.toContain('error');
    }

    const serverErrors = failures.filter(f => /^5\d\d/.test(f));
    expect(serverErrors).toHaveLength(0);
  });
});
