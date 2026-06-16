// New chatbot shell. Flag-gated behind localStorage.ss_new_chatbot === '1'.
// PR-01: hide #aipOuter, reveal #ncbRoot.
// PR-02: sidebar interactivity (collapse, chat-row selection, new chat, search).
// PR-03: conversation (input, send/pause, paste, render, abort).
// PR-04: AI bubble actions, import modal, context tabs, title gen.
// PR-05: chat store + persistence + multi-chat sidebar.
// PR-06: real markdown (KaTeX), file upload (img/.txt/.pdf), real Regenerate.

import { renderMarkdown } from '../ai-chat/ai-markdown.js';
import { attachMessageNavigator } from '../message-navigator/message-navigator.js';
import { handleSourceClick, firstPage } from '../pdf-viewer/source-link.js';
import {
  createAIThinkingStatus,
  getThinkingContext,
  type AIThinkingStatus
} from '../ai-chat/ai-thinking-status.js';
import { routeStudyIntent } from '../ai-chat/intent-router.js';
import { buildPageContext } from '../ai-chat/ai-page-context.js';
import type { DailyMissionPanelHandlers } from '../daily-mission/daily-mission-ui.js';
import {
  generateDailyMission,
  getDailyMission,
  todayLocalDate as _studyServiceToday,
  type DailyMissionResponse
} from '../../services/study-service.js';

/** Returns today's date as YYYY-MM-DD in the local timezone. */
function todayLocalDateStr(): string {
  return _studyServiceToday();
}

/** Tiny i18n wrapper: delegates to window._t (set up by language.ts) and
 * falls back to the English string when the language store isn't ready yet
 * or the key is unknown. Kept private to this module. */
function tStr(key: string, fallback: string): string {
  const w = window as unknown as { _t?: (k: string) => string };
  if (typeof w._t === 'function') {
    const v = w._t(key);
    if (v && v !== key) return v;
  }
  return fallback;
}

function isInternalTechnicalQuestion(text: string): boolean {
  const q = (text || '').toLowerCase();
  if (!q.trim()) return false;
  const probing = /\b(how|what|which|where|why|who|whose|is|are|was|were|does|did|show|tell|explain|describe|list|give|share|reveal|access|debug|bypass|inspect|built?|implemented|stored|connected|works?|configured|using|use[sd]?|powered|runs?|running|made)\b/i;
  if (!probing.test(q)) return false;
  // Tier A — vendor/infra names that are never course subjects: probing
  // about them is always about Minallo's internals.
  const vendorTerms = /\b(gpt[-\w.]*|openai|claude|anthropic|gemini|mistral|llama|supabase|stripe|paypal|cloudflare|netlify|fly\.io|system\s+prompts?|source\s+code|codebase|repositor(y|ies)|repo|tech\s+stack|rls|jwt|api\s+keys?|service\s+role)\b/i;
  if (vendorTerms.test(q)) return true;
  // Tier B — terms that ARE course subjects (databases, SQL, APIs, servers,
  // models… students study these). Internal only when explicitly bound to
  // Minallo itself — bare "explain this function", "what is a vector",
  // "how do SQL joins work" are STUDY questions and must reach the tutor.
  const self = "(minallo(?:'s)?|this\\s+(site|app|website|platform|chatbot|assistant|ai)|the\\s+(site|app|website|platform)|are\\s+you|do\\s+you\\s+(use|run)|you\\s+(use|run|built|made)|built\\s+(on|with)|powered\\s+by)";
  const tech = '(apis?|backend|database|db|schemas?|sql|servers?|endpoints?|secrets?|rag|embeddings?|prompts?|architecture|implementation|migrations?|auth(entication)?|webhooks?|infrastructure|hosting|llms?|(ai|language)\\s+models?|models?|workers?)';
  const bound = new RegExp(
    '\\b' + self + '\\b[\\s\\S]{0,48}\\b' + tech + '\\b|\\b' + tech + '\\b[\\s\\S]{0,48}\\b' + self + '\\b', 'i'
  );
  return bound.test(q);
}

function technicalRefusal(): string {
  return tStr(
    'ai_refuse_technical',
    "I can't help with technical or internal implementation details about Minallo. I can still help you study from your course material, create revision notes, quiz you, or explain a topic step by step."
  );
}

export function initNewChatbotShell(): void {
  const newRoot = document.getElementById('ncbRoot') as HTMLElement | null;
  if (!newRoot) return;

  newRoot.hidden = false;
  newRoot.style.display = '';

  loadChatStore(); // PR-05 — must run before rendering sidebar or conversation.

  initSidebar(newRoot);
  initConversation(newRoot);
  initMessageNavigator(newRoot);
  initScrollToBottom(newRoot);
  initImportModal(newRoot);
  initContextTabs(newRoot);
  initContextCollapse(newRoot);
  initUploads(newRoot);
  initAiTools(newRoot);
  initClearAll(newRoot);
  initTextareaAutoSize(newRoot);
  initActionCards(newRoot);
  initKeyboardShortcuts(newRoot);
  initTutorModes(newRoot);
  initSourceControls(newRoot);
  initFullbleed();

  renderSidebar(newRoot);
  loadActiveChatIntoCenter(newRoot);
  consumePracticeSeed(newRoot);

  // The chatbot view is injected into the DOM after the global applyLanguage()
  // pass on page load, so its data-i18n nodes haven't been translated yet.
  // Re-run applyLanguage now so all data-i18n / data-i18n-ph / data-i18n-title
  // / data-i18n-aria nodes inside chatbot.html get their localized strings.
  // Also re-translate on live language switch via the minallo:lang-changed event.
  applyChatbotI18n(newRoot);
  if (!(window as unknown as { _ncbLangBound?: boolean })._ncbLangBound) {
    (window as unknown as { _ncbLangBound?: boolean })._ncbLangBound = true;
    window.addEventListener('minallo:lang-changed', () => {
      const root = document.getElementById('ncbRoot') as HTMLElement | null;
      if (root) applyChatbotI18n(root);
    });
  }
}

function applyChatbotI18n(root: HTMLElement): void {
  // Scoped translation pass over the chatbot root only. We avoid calling
  // window.applyLanguage here because it dispatches `minallo:lang-changed`
  // and would loop our own listener.
  const w = window as unknown as { _t?: (k: string) => string };
  const tr = typeof w._t === 'function' ? w._t : null;
  if (tr) {
    root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (key) {
        const v = tr(key);
        if (v !== key) el.textContent = v;
      }
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-ph]').forEach((el) => {
      const key = el.getAttribute('data-i18n-ph');
      if (key) {
        const v = tr(key);
        if (v !== key) (el as HTMLInputElement).placeholder = v;
      }
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (key) {
        const v = tr(key);
        if (v !== key) el.setAttribute('title', v);
      }
    });
    root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      if (key) {
        const v = tr(key);
        if (v !== key) el.setAttribute('aria-label', v);
      }
    });
  }
  // Tutor-mode pill labels are owned by initTutorModes (data-label-de/en),
  // not by data-i18n. Refresh them whenever the language changes.
  const useDe = (localStorage.getItem('ss_lang') || 'en') === 'de';
  root.querySelectorAll<HTMLButtonElement>('.ncb-tutor-mode').forEach((pill) => {
    const labelEl = pill.querySelector<HTMLElement>('.ncb-tutor-mode-label');
    if (!labelEl) return;
    const de = pill.getAttribute('data-label-de') || '';
    const en = pill.getAttribute('data-label-en') || labelEl.textContent || '';
    labelEl.textContent = useDe ? de : en;
  });
  // Sidebar section labels, chat meta (timestamps + counts), 'New chat'
  // sentinel titles, and the active-chat header all need a re-render so
  // their dynamic text picks up the new language. Guarded — early mount
  // calls happen before the store is loaded.
  try {
    if (chatStore && Array.isArray(chatStore.chats)) {
      renderSidebar(root);
      const headerTitle = root.querySelector<HTMLElement>('.ncb-chat-header-title');
      if (headerTitle) headerTitle.textContent = displayChatTitle(chatStore.getActive().title);
    }
  } catch { /* ignore — store not ready */ }
}

// Phase 3: the dashboard "Practice this" button writes a seed into
// sessionStorage and navigates to the chatbot. On every chatbot mount we
// drain that seed once: switch tutor mode to quiz, prefill the textarea
// with the seeded prompt, focus it. We deliberately do NOT auto-send —
// the student can edit the prompt or just hit Enter.
function consumePracticeSeed(root: HTMLElement): void {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem('ss_practice_seed'); } catch { return; }
  if (!raw) return;
  try { sessionStorage.removeItem('ss_practice_seed'); } catch { /* ignore */ }

  let seed: { topic?: string; prompt?: string } | null = null;
  try { seed = JSON.parse(raw); } catch { return; }
  const prompt = (seed && typeof seed.prompt === 'string' ? seed.prompt : '').trim();
  if (!prompt) return;

  // Force quiz mode so the streamed response is an MCQ on the seeded topic.
  currentTutorMode = 'quiz';
  _writeStoredTutorMode('quiz');
  root.querySelectorAll<HTMLButtonElement>('.ncb-tutor-mode').forEach((p) => {
    p.setAttribute('aria-pressed', p.getAttribute('data-mode') === 'quiz' ? 'true' : 'false');
  });

  const textarea = root.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
  if (!textarea) return;
  textarea.value = prompt;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  // Slight delay to win against any late layout pass that resets focus.
  setTimeout(() => { textarea.focus(); textarea.setSelectionRange(prompt.length, prompt.length); }, 0);
}

// PR-02 — sidebar behavior. Idempotent: each binding tags the node with
// data-ncb-bound so we don't double-bind across repeat init calls.

function initSidebar(root: HTMLElement): void {
  const sidebar = root.querySelector<HTMLElement>('.ncb-sidebar');
  if (!sidebar) return;

  bindCollapse(sidebar);
  bindChatItems(sidebar);
  bindNewChat(sidebar);
  bindSearch(sidebar);
}

function bindCollapse(sidebar: HTMLElement): void {
  const btn = sidebar.querySelector<HTMLButtonElement>('.ncb-collapse-btn');
  if (!btn || btn.dataset.ncbBound === '1') return;
  btn.dataset.ncbBound = '1';
  btn.addEventListener('click', () => {
    const collapsed = sidebar.dataset.collapsed === 'true';
    setCollapsed(sidebar, !collapsed);
  });
}

function setCollapsed(sidebar: HTMLElement, collapsed: boolean): void {
  sidebar.dataset.collapsed = collapsed ? 'true' : 'false';
}

function bindChatItems(sidebar: HTMLElement): void {
  const list = sidebar.querySelector<HTMLElement>('.ncb-chat-list');
  if (!list || list.dataset.ncbBound === '1') return;
  list.dataset.ncbBound = '1';

  // Event delegation: re-renders of the list (PR-05) keep the binding alive.
  list.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    // PR-10: three-dots → open chat-row menu instead of selecting the chat.
    const moreBtn = target.closest<HTMLElement>('.ncb-chat-more');
    if (moreBtn) {
      ev.stopPropagation();
      const ownerItem = moreBtn.closest<HTMLElement>('.ncb-chat-item');
      const ownerId = ownerItem?.dataset.chatId;
      const root = sidebar.closest<HTMLElement>('.ncb-root');
      if (ownerId && root) openChatRowMenu(root, ownerId, moreBtn);
      return;
    }

    const item = target.closest<HTMLElement>('.ncb-chat-item');
    if (!item) return;

    if (sidebar.dataset.collapsed === 'true') setCollapsed(sidebar, false);

    const chatId = item.dataset.chatId;
    const root = sidebar.closest<HTMLElement>('.ncb-root');
    if (chatId && root) {
      switchActiveChat(root, chatId);
    } else {
      selectChatItem(list, item);
    }
  });
}

function selectChatItem(list: HTMLElement, item: HTMLElement): void {
  list.querySelectorAll<HTMLElement>('.ncb-chat-item').forEach((el) => {
    el.classList.remove('ncb-chat-item--active');
  });
  item.classList.add('ncb-chat-item--active');
}

function bindNewChat(sidebar: HTMLElement): void {
  const btn = sidebar.querySelector<HTMLButtonElement>('.ncb-new-chat-btn');
  if (!btn || btn.dataset.ncbBound === '1') return;
  btn.dataset.ncbBound = '1';

  btn.addEventListener('click', () => {
    if (sidebar.dataset.collapsed === 'true') setCollapsed(sidebar, false);

    const root = sidebar.closest<HTMLElement>('.ncb-root');
    if (!root) return;

    // PR-05: de-dupe — if there's already an empty draft chat, just switch to it
    // instead of creating a second one (matches the React preview's handleNewChat).
    const existingDraft = chatStore.chats.find(
      (c) => c.messages.length === 0 && c.title === 'New chat'
    );
    if (existingDraft) {
      switchActiveChat(root, existingDraft.id);
      return;
    }

    const created = chatStore.newChat();
    chatStore.activeId = created.id;
    saveChatStore();
    renderSidebar(root);
    loadActiveChatIntoCenter(root);
  });
}

function bindSearch(sidebar: HTMLElement): void {
  const input = sidebar.querySelector<HTMLInputElement>('.ncb-search-input');
  const list = sidebar.querySelector<HTMLElement>('.ncb-chat-list');
  if (!input || !list || input.dataset.ncbBound === '1') return;
  input.dataset.ncbBound = '1';

  let searchRaf = 0;
  input.addEventListener('input', () => {
    if (searchRaf) window.cancelAnimationFrame(searchRaf);
    searchRaf = window.requestAnimationFrame(() => {
      searchRaf = 0;
      const q = input.value.trim().toLowerCase();
      const items = list.querySelectorAll<HTMLElement>('.ncb-chat-item');
      items.forEach((item) => {
        const text =
          item.dataset.searchText ||
          (item.querySelector<HTMLElement>('.ncb-chat-title')?.textContent || '').toLowerCase();
        item.dataset.searchText = text;
        item.style.display = !q || text.includes(q) ? '' : 'none';
      });

      // Hide section labels whose section has no visible items.
      const labels = list.querySelectorAll<HTMLElement>('.ncb-chat-section-label');
      labels.forEach((label) => {
        let visible = 0;
        let sib = label.nextElementSibling as HTMLElement | null;
        while (sib && !sib.classList.contains('ncb-chat-section-label')) {
          if (sib.classList.contains('ncb-chat-item') && sib.style.display !== 'none') visible++;
          sib = sib.nextElementSibling as HTMLElement | null;
        }
        label.style.display = visible === 0 ? 'none' : '';
      });
    });
  });
}

// ============ Tutor-mode pills (phase 1) ============
//
// Three pills above the composer: Solve with me / Explain / Quiz me.
// The selected mode is forwarded to /ask-stream as `tutorMode`. Default is
// 'explain' so ordinary questions receive direct grounded answers. Persisted in
// localStorage so the choice survives reloads but never spans logins.

type TutorMode = 'explain' | 'solve' | 'quiz';
type SourceMode = 'auto' | 'course_files' | 'internet';
type CourseFileScope = 'all_course_files' | 'specific_files';
const TUTOR_MODE_STORAGE_KEY = 'ncb_tutor_mode';
const TUTOR_MODE_MIGRATION_KEY = 'ncb_tutor_mode_direct_default_v1';
const TUTOR_MODE_DEFAULT: TutorMode = 'explain';
let currentTutorMode: TutorMode = TUTOR_MODE_DEFAULT;
let messageRenderRun = 0;
let sidebarRenderRun = 0;
let activeChatLoadRaf: number | null = null;
let suppressMessageAutoScroll = false;
// Bumped on every chat (re)load; pending settle-scroll passes carry the token
// they were scheduled with and bail if a newer load — or the user's own scroll
// — has superseded them. Lets us land on the bottom even after async KaTeX /
// image reflow grows the content past the initial scroll.
let chatScrollSettleToken = 0;

function _readStoredTutorMode(): TutorMode {
  try {
    const v = localStorage.getItem(TUTOR_MODE_STORAGE_KEY);
    if (v === 'solve' && localStorage.getItem(TUTOR_MODE_MIGRATION_KEY) !== '1') {
      localStorage.setItem(TUTOR_MODE_STORAGE_KEY, TUTOR_MODE_DEFAULT);
      localStorage.setItem(TUTOR_MODE_MIGRATION_KEY, '1');
      return TUTOR_MODE_DEFAULT;
    }
    if (v === 'explain' || v === 'solve' || v === 'quiz') return v;
  } catch { /* ignore */ }
  return TUTOR_MODE_DEFAULT;
}

function _writeStoredTutorMode(m: TutorMode): void {
  try { localStorage.setItem(TUTOR_MODE_STORAGE_KEY, m); } catch { /* ignore */ }
}

function _preferGerman(): boolean {
  // Profile-driven when available, else fall back to navigator. We treat any
  // de-* locale as German.
  const profileLang = (window as unknown as { _userProfile?: { language?: string } })._userProfile?.language;
  const lang = String(profileLang || navigator.language || '').toLowerCase();
  return lang.startsWith('de');
}

function initTutorModes(root: HTMLElement): void {
  const container = root.querySelector<HTMLElement>('.ncb-tutor-modes');
  if (!container || container.dataset.ncbBound === '1') return;
  container.dataset.ncbBound = '1';

  currentTutorMode = _readStoredTutorMode();
  const useDe = _preferGerman();

  const pills = Array.from(container.querySelectorAll<HTMLButtonElement>('.ncb-tutor-mode'));
  pills.forEach((pill) => {
    const labelEl = pill.querySelector<HTMLElement>('.ncb-tutor-mode-label');
    if (labelEl) {
      const de = pill.getAttribute('data-label-de') || '';
      const en = pill.getAttribute('data-label-en') || labelEl.textContent || '';
      labelEl.textContent = useDe ? de : en;
    }
    const mode = pill.getAttribute('data-mode') as TutorMode | null;
    pill.setAttribute('aria-pressed', mode === currentTutorMode ? 'true' : 'false');
    pill.addEventListener('click', () => {
      const next = pill.getAttribute('data-mode') as TutorMode | null;
      if (!next || next === currentTutorMode) return;
      currentTutorMode = next;
      _writeStoredTutorMode(next);
      pills.forEach((p) => {
        p.setAttribute('aria-pressed', p.getAttribute('data-mode') === next ? 'true' : 'false');
      });
    });
  });
}

function getCurrentTutorMode(): TutorMode {
  return currentTutorMode;
}

function normaliseSourceMode(v: unknown): SourceMode {
  return v === 'course_files' || v === 'internet' || v === 'auto' ? v : 'auto';
}

function normaliseCourseFileScope(v: unknown): CourseFileScope {
  return v === 'specific_files' || v === 'all_course_files' ? v : 'all_course_files';
}

function sourceModeForActiveChat(): SourceMode {
  return normaliseSourceMode(chatStore.getActive().sourceMode);
}

function courseFileScopeForActiveChat(): CourseFileScope {
  return normaliseCourseFileScope(chatStore.getActive().courseFileScope);
}

// The popup is position:fixed (so the composer's overflow:hidden can't clip
// it), which means we place it by hand relative to the trigger: above it,
// right-aligned, falling back to below when there's no room above.
function positionSourcePopup(control: HTMLElement): void {
  const trigger = control.querySelector<HTMLButtonElement>('.ncb-source-trigger');
  const popup = control.querySelector<HTMLElement>('.ncb-source-popup');
  if (!trigger || !popup) return;
  const r = trigger.getBoundingClientRect();
  const pw = popup.offsetWidth;
  const ph = popup.offsetHeight;
  const margin = 8;
  let left = r.right - pw;
  if (left < margin) left = margin;
  const maxLeft = window.innerWidth - pw - margin;
  if (left > maxLeft) left = Math.max(margin, maxLeft);
  let top = r.top - ph - margin;
  if (top < margin) top = r.bottom + margin; // not enough room above → below
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

function setSourcePopupOpen(control: HTMLElement, open: boolean): void {
  control.dataset.open = open ? 'true' : 'false';
  const trigger = control.querySelector<HTMLButtonElement>('.ncb-source-trigger');
  const popup = control.querySelector<HTMLElement>('.ncb-source-popup');
  if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!popup) return;
  popup.hidden = !open;
  // Measure-then-place: it must be visible (not [hidden]) to have a size.
  if (open) positionSourcePopup(control);
}

function updateSourceControls(root: HTMLElement): void {
  const active = chatStore.getActive();
  const mode = normaliseSourceMode(active.sourceMode);
  const scope = normaliseCourseFileScope(active.courseFileScope);
  let activeModeLabel = '';
  root.querySelectorAll<HTMLButtonElement>('.ncb-source-mode').forEach((btn) => {
    const on = btn.dataset.sourceMode === mode;
    btn.classList.toggle('ncb-source-mode--active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) activeModeLabel = (btn.textContent || '').trim();
  });
  root.querySelectorAll<HTMLButtonElement>('.ncb-course-scope').forEach((btn) => {
    const on = btn.dataset.courseFileScope === scope;
    btn.classList.toggle('ncb-course-scope--active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  // Reflect the current mode on the collapsed trigger, and hide the file-scope
  // section when Internet mode is selected (no course files involved then).
  const label = root.querySelector<HTMLElement>('.ncb-source-trigger-label');
  if (label) label.textContent = activeModeLabel || 'Auto';
  const scopeSection = root.querySelector<HTMLElement>('.ncb-source-scope-section');
  if (scopeSection) scopeSection.hidden = mode === 'internet';
}

function initSourceControls(root: HTMLElement): void {
  const control = root.querySelector<HTMLElement>('.ncb-source-control');
  if (!control || control.dataset.ncbBound === '1') return;
  control.dataset.ncbBound = '1';

  const trigger = control.querySelector<HTMLButtonElement>('.ncb-source-trigger');
  trigger?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setSourcePopupOpen(control, control.dataset.open !== 'true');
  });

  control.querySelectorAll<HTMLButtonElement>('.ncb-source-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chat = chatStore.getActive();
      chat.sourceMode = normaliseSourceMode(btn.dataset.sourceMode);
      chat.updatedAt = Date.now();
      saveChatStore();
      updateSourceControls(root);
      // Picking a source is the primary action — close the drop-up after it.
      setSourcePopupOpen(control, false);
    });
  });
  control.querySelectorAll<HTMLButtonElement>('.ncb-course-scope').forEach((btn) => {
    btn.addEventListener('click', () => {
      const chat = chatStore.getActive();
      chat.courseFileScope = normaliseCourseFileScope(btn.dataset.courseFileScope);
      chat.updatedAt = Date.now();
      saveChatStore();
      updateSourceControls(root);
    });
  });

  // Close on outside click / Escape. Bound once on document; guarded by the
  // open state so it's a cheap no-op otherwise.
  document.addEventListener('click', (ev) => {
    if (control.dataset.open !== 'true') return;
    if (!control.contains(ev.target as Node)) setSourcePopupOpen(control, false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && control.dataset.open === 'true') setSourcePopupOpen(control, false);
  });

  // The popup is position:fixed, so re-place it if the viewport shifts while
  // it's open (scrolling the message list, resizing the window).
  const reposition = (): void => {
    if (control.dataset.open === 'true') positionSourcePopup(control);
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  updateSourceControls(root);
}

// ============ PR-03: Conversation (input, send, paste, render, abort) ============

interface PastedImage {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string; // full "data:image/...;base64,..." — used for preview and to derive raw base64
}

interface PendingFile {
  id: string;
  name: string;
  kind: 'image' | 'text' | 'binary';
  mediaType?: string; // for image
  base64?: string; // for image
  textContent?: string; // for text/extracted-pdf
  /** Scanned/image-only PDFs have no text layer — the first pages are
   *  rendered to JPEGs instead so the model can read them visually. */
  pageImages?: Array<{ mediaType: string; base64: string }>;
  size?: number;
}

interface MissionMarker {
  type: 'daily_mission';
  courseId: string;
  date: string; // YYYY-MM-DD local date at creation time
}

/** A cheatsheet/summary generated in this chat. The full markdown rides on the
 *  assistant message so follow-up questions ("explain the cheatsheet you just
 *  created") can hand the content back to the model — the visible reply only
 *  says "Your cheatsheet is ready", which gives the AI nothing to explain. */
interface GeneratedDoc {
  kind: 'cheatsheet' | 'summary';
  title: string;
  markdown: string;
  courseId: string;
  noteId?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  images?: PastedImage[];
  files?: PendingFile[];
  selectedSourceMode?: SourceMode;
  sourceScope?: string;
  sourceLabel?: string;
  courseFileScope?: CourseFileScope;
  sources?: SrcItem[];
  /** Lightweight marker stored instead of the serialised mission HTML.
   *  On history replay the mission panel is re-fetched and re-rendered fresh. */
  missionMarker?: MissionMarker;
  /** Set on the "Your cheatsheet/summary is ready" assistant reply. */
  generatedDoc?: GeneratedDoc;
  /** Chatbot-only gate: diagram fences render only for answers whose user turn
   *  explicitly asked for a diagram/visual artifact. */
  allowDiagrams?: boolean;
}

interface ConversationState {
  messages: ChatMessage[];
  pasted: PastedImage[];
  files: PendingFile[];
  controller: AbortController | null;
  isSending: boolean;
}

function initConversation(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>('.ncb-empty');
  const textarea = root.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
  const sendBtn = root.querySelector<HTMLButtonElement>('.ncb-send-btn');
  const pasteRow = root.querySelector<HTMLElement>('.ncb-paste-row');
  const msgs = root.querySelector<HTMLElement>('.ncb-msgs');
  if (!stage || !textarea || !sendBtn || !pasteRow || !msgs) return;
  if (stage.dataset.ncbConvBound === '1') return;
  stage.dataset.ncbConvBound = '1';

  // PR-05: state.messages is initialised to the active chat's messages array
  // by reference, and re-pointed on chat switch by loadActiveChatIntoCenter.
  // Pasted images / controller / isSending are transient and reset per chat.
  const state = getOrInitLiveState();
  state.messages = chatStore.getActive().messages;
  liveState = state;

  // Send / pause toggle
  sendBtn.addEventListener('click', () => {
    if (state.isSending) {
      abortSend(state);
    } else {
      void doSend(state, stage, textarea, sendBtn, pasteRow, msgs);
    }
  });

  // Enter to send (Shift+Enter = newline)
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      if (!state.isSending) {
        void doSend(state, stage, textarea, sendBtn, pasteRow, msgs);
      }
    }
  });

  // Interactive missing-value forms (minallo-input) dispatch this event when
  // the student submits a value. Route the chatbot ones through the normal
  // send path so the value rides the existing chat history and o4-mini
  // finishes the calculation. Scoped by detail.surface so the PDF-panel
  // listener doesn't also fire.
  document.addEventListener('minallo-ai-input-submit', (ev) => {
    const ce = ev as CustomEvent<{ text?: string; surface?: string }>;
    if (!ce.detail || ce.detail.surface !== 'chatbot') return;
    const text = (ce.detail.text || '').trim();
    if (!text || state.isSending) return;
    textarea.value = text;
    void doSend(state, stage, textarea, sendBtn, pasteRow, msgs);
  });

  // Paste inside textarea
  textarea.addEventListener('paste', (ev) => {
    const files = collectImageFiles(ev.clipboardData);
    if (files.length === 0) return;
    ev.preventDefault();
    void absorbPastedImages(files, state, pasteRow);
  });

  // Global paste when not in an input — only react when chatbot route is visible
  window.addEventListener('paste', (ev) => {
    if (root.hidden || root.offsetParent === null) return;
    const active = document.activeElement as HTMLElement | null;
    const inField =
      !!active &&
      (active.tagName === 'TEXTAREA' ||
        active.tagName === 'INPUT' ||
        active.isContentEditable);
    if (inField) return;
    const files = collectImageFiles(ev.clipboardData);
    if (files.length === 0) return;
    ev.preventDefault();
    void absorbPastedImages(files, state, pasteRow);
  });
}

// Vertical message minimap on the right edge of the chat column. Lets the
// user jump between earlier turns in long tutoring conversations. The
// component watches .ncb-msgs itself, so send/regenerate/chat-switch all
// stay in sync without extra wiring here.
function initMessageNavigator(root: HTMLElement): void {
  const card = root.querySelector<HTMLElement>('.ncb-card');
  const scroller = root.querySelector<HTMLElement>('.ncb-center');
  const msgs = root.querySelector<HTMLElement>('.ncb-msgs');
  if (!card || !scroller || !msgs) return;
  if (card.dataset.msgnavBound === '1') return;
  card.dataset.msgnavBound = '1';
  attachMessageNavigator({
    host: card,
    scroller,
    container: msgs,
    // User turns only (ChatGPT-style): prompts are the landmarks people
    // navigate by; listing AI replies too doubles the list with noise.
    messageSelector: '.ncb-msg-row--user',
    isUser: () => true,
    snippetSource: (row) => row.querySelector<HTMLElement>('.ncb-bubble-text') || row,
    bottomGuard: () => root.querySelector<HTMLElement>('.ncb-input'),
    compact: false,
    minMessages: 3,
  });
}

function collectImageFiles(cd: DataTransfer | null): File[] {
  if (!cd) return [];
  const out: File[] = [];
  for (let i = 0; i < cd.files.length; i++) {
    const f = cd.files[i];
    if (f && f.type && f.type.startsWith('image/')) out.push(f);
  }
  return out;
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } catch {
      resolve(null);
    }
  });
}

async function absorbPastedImages(
  files: File[],
  state: ConversationState,
  pasteRow: HTMLElement
): Promise<void> {
  const added: PastedImage[] = [];
  for (const f of files) {
    const dataUrl = await readAsDataUrl(f);
    if (!dataUrl) continue;
    added.push({
      id:
        (f.name || 'pasted') +
        '-' +
        (f.lastModified || Date.now()) +
        '-' +
        Math.random().toString(36).slice(2, 8),
      name: f.name || tStr('cb_pasted_screenshot', 'Pasted screenshot'),
      mediaType: f.type || 'image/png',
      dataUrl,
    });
  }
  if (!added.length) return;
  state.pasted.push(...added);
  renderPasteRow(state, pasteRow);
}

function renderPasteRow(state: ConversationState, pasteRow: HTMLElement): void {
  if (state.pasted.length === 0) {
    pasteRow.hidden = true;
    pasteRow.innerHTML = '';
    return;
  }
  pasteRow.hidden = false;
  pasteRow.innerHTML = state.pasted
    .map(
      (img) => `
      <div class="ncb-paste-thumb" data-id="${escapeAttr(img.id)}" title="${escapeAttr(img.name)}">
        <img alt="${escapeAttr(img.name)}" src="${escapeAttr(img.dataUrl)}" />
        <button type="button" class="ncb-paste-remove" aria-label="Remove ${escapeAttr(img.name)}">
          <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    `
    )
    .join('');

  pasteRow.querySelectorAll<HTMLButtonElement>('.ncb-paste-remove').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wrap = btn.closest<HTMLElement>('.ncb-paste-thumb');
      const id = wrap?.dataset.id;
      if (!id) return;
      state.pasted = state.pasted.filter((p) => p.id !== id);
      renderPasteRow(state, pasteRow);
    });
  });
}

async function doSend(
  state: ConversationState,
  stage: HTMLElement,
  textarea: HTMLTextAreaElement,
  sendBtn: HTMLButtonElement,
  pasteRow: HTMLElement,
  msgs: HTMLElement
): Promise<void> {
  const text = textarea.value.trim();
  const images = state.pasted.slice();
  const files = state.files.slice();
  if (!text && images.length === 0 && files.length === 0) return;

  // Switch to active-chat state on first send
  if (stage.dataset.state !== 'active') stage.dataset.state = 'active';

  // Append user bubble
  state.messages.push({ role: 'user', text, images, files });
  appendUserBubble(msgs, text, images, files);
  touchActiveChat();
  saveChatStore();

  // Reset input. Belt-and-braces: clear value, force the textarea
  // back to its min height explicitly, clear overflow, then fire
  // input so any other listeners see an empty textarea.
  textarea.value = '';
  textarea.style.height = '44px';
  textarea.style.overflowY = 'hidden';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  state.pasted = [];
  state.files = [];
  renderPasteRow(state, pasteRow);
  renderFilesRow(stage.closest<HTMLElement>('.ncb-root')!, state);

  if (isInternalTechnicalQuestion(text)) {
    const aiRow = appendAiBubble(msgs);
    const bubble = aiRow.querySelector<HTMLElement>('.ncb-bubble-body');
    const raw = technicalRefusal();
    if (bubble) renderRichBubble(bubble, raw, false);
    state.messages.push({ role: 'assistant', text: raw, allowDiagrams: false });
    setBubbleSubtitle(aiRow, 'study_only');
    touchActiveChat();
    saveChatStore();
    appendBubbleActions(aiRow, raw);
    return;
  }

  await streamAiReply(state, sendBtn, msgs);
}

async function streamAiReply(
  state: ConversationState,
  sendBtn: HTMLButtonElement,
  msgs: HTMLElement
): Promise<void> {
  state.isSending = true;
  setSendBtnMode(sendBtn, 'pause');

  const aiRow = appendAiBubble(msgs);
  const bubble = aiRow.querySelector<HTMLElement>('.ncb-bubble-body');
  const thinking = createAIThinkingStatus({
    context: chatbotThinkingContext(state),
    host: bubble,
    surface: 'chatbot',
    compact: true,
    append: false
  });

  const controller = new AbortController();
  state.controller = controller;

  try {
    const allowDiagrams = latestUserAllowsDiagrams(state.messages);
    const latestFileLabel = latestUserFileLabel(state.messages);
    // Phase 12 wiring: when the active chat has ≥1 course-imported source
    // selected AND the latest user message is text-only (no images, no
    // file uploads), route to the Python /ask-stream so plan-v2's RAG +
    // ranking + math template + verification all kick in. Otherwise fall
    // back to /api/ai for free-form chat + image/file handling.
    const routed = await handleIntentRoute(state, bubble, thinking, controller);
    if (routed) {
      const msg: ChatMessage = { role: 'assistant', text: routed.text };
      if (routed.missionMarker) msg.missionMarker = routed.missionMarker;
      if (routed.generatedDoc) msg.generatedDoc = routed.generatedDoc;
      state.messages.push(msg);
      setBubbleSubtitle(aiRow, 'course_files');
      touchActiveChat();
      saveChatStore();
      appendBubbleActions(aiRow, routed.text);
      return;
    }

    const rag = ragEligibility(state.messages);
    let raw: string;
    if (rag) {
      // History = everything BEFORE the just-added user turn (which is
      // already in rag.question). Without this the backend retrieves on
      // the literal text "I don't know" and falls into PARTIAL mode
      // instead of recognising the message as a reply to its own question.
      const priorTurns = state.messages
        .slice(0, -1)
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          text: m.role === 'assistant' ? sanitizeChatbotDiagrams(m.text, !!m.allowDiagrams) : m.text
        }));
      // A cheatsheet/summary generated earlier (this chat, an older chat, or
      // before a refresh) rides along as openFileContext — the backend
      // truncates history turns to ~1.2k chars, so the doc would never
      // survive inside previousTurns.
      const followUpDoc = await resolveFollowUpDoc(state.messages, rag.courseId || null);
      const streamed = await streamFromAskStream(rag.question, rag.courseId, bubble, controller, priorTurns, thinking, rag.documentIds, rag.documentNames, followUpDoc, allowDiagrams);
      raw = sanitizeChatbotDiagrams(streamed.text, allowDiagrams);
      state.messages.push({
        role: 'assistant',
        text: raw,
        allowDiagrams,
        selectedSourceMode: streamed.meta?.selectedSourceMode as SourceMode | undefined,
        sourceScope: streamed.meta?.sourceScope as string | undefined,
        sourceLabel: streamed.meta?.sourceLabel as string | undefined,
        courseFileScope: streamed.meta?.courseFileScope as CourseFileScope | undefined,
        sources: Array.isArray(streamed.meta?.sources) ? streamed.meta.sources as SrcItem[] : undefined,
      });
      setBubbleSubtitle(aiRow, streamed.meta?.sourceScope as string | undefined);
    } else if (normaliseSourceMode(chatStore.getActive().sourceMode) === 'course_files') {
      // Locked to Course Files but no course files are attached to this chat,
      // so there's nothing to search. Honour the mode's contract — never answer
      // from general knowledge here — and tell the user how to attach files
      // instead of silently falling back to the generic model.
      if (thinking) await thinking.waitMinimum();
      thinking?.remove(true);
      raw = tStr(
        'cb_course_files_none',
        "You're in **Course Files** mode, but no course files are attached to this chat yet, so there's nothing for me to search. Click the **import** button (the folder icon next to the message box) to add files from one of your courses, then ask again — or switch the source selector to **Auto** or **Internet**."
      );
      if (bubble) renderRichBubble(bubble, raw, false);
      state.messages.push({ role: 'assistant', text: raw, allowDiagrams: false });
      setBubbleSubtitle(aiRow, 'course_files');
    } else {
      const followUpDoc = await resolveFollowUpDoc(state.messages, null);
      raw = await callGenericAi(state.messages, bubble, controller, thinking, followUpDoc, allowDiagrams);
      raw = sanitizeChatbotDiagrams(raw, allowDiagrams);
      state.messages.push({ role: 'assistant', text: raw, allowDiagrams });
      // Generic chat path — no course retrieval ran, so don't claim otherwise.
      setBubbleSubtitle(aiRow, latestFileLabel ? 'file:' + latestFileLabel : 'general_knowledge');
    }
    touchActiveChat();
    saveChatStore();
    appendBubbleActions(aiRow, raw);

    // After the first AI reply, ask the model for a 4-6 word title.
    if (state.messages.filter((m) => m.role === 'assistant').length === 1) {
      void generateChatTitle(state).then((title) => {
        if (title) updateChatTitle(title);
      });
    }
  } catch (err) {
    thinking?.remove(true);
    if (bubble) {
      if ((err as Error)?.name === 'AbortError') {
        bubble.innerHTML =
          '<em class="ncb-bubble-aborted">' +
          escapeHtml(tStr('cb_response_stopped', 'Response stopped.')) +
          '</em>';
      } else if (isSubscriptionError(err)) {
        // New users without a plan hit the 402 gate — show a calm upgrade
        // prompt instead of a raw "Server 402: {…}" dump, and swap the
        // pointless Retry for a link to the plans.
        bubble.innerHTML = renderInlineMarkdown(
          tStr(
            'cb_need_subscription',
            'You need an active subscription to use the AI tutor. Open **Subscription** in the menu to unlock it.'
          )
        );
        attachSubscribeCta(aiRow, bubble);
      } else {
        bubble.innerHTML = renderInlineMarkdown(
          '❌ ' + ((err as Error)?.message || tStr('cb_request_failed', 'Request failed.'))
        );
        attachErrorRetry(aiRow, bubble);
      }
    }
  } finally {
    state.controller = null;
    state.isSending = false;
    setSendBtnMode(sendBtn, 'send');
    // Sticky: don't yank a user who scrolled up to read while the answer finished.
    scrollMsgsToBottom(msgs, false);
  }
}

type IntentRouteResult = { text: string; missionMarker?: MissionMarker; generatedDoc?: GeneratedDoc };

// ── PDF settings card (shared by cheatsheet + summary) ───────────────────────

interface PdfChatSettings {
  columns: number;
  pages: string;   // 'auto' | '1' | '2' | '3' | '4'
  fontSize: 'small' | 'medium' | 'large';
  padding: 'tight' | 'normal' | 'wide';
  language: string;
}

/** Detect an explicit language preference in the user's cheatsheet request. */
function detectCheatsheetLangPref(text: string): string {
  if (/\bin english\b|auf englisch|translate.*english/i.test(text)) return 'en';
  if (/\bin german\b|auf deutsch|translate.*german/i.test(text)) return 'de';
  if (/german.*terms.*english|deutsch.*begriffe.*englisch/i.test(text)) return 'de_terms_en_explanations';
  return 'source';
}

interface PdfSettingsCardConfig {
  title: string;
  columnChoices: string[];
  defaultColumns: string;
  showPages: boolean;
  showLanguage: boolean;
  initialLang?: string;
  generateLabel?: string;
}

/**
 * Render an interactive settings card inside `bubble` and resolve with the
 * user's chosen layout settings once they click the generate button.
 */
function showPdfSettingsCard(
  bubble: HTMLElement | null,
  cfg: PdfSettingsCardConfig,
  signal?: AbortSignal
): Promise<PdfChatSettings | null> {
  return new Promise((resolve) => {
    if (!bubble) { resolve(null); return; }

    const card = document.createElement('div');
    card.className = 'ncb-cs-settings';

    // Pause pressed while the card waits for a choice: resolve as cancelled
    // instead of leaving the whole send flow awaiting a click forever.
    if (signal) {
      if (signal.aborted) { resolve(null); return; }
      signal.addEventListener('abort', () => { card.remove(); resolve(null); }, { once: true });
    }

    const renderGroup = (
      key: string, label: string,
      opts: Array<{ val: string; label: string }>,
      defaultVal: string
    ): string =>
      '<div class="ncb-cs-settings-row">' +
        '<span class="ncb-cs-settings-label">' + escapeHtml(label) + '</span>' +
        '<div class="ncb-cs-settings-options" data-key="' + key + '">' +
          opts.map(o =>
            '<button type="button" class="ncb-cs-opt' +
            (o.val === defaultVal ? ' ncb-cs-opt--active' : '') +
            '" data-val="' + escapeAttr(o.val) + '">' +
            escapeHtml(o.label) + '</button>'
          ).join('') +
        '</div>' +
      '</div>';

    const colOpts = cfg.columnChoices.map(v => ({ val: v, label: v }));
    let html =
      '<div class="ncb-cs-settings-title">' + escapeHtml(cfg.title) + '</div>' +
      renderGroup('columns', 'Columns', colOpts, cfg.defaultColumns);

    if (cfg.showPages) {
      html += renderGroup('pages', 'Pages',
        [{ val: 'auto', label: 'Auto' }, { val: '1', label: '1' },
         { val: '2', label: '2' }, { val: '3', label: '3' }, { val: '4', label: '4' }],
        'auto');
    }

    html +=
      renderGroup('fontSize', 'Font size',
        [{ val: 'small', label: 'Small' }, { val: 'medium', label: 'Medium' }, { val: 'large', label: 'Large' }],
        'medium') +
      renderGroup('padding', 'Padding',
        [{ val: 'tight', label: 'Tight' }, { val: 'normal', label: 'Normal' }, { val: 'wide', label: 'Wide' }],
        'normal');

    if (cfg.showLanguage) {
      html += renderGroup('language', 'Language', [
        { val: 'source', label: 'Document language' },
        { val: 'en', label: 'English' },
        { val: 'de', label: 'German' },
        { val: 'de_terms_en_explanations', label: 'DE terms + EN' },
      ], cfg.initialLang || 'source');
    }

    html += '<div class="ncb-cs-settings-footer">' +
      '<button type="button" class="ncb-cs-generate">' +
      escapeHtml(cfg.generateLabel || 'Generate PDF') + '</button></div>';

    card.innerHTML = html;

    card.addEventListener('click', (e) => {
      const btn = (e.target as Element).closest<HTMLButtonElement>('.ncb-cs-opt');
      if (!btn) return;
      const group = btn.closest<HTMLElement>('[data-key]');
      if (!group) return;
      group.querySelectorAll('.ncb-cs-opt').forEach(b => b.classList.remove('ncb-cs-opt--active'));
      btn.classList.add('ncb-cs-opt--active');
    });

    const getVal = (key: string): string =>
      card.querySelector<HTMLButtonElement>(`[data-key="${key}"] .ncb-cs-opt--active`)?.dataset.val ?? '';

    card.querySelector('.ncb-cs-generate')?.addEventListener('click', () => {
      const columns = parseInt(getVal('columns') || cfg.defaultColumns, 10) || parseInt(cfg.defaultColumns, 10);
      const pages = getVal('pages') || 'auto';
      const fontSize = (getVal('fontSize') || 'medium') as 'small' | 'medium' | 'large';
      const padding = (getVal('padding') || 'normal') as 'tight' | 'normal' | 'wide';
      const language = getVal('language') || 'source';
      card.remove();
      resolve({ columns, pages, fontSize, padding, language });
    });

    bubble.innerHTML = '';
    bubble.appendChild(card);
  });
}

/** Lazily load cheatsheet.js + cheatsheet.css so the paper view is available. */
function ensureCheatsheetScripts(): Promise<void> {
  const w = window as unknown as {
    openCheatsheetPaper?: unknown;
    _csScriptsLoading?: Promise<void>;
  };
  if (typeof w.openCheatsheetPaper === 'function') return Promise.resolve();
  if (w._csScriptsLoading) return w._csScriptsLoading;

  // Cache-bust with the same assetVersion the loader uses — without it the
  // browser keeps serving a stale cheatsheet.js/css from this unversioned URL.
  const assetVersion = String(
    (window as unknown as { MinalloConfig?: { assetVersion?: string } }).MinalloConfig
      ?.assetVersion || '1'
  );
  const versioned = (src: string): string =>
    src + (src.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(assetVersion);

  const loadScript = (src: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (document.querySelector(`script[src^="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = versioned(src);
      s.onload = () => resolve();
      s.onerror = () => {
        // Remove the dead tag: the querySelector dedupe above would otherwise
        // see it on the retry and resolve instantly without the library.
        s.remove();
        reject(new Error('Failed to load: ' + src));
      };
      document.head.appendChild(s);
    });

  const loadStyle = (href: string): void => {
    if (document.querySelector(`link[href^="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = versioned(href);
    l.onerror = () => { l.remove(); };
    document.head.appendChild(l);
  };

  w._csScriptsLoading = loadScript('/js/utils/db-helpers.js')
    .then(() => {
      loadStyle('/views/cheatsheet/cheatsheet.css');
      return loadScript('/views/cheatsheet/cheatsheet.js');
    })
    .catch((err: unknown) => {
      // Never cache a failed load — with the rejection cached, "Open PDF
      // viewer" stayed dead for the whole session after one network blip.
      w._csScriptsLoading = undefined;
      throw err;
    });
  return w._csScriptsLoading;
}

/** All of the student's courses across every semester (id + display name). */
function listAllCourses(): Array<{ id: string; name: string }> {
  const w = window as unknown as {
    SEMS?: Record<string, { courses?: Array<{ id?: string; name?: string; title?: string }> }>;
  };
  const all: Array<{ id: string; name: string }> = [];
  Object.values(w.SEMS || {}).forEach((sem) => {
    (sem?.courses || []).forEach((c) => {
      if (c?.id) all.push({ id: c.id, name: String(c.name || c.title || '').trim() });
    });
  });
  return all;
}

/** Resolve which course a study-intent message (cheatsheet/summary/notes…)
 *  targets. Priority: a course NAME mentioned in the message → the course the
 *  student has open right now → the only course that exists. Deliberately NOT
 *  "first course of the semester" (the old findPrimaryCourseId fallback): with
 *  several courses that silently generated from an arbitrary one the student
 *  never asked for. Returns null when the choice is genuinely ambiguous so the
 *  router's clarification question fires instead. */
function resolveIntentCourse(messageText: string): {
  courseId: string | null;
  courseName: string | null;
  allNames: string[];
} {
  const all = listAllCourses();
  const allNames = all.map((c) => c.name).filter(Boolean);
  const msg = (messageText || '').toLowerCase();
  // Longest matching name wins ("Mechanik 2" over "Mechanik").
  const named = all
    .filter((c) => c.name.length >= 3 && msg.includes(c.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (named) return { courseId: named.id, courseName: named.name, allNames };
  const w = window as unknown as {
    activeCourseId?: string | null;
    activeCourseRef?: { id?: string; name?: string } | null;
  };
  const activeId = w.activeCourseRef?.id || w.activeCourseId || null;
  if (activeId) {
    const match = all.find((c) => c.id === activeId);
    return { courseId: activeId, courseName: match?.name || w.activeCourseRef?.name || null, allNames };
  }
  if (all.length === 1 && all[0]) return { courseId: all[0].id, courseName: all[0].name, allNames };
  return { courseId: null, courseName: null, allNames };
}

/** Inline course chooser for study intents (cheatsheet/summary/notes/mission).
 *  Rendered into the answer bubble as buttons; the awaiting intent flow
 *  continues with the clicked course — same interaction model as
 *  showPdfSettingsCard. Includes a Cancel action that resolves null. */
function showCoursePickCard(
  bubble: HTMLElement,
  intent: string,
  courses: Array<{ id: string; name: string }>
): Promise<string | null> {
  return new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = 'ncb-cs-settings ncb-course-pick';
    card.innerHTML =
      '<div class="ncb-cs-settings-title">Which course should I use for your ' +
        escapeHtml(intent.replace(/_/g, ' ')) + '?</div>' +
      '<div class="ncb-course-pick-list">' +
        courses.slice(0, 12).map((c) =>
          '<button type="button" class="ncb-cs-opt ncb-course-pick-btn" data-course-id="' +
          escapeAttr(c.id) + '">' + escapeHtml(c.name) + '</button>'
        ).join('') +
      '</div>' +
      '<div class="ncb-cs-settings-footer">' +
        '<button type="button" class="ncb-cs-opt ncb-course-pick-cancel">Cancel</button>' +
      '</div>';
    card.addEventListener('click', (e) => {
      const cancel = (e.target as Element).closest('.ncb-course-pick-cancel');
      if (cancel) {
        card.remove();
        resolve(null);
        return;
      }
      const btn = (e.target as Element).closest<HTMLButtonElement>('.ncb-course-pick-btn');
      if (!btn) return;
      card.remove();
      resolve(btn.dataset.courseId || null);
    });
    bubble.innerHTML = '';
    bubble.appendChild(card);
  });
}

async function handleIntentRoute(
  state: ConversationState,
  bubble: HTMLElement | null,
  thinking: AIThinkingStatus | null,
  controller: AbortController
): Promise<IntentRouteResult | null> {
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'user' || !last.text) return null;
  if ((last.images && last.images.length) || (last.files && last.files.length)) return null;

  const resolvedCourse = resolveIntentCourse(last.text);
  const courseId = resolvedCourse.courseId;
  const route = routeStudyIntent(last.text, courseId);
  if (!route) return null;

  if (route.needsClarification || !route.target.courseId) {
    if (thinking) await thinking.waitMinimum();
    thinking?.remove(true);
    const courses = listAllCourses().filter((c) => c.name);
    if (!bubble || !courses.length) {
      const text = 'Which course should I create this for? Open a course first, then ask again.';
      if (bubble) renderRichBubble(bubble, text);
      return { text };
    }
    // Inline chooser: the intent flow awaits the click and continues in this
    // same turn — no "type your question again" round-trip.
    const pickedCourseId = await showCoursePickCard(bubble, route.intent, courses);
    if (!pickedCourseId) {
      const text = 'Cancelled.';
      renderRichBubble(bubble, text);
      return { text };
    }
    route.target.courseId = pickedCourseId;
  }

  if (route.intent === 'daily_mission') {
    thinking?.remove(true);
    const missionLoading = showTodoMissionPlannerLoading(bubble);
    const targetCourseId = route.target.courseId;
    let data: Awaited<ReturnType<typeof getDailyMission>>;
    try {
      data = await getDailyMission(targetCourseId);
      if (!data.hasPlan) data = await generateDailyMission(targetCourseId);
    } catch (err) {
      cancelTodoMissionPlannerLoading(missionLoading);
      throw err;
    }
    const text = renderDailyMissionText(data);
    await finishTodoMissionPlannerLoading(missionLoading);
    if (bubble) {
      bubble.innerHTML = '';
      const mod = await import('../daily-mission/daily-mission-ui.js');
      void mod.mountDailyMissionPanel(bubble, targetCourseId, {
        handlers: buildDailyMissionHandlers(targetCourseId)
      });
    }
    // Store a lightweight marker instead of the serialised card HTML so that
    // when history is replayed the panel is re-fetched and re-rendered fresh.
    const marker: MissionMarker = {
      type: 'daily_mission',
      courseId: targetCourseId,
      date: todayLocalDateStr(),
    };
    return { text, missionMarker: marker };
  }

  // ── Shared PDF layout helpers (used by both summary and cheatsheet) ──────────
  const padMap: Record<string, string> = { tight: '6mm', normal: '10mm', wide: '16mm' };
  const fontCsMap: Record<string, string> = { small: 'xs', medium: 'sm', large: 'md' };

  /**
   * Return the openCheatsheetPaper function (already loaded or no-op if missing).
   * Wrapped in a thunk so it's re-read after ensureCheatsheetScripts() resolves.
   */
  const getOpenPaper = (): ((opts: Record<string, unknown>) => void) =>
    (window as unknown as { openCheatsheetPaper?: (o: Record<string, unknown>) => void })
      .openCheatsheetPaper ?? (() => { /* not yet loaded */ });

  /** Build CSS layout settings from the user's card choices. */
  const buildLayoutSettings = (s: PdfChatSettings, styleName = 'academic'): Record<string, unknown> => ({
    columns: s.columns,
    font: fontCsMap[s.fontSize] || 'sm',
    pad: padMap[s.padding] || '10mm',
    style: styleName,
  });

  /** Attach a persistent "Open PDF viewer" button whose click reopens the overlay. */
  function attachReopenButton(
    host: HTMLElement,
    getPaperOpts: () => Record<string, unknown> | null
  ): void {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ncb-cs-reopen-btn';
    btn.textContent = '⤓ Open PDF viewer';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      ensureCheatsheetScripts()
        .then(() => { const o = getPaperOpts(); if (o) getOpenPaper()(o); })
        .catch(() => { const o = getPaperOpts(); if (o) getOpenPaper()(o); })
        .finally(() => { btn.disabled = false; btn.textContent = '⤓ Open PDF viewer'; });
    });
    host.appendChild(btn);
  }

  // ── summary ──────────────────────────────────────────────────────────────────
  if (route.intent === 'summary') {
    // 1. Show settings card
    if (thinking) await thinking.waitMinimum();
    thinking?.remove(true);

    const chatSettings = await showPdfSettingsCard(bubble, {
      title: 'Customize your summary PDF',
      columnChoices: ['1', '2', '3'],
      defaultColumns: '2',
      showPages: true,
      showLanguage: false,
      generateLabel: 'Generate PDF',
    }, controller.signal);
    if (!chatSettings) {
      const text = 'Summary cancelled.';
      if (bubble) renderRichBubble(bubble, text);
      return { text };
    }

    // 2. Generate
    const builderSum = showStudyBuilderLoading(bubble, 'summary');

    let sumResult: { text?: string; title?: string };
    try {
      const [modSum] = await Promise.all([
        import('../../services/ai-service.js'),
        ensureCheatsheetScripts(),
      ]);
      throwIfAborted(controller.signal);

      sumResult = await modSum.generateStudyTool(
        route.target.courseId, 'summary', undefined, controller.signal
      ) as { text?: string; title?: string };
      throwIfAborted(controller.signal);
    } catch (err) {
      cancelStudyBuilderLoading(builderSum);
      throw err;
    }

    await finishStudyBuilderLoading(builderSum);

    // 3. Build opts; persist full markdown to localStorage (no noteId for summary)
    const sumLayout = buildLayoutSettings(chatSettings);
    const sumLsKey = 'minallo_sum_last_' + route.target.courseId;
    let sumPaperOpts: Record<string, unknown> | null = sumResult && sumResult.text ? {
      kind: 'summary',
      course: route.target.courseId,
      title: sumResult.title || 'Summary',
      scope: sumResult.title || 'Course summary',
      meta: '',
      markdown: sumResult.text,
      settings: sumLayout,
    } : null;

    if (sumPaperOpts) {
      try {
        localStorage.setItem(sumLsKey, JSON.stringify({
          markdown: sumResult.text,
          title: sumResult.title || 'Summary',
          settings: sumLayout,
        }));
      } catch { /* storage full — non-fatal */ }
    }

    const sumGeneratedDoc: GeneratedDoc | undefined = sumResult && sumResult.text
      ? {
          kind: 'summary',
          title: sumResult.title || 'Summary',
          markdown: sumResult.text,
          courseId: route.target.courseId,
        }
      : undefined;

    const sumText = sumPaperOpts
      ? 'Your summary is ready. Click **⤓ Open PDF viewer** below to view and download it.'
      : 'No summary could be generated from your course sources. Please try again.';
    if (bubble) renderRichBubble(bubble, sumText);

    if (bubble && sumPaperOpts) {
      attachReopenButton(bubble, () => {
        if (sumPaperOpts) return sumPaperOpts;
        // Fallback: restore from localStorage after page refresh
        try {
          const stored = JSON.parse(localStorage.getItem(sumLsKey) || 'null') as
            { markdown: string; title: string; settings: Record<string, unknown> } | null;
          if (stored?.markdown) {
            sumPaperOpts = {
              kind: 'summary',
              course: route.target.courseId,
              title: stored.title,
              scope: stored.title,
              meta: '',
              markdown: stored.markdown,
              settings: stored.settings ?? sumLayout,
            };
          }
        } catch { /* ignore */ }
        return sumPaperOpts;
      });
    }
    return sumGeneratedDoc ? { text: sumText, generatedDoc: sumGeneratedDoc } : { text: sumText };
  }

  // ── cheatsheet ────────────────────────────────────────────────────────────
  if (route.intent === 'cheatsheet') {
    // 1. Detect language preference from the user's message
    const langPref = detectCheatsheetLangPref(last.text);

    // 2. Show settings card
    if (thinking) await thinking.waitMinimum();
    thinking?.remove(true);

    const chatSettings = await showPdfSettingsCard(bubble, {
      title: 'Customize your cheatsheet PDF',
      columnChoices: ['2', '3', '4'],
      defaultColumns: '3',
      showPages: true,
      showLanguage: true,
      initialLang: langPref,
      generateLabel: 'Generate PDF',
    }, controller.signal);
    if (!chatSettings) {
      const text = 'Cheatsheet cancelled.';
      if (bubble) renderRichBubble(bubble, text);
      return { text };
    }

    const fontApiMap: Record<string, 'small' | 'medium' | 'large'> = {
      small: 'small', medium: 'medium', large: 'large'
    };

    // 3. Generate
    const builderCs = showStudyBuilderLoading(bubble, 'cheatsheet');

    let result: Awaited<ReturnType<typeof import('../../services/ai-service.js')['generateCheatsheet']>>;
    try {
      const [mod] = await Promise.all([
        import('../../services/ai-service.js'),
        ensureCheatsheetScripts(),
      ]);
      throwIfAborted(controller.signal);

      result = await mod.generateCheatsheet(route.target.courseId, {
        settings: {
          columns: chatSettings.columns as 2 | 3 | 4,
          fontSize: fontApiMap[chatSettings.fontSize],
          output: 'web',
          language: chatSettings.language as 'source' | 'en' | 'de' | 'de_terms_en_explanations',
        }
      }, controller.signal);
      throwIfAborted(controller.signal);
    } catch (err) {
      cancelStudyBuilderLoading(builderCs);
      throw err;
    }

    await finishStudyBuilderLoading(builderCs);

    // 4. Build opts and persist
    const csLayoutSettings = buildLayoutSettings(chatSettings, (result.settings && result.settings.style as string) || 'academic');
    let paperOpts: Record<string, unknown> | null = result && result.text ? {
      kind: 'cheatsheet',
      course: route.target.courseId,
      title: result.title || 'Cheatsheet',
      scope: result.title || 'Course cheatsheet',
      meta: '',
      markdown: result.text,
      settings: csLayoutSettings,
    } : null;

    const lsKey = 'minallo_cs_last_' + route.target.courseId;
    if (paperOpts && result.noteId) {
      try {
        localStorage.setItem(lsKey, JSON.stringify({
          noteId: result.noteId,
          title: result.title || 'Cheatsheet',
          settings: csLayoutSettings,
        }));
      } catch { /* storage full — non-fatal */ }
    }

    const savedNote = !!result.noteId;
    const text = paperOpts
      ? 'Your cheatsheet is ready. Click **⤓ Open PDF viewer** below to view and download it.' +
        (savedNote ? ' It\'s also **saved to your notes** — you can find it in the Cheatsheet tab of this course.' : '')
      : 'No cheatsheet content was returned. Please try again.';
    if (bubble) renderRichBubble(bubble, text);

    if (bubble && (paperOpts || result.noteId)) {
      attachReopenButton(bubble, () => {
        if (paperOpts) return paperOpts;
        // Restore from localStorage/API after page refresh
        try {
          const stored = JSON.parse(localStorage.getItem(lsKey) || 'null') as
            { noteId: string; title: string; settings: Record<string, unknown> } | null;
          const noteId = stored?.noteId ?? result.noteId;
          if (noteId) {
            // Async load — we return null here and the button retries via the click handler
            import('../../services/ai-service.js').then(svc => svc.getNoteById(noteId)).then(note => {
              if (note) paperOpts = {
                kind: 'cheatsheet',
                course: route.target.courseId,
                title: note.title || stored?.title || 'Cheatsheet',
                scope: note.title || 'Course cheatsheet',
                meta: '',
                markdown: note.content_markdown,
                settings: stored?.settings ?? csLayoutSettings,
              };
            }).catch(() => { /* non-fatal */ });
          }
        } catch { /* ignore */ }
        return paperOpts;
      });
    }

    if (result && result.text) {
      return {
        text,
        generatedDoc: {
          kind: 'cheatsheet',
          title: result.title || 'Cheatsheet',
          markdown: result.text,
          courseId: route.target.courseId,
          noteId: result.noteId || undefined,
        },
      };
    }
    return { text };
  }

  if (route.intent === 'notes') {
    const text = await handleNotesIntent(route.target.courseId, bubble, controller.signal);
    return { text };
  }

  return null;
}

function showTodoMissionPlannerLoading(bubble: HTMLElement | null): HTMLElement | null {
  if (!bubble) return null;
  const el = document.createElement('section');
  el.className = 'todoMissionLoading';
  el.setAttribute('aria-live', 'polite');
  el.innerHTML =
    '<header class="todoMissionHeader">' +
      '<div class="todoMissionLogo" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M9.5 4.5 4 7.2l5.5 2.7L15 7.2 9.5 4.5Z"/>' +
          '<path d="M4 11.2l5.5 2.7 5.5-2.7"/>' +
          '<path d="M4 15.2l5.5 2.7 5.5-2.7"/>' +
          '<path d="M17 7.5h3"/><path d="M18.5 6v3"/>' +
        '</svg>' +
      '</div>' +
      '<div>' +
        '<div class="todoMissionBrand">Minallo AI</div>' +
        '<div class="todoMissionContext">Building a focused study plan from your course context</div>' +
      '</div>' +
    '</header>' +
    '<div class="todoMissionContent">' +
      '<div class="todoMissionLeft">' +
        '<div class="todoMissionBadge"><span></span>Daily mission planner</div>' +
        '<h2>Planning your study day</h2>' +
        '<p>Minallo is turning your open tasks, course deadlines, and study goals into a clear to-do mission for today.</p>' +
        '<div class="todoMissionSteps">' +
          todoMissionStepHtml('📚', 'Reading your study context', 'Courses, folders, deadlines, and unfinished work', 'SCAN') +
          todoMissionStepHtml('🎯', 'Choosing today’s priorities', 'Important tasks move to the top of the plan', 'SORT') +
          todoMissionStepHtml('⏱', 'Sequencing focus blocks', 'Tasks are arranged into realistic study sessions', 'PLAN') +
          todoMissionStepHtml('✅', 'Preparing your checklist', 'Your daily mission is almost ready to start', 'READY') +
        '</div>' +
      '</div>' +
      '<div class="todoMissionBoardWrap" aria-hidden="true">' +
        '<div class="todoMissionOrbit"></div>' +
        '<span class="todoMissionChip chipDeadline">Deadline</span>' +
        '<span class="todoMissionChip chipFocus">Focus block</span>' +
        '<span class="todoMissionChip chipQuick">Quick win</span>' +
        '<span class="todoMissionChip chipDeep">Deep work</span>' +
        '<div class="todoMissionBoard">' +
          '<div class="todoMissionBoardHead">' +
            '<div class="todoMissionBoardTitle">' +
              '<div class="todoMissionCalendar">11</div>' +
              '<div><strong>Today’s Mission</strong><span>4 tasks planned</span></div>' +
            '</div>' +
            '<div class="todoMissionSortedPill">AI sorted</div>' +
          '</div>' +
          '<div class="todoMissionTimeline">' +
            todoMissionTaskHtml('1', 'Review lecture notes', '25 min · Mechanics', 'High', true) +
            todoMissionTaskHtml('2', 'Generate quiz practice', '15 min · Exam prep', 'Mid', false) +
            todoMissionTaskHtml('3', 'Fix weak concepts', '35 min · Deep focus', 'High', true) +
            todoMissionTaskHtml('✓', 'Save final checklist', 'Ready in Study Lounge', 'Done', false) +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="todoMissionProgress" aria-hidden="true"><span></span></div>';

  bubble.prepend(el);
  return el;
}

function todoMissionStepHtml(icon: string, title: string, description: string, status: string): string {
  return (
    '<div class="todoMissionStep">' +
      '<div class="todoMissionStepIcon" aria-hidden="true">' + icon + '</div>' +
      '<div class="todoMissionStepCopy">' +
        '<strong>' + escapeHtml(title) + '</strong>' +
        '<span>' + escapeHtml(description) + '</span>' +
      '</div>' +
      '<em>' + escapeHtml(status) + '</em>' +
    '</div>'
  );
}

function todoMissionTaskHtml(
  number: string,
  title: string,
  meta: string,
  priority: string,
  high: boolean
): string {
  return (
    '<div class="todoMissionTask">' +
      '<div class="todoMissionTaskNo">' + escapeHtml(number) + '</div>' +
      '<div class="todoMissionTaskCopy">' +
        '<strong>' + escapeHtml(title) + '</strong>' +
        '<span>' + escapeHtml(meta) + '</span>' +
      '</div>' +
      '<em class="' + (high ? 'isHigh' : '') + '">' + escapeHtml(priority) + '</em>' +
    '</div>'
  );
}

async function finishTodoMissionPlannerLoading(loader: HTMLElement | null): Promise<void> {
  if (!loader) return;
  loader.classList.add('todoMissionLoading--done');
  await new Promise((resolve) => window.setTimeout(resolve, 220));
  loader.remove();
}

function cancelTodoMissionPlannerLoading(loader: HTMLElement | null): void {
  if (loader) loader.remove();
}

// ── Minallo Study Builder Canvas ──────────────────────────────────────────────
// A Minallo-specific loading animation for cheatsheet/summary generation. Instead
// of exposing raw tool names ("loading skills", "live AI thinking"), it shows a
// small A4 study sheet filling itself section by section — communicating that
// Minallo is *building a real study document*, not running an AI skill.

type StudyBuilderIntent = 'summary' | 'cheatsheet';

type StudyBuilderElement = HTMLElement & {
  _skillLoadingTimer?: number;
  _builderStart?: number;
};

type StudyBuilderCopy = {
  title: string;
  subtitle: string;
  steps: string[];
  chips: string[];
};

const STUDY_BUILDER_UI: Record<StudyBuilderIntent, StudyBuilderCopy> = {
  cheatsheet: {
    title: 'Building your cheatsheet',
    subtitle: 'Minallo is turning your uploaded course material into a compact, exam-ready study sheet.',
    steps: [
      'Reading your uploaded course',
      'Extracting formulas and definitions',
      'Selecting exam-relevant concepts',
      'Organizing everything into sections',
      'Finalizing the cheatsheet layout'
    ],
    chips: ['Formulas', 'Definitions', 'Key ideas', 'Exam traps']
  },
  summary: {
    title: 'Building your summary',
    subtitle: 'Minallo is turning your uploaded course material into a clear, exam-ready study summary.',
    steps: [
      'Reading your uploaded course',
      'Pulling out the key points',
      'Selecting what matters most',
      'Organizing everything into sections',
      'Finalizing the summary layout'
    ],
    chips: ['Key ideas', 'Definitions', 'Summary', 'Exam tips']
  }
};

/**
 * Render the Minallo Study Builder Canvas inside a chat bubble while a
 * cheatsheet/summary is generating. Self-contained: it animates its own steps,
 * blocks and progress bar, and loops smoothly until finishStudyBuilderLoading()
 * is called with the real result. Reuses `_skillLoadingTimer` so the existing
 * finish/cleanup contract still applies.
 */
function showStudyBuilderLoading(
  bubble: HTMLElement | null,
  intent: StudyBuilderIntent
): HTMLElement | null {
  if (!bubble) return null;
  const copy = STUDY_BUILDER_UI[intent];
  const blockKinds = ['formula', 'definition', 'concept', 'trap'];

  const el = document.createElement('div') as StudyBuilderElement;
  el.className = 'ncb-builder ncb-builder--' + intent;
  el.setAttribute('aria-live', 'polite');
  el.style.setProperty('--ncb-builder-progress', '8%');
  el._builderStart = Date.now();

  const stepsHtml = copy.steps
    .map((s, i) =>
      '<li class="ncb-builder-step" data-step="' + i + '">' +
        '<span class="ncb-builder-step-mark" aria-hidden="true"></span>' +
        '<span class="ncb-builder-step-text">' + escapeHtml(s) + '</span>' +
      '</li>')
    .join('');

  const chipsHtml = copy.chips
    .map((c, i) =>
      '<span class="ncb-builder-chip ncb-builder-chip--' + (i + 1) + '">' + escapeHtml(c) + '</span>')
    .join('');

  const blocksHtml = blockKinds
    .map((kind, i) =>
      '<div class="ncb-builder-block ncb-builder-block--' + kind + '" data-block="' + i + '">' +
        '<span class="ncb-builder-block-tag"></span>' +
        '<span class="ncb-builder-block-line"></span>' +
        '<span class="ncb-builder-block-line short"></span>' +
      '</div>')
    .join('');

  el.innerHTML =
    '<div class="ncb-builder-glow" aria-hidden="true"></div>' +
    '<div class="ncb-builder-head">' +
      '<span class="ncb-builder-spark" aria-hidden="true">&#10022;</span>' +
      '<span class="ncb-builder-brand">' +
        '<strong>Minallo AI</strong>' +
        '<span>Creating your study sheet from course context</span>' +
      '</span>' +
    '</div>' +
    '<div class="ncb-builder-body">' +
      '<div class="ncb-builder-left">' +
        '<div class="ncb-builder-title">' + escapeHtml(copy.title) + '</div>' +
        '<div class="ncb-builder-sub">' + escapeHtml(copy.subtitle) + '</div>' +
        '<ul class="ncb-builder-steps">' + stepsHtml + '</ul>' +
      '</div>' +
      '<div class="ncb-builder-canvas" aria-hidden="true">' +
        '<div class="ncb-builder-sheet">' +
          '<div class="ncb-builder-sheet-title"></div>' +
          '<div class="ncb-builder-blocks">' + blocksHtml + '</div>' +
        '</div>' +
        chipsHtml +
      '</div>' +
    '</div>' +
    '<div class="ncb-builder-progress" aria-hidden="true"><span></span></div>';

  const stepEls = Array.from(el.querySelectorAll<HTMLElement>('.ncb-builder-step'));
  const blockEls = Array.from(el.querySelectorAll<HTMLElement>('.ncb-builder-block'));
  let activeStep = 0;

  const paint = (): void => {
    stepEls.forEach((s, i) => {
      s.classList.toggle('is-done', i < activeStep);
      s.classList.toggle('is-active', i === activeStep);
    });
    // Reveal blocks progressively as the steps advance.
    const revealCount = Math.min(blockEls.length, Math.round((activeStep / Math.max(copy.steps.length - 1, 1)) * blockEls.length));
    blockEls.forEach((b, i) => b.classList.toggle('is-in', i < revealCount));
    const pct = Math.min(94, 8 + ((activeStep + 1) / copy.steps.length) * 80);
    el.style.setProperty('--ncb-builder-progress', pct.toFixed(0) + '%');
  };
  paint();

  el._skillLoadingTimer = window.setInterval(() => {
    // Loop smoothly: advance through steps, then idle on the last step until done.
    activeStep = Math.min(activeStep + 1, copy.steps.length - 1);
    paint();
  }, 900);

  bubble.prepend(el);
  return el;
}

/**
 * Complete and remove the Study Builder Canvas once the real result is ready.
 * Holds a short minimum on-screen time so the animation never flashes, fills the
 * progress bar to 100% and ticks every step done before fading out.
 */
/** Tear the Study Builder Canvas down immediately (pause pressed / request
 *  failed). Without this the step-cycling interval keeps firing on a detached
 *  element after the abort path overwrites the bubble. */
function cancelStudyBuilderLoading(builder: HTMLElement | null): void {
  if (!builder) return;
  const el = builder as StudyBuilderElement;
  if (el._skillLoadingTimer) {
    window.clearInterval(el._skillLoadingTimer);
    el._skillLoadingTimer = undefined;
  }
  el.remove();
}

async function finishStudyBuilderLoading(builder: HTMLElement | null): Promise<void> {
  if (!builder) return;
  const el = builder as StudyBuilderElement;
  const MIN_MS = 1400;
  const elapsed = Date.now() - (el._builderStart ?? Date.now());
  if (elapsed < MIN_MS) await new Promise((r) => window.setTimeout(r, MIN_MS - elapsed));

  if (el._skillLoadingTimer) {
    window.clearInterval(el._skillLoadingTimer);
    el._skillLoadingTimer = undefined;
  }
  el.querySelectorAll('.ncb-builder-step').forEach((s) => {
    s.classList.add('is-done');
    s.classList.remove('is-active');
  });
  el.querySelectorAll('.ncb-builder-block').forEach((b) => b.classList.add('is-in'));
  el.style.setProperty('--ncb-builder-progress', '100%');
  el.classList.add('ncb-builder--done');
  await new Promise((r) => window.setTimeout(r, 320));
  el.remove();
}

/** Notes need a single, concrete source — unlike summary/cheatsheet which can
 *  pull from "current course sources" broadly. This resolves a target file
 *  (the one the student has open, or the course's only file), asks a
 *  clarifying question when the choice is ambiguous, then grounds generation
 *  on that file's extracted text via the same single-shot `/api/notes/generate`
 *  call the Notes panel uses for short documents. */
async function handleNotesIntent(
  courseId: string,
  bubble: HTMLElement | null,
  signal?: AbortSignal
): Promise<string> {
  const w = window as unknown as {
    activeFileName?: string | null;
    activeCourseRef?: { id?: string; files?: Array<{ name?: string }> } | null;
    SEMS?: Record<string, { courses?: Array<{ id?: string; files?: Array<{ name?: string }> }> }>;
    sdActiveSemId?: string;
  };

  const course =
    (w.activeCourseRef?.id === courseId ? w.activeCourseRef : null) ||
    w.SEMS?.[w.sdActiveSemId || '']?.courses?.find((c) => c.id === courseId) ||
    null;
  const files = (course?.files || [])
    .map((f) => (typeof f.name === 'string' ? f.name : null))
    .filter((name): name is string => !!name && /\.pdf$/i.test(name));

  let fileName: string | null = null;
  if (w.activeFileName && files.includes(w.activeFileName)) fileName = w.activeFileName;
  else if (files.length === 1) fileName = files[0] ?? null;

  if (!fileName) {
    const text = files.length
      ? 'Which file should I make notes from?\n\n' +
        files.slice(0, 8).map((n) => '• ' + n).join('\n') +
        '\n\nOpen the file you want, then ask me again — e.g. "make notes from this lecture".'
      : 'I can make notes from a course file. Open the source you want, then ask "make notes from this lecture".';
    if (bubble) renderRichBubble(bubble, text);
    return text;
  }

  if (bubble) renderRichBubble(bubble, 'Reading **' + fileName + '** and writing your notes…');
  try {
    const [extraction, ai] = await Promise.all([
      import('../pdf-viewer/pdf-text-extraction.js'),
      import('../../services/ai-service.js')
    ]);
    const [rawText] = await extraction.extractMultiplePdfs([fileName], 20);
    if (signal) throwIfAborted(signal);
    const pdfText = (rawText || '').replace(/^=== .*? ===\n/, '');
    const result = await ai.generateNotes(courseId, { fileName, pdfText }, signal);
    if (signal) throwIfAborted(signal);
    if (result.error || !result.note?.content_markdown) {
      const text = 'I could not generate notes from ' + fileName + ' right now. Please try again from the Notes tab.';
      if (bubble) renderRichBubble(bubble, text);
      return text;
    }
    const text =
      'Notes from ' + fileName + ' (saved to your Notes tab):\n\n' + result.note.content_markdown;
    if (bubble) renderRichBubble(bubble, text);
    return text;
  } catch (err) {
    // Pause pressed: let the caller render the standard "Response stopped."
    if ((err as Error)?.name === 'AbortError') throw err;
    const text = 'I could not generate notes from ' + fileName + ' right now. Please try again from the Notes tab.';
    if (bubble) renderRichBubble(bubble, text);
    return text;
  }
}

/** Resolves the matching course object from global app state, then jumps the
 *  user into My Courses on the right tab — mirrors the dashboard widget's
 *  "open course" wiring (see dashboard-widget.js `cw-pill` handler) so a tap
 *  on a Daily Mission task button lands exactly where the work lives. */
function buildDailyMissionHandlers(courseId: string): DailyMissionPanelHandlers {
  const w = window as unknown as {
    activeCourseRef?: { id?: string } | null;
    sdActiveSemId?: string;
    SEMS?: Record<string, { courses?: Array<{ id?: string; name?: string }> }>;
    setNavActive?: (id: string) => void;
    showPortalSection?: (section: string) => void;
    openCourse?: (course: unknown) => void;
    showCourseSection?: (course: unknown, section: string) => void;
  };

  const findCourse = (): unknown | null => {
    if (w.activeCourseRef?.id === courseId) return w.activeCourseRef;
    const sem = w.SEMS?.[w.sdActiveSemId || ''];
    return sem?.courses?.find((c) => c.id === courseId) || null;
  };

  const goToSection = (section: string): void => {
    const course = findCourse();
    if (!course) return;
    w.setNavActive?.('pcStudip');
    w.showPortalSection?.('studip');
    w.openCourse?.(course);
    if (section !== 'files') w.showCourseSection?.(course, section);
  };

  return {
    onOpenSource: () => goToSection('files'),
    onOpenDeepLearn: () => goToSection('deeplearn'),
    onOpenExamForge: () => goToSection('examforge'),
    onGenerateQuiz: () => goToSection('quiz'),
    onCreateFlashcards: () => goToSection('flashcards')
  };
}

function renderDailyMissionText(data: DailyMissionResponse): string {
  if (data.summary.noValidCandidates) {
    return 'Daily Study Mission\n\nMinallo needs confirmed course sources before it can create trusted tasks. Review your Course Map or upload/re-index course files first.';
  }
  if (!data.tasks.length) {
    return 'Daily Study Mission\n\nNo mission exists yet for today. Choose a course with confirmed sources and ask me to generate it.';
  }
  const lines = [
    'Daily Study Mission',
    '',
    String(data.summary.completedTasks) + '/' + String(data.summary.totalTasks) + ' done · ' + String(data.summary.minutesRemaining) + ' min left',
    ''
  ];
  (['must_do', 'should_do', 'optional'] as const).forEach((group) => {
    const rows = data.tasks.filter((t) => t.priority_group === group && t.status !== 'replaced');
    if (!rows.length) return;
    lines.push(group === 'must_do' ? 'Must Do' : group === 'should_do' ? 'Should Do' : 'Optional');
    rows.forEach((t, i) => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'unavailable' ? '[!]' : '[ ]';
      const pages = t.page_start ? ' · p.' + t.page_start + (t.page_end && t.page_end !== t.page_start ? '-' + t.page_end : '') : '';
      lines.push(mark + ' ' + String(i + 1) + '. ' + t.title + ' · ' + t.estimated_minutes + ' min' + pages);
      if (t.reason) lines.push('   ' + t.reason);
    });
    lines.push('');
  });
  lines.push('Use the task buttons in the mission card to start, mark done, skip, or move work.');
  return lines.join('\n');
}

function chatbotThinkingContext(state: ConversationState): ReturnType<typeof getThinkingContext> {
  const last = state.messages[state.messages.length - 1];
  const active = chatStore.getActive();
  return getThinkingContext({
    question: last?.text || '',
    tutorMode: getCurrentTutorMode(),
    selectedSourceCount: active.selectedSourceIds.length,
    filesCount: (last?.files || []).length,
    hasCourseMaterial: active.selectedSourceIds.length > 0
  });
}


// ── Phase 12 wiring helpers ─────────────────────────────────────────────────


// Matches /ask-stream's openFileContext cap (_MAX_STREAM_OPEN_FILE_CTX_CHARS)
// so a long cheatsheet never 400s the request.
const NCB_GENERATED_DOC_CONTEXT_CHARS = 20000;

// "explain the cheatsheet", "translate that summary", "what's in the pdf you
// made" — EN + DE forms. Used only when the doc is NOT the reply the user is
// directly responding to, so unrelated later questions don't drag a 20k-char
// document into every prompt.
const GENERATED_DOC_REF_RE =
  /\b(cheat\s*-?\s*sheets?|spickzettel|formelsammlung|formula sheets?|summar(y|ies)|zusammenfassung(en)?|pdf|(that|the|this|das|die) (file|document|doc|sheet|datei|dokument)|(you|du) (just )?(made|created|generated|erstellt|generiert))\b/i;

/** The generated doc the latest user message is asking about, if any.
 *  Always returns the doc when the user is replying directly to the
 *  "Your cheatsheet is ready" turn; otherwise only on an explicit mention. */
function generatedDocForFollowUp(messages: ChatMessage[]): GeneratedDoc | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !last.text) return null;
  let doc: GeneratedDoc | null = null;
  let docIdx = -1;
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.generatedDoc?.markdown) {
      doc = m.generatedDoc;
      docIdx = i;
      break;
    }
  }
  if (!doc) return null;
  if (docIdx === messages.length - 2) return doc;
  return GENERATED_DOC_REF_RE.test(last.text) ? doc : null;
}

function generatedDocLabel(doc: GeneratedDoc): string {
  const kind = doc.kind === 'summary' ? 'Summary' : 'Cheatsheet';
  return doc.title && doc.title !== kind ? kind + ' — ' + doc.title : kind;
}

// Stricter gates for the cross-chat restore below: a kind word or a "you
// made/created it" phrase. The broad REF regex (which also matches a bare
// "pdf") is fine when the doc demonstrably exists in THIS chat, but too loose
// to justify fetching a note and attaching 20k chars on a hunch.
const GENERATED_DOC_KIND_RE =
  /\b(cheat\s*-?\s*sheets?|spickzettel|formelsammlung|formula sheets?|summar(y|ies)|zusammenfassung(en)?)\b/i;
const GENERATED_DOC_MADE_RE =
  /\b(you|du) (just )?(made|created|generated|erstellt|generiert)\b/i;

/** Restore the last generated cheatsheet/summary for a course from the
 *  pointers written at generation time: `minallo_cs_last_<courseId>` holds a
 *  noteId (the content lives in the saved note), `minallo_sum_last_<courseId>`
 *  holds the markdown inline. */
async function restoreGeneratedDocForCourse(
  courseId: string,
  userText: string
): Promise<GeneratedDoc | null> {
  const mentionsSummary = /\b(summar|zusammenfassung)/i.test(userText);
  const mentionsCheatsheet = /\b(cheat|spickzettel|formelsammlung|formula sheet)/i.test(userText);

  const tryCheatsheet = async (): Promise<GeneratedDoc | null> => {
    let stored: { noteId?: string; title?: string } | null = null;
    try {
      stored = JSON.parse(localStorage.getItem('minallo_cs_last_' + courseId) || 'null') as
        { noteId?: string; title?: string } | null;
    } catch { return null; }
    if (!stored?.noteId) return null;
    try {
      const svc = await import('../../services/ai-service.js');
      const note = await svc.getNoteById(stored.noteId);
      if (!note?.content_markdown) return null;
      return {
        kind: 'cheatsheet',
        title: note.title || stored.title || 'Cheatsheet',
        markdown: note.content_markdown,
        courseId,
        noteId: stored.noteId,
      };
    } catch { return null; }
  };

  const trySummary = (): GeneratedDoc | null => {
    try {
      const stored = JSON.parse(localStorage.getItem('minallo_sum_last_' + courseId) || 'null') as
        { markdown?: string; title?: string } | null;
      if (!stored?.markdown) return null;
      return { kind: 'summary', title: stored.title || 'Summary', markdown: stored.markdown, courseId };
    } catch { return null; }
  };

  if (mentionsSummary && !mentionsCheatsheet) return trySummary() ?? await tryCheatsheet();
  return (await tryCheatsheet()) ?? trySummary();
}

/** The generated doc the latest user message asks about. In-chat generatedDoc
 *  first; otherwise restore from the per-course pointers — that also covers
 *  chats whose cheatsheet message predates generatedDoc (shipped 2026-06-11)
 *  and docs generated in a different chat or before a page refresh trimmed
 *  them from storage. */
async function resolveFollowUpDoc(
  messages: ChatMessage[],
  preferredCourseId: string | null
): Promise<GeneratedDoc | null> {
  const inChat = generatedDocForFollowUp(messages);
  if (inChat) return inChat;

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !last.text) return null;
  if (!GENERATED_DOC_KIND_RE.test(last.text) && !GENERATED_DOC_MADE_RE.test(last.text)) return null;

  // Most plausible course first; first pointer hit wins. The loop is cheap:
  // a network fetch only happens for courses that actually have a pointer.
  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (id: string | null | undefined): void => {
    const v = (id || '').trim();
    if (v && !seen.has(v)) { seen.add(v); candidates.push(v); }
  };
  push(preferredCourseId);
  push(String((window as unknown as { activeCourseId?: string | null }).activeCourseId || ''));
  listAllCourses().forEach((c) => push(c.id));
  for (const cid of candidates) {
    const doc = await restoreGeneratedDocForCourse(cid, last.text);
    if (doc) return doc;
  }
  return null;
}

/** Decide whether the latest user turn should go through RAG (`/ask-stream`)
 * or the generic chat endpoint. Returns the resolved RAG payload when
 * eligible, else null. */
function ragEligibility(
  messages: ChatMessage[]
): { question: string; courseId: string; documentIds: string[]; documentNames: string[] } | null {
  if (!messages.length) return null;
  const last = messages[messages.length - 1]!;
  if (last.role !== 'user') return null;
  if (!last.text || !last.text.trim()) return null;
  // Images and file uploads aren't supported by /ask-stream — fall through.
  if ((last.images || []).length || (last.files || []).length) return null;

  const active = chatStore.getActive();
  const selected = sourceLibrary.items.filter((s) => active.selectedSourceIds.includes(s.id));

  // Selecting sources is an explicit scoping action: whenever the user has any
  // sources selected, narrow retrieval to exactly those files — regardless of
  // the all/specific toggle (which most users never touch, so a selection used
  // to be silently ignored and retrieval searched the whole course). Only when
  // nothing is selected do we fall back to a whole-course search.
  // The client only knows storage file NAMES (the document-table id lives
  // server-side), so we send names and let the backend resolve them to ids; ids
  // are sent too when known.
  let documentIds: string[] = [];
  let documentNames: string[] = [];
  const scopeToSelection =
    selected.length > 0 || normaliseCourseFileScope(active.courseFileScope) === 'specific_files';
  if (scopeToSelection) {
    const ids = new Set<string>();
    const names = new Set<string>();
    selected.forEach((s) => {
      (s.documents || []).forEach((d) => {
        if (d.id) ids.add(d.id);
        if (d.name) names.add(d.name);
      });
      // A file-type source exposes its filename as the source name. Some items
      // (migrated chats, sources imported without expanded documents[]) have an
      // empty documents[] — without this the whole selection would be sent as
      // nothing and retrieval would silently fall back to a whole-course search.
      if (s.name && /\.(pdf|docx?|txt|pptx?)$/i.test(s.name)) names.add(s.name);
    });
    documentIds = Array.from(ids);
    documentNames = Array.from(names);
  }

  // All selected sources are expected to come from the same course (the
  // import UI scopes by course). Pick the first one's courseId as the
  // request scope. If they ever mix courses we still pick the first —
  // worst case is RAG searches a smaller-than-expected universe.
  const fallbackCourseId = String((window as unknown as { activeCourseId?: string | null }).activeCourseId || '');
  const courseId = selected[0]?.courseId || fallbackCourseId;
  if (!courseId) {
    // No course context. Internet mode still works — a web search needs no
    // course — so route it through /ask-stream with an empty courseId (the
    // backend's INTERNET branch returns before any course/retrieval logic).
    // Auto mode joins it when the question contains a URL: the generic chat
    // path cannot fetch pages and used to answer "I can't access external
    // content" — the backend's auto router resolves a URL question to its
    // INTERNET branch (mirrors _URL_RE in source_router.py). Course Files
    // stays on the generic path when there's no course to ground against.
    const mode = normaliseSourceMode(active.sourceMode);
    const hasUrl = /(?:https?:\/\/|www\.)\S+|\byoutu\.be\/\S+|\b(?:youtube|wikipedia|github|stackoverflow)\.(?:com|org)\b/i.test(last.text);
    if (mode === 'internet' || (mode === 'auto' && hasUrl)) {
      return { question: last.text.trim(), courseId: '', documentIds: [], documentNames: [] };
    }
    return null;
  }

  return { question: last.text.trim(), courseId, documentIds, documentNames };
}


/** Call the Python `/ask-stream` SSE endpoint. Streams tokens into
 * ``bubble`` as they arrive and resolves with the full answer text once
 * the stream completes. */
async function streamFromAskStream(
  question: string,
  courseId: string,
  bubble: HTMLElement | null,
  controller: AbortController,
  previousTurns: Array<{ role: 'user' | 'assistant'; text: string }> = [],
  thinking?: AIThinkingStatus | null,
  documentIds: string[] = [],
  documentNames: string[] = [],
  generatedDoc: GeneratedDoc | null = null,
  allowDiagrams = true
): Promise<{ text: string; meta: Record<string, unknown> | null }> {
  const aiHost = ((window as unknown as { AI_SERVICE_URL?: string }).AI_SERVICE_URL || '').replace(/\/$/, '');
  if (!aiHost) {
    // Misconfigured: graceful fallback to the generic path.
    const text = await callGenericAi([{ role: 'user', text: question }], bubble, controller, thinking, null, allowDiagrams);
    return { text, meta: null };
  }
  const token = getSbToken() || '';

  const resp = await fetch(aiHost + '/ask-stream', {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      courseId,
      question,
      tutorMode: getCurrentTutorMode(),
      sourceMode: sourceModeForActiveChat(),
      // When we send a document selection, tell the backend to hard-scope to
      // it (specific_files); otherwise it would treat the default
      // all_course_files scope as "search everything" and ignore the ids.
      courseFileScope:
        documentIds.length || documentNames.length ? 'specific_files' : courseFileScopeForActiveChat(),
      previousTurns,
      // UI location (page / course tab / open document) for the backend's
      // live-workspace block. In the standalone Chatbot this mostly carries
      // page='chatbot' unless a course/PDF is open behind it.
      pageContext: buildPageContext() || undefined,
      // Only sent for "Selected file(s)" scope — narrows retrieval to these
      // documents. The client knows file names, not document ids, so names are
      // the working path (backend resolves them); ids are sent when known.
      // Both omitted for "All files" (whole-course search).
      ...(documentIds.length ? { documentIds } : {}),
      ...(documentNames.length ? { documentNames } : {}),
      // The cheatsheet/summary this chat generated, when the question is about
      // it. openFileContext is the backend's "text the student is looking at"
      // channel — retrieval can't surface a generated doc (it's a note, not an
      // indexed course file), so it's handed over verbatim.
      ...(generatedDoc ? {
        activeFileName: generatedDocLabel(generatedDoc),
        openFileContext: generatedDoc.markdown.slice(0, NCB_GENERATED_DOC_CONTEXT_CHARS),
      } : {}),
    }),
  });
  if (!resp.ok || !resp.body || !resp.body.getReader) {
    const errText = await resp.text().catch(() => '');
    throw new Error('Ask-stream ' + resp.status + ': ' + errText.slice(0, 200));
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let answerBuf = '';
  let doneMeta: Record<string, unknown> | null = null;
  let liveReveal: ReturnType<typeof createSoftStreamReveal> | null = null;
  let hasLiveReveal = false;

  const ensureLiveReveal = async (): Promise<ReturnType<typeof createSoftStreamReveal>> => {
    if (liveReveal) return liveReveal;
    if (thinking) await thinking.waitMinimum();
    thinking?.remove(true);
    liveReveal = createSoftStreamReveal(bubble, { allowDiagrams });
    hasLiveReveal = true;
    return liveReveal;
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    sseBuffer += decoder.decode(result.value, { stream: true });
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const evt = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (typeof evt.t === 'string') {
          answerBuf += evt.t;
          const reveal = await ensureLiveReveal();
          reveal.push(evt.t);
        }
        if (evt.done) doneMeta = evt;
        if (evt.error) throw new Error(String(evt.error));
      } catch {
        /* ignore malformed line */
      }
    }
  }

  // Re-render with full markdown now that we have the complete text. Inline
  // [Source N] markers are internal grounding anchors; the user sees sources
  // only in the collapsible footer appended below.
  const displayAnswer = sanitizeChatbotDiagrams(
    stripSourceMarkers(answerBuf || tStr('cb_no_response', 'No response.')),
    allowDiagrams
  );
  const revealToFinish = liveReveal as ReturnType<typeof createSoftStreamReveal> | null;
  if (hasLiveReveal && revealToFinish) {
    await revealToFinish.finish();
  } else {
    if (thinking) await thinking.waitMinimum();
    thinking?.remove(true);
  }
  if (bubble) renderRichBubble(bubble, displayAnswer, allowDiagrams);

  // Append sources if the server included them. Verification stays internal.
  if (doneMeta && bubble) appendAskStreamMeta(bubble, doneMeta);

  return { text: displayAnswer, meta: doneMeta };
}


/** In the standalone chatbot the course is never "opened" in the Courses view,
 * so its SEMS course object starts with an empty `files` array — which means
 * source-link.ts has nothing to resolve a clicked citation against (by name OR
 * id) and shows "Source unavailable". Lazily load the active chat's course
 * files via the app's `_ufMerge` so the cited file can be located and opened.
 * Best-effort and idempotent (`_ufMerge` dedupes in-flight loads). */
async function ensureChatCourseFilesLoaded(): Promise<void> {
  const active = chatStore.getActive();
  const selected = sourceLibrary.items.filter((s) => active.selectedSourceIds.includes(s.id));
  const courseId =
    selected[0]?.courseId ||
    String((window as unknown as { activeCourseId?: string | null }).activeCourseId || '');
  if (!courseId) return;
  const w = window as unknown as {
    SEMS?: Record<string, { courses?: Array<{ id?: string; files?: unknown[] }> }>;
    _SEMS?: Record<string, { courses?: Array<{ id?: string; files?: unknown[] }> }>;
    _ufMerge?: (course: unknown) => Promise<unknown>;
  };
  const sems = w.SEMS || w._SEMS;
  if (!sems || typeof w._ufMerge !== 'function') return;
  let course: { id?: string; files?: unknown[] } | undefined;
  for (const sem of Object.values(sems)) {
    course = (sem.courses || []).find((c) => c.id === courseId);
    if (course) break;
  }
  if (course && !(Array.isArray(course.files) && course.files.length)) {
    try { await w._ufMerge(course); } catch { /* best effort — resolution just falls back */ }
  }
}

/** Render the `done` event meta into the answer bubble: source list only.
 * Verification/confidence status remains internal and is not shown to users. */
function appendAskStreamMeta(bubble: HTMLElement, meta: Record<string, unknown>): void {
  const sources = Array.isArray(meta.sources) ? meta.sources : [];
  const sourceLabel = typeof meta.sourceLabel === 'string' ? meta.sourceLabel : '';

  let footerHtml = '';
  if (sourceLabel) footerHtml += '<div class="ncb-source-used">' + escapeHtml(sourceLabel) + '</div>';
  let sourceHtml = '';
  if (sources.length) {
    const items = sources
      .map((s, i) => {
        const src = s as SrcItem;
        const name = src.file_name || src.title || 'Unknown';
        // Web sources carry a URL — render them as real links that open in a
        // new tab. Scheme-check so a model-supplied `javascript:`/`data:` URL
        // can never become a clickable anchor.
        const safeUrl = src.url && /^https?:\/\//i.test(src.url) ? src.url : '';
        if (safeUrl) {
          return (
            '<li class="src-web"><a href="' + escapeAttr(safeUrl) +
            '" target="_blank" rel="noopener noreferrer nofollow">' + escapeHtml(name) + '</a></li>'
          );
        }
        const clickable = !!src.file_name && !/problem solver|visible|^source 0$/i.test(name);
        let line =
          '<li' + (clickable ? ' class="src-cite" title="Open this source" data-src-i="' + i + '"' : '') + '>' +
          escapeHtml(name);
        if (src.pages) line += ', p.' + escapeHtml(String(src.pages));
        if (src.section) line += ' · <em>' + escapeHtml(src.section) + '</em>';
        line += '</li>';
        return line;
      })
      .join('');
    sourceHtml = '<details class="ncb-ask-sources"><summary>' + escapeHtml(tStr('cb_sources_summary', 'Sources')) + ' (' + sources.length + ')</summary><ul>' + items + '</ul></details>';
  }
  footerHtml += sourceHtml;
  if (footerHtml) {
    const footer = document.createElement('div');
    footer.className = 'ncb-ask-footer';
    footer.innerHTML = footerHtml;
    footer.querySelectorAll<HTMLElement>('.ncb-ask-sources .src-cite').forEach((el) => {
      el.addEventListener('click', async () => {
        const src = sources[Number(el.dataset.srcI)] as SrcItem | undefined;
        if (!src) return;
        // Make sure the course's files are loaded before resolving, otherwise
        // the lookup has nothing to match against in the chatbot context.
        await ensureChatCourseFilesLoaded();
        handleSourceClick(
          { fileName: src.file_name, documentId: src.documentId, page: src.pageStart ?? firstPage(src.pages) },
          'popup'
        );
      });
    });
    // Web-source links open natively in a new tab; stop the click from
    // bubbling to any app-level link handler that might keep it in-tab.
    footer.querySelectorAll<HTMLAnchorElement>('.ncb-ask-sources .src-web a').forEach((a) => {
      a.addEventListener('click', (ev) => ev.stopPropagation());
    });
    bubble.appendChild(footer);
  }
}

interface SrcItem {
  file_name?: string;
  pages?: string | null;
  section?: string | null;
  documentId?: string | null;
  pageStart?: number | null;
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
}

// Mirrors strip_answer_intro in answer.py: drops banned opening announcements
// (the old "### Course material found" preface, "I will use these uploaded
// course sources…", "I'm powered by Minallo AI…") so answers saved BEFORE the
// backend scrub still render starting with the substance. Sources render
// once, in the dropdown below the answer.
const ANSWER_INTRO_RX = new RegExp(
  '^\\s*(?:' +
    '#{1,6}\\s*course material found[^\\n]*' +
    '|-\\s*\\[source\\s+\\d+\\][^\\n]*' +
    "|i(?:'|’)?m\\s+(?:minallo\\b|powered\\s+by\\b)[^.!\\n]*[.!]?" +
    '|i\\s+am\\s+(?:minallo\\b|powered\\s+by\\b)[^.!\\n]*[.!]?' +
    "|i(?:\\s+will|(?:'|’)ll)\\s+use\\s+(?:th(?:e|ese|is)|your)\\s+(?:uploaded\\s+)?(?:course\\s+)?(?:sources?|materials?|files?|documents?)[^.!\\n]*[.!]?" +
    "|based\\s+on\\s+(?:the\\s+|your\\s+|these\\s+)?(?:provided\\s+|uploaded\\s+|retrieved\\s+)?(?:course\\s+)?(?:sources?|materials?|documents?)\\s*,?\\s*(?:here(?:'|’)?s\\b|here\\s+is\\b|below\\s+is\\b|i(?:\\s+will|(?:'|’)ll)\\b)[^.!:\\n]*[.!:]?" +
    '|ich\\s+bin\\s+minallo\\b[^.!\\n]*[.!]?' +
    '|ich\\s+werde\\s+von\\s+minallo\\b[^.!\\n]*[.!]?' +
    '|ich\\s+(?:werde|nutze|verwende)\\s+(?:diese|die|deine|ihre)\\s+(?:hochgeladenen?\\s+\\w*|kurs\\w*)[^.!\\n]*[.!]?' +
    ')[ \\t]*',
  'i'
);

function stripAnswerIntro(text: string): string {
  let out = text || '';
  for (;;) {
    const m = out.match(ANSWER_INTRO_RX);
    if (!m || !m[0].trim()) break;
    out = out.slice(m[0].length);
  }
  return out === text ? text : out.replace(/^\n+/, '');
}

function stripSourceMarkers(text: string): string {
  return stripAnswerIntro(text || "")
    .replace(/\s*\[Source\s+\d+\]/gi, "")
    .replace(/\s+\./g, ".")
    .replace(/\s+,/g, ",")
    .trim();
}

function stripSourceMarkersLive(text: string): string {
  // NOTE: no intro strip here — live rendering also passes TAIL slices of
  // the buffer through this, and the start-anchored intro patterns must only
  // ever run against text that begins at position 0.
  return (text || "")
    .replace(/\s*\[Source\s+\d+\]/gi, "")
    .replace(/\s+\./g, ".")
    .replace(/\s+,/g, ",");
}

function takeSoftStreamChunk(text: string, target = 18): string {
  if (text.length <= target) return text;
  const searchEnd = Math.min(text.length, target + 12);
  for (let i = target; i < searchEnd; i++) {
    if (/\s/.test(text[i] || '')) return text.slice(0, i + 1);
  }
  return text.slice(0, target);
}

function appendSoftChunk(host: HTMLElement, text: string): void {
  if (!text) return;
  const chunk = document.createElement('span');
  chunk.className = 'ncb-stream-chunk';
  chunk.textContent = text;
  host.appendChild(chunk);
}

/** Length of the longest prefix of `text` that is safe to render as full
 * markdown+KaTeX mid-stream — i.e. it ends on a paragraph boundary and is not
 * sitting inside an unclosed `$$…$$` display block, inline `$…$`, or fenced
 * ```code``` block. The remainder (the in-progress tail) is shown raw until it
 * completes. This lets finished equations/paragraphs typeset block-by-block
 * instead of the whole answer flashing from raw LaTeX to rendered at the end. */
function streamStableLen(text: string): number {
  let inFence = false;   // inside ```…``` (toggled at line start)
  let inDisplay = false; // inside $$…$$
  let inInline = false;  // inside $…$
  let lastSafe = 0;
  const n = text.length;
  let i = 0;
  while (i < n) {
    // Fenced code toggles only when ``` begins a line.
    if (!inDisplay && !inInline && text.startsWith('```', i) && (i === 0 || text[i - 1] === '\n')) {
      inFence = !inFence;
      i += 3;
      continue;
    }
    if (inFence) { i++; continue; }
    if (text.startsWith('$$', i)) {
      inDisplay = !inDisplay;
      i += 2;
      continue;
    }
    if (text[i] === '$' && !inDisplay) {
      inInline = !inInline;
      i++;
      continue;
    }
    // Paragraph boundary: a blank line outside any math/code construct. A
    // closed $$…$$ block is followed by a blank line, so this also captures
    // completed display equations.
    if (!inDisplay && text[i] === '\n' && text[i + 1] === '\n') {
      let j = i;
      while (j < n && text[j] === '\n') j++;
      inInline = false; // a stray currency '$' shouldn't poison later blocks
      lastSafe = j;
      i = j;
      continue;
    }
    i++;
  }
  return lastSafe;
}

function createSoftStreamReveal(
  bubble: HTMLElement | null,
  options: { allowDiagrams?: boolean } = {}
): {
  push: (text: string) => void;
  finish: () => Promise<void>;
} {
  if (!bubble) {
    return { push: () => {}, finish: async () => {} };
  }

  // Two regions: `rendered` holds completed blocks typeset with full
  // markdown+KaTeX, `live` shows only the in-progress tail as raw plain text
  // (with the soft-reveal animation). As blocks complete they move from `live`
  // into `rendered`, so finished equations typeset in place instead of the
  // whole answer staying raw until the end.
  bubble.innerHTML = '';
  const rendered = document.createElement('div');
  rendered.className = 'ncb-stream-rendered';
  const live = document.createElement('div');
  live.className = 'ncb-stream-live';
  bubble.appendChild(rendered);
  bubble.appendChild(live);

  let rawText = '';        // full raw text revealed so far (incl. source markers)
  let stableLen = 0;       // chars of rawText already promoted into `rendered`
  let visibleTail = '';    // stripped tail text currently shown in `live`
  let buffer = '';
  let raf: number | null = null;
  let timer: number | null = null;
  let finishResolve: (() => void) | null = null;

  const scroll = (): void => {
    const msgs = bubble.closest<HTMLElement>('.ncb-msgs');
    // Sticky follow: only track the streaming output while the user is near the
    // bottom, so they can scroll up to read earlier content mid-response.
    if (msgs) scrollMsgsToBottom(msgs, false);
  };

  // Promote any newly-completed blocks out of the raw tail into the rendered
  // region. Only runs the (costlier) markdown+KaTeX pass when the safe
  // boundary actually advances — i.e. once per completed block, not per token.
  const promoteStable = (): void => {
    const safe = streamStableLen(rawText);
    if (safe <= stableLen) return;
    stableLen = safe;
    renderRichBubble(
      rendered,
      stripSourceMarkersLive(rawText.slice(0, stableLen)).trim(),
      options.allowDiagrams !== false
    );
    live.textContent = '';
    visibleTail = '';
    scroll();
  };

  const renderTail = (): void => {
    const tail = stripSourceMarkersLive(rawText.slice(stableLen));
    if (!tail.startsWith(visibleTail)) {
      live.textContent = '';
      visibleTail = '';
    }
    const delta = tail.slice(visibleTail.length);
    if (delta) {
      appendSoftChunk(live, delta);
      visibleTail = tail;
      scroll();
    }
  };

  const clearScheduled = (): void => {
    if (raf != null) {
      window.cancelAnimationFrame(raf);
      raf = null;
    }
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const cleanup = (): void => {
    clearScheduled();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };

  const drain = (): void => {
    raf = null;
    timer = null;
    if (!buffer) {
      if (finishResolve) {
        const resolve = finishResolve;
        finishResolve = null;
        cleanup();
        resolve();
      }
      return;
    }
    const added = document.hidden ? buffer : takeSoftStreamChunk(buffer, 18);
    buffer = buffer.slice(added.length);
    rawText += added;
    promoteStable();
    renderTail();
    schedule();
  };

  const schedule = (): void => {
    if (raf != null || timer != null) return;
    if (document.hidden) timer = window.setTimeout(drain, 0);
    else raf = window.requestAnimationFrame(drain);
  };

  function onVisibilityChange(): void {
    if (!document.hidden || raf == null) return;
    window.cancelAnimationFrame(raf);
    raf = null;
    schedule();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    push(text: string): void {
      buffer += text;
      schedule();
    },
    finish(): Promise<void> {
      if (!buffer && raf == null && timer == null) {
        cleanup();
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        finishResolve = resolve;
        schedule();
      });
    },
  };
}


/** Generic /api/ai chat path (free-form, image/file aware). Kept as a
 * helper so streamAiReply can route to either RAG or chat without a
 * giant branch body. */
async function callGenericAi(
  messages: ChatMessage[],
  bubble: HTMLElement | null,
  controller: AbortController,
  thinking?: AIThinkingStatus | null,
  followUpDoc: GeneratedDoc | null = null,
  allowDiagrams = true
): Promise<string> {
  const apiMessages = buildApiMessages(messages, followUpDoc);
  const resp = await fetch('/api/ai', {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (getSbToken() || ''),
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 6000,
      system: buildSystemPrompt(),
      messages: apiMessages,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Server ' + resp.status + ': ' + errText.slice(0, 200));
  }
  const data = (await resp.json()) as { content?: Array<{ text?: string }>; error?: { message?: string } };
  const rawResponse = data.error
    ? tStr('cb_error_prefix', '❌ Error: ') + (data.error.message || JSON.stringify(data.error))
    : data.content
      ? data.content.map((b) => b.text || '').join('')
      : tStr('cb_no_response', 'No response.');
  const raw = sanitizeChatbotDiagrams(rawResponse, allowDiagrams);
  // Type into the bubble for the same UX as before.
  if (thinking) await thinking.waitMinimum();
  thinking?.remove(true);
  await typeIntoBubble(bubble, raw, () => controller.signal.aborted, allowDiagrams);
  return raw;
}

function abortSend(state: ConversationState): void {
  if (state.controller) state.controller.abort();
}

/** Mirror fetch's abort contract for non-fetch awaits: pressing pause must
 *  stop an intent flow at the next checkpoint instead of letting the result
 *  render after the user already gave up on it. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

function appendUserBubble(
  msgs: HTMLElement,
  text: string,
  images: PastedImage[],
  files: PendingFile[] = []
): void {
  const row = document.createElement('div');
  row.className = 'ncb-msg-row ncb-msg-row--user';
  const attachments = images
    .filter((img) => !!img.dataUrl)
    .map(
      (img) =>
        `<img class="ncb-bubble-image" src="${escapeAttr(img.dataUrl)}" alt="${escapeAttr(img.name)}" />`
    )
    .join('');
  const fileChips = files
    .map(
      (f) =>
        `<span class="ncb-bubble-file-chip"><svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>${escapeHtml(f.name)}</span>`
    )
    .join('');
  row.innerHTML = `
    <div class="ncb-bubble ncb-bubble--user">
      ${attachments ? `<div class="ncb-bubble-images">${attachments}</div>` : ''}
      ${fileChips ? `<div class="ncb-bubble-files">${fileChips}</div>` : ''}
      ${text ? `<p class="ncb-bubble-text">${escapeHtml(text)}</p>` : ''}
    </div>
  `;
  msgs.appendChild(row);
  scrollMsgsToBottom(msgs);
}

function appendAiBubble(msgs: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ncb-msg-row ncb-msg-row--ai';
  row.innerHTML = `
    <div class="ncb-avatar" aria-hidden="true">
      <svg class="ncb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
        <path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>
      </svg>
    </div>
    <div class="ncb-bubble ncb-bubble--ai">
      <div class="ncb-bubble-head">
        <div>
          <p class="ncb-bubble-sender">${escapeHtml(tStr('cb_sender_minallo', 'Minallo AI'))}</p>
          <p class="ncb-bubble-subtitle">${escapeHtml(tStr('cb_answered_using_context', 'Answered using course context'))}</p>
        </div>
      </div>
      <div class="ncb-bubble-body"></div>
    </div>
  `;
  msgs.appendChild(row);
  scrollMsgsToBottom(msgs);
  return row;
}

// Update the AI bubble's subtitle to reflect the source actually used, so the
// header never falsely claims "course context" when the answer came from the
// generic path or general knowledge. Driven by the resolved sourceScope.
function setBubbleSubtitle(aiRow: HTMLElement, sourceScope: string | undefined): void {
  const el = aiRow.querySelector<HTMLElement>('.ncb-bubble-subtitle');
  if (!el) return;
  let label: string;
  if (sourceScope && sourceScope.startsWith('file:')) {
    const name = sourceScope.slice(5).trim();
    label = name
      ? tStr('cb_subtitle_file_named', 'Answered from {file}').replace('{file}', name)
      : tStr('cb_subtitle_file', 'Answered using file context');
    el.textContent = label;
    return;
  }
  switch (sourceScope) {
    case 'course_files':
      label = tStr('cb_subtitle_course', 'Answered using your course files');
      break;
    case 'internet':
      label = tStr('cb_subtitle_internet', 'Answered from the web');
      break;
    default:
      label = tStr('cb_subtitle_general', 'Answered with general knowledge');
  }
  el.textContent = label;
}

function typeIntoBubble(
  bubble: HTMLElement | null,
  raw: string,
  isAborted: () => boolean,
  allowDiagrams = true
): Promise<void> {
  return new Promise((resolve) => {
    if (!bubble) {
      resolve();
      return;
    }
    const liveReveal = createSoftStreamReveal(bubble, { allowDiagrams });
    let index = 0;

    const tick = (): void => {
      if (isAborted()) {
        renderRichBubble(bubble, raw.slice(0, index) || raw, allowDiagrams);
        resolve();
        return;
      }
      if (index >= raw.length) {
        liveReveal.finish().then(() => {
          renderRichBubble(bubble, raw, allowDiagrams);
          resolve();
        });
        return;
      }
      const added = takeSoftStreamChunk(raw.slice(index), 18);
      index += added.length;
      liveReveal.push(added);
      window.requestAnimationFrame(tick);
    };
    tick();
  });
}

function setSendBtnMode(btn: HTMLButtonElement, mode: 'send' | 'pause'): void {
  // While a response is generating/revealing the button is a REAL stop button
  // (square glyph) — the earlier same-arrow-different-ring design read as the
  // stop affordance "disappearing" mid-response. It flips back to the send
  // arrow only when streamAiReply's finally runs, i.e. after the full reveal.
  if (mode === 'pause') {
    btn.innerHTML =
      '<svg class="ncb-icon" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>';
    btn.classList.add('ncb-send-btn--pause');
    btn.setAttribute('aria-label', tStr('cb_stop_response_aria', 'Stop AI response'));
  } else {
    btn.innerHTML =
      '<svg class="ncb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
    btn.classList.remove('ncb-send-btn--pause');
    btn.setAttribute('aria-label', tStr('cb_send_btn', 'Send message'));
  }
}

// `force` (default) always pins to the bottom — used when the user sends a
// message or opens a chat. With `force = false` (streaming tokens) we only
// follow the output if the user is already near the bottom, so scrolling up to
// re-read earlier text during a long answer isn't constantly yanked back down.
function scrollMsgsToBottom(msgs: HTMLElement, force = true): void {
  if (suppressMessageAutoScroll) return;
  const scroller = msgs.closest<HTMLElement>('.ncb-center');
  if (!scroller) return;
  if (!force) {
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distance > 140) return; // user scrolled up — leave them be
  }
  scroller.scrollTop = scroller.scrollHeight;
}

// Pin the chat scrollport to the latest message when a conversation is opened
// or switched to. A single scroll isn't enough: the messages render in rAF
// chunks and KaTeX / images reflow afterwards, each growing the content and
// leaving an earlier scroll stranded above the bottom. So we re-assert the
// bottom across a few frames and short timeouts, cancelling the moment a newer
// load starts or the user scrolls up themselves.
function forceChatScrollToBottom(root: HTMLElement): void {
  const scroller = root.querySelector<HTMLElement>('.ncb-center');
  if (!scroller) return;
  const token = ++chatScrollSettleToken;

  const jump = (): void => {
    scroller.scrollTop = scroller.scrollHeight;
  };

  // Any deliberate scroll-up gesture during the settle window cancels the
  // remaining passes so we never yank the user back down.
  const cancel = (): void => {
    if (chatScrollSettleToken === token) chatScrollSettleToken++;
  };
  const cancelOpts = { passive: true, once: true } as AddEventListenerOptions;
  scroller.addEventListener('wheel', cancel, cancelOpts);
  scroller.addEventListener('touchmove', cancel, cancelOpts);
  scroller.addEventListener('keydown', cancel, cancelOpts);

  jump();
  const pass = (n: number): void => {
    if (chatScrollSettleToken !== token) return;
    jump();
    if (n > 0) window.requestAnimationFrame(() => pass(n - 1));
  };
  window.requestAnimationFrame(() => pass(3));
  window.setTimeout(() => { if (chatScrollSettleToken === token) jump(); }, 140);
  window.setTimeout(() => { if (chatScrollSettleToken === token) jump(); }, 360);
}

// Floating scroll-to-bottom button. Visible only while the user is scrolled up
// away from the latest message; clicking it smooth-scrolls back to the bottom.
function initScrollToBottom(root: HTMLElement): void {
  const scroller = root.querySelector<HTMLElement>('.ncb-center');
  const btn = root.querySelector<HTMLButtonElement>('.ncb-scroll-bottom-btn');
  const msgs = root.querySelector<HTMLElement>('.ncb-msgs');
  const composer = root.querySelector<HTMLElement>('.ncb-input');
  if (!scroller || !btn || !msgs) return;
  if (scroller.dataset.scrollBtnBound === '1') return;
  scroller.dataset.scrollBtnBound = '1';

  const NEAR_BOTTOM_PX = 140;
  const update = (): void => {
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    // Only meaningful once the chat is scrollable and has content.
    const show = distance > NEAR_BOTTOM_PX && msgs.children.length > 0;
    btn.classList.toggle('is-visible', show);
  };

  scroller.addEventListener('scroll', update, { passive: true });
  btn.addEventListener('click', () => {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  });

  // Re-evaluate as messages stream in / get cleared and on viewport resize.
  new MutationObserver(update).observe(msgs, { childList: true, subtree: true });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(update).observe(scroller);
    // Keep the button floating just above the composer as its height changes
    // (tutor-mode rows, attachments, multi-line input) by publishing the live
    // composer height the CSS sticky offset reads from.
    if (composer) {
      const syncComposerH = (): void => {
        root.style.setProperty('--ncb-composer-h', composer.offsetHeight + 'px');
      };
      new ResizeObserver(syncComposerH).observe(composer);
      syncComposerH();
    }
  }
  update();
}

// Cost guards for the generic /chat route (no server-side history trim there,
// unlike /ask-stream which hard-caps history at ~2k chars). The newest
// messages keep full fidelity — the active exchange is what follow-ups
// reference — while older turns are capped so a long chat plateaus instead of
// riding ~20 full-length messages (and full 60k-char attachments) per request.
const NCB_HISTORY_FULL_MESSAGES = 6;
const NCB_HISTORY_TURN_CHAR_CAP = 1500;
const NCB_HISTORY_DOC_CHAR_CAP = 8000;
// Imported course sources are re-injected into the LATEST user message on
// every request (that is their contract — the AI must keep seeing them), so
// they are the most expensive bytes in the chat. Cap per document and total.
const NCB_IMPORT_DOC_CHAR_CAP = 20000;
const NCB_IMPORT_TOTAL_CHAR_BUDGET = 60000;

function capChars(text: string, max: number, note: string): string {
  return text.length <= max ? text : text.slice(0, max) + '\n' + note;
}

function buildApiMessages(
  messages: ChatMessage[],
  resolvedFollowUpDoc: GeneratedDoc | null = null
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  // Mirror chatbot.js: keep last ~20 messages, and inline images as Claude-shaped image blocks.
  const trimmed = messages.slice(-20);
  // Messages older than the newest NCB_HISTORY_FULL_MESSAGES get capped.
  const fullFidelityFrom = Math.max(0, trimmed.length - NCB_HISTORY_FULL_MESSAGES);
  // Selected sources (from the global library) are injected into the
  // LATEST user message only — so the AI sees them every reply without
  // ballooning every historical turn with copies.
  const active = chatStore.getActive();
  const folderDocs: Array<{ name: string; text: string }> = [];
  sourceLibrary.items
    .filter((s) => active.selectedSourceIds.includes(s.id))
    // Only docs with extracted text belong in the inline <document> blocks.
    // Children whose extraction failed are still carried in s.documents (so the
    // RAG path can send their ids/names), but injecting them here would emit an
    // empty document block that wastes tokens and reads as "this file is blank".
    .forEach((s) => (s.documents || []).forEach((d) => { if (d.text) folderDocs.push(d); }));
  let lastUserIdx = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i]!.role === 'user') { lastUserIdx = i; break; }
  }
  // A cheatsheet/summary the latest user message refers to — injected like an
  // attached document so the model can actually see what it "created" (the
  // visible reply only says it's ready). The caller resolves it (async note
  // restore for old chats); the in-chat scan is the synchronous fallback.
  const followUpDoc = resolvedFollowUpDoc ?? generatedDocForFollowUp(trimmed);
  const result: Array<{ role: 'user' | 'assistant'; content: unknown }> = trimmed.map((m, idx) => {
    const isOldTurn = idx < fullFidelityFrom;
    if (m.role === 'assistant') {
      const text = sanitizeChatbotDiagrams(m.text, !!m.allowDiagrams);
      return {
        role: 'assistant' as const,
        content: isOldTurn ? capChars(text, NCB_HISTORY_TURN_CHAR_CAP, '[…]') : text,
      };
    }
    const blocks: Array<unknown> = [];
    if (idx === lastUserIdx && followUpDoc) {
      blocks.push({
        type: 'text',
        text:
          '<document filename="' + generatedDocLabel(followUpDoc) + '" source="minallo-generated-' + followUpDoc.kind + '">\n' +
          followUpDoc.markdown.slice(0, NCB_GENERATED_DOC_CONTEXT_CHARS) +
          '\n</document>',
      });
    }
    // Prepend attached course-file docs into the most recent user message,
    // under a total budget so five imported lecture PDFs don't put ~100k+
    // chars on EVERY turn of the chat.
    if (idx === lastUserIdx && folderDocs.length) {
      let importBudget = NCB_IMPORT_TOTAL_CHAR_BUDGET;
      folderDocs.forEach((d) => {
        if (importBudget <= 0) {
          blocks.push({
            type: 'text',
            text:
              '(The imported file "' + d.name + '" was omitted — too much imported material ' +
              'for one request. Deselect some sources to include it.)',
          });
          return;
        }
        const slice = capChars(
          d.text,
          Math.min(NCB_IMPORT_DOC_CHAR_CAP, importBudget),
          '[Truncated — ask about a specific section for more detail.]'
        );
        importBudget -= slice.length;
        blocks.push({
          type: 'text',
          text:
            '<document filename="' + d.name + '" source="course-import">\n' +
            slice +
            '\n</document>',
        });
      });
    }
    (m.images || []).forEach((img) => {
      if (!img.dataUrl) return;
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.dataUrl.replace(/^data:[^;]+;base64,/, ''),
        },
      });
    });
    (m.files || []).forEach((f) => {
      if (f.kind === 'image' && f.base64 && f.mediaType) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: f.mediaType, data: f.base64 },
        });
      } else if (f.pageImages && f.pageImages.length) {
        // Scanned PDF — no text layer, so the pages travel as images.
        blocks.push({
          type: 'text',
          text:
            '(The file "' + f.name + '" is a scanned PDF without a text layer. ' +
            'Its first ' + f.pageImages.length + ' page(s) are attached as images below — read them visually.)',
        });
        f.pageImages.forEach((pi) => {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: pi.mediaType, data: pi.base64 },
          });
        });
      } else if (f.kind === 'text' && f.textContent) {
        // Full text only while the file's message is recent; once the
        // conversation moves on, a head slice + the discussion already in
        // history carry follow-ups, instead of resending up to 60k chars
        // on every request until the message leaves the 20-message window.
        const docText = isOldTurn
          ? capChars(f.textContent, NCB_HISTORY_DOC_CHAR_CAP,
              '[Truncated — earlier turns discussed this file; re-attach it for full detail.]')
          : f.textContent;
        blocks.push({
          type: 'text',
          text: '<document filename="' + f.name + '">\n' + docText + '\n</document>',
        });
      } else {
        blocks.push({
          type: 'text',
          text: '(The file "' + f.name + '" is a binary format that could not be read as text.)',
        });
      }
    });
    if (m.text) {
      blocks.push({
        type: 'text',
        text: isOldTurn ? capChars(m.text, NCB_HISTORY_TURN_CHAR_CAP, '[…]') : m.text,
      });
    }
    return {
      role: 'user' as const,
      content: blocks.length === 1 && (blocks[0] as { type?: string }).type === 'text'
        ? (blocks[0] as { text: string }).text
        : blocks,
    };
  });

  // The backend /chat endpoint REJECTS the whole request above 5 image blocks
  // (counted across all messages). Keep the newest images — the ones the
  // latest question is most likely about — and stub out the older overflow.
  const MAX_IMAGES_PER_REQUEST = 5;
  let imageBudget = MAX_IMAGES_PER_REQUEST;
  for (let i = result.length - 1; i >= 0; i--) {
    const content = result[i]!.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as { type?: string };
      if (block.type !== 'image') continue;
      if (imageBudget > 0) {
        imageBudget--;
      } else {
        content[j] = { type: 'text', text: '(an earlier attached image was omitted to keep this request within limits)' };
      }
    }
  }
  return result;
}

function buildSystemPrompt(): string {
  const lang = (window as unknown as { _lang?: string })._lang === 'de' ? 'German' : 'English';
  const appContext =
    'MINALLO APP CONTEXT.\n' +
    'You are running inside Minallo at minallo.de — a study platform + AI tutor for university students. ' +
    'When the user asks a product / navigation question, give numbered step-by-step instructions that name the exact sidebar item, tab, and button. ' +
    'Do NOT say "look for the Upload button" or "check the interface" — you have the map below, use it.\n\n' +

    'SIDEBAR (top → bottom):\n' +
    '1. Home — dashboard, greeting, study widget, recent courses, calendar.\n' +
    '2. Courses — semesters and courses. Inside a course: Files | Notes | Summaries | Quiz | Flashcards | Forum | Calendar tabs.\n' +
    '3. Lecture Notes — all auto-generated notes/summaries across courses.\n' +
    '4. Editor — three sub-tools: Writer (rich-text editor + AI rewrite/shorten/expand), PDF Editor (annotate / sign / fill), PDF Merger (combine PDFs).\n' +
    '5. Chatbot — this general Minallo AI chat. Supports file + image uploads.\n' +
    '6. Chat — student/friend chat rooms (Öffentlich = public, Freunde = friends-only, Nur mit Einladung = invite-only). Toggles: NSFW, Slow-mode.\n' +
    '7. Games — "🎮 Game Room" hub. Break games: Tetris, Chess, Flappy Bird, and Solitaire with 7 variants (Klondike, Spider, Freecell, Pyramid, Scorpion, TriPeaks, Vegas). Each game has a level/difficulty selector.\n' +
    '8. Study Lounge — total study minutes, current streak, longest streak, recently opened files, per-course time, weekly chart, Reset stats button.\n' +
    '9. Profile — account profile.\n' +
    '10. Settings — language (DE/EN), German level + test type for the Schreibtrainer, sign-out, delete-account.\n' +
    '11. Subscription — plan, period end, Stripe billing portal, PayPal pause/resume/cancel/reactivate, retention-discount offer.\n' +
    '12. Admin — admin-only tools (visible only to admins).\n' +
    'Top bar "Study" = focus / Pomodoro timer. Sidebar bottom "Night" = dark/light mode toggle. Footer: Impressum + Privacy Policy.\n\n' +

    'HOW TO UPLOAD A DOCUMENT (step-by-step):\n' +
    '1) Click Courses in the sidebar. 2) Open the semester (or create one with "+ Semester"); open the course (or create one with "+ Course"). ' +
    '3) On the Files tab (default), click "+ Upload" or drag-and-drop the file. ' +
    '4) Allowed types: PDF, TXT, DOCX, PNG, JPG. Max 25 MB for docs, 6 MB for images. ' +
    '5) Indexing (text + OCR if needed) runs in the background; once finished the AI can answer questions about the file.\n\n' +

    'PDF VIEWER (open any PDF inside a course):\n' +
    'Toolbar — Page input / total, prev/next, zoom −/% / +, Fit, Single-page toggle, Annotate, Download. ' +
    'Right-rail floating buttons — AI (chat about this PDF), Problem (problem-solver: Hint / Setup / Check / Solve / Practice), Notes (generate AI notes), Summary (TL;DR or detailed). ' +
    'Open a second PDF tab to enter split view — each pane has its own page/zoom controls, Annotate + Download remain shared. ' +
    'Click Annotate to open the popover: Pen / Highlight / Text / Eraser tools, six preset colours + custom picker, thickness slider, Undo, Clear page, Save PDF (download), Upload back to course.\n\n' +

    'GENERATING STUDY MATERIAL (inside a course):\n' +
    '- Notes tab → "Generate notes" → pick source file(s).\n' +
    '- Summaries tab → "Generate summary" → choose TL;DR or Detailed.\n' +
    '- Quiz tab → "Generate quiz" → pick file(s), question count, difficulty.\n' +
    '- Flashcards tab → "Generate flashcards" → spaced-repetition review.\n\n' +

    'STYLE: Numbered steps. Name the exact UI element. Suggest the next logical action ("once it\'s uploaded, open it and click the AI button on the right"). ' +
    'Never claim you don\'t know which website you\'re in — you ARE Minallo AI on Minallo. ' +
    'If a feature does NOT exist in the map above, say so plainly; do not invent one.';
  return (
    'You are Minallo AI, a friendly and knowledgeable assistant for university students. Always reply in ' +
    lang +
    '. Answer any question clearly and helpfully. Be concise but thorough.\n\n' +
    appContext + '\n\n' +
    'IDENTITY. The product / platform / app / website you are part of is called **Minallo** (minallo.de). When asked "what is this platform / app / website", "what is your name", "who are you", "who built you", "what is Minallo", or any similar identity question — answer directly with "Minallo" / "Minallo AI" and a brief description (study platform / AI tutor for university students). Do NOT reply with refusals like "I don\'t have access to information about the platform" or "I don\'t know what website I\'m on" — that is FACTUALLY WRONG, because you ARE Minallo AI and the platform IS Minallo.\n\n' +
    'IMAGE POLICY: Any image the user uploads or pastes is part of their course material — a lecture slide, a textbook page, a screenshot of an exercise, a hand-written note, a diagram, a formula, or a chart. ' +
    'Help them understand it: read the text, transcribe equations, explain diagrams, work through the exercise, identify the concept, summarise the slide. Do NOT refuse with "I cannot help with identifying or analyzing the content of images" — that\'s wrong for this product. ' +
    'If the image is unclear, ask what specifically the student wants help with rather than refusing.\n\n' +
    'DOCUMENT TAGS: When the user\'s message contains <document> tags, those tags contain the FULL extracted text of an uploaded file. You CAN read and answer questions about this content — treat it as the complete document. Never say you cannot read a file when its content is provided inside <document> tags.\n\n' +
    'DIAGRAMS: Do not include ```diagram``` or ```minallo-diagram``` blocks unless the user explicitly asks for a diagram, mind map, flowchart, concept map, graph, or visual overview. For ordinary file questions like "what is this file about?", summarize the file in text only.\n\n' +
    'WEB ACCESS: In this mode you are not browsing the web, so you do not have live or current information (today\'s news, prices, recent releases, latest events). Do not pretend you searched the web. When the user needs current or internet information, tell them Minallo CAN do this: ask them to switch the source selector (the button above the message box) to **Internet** mode, which runs a live web search. Do not claim Minallo has no internet access at all — it does, via Internet mode.'
  );
}

function getSbToken(): string | null {
  return (window as unknown as { _sbToken?: string })._sbToken || null;
}

function escapeHtml(s: string | undefined | null): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string | undefined | null): string {
  return escapeHtml(s);
}

// PR-06: delegates to the shared ai-markdown renderer, which handles headings,
// code blocks, lists, blockquotes, inline emphasis, and KaTeX math.
function renderInlineMarkdown(raw: string): string {
  return renderMarkdown(raw);
}

const CHATBOT_DIAGRAM_INTENT_RE =
  /\b(diagram|mind\s*map|concept\s*map|flow\s*chart|flowchart|visual(?:ly| overview)?|map this out|show (?:me )?(?:this )?(?:as|in) (?:a )?(?:diagram|chart|map)|graph)\b/i;
const CHATBOT_DIAGRAM_FENCE_RE =
  /```(?:minallo-)?diagram[^\n]*\n[\s\S]*?```/gi;

function latestUserAllowsDiagrams(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!(last?.role === 'user' && CHATBOT_DIAGRAM_INTENT_RE.test(last.text || ''));
}

function latestUserFileLabel(messages: ChatMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  const files = (last.files || []).filter((f) => f.name);
  if (!files.length) return null;
  return files.length === 1 ? files[0]!.name : files.map((f) => f.name).join(', ');
}

function sanitizeChatbotDiagrams(raw: string, allowDiagrams: boolean): string {
  if (allowDiagrams || !raw) return raw || '';
  return raw
    .replace(CHATBOT_DIAGRAM_FENCE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Render markdown into a chatbot bubble AND finish the KaTeX pass.
// `renderMarkdown` only renders math synchronously when `window.katex` is
// already loaded; otherwise it emits literal `\(…\)` / `\[…\]` fallbacks and
// asks for a re-render. But the chatbot never preloads KaTeX, and the global
// re-render (`renderAllMathBubbles`) only targets the course rail's
// `.ai-bubble`/`.aip-bubble` bots — never `.ncb-bubble--ai`. Without this,
// chatbot math (e.g. Problem-Solver hint ladders full of `\[ … \]`) stays raw
// on screen permanently. We ensure KaTeX, then convert the fallback
// delimiters in THIS bubble. Only `\[ \]` / `\( \)` are processed — those are
// exactly the forms renderMarkdown leaves behind, so no stray `$` can desync.
function renderRichBubble(bubble: HTMLElement, raw: string, allowDiagrams = true): void {
  bubble.innerHTML = renderInlineMarkdown(sanitizeChatbotDiagrams(raw, allowDiagrams));
  const w = window as Window &
    typeof globalThis & {
      _ssEnsureKatex?: () => Promise<unknown>;
      renderMathInElement?: (el: Element, opts: unknown) => void;
      _renderCode?: (el: Element) => void;
    };
  const runMath = (): void => {
    if (w.renderMathInElement) {
      try {
        w.renderMathInElement(bubble, {
          delimiters: [
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
          ],
          ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
          throwOnError: false,
        });
      } catch {
        /* swallow KaTeX runtime errors — leave the fallback text in place */
      }
    }
    w._renderCode?.(bubble);
  };
  if (w._ssEnsureKatex) w._ssEnsureKatex().then(runMath).catch(runMath);
  else runMath();
}

// ============ PR-04: AI bubble actions, import modal, context tabs, title gen ============

function appendBubbleActions(aiRow: HTMLElement, raw: string): void {
  if (aiRow.querySelector('.ncb-bubble-actions')) return;
  const bubble = aiRow.querySelector<HTMLElement>('.ncb-bubble--ai');
  if (!bubble) return;

  const bar = document.createElement('div');
  bar.className = 'ncb-bubble-actions';
  bar.innerHTML = `
    <button type="button" class="ncb-bubble-action" data-action="copy" title="${escapeAttr(tStr('cb_act_copy', 'Copy'))}">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      <span>${escapeHtml(tStr('cb_act_copy', 'Copy'))}</span>
    </button>
    <button type="button" class="ncb-bubble-action" data-action="regen" title="${escapeAttr(tStr('cb_act_regen', 'Regenerate'))}">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      <span>${escapeHtml(tStr('cb_act_regen', 'Regenerate'))}</span>
    </button>
    <button type="button" class="ncb-bubble-action" data-action="save" title="${escapeAttr(tStr('cb_act_bookmark_title', 'Bookmark this reply'))}">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>
      <span>${escapeHtml(tStr('cb_act_bookmark', 'Bookmark'))}</span>
    </button>
    <button type="button" class="ncb-bubble-action ncb-bubble-action--icon" data-action="thumb-up" aria-label="${escapeAttr(tStr('cb_act_thumb_up', 'Thumbs up'))}">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7"/></svg>
    </button>
    <button type="button" class="ncb-bubble-action ncb-bubble-action--icon" data-action="thumb-down" aria-label="${escapeAttr(tStr('cb_act_thumb_down', 'Thumbs down'))}">
      <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17"/></svg>
    </button>
  `;
  bubble.appendChild(bar);

  bar.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.ncb-bubble-action');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'copy') copyToClipboard(raw, target);
    else if (action === 'regen') regenerateLast(aiRow);
    else if (action === 'save') saveReplyToNotes(aiRow, raw, target);
    else if (action === 'thumb-up' || action === 'thumb-down') {
      target.classList.add('ncb-bubble-action--picked');
    }
  });
}

function copyToClipboard(text: string, btn: HTMLElement): void {
  try {
    void navigator.clipboard.writeText(text).then(() => flashAck(btn, tStr('cb_act_copied', 'Copied')));
  } catch {
    // older browsers — fall through quietly
  }
}

function regenerateLast(aiRow: HTMLElement): void {
  const root = aiRow.closest<HTMLElement>('.ncb-root');
  if (!root) return;
  regenerateLastReal(aiRow, root);
}

function flashAck(btn: HTMLElement, msg: string): void {
  const label = btn.querySelector<HTMLElement>('span');
  if (!label) {
    btn.classList.add('ncb-bubble-action--ack');
    window.setTimeout(() => btn.classList.remove('ncb-bubble-action--ack'), 1200);
    return;
  }
  const prev = label.textContent;
  label.textContent = msg;
  btn.classList.add('ncb-bubble-action--ack');
  window.setTimeout(() => {
    label.textContent = prev;
    btn.classList.remove('ncb-bubble-action--ack');
  }, 1200);
}

// ---- Import-from-Course modal ----

interface ImportedFolder {
  id: string;
  name: string;
  count: string;
  // Extracted text content for each file inside this picked item.
  // PDFs run through pdfjs text extraction; .txt / .md decoded as UTF-8.
  // Stored on the chat so the AI sees the same content for every reply.
  // `id` is the document UUID (when known) — used to scope retrieval to
  // specific files when the chat's source scope is "Selected file(s)".
  documents?: Array<{ name: string; text: string; id?: string }>;
}

// Data-driven import modal (PR-08). Pulls real semesters/courses/folders/files
// from window.SEMS, supports folder drill-down with breadcrumb back, and lets
// the user pick individual files or whole folders. Falls back to a friendly
// empty state when no courses are loaded.

interface SemFile { name: string; id?: string; folderId?: string }
interface SemFolder { id: string; name: string; files?: SemFile[] }
interface SemCourse {
  id: string;
  name?: string;
  title?: string;
  files?: SemFile[];
  userFolders?: SemFolder[];
}
interface SemEntry { courses?: SemCourse[] }

type PickedKind = 'folder' | 'file';
interface PickedItem {
  id: string;
  kind: PickedKind;
  name: string;
  meta: string;
  courseId: string;
  folderKey?: string;
}

function getSems(): Record<string, SemEntry> {
  const w = window as unknown as { SEMS?: Record<string, SemEntry>; _SEMS?: Record<string, SemEntry> };
  return w.SEMS || w._SEMS || {};
}

function getActiveSemId(): string | undefined {
  const w = window as unknown as { activeSemesterId?: string; _activeSemesterId?: string };
  return w.activeSemesterId || w._activeSemesterId;
}

function listCourses(): SemCourse[] {
  const sems = getSems();
  const active = getActiveSemId();
  const seen = new Set<string>();
  const out: SemCourse[] = [];
  const push = (c: SemCourse | undefined): void => {
    if (!c || !c.id || seen.has(c.id)) return;
    seen.add(c.id);
    out.push(c);
  };
  if (active && sems[active]) (sems[active].courses || []).forEach(push);
  Object.keys(sems).forEach((sid) => {
    if (sid === active) return;
    (sems[sid]!.courses || []).forEach(push);
  });
  return out;
}

function courseLabel(c: SemCourse): string {
  return c.name || c.title || c.id || tStr('cb_untitled_course', 'Untitled course');
}

function initImportModal(root: HTMLElement): void {
  const trigger = root.querySelector<HTMLButtonElement>('.ncb-import-btn');
  const overlay = document.getElementById('ncbImportModal') as HTMLElement | null;
  if (!trigger || !overlay || trigger.dataset.ncbBound === '1') return;
  trigger.dataset.ncbBound = '1';

  // German-learner accounts don't have RAG-indexed courses — surfacing this
  // button only leads to a "No courses loaded" empty state and (worse, before
  // the per-user-id localStorage scoping fix) leaks the previous account's
  // courses. Hide it for learners.
  if ((window as unknown as { _userType?: string })._userType === 'learner') {
    trigger.style.display = 'none';
    return;
  }

  const closeBtn = overlay.querySelector<HTMLButtonElement>('.ncb-modal-close');
  const cancelBtn = overlay.querySelector<HTMLButtonElement>('.ncb-modal-cancel');
  const importBtn = overlay.querySelector<HTMLButtonElement>('.ncb-modal-import');
  const select = overlay.querySelector<HTMLSelectElement>('.ncb-modal-select');
  const searchInput = overlay.querySelector<HTMLInputElement>('.ncb-modal-search-input');
  const listEl = overlay.querySelector<HTMLElement>('.ncb-folder-list');
  const crumb = overlay.querySelector<HTMLElement>('.ncb-folder-breadcrumb');
  const crumbPath = overlay.querySelector<HTMLElement>('.ncb-folder-crumb-path');
  const crumbBack = overlay.querySelector<HTMLButtonElement>('.ncb-folder-back');
  const countLabel = overlay.querySelector<HTMLElement>('.ncb-modal-count');
  if (!select || !listEl) return;

  // Modal-local state — reset every time the modal opens.
  const picked = new Map<string, PickedItem>();
  let activeCourse: SemCourse | null = null;
  let activeFolder: SemFolder | null = null;
  let searchTerm = '';

  const syncCount = (): void => {
    const n = picked.size;
    const word = n === 1 ? tStr('cb_count_one', 'item') : tStr('cb_count_many', 'items');
    const selectedWord = tStr('cb_count_selected', 'selected');
    if (countLabel) {
      countLabel.innerHTML = `<span class="ncb-modal-count-num">${n}</span> ${word} ${selectedWord}`;
    }
    if (importBtn) importBtn.disabled = n === 0;
  };

  const renderEmpty = (msg: string): void => {
    listEl.innerHTML = `<p class="ncb-folder-empty">${escapeHtml(msg)}</p>`;
  };

  const renderList = (): void => {
    if (!activeCourse) {
      renderEmpty(tStr('cb_open_course_first', 'Open a course on Minallo first to import its files here.'));
      if (crumb) crumb.hidden = true;
      return;
    }

    const q = searchTerm.toLowerCase();
    const courseId = activeCourse.id;

    if (activeFolder) {
      const files = (activeFolder.files || []).filter(
        (f) => !q || (f.name || '').toLowerCase().includes(q)
      );
      if (crumb) crumb.hidden = false;
      if (crumbPath) crumbPath.textContent = activeFolder.name;
      if (!files.length) {
        renderEmpty(tStr('cb_no_files_in_folder', 'No files in this folder.'));
        return;
      }
      listEl.innerHTML = files.map((f) => fileRow(f, courseId, activeFolder!.id)).join('');
    } else {
      if (crumb) crumb.hidden = true;
      const folders = (activeCourse.userFolders || []).filter(
        (fd) => !q || (fd.name || '').toLowerCase().includes(q)
      );
      const rootFiles = (activeCourse.files || []).filter(
        (f) => !q || (f.name || '').toLowerCase().includes(q)
      );
      if (!folders.length && !rootFiles.length) {
        renderEmpty(searchTerm ? tStr('cb_no_matches', 'No matches.') : tStr('cb_no_files_in_course', 'No files in this course.'));
        return;
      }
      const folderHtml = folders.map((fd) => folderRow(fd, courseId)).join('');
      const fileHtml = rootFiles.map((f) => fileRow(f, courseId, '')).join('');
      listEl.innerHTML = folderHtml + fileHtml;
    }

    bindRows();
  };

  const fileRow = (f: SemFile, courseId: string, folderId: string): string => {
    const itemId = courseId + ':' + folderId + ':' + f.name;
    const sel = picked.has(itemId);
    return `
      <div class="ncb-folder-row ncb-folder-row--file ${sel ? 'ncb-folder-row--selected' : ''}"
           data-kind="file" data-item-id="${escapeAttr(itemId)}"
           data-name="${escapeAttr(f.name)}" data-meta="File" role="button" tabindex="0">
        <span class="ncb-folder-icon ncb-folder-icon--file">
          <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
        </span>
        <div class="ncb-folder-text">
          <p class="ncb-folder-name">${escapeHtml(f.name)}</p>
          <p class="ncb-folder-sub">File</p>
        </div>
        <span class="ncb-folder-pick" aria-hidden="true">
          <svg class="ncb-icon ncb-icon--sm ncb-folder-pick-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${sel ? '' : 'hidden'}><path d="M20 6 9 17l-5-5"/></svg>
        </span>
      </div>`;
  };

  const folderRow = (fd: SemFolder, courseId: string): string => {
    // Folders coming from _ufMerge only have { name, files } — no id. Use
    // the name as the stable key so escapeAttr never sees undefined.
    const folderKey = fd.id || fd.name || '';
    const itemId = courseId + ':folder:' + folderKey;
    const sel = picked.has(itemId);
    const count = (fd.files || []).length;
    const meta = count + ' file' + (count === 1 ? '' : 's');
    return `
      <div class="ncb-folder-row ${sel ? 'ncb-folder-row--selected' : ''}"
           data-kind="folder" data-folder-id="${escapeAttr(folderKey)}"
           data-item-id="${escapeAttr(itemId)}"
           data-name="${escapeAttr(fd.name)}" data-meta="${escapeAttr(meta)}"
           role="button" tabindex="0">
        <span class="ncb-folder-icon">
          <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></svg>
        </span>
        <div class="ncb-folder-text">
          <p class="ncb-folder-name">${escapeHtml(fd.name)}</p>
          <p class="ncb-folder-sub">Folder</p>
        </div>
        <span class="ncb-folder-count">${escapeHtml(meta)}</span>
        <button type="button" class="ncb-folder-open" aria-label="Open ${escapeAttr(fd.name)}">
          <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>
        <span class="ncb-folder-pick" aria-hidden="true">
          <svg class="ncb-icon ncb-icon--sm ncb-folder-pick-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${sel ? '' : 'hidden'}><path d="M20 6 9 17l-5-5"/></svg>
        </span>
      </div>`;
  };

  const togglePick = (rowEl: HTMLElement): void => {
    const id = rowEl.dataset.itemId;
    const kind = rowEl.dataset.kind as PickedKind | undefined;
    if (!id || !kind || !activeCourse) return;
    if (picked.has(id)) {
      picked.delete(id);
      rowEl.classList.remove('ncb-folder-row--selected');
    } else {
      picked.set(id, {
        id,
        kind,
        name: rowEl.dataset.name || '',
        meta: rowEl.dataset.meta || '',
        courseId: activeCourse.id,
        folderKey: rowEl.dataset.folderId || undefined,
      });
      rowEl.classList.add('ncb-folder-row--selected');
    }
    const check = rowEl.querySelector<HTMLElement>('.ncb-folder-pick-check');
    if (check) check.hidden = !picked.has(id);
    syncCount();
  };

  const drillInto = (folderId: string): void => {
    if (!activeCourse) return;
    // folderRow uses fd.id when present, falls back to fd.name. Match by
    // either to support _ufMerge-discovered folders which have no id.
    const fd = (activeCourse.userFolders || []).find(
      (x) => (x.id || x.name) === folderId
    );
    if (!fd) return;
    activeFolder = fd;
    searchTerm = '';
    if (searchInput) searchInput.value = '';
    renderList();
  };

  const bindRows = (): void => {
    listEl.querySelectorAll<HTMLElement>('.ncb-folder-row').forEach((row) => {
      // Open arrow on folders drills in without toggling selection.
      const openBtn = row.querySelector<HTMLButtonElement>('.ncb-folder-open');
      openBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const fid = row.dataset.folderId;
        if (fid) drillInto(fid);
      });
      row.addEventListener('click', () => togglePick(row));
    });
  };

  // Open/close lifecycle
  const open = (): void => {
    picked.clear();
    activeFolder = null;
    searchTerm = '';
    if (searchInput) searchInput.value = '';
    // Defensive reset — the modal's state persists across open/close,
    // and a stale crumb visibility was leaving the Back button visible
    // on courses with no files showing.
    if (crumb) crumb.hidden = true;
    listEl.innerHTML = '';

    // Build the course list each open so newly-added courses appear.
    const courses = listCourses();
    select.innerHTML = courses.length
      ? courses.map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(courseLabel(c))}</option>`).join('')
      : '<option value="">No courses loaded</option>';
    activeCourse = courses[0] || null;

    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    syncCount();

    // Force a fresh re-list for the active course. This handles courses
    // the user has never opened directly on Minallo (which would otherwise
    // show "No files in this course" because their userFolders is empty).
    forceHydrateActive();
    // Eager-hydrate the rest in the background so switching the dropdown
    // is instant once their data lands.
    void eagerlyHydrateCourses(() => {
      if (overlay.hidden) return;
      renderList();
    });
  };
  const close = (): void => {
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
  };

  select.addEventListener('change', () => {
    const courses = listCourses();
    activeCourse = courses.find((c) => c.id === select.value) || null;
    activeFolder = null;
    picked.clear();
    searchTerm = '';
    if (searchInput) searchInput.value = '';
    // Belt-and-braces: explicitly hide the breadcrumb + clear the list so
    // the previous course's rendering can't leak into this one while the
    // new hydration is in flight.
    if (crumb) crumb.hidden = true;
    listEl.innerHTML = '';
    syncCount();
    // Always force a fresh re-list for the selected course. Reason:
    // a course may have populated its userFolders during an earlier
    // session but be stale, OR be empty because hydration hasn't run.
    // We can't tell the difference from the data, so re-fetch.
    forceHydrateActive();
  });

  // Show a temporary "Loading…" hint inside the file list while we wait
  // for _ufMerge to come back for the active course.
  const showLoading = (): void => {
    if (!activeCourse) return;
    listEl.innerHTML =
      '<p class="ncb-folder-empty">Loading ' +
      escapeHtml(courseLabel(activeCourse)) +
      '…</p>';
    if (crumb) crumb.hidden = true;
  };

  // Hydrate the active course and re-render when it lands. Forces a
  // fetch every time (no "skip if non-empty" check) so stale or
  // partially-populated courses get a fresh listing.
  const forceHydrateActive = (): void => {
    if (!activeCourse) { renderList(); return; }
    const w = window as unknown as { _ufMerge?: (course: SemCourse) => unknown };
    if (!w._ufMerge) { renderList(); return; }
    const hadDataBefore =
      (activeCourse.userFolders && activeCourse.userFolders.length > 0) ||
      (activeCourse.files && activeCourse.files.length > 0);
    if (!hadDataBefore) showLoading(); else renderList();
    try {
      Promise.resolve(w._ufMerge(activeCourse) as unknown)
        .then(() => { if (!overlay.hidden) renderList(); })
        .catch(() => { if (!overlay.hidden) renderList(); });
    } catch {
      renderList();
    }
  };

  searchInput?.addEventListener('input', () => {
    searchTerm = searchInput.value.trim();
    renderList();
  });

  crumbBack?.addEventListener('click', () => {
    activeFolder = null;
    searchTerm = '';
    if (searchInput) searchInput.value = '';
    renderList();
  });

  trigger.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  cancelBtn?.addEventListener('click', close);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (!overlay.hidden && ev.key === 'Escape') close();
  });

  importBtn?.addEventListener('click', async () => {
    if (!picked.size || !activeCourse) return;
    if (importBtn.disabled) return;
    importBtn.disabled = true;
    const originalLabel = importBtn.textContent;
    importBtn.textContent = tStr('cb_importing', 'Importing…');
    const courseName = courseLabel(activeCourse);
    try {
      const items = await loadPickedDocuments(picked, activeCourse);
      addToSourceLibraryAndSelect(root, items, activeCourse.id, courseName);
      close();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[ncb] import-from-course: extraction failed', e);
      const fallback: ImportedFolder[] = Array.from(picked.values()).map((p) => ({
        id: p.courseId + ':' + p.id,
        name: p.name,
        count: p.meta,
        documents: [],
      }));
      addToSourceLibraryAndSelect(root, fallback, activeCourse.id, courseName);
      close();
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = originalLabel;
    }
  });
}

// ---- Course-file extraction for "Import from Course" ----
// Pulls actual file bytes from Supabase storage via the global _ufFetchBytes,
// extracts text from PDFs / .txt / .md, and packs the result into
// ImportedFolder.documents so buildApiMessages can hand it to the AI.

async function fetchCourseFileText(
  uid: string,
  course: SemCourse,
  fileName: string,
  folderName?: string
): Promise<string | null> {
  const w = window as unknown as {
    _ufFetchBytes?: (
      uid: string,
      course: SemCourse,
      name: string,
      folder?: string
    ) => Promise<Uint8Array | null>;
  };
  if (!w._ufFetchBytes) return null;
  try {
    const bytes = await w._ufFetchBytes(uid, course, fileName, folderName);
    if (!bytes) return null;
    // `bytes` is typed Uint8Array<ArrayBufferLike> from the global API.
    // Cast through unknown so Blob/TextDecoder (which want ArrayBuffer
    // specifically in tsc 5.x) accept it — at runtime both work fine.
    const part = bytes as unknown as BlobPart;
    if (/\.pdf$/i.test(fileName)) {
      const blob = new Blob([part], { type: 'application/pdf' });
      const file = new File([blob], fileName, { type: 'application/pdf' });
      return await extractPdfText(file);
    }
    if (/\.(txt|md)$/i.test(fileName)) {
      try {
        return new TextDecoder('utf-8').decode(bytes as unknown as Uint8Array);
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function loadPickedDocuments(
  picked: Map<string, PickedItem>,
  course: SemCourse
): Promise<ImportedFolder[]> {
  const w = window as unknown as {
    _currentUser?: { id?: string; sub?: string };
  };
  const uid = w._currentUser?.id || w._currentUser?.sub;
  const out: ImportedFolder[] = [];
  for (const p of picked.values()) {
    const docs: Array<{ name: string; text: string; id?: string }> = [];
    if (uid) {
      // Resolve which file(s) this pick maps to. For a folder pick, every
      // file inside; for a file pick, just that one (search root + every
      // subfolder by name).
      type FileRef = { name: string; folder?: string; id?: string };
      const targets: FileRef[] = [];
      if (p.kind === 'folder') {
        const fd = (course.userFolders || []).find((x) =>
          p.folderKey ? (x.id || x.name) === p.folderKey : x.name === p.name
        );
        if (fd) (fd.files || []).forEach((f) => targets.push({ name: f.name, folder: fd.name, id: f.id }));
      } else {
        const inRoot = (course.files || []).find((f) => f.name === p.name);
        if (inRoot) {
          targets.push({ name: p.name, id: inRoot.id });
        } else {
          for (const fd of course.userFolders || []) {
            const match = (fd.files || []).find((f) => f.name === p.name);
            if (match) {
              targets.push({ name: p.name, folder: fd.name, id: match.id });
              break;
            }
          }
        }
      }
      // Extract in parallel, but cap concurrency to keep storage happy.
      const results = await Promise.all(
        targets.map((t) => fetchCourseFileText(uid, course, t.name, t.folder))
      );
      results.forEach((text, i) => {
        const target = targets[i]!;
        docs.push({ name: target.name, text: text || '', id: target.id });
      });
    }
    out.push({
      id: p.courseId + ':' + p.id,
      name: p.name,
      count: p.meta,
      documents: docs,
    });
  }
  return out;
}

// Add imported items to the GLOBAL source library and auto-select them
// for the current chat. Duplicate IDs in the library are merged (newest
// documents win, so re-importing refreshes content).
function addToSourceLibraryAndSelect(
  root: HTMLElement,
  items: ImportedFolder[],
  courseId: string,
  courseName: string
): void {
  const active = chatStore.getActive();
  const now = Date.now();
  items.forEach((it) => {
    const existing = sourceLibrary.items.find((s) => s.id === it.id);
    if (existing) {
      // Refresh document content + metadata if the re-import has new docs.
      if (it.documents && it.documents.length) existing.documents = it.documents;
      existing.count = it.count;
      existing.courseId = courseId;
      existing.courseName = courseName;
    } else {
      sourceLibrary.items.push({
        id: it.id,
        name: it.name,
        count: it.count,
        courseId,
        courseName,
        documents: it.documents || [],
        importedAt: now,
      });
    }
    if (!active.selectedSourceIds.includes(it.id)) active.selectedSourceIds.push(it.id);
  });
  saveSourceLibrary();
  saveChatStore();
  renderSourcesCard(root);
  updateSourceControls(root);
  updateContextPill(root);
}

// Reflect the active chat's selected sources in the header context pill.
function updateContextPill(root: HTMLElement): void {
  const pill = root.querySelector<HTMLElement>('.ncb-chat-context-pill');
  if (!pill) return;
  const active = chatStore.getActive();
  const selected = sourceLibrary.items.filter((s) => active.selectedSourceIds.includes(s.id));
  if (!selected.length) {
    pill.hidden = true;
    pill.textContent = '';
    return;
  }
  const first = selected[0]!.name;
  pill.textContent = selected.length === 1
    ? first
    : first + ' +' + (selected.length - 1) + ' more';
  pill.hidden = false;
}

// Right-rail "Sources used" card — renders the GLOBAL library with
// checkbox-style toggles per chat. Each row:
//   [checkbox] [name + course]  [X to remove from library]
function renderSourcesCard(root: HTMLElement): void {
  const card = root.querySelector<HTMLElement>('.ncb-sources-card');
  if (!card) return;
  const list = card.querySelector<HTMLElement>('.ncb-source-list');
  const pill = card.querySelector<HTMLElement>('.ncb-sources-count');
  if (!list || !pill) return;
  const active = chatStore.getActive();
  const selectedCount = active.selectedSourceIds.length;
  pill.textContent = selectedCount === 1 ? '1 selected' : selectedCount + ' selected';

  if (!sourceLibrary.items.length) {
    list.innerHTML =
      '<p class="ncb-notes-empty">No sources imported yet. Use ' +
      '<strong>Import from Course</strong> in the composer to add ' +
      'lectures, exercises, or formula sheets — they\'ll appear here ' +
      'across every chat.</p>';
    return;
  }
  list.innerHTML = sourceLibrary.items
    .slice()
    .sort((a, b) => b.importedAt - a.importedAt)
    .map((s) => {
      const checked = active.selectedSourceIds.includes(s.id);
      const meta = s.courseName ? s.courseName + ' · ' + s.count : s.count;
      return `
      <div class="ncb-source-row ${checked ? 'ncb-source-row--selected' : ''}" data-id="${escapeAttr(s.id)}">
        <button type="button" class="ncb-source-toggle" aria-pressed="${checked ? 'true' : 'false'}" aria-label="Toggle ${escapeAttr(s.name)}">
          <span class="ncb-source-check" aria-hidden="true">
            ${checked
              ? '<svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
              : ''}
          </span>
        </button>
        <div class="ncb-source-info">
          <p class="ncb-source-name">${escapeHtml(s.name)}</p>
          <p class="ncb-source-meta">${escapeHtml(meta)}</p>
        </div>
        <button type="button" class="ncb-source-open ncb-source-remove" aria-label="Remove ${escapeAttr(s.name)} from library">
          <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    `;
    })
    .join('');
  // Toggle (select/deselect for current chat).
  list.querySelectorAll<HTMLButtonElement>('.ncb-source-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest<HTMLElement>('.ncb-source-row')?.dataset.id;
      if (!id) return;
      const c = chatStore.getActive();
      if (c.selectedSourceIds.includes(id)) {
        c.selectedSourceIds = c.selectedSourceIds.filter((sid) => sid !== id);
      } else {
        c.selectedSourceIds.push(id);
      }
      saveChatStore();
      renderSourcesCard(root);
      updateContextPill(root);
    });
  });
  // Remove from library entirely (also deselects from all chats).
  list.querySelectorAll<HTMLButtonElement>('.ncb-source-remove').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.closest<HTMLElement>('.ncb-source-row')?.dataset.id;
      if (!id) return;
      sourceLibrary.items = sourceLibrary.items.filter((s) => s.id !== id);
      chatStore.chats.forEach((c) => {
        c.selectedSourceIds = c.selectedSourceIds.filter((sid) => sid !== id);
      });
      saveSourceLibrary();
      saveChatStore();
      renderSourcesCard(root);
      updateContextPill(root);
    });
  });
}

// The composer chip row is no longer the source of truth for what's
// attached — the Sources card in the right rail owns that now. Keep the
// helper as a no-op shim so any remaining callers don't blow up, and
// hide the row in the DOM. Legacy callers will be dropped over time.
function renderAttachChips(root: HTMLElement): void {
  const row = root.querySelector<HTMLElement>('.ncb-attach-row');
  if (!row) return;
  row.hidden = true;
  row.innerHTML = '';
}

// ---- Context-panel tabs ----

function initContextTabs(root: HTMLElement): void {
  const tabs = Array.from(root.querySelectorAll<HTMLElement>('.ncb-mini-tab'));
  if (!tabs.length || tabs[0]?.dataset.ncbBound === '1') return;

  const sourcesCard = root.querySelector<HTMLElement>('.ncb-sources-card');
  const notesCard = root.querySelector<HTMLElement>('.ncb-notes-card');

  tabs.forEach((tab, idx) => {
    tab.dataset.ncbBound = '1';
    tab.dataset.tabIdx = String(idx);
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('ncb-mini-tab--active'));
      tab.classList.add('ncb-mini-tab--active');

      const label = (tab.querySelector<HTMLElement>('span')?.textContent || '').trim();
      const showNotes = label === 'Notes';

      // PR-07: Notes tab shows saved replies; Files/Sources still share the
      // "Sources used" card (real per-tab Files/Sources content is future work).
      if (sourcesCard) sourcesCard.hidden = showNotes;
      if (notesCard) notesCard.hidden = !showNotes;

      const cardTitle = sourcesCard?.querySelector<HTMLElement>('.ncb-context-card-title');
      if (cardTitle && !showNotes) cardTitle.textContent = label === 'Sources' ? tStr('cb_sources_used', 'Sources used') : label;

      if (showNotes) renderNotesTab(root);
    });
  });
}

// ---- Saved replies: server persistence ----
// localStorage is the instant read/write cache; the chat_saved_replies table
// is the durable copy (survives cleared browser data / other devices). All
// pushes are fire-and-forget; renderNotesTab does a one-shot two-way merge
// per chat per page load, which also re-pushes anything a failed POST missed.

const SAVED_REPLIES_API = '/api/chat-saved-replies';

function syncSavedReplyCreate(chatId: string, r: SavedReply): void {
  const token = getSbToken();
  if (!token) return;
  void fetch(SAVED_REPLIES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ id: r.id, chatId, text: r.text, createdAt: r.createdAt }),
  }).catch(() => {
    /* offline — the local copy is intact; the next Notes-tab merge re-pushes it */
  });
}

function syncSavedReplyDelete(id: string): void {
  const token = getSbToken();
  if (!token) return;
  void fetch(SAVED_REPLIES_API + '?id=' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + token },
  }).catch(() => {
    /* offline — worst case the reply resurfaces on a later merge */
  });
}

const _savedRepliesSyncedChats = new Set<string>();

async function mergeSavedRepliesFromServer(root: HTMLElement, chatId: string): Promise<void> {
  if (_savedRepliesSyncedChats.has(chatId)) return;
  const token = getSbToken();
  if (!token) return;
  _savedRepliesSyncedChats.add(chatId);
  try {
    const resp = await fetch(SAVED_REPLIES_API + '?chatId=' + encodeURIComponent(chatId), {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!resp.ok) {
      _savedRepliesSyncedChats.delete(chatId);
      return;
    }
    const data = (await resp.json()) as {
      replies?: Array<{ id?: string; reply_text?: string; created_at?: string }>;
    };
    const serverRows = Array.isArray(data.replies) ? data.replies : [];
    const chat = chatStore.chats.find((c) => c.id === chatId);
    if (!chat) return;

    // Server → local: adopt rows this browser doesn't have.
    const localIds = new Set(chat.savedReplies.map((r) => r.id));
    let changed = false;
    for (const row of serverRows) {
      if (!row.id || typeof row.reply_text !== 'string' || localIds.has(row.id)) continue;
      chat.savedReplies.push({
        id: row.id,
        text: row.reply_text,
        createdAt: Date.parse(row.created_at || '') || Date.now(),
      });
      changed = true;
    }

    // Local → server: re-push rows a failed/pre-feature save never uploaded.
    const serverIds = new Set(serverRows.map((r) => r.id));
    chat.savedReplies.forEach((r) => {
      if (!serverIds.has(r.id)) syncSavedReplyCreate(chatId, r);
    });

    if (changed) {
      chat.savedReplies.sort((a, b) => b.createdAt - a.createdAt);
      saveChatStore();
      // Re-render only if the Notes tab for this chat is still on screen.
      // Safe from loops: the synced-chats set short-circuits the next call.
      const notesCard = root.querySelector<HTMLElement>('.ncb-notes-card');
      if (notesCard && !notesCard.hidden && chatStore.activeId === chatId) renderNotesTab(root);
    }
  } catch {
    _savedRepliesSyncedChats.delete(chatId); // network error — retry on next open
  }
}

function saveReplyToNotes(aiRow: HTMLElement, raw: string, btn: HTMLElement): void {
  const chat = chatStore.getActive();

  // De-dupe by exact text — Save twice should refuse, not double-add.
  const already = chat.savedReplies.find((r) => r.text === raw);
  if (already) {
    flashAck(btn, tStr('cb_act_already_saved', 'Already saved'));
    return;
  }

  const reply: SavedReply = {
    id: 'rep_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    text: raw,
    createdAt: Date.now(),
  };
  chat.savedReplies.unshift(reply);
  touchActiveChat();
  saveChatStore();
  syncSavedReplyCreate(chat.id, reply);
  flashAck(btn, tStr('cb_act_saved', 'Saved'));

  // If the Notes tab is currently visible, refresh it inline.
  const root = aiRow.closest<HTMLElement>('.ncb-root');
  if (root) {
    const notesCard = root.querySelector<HTMLElement>('.ncb-notes-card');
    if (notesCard && !notesCard.hidden) renderNotesTab(root);

    // Always keep the count pill fresh — visible only when Notes tab is open
    // but cheap to update so we don't desync if user opens it later.
    const count = root.querySelector<HTMLElement>('.ncb-notes-count');
    if (count) count.textContent = String(chat.savedReplies.length);
  }
}

function renderNotesTab(root: HTMLElement): void {
  const notesCard = root.querySelector<HTMLElement>('.ncb-notes-card');
  if (!notesCard) return;
  const list = notesCard.querySelector<HTMLElement>('.ncb-notes-list');
  const count = notesCard.querySelector<HTMLElement>('.ncb-notes-count');
  if (!list) return;

  const chat = chatStore.getActive();
  if (count) count.textContent = String(chat.savedReplies.length);

  // Pull the durable server copy in the background (once per chat per page
  // load); re-renders this tab if it brings anything new.
  void mergeSavedRepliesFromServer(root, chat.id);

  if (chat.savedReplies.length === 0) {
    list.innerHTML =
      '<p class="ncb-notes-empty">' + escapeHtml(tStr('cb_notes_empty', 'Save useful AI replies here by tapping the Save to notes button under any reply.')) + '</p>';
    return;
  }

  list.innerHTML = chat.savedReplies
    .map(
      (r) => `
      <article class="ncb-saved-card" data-id="${escapeAttr(r.id)}">
        <div class="ncb-saved-body">${renderInlineMarkdown(r.text)}</div>
        <div class="ncb-saved-foot">
          <span class="ncb-saved-time">${escapeHtml(relativeTime(r.createdAt))}</span>
          <div class="ncb-saved-actions">
            <button type="button" class="ncb-saved-copy" title="${escapeAttr(tStr('cb_act_copy', 'Copy'))}">
              <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            </button>
            <button type="button" class="ncb-saved-remove" title="${escapeAttr(tStr('cb_menu_delete', 'Delete'))}" aria-label="${escapeAttr(tStr('cb_remove_saved_reply', 'Remove saved reply'))}">
              <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </div>
      </article>
    `
    )
    .join('');

  list.querySelectorAll<HTMLElement>('.ncb-saved-card').forEach((card) => {
    const id = card.dataset.id;
    if (!id) return;
    card.querySelector<HTMLButtonElement>('.ncb-saved-remove')?.addEventListener('click', () => {
      chat.savedReplies = chat.savedReplies.filter((r) => r.id !== id);
      touchActiveChat();
      saveChatStore();
      syncSavedReplyDelete(id);
      renderNotesTab(root);
    });
    card.querySelector<HTMLButtonElement>('.ncb-saved-copy')?.addEventListener('click', (ev) => {
      const target = ev.currentTarget as HTMLElement;
      const reply = chat.savedReplies.find((r) => r.id === id);
      if (reply) copyToClipboard(reply.text, target);
    });
  });
}

// ---- Chat title generation ----

async function generateChatTitle(state: ConversationState): Promise<string | null> {
  const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
  const lastAi = [...state.messages].reverse().find((m) => m.role === 'assistant');
  if (!lastUser && !lastAi) return null;

  // Strip fenced blocks (code / minallo-diagram / minallo-quiz JSON) from the
  // AI sample before seeding the titler — feeding it raw block payloads both
  // wastes tokens and risks the block leaking into the generated title.
  const aiSample = (lastAi?.text || '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  const seed =
    (lastUser?.text || '') +
    (lastUser?.images?.length ? ' [' + lastUser.images.length + ' image(s)]' : '') +
    '\n\n' +
    aiSample.slice(0, 400);

  try {
    const resp = await fetch('/api/ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (getSbToken() || ''),
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 30,
        system:
          'You title chat conversations. Reply with ONLY a 3-6 word title in Title Case. ' +
          'No quotes, no punctuation at the end, no preamble. Match the language of the user.',
        messages: [{ role: 'user', content: seed }],
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { content?: Array<{ text?: string }> };
    const title = (data.content || [])
      .map((b) => b.text || '')
      .join('')
      .trim()
      .replace(/^["'`]+|["'`.!?]+$/g, '');
    return title || null;
  } catch {
    return null;
  }
}

function updateChatTitle(title: string): void {
  // PR-05: persist into store + re-render header and sidebar row from data.
  const active = chatStore.getActive();
  active.title = sanitizeChatTitle(title) || 'New chat';
  active.updatedAt = Date.now();
  saveChatStore();

  const root = document.getElementById('ncbRoot');
  if (root) {
    const headerTitle = root.querySelector<HTMLElement>('.ncb-chat-header-title');
    if (headerTitle) headerTitle.textContent = displayChatTitle(title);
    renderSidebar(root);
  }
}

// ============ PR-05: Chat store + persistence + sidebar render + chat load ============

interface SavedReply {
  id: string;
  text: string;
  createdAt: number;
}

interface SavedChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** @deprecated kept for backward compat with v1 chats — selectedSourceIds is the new model. */
  attachedFolders: ImportedFolder[];
  /** IDs of sources from the global library that are active for this chat. */
  selectedSourceIds: string[];
  sourceMode: SourceMode;
  courseFileScope: CourseFileScope;
  savedReplies: SavedReply[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ChatStore {
  chats: SavedChat[];
  activeId: string;
  getActive(): SavedChat;
  newChat(): SavedChat;
}

/** Global source library entry — one per imported file/folder, shared across all chats. */
interface SourceLibraryItem {
  id: string;
  name: string;
  count: string;
  courseId: string;
  courseName: string;
  documents: Array<{ name: string; text: string; id?: string }>;
  importedAt: number;
}

// Chat transcripts and imported source text are private user data, so the
// storage keys are namespaced per user id — same pattern as the
// ss_user_courses:<uid> fix in app-data.js — and an account signing in on
// this browser can never read another account's chats. The legacy unscoped
// keys are migrated once into the current user's namespace, then deleted.
const NCB_STORE_KEY_BASE = 'ss_ncb_chats_v1';
const NCB_ACTIVE_KEY_BASE = 'ss_ncb_active_v1';
const NCB_SOURCES_KEY_BASE = 'ss_ncb_sources_v1';

function ncbCurrentUid(): string {
  const u = (window as unknown as { _currentUser?: { id?: string; sub?: string } })._currentUser;
  if (u && (u.id || u.sub)) return u.id || u.sub || '';
  // Cold start: auth may not have resolved yet, but ss_last_uid was persisted
  // by the session that is being restored.
  try { return localStorage.getItem('ss_last_uid') || ''; } catch { return ''; }
}

function ncbScopedKey(base: string): string {
  const uid = ncbCurrentUid();
  return uid ? base + ':' + uid : base;
}
const NCB_MAX_STORED_CHATS = 200;
const NCB_MAX_STORED_MESSAGES_PER_CHAT = 120;
const NCB_MAX_STORED_MESSAGE_CHARS = 80000;
const NCB_MAX_SOURCE_ITEMS = 120;
const NCB_MAX_SOURCE_DOCS_PER_ITEM = 20;
const NCB_MAX_SOURCE_DOC_CHARS = 24000;

const sourceLibrary: { items: SourceLibraryItem[] } = { items: [] };

let liveState: ConversationState | null = null;

const chatStore: ChatStore = {
  chats: [],
  activeId: '',
  getActive(): SavedChat {
    let c = chatStore.chats.find((ch) => ch.id === chatStore.activeId);
    if (c) return c;
    // Self-heal: pick the most recent, or create a fresh one.
    c = chatStore.chats[0];
    if (c) {
      chatStore.activeId = c.id;
      return c;
    }
    const fresh = chatStore.newChat();
    chatStore.activeId = fresh.id;
    return fresh;
  },
  newChat(): SavedChat {
    const now = Date.now();
    const chat: SavedChat = {
      id: 'ncb_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      title: 'New chat',
      messages: [],
      attachedFolders: [],
      selectedSourceIds: [],
      sourceMode: 'auto',
      courseFileScope: 'all_course_files',
      savedReplies: [],
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };
    chatStore.chats.unshift(chat);
    return chat;
  },
};

function getOrInitLiveState(): ConversationState {
  if (liveState) return liveState;
  const fresh: ConversationState = {
    messages: [],
    pasted: [],
    files: [],
    controller: null,
    isSending: false,
  };
  liveState = fresh;
  return fresh;
}

function truncateForStorage(text: string, max: number): string {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + '\n\n[Stored transcript trimmed for browser performance.]';
}

function compactMessageForStorage(m: ChatMessage): ChatMessage {
  const compact: ChatMessage = {
    role: m.role,
    text: truncateForStorage(m.text || '', NCB_MAX_STORED_MESSAGE_CHARS),
  };
  if (m.images?.length) {
    compact.images = m.images.map((img) => ({
      id: img.id,
      name: img.name,
      mediaType: img.mediaType,
      dataUrl: '',
    }));
  }
  if (m.files?.length) {
    compact.files = m.files.map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      mediaType: f.mediaType,
      size: f.size,
    }));
  }
  if (m.role === 'assistant') {
    compact.selectedSourceMode = m.selectedSourceMode;
    compact.sourceScope = m.sourceScope;
    compact.sourceLabel = m.sourceLabel;
    compact.courseFileScope = m.courseFileScope;
    compact.sources = m.sources;
    compact.allowDiagrams = !!m.allowDiagrams;
    // Preserve the mission marker verbatim — it's tiny and must survive
    // the storage round-trip so appendStoredMessage can re-fetch the cards.
    if (m.missionMarker) compact.missionMarker = m.missionMarker;
    // Keep the generated cheatsheet/summary so "explain the cheatsheet you
    // just created" still works after a page refresh. Capped at the same
    // length the model would receive anyway.
    if (m.generatedDoc?.markdown) {
      compact.generatedDoc = {
        kind: m.generatedDoc.kind,
        title: m.generatedDoc.title,
        markdown: m.generatedDoc.markdown.slice(0, NCB_GENERATED_DOC_CONTEXT_CHARS),
        courseId: m.generatedDoc.courseId,
        noteId: m.generatedDoc.noteId,
      };
    }
  }
  return compact;
}

function compactChatForStorage(c: SavedChat): SavedChat {
  const messages = c.messages.slice(-NCB_MAX_STORED_MESSAGES_PER_CHAT);
  return {
    id: c.id,
    title: c.title,
    messages: messages.map(compactMessageForStorage),
    attachedFolders: [],
    selectedSourceIds: Array.isArray(c.selectedSourceIds) ? c.selectedSourceIds.slice() : [],
    sourceMode: normaliseSourceMode(c.sourceMode),
    courseFileScope: normaliseCourseFileScope(c.courseFileScope),
    savedReplies: (c.savedReplies || []).map((r) => ({
      id: r.id,
      text: truncateForStorage(r.text || '', NCB_MAX_STORED_MESSAGE_CHARS),
      createdAt: r.createdAt,
    })),
    pinned: !!c.pinned,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function compactChatsForStorage(chats: SavedChat[], activeId: string): SavedChat[] {
  const picked = new Map<string, SavedChat>();
  const byRecent = chats.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const add = (c: SavedChat | undefined): void => {
    if (c && !picked.has(c.id)) picked.set(c.id, c);
  };
  add(chats.find((c) => c.id === activeId));
  byRecent.filter((c) => c.pinned).forEach(add);
  byRecent.forEach((c) => {
    if (picked.size < NCB_MAX_STORED_CHATS) add(c);
  });
  return Array.from(picked.values()).map(compactChatForStorage);
}

function compactSourcesForStorage(items: SourceLibraryItem[], selectedIds: Set<string>): SourceLibraryItem[] {
  const selected = items.filter((s) => selectedIds.has(s.id));
  const recent = items
    .filter((s) => !selectedIds.has(s.id))
    .sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
  return selected
    .concat(recent)
    .slice(0, NCB_MAX_SOURCE_ITEMS)
    .map((s) => ({
      id: s.id,
      name: s.name,
      count: s.count,
      courseId: s.courseId,
      courseName: s.courseName,
      importedAt: s.importedAt,
      documents: (s.documents || []).slice(0, NCB_MAX_SOURCE_DOCS_PER_ITEM).map((d) => ({
        name: d.name,
        text: truncateForStorage(d.text || '', NCB_MAX_SOURCE_DOC_CHARS),
        id: d.id,
      })),
    }));
}

function selectedSourceIdsFromChats(chats: SavedChat[]): Set<string> {
  const ids = new Set<string>();
  chats.forEach((c) => (c.selectedSourceIds || []).forEach((id) => ids.add(id)));
  return ids;
}

let _ncbLoadedUid: string | null = null;

function loadChatStore(): void {
  const uid = ncbCurrentUid();
  // Account changed within one page session. SIGNED_OUT normally reloads the
  // page, so this is belt-and-braces — but never let one account's in-memory
  // chats survive into (or be saved under) another account's namespace.
  if (_ncbLoadedUid !== null && _ncbLoadedUid !== uid) {
    chatStore.chats = [];
    chatStore.activeId = '';
    sourceLibrary.items = [];
    liveState = null;
  }
  _ncbLoadedUid = uid;

  // One-time migration: clients before the per-uid scoping wrote chats to the
  // unscoped keys, which leaked across accounts sharing a browser. Adopt that
  // data for the current user, then delete it so it can never resurface in a
  // different account.
  try {
    if (uid) {
      [NCB_STORE_KEY_BASE, NCB_ACTIVE_KEY_BASE, NCB_SOURCES_KEY_BASE].forEach((base) => {
        const legacy = localStorage.getItem(base);
        if (legacy === null) return;
        if (localStorage.getItem(base + ':' + uid) === null) {
          localStorage.setItem(base + ':' + uid, legacy);
        }
        localStorage.removeItem(base);
      });
    }
  } catch {
    /* private mode — nothing to migrate */
  }

  try {
    const raw = localStorage.getItem(ncbScopedKey(NCB_STORE_KEY_BASE));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) chatStore.chats = parsed as SavedChat[];
    }
    const activeRaw = localStorage.getItem(ncbScopedKey(NCB_ACTIVE_KEY_BASE));
    if (typeof activeRaw === 'string' && activeRaw) chatStore.activeId = activeRaw;
  } catch {
    // private mode / corrupt storage — start fresh
  }

  // Load the global source library first so the migration below can hoist
  // legacy per-chat attachedFolders into it.
  try {
    const rawLib = localStorage.getItem(ncbScopedKey(NCB_SOURCES_KEY_BASE));
    if (rawLib) {
      const parsedLib = JSON.parse(rawLib) as unknown;
      if (Array.isArray(parsedLib)) sourceLibrary.items = parsedLib as SourceLibraryItem[];
    }
  } catch {
    /* corrupt storage — start fresh */
  }

  // Migrate any missing fields on legacy entries.
  chatStore.chats.forEach((c) => {
    if (!Array.isArray(c.messages)) c.messages = [];
    if (!Array.isArray(c.attachedFolders)) c.attachedFolders = [];
    if (!Array.isArray(c.selectedSourceIds)) c.selectedSourceIds = [];
    if (!Array.isArray(c.savedReplies)) c.savedReplies = [];
    c.sourceMode = normaliseSourceMode(c.sourceMode);
    c.courseFileScope = normaliseCourseFileScope(c.courseFileScope);
    if (typeof c.pinned !== 'boolean') c.pinned = false;
    if (typeof c.createdAt !== 'number') c.createdAt = Date.now();
    if (typeof c.updatedAt !== 'number') c.updatedAt = c.createdAt;
    if (typeof c.title !== 'string' || !c.title) c.title = 'New chat';

    // v1 → v2 migration: hoist this chat's attachedFolders into the
    // global library and convert them into selectedSourceIds. Only
    // runs if the chat hasn't been migrated yet (no selectedSourceIds).
    if (c.selectedSourceIds.length === 0 && c.attachedFolders.length > 0) {
      c.attachedFolders.forEach((f) => {
        if (!sourceLibrary.items.find((s) => s.id === f.id)) {
          sourceLibrary.items.push({
            id: f.id,
            name: f.name,
            count: f.count,
            courseId: f.id.split(':')[0] || '',
            courseName: '',
            documents: f.documents || [],
            importedAt: c.createdAt,
          });
        }
        if (!c.selectedSourceIds.includes(f.id)) c.selectedSourceIds.push(f.id);
      });
    }
  });

  // Ensure there is always at least one chat and an activeId pointing somewhere.
  if (chatStore.chats.length === 0) {
    const fresh = chatStore.newChat();
    chatStore.activeId = fresh.id;
  } else if (!chatStore.chats.find((c) => c.id === chatStore.activeId)) {
    chatStore.activeId = chatStore.chats[0]!.id;
  }
  chatStore.chats = compactChatsForStorage(chatStore.chats, chatStore.activeId);
  sourceLibrary.items = compactSourcesForStorage(
    sourceLibrary.items,
    selectedSourceIdsFromChats(chatStore.chats)
  );
  try {
    localStorage.setItem(ncbScopedKey(NCB_STORE_KEY_BASE), JSON.stringify(chatStore.chats));
    localStorage.setItem(ncbScopedKey(NCB_ACTIVE_KEY_BASE), chatStore.activeId);
    localStorage.setItem(ncbScopedKey(NCB_SOURCES_KEY_BASE), JSON.stringify(sourceLibrary.items));
  } catch {
    // The regular debounced save path will show the user-facing quota warning.
  }
}

function saveSourceLibrary(): void {
  try {
    localStorage.setItem(
      ncbScopedKey(NCB_SOURCES_KEY_BASE),
      JSON.stringify(compactSourcesForStorage(sourceLibrary.items, selectedSourceIdsFromChats(chatStore.chats)))
    );
  } catch {
    // Quota exceeded etc. — the chat-store save path will surface a toast.
  }
}

let _saveTimer: number | null = null;
let _quotaToastShown = false;
function saveChatStore(): void {
  if (_saveTimer != null) window.clearTimeout(_saveTimer);
  _saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(
        ncbScopedKey(NCB_STORE_KEY_BASE),
        JSON.stringify(compactChatsForStorage(chatStore.chats, chatStore.activeId))
      );
      localStorage.setItem(ncbScopedKey(NCB_ACTIVE_KEY_BASE), chatStore.activeId);
    } catch (err) {
      // Quota exceeded or private-mode write block. Tell the user once per
      // page load so they know their chats may not persist — but don't spam
      // toasts on every keystroke.
      if (_quotaToastShown) return;
      _quotaToastShown = true;
      const w = window as unknown as { showToast?: (title: string, msg?: string) => void };
      const isQuota = (err as DOMException)?.name === 'QuotaExceededError';
      if (typeof w.showToast === 'function') {
        w.showToast(
          isQuota ? tStr('cb_storage_full_title', 'Chat storage full') : tStr('cb_storage_blocked_title', 'Chats not saved'),
          isQuota
            ? tStr('cb_storage_full_text', 'Browser storage is full. Delete some chats to keep new ones from being lost on reload.')
            : tStr('cb_storage_blocked_text', 'Your browser blocked storage (private mode?). Chats will not persist across reloads.')
        );
      }
    }
  }, 200);
}

function touchActiveChat(): void {
  const c = chatStore.getActive();
  c.updatedAt = Date.now();
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  const isDe = (localStorage.getItem('ss_lang') || 'en') === 'de';
  if (min < 1) return isDe ? 'Gerade eben' : 'Just now';
  if (min < 60) return isDe ? `vor ${min} Min.` : `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return isDe ? `vor ${hr} Std.` : `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return isDe ? `vor ${d} Tag${d === 1 ? '' : 'en'}` : `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString(isDe ? 'de-DE' : 'en-US');
}

// 'New chat' is the sentinel title for un-renamed chats. Translate at display
// time so storage stays stable and language switches don't desync chat lists.
const MAX_CHAT_TITLE_CHARS = 60;

// Defensive title cleanup. A title should be a short phrase, but a malformed
// one can slip through (e.g. an assistant reply that leaked a
// ```minallo-diagram``` block into title generation). Take the text before any
// code fence, keep the first line, drop markdown noise, collapse whitespace,
// and hard-cap the length so it can never balloon the header card.
function sanitizeChatTitle(raw: string): string {
  let t = raw || '';
  const fenceIdx = t.indexOf('```');
  if (fenceIdx >= 0) t = t.slice(0, fenceIdx);
  t = (t.split('\n')[0] || '').replace(/[`*#>_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > MAX_CHAT_TITLE_CHARS) t = t.slice(0, MAX_CHAT_TITLE_CHARS).trimEnd() + '…';
  return t;
}

function displayChatTitle(title: string): string {
  if (title === 'New chat') return tStr('cb_chat_title_new', 'New chat');
  return sanitizeChatTitle(title) || tStr('cb_chat_title_new', 'New chat');
}

function chatMeta(c: SavedChat): string {
  const attached = c.selectedSourceIds.length;
  const isDe = (localStorage.getItem('ss_lang') || 'en') === 'de';
  let fragment: string;
  if (attached > 0) {
    fragment = isDe
      ? `${attached} ${attached === 1 ? 'Quelle' : 'Quellen'}`
      : `${attached} source${attached === 1 ? '' : 's'}`;
  } else if (c.messages.length === 0) {
    fragment = tStr('cb_empty_draft', 'Empty draft');
  } else {
    const n = c.messages.length;
    fragment = isDe
      ? `${n} ${n === 1 ? 'Nachr.' : 'Nachr.'}`
      : `${n} msg${n === 1 ? '' : 's'}`;
  }
  return fragment + ' · ' + relativeTime(c.updatedAt);
}

function renderSidebar(root: HTMLElement): void {
  const list = root.querySelector<HTMLElement>('.ncb-chat-list');
  if (!list) return;
  const runId = ++sidebarRenderRun;

  const pinned = chatStore.chats.filter((c) => c.pinned);
  const recent = chatStore.chats.filter((c) => !c.pinned);

  const sections: string[] = [];
  if (pinned.length) {
    sections.push('<p class="ncb-chat-section-label">' + escapeHtml(tStr('cb_section_pinned', 'Pinned')) + '</p>');
    pinned.forEach((c) => sections.push(buildSidebarRow(c)));
  }
  if (recent.length) {
    sections.push('<p class="ncb-chat-section-label">' + escapeHtml(tStr('cb_section_recent', 'Recent')) + '</p>');
    recent.forEach((c) => sections.push(buildSidebarRow(c)));
  }
  list.innerHTML = '';
  if (!sections.length) return;

  const firstChunk = Math.min(sections.length, 48);
  list.insertAdjacentHTML('beforeend', sections.slice(0, firstChunk).join(''));
  let index = firstChunk;

  const renderChunk = (): void => {
    if (runId !== sidebarRenderRun) return;
    const end = Math.min(index + 96, sections.length);
    list.insertAdjacentHTML('beforeend', sections.slice(index, end).join(''));
    index = end;
    if (index < sections.length) window.requestAnimationFrame(renderChunk);
  };
  if (index < sections.length) window.requestAnimationFrame(renderChunk);
}

function buildSidebarRow(c: SavedChat): string {
  const isActive = c.id === chatStore.activeId;
  const iconPath = c.pinned
    ? '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>'
    : '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
  return `
    <button type="button" class="ncb-chat-item${isActive ? ' ncb-chat-item--active' : ''}" data-chat-id="${escapeAttr(c.id)}" data-search-text="${escapeAttr(displayChatTitle(c.title).toLowerCase())}">
      <span class="ncb-chat-icon">
        <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>
      </span>
      <span class="ncb-chat-text">
        <span class="ncb-chat-title">${escapeHtml(displayChatTitle(c.title))}</span>
        <span class="ncb-chat-meta">${escapeHtml(chatMeta(c))}</span>
      </span>
      <span class="ncb-chat-more" aria-hidden="true">
        <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
      </span>
    </button>
  `;
}

function updateActiveSidebarItem(root: HTMLElement, chatId: string): void {
  const list = root.querySelector<HTMLElement>('.ncb-chat-list');
  if (!list) return;
  list.querySelector<HTMLElement>('.ncb-chat-item--active')?.classList.remove('ncb-chat-item--active');
  list
    .querySelector<HTMLElement>('.ncb-chat-item[data-chat-id="' + cssEscape(chatId) + '"]')
    ?.classList.add('ncb-chat-item--active');
}

function switchActiveChat(root: HTMLElement, chatId: string): void {
  if (chatId === chatStore.activeId) return;
  // Abort in-flight response on the old chat.
  if (liveState?.controller) liveState.controller.abort();
  chatStore.activeId = chatId;
  saveChatStore();
  updateActiveSidebarItem(root, chatId);
  if (activeChatLoadRaf != null) window.cancelAnimationFrame(activeChatLoadRaf);
  activeChatLoadRaf = window.requestAnimationFrame(() => {
    activeChatLoadRaf = null;
    loadActiveChatIntoCenter(root);
  });
}

function loadActiveChatIntoCenter(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>('.ncb-empty');
  const msgs = root.querySelector<HTMLElement>('.ncb-msgs');
  const headerTitle = root.querySelector<HTMLElement>('.ncb-chat-header-title');
  const textarea = root.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
  const sendBtn = root.querySelector<HTMLButtonElement>('.ncb-send-btn');
  const pasteRow = root.querySelector<HTMLElement>('.ncb-paste-row');
  if (!stage || !msgs) return;

  const chat = chatStore.getActive();

  // Reset transient live state.
  const state = getOrInitLiveState();
  state.messages = chat.messages;
  state.pasted = [];
  state.files = [];
  state.controller = null;
  state.isSending = false;
  if (sendBtn) setSendBtnMode(sendBtn, 'send');
  if (textarea) {
    textarea.value = '';
    textarea.style.height = '44px';
    textarea.style.overflowY = 'hidden';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (pasteRow) renderPasteRow(state, pasteRow);
  renderFilesRow(root, state);

  // Header title.
  if (headerTitle) headerTitle.textContent = displayChatTitle(chat.title);
  updateContextPill(root);

  // Stage mode: active iff there are any messages.
  stage.dataset.state = chat.messages.length > 0 ? 'active' : 'empty';

  renderConversationMessages(msgs, chat.messages);

  // Re-render attached folders + sources panel + saved-replies count.
  renderAttachChips(root);
  renderSourcesCard(root);
  updateContextPill(root);
  const count = root.querySelector<HTMLElement>('.ncb-notes-count');
  if (count) count.textContent = String(chat.savedReplies.length);
  const notesCard = root.querySelector<HTMLElement>('.ncb-notes-card');
  if (notesCard && !notesCard.hidden) renderNotesTab(root);

  // Land on the latest message when a chat is opened or switched to, holding
  // the bottom through the async render/KaTeX reflow that follows.
  if (chat.messages.length > 0) forceChatScrollToBottom(root);
}

function appendStoredMessage(msgs: HTMLElement, m: ChatMessage): void {
  if (m.role === 'user') {
    appendUserBubble(msgs, m.text, m.images || [], m.files || []);
    return;
  }
  const row = appendAiBubble(msgs);
  // Restored history must not re-pop interactive minallo-input modals (see
  // promoteAiInputToModal's [data-restored] guard) — forms stay inline.
  row.setAttribute('data-restored', 'true');
  const bubble = row.querySelector<HTMLElement>('.ncb-bubble-body');

  // Daily Mission marker: re-fetch and re-render the live card UI instead of
  // replaying the serialised plain-text fallback, which has no CSS or listeners.
  if (m.missionMarker && m.missionMarker.type === 'daily_mission' && bubble) {
    const marker = m.missionMarker;
    const today = todayLocalDateStr();
    if (marker.date === today) {
      // Same day — reload today's mission fresh.
      bubble.innerHTML = '<div class="dm-loading">Loading your daily mission…</div>';
      import('../daily-mission/daily-mission-ui.js')
        .then((mod) => {
          bubble.innerHTML = '';
          void mod.mountDailyMissionPanel(bubble, marker.courseId, {
            handlers: buildDailyMissionHandlers(marker.courseId)
          });
          scrollMsgsToBottom(msgs);
        })
        .catch(() => {
          bubble.innerHTML = '';
          renderRichBubble(bubble, m.text, !!m.allowDiagrams);
        });
    } else {
      // Past day — show an expired notice with a button to load today's mission.
      bubble.innerHTML =
        '<div class="dm-state dm-state--expired">' +
          '<div class="dm-state-title">This mission has expired</div>' +
          '<p class="dm-state-text">This was your study plan from ' + escapeHtml(marker.date) + '.</p>' +
          '<button type="button" class="dm-cta dm-btn-load-today">Load today’s mission</button>' +
        '</div>';
      const btn = bubble.querySelector<HTMLButtonElement>('.dm-btn-load-today');
      btn?.addEventListener('click', () => {
        bubble.innerHTML = '<div class="dm-loading">Loading your daily mission…</div>';
        import('../daily-mission/daily-mission-ui.js')
          .then((mod) => {
            bubble.innerHTML = '';
            void mod.mountDailyMissionPanel(bubble, marker.courseId, {
              handlers: buildDailyMissionHandlers(marker.courseId)
            });
            scrollMsgsToBottom(msgs);
          })
          .catch(() => {
            bubble.innerHTML = '';
            renderRichBubble(bubble, m.text, !!m.allowDiagrams);
          });
      });
    }
    appendBubbleActions(row, m.text);
    return;
  }

  // Answers saved before the clean-opening fix may still start with the old
  // source preface / self-intro — scrub at render time.
  if (bubble) renderRichBubble(bubble, stripAnswerIntro(m.text), !!m.allowDiagrams);
  if (bubble && (m.sourceLabel || m.sources?.length)) {
    appendAskStreamMeta(bubble, {
      sourceLabel: m.sourceLabel,
      selectedSourceMode: m.selectedSourceMode,
      sourceScope: m.sourceScope,
      courseFileScope: m.courseFileScope,
      sources: m.sources || [],
    });
  }
  appendBubbleActions(row, m.text);
}

function renderConversationMessages(msgs: HTMLElement, messages: ChatMessage[]): void {
  const runId = ++messageRenderRun;
  msgs.innerHTML = '';
  if (!messages.length) return;

  let index = 0;
  const firstChunk = Math.min(messages.length, 2);
  suppressMessageAutoScroll = true;
  try {
    while (index < firstChunk) appendStoredMessage(msgs, messages[index++]!);
  } finally {
    suppressMessageAutoScroll = false;
  }
  scrollMsgsToBottom(msgs);

  const renderChunk = (): void => {
    if (runId !== messageRenderRun) return;
    suppressMessageAutoScroll = true;
    try {
      const end = Math.min(index + 4, messages.length);
      while (index < end) appendStoredMessage(msgs, messages[index++]!);
    } finally {
      suppressMessageAutoScroll = false;
    }
    scrollMsgsToBottom(msgs);
    if (index < messages.length) window.requestAnimationFrame(renderChunk);
  };
  if (index < messages.length) window.requestAnimationFrame(renderChunk);
}

// ============ PR-06: file upload + pdf extraction + files row + regenerate ============

const NCB_FILE_LIMIT = 10;
const NCB_TEXT_CHAR_LIMIT = 60000;
const NCB_PDF_PAGE_LIMIT = 80;
// /api/ai accepts at most 5 images per request (config.ai.imageMax) — keep
// one slot free for a pasted screenshot riding the same message.
const NCB_PDF_IMAGE_PAGE_LIMIT = 4;

function initUploads(root: HTMLElement): void {
  const trigger = root.querySelector<HTMLButtonElement>('.ncb-upload-btn');
  const input = root.querySelector<HTMLInputElement>('.ncb-file-input');
  if (!trigger || !input || trigger.dataset.ncbBound === '1') return;
  trigger.dataset.ncbBound = '1';

  trigger.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    void absorbUploadedFiles(files, root);
  });
}

async function absorbUploadedFiles(files: File[], root: HTMLElement): Promise<void> {
  const state = getOrInitLiveState();
  const remaining = NCB_FILE_LIMIT - state.files.length;
  if (remaining <= 0) return;
  const accepted = files.slice(0, remaining);

  for (const f of accepted) {
    const pending = await readUploadedFile(f);
    if (pending) state.files.push(pending);
    renderFilesRow(root, state);
  }
}

function readUploadedFile(f: File): Promise<PendingFile | null> {
  const id = (f.name || 'file') + '-' + (f.lastModified || Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  const baseMeta = { id, name: f.name || 'file', size: f.size };

  // Image — encode as base64 (strip the data: prefix).
  if (f.type && f.type.startsWith('image/')) {
    return readAsDataUrl(f).then((dataUrl) => {
      if (!dataUrl) return null;
      return {
        ...baseMeta,
        kind: 'image' as const,
        mediaType: f.type,
        base64: dataUrl.replace(/^data:[^;]+;base64,/, ''),
      };
    });
  }

  // .txt / .md / text/plain — read as text directly.
  if (f.type === 'text/plain' || /\.(txt|md)$/i.test(f.name)) {
    return new Promise((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = typeof reader.result === 'string' ? reader.result : '';
          resolve({
            ...baseMeta,
            kind: 'text' as const,
            textContent: raw.length > NCB_TEXT_CHAR_LIMIT ? raw.slice(0, NCB_TEXT_CHAR_LIMIT) + '\n\n[Content truncated]' : raw,
          });
        };
        reader.onerror = () => resolve(null);
        reader.readAsText(f);
      } catch {
        resolve(null);
      }
    });
  }

  // PDF — pdfjsLib + the same page/char limits the existing chatbot uses.
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
    return extractPdfText(f).then(async (text) => {
      // A scanned/image-only PDF extracts to (nearly) nothing. Before this
      // check an empty textContent fell through buildApiMessages' binary
      // branch and the AI told the user it "can't view binary files".
      const contentChars = text.startsWith('(could not extract')
        ? 0
        : text.replace(/--- Page \d+ ---/g, '').replace(/\s+/g, '').length;
      if (contentChars >= 40) {
        return { ...baseMeta, kind: 'text' as const, textContent: text };
      }
      const pageImages = await renderPdfPagesAsImages(f, NCB_PDF_IMAGE_PAGE_LIMIT);
      if (pageImages.length) {
        return { ...baseMeta, kind: 'text' as const, textContent: '', pageImages };
      }
      return {
        ...baseMeta,
        kind: 'text' as const,
        textContent: '(could not extract text from this PDF)',
      };
    });
  }

  // Anything else — store as binary stub so the user sees the chip but the AI
  // gets an honest "couldn't read" hint.
  return Promise.resolve({ ...baseMeta, kind: 'binary' as const });
}

function extractPdfText(f: File): Promise<string> {
  const ensurePdf = (window as unknown as { _ssEnsurePdfJs?: () => Promise<void> })._ssEnsurePdfJs;
  const ensure = typeof ensurePdf === 'function' ? ensurePdf() : Promise.resolve();
  return ensure
    .then(
      () =>
        new Promise<ArrayBuffer | null>((resolve) => {
          try {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => resolve(null);
            reader.readAsArrayBuffer(f);
          } catch {
            resolve(null);
          }
        })
    )
    .then(async (buf) => {
      const pdfjs = (window as unknown as {
        pdfjsLib?: {
          getDocument: (o: unknown) => { promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
              getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
            }>;
          }> };
        };
      }).pdfjsLib;
      if (!buf || !pdfjs) return '(could not extract text from this PDF)';
      try {
        const pdf = await pdfjs.getDocument({
          data: new Uint8Array(buf),
          cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
          cMapPacked: true,
        }).promise;
        const pages = Math.min(pdf.numPages, NCB_PDF_PAGE_LIMIT);
        const out: string[] = [];
        for (let p = 1; p <= pages; p++) {
          const page = await pdf.getPage(p);
          const tc = await page.getTextContent();
          const str = tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
          if (str) out.push('--- Page ' + p + ' ---\n' + str);
        }
        let full = out.join('\n\n');
        const truncated = full.length > NCB_TEXT_CHAR_LIMIT;
        if (truncated) full = full.slice(0, NCB_TEXT_CHAR_LIMIT);
        return full + (truncated ? '\n\n[Content truncated — document is very large]' : '');
      } catch {
        return '(could not extract text from this PDF)';
      }
    });
}

/** Render the first pages of a PDF to JPEGs — the fallback for scanned PDFs
 *  whose text layer is empty, so the model reads the pages visually instead
 *  of being told the file is unreadable. */
function renderPdfPagesAsImages(
  f: File,
  maxPages: number
): Promise<Array<{ mediaType: string; base64: string }>> {
  const ensurePdf = (window as unknown as { _ssEnsurePdfJs?: () => Promise<void> })._ssEnsurePdfJs;
  const ensure = typeof ensurePdf === 'function' ? ensurePdf() : Promise.resolve();
  return ensure
    .then(
      () =>
        new Promise<ArrayBuffer | null>((resolve) => {
          try {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => resolve(null);
            reader.readAsArrayBuffer(f);
          } catch {
            resolve(null);
          }
        })
    )
    .then(async (buf) => {
      const pdfjs = (window as unknown as {
        pdfjsLib?: {
          getDocument: (o: unknown) => { promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
              getViewport: (o: { scale: number }) => { width: number; height: number };
              render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
            }>;
          }> };
        };
      }).pdfjsLib;
      if (!buf || !pdfjs) return [];
      try {
        const pdf = await pdfjs.getDocument({
          data: new Uint8Array(buf),
          cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
          cMapPacked: true,
        }).promise;
        const pages = Math.min(pdf.numPages, maxPages);
        const out: Array<{ mediaType: string; base64: string }> = [];
        for (let p = 1; p <= pages; p++) {
          const page = await pdf.getPage(p);
          const base = page.getViewport({ scale: 1 });
          // ~1280px wide is plenty for the model to read a scanned page while
          // keeping each JPEG small enough for the /api/ai payload.
          const scale = Math.min(2, 1280 / Math.max(base.width, 1));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
          if (base64) out.push({ mediaType: 'image/jpeg', base64 });
        }
        return out;
      } catch {
        return [];
      }
    });
}

function renderFilesRow(root: HTMLElement, state: ConversationState): void {
  const row = root.querySelector<HTMLElement>('.ncb-files-row');
  if (!row) return;
  if (!state.files.length) {
    row.hidden = true;
    row.innerHTML = '';
    return;
  }
  row.hidden = false;
  row.innerHTML = state.files
    .map((f) => {
      const icon =
        f.kind === 'image'
          ? '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="10" cy="13" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>'
          : '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>';
      const kindLabel = f.kind === 'image' ? 'Image' : f.kind === 'text' ? 'Document' : 'File';
      return `
        <span class="ncb-file-chip" data-id="${escapeAttr(f.id)}" title="${escapeAttr(f.name)}">
          <span class="ncb-file-chip-icon">
            <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
          </span>
          <span class="ncb-file-chip-text">
            <span class="ncb-file-chip-name">${escapeHtml(f.name)}</span>
            <span class="ncb-file-chip-kind">${kindLabel}</span>
          </span>
          <button type="button" class="ncb-file-chip-x" aria-label="Remove ${escapeAttr(f.name)}">
            <svg class="ncb-icon ncb-icon--xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </span>
      `;
    })
    .join('');

  row.querySelectorAll<HTMLButtonElement>('.ncb-file-chip-x').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.closest<HTMLElement>('.ncb-file-chip')?.dataset.id;
      if (!id) return;
      state.files = state.files.filter((x) => x.id !== id);
      renderFilesRow(root, state);
    });
  });
}

// Override the PR-04 stub with a real implementation.
function regenerateLastReal(aiRow: HTMLElement, root: HTMLElement): void {
  const msgs = root.querySelector<HTMLElement>('.ncb-msgs');
  const sendBtn = root.querySelector<HTMLButtonElement>('.ncb-send-btn');
  if (!msgs || !sendBtn) return;

  const state = liveState;
  if (!state || state.isSending) return;

  // Drop the trailing assistant message from the active chat.
  const last = state.messages[state.messages.length - 1];
  if (!last || last.role !== 'assistant') return;
  state.messages.pop();
  touchActiveChat();
  saveChatStore();

  // Remove the corresponding DOM row (the bubble the user clicked Regenerate on).
  aiRow.remove();

  void streamAiReply(state, sendBtn, msgs);
}

// ============ Context panel collapse ============

const NCB_CTX_KEY = 'ss_ncb_context_open';

function initContextCollapse(root: HTMLElement): void {
  const card = root.querySelector<HTMLElement>('.ncb-card');
  const closeBtn = root.querySelector<HTMLButtonElement>('.ncb-context-close-btn');
  const openBtn = root.querySelector<HTMLButtonElement>('.ncb-panel-open-btn');
  if (!card || !closeBtn || !openBtn) return;
  if (card.dataset.ncbCtxBound === '1') return;
  card.dataset.ncbCtxBound = '1';

  // Viewport-aware default: small screens (≤1024) default to closed since
  // the panel becomes an overlay sheet at that width. User toggle wins
  // forever after via NCB_CTX_KEY.
  let open = true;
  try {
    const isCompact = !!(window.matchMedia && window.matchMedia('(max-width: 1024px)').matches);
    const raw = localStorage.getItem(NCB_CTX_KEY);
    if (!isCompact) open = true;
    else if (raw === '0') open = false;
    else if (raw === '1') open = true;
    else {
      open = false;
    }
  } catch {
    // ignore — default to open
  }
  apply(open);

  closeBtn.addEventListener('click', () => apply(false));
  openBtn.addEventListener('click', () => apply(true));

  function apply(isOpen: boolean): void {
    card!.dataset.contextOpen = isOpen ? 'true' : 'false';
    openBtn!.hidden = isOpen;
    try {
      localStorage.setItem(NCB_CTX_KEY, isOpen ? '1' : '0');
    } catch {
      // ignore
    }
  }
}

// Toggle body.ncb-fullbleed whenever #psec-aipage is visible. Watches the
// section's style attribute so we react to portal route changes without
// touching the portal navigation code.

let _ncbFullbleedBound = false;
function initFullbleed(): void {
  if (_ncbFullbleedBound) return;
  const section = document.getElementById('psec-aipage');
  if (!section) return;
  _ncbFullbleedBound = true;

  const apply = (): void => {
    const visible = section.style.display !== 'none' && section.offsetParent !== null;
    document.body.classList.toggle('ncb-fullbleed', visible);
  };
  apply();
  try {
    new MutationObserver(apply).observe(section, { attributes: true, attributeFilter: ['style'] });
  } catch {
    // older browsers without MutationObserver — fullbleed just won't toggle
  }
}

// ============ PR-08: AI tools (Quiz me / Flashcards / Summary / Export) ============

const NCB_TOOL_PROMPTS: Record<string, string> = {
  quiz:
    'Generate a 5-question quiz based on the material we have discussed in this conversation and any attached files. Mix difficulty levels. Show questions first, then the answers in a separate section at the bottom.',
  flashcards:
    'Create 10 concise flashcards from our conversation and attached materials. Format each as **Q:** ... / **A:** ...',
  summary:
    'Summarize our conversation so far in clear bullet points: the key concepts covered, important formulas or definitions, and any open questions.',
};

function initAiTools(root: HTMLElement): void {
  const buttons = root.querySelectorAll<HTMLButtonElement>('.ncb-tool-btn');
  if (!buttons.length || buttons[0]?.dataset.ncbBound === '1') return;
  buttons.forEach((btn) => {
    btn.dataset.ncbBound = '1';
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool || '';
      if (tool === 'export') exportActiveChat(btn);
      else runToolPrompt(root, tool, btn);
    });
  });
}

function runToolPrompt(root: HTMLElement, tool: string, btn: HTMLElement): void {
  const prompt = NCB_TOOL_PROMPTS[tool];
  if (!prompt) return;

  const stage = root.querySelector<HTMLElement>('.ncb-empty');
  const sendBtn = root.querySelector<HTMLButtonElement>('.ncb-send-btn');
  const msgs = root.querySelector<HTMLElement>('.ncb-msgs');
  const state = liveState;
  if (!stage || !sendBtn || !msgs || !state || state.isSending) {
    if (state?.isSending) flashAck(btn, tStr('cb_act_busy', 'Busy'));
    return;
  }

  if (stage.dataset.state !== 'active') stage.dataset.state = 'active';

  state.messages.push({ role: 'user', text: prompt, images: [], files: [] });
  appendUserBubble(msgs, prompt, [], []);
  touchActiveChat();
  saveChatStore();

  void streamAiReply(state, sendBtn, msgs);
}

function exportActiveChat(btn: HTMLElement): void {
  const chat = chatStore.getActive();
  if (!chat.messages.length) {
    flashAck(btn, tStr('cb_act_nothing_export', 'Nothing to export'));
    return;
  }
  const lines: string[] = [`# ${chat.title}`, ''];
  chat.messages.forEach((m) => {
    if (m.role === 'user') {
      lines.push('## You');
      if (m.text) lines.push(m.text);
      const fileNames = (m.files || []).map((f) => '- ' + f.name);
      if (fileNames.length) lines.push('', '**Attached files:**', ...fileNames);
      if ((m.images || []).length) lines.push('', `_(${m.images!.length} pasted image(s))_`);
    } else {
      lines.push('## Minallo AI');
      if (m.text) lines.push(m.text);
    }
    lines.push('');
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeTitle = (chat.title || 'chat').replace(/[^a-z0-9-_ ]/gi, '_').slice(0, 64);
  a.href = url;
  a.download = safeTitle + '.md';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flashAck(btn, tStr('cb_act_exported', 'Exported'));
}

// ============ PR-10: chat-row menu, rename, delete, pin, clear-all ============

let _ncbMenuEl: HTMLElement | null = null;

function ensureMenuEl(): HTMLElement {
  if (_ncbMenuEl) return _ncbMenuEl;
  const el = document.createElement('div');
  el.className = 'ncb-row-menu';
  el.hidden = true;
  document.body.appendChild(el);
  document.addEventListener('click', (ev) => {
    if (!_ncbMenuEl || _ncbMenuEl.hidden) return;
    const t = ev.target as Node | null;
    if (t && (_ncbMenuEl === t || _ncbMenuEl.contains(t))) return;
    closeChatRowMenu();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeChatRowMenu();
  });
  _ncbMenuEl = el;
  return el;
}

function closeChatRowMenu(): void {
  if (_ncbMenuEl) _ncbMenuEl.hidden = true;
}

function openChatRowMenu(root: HTMLElement, chatId: string, anchor: HTMLElement): void {
  const chat = chatStore.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const menu = ensureMenuEl();
  menu.innerHTML = `
    <button type="button" class="ncb-row-menu-item" data-act="pin">${escapeHtml(chat.pinned ? tStr('cb_menu_unpin', 'Unpin') : tStr('cb_menu_pin', 'Pin'))}</button>
    <button type="button" class="ncb-row-menu-item" data-act="rename">${escapeHtml(tStr('cb_menu_rename', 'Rename'))}</button>
    <button type="button" class="ncb-row-menu-item ncb-row-menu-item--danger" data-act="delete">${escapeHtml(tStr('cb_menu_delete', 'Delete'))}</button>
  `;
  // Position below the anchor, right-aligned to its right edge.
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 4) + 'px';
  menu.style.left = Math.round(Math.max(8, r.right - 160)) + 'px';
  menu.hidden = false;

  menu.querySelectorAll<HTMLButtonElement>('.ncb-row-menu-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      closeChatRowMenu();
      if (act === 'pin') togglePin(root, chatId);
      else if (act === 'rename') beginRename(root, chatId);
      else if (act === 'delete') deleteChat(root, chatId);
    });
  });
}

function togglePin(root: HTMLElement, chatId: string): void {
  const chat = chatStore.chats.find((c) => c.id === chatId);
  if (!chat) return;
  chat.pinned = !chat.pinned;
  chat.updatedAt = Date.now();
  saveChatStore();
  renderSidebar(root);
}

function beginRename(root: HTMLElement, chatId: string): void {
  const row = root.querySelector<HTMLElement>(`.ncb-chat-item[data-chat-id="${cssEscape(chatId)}"]`);
  const titleEl = row?.querySelector<HTMLElement>('.ncb-chat-title');
  if (!row || !titleEl) return;
  const chat = chatStore.chats.find((c) => c.id === chatId);
  if (!chat) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = chat.title;
  input.className = 'ncb-chat-rename-input';
  input.setAttribute('aria-label', tStr('cb_rename_chat_aria', 'Rename chat'));
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = (save: boolean): void => {
    if (committed) return;
    committed = true;
    const next = input.value.trim();
    if (save && next && next !== chat.title) {
      chat.title = next;
      chat.updatedAt = Date.now();
      saveChatStore();
      // If this is the active chat, the header title needs to sync too.
      if (chat.id === chatStore.activeId) {
        const hdr = root.querySelector<HTMLElement>('.ncb-chat-header-title');
        if (hdr) hdr.textContent = next;
      }
    }
    renderSidebar(root);
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    ev.stopPropagation();
  });
  input.addEventListener('click', (ev) => ev.stopPropagation());
  input.addEventListener('blur', () => commit(true));
}

function deleteChat(root: HTMLElement, chatId: string): void {
  const chat = chatStore.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const isDe = (localStorage.getItem('ss_lang') || 'en') === 'de';
  const ok = window.confirm(
    isDe
      ? `Chat „${chat.title}“ löschen? Das kann nicht rückgängig gemacht werden.`
      : `Delete "${chat.title}"? This can't be undone.`
  );
  if (!ok) return;
  const wasActive = chat.id === chatStore.activeId;
  chatStore.chats = chatStore.chats.filter((c) => c.id !== chatId);
  if (!chatStore.chats.length) chatStore.newChat();
  if (wasActive) chatStore.activeId = chatStore.chats[0]!.id;
  saveChatStore();
  renderSidebar(root);
  if (wasActive) loadActiveChatIntoCenter(root);
}

function cssEscape(s: string): string {
  // CSS.escape isn't in older TS lib types; fall back to a regex.
  const css = (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (css?.escape) return css.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

// ---- Clear-all-chats ----

function initClearAll(root: HTMLElement): void {
  const sidebar = root.querySelector<HTMLElement>('.ncb-sidebar');
  if (!sidebar || sidebar.querySelector('.ncb-clear-all')) return;

  // Inject the clear-all button just before the safe-card.
  const safe = sidebar.querySelector<HTMLElement>('.ncb-safe-card');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ncb-clear-all';
  btn.innerHTML = `
    <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    <span>${escapeHtml(tStr('cb_clear_all', 'Clear all chats'))}</span>
  `;
  btn.addEventListener('click', () => {
    const ok = window.confirm(tStr('cb_clear_all_confirm', "Delete every chat in the sidebar? This can't be undone."));
    if (!ok) return;
    chatStore.chats = [];
    const fresh = chatStore.newChat();
    chatStore.activeId = fresh.id;
    saveChatStore();
    renderSidebar(root);
    loadActiveChatIntoCenter(root);
  });
  if (safe) sidebar.insertBefore(btn, safe);
  else sidebar.appendChild(btn);
}

// ---- Textarea auto-resize ----

function initTextareaAutoSize(root: HTMLElement): void {
  const ta = root.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
  if (!ta || ta.dataset.ncbAutoSize === '1') return;
  ta.dataset.ncbAutoSize = '1';
  // MIN must be slightly above what scrollHeight reports for a single
  // line (one baseline + textarea padding) — otherwise the first
  // keystroke pushes scrollHeight from N → N+1 (subpixel rounding) and
  // the composer visibly grows by 1–2px. Clamping at 36 keeps the
  // composer stable for one-line input.
  const MIN = 36;
  const MAX = 160;
  const resize = (): void => {
    ta.style.height = 'auto';
    const next = Math.max(MIN, Math.min(MAX, ta.scrollHeight));
    ta.style.height = next + 'px';
    ta.style.overflowY = ta.scrollHeight > MAX ? 'auto' : 'hidden';
  };
  ta.addEventListener('input', resize);
  // Reset on send (textarea is cleared by doSend) — observe the value change
  // via a MutationObserver on the value-set side isn't reliable, so we hook
  // a paste/cut/blur for good measure.
  ta.addEventListener('blur', resize);
  resize();
}

// ---- Error retry ----

/** True when a failed AI request is the subscription gate (HTTP 402 or a
 * "subscription required" body) rather than a real outage. We branch on this
 * so new users see a calm upgrade prompt, not a raw server error. */
function isSubscriptionError(err: unknown): boolean {
  const msg = (err as Error)?.message || String(err || '');
  return /\b402\b/.test(msg) || /subscription/i.test(msg);
}

/** Subscription-gate affordance: jumps to the Subscription page. Replaces the
 * Retry button, since retrying a 402 would just fail again. Reuses the retry
 * button styling so no extra CSS is needed. */
function attachSubscribeCta(aiRow: HTMLElement, bubble: HTMLElement | null): void {
  if (!bubble) return;
  if (aiRow.querySelector('.ncb-retry-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ncb-retry-btn';
  btn.innerHTML = '<span>' + escapeHtml(tStr('cb_view_plans', 'View plans')) + '</span>';
  btn.addEventListener('click', () => {
    document.getElementById('psbSubscription')?.click();
  });
  bubble.appendChild(btn);
}

function attachErrorRetry(aiRow: HTMLElement, bubble: HTMLElement | null): void {
  if (!bubble) return;
  const existing = aiRow.querySelector('.ncb-retry-btn');
  if (existing) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ncb-retry-btn';
  btn.innerHTML = `
    <svg class="ncb-icon ncb-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
    <span>Retry</span>
  `;
  btn.addEventListener('click', () => {
    const root = aiRow.closest<HTMLElement>('.ncb-root');
    if (!root) return;
    const msgs = root.querySelector<HTMLElement>('.ncb-msgs');
    const sendBtn = root.querySelector<HTMLButtonElement>('.ncb-send-btn');
    const state = liveState;
    if (!msgs || !sendBtn || !state || state.isSending) return;
    aiRow.remove();
    void streamAiReply(state, sendBtn, msgs);
  });
  bubble.appendChild(btn);
}

// ---- Course folder hydration ----

function eagerlyHydrateCourses(onProgress?: (course: SemCourse) => void): Promise<void> {
  const sems = getSems();
  const w = window as unknown as {
    _ufMerge?: (course: SemCourse) => unknown;
    listUserFolders?: (course: SemCourse) => unknown;
  };
  const trigger = w._ufMerge || w.listUserFolders;
  if (!trigger) return Promise.resolve();
  const promises: Promise<void>[] = [];
  Object.values(sems).forEach((sem) => {
    (sem.courses || []).forEach((c) => {
      const empty = !c.userFolders || c.userFolders.length === 0;
      if (empty && c.id) {
        try {
          const r = trigger(c);
          const p = Promise.resolve(r as unknown)
            .then(() => { try { onProgress?.(c); } catch { /* ignore */ } })
            .catch(() => { /* tolerate per-course failure */ });
          promises.push(p);
        } catch { /* tolerate per-course failure */ }
      }
    });
  });
  return Promise.all(promises).then(() => undefined);
}

// ---- Empty-state action cards ----
// Each card carries a data-prefill starter prompt. Clicking drops the prompt
// into the textarea, focuses it, and (if the prompt ends with ": ") parks the
// caret at the end so the user can keep typing.
function initActionCards(root: HTMLElement): void {
  if (root.dataset.ncbActionsBound === '1') return;
  root.dataset.ncbActionsBound = '1';
  const cards = root.querySelectorAll<HTMLButtonElement>('.ncb-action-card[data-prefill]');
  cards.forEach((card) => {
    card.addEventListener('click', (ev) => {
      ev.preventDefault();
      const prefill = card.dataset.prefill || '';
      if (!prefill) return;
      const ta = root.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
      if (!ta) return;
      ta.value = prefill;
      // Resize manually right here so the textarea is the right size
      // before scroll / focus. Dispatching 'input' alone sometimes fires
      // the listener before the browser has re-laid out for the new
      // value, leaving the textarea capped at its previous height.
      ta.style.height = 'auto';
      const next = Math.max(36, Math.min(160, ta.scrollHeight));
      ta.style.height = next + 'px';
      ta.style.overflowY = ta.scrollHeight > 160 ? 'auto' : 'hidden';
      ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.requestAnimationFrame(() => {
        ta.focus();
        const end = ta.value.length;
        try { ta.setSelectionRange(end, end); } catch { /* old browsers */ }
      });
    });
  });
}

// ---- Keyboard shortcuts ----

function initKeyboardShortcuts(root: HTMLElement): void {
  if (root.dataset.ncbKbBound === '1') return;
  root.dataset.ncbKbBound = '1';
  document.addEventListener('keydown', (ev) => {
    if (root.hidden || root.offsetParent === null) return;
    const meta = ev.metaKey || ev.ctrlKey;
    if (!meta) return;

    // Cmd/Ctrl+K → new chat (and focus the input)
    if (ev.key === 'k' || ev.key === 'K') {
      ev.preventDefault();
      const newBtn = root.querySelector<HTMLButtonElement>('.ncb-new-chat-btn');
      newBtn?.click();
      const ta = root.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
      ta?.focus();
      return;
    }
    // Cmd/Ctrl+/ → focus the input
    if (ev.key === '/') {
      ev.preventDefault();
      const ta = root.querySelector<HTMLTextAreaElement>('.ncb-input-textarea');
      ta?.focus();
    }
  });
}

(window as unknown as { initNewChatbotShell?: () => void }).initNewChatbotShell = initNewChatbotShell;
