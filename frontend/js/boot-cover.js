// Minallo boot cover — the ONE owner of "what is on screen before the final
// interface is ready". The cover itself (#minalloBootCover: Minallo logo on the
// page background, nothing else) ships in raw index.html so it is the very
// first painted frame. This script only decides when to remove it.
//
// Ready condition:
//   logged out            → ss-ready fired (landing / auth modal is up)
//   logged in             → ss-ready fired AND profile resolution is 'ready'
//                           AND user_type is 'learner' | 'enrolled' AND the
//                           chatbot shell has applied that role's experience
//                           (#ncbRoot[data-role-resolved="true"])
// Only auth + role are boot-critical; files, chats, saved items etc. load
// inside their own panels after the interface is visible.
(function () {
  var doc = document.documentElement;
  var appReady = false;
  var done = false;
  var unmountedTimer = null;
  var i18n = {
    en: { msg: 'Couldn’t load your account.', retry: 'Retry', out: 'Sign out' },
    de: { msg: 'Dein Konto konnte nicht geladen werden.', retry: 'Erneut versuchen', out: 'Abmelden' },
  };

  function el(id) { return document.getElementById(id); }

  // Non-sensitive boot diagnostics (window.__minalloBootDebug). Timestamps are
  // performance.now() ms; the boot ORDER must always be
  //   authBridgeReadyAt <= ssReadyAt <= enterAppAt <= profileStartedAt
  //   <= profileReadyAt <= interfaceRevealedAt
  var debug = { marks: {} };
  function mark(name) {
    if (debug.marks[name + 'At'] === undefined) debug.marks[name + 'At'] = Math.round(performance.now());
  }
  Object.defineProperties(debug, {
    appModuleReady: { get: function () { return debug.marks.appImportedAt !== undefined; }, enumerable: true },
    authBridgeReady: { get: function () { return debug.marks.authBridgeReadyAt !== undefined; }, enumerable: true },
    authUserReady: { get: function () { return debug.marks.enterAppAt !== undefined; }, enumerable: true },
    profileRequestStarted: { get: function () { return debug.marks.profileStartedAt !== undefined; }, enumerable: true },
    profileState: { get: function () { return window._profileResolutionState || null; }, enumerable: true },
    experienceApplied: { get: function () { var r = el('ncbRoot'); return !!r && r.getAttribute('data-role-resolved') === 'true'; }, enumerable: true },
    bootCoverVisible: { get: function () { return !doc.classList.contains('mn-boot-done'); }, enumerable: true },
  });
  window.__minalloBootDebug = debug;

  function hide() {
    done = true;
    mark('interfaceRevealed');
    if (unmountedTimer) { clearTimeout(unmountedTimer); unmountedTimer = null; }
    doc.classList.add('mn-boot-done');
    var cover = el('minalloBootCover');
    if (cover) cover.setAttribute('aria-hidden', 'true');
  }

  function show() {
    done = false;
    doc.classList.remove('mn-boot-done');
    var cover = el('minalloBootCover');
    if (cover) cover.removeAttribute('aria-hidden');
    var rec = el('minalloBootRecovery');
    if (rec) rec.hidden = true;
  }

  // true = ready, false = keep waiting, 'unmounted' = role known but the
  // chatbot shell has not mounted yet.
  function interfaceState() {
    if (!appReady) return false;
    if (!window._ssIsLoggedIn) return true;
    if (window._profileResolutionState !== 'ready') return false;
    var t = window._userType;
    if (t !== 'learner' && t !== 'enrolled') return false;
    var root = el('ncbRoot');
    if (!root) return 'unmounted';
    return root.getAttribute('data-role-resolved') === 'true';
  }

  function check() {
    if (done) return;
    var s = interfaceState();
    if (s === true) return hide();
    if (s === 'unmounted' && !unmountedTimer) {
      // Chatbot failed to mount at all: don't trap the user behind the logo.
      unmountedTimer = setTimeout(function () { unmountedTimer = null; if (!done && interfaceState() !== false) hide(); }, 4000);
    }
  }

  // Single centralized recovery surface, only after bounded retries fail.
  function recovery(kind) {
    if (done && doc.classList.contains('mn-boot-done')) return;
    var rec = el('minalloBootRecovery');
    if (!rec) return hide();
    var t = i18n[window._lang === 'de' ? 'de' : 'en'];
    rec.querySelector('[data-boot-msg]').textContent = t.msg;
    var retry = rec.querySelector('[data-boot-retry]');
    var out = rec.querySelector('[data-boot-out]');
    retry.textContent = t.retry;
    out.textContent = t.out;
    retry.onclick = function () {
      if (kind === 'profile' && typeof window._ensureUserProfile === 'function') {
        rec.hidden = true;
        window._ensureUserProfile({ force: true });
      } else {
        window.location.reload();
      }
    };
    out.onclick = function () {
      var sb = window._sb;
      var go = function () { window.location.reload(); };
      try {
        var p = sb && sb.auth && sb.auth.signOut && sb.auth.signOut();
        if (p && p.then) p.then(go, go); else go();
      } catch (e) { go(); }
    };
    rec.hidden = false;
  }

  window.addEventListener('ss-ready', function () { mark('ssReady'); appReady = true; check(); });
  window.addEventListener('ss-profile-updated', check);
  window.addEventListener('ss-experience-applied', check);
  window.addEventListener('ss-profile-failed', function () { recovery('profile'); });

  window.MinalloBoot = {
    isReady: function () { return done; },
    mark: mark,
    hide: hide,
    show: show,
    // Auth decided there is no session: the landing / auth modal is the interface.
    signedOut: hide,
    recovery: recovery,
  };
})();
