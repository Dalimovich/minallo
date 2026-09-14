import { test, expect, Page } from '@playwright/test';
import { AppPage } from './pages/AppPage';
import { mockAiEndpoints } from './utils/mocks';

/**
 * Regression for a real state-ownership bug: two independent systems were
 * both writing to the same element's `hidden` attribute.
 *
 * workspace-library.ts's selectTab() owns `[data-library-panel]` visibility
 * (Courses/German/Saved are mutually exclusive tabs). But
 * experience-mode.ts's applyChatbotExperienceMode() — run again whenever
 * 'ss-profile-updated' fires, e.g. on every page load once the profile
 * round-trip resolves — used to ALSO set `.ncb-learner-only` elements'
 * `hidden` directly, unconditionally re-showing the German/Practice panel
 * even when Saved was the tab the user had actually selected. Net result:
 * a learner who opened Saved, then refreshed, saw the Practice panel and
 * the Saved panel rendered on top of each other simultaneously.
 *
 * The fix separates the two axes: role visibility now toggles a plain
 * `.ncb-role-hidden` CSS class, leaving the `hidden` attribute solely owned
 * by the tab/workspace-view systems that already manage it correctly.
 */

async function applyProfile(page: Page, profile: Record<string, unknown>) {
  await page.evaluate((p) => {
    const w = window as unknown as { applyProfile?: (row: Record<string, unknown>) => void };
    w.applyProfile?.(p);
  }, profile);
}

async function visiblePanelCount(page: Page): Promise<number> {
  return page.locator('[data-library-panel]:visible').count();
}

test.describe('Chatbot learner shell — Saved tab survives refresh without merging with Practice', () => {
  test.beforeEach(async ({ page }) => {
    await mockAiEndpoints(page, 'success');
  });

  test('learner: open Saved, refresh, Saved stays exclusively active', async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });

    // Initial learner load resolves to Practice (the invalid-role correction:
    // learner + Courses active -> Practice) with exactly one panel visible.
    await expect(page.locator('[data-library-tab="german"]')).toHaveClass(/ncb-library-tab--active/);
    expect(await visiblePanelCount(page)).toBe(1);
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeVisible();

    // Click Saved.
    await page.locator('[data-library-tab="saved"]').click();
    await expect(page.locator('[data-library-tab="saved"]')).toHaveClass(/ncb-library-tab--active/);
    await expect(page.locator('.ncb-library-panel[data-library-panel="saved"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeHidden();
    expect(await visiblePanelCount(page)).toBe(1);

    // Refresh on Saved — this is the exact repro: profile resolves again as
    // learner (ss-profile-updated fires again) after the tab state restores
    // itself as 'saved' from persisted storage.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await app.waitForAppShell();
    await app.navigateTo('chatbot');
    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });

    // The bug: applyChatbotExperienceMode() used to force germanPanel.hidden
    // = false here regardless of the active tab, so both panels ended up
    // visible at once. Assert the fixed, exclusive state.
    await expect(page.locator('[data-library-tab="saved"]')).toHaveClass(/ncb-library-tab--active/);
    await expect(page.locator('.ncb-library-panel[data-library-panel="saved"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeHidden();
    expect(await visiblePanelCount(page)).toBe(1);

    // Click Practice — Saved must fully hide, not stack.
    await page.locator('[data-library-tab="german"]').click();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="saved"]')).toBeHidden();
    expect(await visiblePanelCount(page)).toBe(1);

    // Click Saved again — Practice must fully hide.
    await page.locator('[data-library-tab="saved"]').click();
    await expect(page.locator('.ncb-library-panel[data-library-panel="saved"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeHidden();
    expect(await visiblePanelCount(page)).toBe(1);

    // A second, redundant profile re-apply (e.g. a duplicate
    // ss-profile-updated dispatch) must not touch which tab is showing —
    // this is the core regression: applyChatbotExperienceMode() must never
    // change the active library tab except the intentional invalid-role
    // correction (learner+Courses -> Practice / student+Practice -> Courses).
    await applyProfile(page, { user_type: 'learner', german_level: 'B1' });
    await expect(page.locator('[data-library-tab="saved"]')).toHaveClass(/ncb-library-tab--active/);
    await expect(page.locator('.ncb-library-panel[data-library-panel="saved"]')).toBeVisible();
    await expect(page.locator('.ncb-library-panel[data-library-panel="german"]')).toBeHidden();
    expect(await visiblePanelCount(page)).toBe(1);

    await applyProfile(page, { user_type: 'enrolled' });
  });
});
