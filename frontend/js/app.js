// StudySphere app.js ? build 1774335018 ? async fixes

import { escapeHtml } from './utils/escape-html.js';
import { Store } from './core/state.js';
import { exposeLegacyVar, publishLegacyGlobals } from './core/globals.js';
import { initStatePersistence } from './core/state-persistence.js';
import { bindIf as _bindIf, initPortalUi } from './core/portal-ui.js';
import { initSettingsBridge, t as _t } from './features/settings/settings-bridge.js';
import { initLandingAuthBridge } from './features/auth/landing-auth-bridge.js';
import { initAiRenderBridge } from './features/ai-chat/ai-render-bridge.js';
import { initAiExportBridge } from './features/ai-chat/ai-export-bridge.js';
import { initAiAskBridge } from './features/ai-chat/ai-ask-bridge.js';
import { initAiChipsBridge } from './features/ai-chat/ai-chips-bridge.js';
import { initAiConfettiBridge, spawnConfetti } from './features/ai-chat/ai-confetti-bridge.js';
import { initAiPanelEffects } from './features/ai-chat/ai-panel-effects.js';
import { initAiPanelBridge } from './features/ai-chat/ai-panel-bridge.js';
import { initSemesterDropdown } from './features/courses/semester-dropdown.js';
import { initPdfControls } from './features/pdf-viewer/pdf-controls.js';

var PDF_DATA = {
  'Aufgabe_1_3.pdf': 'assets/Aufgabe_1_3.pdf'
};

// ── GLOBAL FUNCTIONS (accessible from inline onclick) ─────────────────────

// copyBubble / fallbackCopy / regenMsg / addBotMsg / addUserMsg / _setAiChipsVisible → features/ai-chat/ai-message-actions.js
import {
  copyBubble as _copyBubble,
  fallbackCopy as _fallbackCopy,
  regenMsg as _regenMsg,
  addBotMsg as _addBotMsg,
  addUserMsg as _addUserMsg,
  setAiChipsVisible as _setAiChipsVisible_
} from './features/ai-chat/ai-message-actions.js';
function copyBubble(btn) {
  _copyBubble(btn);
}
function fallbackCopy(text) {
  _fallbackCopy(text);
}
function regenMsg(btn) {
  _regenMsg(btn);
}
function _setAiChipsVisible(v) {
  _setAiChipsVisible_(v);
}
window.copyBubble = copyBubble;
window.regenMsg = regenMsg;
window.addBotMsg = function (text) {
  return _addBotMsg(text);
};
window.addUserMsg = function (text) {
  return _addUserMsg(text);
};
window._setAiChipsVisible = _setAiChipsVisible;

// ── GLOBAL STUBS (reassigned in DOMContentLoaded) ────────────────────────
var askAI = function (q, s) {
  console.warn('AI not ready yet');
};
var stopGeneration = function () {};
var openAI = function () {};
var closeAI = function () {};
var forceCloseAI = function () {};
var pinAI = function () {};
var showSelectionBanner = function () {};

// ── NIGHT MODE (global — referenced by supabase.js before DOMContentLoaded) ──
var nightOn = Store.getState().settings.darkMode;
(function () {
  document.body.classList.toggle('night', nightOn);
})();

// deferredSave declared globally so ss-ready can wrap it
var deferredSave = function () {};
window.deferredSave = deferredSave;

// Router stubs are replaced by js/router.js after app.js loads.
var _ssHandlingPop = false;
var _ssRestoring = false;
var _pendingPortalRestore = null;
function _ssPushHistory() {}
function _ssReplaceHistory() {}

// _showFilesView / _hideFilesView → core/panels.js (imported above in navigation block)

// ── NAVIGATION + PANEL FUNCTIONS → core/navigation.js + core/panels.js ───────
import {
  showPortal as _showPortal,
  showStudip as _showStudip,
  hideStudip as _hideStudip,
  setNavActive as _setNavActive,
  showPortalSection as _showPortalSection,
  navTo as _navToImpl
} from './core/navigation.js';
import {
  showFilesView as _showFilesView,
  hideFilesView as _hideFilesView,
  panelShow as _panelShow,
  panelHide as _panelHide
} from './core/panels.js';
window._showFilesView = function () {
  _showFilesView();
};

function showStudip() {
  _showStudip();
}
function showPortal() {
  _showPortal();
}
function hideStudip() {
  _hideStudip(typeof _stRunning !== 'undefined' ? _stRunning : false);
}
function showApp() {
  showStudip();
  _ssReplaceHistory({ view: 'studip' }, '#studip');
}
function setNavActive(id) {
  _setNavActive(id);
}
function showPortalSection(sec) {
  _showPortalSection(sec);
}
window.showPortalSection = showPortalSection;
window.showPortal = showPortal;
window.showStudip = showStudip;
window.hideStudip = hideStudip;
window.setNavActive = setNavActive;
function _navTo(navId, sec) {
  _navToImpl(navId, sec);
}

function openSB() {}
function closeSB() {}

// showToast — moved to features/toast/toast.js

var saveState = function () {};
window.saveState = function () {
  return saveState();
};

var _statePersistence = null;
var restoreState = function () {
  return _statePersistence && _statePersistence.restoreState();
};

import {
  renderCourses as _renderCourses,
  sdRenderCourses as _sdRenderCourses
} from './features/courses/courses-render.js';
import { initCourseSearch } from './features/courses/course-search.js';
import { initAuthBridge } from './features/auth/auth-bridge.js';
function renderCourses() {
  _renderCourses({ SEMS, COLORS, activeSemId, activeCourseId, _cameFromStudip });
}
function sdRenderCourses() {
  _sdRenderCourses({ SEMS, COLORS, sdActiveSemId });
}
window.renderCourses = renderCourses;
window.sdRenderCourses = sdRenderCourses;

function renderTT() {}
function renderMails() {}

// ── Folder picker popup ───────────────────────────────────────────────────
// _showFolderPickerPopup → features/courses/course-folders.js

// (user storage functions → js/app-storage.js)

// openCourse / showCourseSection → features/courses/course-view.js
import {
  openCourse as _openCourse,
  showCourseSection as _showCourseSection
} from './features/courses/course-view.js?v=7';
window.openCourse = _openCourse;
window.showCourseSection = _showCourseSection;

// _showFolderPickerPopup → features/courses/course-folders.js
import { showFolderPickerPopup as _showFolderPickerPopup_ } from './features/courses/course-folders.js?v=5';
window._showFolderPickerPopup = _showFolderPickerPopup_;

// _fetchPdfBytes / downloadFile / openFile → services/pdf-service.js + features/pdf-viewer/pdf-viewer.js
import {
  fetchPdfBytes as _fetchPdfBytes_,
  downloadFile as _downloadFile
} from './services/pdf-service.js';
import { openFile as _openFile } from './features/pdf-viewer/pdf-viewer.js';
function _fetchPdfBytes(path, cb, onError) {
  _fetchPdfBytes_(path, cb, onError);
}
function openFile(f, course) {
  _openFile(f, course);
}
function downloadFile(fname) {
  return _downloadFile(fname);
}
window._fetchPdfBytes = _fetchPdfBytes;
window.openFile = openFile;
window.downloadFile = downloadFile;

// openFile body → features/pdf-viewer/pdf-viewer.js
// showCourseSection body → features/courses/course-view.js

// (PDF viewer + annotation engine → js/app-pdf.js)

// ── INIT ─────────────────────────────────────────────────────────────────────

// (COLORS, SEMS, MAJOR_LIST, SUBJECT_LIST → js/app-data.js)

// ── STATE ──────────────────────────────────────────────────────────────────
var activeSemId = 'ws2526',
  activeCourseId = null,
  activeFileName = null,
  currentCourseShort = '';
var pdfDoc = null,
  pdfPage = 1,
  pdfTotal = 0,
  pdfScale = 0.9,
  pdfShowAll = false,
  pdfFullText = '';
var _pdfOpenSeq = 0;
var _courseOpenSeq = 0;
var aiOpen = false,
  aiPinned = false,
  sbOpen = false,
  sbHideTimer = null;
var _openFolders = new Set(); // folder names currently expanded in the files section
var BACKEND_URL = ''; // Netlify Function at /api/ai (same origin — no CORS, no sleeping)
var _MATH_PROMPT = '';
var activeTypeTimer = null,
  activeThinkTimer = null,
  generationStopped = false,
  currentGenId = 0;
var activeCourseRef = null,
  activeCourseSection = 'files';
var activePortalSection = 'dashboard';
var ddOpen = false;
var _cameFromStudip = false;
var _lang = localStorage.getItem('ss_lang') || 'en';

_statePersistence = initStatePersistence({
  getActiveSemId: function () {
    return activeSemId;
  },
  getActiveCourseId: function () {
    return activeCourseId;
  },
  getActiveFileName: function () {
    return activeFileName;
  },
  getActiveCourseSection: function () {
    return activeCourseSection || 'files';
  },
  getSems: function () {
    return window.SEMS;
  },
  getCurrentUser: function () {
    return window._currentUser;
  },
  setActiveSemId: function (v) {
    activeSemId = v;
  },
  setActiveCourseId: function (v) {
    activeCourseId = v;
  },
  setSsRestoring: function (v) {
    _ssRestoring = !!v;
  },
  setPendingPortalRestore: function (v) {
    _pendingPortalRestore = v;
  },
  setPendingRestoreCourse: function (v) {
    window._pendingRestoreCourse = v;
  },
  showFilesView: function () {
    _showFilesView();
  },
  showPortal: function () {
    showPortal();
  },
  showPortalSection: function (s) {
    showPortalSection(s);
  },
  setNavActive: function (id) {
    setNavActive(id);
  },
  renderCourses: function () {
    renderCourses();
  },
  panelShow: function (el) {
    _panelShow(el);
  },
  panelHide: function (el) {
    _panelHide(el);
  },
  showCourseSection: function (c, s) {
    _showCourseSection(c, s);
  }
});
saveState = _statePersistence.saveState;
window._lang = _lang;

exposeLegacyVar(
  'activeSemId',
  function () {
    return activeSemId;
  },
  function (v) {
    activeSemId = v;
  }
);
exposeLegacyVar(
  'activeCourseId',
  function () {
    return activeCourseId;
  },
  function (v) {
    activeCourseId = v;
  }
);
exposeLegacyVar(
  'activeFileName',
  function () {
    return activeFileName;
  },
  function (v) {
    activeFileName = v;
  }
);
exposeLegacyVar(
  'currentCourseShort',
  function () {
    return currentCourseShort;
  },
  function (v) {
    currentCourseShort = v;
  }
);
exposeLegacyVar(
  '_pdfOpenSeq',
  function () {
    return _pdfOpenSeq;
  },
  function (v) {
    _pdfOpenSeq = v;
  }
);
exposeLegacyVar(
  'pdfDoc',
  function () {
    return pdfDoc;
  },
  function (v) {
    pdfDoc = v;
  }
);
exposeLegacyVar(
  'pdfPage',
  function () {
    return pdfPage;
  },
  function (v) {
    pdfPage = v;
  }
);
exposeLegacyVar(
  'pdfTotal',
  function () {
    return pdfTotal;
  },
  function (v) {
    pdfTotal = v;
  }
);
exposeLegacyVar(
  'pdfScale',
  function () {
    return pdfScale;
  },
  function (v) {
    pdfScale = v;
  }
);
exposeLegacyVar(
  'pdfShowAll',
  function () {
    return pdfShowAll;
  },
  function (v) {
    pdfShowAll = v;
  }
);
exposeLegacyVar(
  'pdfFullText',
  function () {
    return pdfFullText;
  },
  function (v) {
    pdfFullText = v;
  }
);
exposeLegacyVar(
  'activeTypeTimer',
  function () {
    return activeTypeTimer;
  },
  function (v) {
    activeTypeTimer = v;
  }
);
exposeLegacyVar(
  'activeThinkTimer',
  function () {
    return activeThinkTimer;
  },
  function (v) {
    activeThinkTimer = v;
  }
);
exposeLegacyVar(
  'generationStopped',
  function () {
    return generationStopped;
  },
  function (v) {
    generationStopped = v;
  }
);
exposeLegacyVar(
  'currentGenId',
  function () {
    return currentGenId;
  },
  function (v) {
    currentGenId = v;
  }
);
exposeLegacyVar(
  'activeCourseRef',
  function () {
    return activeCourseRef;
  },
  function (v) {
    activeCourseRef = v;
  }
);
exposeLegacyVar(
  'activeCourseSection',
  function () {
    return activeCourseSection;
  },
  function (v) {
    activeCourseSection = v;
  }
);
exposeLegacyVar(
  'activePortalSection',
  function () {
    return activePortalSection;
  },
  function (v) {
    activePortalSection = v;
  }
);
exposeLegacyVar(
  '_cameFromStudip',
  function () {
    return _cameFromStudip;
  },
  function (v) {
    _cameFromStudip = v;
  }
);
exposeLegacyVar(
  '_lang',
  function () {
    return _lang;
  },
  function (v) {
    _lang = v === 'de' ? 'de' : 'en';
  }
);
exposeLegacyVar(
  'nightOn',
  function () {
    return nightOn;
  },
  function (v) {
    nightOn = !!v;
  }
);
exposeLegacyVar(
  '_ssHandlingPop',
  function () {
    return _ssHandlingPop;
  },
  function (v) {
    _ssHandlingPop = !!v;
  }
);
exposeLegacyVar(
  '_ssRestoring',
  function () {
    return _ssRestoring;
  },
  function (v) {
    _ssRestoring = !!v;
  }
);
exposeLegacyVar(
  '_pendingPortalRestore',
  function () {
    return _pendingPortalRestore;
  },
  function (v) {
    _pendingPortalRestore = v;
  }
);
exposeLegacyVar(
  'deferredSave',
  function () {
    return deferredSave;
  },
  function (v) {
    if (typeof v === 'function') deferredSave = v;
  }
);
publishLegacyGlobals({
  showStudip: showStudip,
  showPortal: showPortal,
  hideStudip: hideStudip,
  showApp: showApp,
  setNavActive: setNavActive,
  showPortalSection: showPortalSection,
  _navTo: _navTo,
  _bindIf: _bindIf,
  _showFilesView: _showFilesView,
  _hideFilesView: _hideFilesView,
  saveState: saveState,
  restoreState: restoreState,
  forceCloseAI: forceCloseAI,
  closeAI: closeAI,
  openAI: openAI,
  spawnConfetti: spawnConfetti,
  renderCourses: renderCourses,
  sdRenderCourses: sdRenderCourses,
  renderTT: renderTT,
  renderMails: renderMails,
  _ssPushHistory: _ssPushHistory,
  _ssReplaceHistory: _ssReplaceHistory,
  deferredSave: deferredSave,
  BACKEND_URL: BACKEND_URL,
  _MATH_PROMPT: _MATH_PROMPT
});

// ── COURSES DASHBOARD ─────────────────────────────────────────────────────
var sdActiveSemId = 'ws2526';
window.sdActiveSemId = sdActiveSemId;
exposeLegacyVar(
  'sdActiveSemId',
  function () {
    return sdActiveSemId;
  },
  function (v) {
    sdActiveSemId = v;
    window.sdActiveSemId = v;
  }
);

// Course search / add subject logic
initCourseSearch({
  getUserMajor: function () {
    return _userMajor;
  },
  getUserVertiefung: function () {
    return _userVertiefung;
  },
  getSubjectList: function () {
    return SUBJECT_LIST;
  },
  getSems: function () {
    return SEMS;
  },
  getActiveSemesterId: function () {
    return sdActiveSemId;
  },
  saveUserCourses: function () {
    _saveUserCourses();
  },
  renderCourses: function () {
    sdRenderCourses();
  }
});

// Studip semester dropdown
var sdSemBtn = document.getElementById('sdSemBtn'),
  sdSemDD = document.getElementById('sdSemDD');
var sdSemDot = document.getElementById('sdSemDot'),
  sdSemLabel = document.getElementById('sdSemLabel'),
  sdSemChev = document.getElementById('sdSemChev');
var sdDdOpen = false;
sdSemBtn.addEventListener('click', function (e) {
  e.stopPropagation();
  sdDdOpen = !sdDdOpen;
  sdSemDD.classList.toggle('open', sdDdOpen);
  sdSemBtn.classList.toggle('open', sdDdOpen);
  sdSemChev.classList.toggle('up', sdDdOpen);
});
sdSemDD.querySelectorAll('.sem-opt').forEach(function (o) {
  o.addEventListener('click', function () {
    sdActiveSemId = o.getAttribute('data-sid');
    sdSemLabel.textContent = o.textContent.trim();
    sdSemDot.style.background = o.getAttribute('data-col');
    sdSemDD.querySelectorAll('.sem-opt').forEach(function (x) {
      x.classList.remove('sel');
    });
    o.classList.add('sel');
    sdDdOpen = false;
    sdSemDD.classList.remove('open');
    sdSemBtn.classList.remove('open');
    sdSemChev.classList.remove('up');
    sdRenderCourses();
  });
});
document.addEventListener('click', function (e) {
  if (sdDdOpen && !e.target.closest('#sdSemBtn') && !e.target.closest('#sdSemDD')) {
    sdDdOpen = false;
    sdSemDD.classList.remove('open');
    sdSemBtn.classList.remove('open');
    sdSemChev.classList.remove('up');
  }
});
// ── NAVIGATION ───────────────────────────────────────────────────────────
// Ghost-proof approach:
// 1. Body bg = same dark color as overlays — any bleed-through is invisible
// 2. The incoming page is shown at full opacity BEFORE the outgoing fades
//    so there's never a gap where the app is visible
// 3. z-index is adjusted so the visible page always sits on top

// _panelShow / _panelHide → core/panels.js (imported in navigation block)

// nav/portal listeners moved to ss-ready
// ── SIDEBAR ───────────────────────────────────────────────────────────────

// sidebar listeners moved to ss-ready

// Semester dropdown removed (sidebar removed)
function closeDD() {}

// ── NIGHT MODE ────────────────────────────────────────────────────────────
// nightOn is declared globally above DOMContentLoaded — sync the button here
(function () {
  var _bIcon = document.getElementById('nightIcon'); //
  if (_bIcon) _bIcon.textContent = Store.getState().settings.darkMode ? '🌙' : '☀️';
  var _bLbl = document.getElementById('nightLabel');
  if (_bLbl) _bLbl.textContent = Store.getState().settings.darkMode ? 'Night' : 'Day';
})();
// nightBtn listener moved to ss-ready

// ── COURSES ───────────────────────────────────────────────────────────────

// ── TIMETABLE ─────────────────────────────────────────────────────────────

// ── MAILS ─────────────────────────────────────────────────────────────────

// ── COURSE NAVIGATION ─────────────────────────────────────────────────────

function buildSbCourseNav() {}

// ── MULTI-FILE SUMMARY ────────────────────────────────────────────────────
var msmCurrentText = '';
var msmCurrentTitle = '';

(document.getElementById('msmClose') || { addEventListener: function () {} }).addEventListener(
  'click',
  function () {
    document.getElementById('multiSumModal').classList.remove('show');
  }
);
(document.getElementById('multiSumModal') || { addEventListener: function () {} }).addEventListener(
  'click',
  function (e) {
    if (e.target === this) this.classList.remove('show');
  }
);
(document.getElementById('msmSaveBtn') || { addEventListener: function () {} }).addEventListener(
  'click',
  async function () {
    if (!msmCurrentText) return;
    // Save to lecture notes (assign a stable id for DB sync)
    var note = {
      id: lnGenId(),
      title: msmCurrentTitle,
      text: msmCurrentText,
      date: new Date().toISOString(),
      url: ''
    };
    var summaries = lnSummaries.slice();
    summaries.unshift(note);
    lnRender(summaries);
    window.postMessage({ type: 'SS_DELETE_SUMMARY', summaries: summaries }, '*');
    document.getElementById('multiSumModal').classList.remove('show');
    showToast(_t('toast_saved'), msmCurrentTitle.slice(0, 50));
    // Persist to Supabase
    await lnSaveNoteToSupabase(note);
  }
);

// runMultiSummary → features/ai-chat/multi-summary.js
import { runMultiSummary as _runMultiSummary } from './features/ai-chat/multi-summary.js';
function runMultiSummary(fnames, course) {
  return _runMultiSummary(fnames, course);
}
window.runMultiSummary = runMultiSummary;

// downloadFile → services/pdf-service.js (re-exported below with fetchPdfBytes)

// ── PDF ───────────────────────────────────────────────────────────────────

function updateZoomPct() {
  var el = document.getElementById('pdfZoomPct');
  if (el) el.textContent = Math.round(pdfScale * 100) + '%';
}

(document.getElementById('pdfBody') || { addEventListener: function () {} }).addEventListener(
  'mouseup',
  function () {
    setTimeout(function () {
      var sel = window.getSelection();
      if (sel && sel.toString().trim().length > 3) showSelectionBanner(sel.toString().trim());
    }, 30);
  }
);

var _pdfScrollTimer = null;
(document.getElementById('pdfBody') || document.createElement('div')).addEventListener(
  'scroll',
  function () {
    if (!pdfShowAll) return;
    clearTimeout(_pdfScrollTimer);
    _pdfScrollTimer = setTimeout(updatePageInfo, 80);
  }
);
(document.getElementById('pdfPrev') || { addEventListener: function () {} }).addEventListener(
  'click',
  function () {
    if (pdfPage > 1) {
      pdfPage--;
      pdfShowAll = false;
      updatePageInfo();
      renderPages();
    }
  }
);
(document.getElementById('pdfNext') || { addEventListener: function () {} }).addEventListener(
  'click',
  function () {
    if (pdfPage < pdfTotal) {
      pdfPage++;
      pdfShowAll = false;
      updatePageInfo();
      renderPages();
    }
  }
);
(function () {
  var inp = document.getElementById('pdfPageInput');
  if (!inp) return;
  inp.addEventListener('focus', function () {
    this.select();
  });
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      this.blur();
      return;
    }
    if (e.key === 'Escape') {
      this.value = pdfShowAll ? _pdfVisiblePage() : pdfPage;
      this.blur();
    }
  });
  inp.addEventListener('blur', function () {
    var n = parseInt(this.value, 10);
    if (n >= 1 && n <= pdfTotal && pdfTotal > 0) {
      pdfPage = n;
      pdfShowAll = false;
      updatePageInfo();
      renderPages();
    } else {
      this.value = pdfShowAll ? _pdfVisiblePage() : pdfPage;
    }
  });
})();
function _pdfVisiblePage() {
  if (!pdfShowAll) return pdfPage;
  var body = document.getElementById('pdfBody');
  if (!body) return pdfPage;
  var scrollTop = body.scrollTop;
  var wraps = body.querySelectorAll('.pdf-page-wrap');
  var best = pdfPage;
  var bestDist = Infinity;
  wraps.forEach(function (w) {
    var dist = Math.abs(w.offsetTop - scrollTop);
    if (dist < bestDist) {
      bestDist = dist;
      best = parseInt(w.dataset.pageNum) || pdfPage;
    }
  });
  return best;
}
function _pdfScrollToPage(num) {
  var body = document.getElementById('pdfBody');
  if (!body) return;
  var wrap = body.querySelector('[data-page-num="' + num + '"]');
  if (wrap) body.scrollTop = wrap.offsetTop;
}
(document.getElementById('pdfZoomIn') || { addEventListener: function () {} }).addEventListener(
  'click',
  function () {
    var pg = _pdfVisiblePage();
    pdfScale = Math.min(Math.round((pdfScale + 0.1) * 10) / 10, 3);
    updateZoomPct();
    renderPages();
    setTimeout(function () {
      _pdfScrollToPage(pg);
    }, 120);
  }
);
(document.getElementById('pdfZoomOut') || { addEventListener: function () {} }).addEventListener(
  'click',
  function () {
    var pg = _pdfVisiblePage();
    pdfScale = Math.max(Math.round((pdfScale - 0.1) * 10) / 10, 0.2);
    updateZoomPct();
    renderPages();
    setTimeout(function () {
      _pdfScrollToPage(pg);
    }, 120);
  }
);
(document.getElementById('pdfFit') || { addEventListener: function () {} }).addEventListener(
  'click',
  function () {
    var pg = _pdfVisiblePage();
    pdfScale = 0.9;
    updateZoomPct();
    renderPages();
    setTimeout(function () {
      _pdfScrollToPage(pg);
    }, 120);
  }
);

(document.getElementById('pdfDownload') || { addEventListener: function () {} }).addEventListener(
  'click',
  function () {
    if (activeFileName) downloadFile(activeFileName);
  }
);
(document.getElementById('pdfAll') || { addEventListener: function () {} }).addEventListener(
  'click',
  function () {
    pdfShowAll = !pdfShowAll;
    document.getElementById('pdfAll').textContent = pdfShowAll ? 'Single page' : 'All pages';
    renderPages();
  }
);

// ── AI PANEL ──────────────────────────────────────────────────────────────
var aiPanel = document.getElementById('aiPanel'),
  aiTab = document.getElementById('aiTab');
var hoverZone = document.getElementById('aiHoverZone');

// AI panel lifecycle + selection banner now live in features/ai-chat/ai-panel-bridge.js

// Only open on click or direct hover over the tab logo — not the wide hover zone
// bound via initAiPanelBridge(...)

// bound via initAiPanelBridge(...)

// Reset manual-closed once cursor moves far from right edge (150px)
// bound via initAiPanelBridge(...)

// bound via initAiPanelBridge(...)

// bound via initAiPanelBridge(...)

// ── SELECTION BANNER ──────────────────────────────────────────────────────
// showSelectionBanner → features/ai-chat/ai-panel-bridge.js

// ── AI MESSAGES ───────────────────────────────────────────────────────────
var aiMsgs = document.getElementById('aiMsgs');
initAiRenderBridge();
initAiPanelEffects({ aiMsgs: aiMsgs, aiPanel: aiPanel });
var _aiPanelBridge = initAiPanelBridge({
  aiPanel: aiPanel,
  aiTab: aiTab,
  aiClose: document.getElementById('aiClose'),
  aiMsgs: aiMsgs,
  t: _t,
  escapeHtml: escapeHtml,
  askAI: function (prompt) {
    return askAI(prompt);
  },
  getAiPinned: function () {
    return aiPinned;
  },
  setAiPinned: function (v) {
    aiPinned = v;
  },
  getAiOpen: function () {
    return aiOpen;
  },
  setAiOpen: function (v) {
    aiOpen = v;
  }
});
openAI = _aiPanelBridge.openAI;
closeAI = _aiPanelBridge.closeAI;
forceCloseAI = _aiPanelBridge.forceCloseAI;
pinAI = _aiPanelBridge.pinAI;
showSelectionBanner = _aiPanelBridge.showSelectionBanner;
window.openAI = openAI;
window.closeAI = closeAI;
window.forceCloseAI = forceCloseAI;
window.pinAI = pinAI;
window.showSelectionBanner = showSelectionBanner;

// getTime → features/ai-chat/ai-message-actions.js (private helper there)

// renderMarkdown → features/ai-chat/ai-markdown.js

// ── MATH RENDERING (KaTeX) ───────────────────────────────────────────────

// _aiMakePdfBlob / _aiDownloadPdf / _ufDestPicker / _glMoveDestPicker / _aiExportToCourse / _aiShowExportModal / _aiResponseActions → features/ai-chat/ai-export.js
initAiExportBridge();

// addBotMsg / addUserMsg / _setAiChipsVisible → features/ai-chat/ai-message-actions.js (bridged at top of file)

// Welcome message — deferred so _t is defined
setTimeout(function () {
  if (typeof addBotMsg === 'function')
    addBotMsg(
      window._t ? window._t('ai_welcome') : "👋 Hello! Open a PDF and I'll help you study it."
    );
}, 0);

// askAI / addTyping / pdfToImages → features/ai-chat/ai-ask.js

var _aiState = {
  get generationStopped() {
    return generationStopped;
  },
  set generationStopped(v) {
    generationStopped = v;
  },
  get currentGenId() {
    return currentGenId;
  },
  set currentGenId(v) {
    currentGenId = v;
  },
  get activeTypeTimer() {
    return activeTypeTimer;
  },
  set activeTypeTimer(v) {
    activeTypeTimer = v;
  },
  get activeThinkTimer() {
    return activeThinkTimer;
  },
  set activeThinkTimer(v) {
    activeThinkTimer = v;
  }
};

var _aiAskBridge = initAiAskBridge(_aiState);
askAI = _aiAskBridge.askAI;

// ── ASK AI ────────────────────────────────────────────────────────────────

// ── SEND BUTTON ───────────────────────────────────────────────────────────
// chipPrompt / closeAllOpts / chip listeners → features/ai-chat/ai-chips.js
initAiChipsBridge();
// ── PER-PDF CHAT PERSISTENCE — moved to features/js/chat.js ─────────────────

// ── CONFETTI ──────────────────────────────────────────────────────────────
initAiConfettiBridge();

// ── INIT ──────────────────────────────────────────────────────────────────
// Apply cached profile & courses instantly before auth completes
(function () {
  try {
    var lastUid = localStorage.getItem('ss_last_uid');
    if (!lastUid) return;
    var cp = JSON.parse(localStorage.getItem('profile_cache_' + lastUid) || 'null');
    if (cp) {
      if (cp.full_name && typeof applyProfile === 'function') applyProfile(cp);
      if (cp.courses && typeof _loadUserCourses === 'function') _loadUserCourses(cp.courses);
    }
  } catch (e) {}
})();
renderCourses();
renderTT();
renderMails();

// ── STATE PERSISTENCE ─────────────────────────────────────────────────────

// Flash scroll hint when new message arrives

// ── INTERACTIVE EFFECTS JS ─────────────────────────────────────────

// Ripple effect on any clickable element in AI panel

// ── PORTAL SECTION SWITCHER ───────────────────────────────────────────────

// pc* card listeners moved to ss-ready

// ── SUPABASE AUTH + DATA ─────────────────────────────────────────────────
// Note: auth DOM elements are injected dynamically by loader.js, so we must
// wait for 'ss-ready' before querying them — NOT DOMContentLoaded.

// ── END INIT ─────────────────────────────────────────────────────────────────

// ── SS-READY (runs at top level since app.js loads after all HTML) ───────────

// ── DOM LISTENERS (elements injected by loader.js — must be in ss-ready) ────

// Nav buttons

// Sidebar

// ── Theme transition: radial ripple from click origin ────────────────────
function _applyTheme(toNight, originEl) {
  var rect = originEl
    ? originEl.getBoundingClientRect()
    : { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
  var x = Math.round(rect.left + rect.width / 2);
  var y = Math.round(rect.top + rect.height / 2);

  function _commitTheme() {
    Store.setState({ settings: { darkMode: toNight } }); // Update central state
    // UI update for body class is handled by the Store subscription

    var nbIcon = document.getElementById('nightIcon');
    if (nbIcon) {
      nbIcon.textContent = toNight ? '🌙' : '☀️';
      var nbLbl = document.getElementById('nightLabel');
      if (nbLbl) nbLbl.textContent = toNight ? 'Night' : 'Day';
    }
    var dm = document.getElementById('settingsDarkMode');
    if (dm) dm.checked = toNight;
    localStorage.setItem('ss_dark', toNight ? '1' : '0'); // Keep for early loading scripts (e.g., auth-bootstrap.js)
    saveState();
  }

  // View Transitions API — browser screenshots old & new state,
  // then reveals the real new-theme content as an expanding circle
  if (!document.startViewTransition) {
    _commitTheme(); // fallback: instant switch
    return;
  }

  var transition = document.startViewTransition(_commitTheme);

  transition.ready.then(function () {
    var endRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );
    document.documentElement.animate(
      {
        clipPath: [
          'circle(0px at ' + x + 'px ' + y + 'px)',
          'circle(' + endRadius + 'px at ' + x + 'px ' + y + 'px)'
        ]
      },
      {
        duration: 500,
        easing: 'ease-in-out',
        pseudoElement: '::view-transition-new(root)'
      }
    );
  });
}

// Night mode button
_bindIf('nightBtn', 'click', function () {
  _applyTheme(!Store.getState().settings.darkMode, this);
});

// ── Mobile hamburger menu ──────────────────────────────────────
(function () {
  var ham = document.getElementById('portalHamburger');
  var scrim = document.getElementById('mobScrim');
  var sb = document.querySelector('#portal .sidebar');
  if (!ham || !scrim || !sb) return;
  function openMobSb() {
    sb.classList.add('mob-open');
    scrim.classList.add('show');
  }
  function closeMobSb() {
    sb.classList.remove('mob-open');
    scrim.classList.remove('show');
  }
  ham.addEventListener('click', openMobSb);
  scrim.addEventListener('click', closeMobSb);
  // Close when a nav item is clicked
  sb.addEventListener('click', function (e) {
    if (window.innerWidth <= 768 && e.target.closest('.sb-item')) closeMobSb();
  });
})();

// Dashboard cards
_bindIf('pcStudip', 'click', function () {
  showStudip();
  _ssPushHistory({ view: 'studip' }, '#studip');
});
_bindIf('pcMail', 'click', function () {
  window.open('https://mail.tu-braunschweig.de', '_blank');
});
_bindIf('pcConnect', 'click', function () {
  window.open('https://connect.tu-braunschweig.de', '_blank');
});
_bindIf('pcTT', 'click', function () {
  window.open('https://connect.tu-braunschweig.de', '_blank');
});
_bindIf('pcCert', 'click', function () {
  window.open('https://connect.tu-braunschweig.de', '_blank');
});
_bindIf('pcWeb', 'click', function () {
  window.open('https://www.tu-braunschweig.de', '_blank');
});

// Auth + user-data bridge -> features/auth/auth-bridge.js
var _authBridge = initAuthBridge({
  sb: _sb,
  t: _t,
  getCurrentUser: function () {
    return _currentUser;
  },
  verifyAndEnter: function (token) {
    return _verifyAndEnter(token);
  },
  enterApp: function (user) {
    return _enterApp(user);
  },
  resetActivityTimer: function () {
    return _resetActivityTimer();
  }
});

// _startPresenceHeartbeat / loadUserData / applyProfile / _applyUserTypeUI → features/auth/user-data.js

var _userType = localStorage.getItem('ss_user_type') || 'enrolled';
var _germanTest = '';
var _germanLevel = '';

// GERMAN LEARNER PRACTICE -- moved to features/js/practice.js

// LANGUAGE / i18n → features/settings/language.js
initSettingsBridge();

// applyLanguage → features/settings/language.js

// applySettings → features/settings/settings.js

// ── ADMIN PANEL → features/admin/admin-panel.js ──────────────────────────

// ── LANDING PAGE ─────────────────────────────────────────────────────────
initLandingAuthBridge({
  authBridge: _authBridge
});

// ── END SS-READY ─────────────────────────────────────────────────────────────

// ── ONBOARDING → features/auth/onboarding.js ────────────────────────────

// _obBaseInfo / _obSaveAndClose / _obFinish / _obFinishLearner / listeners → features/auth/onboarding.js
// ?? STUDY LOUNGE ??????????????????????????????????????????????????????????

// ── CHATBOT PAGE — moved to features/chatbot/chatbot.js ──────────────────────

// ── CHAT — moved to features/js/chat.js ──────────────────────────────────────
// WIDGET DASHBOARD + GOOGLE CALENDAR -- moved to features/js/dashboard.js
// Music Services -> features/music/music-services.js

// ── Subscription service → services/subscription-service.js ─────────────
import {
  createCheckoutSession as _createCheckoutSession,
  createPortalSession as _createPortalSession,
  verifyPayment as _verifyPayment,
  activatePayPalSubscription as _activatePayPalSubscription,
  loadBillingConfig as _loadBillingConfig
} from './services/subscription-service.js';
window._subService = {
  createCheckoutSession: _createCheckoutSession,
  createPortalSession: _createPortalSession,
  verifyPayment: _verifyPayment,
  activatePayPalSubscription: _activatePayPalSubscription,
  loadBillingConfig: _loadBillingConfig
};

// ── Study Techniques → features/study-timer/study-timer.js ───────────────
if (window.StudySphere) {
  window.StudySphere.markReady('app-js-evaluated', {});
  window.StudySphere.emit('app:script-evaluated', {});
}
