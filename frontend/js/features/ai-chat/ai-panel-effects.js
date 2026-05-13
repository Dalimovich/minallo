export function initAiPanelEffects(options) {
    const opts = options || {};
    const aiMsgs = (opts.aiMsgs || document.getElementById('aiMsgs'));
    if (aiMsgs && !aiMsgs.__ssFlashWrapped) {
        const origAppend = aiMsgs.appendChild.bind(aiMsgs);
        aiMsgs.appendChild = function (el) {
            const result = origAppend(el);
            aiMsgs.classList.remove('new-msg');
            void aiMsgs.offsetWidth;
            aiMsgs.classList.add('new-msg');
            setTimeout(() => aiMsgs.classList.remove('new-msg'), 700);
            return result;
        };
        aiMsgs.__ssFlashWrapped = true;
    }
    const aiPanel = (opts.aiPanel || document.getElementById('aiPanel'));
    if (aiPanel && !aiPanel.__ssRippleBound) {
        aiPanel.addEventListener('click', (e) => {
            const target = e.target;
            const btn = target?.closest('button, .ai-tip, .chip-sub, .ai-sel-btn');
            if (!btn)
                return;
            const r = document.createElement('span');
            const rect = btn.getBoundingClientRect();
            const size = Math.max(rect.width, rect.height) * 1.5;
            const mouse = e;
            r.style.cssText =
                'position:absolute;border-radius:50%;background:rgba(255,255,255,.3);width:' + size +
                    'px;height:' + size + 'px;' +
                    'left:' + (mouse.clientX - rect.left - size / 2) +
                    'px;top:' + (mouse.clientY - rect.top - size / 2) + 'px;' +
                    'animation:rippleOut .5s ease forwards;pointer-events:none;z-index:99';
            if (getComputedStyle(btn).position === 'static')
                btn.style.position = 'relative';
            btn.style.overflow = 'hidden';
            btn.appendChild(r);
            setTimeout(() => r.remove(), 520);
        });
        aiPanel.__ssRippleBound = true;
    }
}
//# sourceMappingURL=ai-panel-effects.js.map