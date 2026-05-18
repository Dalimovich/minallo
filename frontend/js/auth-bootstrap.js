// Minallo auth/bootstrap shell.
// Runs before supabase.js and loader.js so they can read the boot route.

(function () {
  var loggedIn = false;

  try {
    loggedIn = sessionStorage.getItem('ss_logged_in') === 'true';
  } catch (e) {}

  if (!loggedIn && window.location.hash && window.location.hash.indexOf('access_token') !== -1) {
    loggedIn = true;
  }

  if (!loggedIn) {
    try {
      var qp = new URLSearchParams(window.location.search);
      if (
        qp.get('token') ||
        qp.get('token_hash') ||
        qp.get('confirmation_token') ||
        qp.get('code')
      ) {
        loggedIn = true;
      }
    } catch (e) {}
  }

  if (!loggedIn) {
    try {
      if (sessionStorage.getItem('ss_force_app') === 'true') {
        sessionStorage.removeItem('ss_force_app');
        loggedIn = true;
      }
    } catch (e) {}
  }

  if (!loggedIn) {
    try {
      // Tokens persist in localStorage now (so the user stays signed in
      // across tab close). Fall back to sessionStorage for in-flight
      // sessions from before this code deployed.
      if (localStorage.getItem('sb_sess_token') || sessionStorage.getItem('sb_sess_token')) {
        loggedIn = true;
      }
    } catch (e) {}
  }

  window._ssIsLoggedIn = loggedIn;
  if (window.Minallo) {
    window.Minallo.setState({ bootLoggedIn: loggedIn });
    window.Minallo.emit('auth:boot-route', { loggedIn: loggedIn });
  }

  // Light mode is disabled site-wide (looks broken in the current design).
  // Force night class on regardless of saved preference; ss_dark stays as
  // a no-op key so future re-enable doesn't lose user history.
  try {
    document.body.classList.add('night');
    localStorage.setItem('ss_dark', '1');
  } catch (e) {}

  if (loggedIn) {
    var sp = document.getElementById('ss-splash');
    if (sp) sp.style.display = 'flex';
  }

  // When the user isn't authenticated, the URL must read minallo.de/ only.
  // Wipes any stale #portal=… hash or ?error=… query so the landing + auth
  // modal never display app-route URLs. The app's own router pushes the
  // section hash back after sign-in.
  if (!loggedIn) {
    var hash = window.location.hash;
    var search = window.location.search;
    var hasOAuthHashToken = hash && hash.indexOf('access_token') !== -1;
    if ((hash || search) && !hasOAuthHashToken) {
      try {
        history.replaceState(null, '', window.location.pathname);
      } catch (e) {}
    }
  }
})();

// Back/forward cache (bfcache) defeats every in-memory auth check: Chrome
// restores the cached, authenticated DOM without re-running scripts, so
// _currentUser is still set and history-state restore re-mounts the app.
// Always reload on bfcache restore — small flicker on Back navigation,
// but the dashboard can never reappear post-logout from a cached entry.
window.addEventListener('pageshow', function (e) {
  if (e.persisted) window.location.reload();
});

window._onLoginSuccess = function () {
  try {
    sessionStorage.setItem('ss_logged_in', 'true');
    sessionStorage.setItem('ss_last_active', Date.now());
  } catch (e) {}
  if (window.Minallo) window.Minallo.emit('auth:login-success', {});
  window.location.reload();
};

window._ssHideSplash = function () {
  var sp = document.getElementById('ss-splash');
  if (!sp || sp.style.display === 'none') return;
  sp.classList.add('ss-splash-out');
  setTimeout(function () {
    sp.style.display = 'none';
    sp.classList.remove('ss-splash-out');
  }, 550);
};

var _CFG = window.MinalloConfig || {};
var _GCID = _CFG.googleClientId || window._GCID || '';
var _SUPA = _CFG.supabaseUrl || window._SUPA || '';
var _SAKEY = _CFG.supabaseAnonKey || window._SAKEY || '';

var _REDIRECT = (function () {
  var loc = window.location;
  var path = loc.pathname;
  if (!path.match(/\.html?$/i)) path = path.replace(/\/?$/, '/index.html');
  return loc.origin + path;
})();

function _oauthFallback() {
  window.location.href =
    _SUPA + '/auth/v1/authorize?provider=google&redirect_to=' + encodeURIComponent(_REDIRECT);
}

var _oneTapNonce = null;

function _generateNonce() {
  var arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map(function (b) {
      return b.toString(16).padStart(2, '0');
    })
    .join('');
}

function _sha256hex(str) {
  var buf = new TextEncoder().encode(str);
  return crypto.subtle.digest('SHA-256', buf).then(function (hash) {
    return Array.from(new Uint8Array(hash))
      .map(function (b) {
        return b.toString(16).padStart(2, '0');
      })
      .join('');
  });
}

function _handleGoogleCredential(response) {
  if (window.Minallo) window.Minallo.setAuth('checking', { source: 'google-one-tap' });
  var body = { provider: 'google', id_token: response.credential, gotrue_meta_security: {} };
  if (_oneTapNonce) body.nonce = _oneTapNonce;
  fetch(_SUPA + '/auth/v1/token?grant_type=id_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: _SAKEY },
    body: JSON.stringify(body)
  })
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      if (d && d.access_token) {
        // Persistent across tab close (matches _sbStoreSession in supabase.js).
        localStorage.setItem('sb_sess_token', d.access_token);
        if (d.refresh_token) localStorage.setItem('sb_sess_refresh', d.refresh_token);
        sessionStorage.removeItem('sb_sess_token');
        sessionStorage.removeItem('sb_sess_refresh');
        localStorage.removeItem('sb_token');
        localStorage.removeItem('sb_refresh');
        if (window.Minallo)
          window.Minallo.setAuth('token-received', { source: 'google-one-tap' });
        var alreadyIn = false;
        try {
          alreadyIn = sessionStorage.getItem('ss_logged_in') === 'true';
        } catch (e) {}
        if (!alreadyIn) window._onLoginSuccess();
      } else {
        if (window.Minallo) window.Minallo.setAuth('failed', { source: 'google-one-tap' });
        console.warn('[Auth] id_token exchange failed:', d && (d.error || d.msg));
        _oauthFallback();
      }
    })
    .catch(function (err) {
      if (window.Minallo) window.Minallo.setAuth('failed', { source: 'google-one-tap' });
      console.warn('[Auth] id_token fetch error, falling back to OAuth:', err);
      _oauthFallback();
    });
}

function _initOneTap() {
  var parent = document.getElementById('ss-one-tap-parent');
  if (!parent) {
    parent = document.createElement('div');
    parent.id = 'ss-one-tap-parent';
    parent.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;';
    document.body.appendChild(parent);
  }

  var rawNonce = _generateNonce();
  _oneTapNonce = rawNonce;
  _sha256hex(rawNonce).then(function (hashedNonce) {
    google.accounts.id.initialize({
      client_id: _GCID,
      callback: _handleGoogleCredential,
      context: 'signin',
      cancel_on_tap_outside: false,
      auto_select: false,
      itp_support: true,
      // Required since Chrome's FedCM rollout (Oct 2024). Without this flag
      // Chrome silently suppresses the One Tap prompt — the callback fires
      // with isNotDisplayed() === true and a browser-policy suppression
      // reason. That's why no popup appeared on the landing.
      use_fedcm_for_prompt: true,
      nonce: hashedNonce,
      prompt_parent_id: 'ss-one-tap-parent'
    });

    if (!window._ssIsLoggedIn) {
      google.accounts.id.prompt(function (notification) {
        if (notification.isNotDisplayed()) {
          console.warn('[OneTap] not displayed:', notification.getNotDisplayedReason());
          window._oneTapBlocked = true;
        } else if (notification.isSkippedMoment()) {
          console.log('[OneTap] skipped:', notification.getSkippedReason());
          window._oneTapBlocked = true;
        } else if (notification.isDismissedMoment()) {
          var reason = notification.getDismissedReason();
          console.log('[OneTap] dismissed:', reason);
          if (reason !== 'credential_returned') window._oneTapBlocked = true;
        }
      });
    }
  });
}

window._googleAuth = function () {
  if (window.Minallo)
    window.Minallo.emit('auth:google-start', {
      inAppShell: !!document.getElementById('authModal')
    });

  if (document.getElementById('authModal')) {
    _oauthFallback();
    return;
  }

  if (window._oneTapBlocked) {
    try {
      sessionStorage.setItem('ss_force_app', 'true');
      sessionStorage.setItem('ss_show_auth', 'true');
    } catch (e) {}
    window.location.reload();
    return;
  }

  var showAuthModal = function () {
    try {
      sessionStorage.setItem('ss_force_app', 'true');
      sessionStorage.setItem('ss_show_auth', 'true');
    } catch (e) {}
    window.location.reload();
  };

  var tryOneTap = function () {
    google.accounts.id.prompt(function (notification) {
      if (
        notification.isNotDisplayed() ||
        notification.isSkippedMoment() ||
        (notification.isDismissedMoment() &&
          notification.getDismissedReason() !== 'credential_returned')
      ) {
        window._oneTapBlocked = true;
        showAuthModal();
      }
    });
  };

  if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
    tryOneTap();
    return;
  }

  var attempts = 0;
  var wait = setInterval(function () {
    attempts++;
    if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
      clearInterval(wait);
      tryOneTap();
    } else if (attempts >= 30) {
      clearInterval(wait);
      showAuthModal();
    }
  }, 100);
};

var _gsiTimer = setInterval(function () {
  if (typeof google !== 'undefined' && google.accounts) {
    clearInterval(_gsiTimer);
    _initOneTap();
  }
}, 100);

(function () {
  ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(function (ev) {
    document.addEventListener(
      ev,
      function () {
        try {
          sessionStorage.setItem('ss_last_active', Date.now());
        } catch (e) {}
      },
      { passive: true }
    );
  });
})();
