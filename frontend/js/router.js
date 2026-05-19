// Minallo router/history layer. Loaded after app.js so it can wrap app globals.

function _bindIf(id, event, handler) {
  var el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

var _ssHandlingPop = false;
var _ssRestoring = false; // suppress history pushes during state restore

function _ssPushHistory(state, hash) {
  // TEMP diagnostic — remove after URL-stuck-on-notes bug is confirmed fixed.
  // Logs why a push is suppressed so the next click reveals which flag is held.
  if (_ssHandlingPop || _ssRestoring || window._ssRestoring) {
    try {
      console.log(
        '[router] _ssPushHistory bailed',
        'hash=', hash,
        '_ssHandlingPop=', _ssHandlingPop,
        '_ssRestoring(local)=', _ssRestoring,
        'window._ssRestoring=', window._ssRestoring
      );
    } catch (e) {}
    return;
  }
  try {
    history.pushState(state, '', hash || window.location.pathname);
  } catch (e) {
    try { console.log('[router] pushState threw', e); } catch (e2) {}
  }
}

function _ssReplaceHistory(state, hash) {
  try {
    history.replaceState(state, '', hash || window.location.pathname);
  } catch (e) {}
}

// Authoritative URL + ss_portal_tab + ss_last_section commit. Belt-and-suspenders
// alongside the showPortalSection wrapper — calling this after every navigation
// guarantees URL and storage match the visible section even if the wrapper
// chain is shadowed/broken by a later script.
function _finalizeNav(section) {
  if (!section) return;
  try {
    sessionStorage.setItem('ss_portal_tab', section);
    localStorage.setItem('ss_last_section', section);
  } catch (e) {}
  var urlSection = section === 'studip' ? 'courses' : section;
  try {
    history.pushState({ view: 'portal', section: section }, '', '#portal=' + encodeURIComponent(urlSection));
  } catch (e) {}
}

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
    var course = _ssFindCourseById(state.courseId) || _ssFindCourseByShort(state.courseShort);
    if (course) {
      setNavActive('pcStudip');
      if (typeof window.openCourse === 'function') window.openCourse(course);
      if (state.section && typeof window.showCourseSection === 'function')
        window.showCourseSection(course, state.section);
    }
    return;
  }

  if (state.view === 'file') {
    var fileCourse = _ssFindCourseById(state.courseId) || _ssFindCourseByShort(state.courseShort);
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
    }
  }
}

var _origOpenCourse = window.openCourse;
window.openCourse = function (c) {
  _pendingPortalRestore = null;
  if (typeof _origOpenCourse === 'function') _origOpenCourse(c);
  saveState();
  _ssPushHistory(
    {
      view: 'course',
      courseId: c.id || null,
      courseShort: c.short || null,
      section: activeCourseSection || 'files'
    },
    '#course=' + encodeURIComponent(c.id || c.short || '')
  );
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
      section: activeCourseSection || 'files'
    },
    '#file=' + encodeURIComponent(f.name || '')
  );
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
      section: s || 'files'
    },
    '#course=' +
      encodeURIComponent(c.id || c.short || '') +
      '&section=' +
      encodeURIComponent(s || 'files')
  );
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
var _origShowPortalSection = window.showPortalSection;
window.showPortalSection = function (sec) {
  var target = sec || 'dashboard';

  // 'courses' is the URL-facing alias for the internal 'studip' section
  if (target === 'courses') target = 'studip';

  if (target === 'dashboard' && _pendingPortalRestore) {
    target = _pendingPortalRestore;
    _pendingPortalRestore = null;
    setNavActive(_ssPortalNavId(target));
    if (target === 'courses' || target === 'studip') setTimeout(sdRenderCourses, 0);
    if (target === 'chat') setTimeout(_chatInit, 0);
    if (target === 'editor')
      setTimeout(function () {
        if (typeof window._writerInit === 'function') window._writerInit();
        else if (typeof window._editorInit === 'function') window._editorInit();
      }, 0);
  }

  activePortalSection = target;
  // TEMP diagnostic — catch any throw from the inner showPortalSection so we
  // can see what's blowing up while still completing the URL/sessionStorage
  // update. Without this, a throw here silently kills the ss_portal_tab and
  // history push, leaving Notes (the last successful update) as the perpetual
  // restore target.
  try {
    _origShowPortalSection(target);
  } catch (e) {
    try {
      console.error(
        '[router] _origShowPortalSection threw for target=', target,
        'error=', e && (e.stack || e.message || e)
      );
    } catch (e2) {}
  }
  if (target === 'subscription') {
    setTimeout(function () {
      if (typeof _bindSubscriptionControls === 'function') _bindSubscriptionControls();
      if (typeof _initPayPalButton === 'function') _initPayPalButton();
    }, 400);
  }
  try {
    sessionStorage.setItem('ss_portal_tab', target);
    localStorage.setItem('ss_last_section', target);
  } catch (e) {}
  // Show 'courses' in the URL instead of internal name 'studip'
  var urlSection = target === 'studip' ? 'courses' : target;
  _ssPushHistory({ view: 'portal', section: target }, '#portal=' + encodeURIComponent(urlSection));
};

// Skip the initial portal-state replace when we're about to show the auth
// modal — otherwise the URL flashes #portal=dashboard between landing and
// the auth screen before _showModal wipes it.
var _ssSkipBootRoute = false;
try {
  _ssSkipBootRoute = sessionStorage.getItem('ss_show_auth') === 'true';
} catch (e) {}

if (!_ssSkipBootRoute &&
    (!window.location.hash || window.location.hash.indexOf('access_token') === -1)) {
  var _rst = {};
  try {
    _rst = JSON.parse(localStorage.getItem('ss_state') || '{}');
  } catch (e) {}
  if (_rst.inApp && (_rst.view === 'studip' || _rst.view === 'courses')) {
    _ssReplaceHistory({ view: 'courses' }, '#portal=courses');
  } else if (_rst.inApp && _rst.fileName) {
    _ssReplaceHistory(
      {
        view: 'file',
        courseId: _rst.courseId,
        fileName: _rst.fileName,
        section: _rst.section || 'files'
      },
      '#file=' + encodeURIComponent(_rst.fileName)
    );
  } else if (_rst.inApp && _rst.courseId) {
    _ssReplaceHistory(
      { view: 'course', courseId: _rst.courseId, section: _rst.section },
      '#course=' + encodeURIComponent(_rst.courseId)
    );
  } else {
    var _initSec = _pendingPortalRestore || 'dashboard';
    _ssReplaceHistory(
      { view: 'portal', section: _initSec },
      '#portal=' + encodeURIComponent(_initSec)
    );
  }
}

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
  showPortal();
  setNavActive('psbDashboard');
  showPortalSection('dashboard');
  _finalizeNav('dashboard');
});

_bindIf('psbGerman', 'click', function () {
  showPortal();
  setNavActive('psbGerman');
  showPortalSection('german');
  _finalizeNav('german');
  window._glBackToHome();
});

_bindIf('psbProfile', 'click', function () {
  showPortal();
  setNavActive('psbProfile');
  showPortalSection('profile');
  _finalizeNav('profile');
});

_bindIf('psbSettings', 'click', function () {
  showPortal();
  setNavActive('psbSettings');
  showPortalSection('settings');
  _finalizeNav('settings');
});

_bindIf('psbSubscription', 'click', function () {
  showPortal();
  setNavActive('psbSubscription');
  showPortalSection('subscription');
  _finalizeNav('subscription');
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
    }
    if (item.id === 'psbEditor') {
      _navTo('psbEditor', 'editor');
      _finalizeNav('editor');
      if (typeof window._writerInit === 'function') window._writerInit();
      else if (typeof window._editorInit === 'function') window._editorInit();
    }
    if (item.id === 'psbAIPage') {
      _navTo('psbAIPage', 'aipage');
      _finalizeNav('aipage');
      if (typeof window._aipRefreshSidebar === 'function') window._aipRefreshSidebar();
    }
    if (item.id === 'psbChat') {
      _navTo('psbChat', 'chat');
      _finalizeNav('chat');
      _chatInit();
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
