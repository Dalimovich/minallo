// StudySphere frontend entry point.
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

window.addEventListener('error', function (event) {
  console.error('[StudySphere] Unhandled error:', event.error || event.message);
});

window.addEventListener('unhandledrejection', function (event) {
  console.error('[StudySphere] Unhandled promise rejection:', event.reason);
});

initSidebarIcons();
initPdfWorker();
initPullToRefresh();
initConsoleFilter();
initAdminPanel();
initOnboarding();
initStudyLounge();
initMusicServices({
  sb: window._sb,
  getCurrentUser: function () {
    return window._currentUser;
  },
  applyUserTypeUI: function () {
    if (typeof window._applyUserTypeUI === 'function') {
      return window._applyUserTypeUI();
    }
  },
  showToast: function (title, sub) {
    if (typeof window.showToast === 'function') window.showToast(title, sub);
  }
});
initStudyTimer();

import './app.js?v=7';
