import { renderMarkdown } from './ai-markdown.js';
export function initAiRenderBridge(options) {
    const opts = options || {};
    let katexRenderScheduled = false;
    function renderMathIn(el) {
        if (!el || !window.renderMathInElement)
            return;
        try {
            window.renderMathInElement(el, {
                delimiters: [
                    { left: '\\[', right: '\\]', display: true },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                ],
                ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
                throwOnError: false,
            });
        }
        catch {
            /* swallow KaTeX runtime errors */
        }
    }
    function renderAllMathBubbles() {
        document.querySelectorAll('.ai-bubble.bot, .aip-bubble.bot').forEach((el) => {
            // Skip bubbles already rendered by renderMarkdown — they contain .katex.
            // Re-running renderMathInElement on KaTeX HTML double-processes text.
            if (el.querySelector('.katex'))
                return;
            renderMathIn(el);
        });
    }
    function scheduleKatexRender() {
        if (katexRenderScheduled || (window.katex && window.renderMathInElement))
            return;
        katexRenderScheduled = true;
        const ensurePromise = window._ssEnsureKatex?.();
        if (!ensurePromise) {
            katexRenderScheduled = false;
            return;
        }
        ensurePromise
            .then(() => {
            katexRenderScheduled = false;
            renderAllMathBubbles();
        })
            .catch((err) => {
            katexRenderScheduled = false;
            console.warn('KaTeX failed to load:', err);
        });
    }
    function renderMath(el) {
        if (!el)
            return;
        if (window.renderMathInElement) {
            renderMathIn(el);
            return;
        }
        const ensurePromise = window._ssEnsureKatex?.();
        if (!ensurePromise)
            return;
        ensurePromise
            .then(() => renderMathIn(el))
            .catch((err) => console.warn('KaTeX failed to load:', err));
    }
    window._ssScheduleKatexRender = scheduleKatexRender;
    window.renderMarkdown = renderMarkdown;
    window._renderMath = renderMath;
    if (typeof opts.getWelcomeText === 'function') {
        setTimeout(() => {
            if (typeof window.addBotMsg === 'function')
                window.addBotMsg(opts.getWelcomeText());
        }, 0);
    }
    return { renderMarkdown, renderMath, scheduleKatexRender };
}
//# sourceMappingURL=ai-render-bridge.js.map