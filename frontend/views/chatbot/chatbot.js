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
  // the already-registered window.initNewChatbotShell.
  var shellPromise = window._ncbShellPromise || (window._ncbShellPromise = new Promise(function (resolve) {
    if (typeof window.initNewChatbotShell === 'function') {
      resolve();
      return;
    }
    var s = document.createElement('script');
    s.type = 'module';
    // Cache-bust query string. Without this the browser and Cloudflare
    // edge cache the chatbot shell indefinitely, so prompt updates
    // (e.g. MINALLO_APP_CONTEXT) never reach existing users. Bump on
    // every shell-affecting change.
    s.src = 'js/features/chatbot-new/shell.js?v=4';
    s.onload = function () { resolve(); };
    s.onerror = function () {
      console.error('chatbot-new/shell.js failed to load');
      resolve();
    };
    document.head.appendChild(s);
  }));

  Promise.all([
    fetch('views/chatbot/chatbot.html').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }),
    shellPromise,
  ])
    .then(function (results) {
      container.innerHTML = results[0];
      if (typeof window.initNewChatbotShell === 'function') {
        window.initNewChatbotShell();
      } else {
        console.error('initNewChatbotShell missing after shell load');
      }
    })
    .catch(function (err) {
      console.error('chatbot load failed:', err);
    });
})();
