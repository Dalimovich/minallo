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
import './features/chatbot-new/shell.js';
import { initWritingCoach } from './features/writing-coach/writing-coach.js';

window.addEventListener('error', (event: ErrorEvent) => {
  console.error('[Minallo] Unhandled error:', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  console.error('[Minallo] Unhandled promise rejection:', event.reason);
});

initSidebarIcons();
initPdfWorker();
initPullToRefresh();
initConsoleFilter();
initAdminPanel();
initOnboarding();
initStudyLounge();
initMusicServices({
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
});
initStudyTimer();
initDocumentRail();
initWritingCoach();

// @ts-ignore — dynamic import with cache-busting query string
import('./app.js?v=7');
