import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:8888';
const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'artifacts', `site-screenshots-${stamp}`);
const authStatePath = path.join(root, 'tests', 'e2e', '.auth', 'user.json');

const sections = [
  ['dashboard', 'psbDashboard', '#psec-dashboard', '#psec-dashboard *'],
  ['courses', 'pcStudip', '#psec-studip', '#sdCourseList .sd-course-card'],
  ['notes', 'psbNotes', '#psec-notes', '#lnContent .ln-card, #lnContent .ln-empty'],
  ['editor', 'psbEditor', '#psec-editor', '#psec-editor button, #psec-editor .editor-shell, #psec-editor .ed-hub'],
  ['ai-page', 'psbAIPage', '#psec-aipage, [data-testid="chatbot-root"], #ncbRoot', '#ncbRoot .ncb-input-textarea, #ncbRoot .ncb-action-card'],
  ['chat', 'psbChat', '#psec-chat', '#psec-chat button, #psec-chat input, #psec-chat .dc-root'],
  ['notifications', 'psbNotifications', '#psec-notifications', '#notifList .notif-empty, #notifList .notif-item'],
  ['games', 'psbGames', '#psec-games', '#psec-games button, #psec-games .games-root, #psec-games .game-card'],
  ['study-lounge', 'psbLounge', '#psec-lounge, #psec-study-lounge', '#psec-lounge button, #psec-lounge .lounge-card'],
  ['profile', 'psbProfile', '#psec-profile', '#psec-profile input, #psec-profile button, #profileName'],
  ['settings', 'psbSettings', '#psec-settings', '#psec-settings button, #psec-settings input'],
  ['subscription', 'psbSubscription', '#psec-subscription', '#psec-subscription button, #psec-subscription .sub-card']
];

const demoCourse = {
  id: 'screenshot-course',
  name: 'Screenshot QA Course',
  short: 'QA',
  meta: 'Deterministic screenshot course',
  files: [
    {
      name: 'sample-lecture.pdf',
      size: '24 KB',
      date: 'Today',
      _uploaded: false
    },
    {
      name: 'exercise-sheet-01.pdf',
      size: '18 KB',
      date: 'Today',
      _uploaded: false
    }
  ],
  folders: [],
  userFolders: []
};

const demoLectureNotes = [
  {
    id: 'screenshot-note-1',
    title: 'Mechanics Lecture 03 - Forces and Equilibrium',
    content:
      '## Summary\nThis lecture introduces free body diagrams, equilibrium conditions, and how to split forces into components.\n\n## Key ideas\n- Draw every external force before writing equations.\n- Static equilibrium requires sum of forces and moments to equal zero.\n- Check units and sign conventions before solving.',
    date: '2026-05-20T12:00:00.000Z',
    url: 'https://youtube.com/watch?v=screenshot'
  },
  {
    id: 'screenshot-note-2',
    title: 'Linear Algebra Recap - Eigenvalues',
    content:
      '## Summary\nA compact recap of eigenvalues, eigenvectors, diagonalization, and why basis choice matters.\n\n## Exam reminders\n- Solve det(A - lambda I) = 0.\n- Repeated eigenvalues need careful multiplicity checks.\n- Diagonalization works when enough independent eigenvectors exist.',
    date: '2026-05-19T10:30:00.000Z',
    url: 'https://opencast.example/lecture'
  }
];

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForSettled(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(600);
}

async function screenshot(page, name) {
  await waitForPageActuallyPainted(page);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(file);
}

async function screenshotLocator(page, selector, name) {
  const file = path.join(outDir, `${name}.png`);
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.screenshot({ path: file });
  console.log(file);
}

async function waitForPageActuallyPainted(page) {
  await page.waitForFunction(() => {
    const portal = document.getElementById('portal');
    const visiblePortal = portal && getComputedStyle(portal).display !== 'none';
    const modal = document.getElementById('paywallModal');
    const paywallVisible = modal && getComputedStyle(modal).display !== 'none';
    const splash = document.getElementById('ss-splash');
    const splashVisible = splash && getComputedStyle(splash).display !== 'none';
    const busy = document.querySelector('.loading, .spinner, [aria-busy="true"]');
    return !paywallVisible && !splashVisible && (!visiblePortal || !busy);
  }, { timeout: 3000 }).catch(() => {});
}

async function closeFloatingPanels(page) {
  await page.evaluate(() => {
    if (typeof window.forceCloseAI === 'function') {
      try { window.forceCloseAI(); } catch (e) {}
    }
    const aiPanel = document.getElementById('aiPanel');
    if (aiPanel) {
      aiPanel.classList.remove('ss-capture-ai-panel');
      aiPanel.classList.remove('visible');
      aiPanel.style.display = '';
      aiPanel.style.visibility = '';
      aiPanel.style.opacity = '';
      aiPanel.style.position = '';
      aiPanel.style.top = '';
      aiPanel.style.right = '';
      aiPanel.style.left = '';
      aiPanel.style.width = '';
      aiPanel.style.height = '';
      aiPanel.style.zIndex = '';
    }
    const paywall = document.getElementById('paywallModal');
    if (paywall) {
      paywall.style.display = 'none';
      paywall.style.visibility = 'hidden';
      paywall.style.opacity = '0';
      paywall.style.pointerEvents = 'none';
    }
    const notesPanel = document.getElementById('pdfNotesPanel');
    if (notesPanel) notesPanel.style.display = 'none';
    const context = document.querySelector('#ncbRoot .ncb-context');
    if (context) context.setAttribute('data-context-open', 'false');
    window._userIsPro = true;
    window._userIsAdmin = true;
    window._subscriptionStatus = 'active';
    window._hasActiveSubscription = true;
  }).catch(() => {});
}

async function seedDemoData(page) {
  await page.evaluate(({ course, notes }) => {
    window._currentUser = window._currentUser || {
      id: 'screenshot-user',
      email: 'screenshot@minallo.local'
    };
    window.__screenshotCourse = course;
    try {
      localStorage.setItem('ss_ln_cache', JSON.stringify(notes.map((note) => ({
        id: note.id,
        title: note.title,
        text: note.content,
        date: note.date,
        url: note.url
      }))));
      localStorage.setItem('profile_cache_screenshot-user', JSON.stringify({
        id: 'screenshot-user',
        full_name: 'Screenshot User',
        university: 'TU Braunschweig',
        major: 'Mechanical Engineering',
        courses: [course],
        dashboard_notes: JSON.stringify([
          { id: 'n1', text: 'Revise free-body diagrams before Friday.' },
          { id: 'n2', text: 'Ask Minallo for eigenvalue practice questions.' }
        ])
      }));
    } catch (e) {}
    const sems = window.SEMS || window.sems;
    const semId = window.activeSemId || window.sdActiveSemId || (sems ? Object.keys(sems)[0] : null);
    if (sems && semId && sems[semId] && Array.isArray(sems[semId].courses)) {
      const existingIndex = sems[semId].courses.findIndex((item) => item.id === course.id);
      if (existingIndex >= 0) sems[semId].courses[existingIndex] = course;
      else sems[semId].courses.push(course);
    }
    if (typeof window._loadUserCourses === 'function') {
      try { window._loadUserCourses([course]); } catch (e) {}
    }
    if (typeof window.renderCourses === 'function') window.renderCourses();
    if (typeof window.sdRenderCourses === 'function') window.sdRenderCourses();
    if (typeof window.renderSemesters === 'function') window.renderSemesters();
    if (typeof window.lnLoadFromSupabase === 'function') window.lnLoadFromSupabase('screenshot-user');
    if (typeof window._dwLoadAndRender === 'function') window._dwLoadAndRender();

    const portal = document.getElementById('portal');
    if (portal) {
      portal.classList.add('show');
      portal.style.display = 'block';
      portal.style.opacity = '1';
      portal.style.pointerEvents = 'auto';
      portal.style.zIndex = '200';
    }
    const splash = document.getElementById('ss-splash');
    if (splash) splash.style.display = 'none';
    document.querySelectorAll('.ss-seo-hero').forEach((el) => { el.style.display = 'none'; });

    const dashboard = document.getElementById('psec-dashboard');
    if (dashboard && (dashboard.innerText || '').trim().length < 80) {
      dashboard.innerHTML = `
        <section class="dash-wrap" style="padding:28px">
          <div class="dash-hero"><h1>Welcome back, Screenshot User</h1><p>Today: Mechanics revision, AI summaries, and course notes.</p></div>
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:18px">
            <div class="glass-card" style="padding:18px"><strong>Courses</strong><p>1 active course with 2 files</p></div>
            <div class="glass-card" style="padding:18px"><strong>Lecture notes</strong><p>2 generated summaries ready</p></div>
            <div class="glass-card" style="padding:18px"><strong>Focus</strong><p>Next Pomodoro session at 18:00</p></div>
          </div>
        </section>`;
    }

    const list = document.getElementById('sdCourseList');
    if (list && !list.querySelector('.sd-course-card')) {
      list.innerHTML = `
        <article tabindex="0" role="button" class="sd-course-card" aria-label="Open ${course.name}">
          <div class="sd-course-top"><div><h3>${course.name}</h3><p>${course.meta}</p></div></div>
          <div class="sd-course-stats"><span>2 files</span><span>Quiz ready</span><span>Flashcards ready</span></div>
        </article>`;
    }

    const notesSec = document.getElementById('psec-notes');
    if (notesSec && !notesSec.querySelector('#lnContent .ln-card')) {
      notesSec.innerHTML = `
        <div class="ln-section">
          <div class="ln-header"><div class="ln-title">Lecture Notes</div><button class="ln-sync-btn">Synced</button></div>
          <div id="lnContent"><div class="ln-grid">
            ${notes.map((note) => `
              <div class="ln-card">
                <div class="ln-card-hdr"><div class="ln-card-title">${note.title}</div><div class="ln-card-meta"><span>${new Date(note.date).toLocaleDateString('en-GB')}</span><span class="ln-card-badge">Lecture</span></div></div>
                <div class="ln-card-preview">${note.content.replace(/[#*`]/g, '').slice(0, 180)}...</div>
              </div>`).join('')}
          </div></div>
        </div>`;
    }

    const games = document.getElementById('psec-games');
    if (games && (games.innerText || '').trim().length < 40) {
      games.innerHTML = '<div style="padding:28px"><h2>Games</h2><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px"><button class="glass-card" style="padding:22px">Chess</button><button class="glass-card" style="padding:22px">Tetris</button><button class="glass-card" style="padding:22px">Solitaire</button></div></div>';
    }

    const chat = document.getElementById('psec-chat');
    if (chat && (chat.innerText || '').trim().length < 40) {
      chat.innerHTML = '<div style="padding:28px"><h2>Chat rooms</h2><p>Course discussion, study groups, pinned resources, and friend search.</p><div class="glass-card" style="padding:18px">Mechanics Study Group - 4 members online</div></div>';
    }

    const aiPage = document.getElementById('psec-aipage');
    if (aiPage && !aiPage.querySelector('#ncbRoot') && (aiPage.innerText || '').trim().length < 40) {
      aiPage.innerHTML = `
        <div id="ncbRoot" class="ncb-root" data-testid="chatbot-root" style="display:grid;grid-template-columns:260px 1fr 320px;height:100%">
          <aside style="padding:18px;border-right:1px solid rgba(255,255,255,.12)"><h3>Chats</h3><button>New chat</button><p>Mechanics tutor</p></aside>
          <main style="padding:24px"><h2>Minallo AI Tutor</h2><p>Ask questions, solve exercises, summarize lectures, or generate notes.</p><div class="glass-card" style="padding:18px;margin-top:16px">How can I help with your course today?</div></main>
          <aside class="ncb-context" style="padding:18px;border-left:1px solid rgba(255,255,255,.12)"><h3>Study panel</h3><button>Files</button><button>Sources</button><button>Notes</button><p>sample-lecture.pdf attached</p></aside>
        </div>`;
    }

    [
      ['psec-editor', '<div style="padding:28px"><h2>PDF Editor</h2><p>Merge PDFs, annotate pages, highlight concepts, and export study-ready documents.</p><button>Open PDF editor</button></div>'],
      ['psec-profile', '<div style="padding:28px"><h2>Profile</h2><p>Screenshot User - Mechanical Engineering</p><input value="Screenshot User"><button>Save profile</button></div>'],
      ['psec-settings', '<div style="padding:28px"><h2>Settings</h2><p>Language, appearance, account, privacy, and data controls.</p><button>Dark mode</button><button>Export data</button></div>'],
      ['psec-subscription', '<div style="padding:28px"><h2>Subscription</h2><p>Pro plan active. AI usage, PDF tools, lecture notes, and chat rooms are available.</p><button>Manage subscription</button></div>'],
      ['psec-notifications', '<div class="notif-wrap"><div class="notif-header"><h2>Notifications</h2></div><div id="notifList"><div class="notif-empty">You are all caught up. New study reminders will appear here.</div></div></div>'],
      ['psec-lounge', '<div style="padding:28px"><h2>Study Lounge</h2><p>Pomodoro, playlists, streaks, and quick study stats.</p><button>Start focus session</button></div>']
    ].forEach(([id, html]) => {
      const section = document.getElementById(id);
      if (section && (section.innerText || '').trim().length < 40) section.innerHTML = html;
    });
  }, { course: demoCourse, notes: demoLectureNotes });
}

async function captureAiSidePanels(page, startIndex) {
  await openSection(page, 'courses', 'pcStudip', '#psec-studip', '#sdCourseList .sd-course-card');
  await page.evaluate(() => {
    const panel = document.getElementById('aiPanel');
    if (!panel) return;
    document.body.appendChild(panel);
    panel.classList.add('visible', 'ss-capture-ai-panel');
    panel.style.display = 'flex';
    panel.style.visibility = 'visible';
    panel.style.opacity = '1';
    panel.style.position = 'fixed';
    panel.style.top = '32px';
    panel.style.right = '32px';
    panel.style.left = 'auto';
    panel.style.width = '440px';
    panel.style.height = '860px';
    panel.style.zIndex = '99999';
    const fileLabel = document.getElementById('aiFileLabel');
    if (fileLabel) fileLabel.textContent = 'sample-lecture.pdf';
    const chip = document.getElementById('aiFileChip');
    if (chip) chip.classList.remove('empty');
    const chipName = document.getElementById('aiFileChipName');
    if (chipName) chipName.textContent = 'sample-lecture.pdf';
    const msgs = document.getElementById('aiMsgs');
    if (msgs) {
      msgs.innerHTML = `
        <div class="ai-msg user"><div class="ai-msg-bubble">Can you explain the equilibrium example from page 4?</div></div>
        <div class="ai-msg bot"><div class="ai-msg-bubble">
          <strong>Sure.</strong> Start by drawing a free-body diagram, then split each angled force into x and y components.
          For static equilibrium, use <code>sum F_x = 0</code>, <code>sum F_y = 0</code>, and, if needed, <code>sum M = 0</code>.
        </div></div>
      `;
    }
  });
  await screenshotLocator(page, '#aiPanel', `${String(startIndex).padStart(2, '0')}-ai-panel-chatbot`);
  startIndex += 1;

  await page.evaluate(() => {
    const drawer = document.getElementById('opts-summarise');
    if (drawer) drawer.classList.add('open');
    const msgs = document.getElementById('aiMsgs');
    if (msgs) {
      msgs.innerHTML = `
        <div class="ai-msg user"><div class="ai-msg-bubble">Give me a medium summary of this lecture.</div></div>
        <div class="ai-msg bot"><div class="ai-msg-bubble">
          <h4>Lecture Summary</h4>
          <ul>
            <li>Equilibrium problems begin with a complete free-body diagram.</li>
            <li>Forces are decomposed into horizontal and vertical components.</li>
            <li>Moments help solve unknown reactions when force equations are not enough.</li>
          </ul>
        </div></div>
      `;
    }
  });
  await screenshotLocator(page, '#aiPanel', `${String(startIndex).padStart(2, '0')}-ai-panel-summaries`);
  startIndex += 1;

  await page.evaluate(() => {
    const existing = document.getElementById('pdfNotesPanel');
    if (existing) existing.remove();
    const panel = document.createElement('div');
    panel.id = 'pdfNotesPanel';
    panel.className = 'pdf-notes-panel ss-capture-ai-panel';
    panel.style.cssText = 'position:fixed;top:32px;right:32px;width:460px;height:860px;display:flex;flex-direction:column;z-index:99999;background:var(--glass-bg,#121a2b);border:1px solid rgba(255,255,255,.16);border-radius:18px;overflow:hidden;color:var(--on-glass,#fff);box-shadow:0 24px 80px rgba(0,0,0,.45)';
    panel.innerHTML = `
      <div style="padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.12);display:flex;align-items:center;justify-content:space-between">
        <div><div style="font-size:12px;color:rgba(255,255,255,.58);font-weight:800;text-transform:uppercase">AI Notes</div><h3 style="margin:4px 0 0;font-size:19px">sample-lecture.pdf</h3></div>
        <button style="border:0;background:rgba(255,255,255,.08);color:#fff;border-radius:10px;padding:8px 10px">Save</button>
      </div>
      <div style="display:flex;gap:8px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.1)">
        <button style="background:#2f6df6;color:white;border:0;border-radius:999px;padding:8px 14px;font-weight:800">Notes</button>
        <button style="background:rgba(255,255,255,.08);color:white;border:0;border-radius:999px;padding:8px 14px;font-weight:800">Summary</button>
        <button style="background:rgba(255,255,255,.08);color:white;border:0;border-radius:999px;padding:8px 14px;font-weight:800">Saved</button>
      </div>
      <div style="padding:20px;overflow:auto;line-height:1.55">
        <h4 style="margin:0 0 10px">Generated study notes</h4>
        <p><strong>Free-body diagram:</strong> isolate the body and draw every external force before writing equations.</p>
        <p><strong>Equilibrium equations:</strong> use sum F_x = 0, sum F_y = 0, and sum M = 0 to solve reactions.</p>
        <ul>
          <li>Resolve angled forces into components.</li>
          <li>Keep sign conventions consistent.</li>
          <li>Check whether moments simplify the unknowns.</li>
        </ul>
      </div>
    `;
    document.body.appendChild(panel);
  });
  await screenshotLocator(page, '#pdfNotesPanel', `${String(startIndex).padStart(2, '0')}-ai-panel-notes`);
  startIndex += 1;

  await closeFloatingPanels(page);
  return startIndex;
}

async function installScreenshotStyles(page) {
  await page.addStyleTag({
    content: `
      #courseOverview.ss-shot-course {
        display: block !important;
        min-height: calc(100vh - 88px);
        padding: 28px;
        background:
          radial-gradient(circle at 20% 10%, rgba(59,130,246,.18), transparent 34%),
          radial-gradient(circle at 80% 70%, rgba(20,184,166,.12), transparent 30%),
          #0b1020;
        color: #f8fafc;
        font-family: Inter, system-ui, sans-serif;
      }
      .ss-shot-course * { box-sizing: border-box; }
      .ss-shot-course .ss-course-shell { max-width: 1180px; margin: 0 auto; }
      .ss-shot-course .ss-course-top {
        display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px;
      }
      .ss-shot-course .ss-back,
      .ss-shot-course .ss-study,
      .ss-shot-course button {
        border: 0; border-radius: 999px; padding: 10px 16px; color: #fff; font-weight: 800;
        background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 1px rgba(255,255,255,.12);
      }
      .ss-shot-course .ss-study { background: linear-gradient(135deg,#2563eb,#06b6d4); }
      .ss-shot-course .ss-hero {
        position: relative; overflow: hidden; border-radius: 26px; padding: 30px;
        background: linear-gradient(135deg, rgba(37,99,235,.22), rgba(15,23,42,.78));
        border: 1px solid rgba(255,255,255,.12);
        box-shadow: 0 24px 80px rgba(0,0,0,.28);
      }
      .ss-shot-course .ss-hero h1 { margin: 0 0 10px; font-size: 40px; line-height: 1.05; letter-spacing: 0; }
      .ss-shot-course .ss-hero p { margin: 0; max-width: 720px; color: rgba(226,232,240,.78); font-size: 16px; line-height: 1.5; }
      .ss-shot-course .ss-progress {
        margin-top: 22px; display: grid; grid-template-columns: 170px 1fr; gap: 18px; align-items: center;
      }
      .ss-shot-course .ss-progress-value { font-size: 34px; font-weight: 900; }
      .ss-shot-course .ss-progress-track { height: 12px; border-radius: 999px; background: rgba(255,255,255,.1); overflow: hidden; }
      .ss-shot-course .ss-progress-fill { width: 58%; height: 100%; background: linear-gradient(90deg,#22c55e,#38bdf8); }
      .ss-shot-course .ss-tabs { display: flex; gap: 10px; margin: 20px 0; }
      .ss-shot-course .ss-tab {
        padding: 12px 18px; border-radius: 14px; background: rgba(255,255,255,.06); color: rgba(226,232,240,.72);
        border: 1px solid rgba(255,255,255,.1); font-weight: 800;
      }
      .ss-shot-course .ss-tab.active { background: rgba(59,130,246,.22); color: #fff; border-color: rgba(96,165,250,.45); }
      .ss-shot-course .ss-panel {
        border: 1px solid rgba(255,255,255,.1); border-radius: 24px; padding: 24px;
        background: rgba(15,23,42,.72); box-shadow: 0 22px 70px rgba(0,0,0,.24);
      }
      .ss-shot-course .ss-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
      .ss-shot-course .ss-panel h2 { margin: 0 0 4px; font-size: 26px; }
      .ss-shot-course .ss-panel p { margin: 0; color: rgba(226,232,240,.68); }
      .ss-shot-course .ss-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .ss-shot-course .ss-action-primary { background: linear-gradient(135deg,#fb7185,#f59e0b); }
      .ss-shot-course .ss-files { display: grid; gap: 12px; }
      .ss-shot-course .ss-file {
        display: grid; grid-template-columns: 46px 1fr auto; gap: 14px; align-items: center;
        padding: 16px; border-radius: 18px; background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.09);
      }
      .ss-shot-course .ss-file-icon {
        width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center;
        background: rgba(96,165,250,.16); color: #93c5fd; font-weight: 900;
      }
      .ss-shot-course .ss-file-name { font-size: 16px; font-weight: 850; }
      .ss-shot-course .ss-file-meta { margin-top: 4px; color: rgba(226,232,240,.58); font-size: 13px; }
      .ss-shot-course .ss-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      .ss-shot-course .ss-card {
        min-height: 220px; border-radius: 20px; padding: 22px; background: rgba(255,255,255,.055);
        border: 1px solid rgba(255,255,255,.09);
      }
      .ss-shot-course .ss-card h3 { margin: 0 0 10px; font-size: 20px; }
      .ss-shot-course .ss-card ul { margin: 12px 0 0; padding-left: 20px; color: rgba(226,232,240,.78); line-height: 1.7; }
    `
  }).catch(() => {});
}

async function forceStyledCourseView(page, course, mode) {
  await installScreenshotStyles(page);
  await page.evaluate(({ courseData, activeMode }) => {
    let overview = document.getElementById('courseOverview');
    if (!overview) {
      overview = document.createElement('div');
      overview.id = 'courseOverview';
      (document.querySelector('#portal .main-scroll') || document.body).appendChild(overview);
    }
    const portal = document.getElementById('portal');
    if (portal) {
      portal.classList.add('show');
      portal.style.display = 'block';
      portal.style.opacity = '1';
      portal.style.pointerEvents = 'auto';
    }
    document.querySelectorAll('.portal-section').forEach((el) => { el.style.display = 'none'; });
    const app = document.getElementById('app');
    if (app) app.style.display = 'none';
    overview.className = 'ss-shot-course';
    overview.style.display = 'block';
    const files = courseData.files || [];
    const tabs = ['overview', 'files', 'quiz', 'flashcards'];
    const tabHtml = tabs.map((tab) => (
      `<div class="ss-tab ${tab === activeMode ? 'active' : ''}">${tab === 'overview' ? 'Overview' : tab[0].toUpperCase() + tab.slice(1)}</div>`
    )).join('');
    const filesHtml = `
      <section class="ss-panel">
        <div class="ss-panel-head">
          <div><h2>Files</h2><p>Organized lecture material ready for AI, notes, quiz, and flashcard generation.</p></div>
          <div class="ss-actions"><button>Select multiple</button><button>New folder</button><button class="ss-action-primary">Upload files</button></div>
        </div>
        <div class="ss-files">
          ${files.map((file) => `
            <div class="ss-file">
              <div class="ss-file-icon">PDF</div>
              <div><div class="ss-file-name">${file.name}</div><div class="ss-file-meta">${file.size} · Uploaded Today · AI indexed</div></div>
              <button>Open</button>
            </div>`).join('')}
        </div>
      </section>`;
    const quizHtml = `
      <section class="ss-panel">
        <div class="ss-panel-head">
          <div><h2>Quiz</h2><p>Practice exam-style questions generated from the indexed course files.</p></div>
          <button class="ss-action-primary">Generate quiz</button>
        </div>
        <div class="ss-two-col">
          <div class="ss-card"><h3>Ready Topics</h3><ul><li>Free-body diagrams</li><li>Equilibrium equations</li><li>Moment balance</li></ul></div>
          <div class="ss-card"><h3>Suggested Question</h3><p>A beam is supported at two points and loaded at an angle. Which equations solve the support reactions?</p></div>
        </div>
      </section>`;
    const flashHtml = `
      <section class="ss-panel">
        <div class="ss-panel-head">
          <div><h2>Flashcards</h2><p>Turn lecture concepts and formulas into spaced-repetition cards.</p></div>
          <button class="ss-action-primary">Generate cards</button>
        </div>
        <div class="ss-two-col">
          <div class="ss-card"><h3>Select a deck</h3><p>Mechanics basics · 18 cards · recently studied</p></div>
          <div class="ss-card"><h3>Preview</h3><p><strong>Front:</strong> What is required for static equilibrium?</p><p><strong>Back:</strong> Sum of forces and moments must equal zero.</p></div>
        </div>
      </section>`;
    const overviewHtml = `
      <section class="ss-panel">
        <div class="ss-panel-head"><div><h2>Course Overview</h2><p>Everything in this course is ready for document review, AI tutoring, notes, quizzes, and flashcards.</p></div></div>
        <div class="ss-two-col">
          <div class="ss-card"><h3>Next steps</h3><ul><li>Review sample-lecture.pdf</li><li>Generate a quiz from Mechanics Lecture 03</li><li>Create flashcards for equilibrium formulas</li></ul></div>
          <div class="ss-card"><h3>Course stats</h3><ul><li>2 indexed PDFs</li><li>2 lecture notes</li><li>58% study progress</li></ul></div>
        </div>
      </section>`;
    const panels = { overview: overviewHtml, files: filesHtml, quiz: quizHtml, flashcards: flashHtml };
    overview.innerHTML = `
      <div class="ss-course-shell">
        <div class="ss-course-top">
          <button class="ss-back">← Back</button>
          <button class="ss-study">Study</button>
        </div>
        <section class="ss-hero">
          <h1>${courseData.name}</h1>
          <p>${courseData.meta}. Manage files, generate quizzes, study flashcards, and open AI or notes inside this course.</p>
          <div class="ss-progress"><div><div class="ss-progress-value">58%</div><p>Study progress</p></div><div class="ss-progress-track"><div class="ss-progress-fill"></div></div></div>
        </section>
        <nav class="ss-tabs">${tabHtml}</nav>
        ${panels[activeMode] || overviewHtml}
      </div>`;
  }, { courseData: course, activeMode: mode });
  await waitForSettled(page);
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout: 1200 }).catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function waitForAppShell(page) {
  await page.waitForFunction(
    () => {
      const loggedIn = sessionStorage.getItem('ss_logged_in') === 'true';
      const hasApp =
        !!document.querySelector('#portal') ||
        !!document.querySelector('#courseAddBtn') ||
        !!document.querySelector('#sdCourseList') ||
        !!document.querySelector('#welcomeState') ||
        !!document.querySelector('#courseOverview');
      const hasAuth =
        !!document.querySelector('#authEmail') ||
        !!document.querySelector('#authModal') ||
        !!document.querySelector('#nlNavSignIn') ||
        !!document.querySelector('#landingLoginBtn');
      return loggedIn || hasApp || hasAuth || document.body?.getAttribute('data-ss-ready') === 'true';
    },
    { timeout: 30000 }
  );
}

async function openSection(page, section, navId, visibleSelector, contentSelector) {
  await closeFloatingPanels(page);
  await page.evaluate(
    ({ sectionName, nav }) => {
      window._currentUser = window._currentUser || {
        id: 'screenshot-user',
        email: 'screenshot@minallo.local'
      };
      const internalSection = sectionName === 'courses' ? 'studip' : sectionName;
      if (typeof window.showPortal === 'function') window.showPortal();
      if (typeof window.setNavActive === 'function') window.setNavActive(nav);
      if (typeof window.showPortalSection === 'function') {
        try {
          window.showPortalSection(internalSection);
        } catch (e) {}
      } else {
        const portal = document.getElementById('portal');
        if (portal) {
          portal.classList.add('show');
          portal.style.display = 'block';
          portal.style.opacity = '1';
          portal.style.pointerEvents = 'auto';
        }
        document.querySelectorAll('.portal-section').forEach((el) => {
          el.style.display = 'none';
        });
        const id = internalSection === 'studip' ? 'psec-studip' : `psec-${internalSection}`;
        const target = document.getElementById(id);
        if (target) target.style.display = 'block';
      }
      if (internalSection === 'chat' && typeof window._chatInit === 'function') {
        try {
          window._chatInit();
        } catch (e) {}
      }
      if (internalSection === 'lounge' && typeof window._loungeRender === 'function') window._loungeRender();
      if (internalSection === 'aipage' && typeof window._aipRefreshSidebar === 'function') {
        window._aipRefreshSidebar();
      }
    },
    { sectionName: section === 'ai-page' ? 'aipage' : section, nav: navId }
  );
  await page.locator(visibleSelector).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  if (contentSelector) {
    await page.locator(contentSelector).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  }
  await page.waitForFunction(
    ({ selector }) => {
      const root = document.querySelector(selector);
      if (!root) return false;
      const style = getComputedStyle(root);
      const text = (root.innerText || '').trim();
      return style.display !== 'none' && style.visibility !== 'hidden' && text.length > 20;
    },
    { selector: visibleSelector.split(',')[0] },
    { timeout: 5000 }
  ).catch(() => {});
  await closeFloatingPanels(page);
  await waitForSettled(page);
}

async function capturePublic(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  await waitForSettled(page);
  await screenshot(page, '00-landing');

  const opened = await clickFirstVisible(page, [
    '#nlNavSignIn',
    '#landingLoginBtn',
    '[data-i18n="landing_nav_login"]',
    'button:has-text("Login")',
    'button:has-text("Sign in")'
  ]);
  if (opened) {
    await page.locator('#authModal, #authEmail').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    await waitForSettled(page);
    await screenshot(page, '01-auth-sign-in');

    const switched = await clickFirstVisible(page, ['#authSwitch', 'button:has-text("Sign up")', 'a:has-text("Sign up")']);
    if (switched) {
      await waitForSettled(page);
      await screenshot(page, '02-auth-sign-up');
    }
  }

  if (!(await exists(path.join(outDir, '02-auth-sign-up.png')))) {
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await waitForSettled(page);
    const signupOpened = await clickFirstVisible(page, [
      '#nlNavStartFree',
      'button:has-text("Start free trial")',
      'a:has-text("Start free trial")'
    ]);
    if (signupOpened) {
      await page.locator('#authModal, #authEmail').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await waitForSettled(page);
      await screenshot(page, '02-auth-sign-up');
    }
  }

  await context.close();
}

async function captureApp(browser) {
  const fakeUser = {
    id: 'screenshot-user',
    email: 'screenshot@minallo.local',
    user_metadata: { full_name: 'Screenshot User' }
  };
  const fakeToken = [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: fakeUser.id, exp: Math.floor(Date.now() / 1000) + 3600 }))
      .toString('base64url'),
    'screenshot'
  ].join('.');
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }
  });
  await context.addInitScript(({ token, userId }) => {
    try {
      sessionStorage.setItem('ss_logged_in', 'true');
      sessionStorage.setItem('ss_last_active', String(Date.now()));
      sessionStorage.setItem('sb_sess_token', token);
      localStorage.setItem('sb_sess_token', token);
      localStorage.setItem('sb_sess_refresh', 'screenshot-refresh-token');
      localStorage.setItem(`ob_done_${userId}`, '1');
      sessionStorage.removeItem('ss_show_auth');
      sessionStorage.setItem('ss_force_app', 'true');
      window._ssIsLoggedIn = true;
    } catch {}
  }, { token: fakeToken, userId: fakeUser.id });
  const page = await context.newPage();
  await page.route('**/auth/v1/health', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  );
  await page.route('**/auth/v1/user', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeUser) })
  );
  await page.route('**/auth/v1/token?grant_type=refresh_token', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: fakeToken,
        refresh_token: 'screenshot-refresh-token',
        user: fakeUser
      })
    })
  );
  await page.route('**/rest/v1/profiles**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: fakeUser.id,
          full_name: 'Screenshot User',
          university: 'TU Braunschweig',
          major: 'Mechanical Engineering',
          courses: [demoCourse],
          dashboard_notes: JSON.stringify([
            { id: 'n1', text: 'Revise free-body diagrams before Friday.' },
            { id: 'n2', text: 'Ask Minallo for eigenvalue practice questions.' }
          ])
        }
      ])
    })
  );
  await page.route('**/rest/v1/lecture_notes**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(demoLectureNotes.map(note => ({
        id: note.id,
        user_id: fakeUser.id,
        title: note.title,
        content: note.content,
        date: note.date,
        url: note.url
      })))
    })
  );
  await page.route('**/rest/v1/subscriptions**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          user_id: fakeUser.id,
          plan: 'pro',
          status: 'active',
          current_period_end: '2099-12-31T23:59:59.000Z',
          had_trial: true,
          admin_managed: true
        }
      ])
    })
  );
  await page.route('**/rest/v1/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  );
  await page.route('**/api/admin-users', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isAdmin: true })
    })
  );
  await page.route('**/storage/v1/**', route =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'mocked' }) })
  );
  await page.route('**/api/ai**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, text: 'Mocked screenshot response' })
    })
  );

  await page.goto(
    `${baseURL}/#access_token=${encodeURIComponent(fakeToken)}&refresh_token=screenshot-refresh-token`,
    { waitUntil: 'domcontentloaded' }
  );
  await waitForAppShell(page);
  await page.waitForSelector('#portal', { timeout: 30000 }).catch(() => {});
  await page
    .waitForFunction(() => typeof window._enterApp === 'function' && typeof window.showPortalSection === 'function', {
      timeout: 10000
    })
    .catch(() => {});
  await page.evaluate(user => {
    window._currentUser = user;
    window._userIsPro = true;
    window._userIsAdmin = true;
    window._subscriptionStatus = 'active';
    window._hasActiveSubscription = true;
    if (typeof window._enterApp === 'function') {
      try { window._enterApp(user); } catch (e) {}
    }
    if (typeof window.applySubscription === 'function') {
      try {
        window.applySubscription({
          plan: 'pro',
          status: 'active',
          admin_managed: true,
          had_trial: true
        });
      } catch (e) {}
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
    const splash = document.getElementById('ss-splash');
    if (splash) splash.style.display = 'none';
    document.querySelectorAll('.ss-seo-hero').forEach(el => {
      el.style.display = 'none';
    });
    if (typeof window.setNavActive === 'function') {
      try { window.setNavActive('psbDashboard'); } catch (e) {}
    }
    if (typeof window.showPortalSection === 'function') {
      try { window.showPortalSection('dashboard'); } catch (e) {}
    }
    const paywall = document.getElementById('paywallModal');
    if (paywall) {
      paywall.style.display = 'none';
      paywall.style.pointerEvents = 'none';
    }
  }, fakeUser).catch(() => {});
  await page.addStyleTag({
    content:
      '#paywallModal, .paywall-modal, [data-testid="paywall-modal"] { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; } #aiPanel:not(.ss-capture-ai-panel) { display: none !important; visibility: hidden !important; pointer-events: none !important; }'
  }).catch(() => {});
  await seedDemoData(page);
  await waitForSettled(page);

  const portalVisible = await page.evaluate(() => {
    const portal = document.getElementById('portal');
    if (!portal) return false;
    portal.classList.add('show');
    portal.style.display = 'block';
    portal.style.opacity = '1';
    portal.style.pointerEvents = 'auto';
    portal.style.zIndex = '200';
    return true;
  }).catch(() => false);
  if (!portalVisible) {
    await screenshot(page, '03-authenticated-session-not-available');
    await context.close();
    return false;
  }

  let index = 10;
  for (const [section, navId, visibleSelector, contentSelector] of sections) {
    await seedDemoData(page);
    await openSection(page, section, navId, visibleSelector, contentSelector);
    await page.evaluate(() => {
      const paywall = document.getElementById('paywallModal');
      if (paywall) {
        paywall.style.display = 'none';
        paywall.style.pointerEvents = 'none';
      }
      window._userIsPro = true;
      window._userIsAdmin = true;
      window._subscriptionStatus = 'active';
      window._hasActiveSubscription = true;
    }).catch(() => {});
    const normalized = String(index).padStart(2, '0');
    await screenshot(page, `${normalized}-${section}`);
    index += 1;
  }

  const adminVisible = await page.locator('#psbAdmin').isVisible({ timeout: 1000 }).catch(() => false);
  if (adminVisible) {
    await openSection(page, 'admin', 'psbAdmin', '#psec-admin');
    await screenshot(page, `${String(index).padStart(2, '0')}-admin`);
    index += 1;
  }

  await openSection(page, 'courses', 'pcStudip', '#psec-studip');
  await page.addStyleTag({
    content: '#paywallModal, .paywall-modal, [data-testid="paywall-modal"] { display: none !important; pointer-events: none !important; }'
  }).catch(() => {});
  await forceStyledCourseView(page, demoCourse, 'overview');
  await screenshot(page, `${String(index).padStart(2, '0')}-course-overview`);
  index += 1;
  for (const tab of ['files', 'quiz', 'flashcards']) {
    await forceStyledCourseView(page, demoCourse, tab);
    await screenshot(page, `${String(index).padStart(2, '0')}-course-${tab}`);
    index += 1;
  }
  await page.evaluate(() => {
    const pdf = document.getElementById('pdfView') || document.createElement('div');
    pdf.id = 'pdfView';
    pdf.style.cssText = 'display:block;min-height:calc(100vh - 88px);padding:28px;background:#0b1020;color:#f8fafc;font-family:Inter,system-ui,sans-serif';
    pdf.innerHTML = '<div style="max-width:1120px;margin:0 auto;display:grid;grid-template-columns:1fr 360px;gap:20px"><section style="border:1px solid rgba(255,255,255,.12);border-radius:24px;background:rgba(15,23,42,.78);padding:24px;min-height:720px"><h2 style="margin-top:0">sample-lecture.pdf</h2><div style="height:580px;border-radius:18px;background:#f8fafc;color:#111827;padding:40px;box-shadow:0 24px 80px rgba(0,0,0,.35)"><h1>Mechanics Lecture 03</h1><p>For static equilibrium, the sum of forces and moments must equal zero.</p><p style="margin-top:80px;text-align:center;color:#64748b">PDF page preview</p></div></section><aside style="border:1px solid rgba(255,255,255,.12);border-radius:24px;background:rgba(15,23,42,.78);padding:24px"><h3>Document tools</h3><button style="width:100%;padding:12px;border:0;border-radius:14px;background:#2563eb;color:#fff;font-weight:800">Open AI panel</button><button style="width:100%;padding:12px;border:0;border-radius:14px;background:rgba(255,255,255,.08);color:#fff;font-weight:800;margin-top:10px">Generate notes</button></aside></div>';
    (document.querySelector('#portal .main-scroll') || document.body).appendChild(pdf);
    document.querySelectorAll('.portal-section,#courseOverview').forEach((el) => { el.style.display = 'none'; });
  });
  await screenshot(page, `${String(index).padStart(2, '0')}-pdf-viewer`);
  index += 1;

  index = await captureAiSidePanels(page, index);

  await context.close();
  return true;
}

await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  await capturePublic(browser);
  const appCaptured = await captureApp(browser);
  console.log(`SCREENSHOT_DIR=${outDir}`);
  if (!appCaptured) {
    console.log('AUTH_WARNING=Authenticated portal was not available. Saved the logged-out state instead.');
  }
} finally {
  await browser.close();
}
