// ── CHATBOT PAGE ─────────────────────────────────────────────────────────────
// Minimal dispatcher: fetch the chatbot markup into #psec-aipage and hand
// control to the new shell (frontend/js/features/chatbot-new/shell.ts), which
// is registered on window as initNewChatbotShell via main.js's side-effect
// import. The legacy chatbot lived here as a ~1300-line IIFE; it was removed
// after PR-07 reached functional parity.
(function () {
  var container = document.getElementById('psec-aipage');
  if (!container) return;

  fetch('views/chatbot/chatbot.html')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function (html) {
      container.innerHTML = html;
      if (typeof window.initNewChatbotShell === 'function') {
        window.initNewChatbotShell();
      }
    })
    .catch(function (err) {
      console.error('chatbot.html load failed:', err);
    });
})();
