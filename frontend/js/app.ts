// Minallo app.ts — entry orchestrator. Wires bridges, exposes legacy globals,
// owns the app-level mutable state (active course/file, pdf scale, etc.).

import { escapeHtml } from './utils/escape-html.js';
import { Store } from './core/state.js';
import { exposeLegacyVar, publishLegacyGlobals } from './core/globals.js';
import { initStatePersistence } from './core/state-persistence.js';
import { bindIf as _bindIf } from './core/portal-ui.js';
import { initSettingsBridge, t as _t } from './features/settings/settings-bridge.js';
import { initLandingAuthBridge } from './features/auth/landing-auth-bridge.js';
import { initAiRenderBridge } from './features/ai-chat/ai-render-bridge.js';
import { initAiExportBridge } from './features/ai-chat/ai-export-bridge.js';
import { initAiAskBridge } from './features/ai-chat/ai-ask-bridge.js';
import { initAiChipsBridge } from './features/ai-chat/ai-chips-bridge.js';
import { initAiConfettiBridge, spawnConfetti } from './features/ai-chat/ai-confetti-bridge.js';
import { initAiPanelEffects } from './features/ai-chat/ai-panel-effects.js';
import { initAiPanelBridge } from './features/ai-chat/ai-panel-bridge.js';
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
import { runMultiSummary as _runMultiSummary } from './features/ai-chat/multi-summary.js';
import {
  createCheckoutSession as _createCheckoutSession,
  createPortalSession as _createPortalSession,
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
let askAI: (q: string, skipUserBubble?: boolean, opts?: { forceRefresh?: boolean }) => unknown =
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
function showPortal(): void { _showPortal(); }
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
(window as unknown as { sdActiveSemId: string }).sdActiveSemId = sdActiveSemId;
exposeLegacyVar('sdActiveSemId', () => sdActiveSemId, (v: string) => {
  sdActiveSemId = v;
  (window as unknown as { sdActiveSemId: string }).sdActiveSemId = v;
});

initCourseSearch({
  getUserMajor: () => _userMajor,
  getUserVertiefung: () => _userVertiefung,
  getSubjectList: () => SUBJECT_LIST,
  getSems: () => SEMS,
  getActiveSemesterId: () => sdActiveSemId,
  saveUserCourses: () => { _saveUserCourses(); },
  renderCourses: () => { sdRenderCourses(); },
});

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
    if (sid) sdActiveSemId = sid;
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
  return _runMultiSummary(fnames, course as unknown as Parameters<typeof _runMultiSummary>[1]);
}
(window as unknown as { runMultiSummary: typeof runMultiSummary }).runMultiSummary = runMultiSummary;

// Expose for the typing IIFE / setters above
exposeLegacyVar('msmCurrentText', () => msmCurrentText, (v: string) => { msmCurrentText = v; });
exposeLegacyVar('msmCurrentTitle', () => msmCurrentTitle, (v: string) => { msmCurrentTitle = v; });

// ── PDF ───────────────────────────────────────────────────────────────────
function updateZoomPct(): void {
  const el = document.getElementById('pdfZoomPct');
  if (el) el.textContent = Math.round(pdfScale * 100) + '%';
}

document.getElementById('pdfBody')?.addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 3) showSelectionBanner(sel.toString().trim());
  }, 30);
});

let _pdfScrollTimer: ReturnType<typeof setTimeout> | null = null;
document.getElementById('pdfBody')?.addEventListener('scroll', () => {
  if (!pdfShowAll) return;
  if (_pdfScrollTimer) clearTimeout(_pdfScrollTimer);
  _pdfScrollTimer = setTimeout(updatePageInfo, 80);
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
      pdfShowAll = false;
      updatePageInfo();
      renderPages();
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

document.getElementById('pdfZoomIn')?.addEventListener('click', () => {
  const pg = _pdfVisiblePage();
  pdfScale = Math.min(Math.round((pdfScale + 0.1) * 10) / 10, 3);
  updateZoomPct();
  renderPages();
  setTimeout(() => _pdfScrollToPage(pg), 120);
});
document.getElementById('pdfZoomOut')?.addEventListener('click', () => {
  const pg = _pdfVisiblePage();
  pdfScale = Math.max(Math.round((pdfScale - 0.1) * 10) / 10, 0.2);
  updateZoomPct();
  renderPages();
  setTimeout(() => _pdfScrollToPage(pg), 120);
});
document.getElementById('pdfFit')?.addEventListener('click', () => {
  const pg = _pdfVisiblePage();
  pdfScale = 0.9;
  updateZoomPct();
  renderPages();
  setTimeout(() => _pdfScrollToPage(pg), 120);
});
document.getElementById('pdfDownload')?.addEventListener('click', () => {
  if (activeFileName) downloadFile(activeFileName);
});
document.getElementById('pdfBack')?.addEventListener('click', () => {
  const w = window as unknown as {
    activeCourseRef?: { id?: string } & Record<string, unknown>;
    showCourseSection?: (course: unknown, section: string) => void;
    showPortalSection?: (section: string) => void;
  };
  if (w.activeCourseRef && typeof w.showCourseSection === 'function') {
    w.showCourseSection(w.activeCourseRef, 'files');
    return;
  }
  if (typeof w.showPortalSection === 'function') w.showPortalSection('courses');
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

initAiRenderBridge();
initAiPanelEffects({ aiMsgs, aiPanel });
const _aiPanelBridge = initAiPanelBridge({
  aiPanel, aiClose: document.getElementById('aiClose'), aiMsgs,
  t: _t, escapeHtml,
  askAI: (prompt: string) => askAI(prompt),
  getAiPinned: () => aiPinned,
  setAiPinned: (v: boolean) => { aiPinned = v; },
  getAiOpen: () => aiOpen,
  setAiOpen: (v: boolean) => { aiOpen = v; },
});
openAI = _aiPanelBridge.openAI;
closeAI = _aiPanelBridge.closeAI;
forceCloseAI = _aiPanelBridge.forceCloseAI;
pinAI = _aiPanelBridge.pinAI;
showSelectionBanner = _aiPanelBridge.showSelectionBanner;

(window as unknown as { _aiPanelBridge: typeof _aiPanelBridge })._aiPanelBridge = _aiPanelBridge;
(window as unknown as { _aiMsgs: HTMLElement | null })._aiMsgs = aiMsgs;
window.openAI = openAI;
(window as unknown as { closeAI: typeof closeAI }).closeAI = closeAI;
window.forceCloseAI = forceCloseAI;
window.pinAI = pinAI;
window.showSelectionBanner = showSelectionBanner;

initAiExportBridge();

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

const _aiAskBridge = initAiAskBridge(_aiState as unknown as Parameters<typeof initAiAskBridge>[0]);
askAI = _aiAskBridge.askAI as typeof askAI;

initAiChipsBridge();
initAiConfettiBridge();

// Apply cached profile & courses instantly before auth completes
(function (): void {
  try {
    const lastUid = localStorage.getItem('ss_last_uid');
    if (!lastUid) return;
    const cp = JSON.parse(localStorage.getItem('profile_cache_' + lastUid) || 'null');
    if (cp) {
      if (cp.full_name && typeof applyProfile === 'function') applyProfile(cp);
      if (cp.courses && typeof _loadUserCourses === 'function') _loadUserCourses(cp.courses);
    }
  } catch { /* corrupted cache */ }
})();
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
  function openMobSb(): void { sb!.classList.add('mob-open'); scrim!.classList.add('show'); }
  function closeMobSb(): void { sb!.classList.remove('mob-open'); scrim!.classList.remove('show'); }
  ham.addEventListener('click', openMobSb);
  scrim.addEventListener('click', closeMobSb);
  sb.addEventListener('click', (e: Event) => {
    const target = e.target as Element | null;
    if (window.innerWidth <= 768 && target && target.closest('.sb-item')) closeMobSb();
  });
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
      history.pushState({ view: 'portal', section: 'studip' }, '', '#portal=courses');
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
