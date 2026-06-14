// ── CHATBOT PAGE ─────────────────────────────────────────────────────────────
// Minimal dispatcher: fetch the chatbot markup into #psec-aipage and hand
// control to the new shell (frontend/js/features/chatbot-new/shell.ts), which
// registers itself on window as initNewChatbotShell. The shell is ~103 KB so
// we lazy-load it the first time this dispatcher runs (i.e. when the user
// navigates to the chatbot page) instead of pulling it into main.js eagerly.
// The legacy chatbot lived here as a ~1300-line IIFE; it was removed after
// PR-07 reached functional parity.
(function () {
  var container = document.getElementById('psec-aipage');
  if (!container) return;

  // Inject the shell module exactly once. Subsequent navigations just call
  // the already-registered window.initNewChatbotShell. A transient network
  // failure on the script must NOT permanently blank the page: we retry the
  // load a few times, and only on total failure clear the cached promise so a
  // later navigation can try again (instead of reusing a broken resolution).
  var shellPromise = window._ncbShellPromise || (window._ncbShellPromise = new Promise(function (resolve, reject) {
    if (typeof window.initNewChatbotShell === 'function') {
      resolve();
      return;
    }
    // Cache-bust query string. Without this the browser and Cloudflare
    // edge cache the chatbot shell indefinitely, so prompt updates
    // (e.g. MINALLO_APP_CONTEXT) never reach existing users. Bump on
    // every shell-affecting change.
    var av = window.MinalloConfig && window.MinalloConfig.assetVersion ? window.MinalloConfig.assetVersion : '1';
    var attempts = 0;
    function tryLoad() {
      attempts++;
      var s = document.createElement('script');
      s.type = 'module';
      s.src = 'js/features/chatbot-new/shell.js?v=8&av=' + encodeURIComponent(av);
      s.onload = function () { resolve(); };
      s.onerror = function () {
        s.remove();
        if (attempts < 3) {
          setTimeout(tryLoad, 400 * attempts);
        } else {
          console.error('chatbot-new/shell.js failed to load after ' + attempts + ' attempts');
          window._ncbShellPromise = null;
          reject(new Error('shell load failed'));
        }
      };
      document.head.appendChild(s);
    }
    tryLoad();
  }));

  // Re-fetch the markup with a couple of retries if the prewarmed promise is
  // missing or rejected, for the same transient-failure resilience.
  function fetchHtml(retries) {
    return fetch('views/chatbot/chatbot.html').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).catch(function (err) {
      if (retries > 0) {
        return new Promise(function (res) { setTimeout(res, 400); }).then(function () {
          return fetchHtml(retries - 1);
        });
      }
      throw err;
    });
  }
  var htmlPromise = (window._ncbHtmlPromise || Promise.reject()).catch(function () {
    return fetchHtml(2);
  });

  Promise.all([
    htmlPromise,
    shellPromise,
  ])
    .then(function (results) {
      if (!container.querySelector('#ncbRoot')) {
        container.innerHTML = results[0];
      }
      if (typeof window.initNewChatbotShell === 'function') {
        window.initNewChatbotShell();
      } else {
        console.error('initNewChatbotShell missing after shell load');
        // Let a later navigation retry the whole thing rather than stay blank.
        window._ncbShellPromise = null;
      }
    })
    .catch(function (err) {
      console.error('chatbot load failed:', err);
      window._ncbShellPromise = null;
    });
})();
