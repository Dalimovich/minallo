// Minallo document side rail + drawer.
//
// Task-01 wired the shell (rail + empty drawer + resize + route guard).
// Task-02 mounts real working content per mode by HOSTING the existing
// legacy panels inside the drawer rather than reimplementing them:
//   - AI mode:     host #aiPanel    (chat history, composer, chips, send)
//   - Notes mode:  host #pdfNotesPanel and force its tabs to Notes|Saved
//   - Summary mode: host #pdfNotesPanel and force its tabs to Summary|Saved
//
// This keeps the original send / generate / save / load flows untouched
// (we drive them via DOM simulation on the same buttons the legacy
// toolbar callers use) and avoids parallel implementations.

export type DocRailRoute = 'pdf' | 'courses' | 'other';
export type DocRailMode = 'ai' | 'problem' | 'notes' | 'summary';

interface NotesPanelApi {
  open: () => void;
  close: () => void;
  delete?: () => void;
  ctx?: () => unknown;
  ensure?: () => void;
}

interface DocRailWindow extends Window {
  __minalloDocRail?: {
    setRouteVisibility: (route: DocRailRoute) => void;
    open: (mode: DocRailMode) => void;
    close: () => void;
    currentMode: () => DocRailMode | null;
  };
  openAI?: () => void;
  askAI?: (
    prompt: string,
    skipUserBubble?: boolean,
    opts?: {
      forceRefresh?: boolean;
      problemSolver?: {
        mode: string;
        problem: string;
        studentWork?: string;
      };
    }
  ) => unknown;
  _notesPanel?: NotesPanelApi;
  _ssLoadPortalFeature?: (name: string) => Promise<void>;
  _ssSyncUrl?: () => void;
}

const WIDTH_KEY = 'ss_dr_width';
const WIDTH_MIN = 340;
const WIDTH_MIN_MAXIMIZED = 390;
const WIDTH_MAX = 900;
const WIDTH_DEFAULT = 520;
const SPLIT_CLASS = 'dr-pdf-split-open';

let _initialized = false;
let _openMode: DocRailMode | null = null;
let _route: DocRailRoute = 'other';
let _drawerWidth = WIDTH_DEFAULT;

// Snapshot of the last Problem Solver submission so we can:
//   * restore form fields when the user clicks the strip to return,
//   * render the collapsed strip at the top of the AI panel while the
//     answer is being read.
// Persists until cleared via the Problem mode trash button.
interface ProblemSubmission {
  mode: string;
  problem: string;
  work: string;
}
let _lastProblemSubmission: ProblemSubmission | null = null;
const PROBLEM_MODE_LABELS: Record<string, string> = {
  hint: 'Hint ladder',
  setup: 'Set up equations',
  check: 'Check my work',
  solve: 'Full solution',
  practice: 'Generate similar practice',
};

// Track original parents/styles so we can restore the legacy panels on close.
let _aiHomeParent: HTMLElement | null = null;
let _notesHomeParent: HTMLElement | null = null;

function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return WIDTH_DEFAULT;
  const min = document.body.classList.contains('pdf-maximized') ? WIDTH_MIN_MAXIMIZED : WIDTH_MIN;
  return Math.max(min, Math.min(WIDTH_MAX, Math.round(w)));
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw == null) return WIDTH_DEFAULT;
    const n = parseFloat(raw);
    return clampWidth(n);
  } catch {
    return WIDTH_DEFAULT;
  }
}

function saveWidth(w: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    /* ignore */
  }
}

const HEADER_COPY: Record<DocRailMode, { title: string; subtitle: string }> = {
  ai: { title: 'AI', subtitle: 'Ask this document' },
  problem: { title: 'Problem', subtitle: 'Solve engineering exercises' },
  notes: { title: 'Notes', subtitle: 'AI-generated notes from this PDF' },
  summary: { title: 'Summary', subtitle: 'AI-generated summary of this PDF' },
};

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function applyHeader(mode: DocRailMode): void {
  const titleEl = $('drTitle');
  const subEl = $('drSubtitle');
  const copy = HEADER_COPY[mode];
  if (titleEl) titleEl.textContent = copy.title;
  if (subEl) subEl.textContent = copy.subtitle;
}

function updateRailActive(mode: DocRailMode | null): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.dr-rail-btn');
  buttons.forEach((b) => {
    const m = b.dataset.drMode as DocRailMode | undefined;
    b.classList.toggle('is-active', !!m && m === mode);
    b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
  });
}

function applyWidth(drawer: HTMLElement, w: number): void {
  const px = w + 'px';
  drawer.style.setProperty('width', px, 'important');
  drawer.style.setProperty('flex-basis', px);
}

function setDrawerWidthVar(w: number): void {
  const value = clampWidth(w) + 'px';
  const root = $('drRoot');
  if (root) root.style.setProperty('--dr-drawer-w', value);
  document.body.style.setProperty('--dr-drawer-w', value);
}

function clearSplitState(): void {
  const root = $('drRoot');
  if (root) {
    root.classList.remove('is-open');
    root.style.removeProperty('--dr-drawer-w');
  }
  document.body.classList.remove(SPLIT_CLASS);
  document.body.style.removeProperty('--dr-drawer-w');
  const drawer = $('drDrawer');
  if (drawer && root && drawer.parentElement !== root) {
    drawer.classList.remove('dr-inline-split');
    root.appendChild(drawer);
  }
}

function applySplitState(drawer?: HTMLElement | null): void {
  const root = $('drRoot');
  if (!root) return;
  const isSheet = !!drawer?.classList.contains('dr-sheet');
  const shouldSplit = (_route === 'pdf' || _route === 'courses') && _openMode != null && !isSheet;
  root.classList.toggle('is-open', shouldSplit);
  document.body.classList.toggle(SPLIT_CLASS, shouldSplit);
  if (shouldSplit) {
    setDrawerWidthVar(_drawerWidth);
    const appBody = document.querySelector('.app-body') as HTMLElement | null;
    if (drawer && appBody && drawer.parentElement !== appBody) {
      drawer.classList.add('dr-inline-split');
      appBody.appendChild(drawer);
    }
  } else {
    root.style.removeProperty('--dr-drawer-w');
    document.body.style.removeProperty('--dr-drawer-w');
    if (drawer && root && drawer.parentElement !== root) {
      drawer.classList.remove('dr-inline-split');
      root.appendChild(drawer);
    }
  }
}

function isDesktopDrawerOpen(drawer: HTMLElement): boolean {
  return drawer.classList.contains('is-open') && !drawer.classList.contains('dr-sheet');
}

function updateDrawerModeClass(drawer: HTMLElement, mode: DocRailMode | null): void {
  drawer.classList.remove('dr-mode-ai', 'dr-mode-problem', 'dr-mode-notes', 'dr-mode-summary');
  if (mode) drawer.classList.add('dr-mode-' + mode);
}

// ── Trash button label/state per mode ────────────────────────────────────
function configureTrash(mode: DocRailMode): void {
  const trash = $('drTrash') as HTMLButtonElement | null;
  if (!trash) return;
  // Clear previous handler.
  trash.onclick = null;
  trash.disabled = false;
  trash.removeAttribute('aria-disabled');
  if (mode === 'ai') {
    trash.title = 'Clear chat';
    trash.setAttribute('aria-label', 'Clear chat');
    trash.onclick = () => {
      const btn = document.getElementById('aiClearBtn') as HTMLButtonElement | null;
      if (btn) btn.click();
      // The Problem Solver strip lives in the AI content area; once the
      // chat is cleared it's pointing at a context that no longer exists.
      _lastProblemSubmission = null;
      document.querySelector('.dr-problem-strip')?.remove();
    };
  } else if (mode === 'problem') {
    trash.title = 'Clear problem';
    trash.setAttribute('aria-label', 'Clear problem');
    trash.onclick = () => {
      const form = document.getElementById('drProblemForm') as HTMLFormElement | null;
      if (form) form.reset();
      document.querySelectorAll<HTMLButtonElement>('.dr-problem-mode').forEach((btn, idx) => {
        const active = idx === 0;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      // Also drop the snapshot so the AI-mode strip doesn't reappear
      // with stale content next time the AI panel mounts.
      _lastProblemSubmission = null;
    };
  } else {
    // Notes / Summary — delete the currently-loaded note for this tab.
    trash.title = 'Delete current note';
    trash.setAttribute('aria-label', 'Delete current note');
    const np = (window as DocRailWindow)._notesPanel;
    if (np && typeof np.delete === 'function') {
      trash.onclick = () => np.delete!();
    } else {
      trash.disabled = true;
      trash.setAttribute('aria-disabled', 'true');
      trash.title = 'Coming soon';
    }
  }
}

function getSelectedText(): string {
  try {
    return window.getSelection()?.toString().trim() || '';
  } catch {
    return '';
  }
}

function buildProblemChatText(mode: string, problem: string, work: string): string {
  // Short chat-bubble text. The full problem + studentWork ride along as
  // structured fields in `problemSolver`, so the backend assembles the
  // canonical PROBLEM SOLVER INPUT block and doesn't need a second copy
  // here. Keep a short preview so the user can recognise the entry in
  // their chat history without scrolling back to the Problem panel.
  const flatProblem = problem.replace(/\s+/g, ' ').trim();
  const preview = flatProblem.length > 120 ? flatProblem.slice(0, 117) + '...' : flatProblem;
  const workTag = work.trim() ? ' (with work attached)' : '';
  return 'Problem Solver — ' + (PROBLEM_MODE_LABELS[mode] || mode) + workTag + '\n\n> ' + preview;
}

function renderProblemStrip(content: HTMLElement): void {
  if (!_lastProblemSubmission) return;
  // Idempotent — bail if the strip is already in this content area.
  if (content.querySelector('.dr-problem-strip')) return;

  const sub = _lastProblemSubmission;
  const label = PROBLEM_MODE_LABELS[sub.mode] || sub.mode;
  const flat = sub.problem.replace(/\s+/g, ' ').trim();
  const preview = flat.length > 70 ? flat.slice(0, 67) + '...' : flat;

  const strip = document.createElement('button');
  strip.type = 'button';
  strip.className = 'dr-problem-strip';
  strip.setAttribute('aria-label', 'Edit Problem Solver inputs');
  strip.title = 'Click to edit the Problem Solver inputs';

  const tag = document.createElement('span');
  tag.className = 'dr-problem-strip-tag';
  tag.textContent = 'Problem Solver — ' + label;
  const previewEl = document.createElement('span');
  previewEl.className = 'dr-problem-strip-preview';
  previewEl.textContent = preview;
  const action = document.createElement('span');
  action.className = 'dr-problem-strip-action';
  action.textContent = 'Edit';

  strip.appendChild(tag);
  strip.appendChild(previewEl);
  strip.appendChild(action);
  strip.addEventListener('click', () => openDrawer('problem'));

  content.insertBefore(strip, content.firstChild);
}

function mountProblemPanel(): void {
  const content = getContentEl();
  if (!content) return;
  content.innerHTML =
    '<form id="drProblemForm" class="dr-problem">' +
      '<div class="dr-problem-hero">' +
        '<div class="dr-problem-kicker">Engineering workflow</div>' +
        '<h2>Turn a problem into a clean solution path.</h2>' +
        '<p>Paste the exercise, add your attempt if you have one, then send it to the AI tutor with the right solving mode.</p>' +
      '</div>' +
      '<div class="dr-problem-modes" role="group" aria-label="Problem solver mode">' +
        '<button type="button" class="dr-problem-mode is-active" data-mode="hint" aria-pressed="true">Hint</button>' +
        '<button type="button" class="dr-problem-mode" data-mode="setup" aria-pressed="false">Setup</button>' +
        '<button type="button" class="dr-problem-mode" data-mode="check" aria-pressed="false">Check</button>' +
        '<button type="button" class="dr-problem-mode" data-mode="solve" aria-pressed="false">Solve</button>' +
        '<button type="button" class="dr-problem-mode" data-mode="practice" aria-pressed="false">Practice</button>' +
      '</div>' +
      '<label class="dr-problem-field">' +
        '<span>Problem statement</span>' +
        '<textarea id="drProblemText" rows="8" placeholder="Paste the exercise, task, or selected PDF text here"></textarea>' +
      '</label>' +
      '<label class="dr-problem-field">' +
        '<span>Your work optional</span>' +
        '<textarea id="drProblemWork" rows="4" placeholder="Paste your equations or partial solution if you want it checked"></textarea>' +
      '</label>' +
      '<div class="dr-problem-actions">' +
        '<button type="button" class="dr-problem-secondary" id="drProblemUseSelection">Use selection</button>' +
        '<button type="submit" class="dr-problem-primary">Send to AI</button>' +
      '</div>' +
      '<p class="dr-problem-foot">Tip: select text in the PDF first, then use selection.</p>' +
    '</form>';

  content.querySelectorAll<HTMLButtonElement>('.dr-problem-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      content.querySelectorAll<HTMLButtonElement>('.dr-problem-mode').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
  });

  const problemText = content.querySelector<HTMLTextAreaElement>('#drProblemText');
  const workText = content.querySelector<HTMLTextAreaElement>('#drProblemWork');
  content.querySelector<HTMLButtonElement>('#drProblemUseSelection')?.addEventListener('click', () => {
    const selected = getSelectedText();
    if (!selected || !problemText) return;
    problemText.value = problemText.value
      ? problemText.value.trim() + '\n\n' + selected
      : selected;
    problemText.focus();
  });

  // Restore previous submission so "Edit" from the AI-mode strip lands
  // the user back on the exact form state they sent.
  if (_lastProblemSubmission) {
    if (problemText) problemText.value = _lastProblemSubmission.problem;
    if (workText) workText.value = _lastProblemSubmission.work;
    const restoreMode = _lastProblemSubmission.mode;
    content.querySelectorAll<HTMLButtonElement>('.dr-problem-mode').forEach((btn) => {
      const active = btn.dataset.mode === restoreMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  content.querySelector<HTMLFormElement>('#drProblemForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const problem = (problemText?.value || '').trim();
    const work = (workText?.value || '').trim();
    if (!problem) {
      problemText?.focus();
      return;
    }
    const activeMode =
      content.querySelector<HTMLButtonElement>('.dr-problem-mode.is-active')?.dataset.mode || 'hint';
    const chatText = buildProblemChatText(activeMode, problem, work);
    // Snapshot the submission so the strip in AI mode + the "Edit"
    // round-trip back to Problem mode can restore the exact inputs.
    _lastProblemSubmission = { mode: activeMode, problem, work };
    const w = window as DocRailWindow;
    const send = () => {
      if (typeof w.askAI === 'function') {
        w.askAI(chatText, false, {
          problemSolver: {
            mode: activeMode,
            problem,
            studentWork: work || undefined,
          },
        });
      }
    };
    if (_openMode === 'ai') {
      // AI panel already mounted — send now, no need to wait for the
      // ready event (it won't fire because openDrawer is a no-op).
      send();
    } else {
      // Wait for mountAiPanel to finish, then send. Deterministic
      // replacement for the previous magic 80ms setTimeout.
      document.addEventListener('minallo-ai-panel-ready', send, { once: true });
      openDrawer('ai');
    }
  });
}

function applyUserTypeVisibility(): void {
  const w = window as Window & { _userType?: string };
  const problemBtn = document.querySelector<HTMLElement>('.dr-rail-btn[data-dr-mode="problem"]');
  if (problemBtn) problemBtn.style.display = w._userType === 'learner' ? 'none' : '';
  if (w._userType === 'learner' && _openMode === 'problem') closeDrawer();
}

// ── Host content area helpers ────────────────────────────────────────────
function getContentEl(): HTMLElement | null {
  const drawer = $('drDrawer');
  if (!drawer) return null;
  return drawer.querySelector('.dr-content') as HTMLElement | null;
}

function clearDrawerContent(): void {
  const content = getContentEl();
  if (!content) return;
  // Move out any hosted legacy panels before clearing innerHTML so we don't
  // destroy live DOM nodes the legacy modules still reference.
  restoreAiPanel();
  restoreNotesPanel();
  content.innerHTML = '';
}

// ── AI mode: host the legacy #aiPanel inside the drawer ──────────────────
function mountAiPanel(): void {
  const content = getContentEl();
  if (!content) return;
  const panel = document.getElementById('aiPanel') as HTMLElement | null;
  if (!panel) {
    content.innerHTML = '<div class="dr-empty">AI panel not loaded yet.</div>';
    return;
  }
  if (!_aiHomeParent) _aiHomeParent = panel.parentElement;
  // Reset any stray positioning so the panel sits flush inside the drawer.
  panel.classList.add('dr-host-ai');
  panel.style.position = 'static';
  panel.style.left = '';
  panel.style.top = '';
  panel.style.right = '';
  panel.style.bottom = '';
  panel.style.width = '100%';
  panel.style.height = '100%';
  panel.style.zIndex = '';
  panel.style.opacity = '1';
  panel.style.transform = 'none';
  panel.style.borderRadius = '0';
  panel.style.boxShadow = 'none';
  panel.style.border = 'none';
  panel.style.background = 'transparent';
  panel.style.display = 'flex';
  // Make sure the legacy bridge treats the panel as visible so renders run.
  panel.classList.add('visible');
  content.appendChild(panel);
  // If the user opened AI via the Problem Solver flow, prepend the
  // collapsed strip so the problem stays visible while they read the
  // streaming answer. Cleared via the Problem trash button.
  renderProblemStrip(content);
  // Restore chat history via existing bridge.
  const w = window as DocRailWindow & { pinAI?: () => void };
  if (typeof w.openAI === 'function') {
    try { w.openAI(); } catch (_e) { /* ignore */ }
  }
  // Pin the panel so ai-panel-bridge's mouseleave→closeAI auto-close doesn't
  // remove `.visible` (which kills input/send) when the cursor leaves the
  // drawer. The drawer has its own X / Esc / rail-toggle close paths.
  if (typeof w.pinAI === 'function') {
    try { w.pinAI(); } catch (_e) { /* ignore */ }
  }
  // Auto-focus the input after the drawer transition (~240ms).
  window.setTimeout(() => {
    const input = document.getElementById('aiInput') as HTMLTextAreaElement | null;
    if (!input) return;
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }
  }, 240);
  // Signal callers (like the Problem Solver submit flow) that the AI
  // panel is mounted and `window.askAI` can be invoked against a live
  // panel. Dispatched at the end of mountAiPanel so any listener fires
  // synchronously after DOM work completes.
  document.dispatchEvent(new CustomEvent('minallo-ai-panel-ready'));
}

function restoreAiPanel(): void {
  const panel = document.getElementById('aiPanel') as HTMLElement | null;
  if (!panel || !panel.classList.contains('dr-host-ai')) return;
  panel.classList.remove('dr-host-ai', 'visible');
  // Reset overrides so the bubble path (if ever re-enabled) still works.
  panel.style.position = '';
  panel.style.width = '';
  panel.style.height = '';
  panel.style.transform = '';
  panel.style.opacity = '';
  panel.style.borderRadius = '';
  panel.style.boxShadow = '';
  panel.style.border = '';
  panel.style.background = '';
  panel.style.display = '';
  // Park it back on document.body, collapsed (CSS width:0) until the next open.
  // We don't try to put it back inside #pdfViewerWrap because that container
  // may have been swapped out by route navigation.
  if (panel.parentElement !== document.body) {
    document.body.appendChild(panel);
  }
}

// ── Notes / Summary mode: host the legacy #pdfNotesPanel ─────────────────
function ensureNotesPanel(): HTMLElement | null {
  let panel = document.getElementById('pdfNotesPanel') as HTMLElement | null;
  if (panel) return panel;
  // The legacy module exposes ensure() which reads window.activeCourseId /
  // window.activeFileName, calls _createPanel + _injectToolbarButton, and
  // resolves the documentId. open() alone is not enough — it bails when
  // #pdfNotesPanel doesn't exist yet, and the one-shot 500ms init timer in
  // notes-panel.js can miss in some PDF-open flows.
  const w = window as DocRailWindow;
  if (w._notesPanel && typeof w._notesPanel.ensure === 'function') {
    try { w._notesPanel.ensure(); } catch (_e) { /* ignore */ }
  } else if (w._notesPanel && typeof w._notesPanel.open === 'function') {
    // Fallback for older notes-panel.js without ensure().
    try { w._notesPanel.open(); } catch (_e) { /* ignore */ }
  } else if (typeof w._ssLoadPortalFeature === 'function') {
    void w._ssLoadPortalFeature('notesPanel').then(() => {
      if (_openMode === 'notes' || _openMode === 'summary') mountNotesPanel(_openMode);
    });
  }
  panel = document.getElementById('pdfNotesPanel') as HTMLElement | null;
  return panel;
}

function mountNotesPanel(mode: 'notes' | 'summary'): void {
  const content = getContentEl();
  if (!content) return;
  const panel = ensureNotesPanel();
  if (!panel) {
    content.innerHTML =
      '<div class="dr-empty">Open a PDF first to use Notes & Summary tools.</div>';
    return;
  }
  if (!_notesHomeParent) _notesHomeParent = panel.parentElement;
  // The legacy open() may have set #centreContent to .pdf-split — undo so the
  // PDF page keeps its full width while the drawer hosts the panel.
  const centre = document.getElementById('centreContent');
  if (centre) centre.classList.remove('pdf-split');
  // Reset legacy inline styles & host inside the drawer.
  panel.classList.add('dr-host-notes');
  panel.style.position = 'static';
  panel.style.display = 'flex';
  panel.style.width = '100%';
  panel.style.height = '100%';
  panel.style.left = '';
  panel.style.right = '';
  panel.style.top = '';
  panel.style.bottom = '';
  panel.style.border = 'none';
  panel.style.boxShadow = 'none';
  panel.style.background = 'transparent';
  // If the notes feature was lazy-loaded, this drawer may still contain the
  // temporary "Open a PDF first" placeholder from the first mount attempt.
  // Replace the content instead of appending so the hosted panel always starts
  // directly below the drawer header.
  content.replaceChildren(panel);
  // Switch to the relevant tab (Notes drawer → notes tab; Summary drawer →
  // summary tab). Simulating a click drives the legacy state machine
  // correctly (tabs, detail-row visibility, content render).
  const wantTab = mode === 'summary' ? 'summary' : 'notes';
  const tabBtn = panel.querySelector(
    '.np-tab[data-tab="' + wantTab + '"]'
  ) as HTMLButtonElement | null;
  if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();
  // Set a mode marker on the panel so CSS can hide the irrelevant tab.
  panel.classList.remove('dr-mode-notes', 'dr-mode-summary');
  panel.classList.add('dr-mode-' + mode);
  // Mirror the active tab as a data-attribute on the panel so CSS can
  // collapse the generation chrome (pills + Generate + preview) to just
  // the saved-list when the Saved tab is active.
  syncDrTab(panel, wantTab);
  panel.querySelectorAll<HTMLButtonElement>('.np-tab').forEach((btn) => {
    if (btn.dataset.drBound === '1') return;
    btn.dataset.drBound = '1';
    btn.addEventListener('click', () => {
      const t = btn.dataset.tab;
      if (t) syncDrTab(panel, t);
    });
  });
}

function syncDrTab(panel: HTMLElement, tab: string): void {
  panel.dataset.drTab = tab;
}

function restoreNotesPanel(): void {
  const panel = document.getElementById('pdfNotesPanel') as HTMLElement | null;
  if (!panel || !panel.classList.contains('dr-host-notes')) return;
  panel.classList.remove('dr-host-notes', 'dr-mode-notes', 'dr-mode-summary');
  panel.style.position = '';
  panel.style.display = 'none';
  panel.style.width = '';
  panel.style.height = '';
  panel.style.border = '';
  panel.style.boxShadow = '';
  panel.style.background = '';
  if (_notesHomeParent && panel.parentElement !== _notesHomeParent) {
    _notesHomeParent.appendChild(panel);
  }
}

// ── Drawer open/close/switch ─────────────────────────────────────────────
function renderModeContent(mode: DocRailMode): void {
  clearDrawerContent();
  configureTrash(mode);
  if (mode === 'ai') {
    mountAiPanel();
  } else if (mode === 'problem') {
    mountProblemPanel();
  } else {
    mountNotesPanel(mode);
  }
}

const MOBILE_MQ = '(max-width: 768px)';
function isMobileViewport(): boolean {
  try {
    return window.matchMedia(MOBILE_MQ).matches;
  } catch {
    return false;
  }
}

// Opening/closing/resizing the rail changes the PDF column width. Re-fit via CSS
// zoom (no re-render) so the page never blanks/reloads and the user's scroll
// position and text selection are preserved. renderPages() would instead do
// body.innerHTML='' — a full teardown that flashes the page, jumps scroll to the
// top and wipes any selection. Fall back to it only if the CSS re-fit helper is
// somehow unavailable.
function refitPdfToDrawer(): void {
  const w = window as unknown as { _refitPdfWidth?: () => void; renderPages?: () => void };
  if (typeof w._refitPdfWidth === 'function') {
    w._refitPdfWidth();
    return;
  }
  if (typeof w.renderPages === 'function') w.renderPages();
}

function openDrawer(mode: DocRailMode): void {
  const drawer = $('drDrawer');
  if (!drawer) return;
  const wasOpen = _openMode != null;
  _openMode = mode;
  applyHeader(mode);
  updateDrawerModeClass(drawer, mode);
  drawer.hidden = false;
  // Decide presentation mode at open time. Once open, we keep whatever
  // mode we picked even if the viewport is resized across the breakpoint.
  if (!wasOpen) {
    const sheet = isMobileViewport();
    drawer.classList.toggle('dr-sheet', sheet);
    const root = $('drRoot');
    if (root) root.classList.toggle('is-sheet-open', sheet);
  }
  void drawer.offsetWidth;
  drawer.classList.add('is-open');
  // On mobile (sheet mode) CSS forces full-width; don't apply the persisted
  // desktop width.
  if (!drawer.classList.contains('dr-sheet')) {
    applyWidth(drawer, _drawerWidth);
  }
  applySplitState(drawer);
  updateRailActive(mode);
  // Render after the slide-in starts so we don't pay the cost during the
  // transition; tiny delay also helps the input auto-focus feel natural.
  if (wasOpen) {
    // Mode switch — render immediately.
    renderModeContent(mode);
  } else {
    // First open — wait for the slide-in transition to finish so
    // the drawer's final dimensions are settled before rendering.
    const afterTransition = (): void => {
      if (_openMode === mode) renderModeContent(mode);
      refitPdfToDrawer();
    };
    let fired = false;
    const onEnd = (e: TransitionEvent): void => {
      if (e.target !== drawer) return;
      if (fired) return;
      fired = true;
      drawer.removeEventListener('transitionend', onEnd);
      afterTransition();
    };
    drawer.addEventListener('transitionend', onEnd);
    window.setTimeout(() => {
      if (!fired) {
        fired = true;
        drawer.removeEventListener('transitionend', onEnd);
        afterTransition();
      }
    }, 350);
  }
  const w2 = window as DocRailWindow;
  if (typeof w2._ssSyncUrl === 'function') w2._ssSyncUrl();
}

function closeDrawer(): void {
  const drawer = $('drDrawer');
  if (!drawer) return;
  _openMode = null;
  drawer.classList.remove('is-open');
  // Clear sheet-mode state on close so the next open re-evaluates the
  // viewport.
  const wasSheet = drawer.classList.contains('dr-sheet');
  drawer.classList.remove('dr-sheet');
  const rootEl = $('drRoot');
  if (rootEl) rootEl.classList.remove('is-sheet-open');
  if (wasSheet) {
    // Strip the inline width that JS might have left behind from a prior
    // desktop session so it doesn't leak back when the user resizes up.
    drawer.style.width = '';
  }
  updateDrawerModeClass(drawer, null);
  updateRailActive(null);
  clearSplitState();
  // Tear down hosted content so legacy modules' references stay valid.
  clearDrawerContent();
  const onEnd = (): void => {
    if (!drawer.classList.contains('is-open')) drawer.hidden = true;
    drawer.removeEventListener('transitionend', onEnd);
  };
  drawer.addEventListener('transitionend', onEnd);
  window.setTimeout(() => {
    if (!drawer.classList.contains('is-open')) drawer.hidden = true;
  }, 360);
  // Re-render PDF after the slide-out transition so the canvas expands
  // back to the full column width (deferred if the user has a live selection).
  window.setTimeout(() => {
    refitPdfToDrawer();
  }, 320);
  const w2 = window as DocRailWindow;
  if (typeof w2._ssSyncUrl === 'function') w2._ssSyncUrl();
}

function toggleMode(mode: DocRailMode): void {
  if (_openMode === mode) {
    closeDrawer();
  } else {
    openDrawer(mode);
  }
}

function wireResize(): void {
  const drawer = $('drDrawer');
  const handle = $('drResize');
  if (!drawer || !handle) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;
  let rafId = 0;
  let pendingWidth = 0;

  const onMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    pendingWidth = clampWidth(startW - dx);
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        _drawerWidth = pendingWidth;
        applyWidth(drawer, pendingWidth);
        if (document.body.classList.contains('pdf-maximized')) {
          setDrawerWidthVar(pendingWidth);
        }
      });
    }
  };

  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    _drawerWidth = pendingWidth;
    applyWidth(drawer, pendingWidth);
    if (document.body.classList.contains(SPLIT_CLASS) || isDesktopDrawerOpen(drawer)) {
      setDrawerWidthVar(pendingWidth);
    }
    handle.classList.remove('is-active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    saveWidth(_drawerWidth);
    refitPdfToDrawer();
  };

  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if (drawer.classList.contains('dr-sheet')) return;
    dragging = true;
    startX = e.clientX;
    startW = _drawerWidth;
    pendingWidth = startW;
    handle.classList.add('is-active');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function wireRailButtons(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.dr-rail-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.drMode as DocRailMode | undefined;
      if (!mode) return;
      toggleMode(mode);
    });
  });
}

function wireClose(): void {
  const btn = $('drClose');
  if (btn) btn.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && _openMode != null) {
      closeDrawer();
    }
  });
}

function wireAiFontZoom(drawer: HTMLElement): void {
  const storageKey = 'minallo_ai_font_scale';
  const familyStorageKey = 'minallo_ai_font_family';
  const families: Record<string, string> = {
    modern: 'var(--font-main)',
    readable: 'Arial, Helvetica, sans-serif',
    classic: 'Georgia, "Times New Roman", serif',
    mono: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
  };
  const clamp = (value: number): number => Math.min(1.8, Math.max(0.7, value));
  let scale = 1;
  let family = 'modern';
  let modifierHeld = false;
  try {
    const saved = Number.parseFloat(localStorage.getItem(storageKey) || '1');
    if (Number.isFinite(saved)) scale = clamp(saved);
    const savedFamily = localStorage.getItem(familyStorageKey) || 'modern';
    if (families[savedFamily]) family = savedFamily;
  } catch { /* storage may be unavailable */ }

  const apply = (): void => {
    document.documentElement.style.setProperty('--ai-panel-font-scale', String(scale));
    drawer.style.setProperty('--ai-panel-font-scale', String(scale));
    drawer.dataset.aiFontScale = String(scale);
    // Older app bundles wrote the custom property directly onto #aiPanel.
    // That inline value outranks inheritance from the drawer/root, so always
    // update the actual hosted panel too.
    const panel = document.getElementById('aiPanel');
    panel?.style.setProperty('--ai-panel-font-scale', String(scale));
    const messages = document.getElementById('aiMsgs');
    messages?.style.setProperty('--ai-panel-font-scale', String(scale));
    const familyValue = families[family] || 'var(--font-main)';
    drawer.style.setProperty('--ai-panel-font-family', familyValue);
    panel?.style.setProperty('--ai-panel-font-family', familyValue);
    messages?.style.setProperty('--ai-panel-font-family', familyValue);
    // Apply directly to existing messages as well as their container. This
    // makes the controls immediately visible even when a legacy theme rule
    // set a custom property or font family on an individual bubble.
    messages?.querySelectorAll<HTMLElement>('.ai-bubble').forEach((bubble) => {
      bubble.style.setProperty('--ai-panel-font-scale', String(scale));
      bubble.style.setProperty('--ai-panel-font-family', familyValue);
    });
    const value = document.getElementById('drFontValue');
    if (value) value.textContent = Math.round(scale * 100) + '%';
  };
  apply();

  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Control' || event.key === 'Meta') modifierHeld = true;
  }, { capture: true });
  window.addEventListener('keyup', (event: KeyboardEvent) => {
    if (event.key === 'Control' || event.key === 'Meta') modifierHeld = false;
  }, { capture: true });
  window.addEventListener('blur', () => { modifierHeld = false; });

  // Bind to the actual drawer rather than document/window. Chromium treats
  // root wheel listeners specially, while an explicit non-passive element
  // listener can reliably cancel browser zoom.
  const resizeFromWheel = (event: WheelEvent): void => {
    if (!drawer.classList.contains('dr-mode-ai')) return;
    if (!event.ctrlKey && !event.metaKey && !modifierHeld) return;
    event.preventDefault();
    event.stopPropagation();
    const legacyDelta = (event as WheelEvent & { wheelDelta?: number }).wheelDelta;
    const scrollingUp = event.deltaY ? event.deltaY < 0 : (legacyDelta || 0) > 0;
    scale = clamp(Math.round((scale + (scrollingUp ? 0.15 : -0.15)) * 20) / 20);
    apply();
    try { localStorage.setItem(storageKey, String(scale)); } catch { /* ignore */ }
  };
  drawer.addEventListener('wheel', resizeFromWheel, { passive: false, capture: true });
  // Fallback for devices/drivers that still emit the legacy mousewheel event.
  drawer.addEventListener('mousewheel', resizeFromWheel as EventListener, { passive: false, capture: true });

  const sizeControl = document.getElementById('drSizeControl');
  const familyControl = document.getElementById('drFamilyControl');
  const sizeButton = document.getElementById('drSizeBtn') as HTMLButtonElement | null;
  const familyButton = document.getElementById('drFamilyBtn') as HTMLButtonElement | null;
  const sizeMenu = document.getElementById('drSizeMenu');
  const familyMenu = document.getElementById('drFamilyMenu');
  const setMenuOpen = (menu: HTMLElement | null, button: HTMLButtonElement | null, open: boolean): void => {
    if (!menu || !button) return;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  sizeButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenuOpen(familyMenu, familyButton, false);
    setMenuOpen(sizeMenu, sizeButton, sizeMenu?.hidden !== false);
  });
  familyButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenuOpen(sizeMenu, sizeButton, false);
    setMenuOpen(familyMenu, familyButton, familyMenu?.hidden !== false);
  });
  sizeMenu?.addEventListener('click', (event) => event.stopPropagation());
  familyMenu?.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (sizeControl && !sizeControl.contains(target)) setMenuOpen(sizeMenu, sizeButton, false);
    if (familyControl && !familyControl.contains(target)) setMenuOpen(familyMenu, familyButton, false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setMenuOpen(sizeMenu, sizeButton, false);
      setMenuOpen(familyMenu, familyButton, false);
    }
  });
  document.getElementById('drFontMinus')?.addEventListener('click', () => {
    scale = clamp(Math.round((scale - 0.15) * 20) / 20);
    apply();
    try { localStorage.setItem(storageKey, String(scale)); } catch { /* ignore */ }
  });
  document.getElementById('drFontPlus')?.addEventListener('click', () => {
    scale = clamp(Math.round((scale + 0.15) * 20) / 20);
    apply();
    try { localStorage.setItem(storageKey, String(scale)); } catch { /* ignore */ }
  });
  const familyOptions = document.querySelectorAll<HTMLButtonElement>('.dr-font-option[data-font-family]');
  const syncFamilyOptions = (): void => {
    familyOptions.forEach((option) => option.classList.toggle('is-active', option.dataset.fontFamily === family));
  };
  syncFamilyOptions();
  familyOptions.forEach((option) => {
    option.addEventListener('click', () => {
      const next = option.dataset.fontFamily || 'modern';
      family = families[next] ? next : 'modern';
      apply();
      syncFamilyOptions();
      try { localStorage.setItem(familyStorageKey, family); } catch { /* ignore */ }
      setMenuOpen(familyMenu, familyButton, false);
    });
  });
}

function setRouteVisibility(route: DocRailRoute): void {
  const root = $('drRoot');
  if (!root) return;
  _route = route;
  applyUserTypeVisibility();
  root.hidden = false;
  root.classList.toggle('is-pdf', route === 'pdf');
  root.classList.toggle('is-courses', route === 'courses');
  if (route === 'other') {
    clearSplitState();
  } else {
    applySplitState($('drDrawer'));
  }
  if (route === 'other' && _openMode != null) {
    closeDrawer();
  }
}

export function initDocumentRail(): void {
  if (_initialized) return;
  const root = $('drRoot');
  if (!root) {
    window.addEventListener('ss-ready', () => initDocumentRail(), { once: true });
    return;
  }
  _initialized = true;

  _drawerWidth = loadWidth();
  const drawer = $('drDrawer');
  if (drawer) {
    applyWidth(drawer, _drawerWidth);
    wireAiFontZoom(drawer);
  }

  wireRailButtons();
  wireClose();
  wireResize();
  applyUserTypeVisibility();
  window.addEventListener('ss-profile-updated', applyUserTypeVisibility);

  const w: DocRailWindow = window as DocRailWindow;
  w.__minalloDocRail = {
    setRouteVisibility,
    open: openDrawer,
    close: closeDrawer,
    currentMode: () => _openMode,
  };

  root.classList.remove('is-pdf', 'is-courses', 'is-open');
  clearSplitState();
}
