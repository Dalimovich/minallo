import {
  initAskAI,
  addTyping,
  pdfToImages,
  restoreCourseHistory,
  clearCourseHistory,
  resetAiPanelChat,
} from './ai-ask.js';
import { detectIntent, type IntentResult } from './intent-router.js';

// ── Intent-router helpers ────────────────────────────────────────────────────

/** Renders a chat bubble from the assistant with the given text. */
function renderClarificationMessage(question: string): void {
  const aiMsgs = document.getElementById('aiMsgs') || document.querySelector<HTMLElement>('.ai-msgs');
  if (!aiMsgs) return;
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg-wrap';
  wrap.innerHTML =
    '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
    '<div class="msg-body"><div class="ai-bubble bot"></div></div>';
  const bubble = wrap.querySelector<HTMLElement>('.ai-bubble.bot');
  if (bubble) bubble.textContent = question;
  aiMsgs.appendChild(wrap);
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
  // Focus the input so the user can reply immediately.
  const input = document.getElementById('aiInput') as HTMLTextAreaElement | null;
  if (input) input.focus();
}

/** Renders the daily/weekly mission as an inline chat bubble in the message thread. */
function handleMissionIntent(result: IntentResult): void {
  const aiMsgs = document.getElementById('aiMsgs') || document.querySelector<HTMLElement>('.ai-msgs');
  if (!aiMsgs) return;

  const isWeekly = result.intent === 'weekly_mission';

  // Create the assistant message wrapper with a loading state first.
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg-wrap';
  wrap.innerHTML =
    '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
    '<div class="msg-body"><div class="ai-bubble bot dm-intent-bubble"></div></div>';
  const bubble = wrap.querySelector<HTMLElement>('.ai-bubble.bot');
  aiMsgs.appendChild(wrap);
  aiMsgs.scrollTop = aiMsgs.scrollHeight;

  if (isWeekly) {
    // Weekly mission: placeholder until the weekly generate endpoint is wired.
    if (bubble) {
      bubble.innerHTML =
        '<strong>Planning your week across all active subjects…</strong>' +
        '<br><span style="opacity:0.7;font-size:0.9em">Weekly mission generation coming soon.</span>';
    }
    return;
  }

  // Daily mission: mount the full task-card UI directly inside this chat bubble.
  // There is NO separate panel element — the bubble IS the surface.
  const courseId =
    (window as unknown as { activeCourseId?: string }).activeCourseId ||
    (window as unknown as { currentCourseId?: string }).currentCourseId ||
    '';

  if (!courseId) {
    if (bubble) {
      bubble.textContent =
        'Open a course first, then ask me for your daily mission and I\'ll build your study plan from your uploaded files.';
    }
    return;
  }

  if (bubble) bubble.textContent = 'Loading your daily mission…';

  // Replace the bubble with a panel-host div and mount the Daily Mission UI inside it.
  const msgBody = wrap.querySelector<HTMLElement>('.msg-body');
  if (!msgBody) return;
  msgBody.innerHTML = '';
  const host = document.createElement('div');
  host.className = 'dm-panel-host';
  msgBody.appendChild(host);

  import('./../../features/daily-mission/daily-mission-ui.js')
    .then((mod) => {
      const courseTitle =
        (window as unknown as { activeCourseTitle?: string }).activeCourseTitle ||
        (window as unknown as { currentCourseShort?: string }).currentCourseShort ||
        undefined;
      mod.mountDailyMissionPanel(host, courseId, { courseName: courseTitle });
      aiMsgs.scrollTop = aiMsgs.scrollHeight;
    })
    .catch(() => {
      host.textContent = 'Could not load your daily mission. Please try again.';
    });
}

// ── AskAiState ───────────────────────────────────────────────────────────────

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
      // ── Intent router intercept ─────────────────────────────────────────
      // Check for study-planning commands before sending to the AI backend.
      const _w = window as unknown as {
        activeCourseId?: string;
        currentCourseId?: string;
        activeCourseTitle?: string;
        currentCourseShort?: string;
      };
      const intentResult = detectIntent(q, {
        activeCourseId: _w.activeCourseId || _w.currentCourseId,
        activeCourseTitle: _w.activeCourseTitle || _w.currentCourseShort
      });

      if (intentResult.intent === 'daily_mission' || intentResult.intent === 'weekly_mission') {
        // Add the user message bubble first so the conversation reads naturally.
        if (typeof window.addUserMsg === 'function') window.addUserMsg(q);
        handleMissionIntent(intentResult);
        return; // don't send to AI
      }

      if (intentResult.needsClarification) {
        if (typeof window.addUserMsg === 'function') window.addUserMsg(q);
        renderClarificationMessage(intentResult.clarificationQuestion!);
        return; // don't send to AI
      }
      // ── End intent router ───────────────────────────────────────────────

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
  window.resetAiPanelChat = resetAiPanelChat;

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
