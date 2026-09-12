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
const outDir = path.join(root, 'artifacts', `sidebar-screenshots-${themeName}-${stamp}`);
const shots = [];

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

async function settle(page, extra = 900) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(extra);
  await page
    .waitForFunction(
      () => {
        const splash = document.getElementById('ss-splash');
        const splashVisible =
          splash &&
          getComputedStyle(splash).display !== 'none' &&
          splash.getBoundingClientRect().width > 10;
        return document.readyState !== 'loading' && !splashVisible;
      },
      { timeout: 20000 }
    )
    .catch(() => {});
  await page.waitForTimeout(350);
}

async function preparePortal(page) {
  await page.goto(`${baseURL}/#portal=courses`, { waitUntil: 'domcontentloaded' });
  await page.locator('#portal .sidebar').waitFor({ state: 'attached', timeout: 30000 });
  await page
    .waitForFunction(
      () => typeof window.showPortalSection === 'function' && !!document.querySelector('#portal .sidebar'),
      { timeout: 30000 }
    )
    .catch(() => {});

  await page.evaluate(theme => {
    window._userIsPro = true;
    window._hasActiveSubscription = true;
    window._subscriptionStatus = 'active';

    const paywall = document.getElementById('paywallModal');
    if (paywall) {
      paywall.style.display = 'none';
      paywall.style.visibility = 'hidden';
      paywall.style.opacity = '0';
      paywall.style.pointerEvents = 'none';
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

    if (typeof window.showPortalSection === 'function') window.showPortalSection('studip');
    if (typeof window.setNavActive === 'function') window.setNavActive('pcStudip');
    document.querySelectorAll('#portal .sidebar .sb-item').forEach(item => {
      item.classList.remove('on', 'active');
    });
    const courses = document.getElementById('pcStudip');
    if (courses) courses.classList.add('on', 'active');
    if (theme === 'light') {
      try {
        sessionStorage.setItem('ss_dark', '0');
        localStorage.setItem('ss_theme', 'light');
      } catch {}
      document.body.classList.remove('night');
      document.documentElement.classList.remove('night');
    }

    const avatar = document.getElementById('authAvatar');
    if (avatar) avatar.textContent = 'M';
    const name = document.getElementById('authName');
    if (name) name.textContent = 'Mohamed Ali Mariam';
    const sub = document.getElementById('sbUserSub');
    if (sub) sub.textContent = 'TU Braunschweig';
  }, themeName);

  await page.addStyleTag({
    content: `
      html, body, #portal { background: #050816 !important; }
      #portal .sidebar {
        display: flex !important;
        visibility: visible !important;
        opacity: 1 !important;
        position: absolute !important;
        left: 16px !important;
        top: 16px !important;
        bottom: auto !important;
        height: auto !important;
        min-height: 0 !important;
        transform: none !important;
        overflow: visible !important;
      }
      #portal .sb-nav {
        overflow: visible !important;
        max-height: none !important;
      }
      #portal .sb-bottom {
        position: static !important;
        margin-top: 14px !important;
      }
      #portal .sidebar.ss-open {
        width: var(--sb-w) !important;
      }
      #portal .sidebar.ss-open .sb-item > span:not(.sb-item-badge),
      #portal .sidebar.ss-open .sb-user-info,
      #portal .sidebar.ss-open .sb-section-label,
      #portal .sidebar.ss-open .sb-night-track-label {
        opacity: 1 !important;
        transform: translateX(0) !important;
        pointer-events: auto !important;
      }
      #portal .sidebar.ss-open .sb-user {
        padding-left: 12px !important;
        justify-content: flex-start !important;
      }
      #portal .sidebar.ss-open .sb-item {
        justify-content: flex-start !important;
        padding-left: 12px !important;
      }
      #portal .sidebar.ss-open .sb-item-icon {
        margin-right: 12px !important;
      }
      #portal .sidebar.ss-open .sb-divider {
        opacity: 0 !important;
      }
      #portal .main,
      #portal .mob-scrim,
      #paywallModal,
      #authModal,
      #onboardModal,
      .paywall-modal,
      [data-testid="paywall-modal"] {
        display: none !important;
      }
    `
  });

  await settle(page, 800);
}

async function captureSidebar(page, fileName, open) {
  await page.evaluate(isOpen => {
    const portal = document.getElementById('portal');
    if (portal) {
      portal.classList.add('show');
      portal.style.display = 'block';
      portal.style.opacity = '1';
      portal.style.pointerEvents = 'auto';
    }
    const sidebar = document.querySelector('#portal .sidebar');
    if (!sidebar) return;
    sidebar.style.display = 'flex';
    sidebar.style.visibility = 'visible';
    sidebar.style.opacity = '1';
    sidebar.style.transform = 'none';
    sidebar.classList.toggle('ss-open', isOpen);
  }, open);

  if (open) {
    await page.mouse.move(40, 40);
  } else {
    await page.mouse.move(1000, 500);
  }

  await page.waitForTimeout(900);
  const file = path.join(outDir, fileName);
  await page.locator('#portal .sidebar').screenshot({ path: file, animations: 'disabled' });
  shots.push(file);
  console.log(file);
}

async function writeIndex() {
  const cards = shots
    .map(file => {
      const rel = path.relative(outDir, file).replace(/\\/g, '/');
      const name = path.basename(file, '.png');
      return `<figure><img src="${rel}" alt="${name}"><figcaption>${name}</figcaption></figure>`;
    })
    .join('\n');

  await fs.writeFile(
    path.join(outDir, 'index.html'),
    `<!doctype html>
<meta charset="utf-8">
<title>Minallo Sidebar Screenshots</title>
<style>
body{margin:0;background:#050816;color:#f8fafc;font-family:Inter,system-ui,sans-serif;padding:28px}
h1{font-size:24px;margin:0 0 18px}
.grid{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}
figure{margin:0;background:#0f172a;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px}
img{height:860px;width:auto;display:block;border-radius:8px}
figcaption{padding:10px 2px 2px;color:#cbd5e1;font-size:13px}
</style>
<h1>Minallo Sidebar Screenshots</h1>
<div class="grid">${cards}</div>`
  );
}

await fs.mkdir(outDir, { recursive: true });

const session = await signInWithPassword();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 1400 },
  deviceScaleFactor: 1
});

await context.addInitScript(
  ({ accessToken, refreshToken, userId }) => {
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
  },
  {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    userId: session.user.id,
    theme: themeName
  }
);

const page = await context.newPage();

try {
  await preparePortal(page);
  await captureSidebar(page, '01-sidebar-closed.png', false);
  await captureSidebar(page, '02-sidebar-open.png', true);
  await writeIndex();
  console.log(`SCREENSHOT_DIR=${outDir}`);
} finally {
  await context.close();
  await browser.close();
}
