// ── EARLY OAUTH HASH EXTRACTION ───────────────────────────────────────────
// app.js calls _ssReplaceHistory() at top-level, which overwrites the URL hash
// (#access_token=...) with #portal=dashboard BEFORE the ss-ready handler runs.
// We must grab the token NOW — supabase.js loads via <script src> before app.js,
// so the original hash is still intact here.
(function () {
  try {
    var h = window.location.hash;
    if (h && h.indexOf('access_token') !== -1) {
      var hp = new URLSearchParams(h.slice(1));
      var tok = hp.get('access_token');
      var ref = hp.get('refresh_token') || '';
      if (tok) {
        _sbStoreSession(tok, ref);
      }
    }
  } catch (e) {}
})();

// ── Supabase REST client (no SDK needed) ──────────────────────────────────
var _SBCFG = window.MinalloConfig || {};
var SUPA_URL = _SBCFG.supabaseUrl || window._SUPA || '';
var SUPA_KEY = _SBCFG.supabaseAnonKey || window._SAKEY || '';
var _sbToken = null; // access token after login
window._sbToken = null; // expose to window for API clients
var _currentUser = null;
var _sbAuthCallbacks = [];
// Single-flight guard for refreshSession(). Supabase rotates the refresh token
// on every use, so N callers firing N concurrent refreshes with the same stored
// token make all-but-one fail — and the failing path nulls _sbToken + clears the
// stored session. That knocks out in-flight work (e.g. a multi-file upload where
// each _ufUpload awaits _ufEnsureFreshToken). Sharing one in-flight promise means
// concurrent callers get the single successful refresh instead of racing.
var _sbRefreshInFlight = null;
var _SS = window.Minallo;

function _sbStoreSession(accessToken, refreshToken) {
  try {
    // Persistent across tab close — user "stays signed in until they log out"
    // (per product requirement). Previously this wrote to sessionStorage which
    // is volatile per-tab; the result was every new tab forced a re-login.
    sessionStorage.setItem('sb_sess_token', accessToken || '');
    if (refreshToken) localStorage.setItem('sb_sess_refresh', refreshToken);
    // Keep the long-lived refresh token for "stay signed in", but avoid
    // persisting short-lived bearer access tokens across browser restarts.
    localStorage.removeItem('sb_sess_token');
    // Legacy keys from an even earlier scheme — leave the removes for safety.
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_refresh');
  } catch (e) {}
}

function _sbStoredToken() {
  try {
    // Access tokens are tab/session-scoped. Persistent login is restored with
    // the refresh token instead of keeping bearer tokens on disk.
    return (
      sessionStorage.getItem('sb_sess_token') ||
      localStorage.getItem('sb_sess_token') ||
      null
    );
  } catch (e) {
    return null;
  }
}

function _sbStoredRefresh() {
  try {
    return (
      localStorage.getItem('sb_sess_refresh') ||
      sessionStorage.getItem('sb_sess_refresh') ||
      null
    );
  } catch (e) {
    return null;
  }
}

function _sbClearStoredSession() {
  try {
    localStorage.removeItem('sb_sess_token');
    localStorage.removeItem('sb_sess_refresh');
    sessionStorage.removeItem('sb_sess_token');
    sessionStorage.removeItem('sb_sess_refresh');
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_refresh');
  } catch (e) {}
}

// Decode the JWT exp claim to milliseconds. Returns 0 if the token is missing,
// malformed, or the payload doesn't have a numeric exp. Fail-closed: anything
// non-parseable looks expired, which forces a refresh — same fallback the
// pre-existing getUser-then-refresh path used to take after a 403.
function _jwtExpiryMs(tok) {
  try {
    var part = (tok || '').split('.')[1];
    if (!part) return 0;
    var b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var p = JSON.parse(atob(b64));
    return p && typeof p.exp === 'number' ? p.exp * 1000 : 0;
  } catch (e) { return 0; }
}

// 90s buffer covers ~minute of client/server clock skew in either direction
// plus the time the refresh round-trip itself takes. Better one extra refresh
// call than the 403 noise coming back.
var _JWT_SKEW_MS = 90 * 1000;

function _jwtAliveEnough(tok) {
  var exp = _jwtExpiryMs(tok);
  return exp > 0 && (Date.now() + _JWT_SKEW_MS) < exp;
}

function _ssAuth(status, detail) {
  if (!_SS || typeof _SS.setAuth !== 'function') return;
  _SS.setAuth(status, detail || {});
}

function _ssEmit(name, detail) {
  if (!_SS || typeof _SS.emit !== 'function') return;
  _SS.emit(name, detail || {});
}

function _sbHeaders(extra) {
  var h = {
    'Content-Type': 'application/json',
    apikey: SUPA_KEY,
    Authorization: 'Bearer ' + (_sbToken || SUPA_KEY)
  };
  return Object.assign(h, extra || {});
}

// ── AUTH ──────────────────────────────────────────────────────────────────
var _sb = {
  auth: {
    signUp: async function (email, password, redirectTo) {
      var body = { email: email, password: password };
      var url = SUPA_URL + '/auth/v1/signup';
      if (redirectTo) url += '?redirect_to=' + encodeURIComponent(redirectTo);
      var r = await fetch(url, {
        method: 'POST',
        headers: _sbHeaders(),
        body: JSON.stringify(body)
      });
      var d = await r.json();
      return d;
    },
    signIn: async function (email, password) {
      var r = await fetch(SUPA_URL + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: _sbHeaders(),
        body: JSON.stringify({ email: email, password: password })
      });
      var d = await r.json();
      if (d.access_token) {
        _sbToken = d.access_token;
        window._sbToken = _sbToken;
        _currentUser = d.user;
        _ssAuth('signed-in', { source: 'password', user: _currentUser });
        // Always persist — user stays logged in across browser restarts until explicit sign-out
        _sbStoreSession(d.access_token, d.refresh_token || '');
        _sbAuthCallbacks.forEach(function (cb) {
          cb('SIGNED_IN', d);
        });
        if (typeof _enterApp === 'function' && _currentUser) {
          _enterApp(_currentUser);
        }
      }
      return d;
    },
    signOut: function () {
      // Clear local state BEFORE the network call so a failed/offline logout
      // can't leave stale tokens on disk that look "still signed in" on reload.
      // Capture the auth header up front so the best-effort revocation still
      // carries the user's bearer token.
      var logoutHeaders = _sbHeaders();
      _sbToken = null;
      window._sbToken = null;
      _currentUser = null;
      _ssAuth('signed-out', { source: 'signOut' });
      _sbClearStoredSession();
      localStorage.removeItem('ss_state');
      sessionStorage.removeItem('ss_last_active');
      // Chat history, AI-generated study material, drafts and connected-account
      // tokens are private user data. Wipe so a different user signing into the
      // same browser can never see (or use) any of it.
      try {
        var _wipePrefixes = [
          // Per-course AI chat history (course rail).
          'ss_course_qa_',
          // Legacy per-file chat transcripts (storage-service loadChat/saveChat).
          'ss_chat_',
          // Generated summary markdown / cheatsheet pointers per course.
          'minallo_sum_last_',
          'minallo_cs_last_',
          // Per-course file-list caches, counters and progress.
          'ss_uf_cache_',
          'ss_fc_',
          'ss_progress_total_',
          'ss_opened_',
          'ss_lastopen_'
        ];
        var _wipeExact = [
          'ss_stats',
          // Legacy unscoped chatbot store (pre per-uid scoping). The scoped
          // ss_ncb_*:<uid> keys stay — they're namespaced per user id, so a
          // different account can't read them and chats survive a re-login.
          'ss_ncb_chats_v1',
          'ss_ncb_active_v1',
          'ss_ncb_sources_v1',
          'ncb_tutor_mode',
          // Writing-coach drafts are private user text.
          'ss_writing_coach_draft',
          'ss_writing_coach_task',
          'ss_focus_timer_v1',
          'ss_last_section',
          'ss_university',
          'ss_pdfed_recents',
          // Connected music accounts: never leave OAuth tokens behind, or the
          // next account on this browser could control the previous user's
          // Spotify / see their playlists.
          'ss_sp_token',
          'ss_sp_refresh',
          'ss_sp_verifier',
          'ss_yt_playlists'
        ];
        var _qaKeys = [];
        for (var _i = 0; _i < localStorage.length; _i++) {
          var _k = localStorage.key(_i);
          if (!_k) continue;
          var _hit = _wipeExact.indexOf(_k) !== -1;
          for (var _wp = 0; !_hit && _wp < _wipePrefixes.length; _wp++) {
            if (_k.indexOf(_wipePrefixes[_wp]) === 0) _hit = true;
          }
          if (_hit) _qaKeys.push(_k);
        }
        _qaKeys.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
      // Wipe in-memory course state so the next account on this browser
      // doesn't see the previous user's courses (the per-user-id localStorage
      // cache stays — it's already namespaced, just not visible to other UIDs).
      try {
        if (typeof SEMS !== 'undefined' && SEMS) {
          Object.keys(SEMS).forEach(function (sid) { SEMS[sid].courses = []; });
        }
        // Drop the legacy unscoped key in case an older client wrote to it.
        localStorage.removeItem('ss_user_courses');
      } catch (e) {}
      // Profile + course caches keyed by ss_last_uid are read at app boot
      // (app.ts) BEFORE auth resolves. If we leave them behind, the NEXT
      // user signing in on the same browser flashes the previous user's
      // name / courses for a moment. Clear both.
      //
      // Also wipe onboarding answers — both the unscoped legacy keys
      // (ss_user_type/ss_major/ss_vertiefung) and the per-uid variants
      // (ss_user_type_<uid>/ss_german_test_<uid>/ss_german_level_<uid>).
      // These don't directly leak across users since user-data.ts loads the
      // signed-in user's profile from Supabase on next login, but they're
      // stale account data that ought to come off when the user logs out.
      try {
        for (var _pi = localStorage.length - 1; _pi >= 0; _pi--) {
          var _pk = localStorage.key(_pi);
          if (!_pk) continue;
          if (
            _pk.indexOf('profile_cache_') === 0 ||
            _pk.indexOf('ss_user_type_') === 0 ||
            _pk.indexOf('ss_german_test_') === 0 ||
            _pk.indexOf('ss_german_level_') === 0
          ) localStorage.removeItem(_pk);
        }
        localStorage.removeItem('ss_last_uid');
        localStorage.removeItem('ss_user_type');
        localStorage.removeItem('ss_major');
        localStorage.removeItem('ss_vertiefung');
        // Also drop the device-trial marker so a re-login on the same
        // browser doesn't keep "you already used your trial" stuck on.
        localStorage.removeItem('minallo_trial_used');
      } catch (e) {}
      try {
        sessionStorage.removeItem('ss_logged_in');
      } catch (e) {}
      try {
        sessionStorage.removeItem('ss_portal_tab');
      } catch (e) {}
      clearTimeout(_activityTimer);
      _sbAuthCallbacks.forEach(function (cb) {
        cb('SIGNED_OUT', null);
      });
      return fetch(SUPA_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: logoutHeaders
      }).catch(function () {});
    },
    // Send a password-recovery email. Supabase renders the "Reset Password"
    // email template (configured in dashboard) with a magic link to
    // SITE_URL + redirectTo + #access_token=...&type=recovery.
    recover: async function (email, redirectTo) {
      var url = SUPA_URL + '/auth/v1/recover';
      if (redirectTo) url += '?redirect_to=' + encodeURIComponent(redirectTo);
      var r = await fetch(url, {
        method: 'POST',
        headers: _sbHeaders(),
        body: JSON.stringify({ email: email })
      });
      var d = await r.json().catch(function () { return {}; });
      return { ok: r.ok, status: r.status, body: d };
    },
    // Update the password of the currently-authenticated user. Used by the
    // reset-password page after Supabase has set a recovery JWT via the email
    // link redirect.
    updatePassword: async function (newPassword, recoveryToken) {
      var headers = recoveryToken
        ? Object.assign({}, _sbHeaders(), { Authorization: 'Bearer ' + recoveryToken })
        : _sbHeaders();
      var r = await fetch(SUPA_URL + '/auth/v1/user', {
        method: 'PUT',
        headers: headers,
        body: JSON.stringify({ password: newPassword })
      });
      var d = await r.json().catch(function () { return {}; });
      return { ok: r.ok, status: r.status, body: d };
    },
    getUser: function () {
      if (!_sbToken) return Promise.resolve(null);
      return fetch(SUPA_URL + '/auth/v1/user', {
        headers: _sbHeaders()
      })
        .then(function (r) {
          if (!r.ok) return null;
          return r.json();
        })
        .then(function (data) {
          if (!data || data.error || !data.id) return null;
          return data;
        });
    },
    onAuthStateChange: function (cb) {
      _sbAuthCallbacks.push(cb);
    },
    refreshSession: function () {
      // Coalesce concurrent refreshes onto one network round-trip (see
      // _sbRefreshInFlight note above) so parallel callers can't race the
      // refresh-token rotation and clobber each other's session.
      if (_sbRefreshInFlight) return _sbRefreshInFlight;
      var ref = _sbStoredRefresh();
      if (!ref) return Promise.resolve(null);
      _sbRefreshInFlight = fetch(SUPA_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: _sbHeaders(),
        body: JSON.stringify({ refresh_token: ref })
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          if (d.access_token) {
            _sbToken = d.access_token;
            _currentUser = d.user || _currentUser;
            _sbStoreSession(d.access_token, d.refresh_token || ref);
            return _currentUser;
          }
          _sbToken = null;
          _sbClearStoredSession();
          return null;
        })
        .catch(function () {
          return null;
        })
        .finally(function () {
          _sbRefreshInFlight = null;
        });
      return _sbRefreshInFlight;
    },
    restoreSession: function () {
      _ssAuth('checking', { source: 'restoreSession' });
      var token = _sbStoredToken();
      if (!token) {
        if (_sbStoredRefresh()) {
          window._sbSessionReady = _sb.auth.refreshSession().then(function (user) {
            if (user && user.id) return _settle(user, 'refreshSession');
            _ssAuth('signed-out', { source: 'restoreSession' });
            return null;
          });
          return window._sbSessionReady;
        }
        _ssAuth('signed-out', { source: 'restoreSession' });
        window._sbSessionReady = Promise.resolve(null);
        return window._sbSessionReady;
      }
      _sbToken = token;

      function _signedOut() {
        _sbToken = null;
        _sbClearStoredSession();
        _ssAuth('signed-out', { source: 'restoreSession' });
        return null;
      }

      function _settle(user, source) {
        _currentUser = user;
        _ssAuth('signed-in', { source: source, user: user });
        _sbAuthCallbacks.forEach(function (cb) { cb('SIGNED_IN', { user: user }); });
        return user;
      }

      function _attemptGetUser(refreshedAlready) {
        return _sb.auth.getUser().then(function (user) {
          if (user && user.id) return _settle(user, refreshedAlready ? 'refreshSession' : 'restoreSession');
          // Safety net: JWT looked alive but server still rejected. Try refresh
          // exactly once, then give up.
          if (refreshedAlready) return _signedOut();
          return _sb.auth.refreshSession().then(function (refreshedUser) {
            if (refreshedUser && refreshedUser.id) return _settle(refreshedUser, 'refreshSession');
            return _signedOut();
          });
        }).catch(function () {
          if (refreshedAlready) return _signedOut();
          return _sb.auth.refreshSession().then(function (refreshedUser) {
            if (refreshedUser && refreshedUser.id) return _settle(refreshedUser, 'refreshSession');
            return _signedOut();
          });
        });
      }

      if (_jwtAliveEnough(token)) {
        window._sbSessionReady = _attemptGetUser(false);
      } else {
        // Refresh first so we don't fire /auth/v1/user with a dead token.
        window._sbSessionReady = _sb.auth.refreshSession().then(function (user) {
          if (user && user.id) return _settle(user, 'refreshSession');
          // Refresh failed — last-ditch attempt at getUser in case the access
          // token is somehow still good (unlikely, but free).
          return _attemptGetUser(true);
        });
      }
      return window._sbSessionReady;
    }
  },

  // ── DATA (REST API) ──────────────────────────────────────────────────────
  from: function (table) {
    return {
      select: function (cols) {
        return {
          eq: function (col, val) {
            return {
              single: function () {
                return fetch(
                  SUPA_URL +
                    '/rest/v1/' +
                    table +
                    '?select=' +
                    (cols || '*') +
                    '&' +
                    col +
                    '=eq.' +
                    encodeURIComponent(val) +
                    '&limit=1',
                  {
                    headers: Object.assign(_sbHeaders(), { Prefer: 'return=representation' })
                  }
                )
                  .then(function (r) {
                    if (!r.ok) return null;
                    return r.json().then(function (d) {
                      return Array.isArray(d) ? d[0] || null : null;
                    });
                  })
                  .catch(function () {
                    return null;
                  });
              }
            };
          }
        };
      },
      upsert: function (data) {
        return fetch(SUPA_URL + '/rest/v1/' + table, {
          method: 'POST',
          headers: Object.assign(_sbHeaders(), {
            Prefer: 'resolution=merge-duplicates,return=minimal'
          }),
          body: JSON.stringify(data)
        }).then(function (r) {
          return r.ok
            ? { error: null }
            : r.json().then(function (e) {
                return { error: e };
              });
        });
      }
    };
  }
};

console.log('Supabase REST client ready ✓');
// Quick connectivity test
fetch(SUPA_URL + '/auth/v1/health', { headers: { apikey: SUPA_KEY } })
  .then(function (r) {
    console.log('Supabase reachable ✓ status:', r.status);
  })
  .catch(function (e) {
    console.error('Supabase NOT reachable:', e.message);
  });

// ── SESSION PERSISTENCE ──────────────────────────────────────────────────
var _activityTimer = null;

function _resetActivityTimer() {
  // Auto-logout disabled — users stay logged in indefinitely
}

// Track activity
['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(function (ev) {
  document.addEventListener(ev, _resetActivityTimer, { passive: true });
});

// ── Welcome email (first successful login) ─────────────────────────────────
// Fire-and-forget call to the python-ai service, which sends a one-time
// welcome email over Zoho SMTP. Sent-once truth lives in the auth user's
// app_metadata (welcome_email_sent_at), set server-side; the localStorage key
// only avoids repeating the network call on every app entry.
function _maybeSendWelcomeEmail(user) {
  if (!user || !user.id || !user.email) return;
  var key = 'ss_welcome_mail_' + user.id;
  try {
    if (localStorage.getItem(key)) return;
  } catch (e) {}
  if (user.app_metadata && user.app_metadata.welcome_email_sent_at) {
    try { localStorage.setItem(key, '1'); } catch (e) {}
    return;
  }
  var base = window.AI_SERVICE_URL || '';
  if (!base || !_sbToken) return;
  // Defer so this never competes with app boot for bandwidth.
  setTimeout(function () {
    fetch(base + '/welcome-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _sbToken },
      body: JSON.stringify({
        language: window._lang || localStorage.getItem('ss_lang') || 'en'
      })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        // "sent" and "already_sent" both mean: never ask again on this device.
        if (d && (d.sent || d.reason === 'already_sent')) {
          try { localStorage.setItem(key, '1'); } catch (e) {}
        }
      })
      .catch(function () { /* retried on a later login */ });
  }, 4000);
}

// Global auth helpers
function _enterApp(user) {
  _currentUser = user;
  _ssAuth('entering', { source: 'enterApp', user: user });
  if (user && user.email) sessionStorage.removeItem('pendingConfirm');
  if (user && user.id) {
    try {
      localStorage.setItem('ss_last_uid', user.id);
    } catch (e) {}
  }

  // ── Session routing: mark browser session as logged-in ─────────────────
  // _onLoginSuccess (defined in index.html) sets ss_logged_in = 'true' and
  // reloads so loader.js can boot the full app instead of the landing page.
  // Guard: only call it when the flag is not already set, so subsequent
  // _enterApp calls (e.g. activity-timer resets) do NOT trigger extra reloads.
  if (typeof window._onLoginSuccess === 'function') {
    var _alreadyIn = false;
    try {
      _alreadyIn = sessionStorage.getItem('ss_logged_in') === 'true';
    } catch (e) {}
    if (!_alreadyIn) {
      window._onLoginSuccess(); // → sets flag → reloads → loader.js shows app
      return; // stop here; reload re-runs _enterApp with flag set
    }
  }
  // ───────────────────────────────────────────────────────────────────────

  // First-login welcome email. After the routing guard on purpose: the
  // first-ever _enterApp reloads the page immediately (above), which would
  // cancel the deferred request — the post-reload _enterApp lands here.
  _maybeSendWelcomeEmail(user);

  // Sync nightBtn safely — nightOn may not be defined yet if app.js hasn't run
  var _nb = document.getElementById('nightBtn');
  var _nightOn =
    typeof nightOn !== 'undefined' ? nightOn : sessionStorage.getItem('ss_dark') !== '0';
  if (_nb) _nb.textContent = _nightOn ? '☀️' : '🌙';
  var modal = document.getElementById('authModal');
  document.body.classList.add('minallo-app-active');
  if (modal) {
    modal.style.display = 'none';
    modal.style.pointerEvents = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  // Only reset to portal view on the first entry into the app.
  // If the user is already in the app (Stud.IP or files view), a repeated
  // _enterApp call (e.g. from signIn or a silent One Tap refresh) must NOT
  // hide #app and jump the user back to the portal.
  var _inAppAlready = false;
  try {
    _inAppAlready = JSON.parse(localStorage.getItem('ss_state') || '{}').inApp === true;
  } catch (e) {}

  console.log(
    '[Auth] _enterApp: _inAppAlready=',
    _inAppAlready,
    'ss_state=',
    localStorage.getItem('ss_state')
  );
  var _appEl = document.getElementById('app');
  var _portalEl = document.getElementById('portal');
  // Determine which section to restore before anything else changes the state
  var _restoreSec = null;
  try {
    _restoreSec =
      sessionStorage.getItem('ss_portal_tab') || localStorage.getItem('ss_last_section');
  } catch (e) {}
  // If ss_state says the user was inside a file/course view (inApp=true),
  // force _restoreSec='studip' so nav lands on Courses regardless of what
  // ss_portal_tab happens to say — covers entry points (e.g. deep-link to
  // #file=, dashboard-widget course pills before they updated the tab) that
  // bypass the normal showPortalSection path.
  //
  // We deliberately do NOT override for ss_state.view==='studip' alone
  // (courses listing without inApp). That case is fully covered by
  // ss_portal_tab, and overriding here would yank the user back to Courses
  // on every refresh after they navigated to Notes/Editor/Chatbot/etc.
  try {
    var _savedSt = JSON.parse(localStorage.getItem('ss_state') || 'null');
    if (_savedSt && _savedSt.inApp === true) {
      _restoreSec = 'studip';
    }
  } catch (e) {}

  if (!_inAppAlready) {
    if (_appEl) _appEl.style.display = 'none';
    if (_portalEl) {
      _portalEl.classList.add('show');
      _portalEl.style.display = 'block';
      _portalEl.style.opacity = '1';
      _portalEl.style.pointerEvents = 'auto';
      _portalEl.style.zIndex = '200';
    }
  }
  // Always restore the last section, falling back to dashboard
  var _targetSec = _restoreSec && _restoreSec !== 'dashboard' ? _restoreSec : 'dashboard';
  if (typeof setNavActive === 'function')
    setNavActive(
      {
        chat: 'psbChat',
        editor: 'psbEditor',
        notes: 'psbNotes',
        aipage: 'psbAIPage',
        games: 'psbGames',
        lounge: 'psbLounge',
        notifications: 'psbNotifications',
        profile: 'psbProfile',
        settings: 'psbSettings',
        subscription: 'psbSubscription',
        german: 'psbGerman',
        studip: 'pcStudip',
        admin: 'psbAdmin'
      }[_targetSec] || 'psbDashboard'
    );
  if (typeof showPortalSection === 'function') showPortalSection(_targetSec);
  if (typeof window._ssAfterFeature === 'function') {
    window._ssAfterFeature(_targetSec, function () {
      if (_targetSec === 'aipage' && typeof window._aipRefreshSidebar === 'function') window._aipRefreshSidebar();
      if (_targetSec === 'chat' && typeof window._chatInit === 'function') window._chatInit();
      if (_targetSec === 'german' && typeof window._glBackToHome === 'function') window._glBackToHome();
    });
  }
  if (typeof updateAuthIndicator === 'function') updateAuthIndicator(user);
  if (user && typeof loadUserData === 'function') loadUserData(user.id);
  // Hydrate localStorage from DB so study progress & lounge stats survive
  // clearing browser storage. No-op if progress-sync hasn't loaded yet —
  // the ss-ready listener inside progress-sync.ts covers the page-reload path.
  try {
    if (window._progressSync && typeof window._progressSync.loadAndHydrate === 'function') {
      window._progressSync.loadAndHydrate().catch(function () {});
    }
  } catch (e) {}
  _ssAuth('entered', { source: 'enterApp', user: user });
  if (_SS && typeof _SS.markReady === 'function')
    _SS.markReady('auth', { userId: user && user.id });
  _resetActivityTimer();
  // Check DB — new user has no profile row → show onboarding form
  if (user && user.id) {
    var _showOb = function () {
      setTimeout(function () {
        var modal = document.getElementById('onboardModal');
        if (modal) {
          var ef = document.getElementById('obEmail');
          if (ef && user.email) ef.value = user.email;
          modal.style.display = 'flex';
        }
      }, 500);
    };
    // Fast guard: if onboarding was completed this browser, skip fetch
    if (localStorage.getItem('ob_done_' + user.id) === '1') return;
    // Use maybeSingle approach: fetch with limit=1, no error on empty
    fetch(
      SUPA_URL + '/rest/v1/profiles?select=id&id=eq.' + encodeURIComponent(user.id) + '&limit=1',
      {
        headers: Object.assign({
          'Content-Type': 'application/json',
          apikey: SUPA_KEY,
          Authorization: 'Bearer ' + _sbToken
        })
      }
    )
      .then(function (r) {
        return r.json();
      })
      .then(function (rows) {
        var hasProfile = Array.isArray(rows) && rows.length > 0;
        if (hasProfile) {
          localStorage.setItem('ob_done_' + user.id, '1');
        } else {
          _showOb();
        }
      })
      .catch(function () {
        /* on fetch error, don't force onboarding */
      });
  }
}

function _showModal() {
  _sbToken = null;
  window._sbToken = null;
  _currentUser = null;
  _ssAuth('signed-out', { source: 'showModal' });

  _sbClearStoredSession();
  localStorage.removeItem('ss_state');

  sessionStorage.removeItem('ss_last_active');
  sessionStorage.removeItem('ss_logged_in');
  sessionStorage.removeItem('ss_try_saved_login');
  sessionStorage.removeItem('ss_show_auth');
  sessionStorage.removeItem('ss_portal_tab');

  // Wipe any portal-* history state router.js left behind. Otherwise the URL
  // shows #portal=dashboard while the user is on the auth screen, and Back
  // pops to that entry → _ssApplyHistoryState shows the portal without auth.
  try {
    history.replaceState(null, '', window.location.pathname);
  } catch (e) {}

  var modal = document.getElementById('authModal');
  document.body.classList.remove('minallo-app-active');
  if (modal) {
    modal.style.display = 'flex';
    modal.style.pointerEvents = '';
    modal.removeAttribute('aria-hidden');
  }

  var portal = document.getElementById('portal');
  if (portal) {
    portal.classList.remove('show');
    portal.style.display = 'none';
  }

  var appEl = document.getElementById('app');
  if (appEl) appEl.style.display = 'none';
}

// Try to get a fresh access token using the stored refresh token
function _sbRefreshAccessToken() {
  var ref = null;
  try {
    ref = _sbStoredRefresh();
  } catch (e) {}
  if (!ref) return Promise.resolve(null);
  // 5s timeout: this fetch gates the whole boot on refresh. Without a
  // timeout, any Supabase auth slowness (rate-limit, transient outage,
  // proxy hiccup) leaves the user stuck on the splash forever because
  // _verifyAndEnter waits on this promise.
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
  return fetch(SUPA_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
    body: JSON.stringify({ refresh_token: ref }),
    signal: controller ? controller.signal : undefined
  })
    .then(function (r) {
      if (timer) clearTimeout(timer);
      return r.json();
    })
    .then(function (d) {
      if (d && d.access_token) {
        _sbToken = d.access_token;
        window._sbToken = _sbToken;
        _sbStoreSession(d.access_token, d.refresh_token || ref);
        return d.access_token;
      }
      return null;
    })
    .catch(function (err) {
      if (timer) clearTimeout(timer);
      console.warn('[Auth] refresh failed/timed out:', err && err.name);
      return null;
    });
}

function _verifyAndEnter(tok) {
  _ssAuth('checking', { source: 'verifyAndEnter' });
  _ssEmit('auth:verify:start', { hasToken: !!tok });
  _sbToken = tok;
  window._sbToken = tok;

  function _giveUp() {
    _ssAuth('failed', { source: 'verifyAndEnter' });
    _showModal();
  }

  // refreshedAlready: when true, we've burned our one refresh retry. A second
  // getUser failure goes straight to the modal — no infinite loop.
  function _tryGetUser(refreshedAlready) {
    function _onFail() {
      if (refreshedAlready) return _giveUp();
      _sbRefreshAccessToken().then(function (newTok) {
        if (newTok) _tryGetUser(true);
        else _giveUp();
      });
    }
    // 5s timeout: _sb.auth.getUser hits /auth/v1/user and has no built-in
    // timeout. Without this race, any auth endpoint slowness leaves the
    // boot waiting on this promise forever and the splash never hides.
    var timeoutPromise = new Promise(function (_resolve, reject) {
      setTimeout(function () { reject(new Error('getUser timeout')); }, 5000);
    });
    Promise.race([_sb.auth.getUser(), timeoutPromise])
      .then(function (user) {
        if (user && user.id) {
          _ssEmit('auth:verify:success', { userId: user.id, refreshed: refreshedAlready });
          _enterApp(user);
        } else {
          _onFail();
        }
      })
      .catch(function (err) {
        if (err && err.message === 'getUser timeout') {
          console.warn('[Auth] getUser timed out — falling back to sign-in modal');
        }
        _onFail();
      });
  }

  if (_jwtAliveEnough(tok)) {
    // Token looks valid — try getUser straight; refresh-on-fail is the safety net.
    _tryGetUser(false);
  } else {
    // Token is expired (or within the skew buffer). Refresh first so we don't
    // hit /auth/v1/user with a dead token and spam the console with 403s.
    _sbRefreshAccessToken().then(function (newTok) {
      if (newTok) _tryGetUser(true);
      else _giveUp();
    });
  }
}

window.addEventListener('ss-ready', function () {
  _ssEmit('auth:ss-ready', {});
  console.log(
    '[Auth] ss-ready fired. ss_logged_in=',
    sessionStorage.getItem('ss_logged_in'),
    'sb_token=',
    !!_sbStoredToken(),
    'sb_sess_token=',
    !!sessionStorage.getItem('sb_sess_token'),
    'hash=',
    window.location.hash.slice(0, 30)
  );

  function _clearSavedAuth() {
    _sbToken = null;
    window._sbToken = null;
    _currentUser = null;
    _ssAuth('signed-out', { source: 'clearSavedAuth' });

    try {
      _sbClearStoredSession();
      localStorage.removeItem('ss_state');

      sessionStorage.removeItem('ss_last_active');
      sessionStorage.removeItem('ss_logged_in');
      sessionStorage.removeItem('ss_try_saved_login');
      sessionStorage.removeItem('ss_show_auth');
      sessionStorage.removeItem('ss_portal_tab');
    } catch (e) {}
  }

  function _showModalClean() {
    _clearSavedAuth();

    try {
      history.replaceState(null, '', window.location.pathname);
    } catch (e) {}

    var modal = document.getElementById('authModal');
    document.body.classList.remove('minallo-app-active');
    if (modal) {
      modal.style.display = 'flex';
      modal.style.pointerEvents = '';
      modal.removeAttribute('aria-hidden');
    }

    var portal = document.getElementById('portal');
    if (portal) {
      portal.classList.remove('show');
      portal.style.display = 'none';
    }

    var appEl = document.getElementById('app');
    if (appEl) appEl.style.display = 'none';
  }

  var hash = window.location.hash;
  var query = window.location.search;

  var hashToken = null;
  if (hash && hash.indexOf('access_token') !== -1) {
    var hp = new URLSearchParams(hash.slice(1));
    hashToken = hp.get('access_token');
  }

  var queryToken = null;
  var queryType = null;
  if (query) {
    var qp = new URLSearchParams(query);
    queryToken = qp.get('token') || qp.get('token_hash') || qp.get('confirmation_token');
    queryType = qp.get('type');
  }

  if (hashToken) {
    _ssAuth('checking', { source: 'hashToken' });
    console.log('[Auth] → path: hashToken found');
    history.replaceState(null, '', window.location.pathname);
    var ref = new URLSearchParams(hash.slice(1)).get('refresh_token') || '';
    _sbStoreSession(hashToken, ref);
    _verifyAndEnter(hashToken);
    return;
  }

  if (queryToken) {
    _ssAuth('checking', { source: 'queryToken' });
    history.replaceState(null, '', window.location.pathname);
    fetch(SUPA_URL + '/auth/v1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY },
      body: JSON.stringify({ token: queryToken, type: queryType || 'signup' })
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d.access_token) {
          _sbStoreSession(d.access_token, d.refresh_token || '');
          _verifyAndEnter(d.access_token);
        } else {
          _showModalClean();
        }
      })
      .catch(function () {
        _showModalClean();
      });
    return;
  }

  var trySaved = false;
  try {
    trySaved = sessionStorage.getItem('ss_try_saved_login') === 'true';
    if (trySaved) sessionStorage.removeItem('ss_try_saved_login');
  } catch (e) {}

  if (trySaved) {
    _ssAuth('checking', { source: 'trySaved' });
    console.log('[Auth] → path: trySaved');
    var saved = null;
    var sess = null;
    var alive = false;
    var tok = null;

    try {
      saved = null;
      sess = _sbStoredToken();
      tok = saved || sess || null;
    } catch (e) {}

    if (tok) {
      _verifyAndEnter(tok);
    } else {
      _showModalClean();
    }
    return;
  }

  var alreadyIn = false;
  try {
    alreadyIn = sessionStorage.getItem('ss_logged_in') === 'true';
  } catch (e) {}

  if (alreadyIn) {
    _ssAuth('checking', { source: 'alreadyIn' });
    console.log('[Auth] → path: alreadyIn');
    var saved2 = null;
    var sess2 = null;
    var tok2 = null;

    try {
      saved2 = null;
      sess2 = _sbStoredToken();
      tok2 = saved2 || sess2 || null;
    } catch (e) {}

    // Compute from JWT exp instead of leaving a dead literal — the log now
    // tells you whether the token is actually still good.
    var alive2 = _jwtAliveEnough(tok2);

    console.log(
      '[Auth] alreadyIn: saved2=',
      !!saved2,
      'sess2=',
      !!sess2,
      'alive2=',
      alive2,
      'tok2=',
      !!tok2
    );
    if (tok2) {
      _verifyAndEnter(tok2);
    } else {
      console.log('[Auth] alreadyIn but no token → showModalClean');
      _showModalClean();
    }
    return;
  }

  // Login CTA redirect — show the auth modal immediately.
  var showAuth = false;
  try {
    showAuth = sessionStorage.getItem('ss_show_auth') === 'true';
  } catch (e) {}
  if (showAuth) {
    _ssAuth('signed-out', { source: 'showAuth' });
    console.log('[Auth] → path: showAuth → _showModal');
    _showModal();
    return;
  }

  // Session login: verify the in-tab token and enter the app, or fall back to the auth modal.
  var savedTok = null;
  try {
    savedTok = _sbStoredToken();
  } catch (e) {}
  if (savedTok) {
    _ssAuth('checking', { source: 'persistentToken' });
    console.log('[Auth] → path: persistent sb_token restore');
    _verifyAndEnter(savedTok);
    return;
  }
  if (_sbStoredRefresh()) {
    _ssAuth('checking', { source: 'persistentRefresh' });
    console.log('[Auth] persistent refresh restore');
    _sbRefreshAccessToken().then(function (newTok) {
      if (newTok) _verifyAndEnter(newTok);
      else _showModalClean();
    });
    return;
  }

  console.log(
    '[Auth] → path: fallthrough (no action taken) — page will appear blank if full app is loaded'
  );
  _ssAuth('idle', { source: 'fallthrough' });
  // Default startup path: stay on the landing page until the user clicks Login.
});
