// Notify the document rail of a route change (PDF / courses / other).
// The rail module exposes itself via window.__minalloDocRail to avoid a
// hard module dependency from core/panels into a feature module.
function _notifyDocRail(route: 'pdf' | 'courses' | 'other'): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dr = (window as any).__minalloDocRail as
    | { setRouteVisibility: (route: 'pdf' | 'courses' | 'other') => void }
    | undefined;
  if (dr && typeof dr.setRouteVisibility === 'function') {
    dr.setRouteVisibility(route);
  }
}

export function panelShow(el: HTMLElement | null, isFlexEl?: boolean): void {
  if (!el) return;
  el.style.display = isFlexEl ? 'flex' : 'block';
}

export function panelHide(el: HTMLElement | null): void {
  if (!el) return;
  el.style.display = 'none';
}

export function showFilesView(stRunning?: boolean): void {
  const portal = document.getElementById('portal');
  if (portal) {
    portal.classList.add('show');
    portal.style.display = 'block';
    portal.style.opacity = '1';
    portal.style.pointerEvents = 'auto';
  }
  const ms = document.querySelector<HTMLElement>('#portal .main-scroll');
  if (ms) ms.style.display = 'none';
  const app = document.getElementById('app');
  if (app) app.style.display = 'flex';
  const fab = document.getElementById('addWidgetFab');
  if (fab) fab.classList.remove('visible');
  const back = document.getElementById('goPortal');
  if (back) back.style.display = '';
  const title = document.getElementById('topTitle');
  if (title) title.style.display = 'none';
  const crumb = document.getElementById('breadcrumb');
  if (crumb) crumb.style.display = '';
  const stBtn = document.getElementById('studyTechBtn');
  if (stBtn) stBtn.style.display = 'flex';
  const stMini = document.getElementById('stMiniTimer');
  if (stMini) stMini.style.display = stRunning ? 'flex' : 'none';
  _notifyDocRail('pdf');
}

// Single source of truth for which of the two top-level containers is shown.
// `#app` (file view with PDF inside) vs `#portal .main-scroll` (portal
// sections — including the courses listing, which is `psec-studip`).
// Earlier code had `#studipDash` references but that element doesn't exist;
// the courses listing has always been a portal section.
export type TopLevelView = 'file' | 'portal';

export function selectTopLevelView(which: TopLevelView, opts?: { stRunning?: boolean }): void {
  const portal = document.getElementById('portal');
  const app = document.getElementById('app');
  const mainScroll = document.querySelector<HTMLElement>('#portal .main-scroll');

  if (portal) {
    portal.classList.add('show');
    portal.style.display = 'block';
    portal.dataset.activeView = which;
  }

  if (which === 'file') {
    if (mainScroll) mainScroll.style.display = 'none';
    if (app) app.style.display = 'flex';
    _applyFileChrome(opts?.stRunning ?? false);
  } else {
    // 'portal' — show main-scroll, hide #app. Caller (showPortalSection) is
    // responsible for revealing the specific .portal-section they want.
    if (mainScroll) mainScroll.style.display = '';
    if (app) app.style.display = 'none';
    document.body.classList.remove('minallo-in-course');
    _applyPortalChrome();
  }
}

function _applyFileChrome(stRunning: boolean): void {
  const fab = document.getElementById('addWidgetFab');
  if (fab) fab.classList.remove('visible');
  const back = document.getElementById('goPortal');
  if (back) back.style.display = '';
  const title = document.getElementById('topTitle');
  if (title) title.style.display = 'none';
  const crumb = document.getElementById('breadcrumb');
  if (crumb) crumb.style.display = '';
  const stBtn = document.getElementById('studyTechBtn');
  if (stBtn) stBtn.style.display = 'flex';
  const stMini = document.getElementById('stMiniTimer');
  if (stMini) stMini.style.display = stRunning ? 'flex' : 'none';
}

function _applyPortalChrome(): void {
  const back = document.getElementById('goPortal');
  if (back) back.style.display = 'none';
  const title = document.getElementById('topTitle');
  if (title) title.style.display = '';
  const crumb = document.getElementById('breadcrumb');
  if (crumb) crumb.style.display = 'none';
  const stBtn = document.getElementById('studyTechBtn');
  if (stBtn) stBtn.style.display = 'none';
  const stMini = document.getElementById('stMiniTimer');
  if (stMini) stMini.style.display = 'none';
}

export function hideFilesView(): void {
  _notifyDocRail('other');
  const ms = document.querySelector<HTMLElement>('#portal .main-scroll');
  if (ms) ms.style.display = '';
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
  const back = document.getElementById('goPortal');
  if (back) back.style.display = 'none';
  const title = document.getElementById('topTitle');
  if (title) title.style.display = '';
  const crumb = document.getElementById('breadcrumb');
  if (crumb) crumb.style.display = 'none';
  const stBtn = document.getElementById('studyTechBtn');
  if (stBtn) stBtn.style.display = 'none';
  const stMini = document.getElementById('stMiniTimer');
  if (stMini) stMini.style.display = 'none';
}
