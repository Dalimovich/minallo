import { Page, expect } from '@playwright/test';

export class AppPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('/');
    await this.page.waitForLoadState('networkidle');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  get emailInput() { return this.page.locator('input[type="email"]'); }
  get passwordInput() { return this.page.locator('input[type="password"]'); }
  get loginBtn() { return this.page.locator('button[id="loginBtn"], button:has-text("Sign in"), button:has-text("Log in")').first(); }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.loginBtn.click();
    await this.page.waitForSelector('#welcomeState, #courseOverview, #courseList .course-row', { timeout: 15000 });
  }

  // ── Courses ───────────────────────────────────────────────────────────────
  // Real IDs from portal.html / courses-render.js
  get addCourseBtn() { return this.page.locator('#courseAddBtn').first(); }
  get courseNameInput() { return this.page.locator('input[placeholder*="course"], input[id*="courseName"], input[id*="courseAdd"], #courseSearchInput').first(); }
  get saveCourseBtn() { return this.page.locator('button:has-text("Save"), button:has-text("Create"), button:has-text("Add"), button[type="submit"]').first(); }

  // Course items are .course-row inside #courseList
  async openFirstCourse() {
    await this.page.locator('#courseList .course-row').first().click();
    await this.page.waitForSelector('#courseOverview', { state: 'visible', timeout: 10000 });
  }

  async openCourseByName(name: string) {
    await this.page.locator('#courseList .course-row').filter({ hasText: name }).first().click();
    await this.page.waitForSelector('#courseOverview', { state: 'visible', timeout: 10000 });
  }

  // ── Files ─────────────────────────────────────────────────────────────────
  // Real class from course-render.js: .co-file  with .co-file-name inside
  get uploadInput() { return this.page.locator('input[type="file"]'); }
  get firstFileItem() { return this.page.locator('.co-file').first(); }

  async openFirstFile() {
    const openBtn = this.page.locator('.co-file .co-open-btn').first();
    const hasOpenBtn = await openBtn.isVisible().catch(() => false);
    if (hasOpenBtn) {
      await openBtn.click();
    } else {
      await this.firstFileItem.click();
    }
    await expect(this.page.locator('#pdfView')).toBeVisible({ timeout: 15000 });
    await this.page.waitForFunction(() => (window as any).pdfDoc != null, { timeout: 20000 });
  }

  // ── PDF reader ────────────────────────────────────────────────────────────
  get pdfView() { return this.page.locator('#pdfView'); }
  get pdfFileName() { return this.page.locator('#pdfFileName'); }
  get pdfPageInput() { return this.page.locator('#pdfPageInput'); }

  // ── Notes panel ───────────────────────────────────────────────────────────
  // Toolbar button injected by notes-panel.js: #pdfNotesToggle
  get notesToggleBtn() { return this.page.locator('#pdfNotesToggle'); }
  get notesPanel() { return this.page.locator('#pdfNotesPanel'); }
  get generateBtn() { return this.page.locator('#npGenerate'); }
  get notesPreview() { return this.page.locator('#npPreview'); }

  async openNotesPanel() {
    await this.notesToggleBtn.click();
    await expect(this.notesPanel).toBeVisible({ timeout: 5000 });
  }

  // ── Course tabs ───────────────────────────────────────────────────────────
  // Real class from course-render.js: .co-course-tab with data-course-tab attribute
  get quizTab() { return this.page.locator('.co-course-tab[data-course-tab="quiz"]'); }
  get flashcardsTab() { return this.page.locator('.co-course-tab[data-course-tab="flashcards"]'); }
  get filesTab() { return this.page.locator('.co-course-tab[data-course-tab="files"]'); }

  // Panels use data-course-panel attribute
  get quizPanel() { return this.page.locator('[data-course-panel="quiz"]'); }
  get flashcardsPanel() { return this.page.locator('[data-course-panel="flashcards"]'); }

  // ── Console errors ────────────────────────────────────────────────────────
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
