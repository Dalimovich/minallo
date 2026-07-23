// Minallo app.ts — entry orchestrator. Wires bridges, exposes legacy globals,
// owns the app-level mutable state (active course/file, pdf scale, etc.).

import { escapeHtml } from './utils/escape-html.js';
import { Store } from './core/state.js';
import { exposeLegacyVar, publishLegacyGlobals } from './core/globals.js';
import { initStatePersistence } from './core/state-persistence.js';
import { bindIf as _bindIf } from './core/portal-ui.js';
import { initSettingsBridge, t as _t } from './features/settings/settings-bridge.js';
import { initLandingAuthBridge } from './features/auth/landing-auth-bridge.js';
import { initAiChipsBridge } from './features/ai-chat/ai-chips-bridge.js';
import { initAiConfettiBridge, spawnConfetti } from './features/ai-chat/ai-confetti-bridge.js';
import { initAiPanelEffects } from './features/ai-chat/ai-panel-effects.js';
import { initAiPanelBridge } from './features/ai-chat/ai-panel-bridge.js';
import { attachMessageNavigator } from './features/message-navigator/message-navigator.js';
import {
  copyBubble as _copyBubble,
  fallbackCopy as _fallbackCopy,
  regenMsg as _regenMsg,
  addBotMsg as _addBotMsg,
  addUserMsg as _addUserMsg,
  setAiChipsVisible as _setAiChipsVisible_,
} from './features/ai-chat/ai-message-actions.js';
import {
  showPortal as _showPortal,
  showStudip as _showStudip,
  hideStudip as _hideStudip,
  setNavActive as _setNavActive,
  showPortalSection as _showPortalSection,
  navTo as _navToImpl,
  showStudipResume as _showStudipResume,
  clearResumeFile as _clearResumeFile,
} from './core/navigation.js';
import {
  showFilesView as _showFilesView,
  hideFilesView as _hideFilesView,
  panelShow as _panelShow,
  panelHide as _panelHide,
} from './core/panels.js';
import {
  renderCourses as _renderCourses,
  sdRenderCourses as _sdRenderCourses,
} from './features/courses/courses-render.js';
import { initCoursesLayout } from './features/courses/courses-layout.js';
import { initCourseSearch } from './features/courses/course-search.js';
import { initAuthBridge } from './features/auth/auth-bridge.js';
import {
  openCourse as _openCourse,
  showCourseSection as _showCourseSection,
} from './features/courses/course-view.js';
import { showFolderPickerPopup as _showFolderPickerPopup_ } from './features/courses/course-folders.js';
import {
  fetchPdfBytes as _fetchPdfBytes_,
  downloadFile as _downloadFile,
} from './services/pdf-service.js';
import { openFile as _openFile } from './features/pdf-viewer/pdf-viewer.js';
import { initPdfTabs } from './features/pdf-viewer/pdf-tabs.js';
import {
  createCheckoutSession as _createCheckoutSession,
  createPortalSession as _createPortalSession,
  pauseSubscription as _pauseSubscription,
  resumeSubscription as _resumeSubscription,
  cancelSubscription as _cancelSubscription,
  reactivateSubscription as _reactivateSubscription,
  applyRetentionDiscount as _applyRetentionDiscount,
  verifyPayment as _verifyPayment,
  activatePayPalSubscription as _activatePayPalSubscription,
  loadBillingConfig as _loadBillingConfig,
} from './services/subscription-service.js';
import type { LegacyCourse } from '../globals.js';

// ── External globals: defined elsewhere (app-data.js, supabase.js, etc.) ──
// They exist as `var` at script-tag scope; expose them to the TS compiler.
declare const COLORS: string[];
declare const SEMS: Record<string, { color: string; courses: LegacyCourse[] }>;
declare const SUBJECT_LIST: Array<{ name: string; short: string; cat?: string }>;
declare const _userMajor: string;
declare const _userVertiefung: string;
declare const _saveUserCourses: () => void;
declare const _sb: unknown;
declare const _currentUser: { id?: string; sub?: string; email?: string } | null;
declare function _verifyAndEnter(token: string): unknown;
declare function _enterApp(user: unknown): unknown;
declare function _resetActivityTimer(): void;
declare function applyProfile(p: unknown): void;
declare function _loadUserCourses(data: unknown): void;
declare const _stRunning: boolean | undefined;
declare function showToast(title: string, sub?: string): void;
declare function lnGenId(): string;
declare const lnSummaries: Array<{ id: string; title: string; text: string; date: string; url?: string }>;
declare function lnRender(summaries: unknown): void;
declare function lnSaveNoteToSupabase(note: unknown): Promise<unknown>;
declare function updatePageInfo(): void;
declare function renderPages(): void;

// ── GLOBAL FUNCTIONS (accessible from inline onclick) ─────────────────────
function copyBubble(btn: HTMLElement): void { _copyBubble(btn); }
function fallbackCopy(text: string): void { _fallbackCopy(text); }
function regenMsg(btn: HTMLElement): void { _regenMsg(btn); }
function _setAiChipsVisible(v: boolean): void { _setAiChipsVisible_(v); }
(window as unknown as { copyBubble: typeof copyBubble }).copyBubble = copyBubble;
(window as unknown as { regenMsg: typeof regenMsg }).regenMsg = regenMsg;
(window as unknown as { fallbackCopy: typeof fallbackCopy }).fallbackCopy = fallbackCopy;
window.addBotMsg = (text: string): HTMLElement | null => _addBotMsg(text);
window.addUserMsg = (text: string) => _addUserMsg(text);
window._setAiChipsVisible = _setAiChipsVisible;

// ── GLOBAL STUBS (reassigned after init) ────────────────────────────────
let askAI: (
  q: string,
  skipUserBubble?: boolean,
  opts?: {
    forceRefresh?: boolean;
    problemSolver?: {
      mode: string;
      problem: string;
      studentWork?: string;
    };
  }
) => unknown =
  (_q): void => { console.warn('AI not ready yet'); };
let openAI: () => void = (): void => {};
let closeAI: () => void = (): void => {};
let forceCloseAI: () => void = (): void => {};
let pinAI: () => void = (): void => {};
let showSelectionBanner: (txt: string) => void = (): void => {};

// ── NIGHT MODE (global — referenced by supabase.js before DOMContentLoaded) ──
let nightOn = Store.getState().settings.darkMode;
(function (): void {
  document.body.classList.toggle('night', nightOn);
})();

let deferredSave: () => void = (): void => {};
(window as unknown as { deferredSave: typeof deferredSave }).deferredSave = deferredSave;

// Router stubs are replaced by js/router.js after app.js loads.
let _ssHandlingPop = false;
let _ssRestoring = false;
let _pendingPortalRestore: { section: string } | null = null;
function _ssPushHistory(_state?: unknown, _hash?: string): void { /* replaced by router */ }
function _ssReplaceHistory(_state?: unknown, _hash?: string): void { /* replaced by router */ }

window._showFilesView = (): void => { _showFilesView(); };

function showStudip(): void { _showStudip(); }
function suppressAuthModalIfAppActive(): void {
  try {
    const hasAppSession =
      sessionStorage.getItem('ss_logged_in') === 'true' ||
      sessionStorage.getItem('ss_force_app') === 'true' ||
      !!(window as unknown as { _currentUser?: unknown })._currentUser;
    if (!hasAppSession) return;
    document.body.classList.add('minallo-app-active');
    const modal = document.getElementById('authModal');
    if (modal) {
      modal.style.display = 'none';
      modal.style.pointerEvents = 'none';
      modal.setAttribute('aria-hidden', 'true');
    }
  } catch {
    /* storage can be unavailable; portal navigation still works */
  }
}

function showPortal(): void {
  _showPortal();
  suppressAuthModalIfAppActive();
}
function hideStudip(): void {
  _hideStudip(typeof _stRunning !== 'undefined' ? _stRunning : false);
}
function showApp(): void {
  showStudip();
  _ssReplaceHistory({ view: 'studip' }, '#studip');
}
function setNavActive(id: string): void { _setNavActive(id); }
function showPortalSection(sec: string): void { _showPortalSection(sec); }
window.showPortalSection = showPortalSection;
window.showPortal = showPortal;

new MutationObserver(() => suppressAuthModalIfAppActive()).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
window.showStudip = showStudip;
window.hideStudip = hideStudip;
window.setNavActive = setNavActive;
function _navTo(navId: string, sec: string): void { _navToImpl(navId, sec); }

let saveState: () => void = (): void => {};
window.saveState = (): void => saveState();

let _statePersistence: { saveState: () => void; restoreState: () => void } | null = null;
const restoreState = (): void => {
  if (_statePersistence) _statePersistence.restoreState();
};

function renderCourses(): void {
  _renderCourses({ SEMS, COLORS, activeSemId, activeCourseId, _cameFromStudip } as unknown as Parameters<typeof _renderCourses>[0]);
}
function sdRenderCourses(): void {
  _sdRenderCourses({ SEMS, COLORS, sdActiveSemId } as unknown as Parameters<typeof _sdRenderCourses>[0]);
}
window.renderCourses = renderCourses;
window.sdRenderCourses = sdRenderCourses;

function renderTT(): void { /* sidebar removed */ }
function renderMails(): void { /* sidebar removed */ }

window.openCourse = _openCourse;
window.showCourseSection = _showCourseSection;
window._showFolderPickerPopup = _showFolderPickerPopup_;

function _fetchPdfBytes(path: string, cb: (b: Uint8Array) => void, onError?: (e: Error) => void): void {
  _fetchPdfBytes_(path, cb, onError);
}
function openFile(f: unknown, course: LegacyCourse): void {
  _clearResumeFile();
  _recordCourseFileOpen(course, f as { name?: string } | null | undefined);
  _openFile(f as Parameters<typeof _openFile>[0], course);
}

// Per-course set of file names the user has opened at least once. Stored in
// localStorage as a JSON array (Set isn't JSON-serializable). Caller is the
// only writer; readers (e.g. the courses grid) compute opened/total from this.
const _OPENED_MAX = 500;
function _recordCourseFileOpen(course: LegacyCourse | null | undefined, file: { name?: string } | null | undefined): void {
  if (!course || !course.id || !file || !file.name) return;
  try {
    localStorage.setItem('ss_lastopen_' + course.id, String(Date.now()));
  } catch { /* quota */ }
  const key = 'ss_opened_' + course.id;
  try {
    const raw = localStorage.getItem(key);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    if (arr.includes(file.name)) return;
    arr.push(file.name);
    if (arr.length > _OPENED_MAX) arr.splice(0, arr.length - _OPENED_MAX);
    localStorage.setItem(key, JSON.stringify(arr));
    const ts = Number(localStorage.getItem('ss_lastopen_' + course.id)) || Date.now();
    const ps = (window as unknown as { _progressSync?: { syncCourseProgress?: (id: string, f: string[], ms: number) => void } })._progressSync;
    ps?.syncCourseProgress?.(course.id, arr, ts);
  } catch { /* corrupted entry or quota — skip silently */ }
}
function downloadFile(fname: string): unknown { return _downloadFile(fname); }
window._fetchPdfBytes = _fetchPdfBytes;
window.openFile = openFile;
window.downloadFile = downloadFile;

// ── STATE ──────────────────────────────────────────────────────────────────
let activeSemId = 'ss2526';
let activeCourseId: string | null = null;
let activeFileName: string | null = null;
let currentCourseShort = '';
let pdfDoc: { numPages: number } | null = null;
let pdfPage = 1;
let pdfTotal = 0;
let pdfScale = 0.9;
let pdfShowAll = false;
let pdfFullText = '';
let _pdfOpenSeq = 0;
let aiOpen = false;
let aiPinned = false;
const _openFolders = new Set<string>();
window._openFolders = _openFolders;
const BACKEND_URL = '';
const _MATH_PROMPT = '';
let activeTypeTimer: ReturnType<typeof setTimeout> | null = null;
let activeThinkTimer: ReturnType<typeof setInterval> | null = null;
let generationStopped = false;
let currentGenId = 0;
let activeCourseRef: LegacyCourse | null = null;
let activeCourseSection = 'files';
let activePortalSection = 'dashboard';
let _cameFromStudip = false;
let _lang = localStorage.getItem('ss_lang') || 'en';

_statePersistence = initStatePersistence({
  getActiveSemId: () => activeSemId,
  getActiveCourseId: () => activeCourseId,
  getActiveFileName: () => activeFileName,
  getActiveCourseSection: () => activeCourseSection || 'files',
  getSems: () => window.SEMS as Parameters<typeof initStatePersistence>[0]['getSems'] extends () => infer R ? R : never,
  getCurrentUser: () => window._currentUser || null,
  setActiveSemId: (v) => { activeSemId = v; },
  setActiveCourseId: (v) => { activeCourseId = v; },
  setSsRestoring: (v) => { _ssRestoring = !!v; },
  setPendingPortalRestore: (v) => { _pendingPortalRestore = v; },
  setPendingRestoreCourse: (v) => { window._pendingRestoreCourse = v; },
  showFilesView: () => { _showFilesView(); },
  showStudip: () => { showStudip(); },
  showPortal: () => { showPortal(); },
  showPortalSection: (s) => { showPortalSection(s); },
  setNavActive: (id) => { setNavActive(id); },
  renderCourses: () => { renderCourses(); },
  panelShow: (el) => { _panelShow(el); },
  panelHide: (el) => { _panelHide(el); },
  showCourseSection: (c, s) => { _showCourseSection(c, s); },
});
saveState = _statePersistence.saveState;
window._lang = _lang;

exposeLegacyVar('activeSemId', () => activeSemId, (v: string) => { activeSemId = v; });
exposeLegacyVar('activeCourseId', () => activeCourseId, (v: string | null) => { activeCourseId = v; });
exposeLegacyVar('activeFileName', () => activeFileName, (v: string | null) => { activeFileName = v; });
exposeLegacyVar('currentCourseShort', () => currentCourseShort, (v: string) => { currentCourseShort = v; });
exposeLegacyVar('_pdfOpenSeq', () => _pdfOpenSeq, (v: number) => { _pdfOpenSeq = v; });
exposeLegacyVar('pdfDoc', () => pdfDoc, (v: { numPages: number } | null) => { pdfDoc = v; });
exposeLegacyVar('pdfPage', () => pdfPage, (v: number) => { pdfPage = v; });
exposeLegacyVar('pdfTotal', () => pdfTotal, (v: number) => { pdfTotal = v; });
exposeLegacyVar('pdfScale', () => pdfScale, (v: number) => { pdfScale = v; });
exposeLegacyVar('pdfShowAll', () => pdfShowAll, (v: boolean) => { pdfShowAll = v; });
exposeLegacyVar('pdfFullText', () => pdfFullText, (v: string) => { pdfFullText = v; });
exposeLegacyVar('activeTypeTimer', () => activeTypeTimer, (v: ReturnType<typeof setTimeout> | null) => { activeTypeTimer = v; });
exposeLegacyVar('activeThinkTimer', () => activeThinkTimer, (v: ReturnType<typeof setInterval> | null) => { activeThinkTimer = v; });
exposeLegacyVar('generationStopped', () => generationStopped, (v: boolean) => { generationStopped = v; });
exposeLegacyVar('currentGenId', () => currentGenId, (v: number) => { currentGenId = v; });
exposeLegacyVar('activeCourseRef', () => activeCourseRef, (v: LegacyCourse | null) => { activeCourseRef = v; });
exposeLegacyVar('activeCourseSection', () => activeCourseSection, (v: string) => { activeCourseSection = v; });
exposeLegacyVar('activePortalSection', () => activePortalSection, (v: string) => { activePortalSection = v; });
exposeLegacyVar('_cameFromStudip', () => _cameFromStudip, (v: boolean) => { _cameFromStudip = v; });
exposeLegacyVar('_lang', () => _lang, (v: string) => { _lang = v === 'de' ? 'de' : 'en'; });
exposeLegacyVar('nightOn', () => nightOn, (v: boolean) => { nightOn = !!v; });
exposeLegacyVar('_ssHandlingPop', () => _ssHandlingPop, (v: boolean) => { _ssHandlingPop = !!v; });
exposeLegacyVar('_ssRestoring', () => _ssRestoring, (v: boolean) => { _ssRestoring = !!v; });
exposeLegacyVar('_pendingPortalRestore', () => _pendingPortalRestore, (v: { section: string } | null) => { _pendingPortalRestore = v; });
exposeLegacyVar('deferredSave', () => deferredSave, (v: unknown) => {
  if (typeof v === 'function') deferredSave = v as typeof deferredSave;
});

publishLegacyGlobals({
  showStudip, showPortal, hideStudip, showApp,
  setNavActive, showPortalSection, _navTo, _bindIf,
  _showFilesView, _hideFilesView, saveState, restoreState,
  forceCloseAI, closeAI, openAI, spawnConfetti,
  renderCourses, sdRenderCourses, renderTT, renderMails,
  _ssPushHistory, _ssReplaceHistory, deferredSave,
  BACKEND_URL, _MATH_PROMPT,
});

// ── COURSES DASHBOARD ─────────────────────────────────────────────────────
let sdActiveSemId = 'ss2526';
try {
  const saved = sessionStorage.getItem('ss_sd_sem');
  if (saved && SEMS[saved]) sdActiveSemId = saved;
} catch { /* storage unavailable */ }
(window as unknown as { sdActiveSemId: string }).sdActiveSemId = sdActiveSemId;
exposeLegacyVar('sdActiveSemId', () => sdActiveSemId, (v: string) => {
  sdActiveSemId = v;
  (window as unknown as { sdActiveSemId: string }).sdActiveSemId = v;
  try { sessionStorage.setItem('ss_sd_sem', v); } catch { /* */ }
});

initCourseSearch({
  getUserUniversity: () => window._userUniversity || localStorage.getItem('ss_university') || '',
  getUserUniversityName: () => {
    try {
      const uid = window._currentUser?.id || window._currentUser?.sub || localStorage.getItem('ss_last_uid') || '';
      const cached = uid ? JSON.parse(localStorage.getItem('profile_cache_' + uid) || 'null') : null;
      return String(cached?.university_name || cached?.university || window._userUniversity || '');
    } catch {
      return window._userUniversity || '';
    }
  },
  getUserMajor: () => _userMajor,
  getUserVertiefung: () => _userVertiefung,
  getSubjectList: () => SUBJECT_LIST,
  getSems: () => SEMS,
  getActiveSemesterId: () => sdActiveSemId,
  saveUserCourses: () => { _saveUserCourses(); },
  renderCourses: () => { sdRenderCourses(); },
});
initCoursesLayout();

// Studip semester dropdown
const sdSemBtn = document.getElementById('sdSemBtn');
const sdSemDD = document.getElementById('sdSemDD');
const sdSemDot = document.getElementById('sdSemDot');
const sdSemLabel = document.getElementById('sdSemLabel');
const sdSemChev = document.getElementById('sdSemChev');
let sdDdOpen = false;
sdSemBtn?.addEventListener('click', (e: Event) => {
  e.stopPropagation();
  sdDdOpen = !sdDdOpen;
  sdSemDD?.classList.toggle('open', sdDdOpen);
  sdSemBtn.classList.toggle('open', sdDdOpen);
  sdSemChev?.classList.toggle('up', sdDdOpen);
});
sdSemDD?.querySelectorAll<HTMLElement>('.sem-opt').forEach((o) => {
  o.addEventListener('click', () => {
    const sid = o.getAttribute('data-sid');
    if (sid) {
      sdActiveSemId = sid;
      try { sessionStorage.setItem('ss_sd_sem', sid); } catch { /* */ }
    }
    if (sdSemLabel) sdSemLabel.textContent = (o.textContent || '').trim();
    const col = o.getAttribute('data-col');
    if (sdSemDot && col) sdSemDot.style.background = col;
    sdSemDD.querySelectorAll('.sem-opt').forEach((x) => x.classList.remove('sel'));
    o.classList.add('sel');
    sdDdOpen = false;
    sdSemDD.classList.remove('open');
    sdSemBtn?.classList.remove('open');
    sdSemChev?.classList.remove('up');
    sdRenderCourses();
  });
});
document.addEventListener('click', (e: Event) => {
  const target = e.target as Element | null;
  if (sdDdOpen && target && !target.closest('#sdSemBtn') && !target.closest('#sdSemDD')) {
    sdDdOpen = false;
    sdSemDD?.classList.remove('open');
    sdSemBtn?.classList.remove('open');
    sdSemChev?.classList.remove('up');
  }
});

// ── NIGHT MODE button sync ────────────────────────────────────────────────
(function (): void {
  const bIcon = document.getElementById('nightIcon');
  if (bIcon) bIcon.textContent = Store.getState().settings.darkMode ? '🌙' : '☀️';
  const bLbl = document.getElementById('nightLabel');
  if (bLbl) bLbl.textContent = Store.getState().settings.darkMode ? 'Night' : 'Day';
})();

// ── MULTI-FILE SUMMARY ────────────────────────────────────────────────────
let msmCurrentText = '';
let msmCurrentTitle = '';

document.getElementById('msmClose')?.addEventListener('click', () => {
  document.getElementById('multiSumModal')?.classList.remove('show');
});
document.getElementById('multiSumModal')?.addEventListener('click', function (this: HTMLElement, e: Event) {
  if (e.target === this) this.classList.remove('show');
});
document.getElementById('msmSaveBtn')?.addEventListener('click', async () => {
  if (!msmCurrentText) return;
  const note = {
    id: lnGenId(),
    title: msmCurrentTitle,
    text: msmCurrentText,
    date: new Date().toISOString(),
    url: '',
  };
  const summaries = lnSummaries.slice();
  summaries.unshift(note);
  lnRender(summaries);
  window.postMessage({ type: 'SS_DELETE_SUMMARY', summaries }, '*');
  document.getElementById('multiSumModal')?.classList.remove('show');
  showToast(_t('toast_saved'), msmCurrentTitle.slice(0, 50));
  await lnSaveNoteToSupabase(note);
});

function runMultiSummary(fnames: string[], course: LegacyCourse): unknown {
  return import(
    /* @vite-ignore */ atob('Li9mZWF0dXJlcy9haS1jaGF0L211bHRpLXN1bW1hcnkuanM=')
  ).then((mod) => mod.runMultiSummary(fnames, course));
}
(window as unknown as { runMultiSummary: typeof runMultiSummary }).runMultiSummary = runMultiSummary;

// Expose for the typing IIFE / setters above
exposeLegacyVar('msmCurrentText', () => msmCurrentText, (v: string) => { msmCurrentText = v; });
exposeLegacyVar('msmCurrentTitle', () => msmCurrentTitle, (v: string) => { msmCurrentTitle = v; });

// ── PDF ───────────────────────────────────────────────────────────────────
initPdfTabs();

function updateZoomPct(): void {
  const el = document.getElementById('pdfZoomPct') as HTMLInputElement | null;
  if (el && document.activeElement !== el) el.value = Math.round(pdfScale * 100) + '%';
}

document.getElementById('pdfBody')?.addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 3) showSelectionBanner(sel.toString().trim());
  }, 30);
});

let _pdfScrollFrame: number | null = null;
document.getElementById('pdfBody')?.addEventListener('scroll', () => {
  if (!pdfShowAll) return;
  if (_pdfScrollFrame !== null) cancelAnimationFrame(_pdfScrollFrame);
  _pdfScrollFrame = requestAnimationFrame(() => {
    _pdfScrollFrame = null;
    pdfPage = _pdfVisiblePage();
    updatePageInfo();
  });
});
document.getElementById('pdfPrev')?.addEventListener('click', () => {
  if (pdfPage > 1) {
    pdfPage--;
    pdfShowAll = false;
    updatePageInfo();
    renderPages();
  }
});
document.getElementById('pdfNext')?.addEventListener('click', () => {
  if (pdfPage < pdfTotal) {
    pdfPage++;
    pdfShowAll = false;
    updatePageInfo();
    renderPages();
  }
});

(function (): void {
  const inp = document.getElementById('pdfPageInput') as HTMLInputElement | null;
  if (!inp) return;
  inp.addEventListener('focus', function (this: HTMLInputElement) { this.select(); });
  inp.addEventListener('keydown', function (this: HTMLInputElement, e: KeyboardEvent) {
    if (e.key === 'Enter') { this.blur(); return; }
    if (e.key === 'Escape') {
      this.value = String(pdfShowAll ? _pdfVisiblePage() : pdfPage);
      this.blur();
    }
  });
  inp.addEventListener('blur', function (this: HTMLInputElement) {
    const n = parseInt(this.value, 10);
    if (n >= 1 && n <= pdfTotal && pdfTotal > 0) {
      pdfPage = n;
      updatePageInfo();
      if (pdfShowAll) _pdfScrollToPage(n);
      else renderPages();
    } else {
      this.value = String(pdfShowAll ? _pdfVisiblePage() : pdfPage);
    }
  });
})();

function _pdfVisiblePage(): number {
  if (!pdfShowAll) return pdfPage;
  const body = document.getElementById('pdfBody');
  if (!body) return pdfPage;
  const scrollTop = body.scrollTop;
  const wraps = body.querySelectorAll<HTMLElement>('.pdf-page-wrap');
  let best = pdfPage;
  let bestDist = Infinity;
  wraps.forEach((w) => {
    const dist = Math.abs(w.offsetTop - scrollTop);
    if (dist < bestDist) {
      bestDist = dist;
      best = parseInt(w.dataset.pageNum || '', 10) || pdfPage;
    }
  });
  return best;
}
function _pdfScrollToPage(num: number): void {
  const body = document.getElementById('pdfBody');
  if (!body) return;
  const wrap = body.querySelector<HTMLElement>('[data-page-num="' + num + '"]');
  if (wrap) body.scrollTop = wrap.offsetTop;
}

// Zoom by scaling the already-rendered pages live via a CSS `zoom` multiplier
// instead of re-rendering the canvases — so the document never reloads, blanks
// or flashes; it just grows/shrinks smoothly. pdfScale stays the single source
// of truth (the multiplier is pdfScale ÷ the scale we last rendered at), and
// renderPages resets the multiplier so page-change/show-all re-renders stay
// crisp. The viewport's top content is kept anchored as the page reflows.
function _applyPdfZoom(targetScale: number): void {
  const body = document.getElementById('pdfBody');
  const rendered = window._pdfRenderedScale || 0.9;
  // The multiplier also folds in a width factor so a column-width change
  // (e.g. the AI rail opening) that was fitted via _refitPdfWidth survives a
  // subsequent zoom instead of snapping back to the rendered width.
  const widthFactor =
    body && window._pdfRenderedWidth ? body.clientWidth / window._pdfRenderedWidth : 1;
  const prevMul = (pdfScale / rendered) * widthFactor;
  pdfScale = Math.min(4, Math.max(0.2, Math.round(targetScale * 100) / 100));
  const newMul = (pdfScale / rendered) * widthFactor;
  if (body) {
    const prevTop = body.scrollTop;
    body.style.setProperty('--pdf-wheel-zoom', String(newMul));
    if (prevMul > 0) body.scrollTop = prevTop * (newMul / prevMul);
  }
  updateZoomPct();
}

// Re-fit the PDF to the current column width WITHOUT re-rendering. Used when the
// document rail opens/closes and the PDF column changes width: re-rendering would
// blank the page, reset the scroll position and drop any text selection, whereas
// scaling the already-rendered pages via the same CSS `zoom` multiplier keeps all
// of that intact (the canvas just downscales/upscales to fit).
function _refitPdfWidth(): void {
  const body = document.getElementById('pdfBody');
  if (!body || !window._pdfRenderedWidth) return;
  const rendered = window._pdfRenderedScale || 0.9;
  const widthFactor = body.clientWidth / window._pdfRenderedWidth;
  const newMul = (pdfScale / rendered) * widthFactor;
  const prevRaw = parseFloat(getComputedStyle(body).getPropertyValue('--pdf-wheel-zoom'));
  const prevMul = Number.isFinite(prevRaw) && prevRaw > 0 ? prevRaw : pdfScale / rendered;
  const prevTop = body.scrollTop;
  body.style.setProperty('--pdf-wheel-zoom', String(newMul));
  if (prevMul > 0) body.scrollTop = prevTop * (newMul / prevMul);
}
window._refitPdfWidth = _refitPdfWidth;

document.getElementById('pdfZoomIn')?.addEventListener('click', () => {
  _applyPdfZoom(Math.round((pdfScale + 0.1) * 10) / 10);
});
document.getElementById('pdfZoomOut')?.addEventListener('click', () => {
  _applyPdfZoom(Math.round((pdfScale - 0.1) * 10) / 10);
});
document.getElementById('pdfFit')?.addEventListener('click', () => {
  _applyPdfZoom(0.9);
});

(function (): void {
  const inp = document.getElementById('pdfZoomPct') as HTMLInputElement | null;
  if (!inp) return;
  inp.addEventListener('focus', function (this: HTMLInputElement) {
    this.value = String(Math.round(pdfScale * 100));
    this.select();
  });
  inp.addEventListener('keydown', function (this: HTMLInputElement, e: KeyboardEvent) {
    if (e.key === 'Enter') { this.blur(); return; }
    if (e.key === 'Escape') {
      this.value = Math.round(pdfScale * 100) + '%';
      this.blur();
    }
  });
  inp.addEventListener('blur', function (this: HTMLInputElement) {
    const percentage = Number.parseFloat(this.value.replace('%', '').trim());
    if (Number.isFinite(percentage) && percentage >= 20 && percentage <= 400) {
      _applyPdfZoom(percentage / 100);
    }
    this.value = Math.round(pdfScale * 100) + '%';
  });
})();

// Ctrl/Cmd + mouse wheel zoom, like a browser or native PDF reader.
// preventDefault stops the browser's own page zoom.
document.getElementById('pdfBody')?.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    _applyPdfZoom(pdfScale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false }
);
// Fullscreen reading mode. We request native fullscreen on <html> (so the
// browser tabs + address bar disappear), and apply layout classes so that
// INSIDE the fullscreen the sidebar + header are covered while the document
// rail (#drRoot, a separate fixed element) stays visible and usable. Driving
// the classes off `fullscreenchange` keeps them in sync no matter how the user
// enters/exits (button, Esc, F11). If the browser blocks fullscreen we fall
// back to the in-app maximize (classes only).
function _applyPdfMax(on: boolean): void {
  const wrap = document.getElementById('pdfViewerWrap');
  if (!wrap) return;
  const pg = _pdfVisiblePage();
  wrap.classList.toggle('is-maximized', on);
  document.body.classList.toggle('pdf-maximized', on);
  const mbtn = document.getElementById('pdfMaximize');
  if (mbtn) {
    mbtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    mbtn.setAttribute('title', on ? 'Exit fullscreen (Esc)' : 'Fullscreen');
    mbtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
  }
  renderPages();
  setTimeout(() => _pdfScrollToPage(pg), 120);
}
function _pdfIsMax(): boolean {
  return (
    !!document.fullscreenElement ||
    !!document.getElementById('pdfViewerWrap')?.classList.contains('is-maximized')
  );
}
function _togglePdfMaximize(): void {
  if (_pdfIsMax()) {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else _applyPdfMax(false);
    return;
  }
  // Fullscreen <html> so the rail (a sibling of the PDF) stays on screen too.
  const req = document.documentElement.requestFullscreen?.();
  if (req && typeof req.then === 'function') {
    req.catch(() => _applyPdfMax(true)); // success → fullscreenchange handles it
  } else {
    _applyPdfMax(true);
  }
}
document.getElementById('pdfMaximize')?.addEventListener('click', _togglePdfMaximize);
document.getElementById('pdfMaximizeBoth')?.addEventListener('click', _togglePdfMaximize);
// Native enter/exit (button, Esc, F11) all route through here.
document.addEventListener('fullscreenchange', () => {
  _applyPdfMax(!!document.fullscreenElement);
});
// Esc also exits the in-app fallback when no native fullscreen is active.
document.addEventListener('keydown', (e) => {
  if (
    e.key === 'Escape' &&
    !document.fullscreenElement &&
    document.getElementById('pdfViewerWrap')?.classList.contains('is-maximized')
  ) {
    _applyPdfMax(false);
  }
});
document.getElementById('pdfDownload')?.addEventListener('click', () => {
  if (activeFileName) downloadFile(activeFileName);
});
document.getElementById('pdfBack')?.addEventListener('click', () => {
  // Leaving the reader: exit fullscreen + drop maximize so the next view isn't
  // stuck fixed.
  if (document.fullscreenElement) void document.exitFullscreen?.();
  document.body.classList.remove('pdf-maximized');
  document.getElementById('pdfViewerWrap')?.classList.remove('is-maximized');
  const w = window as unknown as {
    activeCourseRef?: { id?: string } & Record<string, unknown>;
    showCourseSection?: (course: unknown, section: string) => void;
    showPortalSection?: (section: string) => void;
  };
  if (w.activeCourseRef && typeof w.showCourseSection === 'function') {
    w.showCourseSection(w.activeCourseRef, 'files');
    return;
  }
  // 'studip' is the internal portal-section id; 'courses' is a URL alias only,
  // and passing it to showPortalSection blanks the page (no psec-courses node).
  if (typeof w.showPortalSection === 'function') w.showPortalSection('studip');
});
document.getElementById('pdfAll')?.addEventListener('click', () => {
  pdfShowAll = !pdfShowAll;
  const btn = document.getElementById('pdfAll');
  if (btn) btn.textContent = pdfShowAll ? 'Single page' : 'All pages';
  renderPages();
});
// In-toolbar Study button — delegates to the existing topbar trigger so the
// Focus Session popup, click-outside guard, and timer state all stay in sync.
document.getElementById('pdfStudyBtn')?.addEventListener('click', () => {
  const stBtn = document.getElementById('studyTechBtn') as HTMLButtonElement | null;
  if (stBtn) stBtn.click();
});

// ── AI PANEL ──────────────────────────────────────────────────────────────
const aiPanel = document.getElementById('aiPanel');
const aiMsgs = document.getElementById('aiMsgs');

if (typeof window.renderMarkdown !== 'function') {
  window.renderMarkdown = (text: string): string => escapeHtml(text);
}

// Cache-bust with ?v=<assetVersion> exactly like main.ts's lazyImportEncoded:
// these feature chunks (and their nested static imports, e.g. ai-markdown.js) are
// served immutable for a year, so without the version a returning browser keeps
// the OLD renderer forever and never sees fixes (tables, KaTeX, etc).
function _versionedImport(encodedPath: string): Promise<Record<string, unknown>> {
  const path = atob(encodedPath);
  const v = window.MinalloConfig?.assetVersion;
  const url = v ? path + (path.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(String(v)) : path;
  return import(/* @vite-ignore */ url);
}

let _aiRenderBridgePromise: Promise<unknown> | null = null;
function _ensureAiRenderBridge(): Promise<unknown> {
  if (_aiRenderBridgePromise) return _aiRenderBridgePromise;
  _aiRenderBridgePromise = _versionedImport('Li9mZWF0dXJlcy9haS1jaGF0L2FpLXJlbmRlci1icmlkZ2UuanM=')
    .then((mod) => (mod.initAiRenderBridge as () => unknown)())
    .catch((err: unknown) => {
      // Never cache the failed import — markdown/KaTeX rendering would stay
      // broken for the whole session after one network blip.
      _aiRenderBridgePromise = null;
      throw err;
    });
  return _aiRenderBridgePromise;
}
(window as unknown as { _ensureAiRenderBridge?: () => Promise<unknown> })._ensureAiRenderBridge =
  _ensureAiRenderBridge;

let _aiExportBridgePromise: Promise<unknown> | null = null;
function _ensureAiExportBridge(): Promise<unknown> {
  if (_aiExportBridgePromise) return _aiExportBridgePromise;
  _aiExportBridgePromise = _versionedImport('Li9mZWF0dXJlcy9haS1jaGF0L2FpLWV4cG9ydC1icmlkZ2UuanM=')
    .then((mod) => (mod.initAiExportBridge as () => unknown)());
  return _aiExportBridgePromise;
}

initAiPanelEffects({ aiMsgs, aiPanel });
// Compact message minimap on the right edge of the side-panel chat. The
// component is DOM-driven (MutationObserver on #aiMsgs), so it tracks both
// the floating panel and its document-rail-hosted (.dr-host-ai) incarnation.
if (aiPanel && aiMsgs) {
  attachMessageNavigator({
    host: aiPanel,
    scroller: aiMsgs,
    container: aiMsgs,
    // User turns only (ChatGPT-style) — AI replies would double the list.
    messageSelector: '.ai-msg-wrap.user',
    isUser: () => true,
    snippetSource: (row) => row.querySelector<HTMLElement>('.ai-bubble') || row,
    // The document-rail's fixed button rail (z-index 9500) covers the
    // drawer's right edge, so an edge overlay would hide behind it. When a
    // vertical rail is on screen, mount the track INSIDE it (below the
    // buttons) instead; it grows taller than the button stack and scrolls
    // internally past the height cap. No rail → normal edge overlay.
    inlineMount: () => {
      const rail = document.querySelector<HTMLElement>('.dr-rail');
      if (!rail) return null;
      const r = rail.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      // Mobile flips the rail horizontal at the bottom — no room for a
      // vertical track there (the navigator is display:none <720px anyway).
      if (r.width > r.height) return null;
      return rail;
    },
    // Overlay-mode fallback: if the rail exists but inlineMount declined it,
    // still keep the track clear of any horizontal overlap.
    rightInset: () => {
      const rail = document.querySelector<HTMLElement>('.dr-rail');
      if (!rail) return 0;
      const r = rail.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return 0;
      const s = aiMsgs.getBoundingClientRect();
      if (r.bottom < s.top || r.top > s.bottom) return 0;
      return Math.max(0, s.right - r.left);
    },
    compact: true,
    minMessages: 3,
  });
}
const _aiPanelBridge = initAiPanelBridge({
  aiPanel, aiClose: document.getElementById('aiClose'), aiMsgs,
  t: _t, escapeHtml,
  askAI: (prompt: string) => askAI(prompt),
  getAiPinned: () => aiPinned,
  setAiPinned: (v: boolean) => { aiPinned = v; },
  getAiOpen: () => aiOpen,
  setAiOpen: (v: boolean) => { aiOpen = v; },
});
openAI = (): void => {
  void _ensureAiRenderBridge();
  void _ensureAiExportBridge();
  _aiPanelBridge.openAI();
};
closeAI = _aiPanelBridge.closeAI;
forceCloseAI = _aiPanelBridge.forceCloseAI;
pinAI = _aiPanelBridge.pinAI;
showSelectionBanner = (txt: string): void => {
  void _ensureAiRenderBridge();
  void _ensureAiExportBridge();
  _aiPanelBridge.showSelectionBanner(txt);
};

(window as unknown as { _aiPanelBridge: typeof _aiPanelBridge })._aiPanelBridge = _aiPanelBridge;
(window as unknown as { _aiMsgs: HTMLElement | null })._aiMsgs = aiMsgs;
window.openAI = openAI;
(window as unknown as { closeAI: typeof closeAI }).closeAI = closeAI;
window.forceCloseAI = forceCloseAI;
window.pinAI = pinAI;
window.showSelectionBanner = showSelectionBanner;

// Welcome message
setTimeout(() => {
  if (window.addBotMsg) {
    window.addBotMsg(
      window._t ? window._t('ai_welcome') : "👋 Hello! Open a PDF and I'll help you study it."
    );
  }
}, 0);

const _aiState = {
  get generationStopped(): boolean { return generationStopped; },
  set generationStopped(v: boolean) { generationStopped = v; },
  get currentGenId(): number { return currentGenId; },
  set currentGenId(v: number) { currentGenId = v; },
  get activeTypeTimer(): ReturnType<typeof setTimeout> | null { return activeTypeTimer; },
  set activeTypeTimer(v: ReturnType<typeof setTimeout> | null) { activeTypeTimer = v; },
  get activeThinkTimer(): ReturnType<typeof setInterval> | null { return activeThinkTimer; },
  set activeThinkTimer(v: ReturnType<typeof setInterval> | null) { activeThinkTimer = v; },
};

let _aiAskBridgeReady = false;
let _aiAskBridgePromise: Promise<{ askAI: typeof askAI; stopGeneration: () => void }> | null = null;
function _ensureAiAskBridge(): Promise<{ askAI: typeof askAI; stopGeneration: () => void }> {
  if (_aiAskBridgePromise) return _aiAskBridgePromise;
  _aiAskBridgePromise = import(
    /* @vite-ignore */ atob('Li9mZWF0dXJlcy9haS1jaGF0L2FpLWFzay1icmlkZ2UuanM=')
  ).then((mod) => {
    const bridge = mod.initAiAskBridge(_aiState);
    askAI = bridge.askAI as typeof askAI;
    _aiAskBridgeReady = true;
    return bridge as { askAI: typeof askAI; stopGeneration: () => void };
  });
  return _aiAskBridgePromise;
}

askAI = ((q: string, skipUserBubble?: boolean, opts?: Parameters<typeof askAI>[2]) => {
  return Promise.all([_ensureAiRenderBridge(), _ensureAiExportBridge()])
    .then(() => _ensureAiAskBridge())
    .then((bridge) => bridge.askAI(q, skipUserBubble, opts));
}) as typeof askAI;
window.askAI = askAI;
window.stopGeneration = (): void => {
  void _ensureAiAskBridge().then((bridge) => bridge.stopGeneration());
};
window.restoreCourseHistory = (courseId?: string | null, fileId?: string | null): void => {
  // Ensure the render + export bridges too (not just ask) — otherwise restored
  // history renders with renderMarkdown/_renderMath/_aiResponseActions missing,
  // so answers come back as raw markdown/LaTeX with no export buttons.
  void Promise.all([_ensureAiRenderBridge(), _ensureAiExportBridge()])
    .then(() => _ensureAiAskBridge())
    .then(() => {
      if (typeof window.restoreCourseHistory === 'function') window.restoreCourseHistory(courseId, fileId);
    });
};
window.clearCourseHistory = (courseId: string, fileId?: string | null): void => {
  void _ensureAiAskBridge().then(() => {
    if (typeof window.clearCourseHistory === 'function') window.clearCourseHistory(courseId, fileId);
  });
};
window.resetAiPanelChat = (): void => {
  void _ensureAiAskBridge().then(() => {
    if (typeof window.resetAiPanelChat === 'function') window.resetAiPanelChat();
  });
};

function _sendAiFromDomAfterBridge(): void {
  const input = document.getElementById('aiInput') as HTMLTextAreaElement | null;
  const q = (input?.value || '').trim();
  const hasImages = !!(window._attachedImages && window._attachedImages.length > 0);
  if (!q && !hasImages) return;
  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }
  const count = document.getElementById('aiCharCount');
  if (count) count.textContent = '0 / 2000';
  void _ensureAiAskBridge().then((bridge) => {
    if (hasImages && typeof window._legacyAskAI === 'function') {
      window._legacyAskAI(q || 'What do you see in this image?');
      return;
    }
    bridge.askAI(q || 'What do you see in this image?');
  });
}

function _primeAiAskBridge(): void {
  void _ensureAiAskBridge().catch((err) => {
    console.error('[ai] failed to load ask bridge:', err);
  });
}

const _aiSendBtn = document.getElementById('aiSend') as HTMLButtonElement | null;
const _aiInput = document.getElementById('aiInput') as HTMLTextAreaElement | null;
_aiSendBtn?.addEventListener('click', (e) => {
  if (_aiAskBridgeReady) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (_aiSendBtn.classList.contains('is-stop')) {
    window.stopGeneration?.();
    return;
  }
  if (_aiSendBtn.disabled) return;
  _sendAiFromDomAfterBridge();
}, true);
_aiInput?.addEventListener('focus', _primeAiAskBridge, { once: true });
_aiInput?.addEventListener('keydown', (e) => {
  if (_aiAskBridgeReady || e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  _sendAiFromDomAfterBridge();
}, true);

initAiChipsBridge();
initAiConfettiBridge();

// Two-phase cache application for instant perceived speed:
//
// Phase 1 (SYNC, now): apply cached PROFILE only — just DOM updates
// (name, avatar, university). Pure local work, no network. Gives the
// user a fully-styled shell on first paint instead of an empty header.
//
// Phase 2 (DEFERRED until ss-ready): apply cached COURSES via
// _loadUserCourses. That call triggers restoreState → _ufMerge → storage
// list, which can saturate the connection pool before ai.js loads. Keep
// it after ss-ready so the boot chain isn't blocked by a storage fetch.
let _cpCached: Record<string, unknown> | null = null;
try {
  const lastUid = localStorage.getItem('ss_last_uid');
  if (lastUid) {
    _cpCached = JSON.parse(localStorage.getItem('profile_cache_' + lastUid) || 'null');
    if (_cpCached && _cpCached.full_name && typeof applyProfile === 'function') {
      applyProfile(_cpCached);
    }
  }
} catch { /* corrupted cache — ignore */ }

// The Profile form is lazy-loaded (views/profile/profile.html). The applyProfile
// above runs at boot — before that HTML exists — so the fields stay empty until a
// network refresh, which is why Profile appears to "load late". Re-apply the
// cached profile the instant the section HTML is injected so fields fill
// immediately. (loadUserData keeps profile_cache_<uid> fresh after its fetch, and
// still re-applies on the network response if the user is already on the page.)
try {
  const _bus = (window as unknown as {
    Minallo?: { on?: (name: string, handler: (p: { id?: string }) => void) => void };
  }).Minallo;
  _bus?.on?.('feature:html-loaded', (p) => {
    if (!p || p.id !== 'psec-profile') return;
    try {
      const u = localStorage.getItem('ss_last_uid');
      const cp = u
        ? (JSON.parse(localStorage.getItem('profile_cache_' + u) || 'null') as Record<
            string,
            unknown
          > | null)
        : null;
      if (cp && cp.full_name && typeof applyProfile === 'function') applyProfile(cp);
    } catch {
      /* corrupted cache — ignore */
    }
  });
} catch {
  /* bus not ready — ignore */
}

function _applyCachedCoursesNow(): void {
  if (_cpCached && _cpCached.courses && typeof _loadUserCourses === 'function') {
    _loadUserCourses(_cpCached.courses);
  }
}
_applyCachedCoursesNow();
renderCourses();
renderTT();
renderMails();

// ── Theme transition: radial ripple from click origin ────────────────────
function _applyTheme(toNight: boolean, originEl?: Element): void {
  const rect = originEl
    ? originEl.getBoundingClientRect()
    : ({
        left: window.innerWidth / 2,
        top: window.innerHeight / 2,
        width: 0,
        height: 0,
      } as DOMRect);
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  function _commitTheme(): void {
    nightOn = !!toNight;
    Store.setState({ settings: { ...Store.getState().settings, darkMode: nightOn } });
    document.body.classList.toggle('night', nightOn);
    const nbIcon = document.getElementById('nightIcon');
    if (nbIcon) {
      nbIcon.textContent = toNight ? '🌙' : '☀️';
      const nbLbl = document.getElementById('nightLabel');
      if (nbLbl) nbLbl.textContent = toNight ? 'Night' : 'Day';
    }
    const dm = document.getElementById('settingsDarkMode') as HTMLInputElement | null;
    if (dm) dm.checked = nightOn;
    localStorage.setItem('ss_dark', nightOn ? '1' : '0');
    saveState();
  }

  if (!document.startViewTransition) {
    _commitTheme();
    return;
  }
  const transition = document.startViewTransition(_commitTheme);
  transition.ready.then(() => {
    const endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );
    document.documentElement.animate(
      {
        clipPath: [
          'circle(0px at ' + x + 'px ' + y + 'px)',
          'circle(' + endRadius + 'px at ' + x + 'px ' + y + 'px)',
        ],
      },
      { duration: 500, easing: 'ease-in-out', pseudoElement: '::view-transition-new(root)' }
    );
  });
}
window._applyTheme = _applyTheme;

_bindIf('nightBtn', 'click', function (this: HTMLElement) {
  _applyTheme(!Store.getState().settings.darkMode, this);
});

// ── Mobile hamburger menu ─────────────────────────────────────────────────
(function (): void {
  const ham = document.getElementById('portalHamburger');
  const scrim = document.getElementById('mobScrim');
  const sb = document.querySelector<HTMLElement>('#portal .sidebar');
  if (!ham || !scrim || !sb) return;
  function openMobSb(ev?: Event): void {
    ev?.preventDefault();
    sb!.classList.add('mob-open');
    scrim!.classList.add('show');
    ham!.setAttribute('aria-expanded', 'true');
  }
  function closeMobSb(ev?: Event): void {
    ev?.preventDefault();
    sb!.classList.remove('mob-open');
    scrim!.classList.remove('show');
    ham!.setAttribute('aria-expanded', 'false');
  }
  function bindTap(el: HTMLElement, fn: (ev: Event) => void): void {
    el.addEventListener('click', fn);
    el.addEventListener('pointerup', fn);
    el.addEventListener('touchend', fn, { passive: false });
  }
  bindTap(ham, openMobSb);
  bindTap(scrim, closeMobSb);
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeMobSb();
  });
  sb.addEventListener('click', (e: Event) => {
    const target = e.target as Element | null;
    if (window.innerWidth <= 768 && target && target.closest('.sb-item')) closeMobSb();
  });
})();

// ── Sidebar expand / collapse toggle ──────────────────────────────────────
// Click-to-expand (hover-expand was removed). State is sticky across reloads
// and restored without animating so the rail never grows on its own.
(function (): void {
  const sb = document.querySelector<HTMLElement>('#portal .sidebar');
  const btn = document.getElementById('sbToggle');
  if (!sb || !btn) return;
  const KEY = 'ss_sb_expanded';

  // Collapsed rail shows icons only, so give each nav item a native tooltip
  // (hover-to-expand is gone — this keeps the icons discoverable).
  sb.querySelectorAll<HTMLElement>('.sb-item').forEach((item) => {
    if (item.title) return;
    const label = item.querySelector('span:not(.sb-item-badge)')?.textContent?.trim();
    if (label) item.title = label;
  });

  function setExpanded(on: boolean, animate = true): void {
    // Skip transitions when restoring saved state on load, so the rail never
    // auto-grows on its own — only a deliberate click animates.
    if (!animate) sb!.classList.add('sb-no-anim');
    sb!.classList.toggle('expanded', on);
    btn!.setAttribute('aria-expanded', on ? 'true' : 'false');
    btn!.setAttribute('aria-label', on ? 'Collapse sidebar' : 'Expand sidebar');
    btn!.setAttribute('title', on ? 'Collapse menu' : 'Expand menu');
    if (!animate) {
      void sb!.offsetWidth; // force reflow so the class change applies instantly
      sb!.classList.remove('sb-no-anim');
    }
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* storage may be blocked — toggle still works for the session */
    }
  }

  setExpanded(localStorage.getItem(KEY) === '1', false);
  btn.addEventListener('click', () => setExpanded(!sb!.classList.contains('expanded')));
})();

// Accessible singleton tooltip for the compact sidebar. A fixed element avoids
// clipping by the scrollable navigation column and never adds icon containers.
(function (): void {
  const sidebar = document.querySelector<HTMLElement>('#portal .sidebar');
  if (!sidebar) return;
  const targets = Array.from(
    sidebar.querySelectorAll<HTMLElement>('.sb-item, .sb-toggle, .sb-user, .sb-night-btn')
  );
  const tooltip = document.createElement('div');
  tooltip.id = 'sidebarTooltip';
  tooltip.className = 'sb-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.appendChild(tooltip);
  let timer: number | null = null;
  let active: HTMLElement | null = null;

  function labelFor(target: HTMLElement): string {
    if (target.classList.contains('sb-toggle')) {
      return sidebar!.classList.contains('expanded') ? 'Collapse sidebar' : 'Expand sidebar';
    }
    if (target.classList.contains('sb-user')) return 'Profile';
    if (target.classList.contains('sb-night-btn')) {
      return document.body.classList.contains('night') ? 'Light mode' : 'Night mode';
    }
    return (
      target.querySelector<HTMLElement>('span[data-i18n], span:not(.sb-item-badge)')?.textContent?.trim() ||
      target.getAttribute('aria-label') ||
      ''
    );
  }

  function hide(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    active?.removeAttribute('aria-describedby');
    active = null;
    tooltip.classList.remove('is-visible');
    tooltip.hidden = true;
  }

  function show(target: HTMLElement): void {
    if (sidebar!.classList.contains('expanded') || window.innerWidth <= 768) return;
    hide();
    timer = window.setTimeout(() => {
      const label = labelFor(target);
      if (!label || sidebar!.classList.contains('expanded')) return;
      active = target;
      target.setAttribute('aria-label', label);
      tooltip.textContent = label;
      tooltip.hidden = false;
      const rect = target.getBoundingClientRect();
      const top = Math.min(window.innerHeight - 18, Math.max(18, rect.top + rect.height / 2));
      tooltip.style.left = `${Math.round(rect.right + 10)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
      target.setAttribute('aria-describedby', tooltip.id);
      requestAnimationFrame(() => tooltip.classList.add('is-visible'));
      timer = null;
    }, 200);
  }

  targets.forEach((target) => {
    const label = labelFor(target);
    if (label) target.setAttribute('aria-label', label);
    target.removeAttribute('title');
    if (!/^(BUTTON|A)$/.test(target.tagName)) {
      target.setAttribute('role', 'button');
      target.tabIndex = 0;
      target.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          target.click();
        }
      });
    }
    target.addEventListener('pointerenter', () => show(target));
    target.addEventListener('pointerleave', hide);
    target.addEventListener('focus', () => show(target));
    target.addEventListener('blur', hide);
    target.addEventListener('click', hide);
  });
  sidebar.addEventListener('transitionstart', hide);
  window.addEventListener('resize', hide);
  window.addEventListener('scroll', hide, true);
})();

// Compact PDF toolbar: the existing page/zoom/fullscreen controls are reused
// in the floating collapsed pill, so their state and listeners stay canonical.
(function (): void {
  const toolbar = document.getElementById('pdfToolbar');
  const toggle = document.getElementById('pdfToolbarCollapse');
  const dragHandle = document.getElementById('pdfToolbarDragHandle');
  const pdfView = document.getElementById('pdfView');
  if (!toolbar || !toggle || !dragHandle || !pdfView) return;
  const toolbarEl = toolbar;
  const toggleEl = toggle;
  const dragHandleEl = dragHandle;
  const pdfViewEl = pdfView;

  function bounds(): { left: number; right: number; top: number; bottom: number } {
    const sidebar = document.querySelector<HTMLElement>('#portal .sidebar');
    const sidebarRight = sidebar?.getBoundingClientRect().right || 0;
    const rect = toolbarEl.getBoundingClientRect();
    const gap = 10;
    const left = Math.max(gap, sidebarRight + gap);
    return {
      left,
      right: Math.max(left, window.innerWidth - rect.width - gap),
      top: gap,
      bottom: Math.max(gap, window.innerHeight - rect.height - gap)
    };
  }

  function place(left: number, top: number): void {
    const limit = bounds();
    toolbarEl.style.left = `${Math.round(Math.min(limit.right, Math.max(limit.left, left)))}px`;
    toolbarEl.style.top = `${Math.round(Math.min(limit.bottom, Math.max(limit.top, top)))}px`;
    toolbarEl.style.right = 'auto';
  }

  function keepClearOfSidebar(): void {
    if (!toolbarEl.classList.contains('is-collapsed')) return;
    const rect = toolbarEl.getBoundingClientRect();
    place(rect.left, rect.top);
  }

  function setCollapsed(collapsed: boolean): void {
    toolbarEl.classList.toggle('is-collapsed', collapsed);
    toggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleEl.setAttribute('aria-label', collapsed ? 'Expand PDF toolbar' : 'Collapse PDF toolbar');
    toggleEl.setAttribute('title', collapsed ? 'Expand toolbar' : 'Collapse toolbar');
    if (!collapsed) {
      toolbarEl.style.removeProperty('left');
      toolbarEl.style.removeProperty('top');
      toolbarEl.style.removeProperty('right');
    }
  }

  toggleEl.addEventListener('click', () => setCollapsed(!toolbarEl.classList.contains('is-collapsed')));
  dragHandleEl.addEventListener('pointerdown', (event: PointerEvent) => {
    if (!toolbarEl.classList.contains('is-collapsed')) return;
    event.preventDefault();
    dragHandleEl.setPointerCapture(event.pointerId);
    const start = toolbarEl.getBoundingClientRect();
    const offsetX = event.clientX - start.left;
    const offsetY = event.clientY - start.top;
    toolbarEl.classList.add('is-dragging');

    const move = (moveEvent: PointerEvent): void => {
      place(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
    };
    const finish = (): void => {
      dragHandleEl.removeEventListener('pointermove', move);
      dragHandleEl.removeEventListener('pointerup', finish);
      dragHandleEl.removeEventListener('pointercancel', finish);
      toolbarEl.classList.remove('is-dragging');
      const rect = toolbarEl.getBoundingClientRect();
      const limit = bounds();
      const distances = [
        { edge: 'left', value: Math.abs(rect.left - limit.left) },
        { edge: 'right', value: Math.abs(rect.left - limit.right) },
        { edge: 'top', value: Math.abs(rect.top - limit.top) },
        { edge: 'bottom', value: Math.abs(rect.top - limit.bottom) }
      ].sort((a, b) => a.value - b.value);
      const edge = distances[0]?.edge;
      place(
        edge === 'left' ? limit.left : edge === 'right' ? limit.right : rect.left,
        edge === 'top' ? limit.top : edge === 'bottom' ? limit.bottom : rect.top
      );
    };
    dragHandleEl.addEventListener('pointermove', move);
    dragHandleEl.addEventListener('pointerup', finish);
    dragHandleEl.addEventListener('pointercancel', finish);
  });
  window.addEventListener('resize', keepClearOfSidebar);
  const sidebar = document.querySelector<HTMLElement>('#portal .sidebar');
  if (sidebar && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(keepClearOfSidebar).observe(sidebar);
  }
  new MutationObserver(() => {
    if (pdfViewEl.style.display !== 'none') setCollapsed(false);
  }).observe(pdfViewEl, { attributes: true, attributeFilter: ['style'] });
})();

// Dashboard cards
_bindIf('pcStudip', 'click', () => {
  const resumed = _showStudipResume();
  if (!resumed) {
    // Push history directly (bypassing _ssPushHistory's _ssRestoring bail),
    // and write ss_portal_tab + ss_last_section so a refresh restores Courses.
    // Mirrors the _finalizeNav helper in router.js for non-Courses sidebar items.
    try {
      sessionStorage.setItem('ss_portal_tab', 'studip');
      localStorage.setItem('ss_last_section', 'studip');
    } catch { /* ignore */ }
    try {
      // Bug 3 fix: guard against duplicate history entries when the hash is
      // already #portal=courses (e.g. clicking the sidebar item twice).
      if (location.hash !== '#portal=courses') {
        history.pushState({ view: 'portal', section: 'studip' }, '', '#portal=courses');
      }
    } catch { /* ignore */ }
  }
});
_bindIf('pcMail', 'click', () => window.open('https://mail.tu-braunschweig.de', '_blank'));
_bindIf('pcConnect', 'click', () => window.open('https://connect.tu-braunschweig.de', '_blank'));
_bindIf('pcTT', 'click', () => window.open('https://connect.tu-braunschweig.de', '_blank'));
_bindIf('pcCert', 'click', () => window.open('https://connect.tu-braunschweig.de', '_blank'));
_bindIf('pcWeb', 'click', () => window.open('https://www.tu-braunschweig.de', '_blank'));

// Auth bridge
const _authBridge = initAuthBridge({
  sb: _sb as Parameters<typeof initAuthBridge>[0]['sb'],
  t: _t,
  getCurrentUser: () => _currentUser,
  verifyAndEnter: (token: string) => _verifyAndEnter(token) as Promise<void> | void,
  enterApp: (user: unknown) => { _enterApp(user); },
  resetActivityTimer: () => { _resetActivityTimer(); },
});

// (Unused locals retained for parity with the JS source.)
void copyBubble; void fallbackCopy; void regenMsg;

initSettingsBridge();

initLandingAuthBridge({ authBridge: _authBridge });

// ── Subscription service ─────────────────────────────────────────────────
(window as unknown as { _subService: Record<string, unknown> })._subService = {
  createCheckoutSession: _createCheckoutSession,
  createPortalSession: _createPortalSession,
  pauseSubscription: _pauseSubscription,
  resumeSubscription: _resumeSubscription,
  cancelSubscription: _cancelSubscription,
  reactivateSubscription: _reactivateSubscription,
  applyRetentionDiscount: _applyRetentionDiscount,
  verifyPayment: _verifyPayment,
  activatePayPalSubscription: _activatePayPalSubscription,
  loadBillingConfig: _loadBillingConfig,
};

interface MinalloMarker {
  markReady: (event: string, payload: unknown) => void;
  emit: (event: string, payload: unknown) => void;
}
const _Minallo = (window as unknown as { Minallo?: MinalloMarker }).Minallo;
if (_Minallo) {
  _Minallo.markReady('app-js-evaluated', {});
  _Minallo.emit('app:script-evaluated', {});
}
