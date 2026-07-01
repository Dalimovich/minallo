// Minallo router/history layer. Loaded after app.js so it can wrap app globals.

function _bindIf(id, event, handler) {
  var el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

var _ssHandlingPop = false;
var _ssRestoring = false; // suppress history pushes during state restore

function _ssPushHistory(state, hash) {
  if (_ssHandlingPop || _ssRestoring || window._ssRestoring) return;
  try {
    var cur = history.state || {};
    if (
      hash &&
      window.location.hash === hash &&
      cur &&
      cur.view === state.view &&
      cur.section === state.section &&
      cur.courseId === state.courseId &&
      cur.fileName === state.fileName
    ) {
      return;
    }
    history.pushState(state, '', hash || window.location.pathname);
  } catch (e) {}
}

function _ssReplaceHistory(state, hash) {
  try {
    history.replaceState(state, '', hash || window.location.pathname);
  } catch (e) {}
}

function _ssCurrentPanel() {
  var rail = window.__minalloDocRail;
  return (rail && rail.currentMode) ? rail.currentMode() : null;
}

function _ssPanelSuffix() {
  var p = _ssCurrentPanel();
  return p ? '&panel=' + encodeURIComponent(p) : '';
}

function _ssCourseHash(course, section) {
  var id = course && (course.id || course.short) ? String(course.id || course.short) : '';
  return '#portal=courses&course=' + encodeURIComponent(id) + '&section=' + encodeURIComponent(section || 'files') + _ssPanelSuffix();
}

function _ssFileHash(fileName, course, section) {
  var id = course && (course.id || course.short) ? String(course.id || course.short) : '';
  return (
    '#portal=courses&course=' + encodeURIComponent(id) +
    '&section=' + encodeURIComponent(section || 'files') +
    '&file=' + encodeURIComponent(fileName || '') +
    _ssPanelSuffix()
  );
}

function _ssStateFromHash(hash) {
  if (!hash || hash.indexOf('access_token') !== -1) return null;
  var raw = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  var params;
  try {
    params = new URLSearchParams(raw);
  } catch (e) {
    return null;
  }
  var file = params.get('file');
  var course = params.get('course');
  var panel = params.get('panel') || null;
  if (file) {
    return {
      view: 'file',
      courseId: course || params.get('courseId') || null,
      courseShort: params.get('courseShort') || null,
      fileName: file,
      section: params.get('section') || 'files',
      panel: panel
    };
  }
  if (course) {
    return {
      view: 'course',
      courseId: course,
      courseShort: params.get('courseShort') || null,
      section: params.get('section') || 'files',
      panel: panel
    };
  }
  var portal = params.get('portal');
  if (portal) {
    var sec = portal === 'courses' ? 'studip' : portal;
    return { view: 'portal', section: sec };
  }
  return null;
}

// Central portal navigation helper. Updates hash, calls showPortalSection,
// calls setNavActive with the correct sidebar ID, and commits URL + storage
// via _finalizeNav. Use this instead of calling showPortalSection directly.
function _navigatePortal(section) {
  if (!section) return;
  var navId = _ssPortalNavId(section);
  if (typeof setNavActive === 'function') setNavActive(navId);
  if (typeof showPortalSection === 'function') showPortalSection(section);
  _finalizeNav(section);
  _ssAfterFeature(section);
}
window._navigatePortal = _navigatePortal;

// Sync the URL to match the actual visible app state. Uses replaceState so it
// doesn't create extra history entries — just corrects the hash if it drifted.
// Called after file open/close, drawer open/close, and section switches.
function _ssSyncUrl() {
  try {
    var hash;
    var portalEl = document.getElementById('portal');
    var activeView = portalEl ? portalEl.dataset.activeView || null : null;
    if (!activeView) {
      var appEl = document.getElementById('app');
      activeView = (appEl && appEl.style.display !== 'none' && appEl.style.display !== '') ? 'file' : 'portal';
    }
    if (activeView === 'file' && activeFileName) {
      hash = _ssFileHash(activeFileName, activeCourseRef || { id: activeCourseId }, activeCourseSection || 'files');
      _ssReplaceHistory(
        { view: 'file', courseId: activeCourseId || null, courseShort: (activeCourseRef && activeCourseRef.short) || null, fileName: activeFileName, section: activeCourseSection || 'files', panel: _ssCurrentPanel() },
        hash
      );
    } else if (activeView === 'file' && activeCourseId) {
      hash = _ssCourseHash(activeCourseRef || { id: activeCourseId }, activeCourseSection || 'files');
      _ssReplaceHistory(
        { view: 'course', courseId: activeCourseId, courseShort: (activeCourseRef && activeCourseRef.short) || null, section: activeCourseSection || 'files', panel: _ssCurrentPanel() },
        hash
      );
    }
    // Portal sections are handled by _finalizeNav — don't override those.
  } catch (e) {}
}
window._ssSyncUrl = _ssSyncUrl;

// Authoritative URL + ss_portal_tab + ss_last_section commit. Belt-and-suspenders
// alongside the showPortalSection wrapper — calling this after every navigation
// guarantees URL and storage match the visible section even if the wrapper
// chain is shadowed/broken by a later script.
function _finalizeNav(section) {
  if (!section) return;
  try {
    sessionStorage.setItem('ss_portal_tab', section);
    localStorage.setItem('ss_last_section', section);
    var st = JSON.parse(localStorage.getItem('ss_state') || '{}');
    st.inApp = false;
    st.view = '';
    localStorage.setItem('ss_state', JSON.stringify(st));
  } catch (e) {}
  var urlSection = section === 'studip' ? 'courses' : section;
  try {
    var nextHash = '#portal=' + encodeURIComponent(urlSection);
    var cur = history.state || {};
    if (cur.view === 'portal' && cur.section === section && window.location.hash === nextHash) {
      return;
    }
    history.pushState({ view: 'portal', section: section }, '', nextHash);
  } catch (e) {}
}

function _ssAfterFeature(section, cb) {
  var loader = window._ssLoadPortalFeature;
  var sectionLoader = window._ssLoadFeatureSection;
  var sectionP =
    typeof sectionLoader === 'function'
      ? sectionLoader(section)
      : Promise.resolve();
  var p =
    typeof loader === 'function'
      ? loader(section)
      : Promise.resolve();
  return Promise.all([sectionP, p])
    .catch(function (err) {
      console.error('[router] lazy feature failed:', section, err);
    })
    .then(function () {
      if (typeof cb === 'function') cb();
    });
}
window._ssAfterFeature = _ssAfterFeature;

function _ssFindCourseById(courseId) {
  if (!courseId) return null;
  for (var semId in SEMS) {
    if (!SEMS[semId] || !SEMS[semId].courses) continue;
    var found = SEMS[semId].courses.find(function (c) {
      return c.id === courseId;
    });
    if (found) return found;
  }
  return null;
}

function _ssFindCourseByShort(shortName) {
  if (!shortName) return null;
  for (var semId in SEMS) {
    if (!SEMS[semId] || !SEMS[semId].courses) continue;
    var found = SEMS[semId].courses.find(function (c) {
      return c.short === shortName;
    });
    if (found) return found;
  }
  return null;
}

function _ssFindFileInCourse(course, fileName) {
  if (!course || !fileName) return null;
  var pools = [];
  if (Array.isArray(course.files)) pools.push(course.files);
  if (Array.isArray(course.folders)) {
    course.folders.forEach(function (folder) {
      if (folder && Array.isArray(folder.files)) pools.push(folder.files);
    });
  }
  if (Array.isArray(course.userFolders)) {
    course.userFolders.forEach(function (folder) {
      if (folder && Array.isArray(folder.files)) pools.push(folder.files);
    });
  }
  for (var i = 0; i < pools.length; i++) {
    var found = pools[i].find(function (f) {
      return f.name === fileName;
    });
    if (found) return found;
  }
  return null;
}

function _ssPortalNavId(section) {
  return (
    {
      dashboard: 'psbDashboard',
      profile: 'psbProfile',
      settings: 'psbSettings',
      subscription: 'psbSubscription',
      notes: 'psbNotes',
      courses: 'pcStudip',
      studip: 'pcStudip',
      chat: 'psbChat',
      notifications: 'psbNotifications',
      games: 'psbGames',
      lounge: 'psbLounge',
      aipage: 'psbAIPage',
      german: 'psbGerman',
      editor: 'psbEditor',
      admin: 'psbAdmin'
    }[section] || 'psbDashboard'
  );
}

function _ssApplyHistoryState(state) {
  if (!state) {
    showPortal();
    // Default to dashboard when we have no state at all.
    setNavActive('psbDashboard');
    return;
  }

  if (state.view === 'portal') {
    showPortal();
    if (state.section) {
      setNavActive(_ssPortalNavId(state.section));
      showPortalSection(state.section);
      _ssAfterFeature(state.section, function () {
        if (state.section === 'chat' && typeof window._chatInit === 'function') window._chatInit();
        if (state.section === 'aipage' && typeof window._aipRefreshSidebar === 'function') window._aipRefreshSidebar();
        if (state.section === 'german' && typeof window._glBackToHome === 'function') window._glBackToHome();
        if (state.section === 'editor') {
          if (typeof window._writerInit === 'function') window._writerInit();
          else if (typeof window._editorInit === 'function') window._editorInit();
        }
      });
    } else {
      setNavActive('psbDashboard');
    }
    return;
  }

  if (state.view === 'studip' || state.view === 'courses') {
    showStudip();
    // showStudip already sets nav, but be explicit so future readers see it.
    setNavActive('pcStudip');
    return;
  }

  // ── Inside a course or a file: nav must be pcStudip (Courses), not whatever
  // section the user was on before. This is the bug from the screenshot —
  // browser back from chatbot to a file left the AI sidebar item highlighted.
  if (state.view === 'course') {
    var course = _ssFindCourseById(state.courseId) || _ssFindCourseByShort(state.courseShort) || _ssFindCourseByShort(state.courseId);
    if (course) {
      setNavActive('pcStudip');
      if (typeof window.openCourse === 'function') window.openCourse(course);
      // Bug 4 fix: defer showCourseSection so it runs after openCourse has
      // finished mounting the course view, preventing the Files tab flash.
      if (state.section && state.section !== 'files' && typeof window.showCourseSection === 'function') {
        setTimeout(function () {
          window.showCourseSection(course, state.section);
        }, 0);
      }
      _ssRestorePanel(state.panel);
    }
    return;
  }

  if (state.view === 'file') {
    var fileCourse = _ssFindCourseById(state.courseId) || _ssFindCourseByShort(state.courseShort) || _ssFindCourseByShort(state.courseId);
    if (fileCourse) {
      setNavActive('pcStudip');
      var file = _ssFindFileInCourse(fileCourse, state.fileName);
      if (file) {
        if (typeof window.openFile === 'function') window.openFile(file, fileCourse);
      } else {
        if (typeof window.openCourse === 'function') window.openCourse(fileCourse);
        if (state.section && typeof window.showCourseSection === 'function')
          window.showCourseSection(fileCourse, state.section);
      }
      _ssRestorePanel(state.panel);
    }
  }
}

function _ssRestorePanel(panel) {
  if (!panel) return;
  setTimeout(function () {
    var rail = window.__minalloDocRail;
    if (rail && typeof rail.open === 'function') rail.open(panel);
  }, 400);
}

var _origOpenCourse = window.openCourse;
window.openCourse = function (c) {
  _pendingPortalRestore = null;
  if (typeof _origOpenCourse === 'function') _origOpenCourse(c);
  saveState();
  var section = activeCourseSection || 'files';
  var current = history.state || {};
  if (
    current.view === 'course' &&
    current.courseId === (c.id || null) &&
    current.section === section
  ) {
    setTimeout(_ssSyncUrl, 120);
    return;
  }
  _ssPushHistory(
    {
      view: 'course',
      courseId: c.id || null,
      courseShort: c.short || null,
      section: section,
      panel: _ssCurrentPanel()
    },
    _ssCourseHash(c, section)
  );
  setTimeout(_ssSyncUrl, 120);
};

var _origOpenFile = window.openFile;
window.openFile = function (f, c) {
  _pendingPortalRestore = null;
  if (typeof _origOpenFile === 'function') _origOpenFile(f, c);
  // saveState() is now called inside pdf-viewer.js after panel is shown
  _ssPushHistory(
    {
      view: 'file',
      courseId: c.id || null,
      courseShort: c.short || null,
      fileName: f.name || null,
      section: activeCourseSection || 'files',
      panel: _ssCurrentPanel()
    },
    _ssFileHash(f.name || '', c, activeCourseSection || 'files')
  );
  // Safety net: if _ssPushHistory bailed due to guard flags, correct the URL.
  setTimeout(_ssSyncUrl, 120);
};

var _origShowSection = window.showCourseSection;
var _inShowSection = false;
window.showCourseSection = function (c, s) {
  if (_inShowSection) return;
  _inShowSection = true;
  if (typeof _origShowSection === 'function') _origShowSection(c, s);
  _inShowSection = false;
  saveState();
  _ssPushHistory(
    {
      view: 'course',
      courseId: c.id || null,
      courseShort: c.short || null,
      section: s || 'files',
      panel: _ssCurrentPanel()
    },
    _ssCourseHash(c, s || 'files')
  );
  setTimeout(_ssSyncUrl, 120);
};

var _savedPortalTab = (function () {
  try {
    return sessionStorage.getItem('ss_portal_tab') || localStorage.getItem('ss_last_section');
  } catch (e) {
    return null;
  }
})();
var _pendingPortalRestore =
  _savedPortalTab && _savedPortalTab !== 'dashboard' ? _savedPortalTab : null;
// Note: the previous router-side wrap of window.showPortalSection was
// removed. Codex's _finalizeNav() (defined above) is now called explicitly
// from every nav handler to commit URL + sessionStorage + localStorage,
// which is what the wrap used to do. Leaving the wrap in place caused two
// problems:
//   1. Double-push: handlers called _finalizeNav AND the wrap pushed
//      history a second time. That's what triggered Chrome's
//      "Throttling navigation to prevent the browser from hanging".
//   2. Wrapper-chain recursion: feature scripts (dashboard-calendar.js)
//      install their own wrappers via the read-then-write pattern. Any
//      attempt to intercept that with a getter/setter while ALSO doing
//      the read-then-write ourselves produced infinite recursion when
//      _origShowPortalSection ended up holding a wrapper that called us
//      back.
// Other side effects the wrap used to handle (subscription init,
// _pendingPortalRestore) now happen in the explicit psbXxx click
// handlers below.

// Skip the initial portal-state replace when we're about to show the auth
// modal — otherwise the URL flashes #portal=dashboard between landing and
// the auth screen before _showModal wipes it.
var _ssSkipBootRoute = false;
try {
  _ssSkipBootRoute = sessionStorage.getItem('ss_show_auth') === 'true';
} catch (e) {}

if (!_ssSkipBootRoute &&
    (!window.location.hash || window.location.hash.indexOf('access_token') === -1)) {
  var _hashState = _ssStateFromHash(window.location.hash);
  var _rst = {};
  try {
    _rst = JSON.parse(localStorage.getItem('ss_state') || '{}');
  } catch (e) {}
  if (_hashState) {
    _ssReplaceHistory(_hashState, window.location.hash);
  } else if (_rst.inApp && (_rst.view === 'studip' || _rst.view === 'courses')) {
    _ssReplaceHistory({ view: 'courses' }, '#portal=courses');
  } else if (_rst.inApp && _rst.fileName) {
    _ssReplaceHistory(
      {
        view: 'file',
        courseId: _rst.courseId,
        fileName: _rst.fileName,
        section: _rst.section || 'files'
      },
      '#portal=courses&course=' + encodeURIComponent(_rst.courseId || '') +
        '&section=' + encodeURIComponent(_rst.section || 'files') +
        '&file=' + encodeURIComponent(_rst.fileName)
    );
  } else if (_rst.inApp && _rst.courseId) {
    _ssReplaceHistory(
      { view: 'course', courseId: _rst.courseId, section: _rst.section || 'files' },
      '#portal=courses&course=' + encodeURIComponent(_rst.courseId) +
        '&section=' + encodeURIComponent(_rst.section || 'files')
    );
  } else {
    var _initSec = _pendingPortalRestore || 'dashboard';
    _ssReplaceHistory(
      { view: 'portal', section: _initSec },
      '#portal=' + encodeURIComponent(_initSec)
    );
  }
}

function _ssApplyBootRoute() {
  if (!_currentUser) return;
  var st = history.state || _ssStateFromHash(window.location.hash);
  if (!st) return;
  _ssHandlingPop = true;
  try {
    _ssApplyHistoryState(st);
  } finally {
    _ssHandlingPop = false;
  }
}

window.addEventListener('ss-ready', function () {
  setTimeout(_ssApplyBootRoute, 0);
}, { once: true });

window.addEventListener('popstate', function (e) {
  // Guard: never restore portal/file views without an authenticated user.
  // Otherwise Back from the landing (or after logout) pops to a stale entry
  // from a prior session and silently re-mounts the app.
  if (!_currentUser) {
    try {
      history.replaceState(null, '', window.location.pathname);
    } catch (err) {}
    return;
  }
  _ssHandlingPop = true;
  try {
    _ssApplyHistoryState(e.state);
  } finally {
    _ssHandlingPop = false;
  }
});

_bindIf('studipBack', 'click', function () {
  showPortal();
  _ssPushHistory({ view: 'portal', section: 'dashboard' }, '#portal=dashboard');
});

_bindIf('psbDashboard', 'click', function () {
  setNavActive('psbDashboard');
  showPortalSection('dashboard');
  _finalizeNav('dashboard');
  _ssAfterFeature('dashboard');
});

_bindIf('psbGerman', 'click', function () {
  setNavActive('psbGerman');
  showPortalSection('german');
  _finalizeNav('german');
  _ssAfterFeature('german', function () {
    if (typeof window._glBackToHome === 'function') window._glBackToHome();
  });
});

_bindIf('psbProfile', 'click', function () {
  setNavActive('psbProfile');
  showPortalSection('profile');
  _finalizeNav('profile');
  _ssAfterFeature('profile');
});

_bindIf('authAvatar', 'click', function () {
  setNavActive('psbProfile');
  showPortalSection('profile');
  _finalizeNav('profile');
  _ssAfterFeature('profile');
});

_bindIf('psbSettings', 'click', function () {
  setNavActive('psbSettings');
  showPortalSection('settings');
  _finalizeNav('settings');
  _ssAfterFeature('settings');
});

_bindIf('psbSubscription', 'click', function () {
  setNavActive('psbSubscription');
  showPortalSection('subscription');
  _finalizeNav('subscription');
  _ssAfterFeature('subscription');
});

// Admin is wired here (not in the lazily-loaded admin-panel.js) so the click
// handler exists from boot — otherwise the first clicks land before the
// delayed admin module attaches its listener and do nothing. _finalizeNav is
// what writes #portal=admin to the URL, matching every other section.
_bindIf('psbAdmin', 'click', function () {
  setNavActive('psbAdmin');
  showPortalSection('admin');
  _finalizeNav('admin');
  _ssAfterFeature('admin');
});

_bindIf('goPortal', 'click', function () {
  if (activeFileName && activeCourseRef) {
    if (
      window._userType === 'learner' &&
      activeCourseRef.id &&
      activeCourseRef.id.startsWith('german-')
    ) {
      activeFileName = null;
      pdfDoc = null;
      pdfFullText = '';
      _setAiChipsVisible(false);
      showPortal();
      setNavActive('psbGerman');
      showPortalSection('german');
      window._glOpenSkill(_glActiveSkill || activeCourseRef.id.replace('german-', ''));
    } else {
      activeFileName = null;
      pdfDoc = null;
      pdfFullText = '';
      _setAiChipsVisible(false);
      document.getElementById('pdfView').style.display = 'none';
      document.getElementById('courseOverview').style.display = 'block';
      showCourseSection(activeCourseRef, 'files');
    }
  } else {
    activeCourseId = null;
    activeCourseRef = null;
    if (window._userType === 'learner') {
      showPortal();
      setNavActive('psbGerman');
      showPortalSection('german');
    } else {
      showStudip();
    }
  }
});

(function () {
  var sbNav = document.querySelector('#portal .sb-nav');
  if (!sbNav) return;
  sbNav.addEventListener('click', function (e) {
    var item = e.target.closest('.sb-item');
    if (!item) return;
    if (item.dataset.comingSoon) {
      showToast('Coming soon!', 'This feature is on its way.');
      return;
    }
    if (item.id === 'psbNotes') {
      _navTo('psbNotes', 'notes');
      _finalizeNav('notes');
      _ssAfterFeature('notes');
    }
    if (item.id === 'psbEditor') {
      _navTo('psbEditor', 'editor');
      _finalizeNav('editor');
      _ssAfterFeature('editor', function () {
        if (typeof window._writerInit === 'function') window._writerInit();
        else if (typeof window._editorInit === 'function') window._editorInit();
      });
    }
    if (item.id === 'psbAIPage') {
      _navTo('psbAIPage', 'aipage');
      _finalizeNav('aipage');
      _ssAfterFeature('aipage', function () {
        if (typeof window._aipRefreshSidebar === 'function') window._aipRefreshSidebar();
      });
    }
    if (item.id === 'psbChat') {
      _navTo('psbChat', 'chat');
      _finalizeNav('chat');
      _ssAfterFeature('chat', function () {
        if (typeof window._chatInit === 'function') window._chatInit();
      });
    }
    if (item.id === 'psbNotifications') {
      _navTo('psbNotifications', 'notifications');
      _finalizeNav('notifications');
    }
    if (item.id === 'psbGames') {
      if (item.classList.contains('st-locked')) return;
      _navTo('psbGames', 'games');
      _finalizeNav('games');
    }
    if (item.id === 'psbLounge') {
      _navTo('psbLounge', 'lounge');
      _finalizeNav('lounge');
      _loungeRender();
    }
  });
})();
