export function initAiPanelBridge(options) {
  options = options || {};

  var aiPanel = options.aiPanel || document.getElementById('aiPanel');
  var aiTab = options.aiTab || document.getElementById('aiTab');
  var aiClose = options.aiClose || document.getElementById('aiClose');
  var aiMsgs = options.aiMsgs || document.getElementById('aiMsgs');
  var getAiPinned =
    options.getAiPinned ||
    function () {
      return false;
    };
  var setAiPinned = options.setAiPinned || function () {};
  var getAiOpen =
    options.getAiOpen ||
    function () {
      return false;
    };
  var setAiOpen = options.setAiOpen || function () {};
  var t =
    options.t ||
    function (key) {
      return key;
    };
  var escapeHtml =
    options.escapeHtml ||
    function (value) {
      return String(value || '');
    };
  var askAI =
    options.askAI ||
    function (prompt) {
      if (typeof window.askAI === 'function') return window.askAI(prompt);
    };

  var _aiManualClosed = false;

  function forceCloseAI() {
    setAiPinned(false);
    setAiOpen(false);
    if (aiPanel) aiPanel.classList.remove('visible');
    if (aiTab) aiTab.classList.remove('hidden');
  }

  function closeAI() {
    if (getAiPinned()) return;
    setAiOpen(false);
    if (aiPanel) aiPanel.classList.remove('visible');
    if (aiTab) aiTab.classList.remove('hidden');
  }

  function openAI() {
    setAiOpen(true);
    if (aiPanel) aiPanel.classList.add('visible');
    if (aiTab) aiTab.classList.add('hidden');
    // Restore previous Q&A for the active course (no-op if panel already has messages)
    var _cid = window.activeCourseId || window.currentCourseId || '';
    if (_cid && typeof window.restoreCourseHistory === 'function') {
      window.restoreCourseHistory(_cid);
    }
  }

  function pinAI() {
    setAiPinned(true);
  }

  function showSelectionBanner(txt) {
    openAI();
    pinAI();
    if (!aiMsgs) return;
    var old = aiMsgs.querySelector('.ai-sel-banner');
    if (old) old.remove();
    var banner = document.createElement('div');
    banner.className = 'ai-sel-banner';
    var explainBtn = document.createElement('button');
    explainBtn.className = 'ai-sel-btn';
    explainBtn.textContent = t('sel_explain');
    var formulaBtn = document.createElement('button');
    formulaBtn.className = 'ai-sel-btn';
    formulaBtn.textContent = t('sel_formula');
    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'ai-sel-dismiss';
    dismissBtn.textContent = t('sel_dismiss');

    var preview = document.createElement('div');
    preview.innerHTML =
      '<b>' +
      escapeHtml(t('sel_preview')) +
      '</b><em>"' +
      escapeHtml(txt.slice(0, 120)) +
      (txt.length > 120 ? '…' : '') +
      '"</em>';

    var actions = document.createElement('div');
    actions.className = 'ai-sel-actions';
    actions.appendChild(explainBtn);
    actions.appendChild(formulaBtn);
    actions.appendChild(dismissBtn);
    banner.appendChild(preview);
    banner.appendChild(actions);

    explainBtn.addEventListener('click', function () {
      banner.remove();
      askAI('Explain this in detail for an engineering student: "' + txt + '"');
    });
    formulaBtn.addEventListener('click', function () {
      banner.remove();
      askAI('Break down this formula step by step, explain every symbol: "' + txt + '"');
    });
    dismissBtn.addEventListener('click', function () {
      banner.remove();
    });

    aiMsgs.appendChild(banner);
    aiMsgs.scrollTop = aiMsgs.scrollHeight;
  }

  if (aiTab && !aiTab.__ssAiPanelBound) {
    aiTab.addEventListener('click', openAI);
    aiTab.addEventListener('mouseenter', function () {
      if (!_aiManualClosed) openAI();
    });
    aiTab.__ssAiPanelBound = true;
  }

  if (aiClose && !aiClose.__ssAiCloseBound) {
    aiClose.addEventListener('click', function () {
      forceCloseAI();
      _aiManualClosed = true;
    });
    aiClose.__ssAiCloseBound = true;
  }

  if (!document.__ssAiPanelMouseResetBound) {
    document.addEventListener('mousemove', function (e) {
      if (!_aiManualClosed) return;
      if (window.innerWidth - e.clientX > 150) _aiManualClosed = false;
    });
    document.__ssAiPanelMouseResetBound = true;
  }

  if (aiPanel && !aiPanel.__ssAiLeaveBound) {
    aiPanel.addEventListener('mouseleave', function () {
      if (!getAiPinned()) setTimeout(closeAI, 600);
    });
    aiPanel.__ssAiLeaveBound = true;
  }

  window.pinAI = pinAI;
  window.showSelectionBanner = showSelectionBanner;

  return {
    forceCloseAI: forceCloseAI,
    closeAI: closeAI,
    openAI: openAI,
    pinAI: pinAI,
    showSelectionBanner: showSelectionBanner
  };
}
