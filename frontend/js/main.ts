// Minallo frontend entry point.
//
// Imports app.js (compatibility bridge) which bootstraps all feature modules.
// As app.js shrinks, the init calls will move here and app.js will be removed.

import { initSidebarIcons } from './core/app-shell.js';
import { initPdfWorker } from './core/pdf-worker.js';
import { initPullToRefresh } from './core/pull-to-refresh.js';
import { initConsoleFilter } from './core/console-filter.js';
import { initAdminPanel } from './features/admin/admin-panel.js';
import { initOnboarding } from './features/auth/onboarding.js';
import { initStudyLounge } from './features/study-lounge/lounge.js';
import { initMusicServices } from './features/music/music-services.js';
import { initStudyTimer } from './features/study-timer/study-timer.js';
import { initDocumentRail } from './features/document-rail/document-rail.js';
// chatbot-new shell (~103 KB) is lazy-loaded by views/chatbot/chatbot.js on
// first navigation to the chatbot page. Keeping the static import here would
// pull it into the main.js module graph and download it on every login.
import { initWritingCoach } from './features/writing-coach/writing-coach.js';
import { initAiUsage } from './services/ai-usage.js';

window.addEventListener('error', (event: ErrorEvent) => {
  console.error('[Minallo] Unhandled error:', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  console.error('[Minallo] Unhandled promise rejection:', event.reason);
});

// Eager: affects first paint or core infrastructure.
initSidebarIcons();
initPdfWorker();
initDocumentRail();

// Deferred: not needed before the first navigation. Run in idle time so they
// don't block the main thread during boot. Falls back to setTimeout(0) when
// requestIdleCallback isn't available (Safari pre-2023, some embedded WebViews).
const runIdle = (fn: () => void): void => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
};

runIdle(() => initPullToRefresh());
runIdle(() => initConsoleFilter());
runIdle(() => initAdminPanel());
runIdle(() => initOnboarding());
// AI Fair-Use banner — checks usage on portal load and renders the banner
// once the user crosses 80% of the monthly cap. Cheap: one GET request,
// no further work unless the response triggers the banner.
runIdle(() => initAiUsage());
runIdle(() => initStudyLounge());
runIdle(() => initMusicServices({
  sb: window._sb as never,
  getCurrentUser: () => window._currentUser ?? null,
  applyUserTypeUI: () => {
    if (typeof window._applyUserTypeUI === 'function') {
      window._applyUserTypeUI();
    }
  },
  showToast: (title: string, sub?: string) => {
    if (typeof window.showToast === 'function') window.showToast(title, sub);
  },
}));
runIdle(() => initStudyTimer());
runIdle(() => initWritingCoach());

// Notifications shell: the portal section #psec-notifications is scaffolded
// UI without a backend feed yet. Wire #notifMarkAll so the button gives
// the user feedback instead of looking broken. Once a real notifications
// table exists we can swap the body for a Supabase update.
runIdle(() => {
  const btn = document.getElementById('notifMarkAll');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const list = document.getElementById('notifList');
    if (list) {
      const items = list.querySelectorAll<HTMLElement>('.notif-item');
      items.forEach((el) => el.classList.remove('is-unread'));
    }
    const count = document.getElementById('notifCount');
    if (count) {
      // i18n: prefer the "all caught up" translation if it has been
      // injected; fall back to the literal default that lives in the
      // HTML data-i18n attribute.
      count.textContent = count.dataset.allCaughtText || 'All caught up';
    }
    const original = btn.textContent;
    btn.textContent = '✓';
    (btn as HTMLButtonElement).disabled = true;
    setTimeout(() => {
      (btn as HTMLButtonElement).disabled = false;
      if (original) btn.textContent = original;
    }, 1200);
    if (typeof window.showToast === 'function') {
      window.showToast('Notifications', 'All marked as read.');
    }
  });
});

// @ts-ignore — dynamic import with cache-busting query string
import('./app.js?v=7');
