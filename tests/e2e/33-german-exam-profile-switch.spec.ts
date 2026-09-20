import { test, expect, Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppPage } from './pages/AppPage';

/**
 * Profile-driven exam workspace: switching the saved profile from telc C1 Hochschule to
 * Goethe C1 (and back) rebuilds the German exam navigation live — no reload, no stale TELC
 * state — and the client never tells the server which exam it wants.
 *
 * /api/ai/german-exam/manifest is mocked the way the real endpoint behaves: it resolves the
 * exam from the SAVED profile (a test-side variable here), ignoring anything the client sends.
 * The manifests themselves come from tests/e2e/fixtures/german-exam-manifests.json, which a
 * Python test keeps identical to the real per-exam profile files.
 */

type Manifest = { profileId: string; displayName: string; modules: { id: string; label: string; parts: unknown[] }[] };
const MANIFESTS: Record<string, Manifest> = JSON.parse(
  readFileSync(resolve(process.cwd(), 'tests', 'e2e', 'fixtures', 'german-exam-manifests.json'), 'utf8')
);

const TELC = { german_test: 'telc', german_level: 'C1 Hochschule', german_exam_profile_id: 'telc_c1_hochschule' };
const GOETHE = { german_test: 'Goethe', german_level: 'C1', german_exam_profile_id: 'goethe_c1' };

async function installProfileGate(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__gateReleased = false;
    let real: ((p: unknown) => void) | null = null;
    Object.defineProperty(window, 'applyProfile', {
      configurable: true,
      get() {
        return function gated(p: unknown) {
          if (w.__gateReleased && real) real(p);
        };
      },
      set(fn: (p: unknown) => void) {
        real = fn;
      },
    });
    w.__applyProfileNow = (p: unknown) => {
      w.__gateReleased = true;
      if (real) real(p);
    };
  });
}

const applyProfile = (page: Page, profile: Record<string, string>) =>
  page.evaluate((p) => (window as unknown as { __applyProfileNow: (p: unknown) => void }).__applyProfileNow(p), profile);

test.describe('German exam workspace — live profile switching', () => {
  test('telc -> Goethe -> telc rebuilds the exam UI without a reload or stale state', async ({ page }) => {
    test.setTimeout(90_000);
    await installProfileGate(page);

    let savedProfileId = 'telc_c1_hochschule';
    const manifestBodies: string[] = [];
    const generateBodies: Record<string, unknown>[] = [];
    await page.route('**/api/ai/german-exam/manifest', (route: Route) => {
      manifestBodies.push(route.request().postData() || '');
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ profileId: savedProfileId, manifest: MANIFESTS[savedProfileId] }),
      });
    });
    await page.route('**/api/ai/german-exam/generate', (route: Route) => {
      generateBodies.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: 'not available' }) });
    });

    const app = new AppPage(page);
    await app.goto();
    expect(await app.loginIfNeeded()).toBeTruthy();
    await page.evaluate(() => {
      const w = window as unknown as { _userType?: string; _applyUserTypeUI?: () => void };
      w._userType = 'learner';
      if (typeof w._applyUserTypeUI === 'function') w._applyUserTypeUI();
    });
    await app.navigateTo('chatbot');

    const group = page.locator('#glExamGroup');
    const overview = page.locator('#glExamOverview');
    const card = (skill: string) => group.locator(`.gl-skill-card[data-skill="${skill}"]`);

    // ── telc C1 Hochschule ──────────────────────────────────────────────────
    await applyProfile(page, TELC);
    await expect(overview).toContainText('telc Deutsch C1 Hochschule');
    await expect(overview.locator('.gl-exam-module-name')).toHaveText(['Lesen', 'Hören', 'Sprachbausteine', 'Schreiben', 'Sprechen']);
    for (const s of ['reading', 'listening', 'sprachbausteine', 'writing']) await expect(card(s)).toBeVisible();

    // Something profile-specific to discard: a held prefetch/prepared state marker.
    await page.evaluate(() => {
      (window as unknown as { __staleMarker?: string }).__staleMarker = 'telc';
    });

    // ── switch to Goethe C1 — live, no reload ───────────────────────────────
    savedProfileId = 'goethe_c1';
    await applyProfile(page, GOETHE);
    await expect(overview).toContainText('Goethe-Zertifikat C1');
    await expect(overview).toContainText('Prepare for your actual exam format');
    await expect(overview.locator('.gl-exam-module-name')).toHaveText(['Lesen', 'Hören', 'Schreiben', 'Sprechen']);
    await expect(overview.locator('[data-exam-module="reading"] .gl-exam-module-meta')).toContainText('4 parts');
    await expect(overview.locator('[data-exam-module="writing"] .gl-exam-module-meta')).toContainText('2 parts');
    // Sprachbausteine does not exist for Goethe: not disabled, not empty — absent.
    await expect(card('sprachbausteine')).toBeHidden();
    await expect(overview).not.toContainText('Sprachbausteine');
    // The page was never reloaded.
    expect(await page.evaluate(() => (window as unknown as { __staleMarker?: string }).__staleMarker)).toBe('telc');
    // General practice stays available and is separate from the exam sections.
    await expect(page.locator('[data-skill-group="general"] .gl-skill-card[data-skill="vocab"]')).toBeVisible();
    await expect(page.locator('[data-skill-group="general"] .gl-skill-card[data-skill="grammar"]')).toBeVisible();

    // Goethe parts are not generatable yet: opening one is refused, never routed to TELC's view.
    await card('reading').click();
    await expect(page.locator('#glReadingView')).toBeHidden();
    expect(generateBodies.filter((b) => b.profileId === 'telc_c1_hochschule')).toHaveLength(0);

    // The client never asks for a specific exam: the manifest request carries no profile id.
    expect(manifestBodies.length).toBeGreaterThanOrEqual(2);
    for (const body of manifestBodies) expect(body).not.toMatch(/profileId|telc|goethe/i);

    // ── and back to telc ────────────────────────────────────────────────────
    savedProfileId = 'telc_c1_hochschule';
    await applyProfile(page, TELC);
    await expect(overview).toContainText('telc Deutsch C1 Hochschule');
    await expect(overview.locator('.gl-exam-module-name')).toHaveText(['Lesen', 'Hören', 'Sprachbausteine', 'Schreiben', 'Sprechen']);
    await expect(card('sprachbausteine')).toBeVisible();
    await expect(overview).not.toContainText('Goethe');
  });
});
