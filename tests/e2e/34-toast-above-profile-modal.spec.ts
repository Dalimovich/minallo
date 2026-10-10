import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

/**
 * Regression coverage for: toast notifications must render ABOVE the Profile
 * workspace modal (and its backdrop) while the modal stays open — the user
 * must never have to close Profile to see the "exam changed" confirmation.
 *
 * A CSS/unit test alone can prove the z-index tokens compare correctly, but
 * cannot prove the toast is actually painted on top in a real browser, which
 * is what broke here: the toast stack (#ss-toast-stack) used to be mounted
 * one level deep inside #ss-sections-root instead of directly on
 * document.body like .mn-workspace-modal-root, so it depended on that
 * ancestor never gaining a stacking context of its own. This test drives the
 * real UI and checks the actual rendered stacking via elementFromPoint,
 * which only passes if the toast is genuinely on top, not just declared so
 * in CSS.
 */
test.describe('Toast notification layering above the Profile modal', () => {
  test('success and error toasts stay visible above the Profile modal while it remains open', async ({ page }) => {
    test.setTimeout(60_000);
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');

    // The toast stack must be a direct child of document.body — a true sibling
    // of the workspace modal root — not nested inside #ss-sections-root.
    await expect
      .poll(() =>
        page.evaluate(() => document.getElementById('ss-toast-stack')?.parentElement === document.body)
      )
      .toBe(true);

    // Open the real Profile modal through the actual account menu.
    await page.locator('.ncb-account-trigger').click();
    await page.locator('[data-account-view="profile"]').click();

    const modalRoot = page.locator('.mn-workspace-modal-root');
    await expect(modalRoot).toBeVisible();
    await expect(page.locator('#profileGermanTest')).toBeVisible();

    for (const variant of ['success', 'error'] as const) {
      const title = variant === 'success' ? 'Exam changed to Goethe C1' : "Couldn't change exam";
      const sub =
        variant === 'success'
          ? 'Your German practice workspace is being updated.'
          : 'Your previous exam profile is still active.';

      // Fire the exact global notification API the profile save flow calls
      // (frontend/views/profile/profile.js: showToast(...)) while the modal
      // is open, without needing to fabricate a full Supabase round trip.
      await page.evaluate(
        ([t, s, v]) => (window as unknown as { showToast: (t: string, s: string, o?: { variant: string }) => void })
          .showToast(t, s, { variant: v }),
        [title, sub, variant]
      );

      const toast = page.locator('.ss-toast', { hasText: title });
      await expect(toast).toBeVisible();
      await expect(toast).toHaveClass(/is-visible/);

      // The modal must still be open — the notification did not require closing it.
      await expect(modalRoot).toBeVisible();

      // Real stacking check: the element actually painted at the toast's own
      // center point must be the toast (or a descendant of it), not the modal
      // backdrop/dialog sitting on top of it.
      const isOnTop = await toast.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const topElement = document.elementFromPoint(x, y);
        return !!topElement && (topElement === el || el.contains(topElement));
      });
      expect(isOnTop, `toast "${title}" must be the topmost element at its own position while Profile is open`).toBe(true);

      await toast.locator('.ss-toast-close').click();
      await expect(toast).toBeHidden();
    }

    // Closing the modal afterwards still works normally.
    await page.locator('.mn-workspace-close').click();
    await expect(modalRoot).toBeHidden();
  });
});
