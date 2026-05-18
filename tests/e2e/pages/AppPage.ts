import { Locator, Page, expect } from '@playwright/test';
import {
  assertNoCriticalConsoleErrors,
  assertNoCriticalNetworkFailures,
  clickAndAssertChanged,
  detectModalOrPanel,
  safeClick,
} from '../utils/assertions';
import { sectionSelectors, sidebarSelectors, MainSection } from '../utils/selectors';

/**
 * Shared E2E page object.
 *
 * Important:
 * Do NOT wait for Playwright `networkidle` in this app.
 * Minallo loads Supabase/auth/API/Sentry/background requests, so the network may never
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
          !!localStorage.getItem('sb_sess_refresh') ||
          !!sessionStorage.getItem('sb_sess_token') ||
          Object.keys(localStorage).some(
            key =>
              key.startsWith('sb-') ||
              key.startsWith('sb_sess_') ||
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

  async waitForAppReady(timeout = 30000) {
    await this.waitForAppShell(timeout);
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

  /**
   * Ensures the test is running in an authenticated session.
   * If the stored session has expired or failed, re-authenticates using
   * E2E_EMAIL / E2E_PASSWORD env vars so tests are resilient to token expiry.
   * Returns true if authenticated, false if credentials are missing.
   */
  async loginIfNeeded(): Promise<boolean> {
    const email = process.env.E2E_EMAIL;
    const password = process.env.E2E_PASSWORD;

    // Check if already authenticated (fast path)
    const alreadyAuth = await this.page.evaluate(() => {
      if (sessionStorage.getItem('ss_logged_in') === 'true') return true;
      return !!(
        document.querySelector('#courseAddBtn') ||
        document.querySelector('#sdCourseList') ||
        document.querySelector('#welcomeState') ||
        document.querySelector('#courseOverview')
      );
    }).catch(() => false);

    if (alreadyAuth) return true;
    if (!email || !password) return false;

    // Session expired or invalid — find and click the login button
    const loginBtn = this.page.locator(
      '[data-i18n="landing_nav_login"], #landingLoginBtn, button:has-text("Login"), button:has-text("Sign in")'
    ).first();

    if (await loginBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await loginBtn.click();
    }

    try {
      await this.page.waitForSelector('#authEmail', { timeout: 10000 });
      await this.emailInput.fill(email);
      await this.passwordInput.fill(password);
      await this.loginBtn.click();
      await this.waitForAuthenticated(30000);
      return true;
    } catch {
      return false;
    }
  }

  async navigateTo(section: MainSection) {
    const nav = this.page.locator(sidebarSelectors[section]).first();

    if (await this.page.locator('#portalHamburger').isVisible().catch(() => false)) {
      const sidebarVisible = await this.page.locator('.sidebar').evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.left >= 0 && rect.width > 40;
      }).catch(() => true);
      if (!sidebarVisible) await this.page.locator('#portalHamburger').click();
    }

    await nav.waitFor({ state: 'visible', timeout: 15000 });
    await nav.click();
    await expect(this.page.locator(sectionSelectors[section]).first()).toBeVisible({
      timeout: 15000,
    });
  }

  async clickAndAssertChanged(locator: Locator, label?: string) {
    return clickAndAssertChanged(locator, { label });
  }

  async safeClick(locator: Locator) {
    return safeClick(locator);
  }

  async detectModalOrPanel() {
    return detectModalOrPanel(this.page);
  }

  async assertNoCriticalConsoleErrors(errors: string[]) {
    await assertNoCriticalConsoleErrors(errors);
  }

  async assertNoCriticalNetworkFailures(failures: string[]) {
    await assertNoCriticalNetworkFailures(failures);
  }

  async ensureQaCourse() {
    await this.navigateTo('courses');
    await this.page.waitForTimeout(250);

    const existing = await this.courseCards.count().catch(() => 0);
    if (existing > 0) return;

    await this.page.evaluate(() => {
      const w = window as any;
      const course = {
        id: 'e2e-course',
        name: 'E2E QA Course',
        meta: 'Deterministic Playwright test course',
        files: [
          {
            name: 'qa-lecture.pdf',
            size: '24 KB',
            date: 'Today',
            _uploaded: false,
          },
        ],
        userFolders: [],
      };

      const sems = w.SEMS || w.sems || null;
      const activeId = w.activeSemId || w.sdActiveSemId || (sems ? Object.keys(sems)[0] : null);
      const sem = activeId && sems ? sems[activeId] : null;
      if (sem && Array.isArray(sem.courses)) {
        if (!sem.courses.some((item: any) => item.id === course.id || item.name === course.name)) {
          sem.courses.push(course);
        }
      }

      try {
        localStorage.setItem('ss_fc_e2e-course', '1');
      } catch {
        // localStorage can be unavailable in hardened browser modes.
      }

      if (typeof w.renderCourses === 'function') w.renderCourses();
      if (typeof w.sdRenderCourses === 'function') w.sdRenderCourses();
      if (typeof w.renderSemesters === 'function') w.renderSemesters();
    });

    await expect(this.courseCards.first()).toBeVisible({ timeout: 10000 });
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
