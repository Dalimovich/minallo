import { renderMarkdown } from './ai-markdown.js';

export interface RenderBridgeOptions {
  getWelcomeText?: () => string;
}

export function initAiRenderBridge(options?: RenderBridgeOptions): {
  renderMarkdown: typeof renderMarkdown;
  renderMath: (el: Element | null) => void;
  scheduleKatexRender: () => void;
} {
  const opts = options || {};
  let katexRenderScheduled = false;

  function renderMathIn(el: Element): void {
    if (!el || !window.renderMathInElement) return;
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
    } catch {
      /* swallow KaTeX runtime errors */
    }
  }

  function renderAllMathBubbles(): void {
    document.querySelectorAll('.ai-bubble.bot, .aip-bubble.bot').forEach((el) => {
      // If a long restored answer is only partly rendered, rebuild it from
      // the saved markdown source once KaTeX is available.
      if (el.querySelector('.katex')) {
        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll('.katex').forEach((mathEl) => mathEl.remove());
        const hasRawMath = /\\\(|\\\[|\$\$|\$/.test(clone.textContent || '');
        const raw = (el as HTMLElement).getAttribute('data-raw');
        if (hasRawMath && raw && window.katex) {
          el.innerHTML = renderMarkdown(raw);
        }
        return;
      }
      renderMathIn(el);
    });
  }

  function scheduleKatexRender(): void {
    if (katexRenderScheduled) return;
    if (window.katex && window.renderMathInElement) {
      renderAllMathBubbles();
      return;
    }
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
      .catch((err: unknown) => {
        katexRenderScheduled = false;
        console.warn('KaTeX failed to load:', err);
      });
  }

  function renderMath(el: Element | null): void {
    if (!el) return;
    if (window.renderMathInElement) {
      renderMathIn(el);
      return;
    }
    const ensurePromise = window._ssEnsureKatex?.();
    if (!ensurePromise) return;
    ensurePromise
      .then(() => renderMathIn(el))
      .catch((err: unknown) => console.warn('KaTeX failed to load:', err));
  }

  // Apply syntax highlighting to all <pre><code> blocks under `el`.
  // Lazy-loads highlight.js on first use; runs idempotently (hljs marks
  // elements with `data-highlighted` after processing, so re-runs no-op).
  function highlightCode(el: Element | null): void {
    if (!el) return;
    const blocks = el.querySelectorAll('pre code');
    if (!blocks.length) return;
    const apply = (): void => {
      const hljs = (window as unknown as { hljs?: { highlightElement: (el: Element) => void } }).hljs;
      if (!hljs) return;
      blocks.forEach((block) => {
        if ((block as HTMLElement).dataset.highlighted) return;
        try {
          hljs.highlightElement(block);
        } catch {
          /* swallow hljs errors — leave the block as plain monospace */
        }
      });
    };
    if ((window as unknown as { hljs?: unknown }).hljs) {
      apply();
      return;
    }
    const ensure = (window as unknown as { _ssEnsureHljs?: () => Promise<void> })._ssEnsureHljs;
    if (!ensure) return;
    ensure()
      .then(apply)
      .catch((err: unknown) => console.warn('highlight.js failed to load:', err));
  }

  window._ssScheduleKatexRender = scheduleKatexRender;
  window.renderMarkdown = renderMarkdown;
  window._renderMath = renderMath;
  window._renderCode = highlightCode;
  (window as unknown as { _minalloRenderMarkdownReady?: boolean })._minalloRenderMarkdownReady = true;

  if (typeof opts.getWelcomeText === 'function') {
    setTimeout(() => {
      if (typeof window.addBotMsg === 'function') window.addBotMsg(opts.getWelcomeText!());
    }, 0);
  }

  return { renderMarkdown, renderMath, scheduleKatexRender };
}
