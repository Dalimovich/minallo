import { Page, expect } from '@playwright/test';

/**
 * Shared E2E page object.
 *
 * Important:
 * Do NOT wait for Playwright `networkidle` in this app.
 * StudySphere loads Supabase/auth/API/Sentry/background requests, so the network may never
 * become fully idle even when the UI is ready. Wait for real app UI instead.
 */
export class AppPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Playwright storageState saves localStorage/cookies, but NOT sessionStorage.
   * The app/tests currently use sessionStorage.ss_logged_in, so restore that flag
   * before app scripts run whenever a Supabase/localStorage token exists.
   */
  async installAuthStorageBridge() {
    await this.page.addInitScript(() => {
      try {
        const hasSupabaseToken =
          !!localStorage.getItem('sb_token') ||
          Object.keys(localStorage).some(
            key =>
              key.startsWith('sb-') ||
              key.includes('supabase') ||
              key.includes('auth-token')
          );

        if (hasSupabaseToken) {
          sessionStorage.setItem('ss_logged_in', 'true');
          sessionStorage.setItem('ss_last_active', String(Date.now()));
        }
      } catch {
        // Ignore storage errors in private/security-restricted contexts.
      }
    });
  }

  async goto() {
    await this.installAuthStorageBridge();
    await this.page.goto('/', { waitUntil: 'domcontentloaded' });
    await this.waitForAppShell();
  }

  /**
   * Wait for either authenticated app UI or login UI.
   * This is much more reliable than networkidle.
   */
  async waitForAppShell(timeout = 30000) {
    await this.page.waitForFunction(
      () => {
        const body = document.body;

        const loggedIn = sessionStorage.getItem('ss_logged_in') === 'true';

        const hasAuthenticatedUi =
          !!document.querySelector('#courseAddBtn') ||
          !!document.querySelector('#sdCourseList') ||
          !!document.querySelector('#welcomeState') ||
          !!document.querySelector('#courseOverview');

        const hasAuthUi =
          !!document.querySelector('#authEmail') ||
          !!document.querySelector('#authModal') ||
          !!document.querySelector('#landingLoginBtn') ||
          !!document.querySelector('[data-i18n="landing_nav_login"]');

        const explicitReady =
          body?.getAttribute('data-ss-ready') === 'true' ||
          !!document.querySelector('[data-testid="app-ready"]');

        return explicitReady || loggedIn || hasAuthenticatedUi || hasAuthUi;
      },
      { timeout }
    );
  }

  async waitForAuthenticated(timeout = 30000) {
    await this.page.waitForFunction(
      () => {
        const loggedIn = sessionStorage.getItem('ss_logged_in') === 'true';

        const hasAuthenticatedUi =
          !!document.querySelector('#courseAddBtn') ||
          !!document.querySelector('#sdCourseList') ||
          !!document.querySelector('#welcomeState') ||
          !!document.querySelector('#courseOverview');

        return loggedIn || hasAuthenticatedUi;
      },
      { timeout }
    );
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  get emailInput() {
    return this.page.locator('#authEmail');
  }

  get passwordInput() {
    return this.page.locator('#authPassword');
  }

  get loginBtn() {
    return this.page.locator('#authSubmit');
  }

  async login(email: string, password: string) {
    await this.page.waitForSelector('#authEmail', { timeout: 15000 });
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.loginBtn.click();
    await this.waitForAuthenticated(30000);
  }

  // ── Courses ───────────────────────────────────────────────────────────────
  get addCourseBtn() {
    return this.page.locator('#courseAddBtn').first();
  }

  get courseNameInput() {
    return this.page
      .locator(
        'input[placeholder*="course"], input[id*="courseName"], input[id*="courseAdd"], #courseSearchInput'
      )
      .first();
  }

  get saveCourseBtn() {
    return this.page
      .locator(
        'button:has-text("Save"), button:has-text("Create"), button:has-text("Add"), button[type="submit"]'
      )
      .first();
  }

  get courseCards() {
    return this.page.locator('#sdCourseList .sd-course-card');
  }

  async openFirstCourse() {
    await this.courseCards.first().waitFor({ state: 'visible', timeout: 15000 });
    await this.courseCards.first().click();
    await this.page.waitForSelector('#courseOverview', {
      state: 'visible',
      timeout: 15000,
    });
  }

  async openCourseByName(name: string) {
    const course = this.courseCards.filter({ hasText: name }).first();
    await course.waitFor({ state: 'visible', timeout: 15000 });
    await course.click();
    await this.page.waitForSelector('#courseOverview', {
      state: 'visible',
      timeout: 15000,
    });
  }

  // ── Files ─────────────────────────────────────────────────────────────────
  get uploadInput() {
    return this.page.locator('input[type="file"]');
  }

  get firstFileItem() {
    return this.page.locator('.co-file').first();
  }

  async openFirstFile() {
    await this.firstFileItem.waitFor({ state: 'visible', timeout: 15000 });

    const openBtn = this.page.locator('.co-file .co-open-btn').first();
    const hasOpenBtn = await openBtn.isVisible().catch(() => false);

    if (hasOpenBtn) {
      await openBtn.click();
    } else {
      await this.firstFileItem.click();
    }

    await expect(this.page.locator('#pdfView')).toBeVisible({ timeout: 20000 });
    await this.page.waitForFunction(() => (window as any).pdfDoc != null, {
      timeout: 30000,
    });
  }

  // ── PDF reader ────────────────────────────────────────────────────────────
  get pdfView() {
    return this.page.locator('#pdfView');
  }

  get pdfFileName() {
    return this.page.locator('#pdfFileName');
  }

  get pdfPageInput() {
    return this.page.locator('#pdfPageInput');
  }

  // ── Notes panel ───────────────────────────────────────────────────────────
  get notesToggleBtn() {
    return this.page.locator('#pdfNotesToggle');
  }

  get notesPanel() {
    return this.page.locator('#pdfNotesPanel');
  }

  get generateBtn() {
    return this.page.locator('#npGenerate');
  }

  get notesPreview() {
    return this.page.locator('#npPreview');
  }

  async openNotesPanel() {
    await this.notesToggleBtn.waitFor({ state: 'visible', timeout: 10000 });
    await this.notesToggleBtn.click();
    await expect(this.notesPanel).toBeVisible({ timeout: 10000 });
  }

  // ── Course tabs ───────────────────────────────────────────────────────────
  get quizTab() {
    return this.page.locator('.co-course-tab[data-course-tab="quiz"]');
  }

  get flashcardsTab() {
    return this.page.locator('.co-course-tab[data-course-tab="flashcards"]');
  }

  get filesTab() {
    return this.page.locator('.co-course-tab[data-course-tab="files"]');
  }

  get quizPanel() {
    return this.page.locator('[data-course-panel="quiz"]');
  }

  get flashcardsPanel() {
    return this.page.locator('[data-course-panel="flashcards"]');
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────
  collectErrors(errors: string[]) {
    this.page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    this.page.on('pageerror', err => errors.push(err.message));
  }

  collectNetworkFailures(failures: string[]) {
    this.page.on('response', resp => {
      if (resp.status() >= 400) failures.push(`${resp.status()} ${resp.url()}`);
    });
  }
}
