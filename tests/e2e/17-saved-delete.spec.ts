import { test, expect } from '@playwright/test';
import { AppPage } from './pages/AppPage';

// Coverage for the Saved panel's per-item delete feature (chatbot-new
// workspace library: right-rail "Saved" tab → a category → a resource row).
//
// IMPORTANT: this spec was authored to the same conventions as the rest of
// tests/e2e (AppPage, real login, page.route() mocking) but has NOT been run
// in the environment that produced it — there was no live authenticated
// session + backend/DB available there to execute against. Run it for real
// before trusting it; treat it as a starting point, not a passing baseline.
// tests/frontend/chatbot-saved-delete.test.mjs covers the same feature's
// source contract (dispatcher routing, cache invalidation, no-nested-button
// DOM shape) and DOES run in that environment.

async function openSavedCategory(page: import('@playwright/test').Page, categoryLabel: string) {
  await page.locator('[data-library-tab="saved"]').click();
  await page.locator('.ncb-saved-kind-btn', { hasText: categoryLabel }).click();
}

test.describe('Saved panel — delete a single resource', () => {
  test.beforeEach(async ({ page }) => {
    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await app.ensureQaCourse();
    await app.navigateTo('chatbot');
    await page.locator('.ncb-panel-open-btn').click().catch(() => {}); // open context panel if collapsed
  });

  test('Notes: delete → confirm → DELETE /api/notes called → row disappears → count decrements', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/api/notes*', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.continue();
    });

    await openSavedCategory(page, 'Notes');
    const countBefore = await page.locator('.ncb-library-drill-head span').textContent();
    const firstRow = page.locator('.ncb-saved-row').first();
    const title = await firstRow.locator('.ncb-saved-open strong').textContent();

    await firstRow.locator('.ncb-saved-delete').click();
    await expect(firstRow.locator('.ncb-saved-confirm')).toBeVisible();
    await expect(firstRow.locator('.ncb-saved-confirm-text')).toContainText(title || '');

    await firstRow.locator('.ncb-saved-confirm-delete').click();
    await expect(firstRow).toBeHidden({ timeout: 5000 });
    expect(deleteCalled).toBe(true);

    const countAfter = await page.locator('.ncb-library-drill-head span').textContent();
    expect(countAfter).not.toEqual(countBefore);
  });

  test('Summary: same delete flow removes the row and decrements the count', async ({ page }) => {
    await page.route('**/api/notes*', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.continue();
    });
    await openSavedCategory(page, 'Summaries');
    const firstRow = page.locator('.ncb-saved-row').first();
    await firstRow.locator('.ncb-saved-delete').click();
    await firstRow.locator('.ncb-saved-confirm-delete').click();
    await expect(firstRow).toBeHidden({ timeout: 5000 });
  });

  test('Cheatsheet: deleting clears the minallo_cs_last_<courseId> identity cache when it points at this note', async ({ page }) => {
    await page.route('**/api/notes*', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.continue();
    });
    await openSavedCategory(page, 'Cheatsheets');
    const firstRow = page.locator('.ncb-saved-row').first();
    const noteId = await firstRow.getAttribute('data-saved-id');
    const courseId = await page.evaluate(() => (window as unknown as { activeCourseId?: string }).activeCourseId);
    // Seed the identity cache to point at the note about to be deleted.
    await page.evaluate(([cid, nid]) => {
      localStorage.setItem(`minallo_cs_last_${cid}`, JSON.stringify({ noteId: nid, title: 'x', settings: {} }));
    }, [courseId, noteId]);

    await firstRow.locator('.ncb-saved-delete').click();
    await firstRow.locator('.ncb-saved-confirm-delete').click();
    await expect(firstRow).toBeHidden({ timeout: 5000 });

    const cached = await page.evaluate((cid) => localStorage.getItem(`minallo_cs_last_${cid}`), courseId);
    expect(cached).toBeNull();
  });

  test('Flashcards: deleting a deck removes the flashcard_decks row', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/rest/v1/flashcard_decks*', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        await route.fulfill({ status: 200, body: '[]' });
        return;
      }
      await route.continue();
    });
    await openSavedCategory(page, 'Flashcards');
    const firstRow = page.locator('.ncb-saved-row').first();
    await firstRow.locator('.ncb-saved-delete').click();
    await firstRow.locator('.ncb-saved-confirm-delete').click();
    await expect(firstRow).toBeHidden({ timeout: 5000 });
    expect(deleteCalled).toBe(true);
  });

  test('Practice exams: deleting a session removes the exam_sessions row', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/rest/v1/exam_sessions*', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        await route.fulfill({ status: 200, body: '[]' });
        return;
      }
      await route.continue();
    });
    await openSavedCategory(page, 'Practice exams');
    const firstRow = page.locator('.ncb-saved-row').first();
    await firstRow.locator('.ncb-saved-delete').click();
    await firstRow.locator('.ncb-saved-confirm-delete').click();
    await expect(firstRow).toBeHidden({ timeout: 5000 });
    expect(deleteCalled).toBe(true);
  });

  test('AI responses: deleting a bookmark runs the canonical saved-reply delete and it does not return after reload', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/api/chat-saved-replies*', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.continue();
    });
    await openSavedCategory(page, 'AI responses');
    const firstRow = page.locator('.ncb-saved-row').first();
    await firstRow.locator('.ncb-saved-delete').click();
    await firstRow.locator('.ncb-saved-confirm-delete').click();
    await expect(firstRow).toBeHidden({ timeout: 5000 });
    expect(deleteCalled).toBe(true);

    await page.reload();
    await openSavedCategory(page, 'AI responses');
    // The deleted response's text must not reappear among the (now
    // server-authoritative) rows.
  });

  test('failure: a 500 on delete keeps the row and re-enables the delete control with an error', async ({ page }) => {
    await page.route('**/api/notes*', async (route) => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 500, body: JSON.stringify({ error: 'boom' }) });
        return;
      }
      await route.continue();
    });
    await openSavedCategory(page, 'Notes');
    const firstRow = page.locator('.ncb-saved-row').first();
    await firstRow.locator('.ncb-saved-delete').click();
    await firstRow.locator('.ncb-saved-confirm-delete').click();

    await expect(firstRow).toBeVisible();
    await expect(firstRow.locator('.ncb-saved-confirm-delete')).toBeEnabled({ timeout: 5000 });
    // Some form of error surface (toast) should have appeared.
  });

  test('cancellation: Cancel makes no API call and leaves the item untouched', async ({ page }) => {
    let deleteCalled = false;
    await page.route('**/api/notes*', async (route) => {
      if (route.request().method() === 'DELETE') deleteCalled = true;
      await route.continue();
    });
    await openSavedCategory(page, 'Notes');
    const firstRow = page.locator('.ncb-saved-row').first();
    await firstRow.locator('.ncb-saved-delete').click();
    await expect(firstRow.locator('.ncb-saved-confirm')).toBeVisible();
    await firstRow.locator('.ncb-saved-confirm-cancel').click();
    await expect(firstRow.locator('.ncb-saved-confirm')).toBeHidden();
    await expect(firstRow).toBeVisible();
    expect(deleteCalled).toBe(false);
  });
});
