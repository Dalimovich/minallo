interface AiPanelEl extends HTMLElement {
  __ssAiPanelBound?: boolean;
  __ssAiCloseBound?: boolean;
  __ssAiLeaveBound?: boolean;
}

interface DocFlag extends Document {
  __ssAiPanelMouseResetBound?: boolean;
}

export interface AiPanelBridgeOptions {
  aiPanel?: HTMLElement | null;
  aiTab?: HTMLElement | null;
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
  const aiTab = (opts.aiTab || document.getElementById('aiTab')) as AiPanelEl | null;
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

  let _aiManualClosed = false;

  function forceCloseAI(): void {
    setAiPinned(false);
    setAiOpen(false);
    if (aiPanel) aiPanel.classList.remove('visible');
    if (aiTab) aiTab.classList.remove('hidden');
  }

  function closeAI(): void {
    if (getAiPinned()) return;
    setAiOpen(false);
    if (aiPanel) aiPanel.classList.remove('visible');
    if (aiTab) aiTab.classList.remove('hidden');
  }

  function openAI(): void {
    setAiOpen(true);
    if (aiPanel) aiPanel.classList.add('visible');
    if (aiTab) aiTab.classList.add('hidden');
    const cid = window.activeCourseId || window.currentCourseId || '';
    if (cid && typeof window.restoreCourseHistory === 'function') {
      window.restoreCourseHistory(cid);
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
      if (!_aiManualClosed) openAI();
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

  const docFlag = document as DocFlag;
  if (!docFlag.__ssAiPanelMouseResetBound) {
    document.addEventListener('mousemove', (e: MouseEvent) => {
      if (!_aiManualClosed) return;
      if (window.innerWidth - e.clientX > 150) _aiManualClosed = false;
    });
    docFlag.__ssAiPanelMouseResetBound = true;
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
