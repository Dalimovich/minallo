export function initAiPanelBridge(options) {
    const opts = options || {};
    const aiPanel = (opts.aiPanel || document.getElementById('aiPanel'));
    const aiTab = (opts.aiTab || document.getElementById('aiTab'));
    const aiClose = (opts.aiClose || document.getElementById('aiClose'));
    const aiMsgs = opts.aiMsgs || document.getElementById('aiMsgs');
    const getAiPinned = opts.getAiPinned || (() => false);
    const setAiPinned = opts.setAiPinned || (() => undefined);
    const setAiOpen = opts.setAiOpen || (() => undefined);
    const t = opts.t || ((key) => key);
    const escapeHtml = opts.escapeHtml || ((value) => String(value || ''));
    const askAI = opts.askAI ||
        ((prompt) => {
            if (typeof window.askAI === 'function')
                return window.askAI(prompt);
            return undefined;
        });
    let _aiManualClosed = false;
    function forceCloseAI() {
        setAiPinned(false);
        setAiOpen(false);
        if (aiPanel)
            aiPanel.classList.remove('visible');
        if (aiTab)
            aiTab.classList.remove('hidden');
    }
    function closeAI() {
        if (getAiPinned())
            return;
        setAiOpen(false);
        if (aiPanel)
            aiPanel.classList.remove('visible');
        if (aiTab)
            aiTab.classList.remove('hidden');
    }
    function openAI() {
        setAiOpen(true);
        if (aiPanel)
            aiPanel.classList.add('visible');
        if (aiTab)
            aiTab.classList.add('hidden');
        const cid = window.activeCourseId || window.currentCourseId || '';
        if (cid && typeof window.restoreCourseHistory === 'function') {
            window.restoreCourseHistory(cid);
        }
    }
    function pinAI() {
        setAiPinned(true);
    }
    function showSelectionBanner(txt) {
        openAI();
        pinAI();
        if (!aiMsgs)
            return;
        aiMsgs.querySelector('.ai-sel-banner')?.remove();
        const banner = document.createElement('div');
        banner.className = 'ai-sel-banner';
        const explainBtn = document.createElement('button');
        explainBtn.className = 'ai-sel-btn';
        explainBtn.textContent = t('sel_explain');
        const formulaBtn = document.createElement('button');
        formulaBtn.className = 'ai-sel-btn';
        formulaBtn.textContent = t('sel_formula');
        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'ai-sel-dismiss';
        dismissBtn.textContent = t('sel_dismiss');
        const preview = document.createElement('div');
        preview.innerHTML =
            '<b>' + escapeHtml(t('sel_preview')) + '</b><em>"' +
                escapeHtml(txt.slice(0, 120)) + (txt.length > 120 ? '…' : '') + '"</em>';
        const actions = document.createElement('div');
        actions.className = 'ai-sel-actions';
        actions.append(explainBtn, formulaBtn, dismissBtn);
        banner.append(preview, actions);
        explainBtn.addEventListener('click', () => {
            banner.remove();
            askAI('Explain this in detail for an engineering student: "' + txt + '"');
        });
        formulaBtn.addEventListener('click', () => {
            banner.remove();
            askAI('Break down this formula step by step, explain every symbol: "' + txt + '"');
        });
        dismissBtn.addEventListener('click', () => {
            banner.remove();
        });
        aiMsgs.appendChild(banner);
        aiMsgs.scrollTop = aiMsgs.scrollHeight;
    }
    if (aiTab && !aiTab.__ssAiPanelBound) {
        aiTab.addEventListener('click', openAI);
        aiTab.addEventListener('mouseenter', () => {
            if (!_aiManualClosed)
                openAI();
        });
        aiTab.__ssAiPanelBound = true;
    }
    if (aiClose && !aiClose.__ssAiCloseBound) {
        aiClose.addEventListener('click', () => {
            forceCloseAI();
            _aiManualClosed = true;
        });
        aiClose.__ssAiCloseBound = true;
    }
    const docFlag = document;
    if (!docFlag.__ssAiPanelMouseResetBound) {
        document.addEventListener('mousemove', (e) => {
            if (!_aiManualClosed)
                return;
            if (window.innerWidth - e.clientX > 150)
                _aiManualClosed = false;
        });
        docFlag.__ssAiPanelMouseResetBound = true;
    }
    if (aiPanel && !aiPanel.__ssAiLeaveBound) {
        aiPanel.addEventListener('mouseleave', () => {
            if (!getAiPinned())
                setTimeout(closeAI, 600);
        });
        aiPanel.__ssAiLeaveBound = true;
    }
    window.pinAI = pinAI;
    window.showSelectionBanner = showSelectionBanner;
    return { forceCloseAI, closeAI, openAI, pinAI, showSelectionBanner };
}
//# sourceMappingURL=ai-panel-bridge.js.map