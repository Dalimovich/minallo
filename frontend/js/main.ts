// Minallo frontend entry point.
//
// Imports app.js (compatibility bridge) which bootstraps all feature modules.
// As app.js shrinks, the init calls will move here and app.js will be removed.

import { initSidebarIcons } from './core/app-shell.js';
import { initPdfWorker } from './core/pdf-worker.js';
import { initNotifications } from './features/notifications/notifications.js';
// chatbot-new shell (~103 KB) is lazy-loaded by views/chatbot/chatbot.js on
// first navigation to the chatbot page. Keeping the static import here would
// pull it into the main.js module graph and download it on every login.

type DocRailRoute = 'pdf' | 'courses' | 'other';
type DocRailMode = 'ai' | 'problem' | 'notes' | 'summary';
type DocRailApi = {
  setRouteVisibility: (route: DocRailRoute) => void;
  open: (mode: DocRailMode) => void;
  close: () => void;
};

window.addEventListener('error', (event: ErrorEvent) => {
  console.error('[Minallo] Unhandled error:', event.error || event.message);
});

window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  console.error('[Minallo] Unhandled promise rejection:', event.reason);
});

// Eager: affects first paint or core infrastructure.
initSidebarIcons();
initPdfWorker();
initNotifications();

let docRailPromise: Promise<DocRailApi | null> | null = null;
function ensureDocumentRail(): Promise<DocRailApi | null> {
  if (docRailPromise) return docRailPromise;
  docRailPromise = lazyImportEncoded('Li9mZWF0dXJlcy9kb2N1bWVudC1yYWlsL2RvY3VtZW50LXJhaWwuanM=')
    .then((m) => {
      (m.initDocumentRail as () => void)();
      return ((window as unknown as { __minalloDocRail?: DocRailApi }).__minalloDocRail || null);
    })
    .catch((err: unknown) => {
      console.warn('[Minallo] document rail failed to load:', err);
      return null;
    });
  return docRailPromise;
}

(window as unknown as { __minalloDocRail?: DocRailApi }).__minalloDocRail = {
  setRouteVisibility(route: DocRailRoute): void {
    if (route === 'other' && !docRailPromise) return;
    ensureDocumentRail().then((api) => api?.setRouteVisibility(route));
  },
  open(mode: DocRailMode): void {
    ensureDocumentRail().then((api) => api?.open(mode));
  },
  close(): void {
    if (!docRailPromise) return;
    ensureDocumentRail().then((api) => api?.close());
  }
};

// Deferred: not needed before the first navigation. Run in idle time so they
// don't block the main thread during boot. Falls back to setTimeout(0) when
// requestIdleCallback isn't available (Safari pre-2023, some embedded WebViews).
const runIdle = (fn: () => void): void => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(fn, { timeout: 8000 });
  } else {
    setTimeout(fn, 4000);
  }
};

const runDelayed = (fn: () => void, ms = 20000): void => {
  setTimeout(fn, ms);
};

function lazyImportEncoded(encodedPath: string): Promise<Record<string, unknown>> {
  // Keep the URL non-literal at parse time. Some browsers/CDN transforms can
  // discover literal import('...') targets immediately, defeating the delay.
  const path = atob(encodedPath);
  // Cache-bust with the same ?v=<assetVersion> the loader stamps onto boot
  // scripts (loader.ts). Lazily-imported chunks are served immutable for a
  // year (Cloudflare cache), so without this a returning browser keeps the old
  // module forever and never sees post-deploy edits to these features.
  const v = window.MinalloConfig?.assetVersion;
  const url = v ? path + (path.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(String(v)) : path;
  return import(/* @vite-ignore */ url);
}

runIdle(() => lazyImportEncoded('Li9jb3JlL2NvbnNvbGUtZmlsdGVyLmpz').then((m) => (m.initConsoleFilter as () => void)()));
runDelayed(() => lazyImportEncoded('Li9mZWF0dXJlcy9hZG1pbi9hZG1pbi1wYW5lbC5qcw==').then((m) => (m.initAdminPanel as () => void)()));
// Onboarding can appear immediately after signup/login. Do not defer this:
// visible buttons must be wired before the user can click them.
lazyImportEncoded('Li9mZWF0dXJlcy9hdXRoL29uYm9hcmRpbmcuanM=')
  .then((m) => (m.initOnboarding as () => void)())
  .catch((err: unknown) => {
    console.warn('[Minallo] onboarding failed to load:', err);
  });
// AI Fair-Use banner — checks usage on portal load and renders the banner
// once the user crosses 80% of the monthly cap. Cheap: one GET request,
// no further work unless the response triggers the banner.
runDelayed(() => lazyImportEncoded('Li9zZXJ2aWNlcy9haS11c2FnZS5qcw==').then((m) => (m.initAiUsage as () => void)()), 12000);
runDelayed(() => lazyImportEncoded('Li9mZWF0dXJlcy9zdHVkeS1sb3VuZ2UvbG91bmdlLmpz').then((m) => (m.initStudyLounge as () => void)()));
runDelayed(() => lazyImportEncoded('Li9mZWF0dXJlcy9tdXNpYy9tdXNpYy1zZXJ2aWNlcy5qcw==').then((m) => (m.initMusicServices as (opts: unknown) => void)({
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
})));
// Study / Focus Session timer. The trigger buttons (#studyTechBtn topbar,
// #coStudyBtn course view, #pdfStudyBtn PDF header) are visible the moment the
// portal renders, but all of their click handling lives inside initStudyTimer.
// Loading that lazily on a 20s runDelayed meant the first clicks after a
// refresh were silently dropped until the chunk finally arrived ("button takes
// more than once to open the popup"). So: (1) an eager capture-phase bridge
// loads the module on the FIRST click and opens the popup as soon as it's
// ready, and (2) an idle fallback still initialises it without a click so a
// session that was running before reload is restored promptly.
let _stInitPromise: Promise<void> | null = null;
let _stInitDone = false;
function ensureStudyTimer(): Promise<void> {
  if (!_stInitPromise) {
    _stInitPromise = lazyImportEncoded('Li9mZWF0dXJlcy9zdHVkeS10aW1lci9zdHVkeS10aW1lci5qcw==')
      .then((m) => { (m.initStudyTimer as () => void)(); _stInitDone = true; })
      .catch((err: unknown) => { _stInitPromise = null; throw err; });
  }
  return _stInitPromise;
}
document.addEventListener('click', (e) => {
  // Once the module is initialised its own delegated handler (and the course
  // view's) take over — don't double-handle.
  if (_stInitDone) return;
  const t = e.target as HTMLElement | null;
  if (!t || !t.closest('#studyTechBtn, #coStudyBtn, #pdfStudyBtn')) return;
  ensureStudyTimer()
    .then(() => {
      const w = window as unknown as { openStudyPopup?: () => void };
      if (typeof w.openStudyPopup === 'function') w.openStudyPopup();
    })
    .catch(() => { /* import failed; idle fallback will retry */ });
}, true);
runIdle(() => { void ensureStudyTimer(); });
runDelayed(() => lazyImportEncoded('Li9mZWF0dXJlcy93cml0aW5nLWNvYWNoL3dyaXRpbmctY29hY2guanM=').then((m) => (m.initWritingCoach as () => void)()));

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
const appAssetVersion = String(window.MinalloConfig?.assetVersion || '1');
import(/* @vite-ignore */ './app.js?v=' + encodeURIComponent(appAssetVersion));
