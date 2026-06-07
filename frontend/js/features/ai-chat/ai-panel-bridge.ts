interface AiPanelEl extends HTMLElement {
  __ssAiCloseBound?: boolean;
  __ssAiLeaveBound?: boolean;
}

export interface AiPanelBridgeOptions {
  aiPanel?: HTMLElement | null;
  aiClose?: HTMLElement | null;
  aiMsgs?: HTMLElement | null;
  getAiPinned?: () => boolean;
  setAiPinned?: (v: boolean) => void;
  getAiOpen?: () => boolean;
  setAiOpen?: (v: boolean) => void;
  t?: (key: string) => string;
  escapeHtml?: (value: unknown) => string;
  askAI?: (prompt: string) => unknown;
}

export function initAiPanelBridge(options?: AiPanelBridgeOptions): {
  forceCloseAI: () => void;
  closeAI: () => void;
  openAI: () => void;
  pinAI: () => void;
  showSelectionBanner: (txt: string) => void;
} {
  const opts = options || {};

  const aiPanel = (opts.aiPanel || document.getElementById('aiPanel')) as AiPanelEl | null;
  const aiClose = (opts.aiClose || document.getElementById('aiClose')) as AiPanelEl | null;
  const aiMsgs = opts.aiMsgs || document.getElementById('aiMsgs');

  const getAiPinned = opts.getAiPinned || (() => false);
  const setAiPinned = opts.setAiPinned || (() => undefined);
  const setAiOpen = opts.setAiOpen || (() => undefined);
  const t = opts.t || ((key: string) => key);
  const escapeHtml = opts.escapeHtml || ((value: unknown) => String(value || ''));
  const askAI = opts.askAI ||
    ((prompt: string) => {
      if (typeof window.askAI === 'function') return window.askAI(prompt);
      return undefined;
    });

  function forceCloseAI(): void {
    setAiPinned(false);
    setAiOpen(false);
    if (aiPanel) aiPanel.classList.remove('visible');
  }

  function closeAI(): void {
    if (getAiPinned()) return;
    setAiOpen(false);
    if (aiPanel) aiPanel.classList.remove('visible');
  }

  function openAI(): void {
    setAiOpen(true);
    // The legacy free-floating panel is retired: #aiPanel is now only presented
    // docked inside the document-rail drawer, which tags it `dr-host-ai` before
    // mounting (see document-rail.ts mountAiPanel). Outside the rail we must NOT
    // reveal the panel, otherwise stray openAI() callers (course file load, PDF
    // text selection, snip tool) pop the old standalone box back up.
    if (aiPanel && aiPanel.classList.contains('dr-host-ai')) {
      aiPanel.classList.add('visible');
    }
    const cid = window.activeCourseId || window.currentCourseId || '';
    if (cid && typeof window.restoreCourseHistory === 'function') {
      window.restoreCourseHistory(cid);
    }
    if (aiMsgs) {
      requestAnimationFrame(() => { aiMsgs.scrollTop = aiMsgs.scrollHeight; });
    }
  }

  function pinAI(): void {
    setAiPinned(true);
  }

  function showSelectionBanner(txt: string): void {
    openAI();
    pinAI();
    if (!aiMsgs) return;
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
      askAI('Break down this formula step by step, explain every symbol, keep the original form first, then show a simplified or factored final form if that makes it clearer: "' + txt + '"');
    });
    dismissBtn.addEventListener('click', () => {
      banner.remove();
    });

    aiMsgs.appendChild(banner);
    aiMsgs.scrollTop = aiMsgs.scrollHeight;
  }

  if (aiClose && !aiClose.__ssAiCloseBound) {
    aiClose.addEventListener('click', () => {
      forceCloseAI();
    });
    aiClose.__ssAiCloseBound = true;
  }

  if (aiPanel && !aiPanel.__ssAiLeaveBound) {
    aiPanel.addEventListener('mouseleave', () => {
      if (!getAiPinned()) setTimeout(closeAI, 600);
    });
    aiPanel.__ssAiLeaveBound = true;
  }

  window.pinAI = pinAI;
  window.showSelectionBanner = showSelectionBanner;

  return { forceCloseAI, closeAI, openAI, pinAI, showSelectionBanner };
}
