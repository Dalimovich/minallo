import { initAskAI, addTyping, pdfToImages, restoreCourseHistory, clearCourseHistory } from './ai-ask.js';

export function initAiAskBridge(state) {
  // Preserve the vision-capable askAI from ai.js (set before this bridge runs)
  if (typeof window.askAI === 'function' && !window._legacyAskAI) {
    window._legacyAskAI = window.askAI;
  }
  var askAI = initAskAI(state);
  window.askAI = askAI;
  window.addTyping = function () {
    return addTyping();
  };
  window._pdfToImages = pdfToImages;

  function stopGeneration() {
    state.generationStopped = true;
    state.currentGenId++;
    // If a stream is in progress, flush queue and do final markdown+KaTeX render
    if (typeof window._activeStreamRender === 'function') {
      window._activeStreamRender();
      window._activeStreamRender = null;
    }
    if (state.activeTypeTimer) {
      clearTimeout(state.activeTypeTimer);
      state.activeTypeTimer = null;
    }
    if (state.activeThinkTimer) {
      clearInterval(state.activeThinkTimer);
      state.activeThinkTimer = null;
    }
    var btn = document.getElementById('aiSend');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-stop');
    }
  }

  window.stopGeneration = stopGeneration;

  (document.getElementById('aiSend') || { addEventListener: function () {} }).addEventListener(
    'click',
    function () {
      if (this.classList.contains('is-stop')) {
        if (typeof window.stopGeneration === 'function') window.stopGeneration();
        return;
      }
      if (this.disabled) return; // guard: programmatic .click() fires even on disabled buttons
      var input = document.getElementById('aiInput');
      if (!input) return;
      var q = input.value.trim();
      // If images are attached, route through the regular AI (which supports vision)
      // rather than the RAG path which is text-only
      var hasImages = window._attachedImages && window._attachedImages.length > 0;
      if (!q && !hasImages) return;
      input.value = '';
      input.style.height = 'auto';
      var count = document.getElementById('aiCharCount');
      if (count) count.textContent = '0 / 2000';
      if (hasImages) {
        // Use the vision-capable AI path (ai.js askAI handles _attachedImages)
        if (typeof window._legacyAskAI === 'function') {
          window._legacyAskAI(q || 'What do you see in this image?');
        } else {
          askAI(q || 'What do you see in this image?');
        }
      } else {
        askAI(q);
      }
    }
  );

  (document.getElementById('aiInput') || { addEventListener: function () {} }).addEventListener(
    'keydown',
    function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var sendBtn = document.getElementById('aiSend');
        if (sendBtn && !sendBtn.disabled) sendBtn.click();
      }
    }
  );

  (document.getElementById('aiInput') || { addEventListener: function () {} }).addEventListener(
    'input',
    function () {
      var count = document.getElementById('aiCharCount');
      if (count) count.textContent = this.value.length + ' / 2000';
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    }
  );

  window.restoreCourseHistory = restoreCourseHistory;
  window.clearCourseHistory = clearCourseHistory;

  return {
    askAI: askAI,
    stopGeneration: stopGeneration
  };
}
