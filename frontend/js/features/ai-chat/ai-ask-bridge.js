import { initAskAI, addTyping, pdfToImages, restoreCourseHistory, clearCourseHistory, } from './ai-ask.js';
export function initAiAskBridge(state) {
    // Preserve the vision-capable askAI from ai.js (set before this bridge runs)
    if (typeof window.askAI === 'function' && !window._legacyAskAI) {
        window._legacyAskAI = window.askAI;
    }
    const askAI = initAskAI(state);
    window.askAI = askAI;
    window.addTyping = () => addTyping();
    window._pdfToImages = pdfToImages;
    function stopGeneration() {
        state.generationStopped = true;
        state.currentGenId++;
        if (typeof window._abortCurrentStream === 'function')
            window._abortCurrentStream();
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
        const btn = document.getElementById('aiSend');
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('is-stop');
        }
    }
    window.stopGeneration = stopGeneration;
    const sendBtn = document.getElementById('aiSend');
    sendBtn?.addEventListener('click', function () {
        if (this.classList.contains('is-stop')) {
            if (typeof window.stopGeneration === 'function')
                window.stopGeneration();
            return;
        }
        if (this.disabled)
            return;
        const input = document.getElementById('aiInput');
        if (!input)
            return;
        const q = input.value.trim();
        const hasImages = !!(window._attachedImages && window._attachedImages.length > 0);
        if (!q && !hasImages)
            return;
        input.value = '';
        input.style.height = 'auto';
        const count = document.getElementById('aiCharCount');
        if (count)
            count.textContent = '0 / 2000';
        if (hasImages) {
            if (typeof window._legacyAskAI === 'function') {
                window._legacyAskAI(q || 'What do you see in this image?');
            }
            else {
                askAI(q || 'What do you see in this image?');
            }
        }
        else {
            askAI(q);
        }
    });
    const inputEl = document.getElementById('aiInput');
    inputEl?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const s = document.getElementById('aiSend');
            if (s && !s.disabled)
                s.click();
        }
    });
    inputEl?.addEventListener('input', function () {
        const count = document.getElementById('aiCharCount');
        if (count)
            count.textContent = this.value.length + ' / 2000';
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
    window.restoreCourseHistory = restoreCourseHistory;
    window.clearCourseHistory = clearCourseHistory;
    return { askAI, stopGeneration };
}
//# sourceMappingURL=ai-ask-bridge.js.map