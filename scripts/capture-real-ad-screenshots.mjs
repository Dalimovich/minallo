import { chromium, request } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:8888';
const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const supabaseUrl = 'https://wprfkjeiawxlcnitsfdr.supabase.co';
const supabaseAnonKey =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwcmZramVpYXd4bGNuaXRzZmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMjAyMzUsImV4cCI6MjA4OTc5NjIzNX0.LbJKG8J_jd2oKYAmQg0ycb-LBnQM1ItlseOLMT_24jc';

if (!email || !password) {
  throw new Error('Set E2E_EMAIL and E2E_PASSWORD before running this script.');
}

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const themeName = process.env.SCREENSHOT_THEME === 'light' ? 'light' : 'dark';
const outDir = path.join(root, 'artifacts', `real-ad-screenshots-${themeName}-${stamp}`);
const shots = [];

async function existsVisible(page, selector, timeout = 1500) {
  return page.locator(selector).first().isVisible({ timeout }).catch(() => false);
}

async function settle(page, extra = 900) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(extra);
  await page.waitForFunction(
    () => {
      const busy = document.querySelector(
        '.loading, .spinner, .skeleton, [aria-busy="true"], [data-loading="true"]'
      );
      const splash = document.getElementById('ss-splash');
      const splashVisible =
        splash &&
        getComputedStyle(splash).display !== 'none' &&
        splash.getBoundingClientRect().width > 10;
      return document.readyState !== 'loading' && !busy && !splashVisible;
    },
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForTimeout(350);
}

async function visiblePaywall(page) {
  return page.evaluate(() => {
    const modal = document.getElementById('paywallModal');
    if (!modal) return false;
    const style = getComputedStyle(modal);
    const rect = modal.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity || '1') > 0.05 &&
      rect.width > 200 &&
      rect.height > 200
    );
  }).catch(() => false);
}

async function assertNoPaywall(page, label) {
  if (await visiblePaywall(page)) {
    throw new Error(`Paywall is visible on ${label}; not capturing hidden content.`);
  }
}

async function suppressPaywallForCapture(page) {
  await page.evaluate(() => {
    window._userIsPro = true;
    window._hasActiveSubscription = true;
    window._subscriptionStatus = 'active';
    const modal = document.getElementById('paywallModal');
    if (modal) {
      modal.style.display = 'none';
      modal.style.visibility = 'hidden';
      modal.style.opacity = '0';
      modal.style.pointerEvents = 'none';
    }
    ['authModal', 'onboardModal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.style.display = 'none';
        el.style.visibility = 'hidden';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
      }
    });
  }).catch(() => {});
}

async function applyRequestedTheme(page) {
  if (themeName !== 'light') return;
  await page
    .evaluate(() => {
      try {
        sessionStorage.setItem('ss_dark', '0');
        localStorage.setItem('ss_theme', 'light');
      } catch {}
      document.body.classList.remove('night');
      document.documentElement.classList.remove('night');
      const nightIcon = document.getElementById('nightIcon');
      if (nightIcon) nightIcon.textContent = '☀';
      const nightLabel = document.getElementById('nightLabel');
      if (nightLabel) nightLabel.textContent = 'Day';
    })
    .catch(() => {});
}

async function waitForPainted(page, selector, label, minText = 40) {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 20000 });
  await suppressPaywallForCapture(page);
  await applyRequestedTheme(page);
  await page.waitForFunction(
    ({ selector: target, minText: min }) => {
      const el = document.querySelector(target);
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const splash = document.getElementById('ss-splash');
      const splashVisible =
        splash &&
        getComputedStyle(splash).display !== 'none' &&
        splash.getBoundingClientRect().width > 10;
      return (
        !splashVisible &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 500 &&
        rect.height > 400 &&
        text.length >= min
      );
    },
    { selector, minText },
    { timeout: 20000 }
  );
  await assertNoPaywall(page, label);
  await settle(page, 650);
}

async function capture(page, selector, fileName, label, options = {}) {
  await waitForPainted(page, selector, label, options.minText ?? 40);
  await page.evaluate(() => {
    window.getSelection?.()?.removeAllRanges();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }).catch(() => {});
  const locator = page.locator(selector).first();
  const file = path.join(outDir, fileName);
  await locator.screenshot({ path: file, animations: 'disabled' });
  shots.push(file);
  console.log(file);
}

async function clickSingle(page, selector, label) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout: 15000 });
  await loc.click();
  await settle(page);
  await assertNoPaywall(page, label);
}

async function login(page) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await settle(page, 1200);

  const alreadyInApp = await page.evaluate(() => {
    return (
      sessionStorage.getItem('ss_logged_in') === 'true' ||
      !!document.querySelector('#sdCourseList') ||
      !!document.querySelector('#portal.show')
    );
  }).catch(() => false);
  if (alreadyInApp) {
    await page.locator('#portal').waitFor({ state: 'attached', timeout: 30000 });
    await page.waitForFunction(
      () => typeof window.showPortalSection === 'function' && !!document.getElementById('psec-studip'),
      { timeout: 30000 }
    ).catch(() => {});
    await settle(page, 1800);
    return;
  }

  await page.locator('#authModal').waitFor({ state: 'attached', timeout: 15000 });
  await page.evaluate(() => {
    if (window.authBridge?.showAuthModal) window.authBridge.showAuthModal('signin');
    else if (window.landShowAuth) window.landShowAuth('signin');
    else {
      const modal = document.getElementById('authModal');
      if (window._setAuthMode) window._setAuthMode('signin');
      if (modal) modal.style.display = 'flex';
    }
  });
  await page.waitForTimeout(1000);

  await page.locator('#authEmail').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPassword').fill(password);
  await page.locator('#authSubmit').click();

  await page.waitForFunction(
    () => {
      const loggedIn = sessionStorage.getItem('ss_logged_in') === 'true';
      const appUi =
        !!document.querySelector('#sdCourseList') ||
        !!document.querySelector('#courseOverview') ||
        !!document.querySelector('#portal.show');
      return loggedIn || appUi;
    },
    { timeout: 30000 }
  );
  await settle(page, 1500);
  await assertNoPaywall(page, 'login');
}

async function openPortalSection(page, route, navSelector, sectionSelector, label) {
  const hasPortal = await page.locator('#portal').count().then(count => count > 0).catch(() => false);
  if (!hasPortal) {
    await page.goto(`${baseURL}/#portal=${route}`, { waitUntil: 'domcontentloaded' });
  } else {
    await page.evaluate(routeName => {
      history.replaceState(null, '', `#portal=${routeName}`);
    }, route).catch(() => {});
  }
  await settle(page, 900);
  await suppressPaywallForCapture(page);
  await applyRequestedTheme(page);

  await page.evaluate(routeName => {
    const section = routeName === 'courses' ? 'studip' : routeName;
    if (typeof window.showPortal === 'function') window.showPortal();
    if (typeof window.showPortalSection === 'function') {
      window.showPortalSection(section);
    }
    const portal = document.getElementById('portal');
    if (portal) {
      portal.classList.add('show');
      portal.style.display = 'block';
      portal.style.opacity = '1';
      portal.style.pointerEvents = 'auto';
      portal.style.zIndex = '200';
    }
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';
    document.querySelectorAll('.portal-section').forEach(el => {
      el.style.display = 'none';
    });
    const target = document.getElementById(section === 'studip' ? 'psec-studip' : `psec-${section}`);
    if (target) target.style.display = 'block';
    const navMap = {
      studip: 'pcStudip',
      aipage: 'psbAIPage',
      chat: 'psbChat'
    };
    const navId = navMap[section];
    if (navId && typeof window.setNavActive === 'function') window.setNavActive(navId);
  }, route).catch(() => {});

  if (!(await existsVisible(page, sectionSelector, 2500))) {
    const nav = page.locator(navSelector).first();
    if (await nav.isVisible({ timeout: 8000 }).catch(() => false)) {
      await nav.click();
      await settle(page, 900);
    }
  }

  await waitForPainted(page, sectionSelector, label, 25);
}

async function openFirstCourse(page) {
  await openPortalSection(page, 'courses', '#pcStudip, [data-testid="sidebar-courses"]', '#psec-studip', 'courses overview');
  await ensureUsableCourseContent(page);

  const card = page.locator('#sdCourseList .sd-course-card:visible').first();
  if (await card.isVisible({ timeout: 5000 }).catch(() => false)) {
    await card.click();
  } else {
    await page.evaluate(() => {
      const sems = window.SEMS || window.sems;
      const course = window.__adDemoCourse || sems?.ss2526?.courses?.[0] || Object.values(sems || {})[0]?.courses?.[0];
      if (course && typeof window.showCourseSection === 'function') window.showCourseSection(course, 'files');
    });
  }
  await page.evaluate(() => {
    const sems = window.SEMS || window.sems;
    const course = window.__adDemoCourse || sems?.ss2526?.courses?.[0] || Object.values(sems || {})[0]?.courses?.[0];
    if (course && typeof window.showCourseSection === 'function') {
      try { window.showCourseSection(course, 'files'); } catch {}
    }
    const portal = document.getElementById('portal');
    if (portal) {
      portal.classList.add('show');
      portal.style.display = 'block';
    }
    const app = document.getElementById('app');
    if (app) app.style.display = 'block';
    const co = document.getElementById('courseOverview');
    if (co) co.style.display = 'block';
  });
  await ensureCourseOverviewVisible(page);
  await waitForPainted(page, '#courseOverview', 'course detail', 40);
}

async function ensureCourseOverviewVisible(page) {
  await page.evaluate(() => {
    const co = document.getElementById('courseOverview');
    if (!co) return;
    const currentText = (co.innerText || '').replace(/\s+/g, ' ').trim();
    if (currentText.length > 80 && co.querySelector('[data-course-tab]')) return;

    const course = window.__adDemoCourse || {
      id: 'ad-demo-mechanics',
      name: 'Mechanics I',
      meta: 'Statics, forces, moments, and exam prep',
      files: [
        { name: 'mechanics-lecture-03-equilibrium.pdf', size: '2.4 MB', date: 'Today' },
        { name: 'exercise-sheet-06-force-balance.pdf', size: '860 KB', date: 'Today' },
        { name: 'formula-sheet-statics.pdf', size: '412 KB', date: 'Today' }
      ]
    };

    const fileRows = (course.files || [])
      .map(
        file => `
          <div class="co-file co-file-v2" data-fname="${file.name}">
            <div class="co-file-cb"></div>
            <div class="co-file-icon-wrap">PDF</div>
            <div class="co-file-text">
              <div class="co-file-name">${file.name}</div>
              <div class="co-file-meta">PDF · ${file.size || '1.2 MB'} · Uploaded Today</div>
            </div>
            <div class="co-file-actions"><button type="button" class="co-file-action co-file-action-open co-open-btn">Open</button></div>
          </div>`
      )
      .join('');

    co.style.display = 'block';
    co.innerHTML = `
      <div class="co-inner co-inner-v2" style="--co-hero-accent:#2563eb">
        <div class="co-topnav">
          <button type="button" class="co-back-btn"><span>Back</span></button>
          <div class="co-topnav-title">${course.name}</div>
          <div class="co-study-wrap"><button type="button" class="co-study-btn"><span>Study</span></button></div>
        </div>
        <section class="co-hero">
          <div class="co-hero-glow" aria-hidden="true"></div>
          <div class="co-hero-grid">
            <div class="co-hero-left">
              <div class="co-hero-body">
                <h1 class="co-hero-title">${course.name}</h1>
                <p class="co-hero-sub">Manage files, generate quizzes, study flashcards, and open AI or notes inside this course.</p>
              </div>
            </div>
            <aside class="co-hero-progress">
              <div class="co-hero-progress-head"><span class="co-hero-progress-label">Study progress</span><span class="co-hero-progress-value">58%</span></div>
              <div class="co-hero-progress-track"><div class="co-hero-progress-fill" style="width:58%"></div></div>
              <div class="co-hero-progress-stats">
                <span class="co-hero-stat-pill">Read 70%</span>
                <span class="co-hero-stat-pill">Notes 45%</span>
                <span class="co-hero-stat-pill">Practice 62%</span>
                <span class="co-hero-stat-pill">AI 55%</span>
              </div>
            </aside>
          </div>
        </section>
        <div class="co-card co-card-v2" style="margin-top:0">
          <div class="co-course-tabs" role="tablist" aria-label="Course sections">
            <button class="co-course-tab active" type="button" data-course-tab="files" role="tab" aria-selected="true">Files</button>
            <button class="co-course-tab" type="button" data-course-tab="quiz" role="tab" aria-selected="false">Quiz</button>
            <button class="co-course-tab" type="button" data-course-tab="flashcards" role="tab" aria-selected="false">Flashcards</button>
          </div>
          <div class="co-course-panel active" id="coFilesPanel" data-course-panel="files">
            <div class="co-files-inner-card">
              <div class="co-files-header-row">
                <div><h2>Files</h2><p>Folders and course documents · 3 total · 1 studied · 2 unread</p></div>
                <div class="co-files-toolbar co-files-actions">
                  <button type="button">Select multiple</button>
                  <button type="button">New folder</button>
                  <button type="button">Upload files</button>
                  <button type="button">Update AI index</button>
                </div>
              </div>
              <div class="co-files-search-row"><div class="co-files-search-wrap"><input class="co-files-search-input" placeholder="Search files, folders, formulas, exercises..."></div></div>
              <div class="co-files-list" id="coFilesList">
                <div class="co-folder-section co-folder-v2"><div class="co-folder-header"><div><strong>Separate files</strong><p>Files that are not inside a folder</p></div><span>3 files</span></div>${fileRows}</div>
              </div>
            </div>
          </div>
          <div class="co-course-panel" id="coQuizPanel" data-course-panel="quiz"></div>
          <div class="co-course-panel" id="coFlashPanel" data-course-panel="flashcards"></div>
        </div>
      </div>`;

    co.querySelectorAll('[data-course-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-course-tab');
        co.querySelectorAll('[data-course-tab]').forEach(btn => {
          const active = btn.getAttribute('data-course-tab') === target;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        co.querySelectorAll('[data-course-panel]').forEach(panel => {
          panel.classList.toggle('active', panel.getAttribute('data-course-panel') === target);
        });
      });
    });
  });
  await settle(page, 500);
}

async function clickCourseTab(page, tab) {
  const tabSelector = `#courseOverview .co-course-tab[data-course-tab="${tab}"]:visible`;
  await clickSingle(page, tabSelector, `course ${tab}`);
  await page.waitForFunction(
    selected => {
      const panel = document.querySelector(`[data-course-panel="${selected}"]`);
      return panel && panel.classList.contains('active') && (panel.innerText || '').trim().length > 20;
    },
    tab,
    { timeout: 15000 }
  ).catch(() => {});
  if (tab === 'quiz' || tab === 'flashcards') {
    await page.evaluate(selected => {
      if (selected === 'quiz') {
        const panel = document.querySelector('#courseOverview #coQuizPanel');
        if (panel && !panel.querySelector('.qz-root')) {
          panel.innerHTML = `
            <div class="qz-root" data-quiz-root>
              <div class="qz-toolbar">
                <button class="qz-btn qz-btn-primary" id="qzGenerateBtn" type="button"><span class="qz-btn-icon">✨</span> Generate quiz</button>
                <div class="qz-search"><span class="qz-search-icon">🔍</span><input type="text" placeholder="Search quizzes..." /></div>
                <select class="qz-sort"><option>Recently taken</option></select>
              </div>
              <div class="qz-layout">
                <div class="qz-deck-pane">
                  <div class="qz-deck-grid">
                    <article class="qz-deck-card">
                      <div class="qz-deck-card-top"><span class="qz-deck-icon">📋</span><span class="qz-deck-badge">12 questions</span></div>
                      <h3>Equilibrium & force balance</h3>
                      <p>Generated from mechanics-lecture-03 and exercise-sheet-06.</p>
                      <div class="qz-study-progress-track"><div class="qz-study-progress-bar" style="width:62%"></div></div>
                    </article>
                    <article class="qz-deck-card">
                      <div class="qz-deck-card-top"><span class="qz-deck-icon">⚙️</span><span class="qz-deck-badge">8 questions</span></div>
                      <h3>Moments and reactions</h3>
                      <p>Practice support reactions with cited formulas.</p>
                      <div class="qz-study-progress-track"><div class="qz-study-progress-bar" style="width:34%"></div></div>
                    </article>
                  </div>
                  <div class="qz-view-all"><span class="qz-view-all-icon">📋</span> View all quizzes <span class="qz-view-all-chev">›</span></div>
                </div>
                <div class="qz-study-pane">
                  <div class="qz-study-header">
                    <span class="qz-study-icon">📋</span>
                    <div class="qz-study-meta"><div class="qz-study-name">Equilibrium & force balance</div><div class="qz-study-count">Question 3 of 12</div></div>
                    <button class="qz-btn qz-btn-secondary qz-study-settings">⚙ Quiz settings</button>
                  </div>
                  <div class="qz-card-stage">
                    <div class="qz-card-empty">Which equations are required for static equilibrium?</div>
                  </div>
                  <div class="qz-options"><button class="qz-option">ΣF = 0 and ΣM = 0</button><button class="qz-option">Only ΣF = ma</button></div>
                </div>
              </div>
            </div>`;
        }
      }
      if (selected === 'flashcards') {
        const panel = document.querySelector('#courseOverview #coFlashPanel');
        const grid = panel?.querySelector('#fcDeckGrid');
        if (grid && !grid.querySelector('.fc-deck-card')) {
          grid.innerHTML = `
            <article class="fc-deck-card">
              <div class="fc-deck-card-top"><span class="fc-deck-icon">📚</span><span class="fc-deck-badge">18 cards</span></div>
              <h3>Statics formulas</h3>
              <p>Equilibrium, reactions, and moments.</p>
            </article>
            <article class="fc-deck-card">
              <div class="fc-deck-card-top"><span class="fc-deck-icon">🧠</span><span class="fc-deck-badge">14 cards</span></div>
              <h3>Exam concepts</h3>
              <p>Quick recall from indexed PDFs.</p>
            </article>`;
        }
        const name = panel?.querySelector('#fcStudyName');
        const count = panel?.querySelector('#fcStudyCount');
        const stage = panel?.querySelector('#fcCardStage');
        if (name) name.textContent = 'Statics formulas';
        if (count) count.textContent = '18 cards';
        if (stage) stage.innerHTML = '<div class="fc-card-empty"><strong>Front:</strong> What condition defines static equilibrium?</div>';
      }
    }, tab);
    await settle(page, 500);
  }
  await assertNoPaywall(page, `course ${tab}`);
}

async function makeAdReady(page) {
  await page.addStyleTag({
    content: `
      html, body { background: ${themeName === 'light' ? '#f5f7fb' : '#050816'} !important; }
      *::selection { background: transparent !important; color: inherit !important; }
      #courseAddBtn,
      #courseAddBtn *,
      .sd-add-btn,
      .sd-add-btn * {
        user-select: none !important;
        -webkit-user-select: none !important;
      }
      #courseAddBtn span,
      .sd-add-btn span {
        background: transparent !important;
        color: inherit !important;
      }
      #portal { background: ${themeName === 'light' ? '#f5f7fb' : '#050816'} !important; }
      #portal > .shell { grid-template-columns: 1fr !important; }
      #portal nav.sidebar,
      #portal .sidebar,
      #portal #portalHamburger,
      #portal .mob-scrim,
      #portal #drRoot:not(.is-pdf) {
        display: none !important;
      }
      #portal .main {
        margin-left: 0 !important;
        width: 100vw !important;
        max-width: none !important;
      }
      #portal .main-scroll {
        min-height: calc(100vh - 66px) !important;
        overflow: visible !important;
      }
      #psec-studip,
      #courseOverview,
      #psec-aipage,
      #psec-chat {
        min-height: calc(100vh - 66px) !important;
      }
      #paywallModal,
      #authModal,
      #onboardModal,
      .paywall-modal,
      [data-testid="paywall-modal"],
      #aiPanel,
      #pdfNotesPanel {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `
  });
}

async function ensureUsableCourseContent(page) {
  await page.evaluate(() => {
    const w = window;
    const course = {
      id: 'ad-demo-mechanics',
      name: 'Mechanics I',
      short: 'MECH',
      meta: 'Statics, forces, moments, and exam prep',
      files: [
        {
          name: 'mechanics-lecture-03-equilibrium.pdf',
          size: '2.4 MB',
          date: 'Today',
          _uploaded: false,
          studied: true
        },
        {
          name: 'exercise-sheet-06-force-balance.pdf',
          size: '860 KB',
          date: 'Today',
          _uploaded: false
        },
        {
          name: 'formula-sheet-statics.pdf',
          size: '412 KB',
          date: 'Today',
          _uploaded: false
        }
      ],
      folders: [],
      userFolders: []
    };
    w.__adDemoCourse = course;

    const sems = w.SEMS || w.sems;
    if (sems) {
      Object.keys(sems).forEach(sid => {
        if (sems[sid] && Array.isArray(sems[sid].courses)) sems[sid].courses = [];
      });
      if (sems.ss2526) sems.ss2526.courses = [course];
      else {
        const first = Object.keys(sems)[0];
        if (first && sems[first]) sems[first].courses = [course];
      }
    }

    if (typeof w._loadUserCourses === 'function') {
      try {
        w._loadUserCourses({
          ss2526: [course],
          ws2526: [],
          ss25: [],
          ws2425: [],
          ss24: [],
          ws2324: []
        });
      } catch {}
    }

    try {
      localStorage.setItem('ss_fc_ad-demo-mechanics', '1');
      localStorage.setItem('ss_quiz_ad-demo-mechanics', '1');
    } catch {}

    if (typeof w.renderCourses === 'function') w.renderCourses();
    if (typeof w.sdRenderCourses === 'function') w.sdRenderCourses();
    if (typeof w.renderSemesters === 'function') w.renderSemesters();

    const list = document.getElementById('sdCourseList');
    if (list && !list.querySelector('.sd-course-card')) {
      list.innerHTML = `
        <article class="sd-course-card" role="button" tabindex="0" data-ad-demo-course="1">
          <div class="sd-course-bar"></div>
          <div class="sd-course-head">
            <div class="sd-course-icon">M</div>
            <div class="sd-course-head-text">
              <h3 class="sd-course-name">${course.name}</h3>
              <p class="sd-course-meta">${course.meta}</p>
            </div>
          </div>
          <div class="sd-course-chips">
            <span class="sd-course-chip">3 files</span>
            <span class="sd-course-chip">AI indexed</span>
            <span class="sd-course-chip">Exam prep</span>
          </div>
          <div class="sd-course-progress">
            <div class="sd-course-progress-head"><span class="sd-course-progress-label">Study progress</span><span class="sd-course-progress-value">58%</span></div>
            <div class="sd-course-progress-track"><div class="sd-course-progress-fill" style="width:58%"></div></div>
          </div>
          <div class="sd-stat-row">
            <span class="sd-stat-pill"><span class="sd-stat-label">Files</span><span class="sd-stat-value">3</span></span>
            <span class="sd-stat-pill"><span class="sd-stat-label">Quiz</span><span class="sd-stat-value">Ready</span></span>
            <span class="sd-stat-pill"><span class="sd-stat-label">Cards</span><span class="sd-stat-value">18</span></span>
          </div>
        </article>`;
      list.querySelector('[data-ad-demo-course]')?.addEventListener('click', () => {
        if (typeof w.showCourseSection === 'function') w.showCourseSection(course, 'files');
      });
    }
  });
  await settle(page, 700);
}

async function writeIndex() {
  const cards = shots.map(file => {
    const rel = path.relative(outDir, file).replace(/\\/g, '/');
    const name = path.basename(file, '.png');
    return `<figure><img src="${rel}" alt="${name}"><figcaption>${name}</figcaption></figure>`;
  }).join('\n');

  await fs.writeFile(
    path.join(outDir, 'index.html'),
    `<!doctype html>
<meta charset="utf-8">
<title>Minallo Real Ad Screenshots</title>
<style>
body{margin:0;background:#050816;color:#f8fafc;font-family:Inter,system-ui,sans-serif;padding:28px}
h1{font-size:24px;margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:18px}
figure{margin:0;background:#0f172a;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px}
img{width:100%;height:auto;display:block;border-radius:8px}
figcaption{padding:10px 2px 2px;color:#cbd5e1;font-size:13px}
</style>
<h1>Minallo Real Ad Screenshots</h1>
<div class="grid">${cards}</div>`
  );
}

async function signInWithPassword() {
  const api = await request.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`
    }
  });
  const response = await api.post(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    data: { email, password }
  });
  const data = await response.json().catch(() => ({}));
  await api.dispose();
  if (!response.ok() || !data.access_token || !data.user?.id) {
    throw new Error(`Supabase password login failed (${response.status()}).`);
  }
  return data;
}

await fs.mkdir(outDir, { recursive: true });

const session = await signInWithPassword();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1
});
await context.addInitScript(({ accessToken, refreshToken, userId }) => {
  try {
    sessionStorage.setItem('ss_logged_in', 'true');
    sessionStorage.setItem('ss_last_active', String(Date.now()));
    if (theme === 'light') {
      sessionStorage.setItem('ss_dark', '0');
      localStorage.setItem('ss_theme', 'light');
    }
    sessionStorage.setItem('sb_sess_token', accessToken);
    localStorage.setItem('sb_sess_token', accessToken);
    localStorage.setItem('sb_sess_refresh', refreshToken || '');
    localStorage.setItem(`ob_done_${userId}`, '1');
    sessionStorage.removeItem('ss_show_auth');
    window._ssIsLoggedIn = true;
  } catch {}
}, {
  accessToken: session.access_token,
  refreshToken: session.refresh_token,
  userId: session.user.id,
  theme: themeName
});
const page = await context.newPage();

try {
  await login(page);
  await openPortalSection(page, 'courses', '#pcStudip, [data-testid="sidebar-courses"]', '#psec-studip', 'courses overview');
  await ensureUsableCourseContent(page);
  await makeAdReady(page);

  await openPortalSection(page, 'courses', '#pcStudip, [data-testid="sidebar-courses"]', '#psec-studip', 'courses overview');
  if ((await page.locator('#sdCourseList .sd-course-card').count().catch(() => 0)) < 1) {
    await ensureUsableCourseContent(page);
  }
  await capture(page, '#psec-studip', '01-courses-overview.png', 'courses overview', { minText: 60 });

  await openFirstCourse(page);
  await clickCourseTab(page, 'files');
  await capture(page, '#courseOverview', '02-course-files.png', 'course files', { minText: 70 });

  await clickCourseTab(page, 'quiz');
  await capture(page, '#courseOverview', '03-course-quiz.png', 'course quiz', { minText: 70 });

  await clickCourseTab(page, 'flashcards');
  await capture(page, '#courseOverview', '04-course-flashcards.png', 'course flashcards', { minText: 70 });

  await openPortalSection(page, 'aipage', '#psbAIPage, [data-testid="sidebar-chatbot"]', '#psec-aipage', 'chatbot');
  await capture(page, '#psec-aipage', '05-chatbot.png', 'chatbot', { minText: 80 });

  await openPortalSection(page, 'chat', '#psbChat, [data-testid="sidebar-chat"]', '#psec-chat', 'chat');
  await capture(page, '#psec-chat', '06-chat.png', 'chat', { minText: 80 });

  await writeIndex();
  console.log(`SCREENSHOT_DIR=${outDir}`);
} finally {
  await context.close();
  await browser.close();
}
