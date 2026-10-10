import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.MOBILE_AUDIT_URL || 'http://127.0.0.1:5173/';
const outDir = path.resolve('artifacts/mobile-audit');
const phase = process.env.MOBILE_AUDIT_PHASE || 'before';
const viewport = { width: 390, height: 844 };

const publicPages = [
  ['home', ''],
  ['ai-tutor', 'ai-tutor.html'],
  ['engineering-tutor', 'ai-tutor-for-engineering-students.html'],
  ['course-learning', 'course-based-ai-learning-tool.html'],
  ['quiz-generator', 'ai-quiz-generator-from-notes.html'],
  ['exam-guide', 'exam-study-guide-generator.html'],
  ['flashcards-pdf', 'flashcards-from-pdf.html'],
  ['lecture-summary', 'lecture-summary-generator.html'],
  ['notes', 'notes.html'],
  ['pdf-editor', 'pdf-editor.html'],
  ['pomodoro', 'pomodoro.html'],
  ['privacy', 'privacy.html'],
  ['terms', 'terms.html'],
  ['impressum', 'impressum.html'],
  ['withdrawal', 'withdrawal.html'],
  ['reset-password', 'reset-password.html'],
];

const portalSections = [
  ['dashboard', 'dashboard'],
  ['courses', 'studip'],
  ['profile', 'profile'],
  ['settings', 'settings'],
  ['subscription', 'subscription'],
  ['admin', 'admin'],
  ['editor', 'editor'],
  ['notes-portal', 'notes'],
  ['ai-page', 'aipage'],
  ['chat', 'chat'],
  ['notifications', 'notifications'],
  ['games', 'games'],
  ['lounge', 'lounge'],
  ['german', 'german'],
];

const extraStates = [
  ['sidebar-open', 'dashboard'],
  ['file-viewer-ai-rail', 'studip'],
];

const featureBySection = {
  dashboard: 'dashboard',
  profile: 'profile',
  settings: 'settings',
  subscription: 'subscription',
  editor: 'editor',
  notes: 'notes',
  aipage: 'aipage',
  chat: 'chat',
  games: 'games',
  german: 'german',
};

const staticHtmlBySection = {
  dashboard: 'views/dashboard/dashboard.html',
  profile: 'views/profile/profile.html',
  settings: 'views/settings/settings.html',
  subscription: 'views/subscription/subscription.html',
  notes: 'views/lecturenotes/lecturenotes.html',
  games: 'views/games/games.html',
  german: 'views/practice/practice.html',
};

async function stubApp(page) {
  await page.route('**/js/supabase.js', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window._currentUser={id:'visual',email:'visual@example.test',user_metadata:{full_name:'Mobile Tester'}};
        window._sbToken='visual-token';
        function forceVisualAuth(){
          sessionStorage.setItem('ss_logged_in','true');
          sessionStorage.setItem('ss_force_app','true');
          window.showPortal&&window.showPortal();
          var m=document.getElementById('authModal');if(m)m.style.display='none';
        }
        window.addEventListener('ss-ready',forceVisualAuth);
        document.addEventListener('DOMContentLoaded',function(){
          forceVisualAuth();
          setTimeout(forceVisualAuth,100);
          setTimeout(forceVisualAuth,500);
        });
        setTimeout(forceVisualAuth,0);
      `,
    })
  );
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    const body = url.includes('profile')
      ? { ok: true, profile: { name: 'Mobile Tester', email: 'visual@example.test', university: 'TU Berlin' } }
      : { ok: true, data: [], courses: [], documents: [], rows: [], stats: {} };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    sessionStorage.setItem('ss_force_app', 'true');
    sessionStorage.setItem('ss_logged_in', 'true');
    localStorage.setItem('ss_dark', '1');
  });
}

async function seedCourses(page) {
  await page.evaluate(() => {
    const now = Date.now();
    window.SEMS = {
      ss2526: {
        id: 'ss2526',
        name: 'SS 2026',
        color: '#06D6A0',
        courses: [
          {
            id: 'mobile-math',
            name: 'Analysis I',
            color: '#06D6A0',
            files: [
              { id: 'f1', name: 'Limits and continuity.pdf', uploadedAt: now - 86400000 },
              { id: 'f2', name: 'Differentiation workbook.pdf', uploadedAt: now - 172800000 },
            ],
          },
          {
            id: 'mobile-physics',
            name: 'Experimental Physics',
            color: '#4CC9F0',
            files: [{ id: 'f3', name: 'Mechanics lecture 01.pdf', uploadedAt: now - 259200000 }],
          },
          {
            id: 'mobile-cs',
            name: 'Algorithms and Data Structures',
            color: '#FFD93D',
            files: [],
          },
        ],
      },
    };
    window.CUR_SEM = 'ss2526';
    window.sdRenderCourses?.();
  });
}

async function openPortalSection(page, section) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.showPortal && document.querySelector('#portal'), null, { timeout: 15000 });
  await page.evaluate(() => {
    sessionStorage.setItem('ss_logged_in', 'true');
    sessionStorage.setItem('ss_force_app', 'true');
    window.showPortal?.();
    const modal = document.getElementById('authModal');
    if (modal) modal.style.display = 'none';
  });
  await page.addStyleTag({
    content: '#authModal,.auth-modal,.auth-view,.auth-shell{display:none!important}',
  }).catch(() => undefined);
  const feature = featureBySection[section];
  if (feature) {
    await page.evaluate(async (name) => {
      await window._ssLoadPortalFeature?.(name);
    }, feature);
  }
  await page.evaluate((sec) => {
    window.showPortal?.();
    window.showPortalSection?.(sec);
    const modal = document.getElementById('authModal');
    if (modal) modal.style.display = 'none';
  }, section);
  if (staticHtmlBySection[section]) {
    await page.evaluate(async ({ sec, file }) => {
      const target = document.getElementById('psec-' + sec);
      if (!target) return;
      if (target.children.length > 0 && target.textContent.trim().length > 20) return;
      const res = await fetch(file);
      if (!res.ok) return;
      const html = await res.text();
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const nested = tmp.querySelector('#psec-' + sec);
      target.innerHTML = nested ? nested.innerHTML : html;
    }, { sec: section, file: staticHtmlBySection[section] });
  }
  if (section === 'studip') await seedCourses(page);
  await page.waitForTimeout(1400);
}

async function openExtraState(page, name, section) {
  await openPortalSection(page, section);
  if (name === 'sidebar-open') {
    await page.evaluate(() => {
      const sidebar = document.querySelector('#portal .sidebar');
      const scrim = document.querySelector('#portal .mob-scrim');
      sidebar?.classList.add('mob-open', 'expanded');
      scrim?.classList.add('show');
    });
  }
  if (name === 'file-viewer-ai-rail') {
    await page.evaluate(() => {
      window.showPortal?.();
      const main = document.querySelector('#portal .main-scroll');
      const app = document.getElementById('app');
      const wrap = document.getElementById('pdfViewerWrap');
      const viewer = document.getElementById('viewerArea');
      const title = document.querySelector('.pdf-toolbar-v2 .pdf-tb-title');
      const sub = document.querySelector('.pdf-toolbar-v2 .pdf-tb-title-sub');
      if (main) main.style.display = 'none';
      if (app) app.style.display = 'flex';
      if (wrap) wrap.style.display = 'flex';
      if (title) title.textContent = 'Thermodynamics lecture 03 - entropy and cycles.pdf';
      if (sub) sub.textContent = 'Experimental Physics / Lecture files';
      if (viewer) viewer.innerHTML = '';
      document.body.classList.add('minallo-in-course');
    });
  }
  if (name === 'file-viewer-ai-rail') {
    await page.evaluate(() => {
      const root = document.querySelector('.dr-root');
      const rail = document.querySelector('.dr-rail');
      const drawer = document.getElementById('drDrawer');
      const content = document.getElementById('drContent') || drawer?.querySelector('.dr-content');
      root?.classList.add('is-pdf', 'is-open');
      if (rail) rail.style.display = '';
      if (drawer) {
        drawer.hidden = false;
        drawer.classList.add('is-open', 'dr-mode-ai', 'dr-inline-split');
        drawer.classList.remove('dr-sheet');
      }
      document.body.classList.add('dr-pdf-split-open');
      if (content && !content.querySelector('#aiPanel')) {
        document.querySelectorAll('#aiPanel').forEach((el) => el.remove());
        content.innerHTML = `
          <div id="aiPanel" class="dr-host-ai" style="display:flex">
            <div class="ai-file-chip-bar"><div class="ai-file-chip"><span id="aiFileChipName">Thermodynamics lecture 03 - entropy and cycles.pdf</span></div></div>
            <div class="ai-msgs">
              <div class="ai-msg bot"><div class="msg-sender bot-sender">Minallo AI</div><div class="ai-bubble bot"><p>Ask about the open lecture, selected formulas, or any paragraph in the PDF.</p></div></div>
              <div class="ai-msg user"><div class="msg-sender user-sender">You</div><div class="ai-bubble user"><p>Explain the Carnot cycle from this page.</p></div></div>
              <div class="ai-msg bot"><div class="msg-sender bot-sender">Minallo AI</div><div class="ai-bubble bot"><p>The cycle is easiest to read as two isothermal and two adiabatic steps. On mobile this answer needs room to breathe without crushing the document viewer.</p></div></div>
            </div>
            <div class="ai-input-area">
              <div class="ai-input-box">
                <textarea class="ai-textarea" placeholder="Ask about this PDF..."></textarea>
                <div class="ai-bottom-row">
                  <button class="ai-mode-pill" type="button">Strict PDF</button>
                  <button class="ai-attach-btn" type="button">+</button>
                  <button class="ai-snip-btn" type="button">[]</button>
                  <button class="ai-send" type="button">↑</button>
                </div>
              </div>
            </div>
          </div>`;
      }
    });
  }
  await page.waitForTimeout(700);
}

async function auditPage(page, selector = 'body') {
  const read = () => page.evaluate((sel) => {
    const vw = window.innerWidth;
    const root = document.querySelector(sel) || document.body;
    const offenders = [];
    const elements = Array.from(root.querySelectorAll('*'));
    for (const el of elements) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      if (rect.right > vw + 2 || rect.left < -2) {
        const cls = typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : '';
        offenders.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          class: cls ? `.${cls}` : '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: (el.textContent || '').trim().slice(0, 60),
        });
      }
      if (offenders.length >= 20) break;
    }
    return {
      url: location.href,
      viewport: vw,
      docScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      rootScrollWidth: root.scrollWidth,
      offenders,
    };
  }, selector);
  try {
    return await read();
  } catch (err) {
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForTimeout(300);
    return read();
  }
}

await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});

const results = [];

for (const [name, slug] of publicPages) {
  const page = await context.newPage();
  const url = new URL(slug, baseUrl).href;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const file = path.join(outDir, `${phase}-public-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  results.push({ kind: 'public', name, screenshot: file, ...(await auditPage(page)) });
  await page.close();
}

for (const [name, section] of portalSections) {
  const page = await context.newPage();
  await stubApp(page);
  await openPortalSection(page, section);
  const file = path.join(outDir, `${phase}-portal-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  results.push({
    kind: 'portal',
    name,
    section,
    screenshot: file,
    ...(await auditPage(page, `#psec-${section}`)),
  });
  await page.close();
}

for (const [name, section] of extraStates) {
  const page = await context.newPage();
  await stubApp(page);
  await openExtraState(page, name, section);
  const file = path.join(outDir, `${phase}-state-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  results.push({
    kind: 'state',
    name,
    section,
    screenshot: file,
    ...(await auditPage(page, name === 'file-viewer-ai-rail' ? '#drDrawer' : '#portal')),
  });
  await page.close();
}

await browser.close();

const report = path.join(outDir, `${phase}-report.json`);
await fs.writeFile(report, JSON.stringify(results, null, 2));

for (const item of results) {
  const over = Math.max(item.docScrollWidth, item.bodyScrollWidth, item.rootScrollWidth) - viewport.width;
  const marker = over > 2 || item.offenders.length ? 'OVERFLOW' : 'ok';
  console.log(`${marker.padEnd(8)} ${item.kind}/${item.name} width+${Math.max(0, over)} offenders=${item.offenders.length}`);
}
console.log(`report: ${report}`);
