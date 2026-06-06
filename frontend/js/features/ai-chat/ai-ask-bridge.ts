import {
  initAskAI,
  addTyping,
  pdfToImages,
  restoreCourseHistory,
  clearCourseHistory,
} from './ai-ask.js';

interface AskAiState {
  generationStopped: boolean;
  currentGenId: number;
  activeTypeTimer: ReturnType<typeof setTimeout> | null;
  activeThinkTimer: ReturnType<typeof setInterval> | null;
  [k: string]: unknown;
}

export function initAiAskBridge(state: AskAiState): {
  askAI: (q: string) => unknown;
  stopGeneration: () => void;
} {
  // Preserve the vision-capable askAI from ai.js (set before this bridge runs)
  if (typeof window.askAI === 'function' && !window._legacyAskAI) {
    window._legacyAskAI = window.askAI;
  }
  const askAI = initAskAI(state);
  window.askAI = askAI;
  window.addTyping = () => addTyping();
  window._pdfToImages = pdfToImages;

  function stopGeneration(): void {
    state.generationStopped = true;
    state.currentGenId++;
    if (typeof window._abortCurrentStream === 'function') window._abortCurrentStream();
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
      (btn as HTMLButtonElement).disabled = false;
      btn.classList.remove('is-stop');
    }
  }
  window.stopGeneration = stopGeneration;

  const sendBtn = document.getElementById('aiSend');
  sendBtn?.addEventListener('click', function (this: HTMLElement) {
    if (this.classList.contains('is-stop')) {
      if (typeof window.stopGeneration === 'function') window.stopGeneration();
      return;
    }
    if ((this as HTMLButtonElement).disabled) return;
    const input = document.getElementById('aiInput') as HTMLTextAreaElement | null;
    if (!input) return;
    const q = input.value.trim();
    const hasImages = !!(window._attachedImages && window._attachedImages.length > 0);
    if (!q && !hasImages) return;
    input.value = '';
    input.style.height = 'auto';
    const count = document.getElementById('aiCharCount');
    if (count) count.textContent = '0 / 2000';
    if (hasImages) {
      if (typeof window._legacyAskAI === 'function') {
        window._legacyAskAI(q || 'What do you see in this image?');
      } else {
        askAI(q || 'What do you see in this image?');
      }
    } else {
      askAI(q);
    }
  });

  const inputEl = document.getElementById('aiInput') as HTMLTextAreaElement | null;
  inputEl?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const s = document.getElementById('aiSend') as HTMLButtonElement | null;
      if (s && !s.disabled) s.click();
    }
  });
  inputEl?.addEventListener('input', function (this: HTMLTextAreaElement) {
    const count = document.getElementById('aiCharCount');
    if (count) count.textContent = this.value.length + ' / 2000';
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  window.restoreCourseHistory = restoreCourseHistory;
  window.clearCourseHistory = clearCourseHistory;

  // minallo-input forms (the AI asking for a missing value) dispatch
  // 'minallo-ai-input-submit' on submit. On the PDF AI panel we resolve it
  // through askAI so the value rides the existing Problem-Solver context +
  // chat history and the model finishes numerically in a new bubble. Scoped by
  // detail.surface; bound once.
  const _w = window as Window & { _ssAiInputPanelBound?: boolean };
  if (!_w._ssAiInputPanelBound) {
    _w._ssAiInputPanelBound = true;
    document.addEventListener('minallo-ai-input-submit', (ev) => {
      const ce = ev as CustomEvent<{ text?: string; surface?: string }>;
      if (!ce.detail || ce.detail.surface !== 'pdf-panel') return;
      const text = (ce.detail.text || '').trim();
      if (text) askAI(text);
    });
  }

  return { askAI, stopGeneration };
}
