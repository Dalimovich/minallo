// Lightweight markdown → HTML renderer for AI message bubbles. Handles
// headings, code blocks, math (KaTeX), lists, blockquotes, inline emphasis.

// Map of common fence-language aliases to display names. Anything not in
// here is shown capitalised. "Code" is the fallback when no lang is given.
const LANG_DISPLAY: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  py: 'Python', python: 'Python',
  rb: 'Ruby', ruby: 'Ruby',
  go: 'Go', golang: 'Go',
  rs: 'Rust', rust: 'Rust',
  java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin', swift: 'Swift',
  c: 'C', cpp: 'C++', 'c++': 'C++', h: 'C', hpp: 'C++', cs: 'C#', csharp: 'C#',
  php: 'PHP', sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish',
  ps1: 'PowerShell', powershell: 'PowerShell',
  sql: 'SQL', mysql: 'MySQL', psql: 'PostgreSQL', postgresql: 'PostgreSQL',
  html: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', less: 'Less',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI',
  md: 'Markdown', markdown: 'Markdown', tex: 'LaTeX', latex: 'LaTeX',
  dockerfile: 'Dockerfile', makefile: 'Makefile',
  r: 'R', matlab: 'MATLAB', m: 'MATLAB', lua: 'Lua', dart: 'Dart',
  scala: 'Scala', haskell: 'Haskell', hs: 'Haskell', clj: 'Clojure',
  elixir: 'Elixir', ex: 'Elixir', erlang: 'Erlang', erl: 'Erlang',
  graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protobuf',
  diff: 'Diff', patch: 'Diff', text: 'Text', plain: 'Text'
};
function prettyLang(raw: string): string {
  const key = (raw || '').trim().toLowerCase();
  if (!key) return 'Code';
  if (LANG_DISPLAY[key]) return LANG_DISPLAY[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// One-time delegated click handler for the copy buttons we emit on every
// code block. Idempotent — re-importing the module won't double-bind. We
// guard for browser environment so the tsx test runner doesn't blow up.
declare global {
  interface Window {
    _ssCodeCopyBound?: boolean;
    _ssAiInputBound?: boolean;
    _ssAiInputModalBound?: boolean;
    _ssDiagramViewerBound?: boolean;
  }
}
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window._ssCodeCopyBound) {
  window._ssCodeCopyBound = true;
  document.addEventListener('click', (ev) => {
    const target = ev.target as Element | null;
    if (!target) return;
    const btn = target.closest('.md-code-copy') as HTMLButtonElement | null;
    if (!btn) return;
    const block = btn.closest('.md-code-block');
    const code = block?.querySelector('pre code');
    const text = code?.textContent || '';
    if (!text) return;
    const done = (): void => {
      btn.classList.add('is-copied');
      const t = window.setTimeout(() => btn.classList.remove('is-copied'), 1400);
      btn.dataset.copyTimer = String(t);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      // Fallback for non-secure contexts / older browsers. textarea + exec.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch { /* swallow */ }
      ta.remove();
    }
  });
}

const DIAGRAM_MIN_ZOOM = 0.35;
const DIAGRAM_MAX_ZOOM = 2.8;

function clampDiagramZoom(value: number): number {
  return Math.max(DIAGRAM_MIN_ZOOM, Math.min(DIAGRAM_MAX_ZOOM, value));
}

function bindDiagramViewer(stage: HTMLElement): void {
  if (stage.dataset.diagramViewerBound) return;
  const svg = stage.querySelector<SVGSVGElement>('svg.md-diagram-svg');
  const content = svg?.querySelector<SVGGElement>('.md-diagram-content');
  if (!svg || !content) return;
  stage.dataset.diagramViewerBound = '1';

  const bounds = {
    x: Number(content.dataset.boundsX || 0),
    y: Number(content.dataset.boundsY || 0),
    w: Math.max(1, Number(content.dataset.boundsW || 800)),
    h: Math.max(1, Number(content.dataset.boundsH || 460)),
  };
  const viewBox = svg.viewBox.baseVal;
  const state = { x: 0, y: 0, scale: 1 };
  const pointers = new Map<number, { x: number; y: number }>();
  let lastPan: { x: number; y: number } | null = null;
  let pinchStart: { dist: number; scale: number; cx: number; cy: number } | null = null;

  const setZoomLabel = (): void => {
    const label = stage.querySelector<HTMLElement>('.md-diagram-zoom-label');
    if (label) label.textContent = Math.round(state.scale * 100) + '%';
  };
  const apply = (): void => {
    content.setAttribute('transform', 'translate(' + state.x.toFixed(2) + ' ' + state.y.toFixed(2) + ') scale(' + state.scale.toFixed(4) + ')');
    setZoomLabel();
  };
  const svgPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svg.getBoundingClientRect();
    const sx = viewBox.width / Math.max(1, rect.width);
    const sy = viewBox.height / Math.max(1, rect.height);
    return {
      x: viewBox.x + (clientX - rect.left) * sx,
      y: viewBox.y + (clientY - rect.top) * sy,
    };
  };
  const zoomAt = (nextScale: number, cx: number, cy: number): void => {
    const scale = clampDiagramZoom(nextScale);
    const beforeX = (cx - state.x) / state.scale;
    const beforeY = (cy - state.y) / state.scale;
    state.scale = scale;
    state.x = cx - beforeX * state.scale;
    state.y = cy - beforeY * state.scale;
    apply();
  };
  const fit = (): void => {
    const pad = 46;
    const fitScale = clampDiagramZoom(Math.min(
      (viewBox.width - pad) / bounds.w,
      (viewBox.height - pad) / bounds.h
    ));
    state.scale = fitScale;
    state.x = (viewBox.width - bounds.w * fitScale) / 2 - bounds.x * fitScale;
    state.y = (viewBox.height - bounds.h * fitScale) / 2 - bounds.y * fitScale;
    apply();
  };

  stage.querySelector<HTMLButtonElement>('[data-diagram-action="zoom-in"]')?.addEventListener('click', () => {
    zoomAt(state.scale * 1.18, viewBox.width / 2, viewBox.height / 2);
  });
  stage.querySelector<HTMLButtonElement>('[data-diagram-action="zoom-out"]')?.addEventListener('click', () => {
    zoomAt(state.scale / 1.18, viewBox.width / 2, viewBox.height / 2);
  });
  stage.querySelector<HTMLButtonElement>('[data-diagram-action="fit"]')?.addEventListener('click', fit);

  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = svgPoint(ev.clientX, ev.clientY);
    const factor = Math.exp(-ev.deltaY * 0.0018);
    zoomAt(state.scale * factor, p.x, p.y);
  }, { passive: false });

  stage.addEventListener('pointerdown', (ev) => {
    if ((ev.target as Element | null)?.closest('.md-diagram-toolbar')) return;
    stage.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    lastPan = { x: ev.clientX, y: ev.clientY };
    stage.classList.add('is-panning');
    if (pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const dx = pts[1]!.x - pts[0]!.x;
      const dy = pts[1]!.y - pts[0]!.y;
      const mid = svgPoint((pts[0]!.x + pts[1]!.x) / 2, (pts[0]!.y + pts[1]!.y) / 2);
      pinchStart = { dist: Math.max(1, Math.hypot(dx, dy)), scale: state.scale, cx: mid.x, cy: mid.y };
    }
  });
  stage.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size >= 2 && pinchStart) {
      const pts = Array.from(pointers.values());
      const dx = pts[1]!.x - pts[0]!.x;
      const dy = pts[1]!.y - pts[0]!.y;
      const mid = svgPoint((pts[0]!.x + pts[1]!.x) / 2, (pts[0]!.y + pts[1]!.y) / 2);
      zoomAt(pinchStart.scale * (Math.hypot(dx, dy) / pinchStart.dist), mid.x, mid.y);
      return;
    }
    if (!lastPan) return;
    const rect = svg.getBoundingClientRect();
    const sx = viewBox.width / Math.max(1, rect.width);
    const sy = viewBox.height / Math.max(1, rect.height);
    state.x += (ev.clientX - lastPan.x) * sx;
    state.y += (ev.clientY - lastPan.y) * sy;
    lastPan = { x: ev.clientX, y: ev.clientY };
    apply();
  });
  const stopPointer = (ev: PointerEvent): void => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (!pointers.size) {
      lastPan = null;
      stage.classList.remove('is-panning');
    }
  };
  stage.addEventListener('pointerup', stopPointer);
  stage.addEventListener('pointercancel', stopPointer);
  fit();
  requestAnimationFrame(fit);
}

function initDiagramViewers(root: ParentNode = document): void {
  root.querySelectorAll?.<HTMLElement>('.md-diagram-stage').forEach(bindDiagramViewer);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window._ssDiagramViewerBound) {
  window._ssDiagramViewerBound = true;
  const start = (): void => {
    initDiagramViewers(document);
    const obs = new MutationObserver((muts) => {
      for (const mut of muts) {
        mut.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const el = node as Element;
          if (el.matches?.('.md-diagram-stage')) bindDiagramViewer(el as HTMLElement);
          else initDiagramViewers(el);
        });
      }
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

// Normalise a German decimal comma to a dot, but only between digits, so
// "5,5" → "5.5" while a thousands-style "1,000" also becomes "1.000" (we keep
// it simple and predictable — users type one decimal value per field).
// Exported for unit testing the submit composition without a DOM.
export function normalizeDecimalValue(raw: string): string {
  return raw.replace(/(\d),(\d)/g, '$1.$2');
}

// ── Completed minallo-input forms — persisted so they never re-ask ──────────
//
// Chat history is saved as raw markdown and re-rendered on restore, so a
// minallo-input block the student already answered used to come back as a
// fresh fillable form (and re-pop the modal) every time the file was reopened.
// On submit we record the form's identity + a values summary in localStorage;
// renderInputForm() then renders answered forms as a locked "✓ Submitted: …"
// note instead of an active form. Identity is the model-provided requestId
// when present, else a stable hash of prompt+symbols so the same re-rendered
// block is still recognised.
const AI_INPUT_DONE_KEY = 'ss_ai_input_done_v1';
const AI_INPUT_DONE_MAX = 120;

function _aiInputDoneMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AI_INPUT_DONE_KEY);
    const obj: unknown = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' && !Array.isArray(obj)
      ? (obj as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function markAiInputDone(id: string, summary: string): void {
  if (!id) return;
  try {
    const map = _aiInputDoneMap();
    map[id] = (summary || '').slice(0, 200);
    // Bounded: drop the oldest entries (insertion order) past the cap.
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - AI_INPUT_DONE_MAX))) delete map[k];
    localStorage.setItem(AI_INPUT_DONE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable (private mode / SSR) — popup-once degrades gracefully */
  }
}

export function aiInputDoneSummary(id: string): string | undefined {
  if (!id) return undefined;
  const map = _aiInputDoneMap();
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

export function aiInputIdentity(reqId: string, promptText: string, symbols: string[]): string {
  if (reqId) return reqId;
  const s = (promptText || '') + '|' + symbols.join(',');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 'h:' + (h >>> 0).toString(36);
}

// One-time delegated submit handler for `minallo-input` forms (the AI asking
// the student for a missing value). Idempotent across re-imports. On submit it
// validates that all fields are filled, normalises a decimal comma (5,5→5.5),
// composes an explicit "continue the calculation with these values" follow-up,
// locks the form, and dispatches a bubbling `minallo-ai-input-submit` event.
// The per-surface listeners (PDF AI panel, Chatbot) route that to their own
// send path — the renderer stays decoupled from how messages are sent.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window._ssAiInputBound) {
  window._ssAiInputBound = true;
  document.addEventListener('submit', (ev) => {
    const target = ev.target as Element | null;
    const form = target?.closest?.('.md-ai-input') as HTMLFormElement | null;
    if (!form) return;
    ev.preventDefault();
    if (form.dataset.submitted) return;
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[data-symbol]'));
    if (!inputs.length) return;
    const parts: string[] = [];
    let firstEmpty: HTMLInputElement | null = null;
    for (const inp of inputs) {
      const raw = (inp.value || '').trim();
      if (!raw) { if (!firstEmpty) firstEmpty = inp; continue; }
      // German decimal comma → dot (only between digits), so "5,5" → "5.5".
      const val = normalizeDecimalValue(raw);
      const sym = inp.dataset.symbol || '';
      const unit = inp.dataset.unit || '';
      parts.push(sym + ' = ' + val + (unit ? ' ' + unit : ''));
    }
    // Require every field before sending — a partial set just makes the model
    // re-ask. Focus the first blank and wait.
    if (firstEmpty) { firstEmpty.focus(); return; }
    if (!parts.length) return;
    form.dataset.submitted = 'true';
    inputs.forEach((i) => { i.disabled = true; });
    const btn = form.querySelector<HTMLButtonElement>('.md-ai-input-submit');
    if (btn) { btn.disabled = true; btn.textContent = '✓ Submitted'; }
    const text =
      'Continue the previous calculation using these user-provided missing values: ' +
      parts.join(', ') +
      '. Do not restart from unrelated assumptions. Finish the numeric solution.';
    // Surface is captured at promote time (data-surface) because by now the
    // form has been moved into the body-level modal and is no longer inside
    // .ncb-root — closest() would always say pdf-panel otherwise.
    const surface =
      form.dataset.surface || (form.closest('.ncb-root') ? 'chatbot' : 'pdf-panel');
    const reqId = form.dataset.requestId || '';
    // Remember this form as answered so restored history renders it as a
    // submitted summary instead of re-asking (and re-popping the modal).
    const promptText = form.querySelector('.md-ai-input-prompt')?.textContent || '';
    markAiInputDone(
      aiInputIdentity(reqId, promptText, inputs.map((i) => i.dataset.symbol || '')),
      parts.join(', ')
    );
    form.dispatchEvent(
      new CustomEvent('minallo-ai-input-submit', {
        bubbles: true,
        detail: { text, requestId: reqId, surface },
      })
    );
    // If the form lives in the modal, close it and update the in-bubble
    // placeholder to a submitted summary.
    const backdrop = form.closest('.md-ai-input-modal-backdrop');
    if (backdrop) {
      const sel = reqId ? '.md-ai-input-placeholder[data-request-id="' + (window.CSS && CSS.escape ? CSS.escape(reqId) : reqId) + '"]' : null;
      const ph = sel ? document.querySelector(sel) : null;
      if (ph) ph.textContent = '✓ Submitted: ' + parts.join(', ');
      backdrop.remove();
    }
  });
}

// ── minallo-actions: clickable next-step buttons offered by the AI ──────────
//
// The backend's ACTIONS_CONTRACT (workspace_context.py) lets the model end an
// answer with a ```minallo-actions``` JSON block. renderActionButtons() (inside
// the markdown renderer) turns it into buttons; this delegated click handler
// executes them. Two kinds:
//   * tab actions   — open/generate inside a course tab. Navigates via the
//     globals the PDF back-button already uses (showPortalSection +
//     showCourseSection), so it works from the course rail, the PDF viewer
//     AND the standalone Chatbot.
//   * ask actions   — compose a follow-up question and dispatch the existing
//     `minallo-ai-input-submit` event; the per-surface listeners route it
//     through their own send path exactly like minallo-input forms.
// Action ids must stay in sync with ALLOWED_AI_ACTIONS on the backend.
export const AI_ACTION_TABS: Record<string, string> = {
  open_files: 'files',
  open_quiz: 'quiz',
  open_flashcards: 'flashcards',
  open_examforge: 'examforge',
  open_cheatsheet: 'cheatsheet',
  open_deep_learn: 'deeplearn',
  generate_quiz: 'quiz',
  generate_flashcards: 'flashcards',
  generate_cheatsheet: 'cheatsheet',
  generate_examforge_exam: 'examforge',
  start_deeplearn: 'deeplearn',
};
export const AI_ASK_ACTIONS: Record<string, string> = {
  create_study_plan: 'Create a study plan for this course based on my files, progress and weak topics.',
  review_weak_topics: 'Which topics am I weak in, and how should I review them?',
};

function _runCourseTabAction(tab: string): boolean {
  const w = window as unknown as {
    activeCourseRef?: unknown;
    showCourseSection?: (course: unknown, section: string) => void;
    showPortalSection?: (section: string) => void;
  };
  if (!w.activeCourseRef || typeof w.showCourseSection !== 'function') return false;
  // Make sure the Courses section is on screen first (the click may come from
  // the standalone Chatbot), then switch to the requested course tab. The
  // internal portal-section id is 'studip' — passing 'courses' (a URL alias
  // only) finds no `psec-courses` element, so showPortalSection hides every
  // section and reveals none, blanking the page underneath the course view.
  if (typeof w.showPortalSection === 'function') w.showPortalSection('studip');
  w.showCourseSection(w.activeCourseRef, tab);
  return true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const _w = window as unknown as { _ssAiActionBound?: boolean };
  if (!_w._ssAiActionBound) {
    _w._ssAiActionBound = true;
    document.addEventListener('click', (ev) => {
      const btn = (ev.target as Element | null)?.closest?.(
        '.md-ai-action'
      ) as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset.aiAction || '';

      const askText = AI_ASK_ACTIONS[action];
      if (askText) {
        const surface = btn.closest('.ncb-root') ? 'chatbot' : 'pdf-panel';
        document.dispatchEvent(
          new CustomEvent('minallo-ai-input-submit', {
            bubbles: true,
            detail: { text: askText, surface },
          })
        );
        btn.disabled = true;
        return;
      }

      const tab = AI_ACTION_TABS[action];
      if (!tab) return;
      if (_runCourseTabAction(tab)) {
        if (action.startsWith('generate_') || action === 'start_deeplearn') {
          if (typeof window.showToast === 'function') {
            window.showToast(btn.textContent || 'Opening…', 'Use the Generate button in this tab.');
          }
        }
      } else if (typeof window.showToast === 'function') {
        window.showToast('Open a course first', 'Go to Courses and open the course, then try again.');
      }
    });
  }
}

// Lift a `minallo-input` form out of the message bubble into a small centered
// modal (a popup), leaving a placeholder note in the bubble. This both reads
// as a dialog the student must answer and escapes the bubble's inline CSS that
// otherwise mashed the labels/units together. Restored history forms (inside
// [data-restored]) are left inline — they were already answered, so we don't
// re-pop them. A global MutationObserver promotes forms as bubbles render
// (streaming finalize, chat restore, etc.).
function promoteAiInputToModal(form: HTMLFormElement): void {
  if (form.dataset.promoted) return;
  form.dataset.promoted = '1';
  // Capture the surface NOW, while the form is still inside its bubble.
  form.dataset.surface = form.closest('.ncb-root') ? 'chatbot' : 'pdf-panel';
  // Don't pop up already-answered history.
  if (form.closest('[data-restored]') || form.dataset.submitted) return;

  const reqId = form.dataset.requestId || '';
  const ph = document.createElement('div');
  ph.className = 'md-ai-input-placeholder';
  if (reqId) ph.setAttribute('data-request-id', reqId);
  ph.textContent = '⌨ Waiting for your input…';
  form.parentNode?.insertBefore(ph, form);

  const backdrop = document.createElement('div');
  backdrop.className = 'md-ai-input-modal-backdrop';
  const card = document.createElement('div');
  card.className = 'md-ai-input-modal';
  backdrop.appendChild(card);
  card.appendChild(form);
  (document.body || document.documentElement).appendChild(backdrop);
  (form.querySelector('input') as HTMLInputElement | null)?.focus();

  // Click outside the card → dismiss, re-inlining the form so it isn't lost.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target !== backdrop) return;
    if (ph.isConnected) ph.replaceWith(form); else card.replaceWith(form);
    backdrop.remove();
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window._ssAiInputModalBound) {
  window._ssAiInputModalBound = true;
  const promoteAll = (root: ParentNode): void => {
    root.querySelectorAll?.('form.md-ai-input:not([data-promoted])')
      .forEach((f) => promoteAiInputToModal(f as HTMLFormElement));
  };
  const start = (): void => {
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          const el = n as Element;
          if (el.matches?.('form.md-ai-input')) promoteAiInputToModal(el as HTMLFormElement);
          else promoteAll(el);
        });
      }
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    promoteAll(document); // sweep anything already present
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

// Memoised katex.renderToString results. The streaming panel re-renders the
// whole in-progress answer every ~60ms; without this every formula above the
// cursor would be re-typeset on every paint, which is the main CPU cost of
// repainting long math-heavy answers. renderToString is pure, so a simple
// bounded map is safe.
const _katexHtmlCache = new Map<string, string>();
const _KATEX_CACHE_MAX = 600;

/**
 * Split streamed markdown into a `stable` prefix that is safe to render and
 * an unstable `tail` that still has an open math delimiter (`$$…`, `\[…`,
 * `\(…`, single-`$` on the current line). Rendering the tail would flash raw
 * LaTeX, so the streaming renderer holds it back until the delimiter closes.
 *
 * Code (fenced and inline) is skipped — `$` inside code is literal. A lone
 * trailing `\` or `$` is also held back: it may be the first half of a
 * delimiter split across two tokens.
 */
export function splitStableStreamText(input: string): { stable: string; tail: string } {
  const n = input.length;
  let inFence = false;
  let inInlineCode = false;
  let mathOpen: { idx: number; close: string } | null = null;
  let lineStart = 0;
  let i = 0;

  while (i < n) {
    const ch = input[i]!;
    if (ch === '\n') {
      inInlineCode = false;
      // Single-$ inline math cannot span lines — an unclosed one is literal text.
      if (mathOpen && mathOpen.close === '$') mathOpen = null;
      lineStart = i + 1;
      i++;
      continue;
    }
    // ``` fence toggle (only at line start, outside math).
    if (!inInlineCode && !mathOpen && input.startsWith('```', i) && /^\s*$/.test(input.slice(lineStart, i))) {
      inFence = !inFence;
      i += 3;
      continue;
    }
    if (inFence) { i++; continue; }
    if (!mathOpen && ch === '`') { inInlineCode = !inInlineCode; i++; continue; }
    if (inInlineCode) { i++; continue; }

    if (mathOpen) {
      if (input.startsWith(mathOpen.close, i)) {
        i += mathOpen.close.length;
        mathOpen = null;
      } else {
        i++;
      }
      continue;
    }

    if (input.startsWith('$$', i)) { mathOpen = { idx: i, close: '$$' }; i += 2; continue; }
    if (input.startsWith('\\[', i)) { mathOpen = { idx: i, close: '\\]' }; i += 2; continue; }
    if (input.startsWith('\\(', i)) { mathOpen = { idx: i, close: '\\)' }; i += 2; continue; }
    if (ch === '$') {
      // Mirror the inline-math opener the renderer uses: `$` followed by a
      // non-space. "$ 5" or "5 $" never opens math, so prices stay stable.
      const next = input[i + 1];
      if (next && next !== '$' && !/\s/.test(next)) mathOpen = { idx: i, close: '$' };
      i++;
      continue;
    }
    i++;
  }

  if (mathOpen) {
    return { stable: input.slice(0, mathOpen.idx), tail: input.slice(mathOpen.idx) };
  }
  const last = input[n - 1];
  if (last === '\\' || last === '$') {
    return { stable: input.slice(0, n - 1), tail: last };
  }
  return { stable: input, tail: '' };
}

export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function scheduleKatex(): void {
    if (window._ssScheduleKatexRender) window._ssScheduleKatexRender();
  }

  function renderKatex(src: string, display: boolean): string {
    if (!window.katex) {
      scheduleKatex();
      return display ? '\\[' + src + '\\]' : '\\(' + src + '\\)';
    }
    const cacheKey = (display ? 'D:' : 'I:') + src;
    const cached = _katexHtmlCache.get(cacheKey);
    if (cached !== undefined) return cached;
    try {
      const html = window.katex.renderToString(src, { displayMode: display, throwOnError: false });
      if (_katexHtmlCache.size >= _KATEX_CACHE_MAX) _katexHtmlCache.clear();
      _katexHtmlCache.set(cacheKey, html);
      return html;
    } catch {
      return display ? '\\[' + src + '\\]' : '\\(' + src + '\\)';
    }
  }

  function num(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function renderDiagram(raw: string): string {
    type DiagramNode = {
      id: string;
      label: string;
      description: string;
      shape: string;
      x: number;
      y: number;
      w: number;
      h: number;
      titleLines: string[];
      descLines: string[];
      explicit: boolean;
    };

    try {
      const spec = JSON.parse(raw) as {
        title?: string;
        caption?: string;
        nodes?: Array<{ id?: string; label?: string; title?: string; description?: string; subtitle?: string; x?: number; y?: number; shape?: string }>;
        edges?: Array<{ from?: string; to?: string; label?: string; type?: string }>;
        labels?: Array<{ text?: string; x?: number; y?: number }>;
      };
      const rawNodes = Array.isArray(spec.nodes) ? spec.nodes.slice(0, 24) : [];
      const edges = Array.isArray(spec.edges) ? spec.edges.slice(0, 36) : [];
      const labels = Array.isArray(spec.labels) ? spec.labels.slice(0, 18) : [];
      if (!rawNodes.length && !labels.length) throw new Error('empty diagram');

      const wrapWords = (text: string, chars: number, maxLines: number): string[] => {
        const words = text.trim().split(/\s+/).filter(Boolean);
        const lines: string[] = [];
        let current = '';
        for (const word of words) {
          const next = current ? current + ' ' + word : word;
          if (next.length <= chars) {
            current = next;
            continue;
          }
          if (current) lines.push(current);
          current = word;
          if (lines.length >= maxLines - 1) break;
        }
        if (current && lines.length < maxLines) lines.push(current);
        return lines.length ? lines : [''];
      };

      const measureNode = (node: { id?: string; label?: string; title?: string; description?: string; subtitle?: string; shape?: string; x?: number; y?: number }, idx: number): DiagramNode => {
        const label = String(node.label || node.title || node.id || 'Concept ' + (idx + 1)).slice(0, 110);
        const description = String(node.description || node.subtitle || '').slice(0, 110);
        const shape = String(node.shape || 'rect').toLowerCase();
        const titleLines = wrapWords(label, 22, 3);
        const descLines = description ? wrapWords(description, 30, 2) : [];
        const longest = [...titleLines, ...descLines].reduce((m, line) => Math.max(m, line.length), 0);
        const baseW = Math.max(128, Math.min(280, Math.round(longest * 7.2 + 44)));
        const baseH = Math.max(68, 32 + titleLines.length * 18 + descLines.length * 15);
        const compact = shape === 'joint' || shape === 'arrow';
        return {
          id: String(node.id || 'n' + idx),
          label,
          description,
          shape,
          x: num(node.x, NaN),
          y: num(node.y, NaN),
          w: shape === 'circle' ? Math.max(92, Math.min(132, baseW)) : compact ? 54 : baseW,
          h: shape === 'circle' ? Math.max(92, Math.min(132, baseH + 24)) : compact ? 54 : baseH,
          titleLines,
          descLines,
          explicit: Number.isFinite(node.x) && Number.isFinite(node.y),
        };
      };

      const nodes = rawNodes.map(measureNode);
      const nodeById = new Map<string, DiagramNode>();
      nodes.forEach((node) => nodeById.set(node.id, node));
      const hasOverlap = (): boolean => {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i]!;
            const b = nodes[j]!;
            if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 48 &&
                Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 56) return true;
          }
        }
        return false;
      };

      const nodeGap = rawNodes.length > 6 ? 76 : 56;
      const colGap = rawNodes.length > 6 ? 92 : 72;
      const shouldAutoLayout = nodes.some((node) => !node.explicit) || rawNodes.length > 5 || hasOverlap();
      if (shouldAutoLayout) {
        const indegree = new Map<string, number>();
        const outgoing = new Map<string, string[]>();
        nodes.forEach((node) => { indegree.set(node.id, 0); outgoing.set(node.id, []); });
        edges.forEach((edge) => {
          const from = edge.from ? String(edge.from) : '';
          const to = edge.to ? String(edge.to) : '';
          if (!nodeById.has(from) || !nodeById.has(to) || from === to) return;
          outgoing.get(from)?.push(to);
          indegree.set(to, (indegree.get(to) || 0) + 1);
        });
        const layer = new Map<string, number>();
        const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id);
        if (!queue.length && nodes[0]) queue.push(nodes[0].id);
        while (queue.length) {
          const id = queue.shift()!;
          const current = layer.get(id) || 0;
          (outgoing.get(id) || []).forEach((next) => {
            layer.set(next, Math.max(layer.get(next) || 0, current + 1));
            indegree.set(next, (indegree.get(next) || 1) - 1);
            if ((indegree.get(next) || 0) <= 0) queue.push(next);
          });
        }
        nodes.forEach((node, idx) => { if (!layer.has(node.id)) layer.set(node.id, Math.floor(idx / 3)); });
        const layers = new Map<number, DiagramNode[]>();
        nodes.forEach((node) => {
          const l = layer.get(node.id) || 0;
          if (!layers.has(l)) layers.set(l, []);
          layers.get(l)!.push(node);
        });
        let x = 110;
        Array.from(layers.keys()).sort((a, b) => a - b).forEach((layerId) => {
          const group = layers.get(layerId)!;
          const maxW = Math.max(...group.map((node) => node.w));
          const columnH = group.reduce((sum, node) => sum + node.h, 0) + Math.max(0, group.length - 1) * nodeGap;
          let y = Math.max(92, 260 - columnH / 2);
          group.forEach((node) => {
            node.x = x + maxW / 2;
            node.y = y + node.h / 2;
            y += node.h + nodeGap;
          });
          x += maxW + colGap;
        });
      } else {
        nodes.forEach((node, idx) => {
          node.x = Math.max(80, num(node.x, 160 + (idx % 3) * 220));
          node.y = Math.max(80, num(node.y, 120 + Math.floor(idx / 3) * 140));
        });
      }

      for (let pass = 0; pass < 18; pass++) {
        let moved = false;
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i]!;
            const b = nodes[j]!;
            const minX = (a.w + b.w) / 2 + 48;
            const minY = (a.h + b.h) / 2 + 56;
            const dx = b.x - a.x || 1;
            const dy = b.y - a.y || 1;
            if (Math.abs(dx) < minX && Math.abs(dy) < minY) {
              const pushX = (minX - Math.abs(dx)) / 2;
              const pushY = (minY - Math.abs(dy)) / 2;
              if (pushX < pushY) {
                a.x -= Math.sign(dx) * pushX;
                b.x += Math.sign(dx) * pushX;
              } else {
                a.y -= Math.sign(dy) * pushY;
                b.y += Math.sign(dy) * pushY;
              }
              moved = true;
            }
          }
        }
        if (!moved) break;
      }

      const edgePoint = (from: DiagramNode, to: DiagramNode): { x: number; y: number } => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        if (from.shape === 'circle') {
          const len = Math.max(1, Math.hypot(dx, dy));
          return { x: from.x + (dx / len) * (from.w / 2), y: from.y + (dy / len) * (from.h / 2) };
        }
        const scale = Math.min((from.w / 2) / Math.max(1, Math.abs(dx)), (from.h / 2) / Math.max(1, Math.abs(dy)));
        return { x: from.x + dx * scale, y: from.y + dy * scale };
      };
      const allXs = nodes.flatMap((node) => [node.x - node.w / 2, node.x + node.w / 2]);
      const allYs = nodes.flatMap((node) => [node.y - node.h / 2, node.y + node.h / 2]);
      labels.forEach((label) => {
        allXs.push(num(label.x, 80));
        allYs.push(num(label.y, 80));
      });
      const minX = Math.min(...allXs, 0) - 90;
      const minY = Math.min(...allYs, 0) - 90;
      const maxX = Math.max(...allXs, 760) + 90;
      const maxY = Math.max(...allYs, 420) + 90;
      const viewW = Math.max(860, Math.ceil(maxX - minX));
      const viewH = Math.max(520, Math.ceil(maxY - minY));
      const boundsX = Math.floor(minX);
      const boundsY = Math.floor(minY);
      const uid = Math.random().toString(36).slice(2, 9);
      const arrowId = 'mdDiagramArrow-' + uid;
      const hatchId = 'mdDiagramHatch-' + uid;
      const svg: string[] = [
        '<div class="md-diagram-toolbar" aria-label="Diagram controls">',
          '<button type="button" data-diagram-action="zoom-in" aria-label="Zoom in">+</button>',
          '<button type="button" data-diagram-action="zoom-out" aria-label="Zoom out">−</button>',
          '<button type="button" data-diagram-action="fit" aria-label="Fit diagram to view">⤢</button>',
          '<span class="md-diagram-zoom-label" aria-hidden="true">100%</span>',
        '</div>',
        '<svg class="md-diagram-svg" viewBox="0 0 ' + viewW + ' ' + viewH + '" role="img" aria-label="' + esc(spec.title || 'Rendered diagram') + '">',
        '<defs>',
          '<marker id="' + arrowId + '" viewBox="0 0 10 10" refX="8.2" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker>',
          '<pattern id="' + hatchId + '" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" stroke-width="1.2"/></pattern>',
        '</defs>',
        '<g class="md-diagram-content" data-bounds-x="' + boundsX + '" data-bounds-y="' + boundsY + '" data-bounds-w="' + Math.ceil(maxX - minX) + '" data-bounds-h="' + Math.ceil(maxY - minY) + '">',
      ];

      edges.forEach((edge, idx) => {
        const a = edge.from ? nodeById.get(String(edge.from)) : null;
        const b = edge.to ? nodeById.get(String(edge.to)) : null;
        if (!a || !b) return;
        let labelX = (a.x + b.x) / 2;
        let labelY = (a.y + b.y) / 2 - 14;
        if (a === b) {
          const r = Math.max(a.w, a.h) / 2 + 28;
          const p = 'M ' + (a.x - 18) + ' ' + (a.y - a.h / 2) + ' C ' + (a.x - r) + ' ' + (a.y - r) + ' ' + (a.x + r) + ' ' + (a.y - r) + ' ' + (a.x + 18) + ' ' + (a.y - a.h / 2);
          svg.push('<path class="md-diagram-edge" d="' + p + '" marker-end="url(#' + arrowId + ')"/>');
          labelX = a.x;
          labelY = a.y - r - 12;
        } else {
          const start = edgePoint(a, b);
          const end = edgePoint(b, a);
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          const curve = String(edge.type || '').toLowerCase() === 'arc' || Math.abs(dy) < 36 || idx % 2 === 1;
          const off = curve ? Math.min(72, 28 + len * 0.08) * (idx % 2 ? 1 : -1) : 0;
          const cx = (start.x + end.x) / 2 + (-dy / len) * off;
          const cy = (start.y + end.y) / 2 + (dx / len) * off;
          svg.push('<path class="md-diagram-edge" d="M ' + start.x.toFixed(1) + ' ' + start.y.toFixed(1) + ' Q ' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + end.x.toFixed(1) + ' ' + end.y.toFixed(1) + '" marker-end="url(#' + arrowId + ')"/>');
          labelX = cx + (-dy / len) * 14;
          labelY = cy + (dx / len) * 14 - 8;
        }
        if (edge.label && String(edge.label).trim().length <= 42) {
          svg.push('<text class="md-diagram-edge-label" x="' + labelX.toFixed(1) + '" y="' + labelY.toFixed(1) + '">' + esc(String(edge.label).slice(0, 42)) + '</text>');
        }
      });

      nodes.forEach((node) => {
        if (node.shape === 'circle') {
          svg.push('<circle class="md-diagram-node" cx="' + node.x + '" cy="' + node.y + '" r="' + (Math.max(node.w, node.h) / 2) + '"/>');
        } else if (node.shape === 'joint') {
          svg.push('<circle class="md-diagram-node md-diagram-node--joint" cx="' + node.x + '" cy="' + node.y + '" r="7"/>');
        } else if (node.shape === 'triangle') {
          const s = Math.max(30, node.w / 3);
          svg.push('<polygon class="md-diagram-node" points="' + node.x + ',' + (node.y - s) + ' ' + (node.x - s) + ',' + (node.y + s * 0.65) + ' ' + (node.x + s) + ',' + (node.y + s * 0.65) + '"/>');
          svg.push('<line class="md-diagram-edge md-diagram-edge--support" x1="' + (node.x - s - 8) + '" y1="' + (node.y + s * 0.65 + 1) + '" x2="' + (node.x + s + 8) + '" y2="' + (node.y + s * 0.65 + 1) + '"/>');
          svg.push('<rect x="' + (node.x - s - 8) + '" y="' + (node.y + s * 0.65 + 1) + '" width="' + ((s + 8) * 2) + '" height="8" fill="url(#' + hatchId + ')" opacity="0.55"/>');
        } else if (node.shape === 'ground') {
          const w = Math.max(76, node.w / 2);
          svg.push('<line class="md-diagram-edge md-diagram-edge--support" x1="' + (node.x - w) + '" y1="' + node.y + '" x2="' + (node.x + w) + '" y2="' + node.y + '"/>');
          svg.push('<rect x="' + (node.x - w) + '" y="' + node.y + '" width="' + (w * 2) + '" height="12" fill="url(#' + hatchId + ')" opacity="0.55"/>');
        } else if (node.shape === 'arrow') {
          const s = 12;
          svg.push('<polygon class="md-diagram-node md-diagram-node--arrow" points="' + node.x + ',' + (node.y - s) + ' ' + (node.x + s) + ',' + node.y + ' ' + node.x + ',' + (node.y + s) + ' ' + (node.x - s) + ',' + node.y + '"/>');
        } else {
          svg.push('<rect class="md-diagram-node" x="' + (node.x - node.w / 2) + '" y="' + (node.y - node.h / 2) + '" width="' + node.w + '" height="' + node.h + '" rx="14"/>');
        }
        const outside = node.shape === 'triangle' || node.shape === 'ground' || node.shape === 'joint' || node.shape === 'arrow';
        if (outside) {
          svg.push('<text class="md-diagram-node-label" x="' + node.x + '" y="' + (node.y + node.h / 2 + 18) + '">' + esc(node.label.slice(0, 46)) + '</text>');
          return;
        }
        const firstY = node.y - ((node.titleLines.length - 1) * 9) - (node.descLines.length ? 8 : 0);
        node.titleLines.forEach((line, idx) => {
          svg.push('<text class="md-diagram-node-label" x="' + node.x + '" y="' + (firstY + idx * 18) + '">' + esc(line) + '</text>');
        });
        node.descLines.forEach((line, idx) => {
          svg.push('<text class="md-diagram-node-label md-diagram-node-sub" x="' + node.x + '" y="' + (firstY + node.titleLines.length * 18 + 4 + idx * 15) + '">' + esc(line) + '</text>');
        });
      });
      labels.forEach((label) => {
        svg.push('<text class="md-diagram-free-label" x="' + num(label.x, boundsX + 90) + '" y="' + num(label.y, boundsY + 90) + '">' + esc(String(label.text || '').slice(0, 90)) + '</text>');
      });
      svg.push('</g></svg>');

      return (
        '<figure class="md-diagram-card">' +
          (spec.title ? '<figcaption class="md-diagram-title">' + esc(spec.title) + '</figcaption>' : '') +
          '<div class="md-diagram-stage">' + svg.join('') + '</div>' +
          (spec.caption ? '<figcaption class="md-diagram-caption">' + esc(spec.caption) + '</figcaption>' : '') +
        '</figure>'
      );
    } catch {
      return renderLegacyDiagram(raw);
    }
  }

  function renderLegacyDiagram(raw: string): string {
    try {
      const spec = JSON.parse(raw) as {
        title?: string;
        caption?: string;
        nodes?: Array<{ id?: string; label?: string; x?: number; y?: number; shape?: string }>;
        edges?: Array<{ from?: string; to?: string; label?: string; type?: string }>;
        labels?: Array<{ text?: string; x?: number; y?: number }>;
      };
      const nodes = Array.isArray(spec.nodes) ? spec.nodes.slice(0, 18) : [];
      const edges = Array.isArray(spec.edges) ? spec.edges.slice(0, 28) : [];
      const labels = Array.isArray(spec.labels) ? spec.labels.slice(0, 18) : [];
      if (!nodes.length && !labels.length) throw new Error('empty diagram');
      // Auto-size rect width from label length so a 3-char node doesn't
      // sit inside a 140px box and a long label doesn't overflow.
      const rectWidth = (label: string): number => {
        const longest = label.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
        const est = Math.max(label.length * 6.5, longest * 9) + 28;
        return Math.max(80, Math.min(220, Math.round(est)));
      };
      const nodeById = new Map<string, { x: number; y: number; w: number; label: string; shape: string }>();
      nodes.forEach((node, idx) => {
        const label = String(node.label || node.id || 'n' + idx).slice(0, 80);
        const shape = String(node.shape || 'rect').toLowerCase();
        nodeById.set(String(node.id || 'n' + idx), {
          x: Math.max(30, Math.min(770, num(node.x, 120 + (idx % 4) * 170))),
          y: Math.max(36, Math.min(420, num(node.y, 100 + Math.floor(idx / 4) * 110))),
          w: shape === 'rect' ? rectWidth(label) : 80,
          label,
          shape,
        });
      });

      const svg: string[] = [
        '<svg class="md-diagram-svg" viewBox="0 0 800 460" role="img" aria-label="' +
          esc(spec.title || 'Rendered diagram') + '">',
        '<defs>',
          '<marker id="mdDiagramArrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker>',
          '<pattern id="mdDiagramHatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" stroke-width="1.2"/></pattern>',
        '</defs>',
      ];
      edges.forEach((edge) => {
        const a = edge.from ? nodeById.get(String(edge.from)) : null;
        const b = edge.to ? nodeById.get(String(edge.to)) : null;
        if (!a || !b) return;
        const isSelf = a === b;
        const isArc = isSelf || String(edge.type || '').toLowerCase() === 'arc';
        let labelX = (a.x + b.x) / 2;
        let labelY = (a.y + b.y) / 2 - 8;
        if (isSelf) {
          // Self-loop: small arc above the node.
          const r = 26;
          const p = 'M ' + (a.x - 10) + ' ' + (a.y - 30) +
                    ' a ' + r + ' ' + r + ' 0 1 1 ' + 20 + ' 0';
          svg.push('<path class="md-diagram-edge" d="' + p + '" fill="none" marker-end="url(#mdDiagramArrow)"/>');
          labelX = a.x;
          labelY = a.y - 60;
        } else if (isArc) {
          // Quadratic bezier with perpendicular control offset.
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          const off = 30;
          const cx = mx + (-dy / len) * off;
          const cy = my + (dx / len) * off;
          svg.push(
            '<path class="md-diagram-edge" d="M ' + a.x + ' ' + a.y +
              ' Q ' + cx + ' ' + cy + ' ' + b.x + ' ' + b.y +
              '" fill="none" marker-end="url(#mdDiagramArrow)"/>'
          );
          labelX = cx;
          labelY = cy - 6;
        } else {
          svg.push(
            '<line class="md-diagram-edge" x1="' + a.x + '" y1="' + a.y +
              '" x2="' + b.x + '" y2="' + b.y + '" marker-end="url(#mdDiagramArrow)"/>'
          );
        }
        if (edge.label) {
          svg.push(
            '<text class="md-diagram-edge-label" x="' + labelX + '" y="' + labelY + '">' +
              esc(String(edge.label).slice(0, 50)) + '</text>'
          );
        }
      });
      nodeById.forEach((node) => {
        // Shapes:
        //   rect     — block / step / component (auto-width)
        //   circle   — joint / wheel / state
        //   joint    — small solid pin marker (FBD pin joints)
        //   triangle — fixed support (apex up, label below)
        //   ground   — immovable surface: horizontal bar + hatched fill below
        //   arrow    — small diamond marker; force vectors should be edges
        //              (which now carry arrow markers), but a labelled point
        //              is useful as an anchor / annotation
        if (node.shape === 'circle') {
          svg.push('<circle class="md-diagram-node" cx="' + node.x + '" cy="' + node.y + '" r="40"/>');
        } else if (node.shape === 'joint') {
          svg.push('<circle class="md-diagram-node md-diagram-node--joint" cx="' + node.x + '" cy="' + node.y + '" r="6"/>');
        } else if (node.shape === 'triangle') {
          const s = 28;
          const pts = (node.x) + ',' + (node.y - s) + ' ' +
                      (node.x - s) + ',' + (node.y + s * 0.6) + ' ' +
                      (node.x + s) + ',' + (node.y + s * 0.6);
          svg.push('<polygon class="md-diagram-node" points="' + pts + '"/>');
          // Hatched ground line under the support apex.
          svg.push('<line class="md-diagram-edge" x1="' + (node.x - s - 6) + '" y1="' + (node.y + s * 0.6 + 1) +
                   '" x2="' + (node.x + s + 6) + '" y2="' + (node.y + s * 0.6 + 1) + '"/>');
          svg.push('<rect x="' + (node.x - s - 6) + '" y="' + (node.y + s * 0.6 + 1) +
                   '" width="' + ((s + 6) * 2) + '" height="6" fill="url(#mdDiagramHatch)" opacity="0.6"/>');
        } else if (node.shape === 'ground') {
          const w = 60;
          svg.push('<line class="md-diagram-edge" x1="' + (node.x - w) + '" y1="' + node.y +
                   '" x2="' + (node.x + w) + '" y2="' + node.y + '"/>');
          svg.push('<rect x="' + (node.x - w) + '" y="' + node.y +
                   '" width="' + (w * 2) + '" height="10" fill="url(#mdDiagramHatch)" opacity="0.6"/>');
        } else if (node.shape === 'arrow') {
          const s = 9;
          const pts = (node.x) + ',' + (node.y - s) + ' ' +
                      (node.x + s) + ',' + (node.y) + ' ' +
                      (node.x) + ',' + (node.y + s) + ' ' +
                      (node.x - s) + ',' + (node.y);
          svg.push('<polygon class="md-diagram-node md-diagram-node--arrow" points="' + pts + '"/>');
        } else {
          const half = node.w / 2;
          svg.push(
            '<rect class="md-diagram-node" x="' + (node.x - half) + '" y="' + (node.y - 30) +
              '" width="' + node.w + '" height="60" rx="12"/>'
          );
        }
        // Label placement: shapes without internal room (triangle/ground/
        // joint/arrow) get the label below the geometry; rect/circle get it
        // centred inside.
        const wordList = node.label.split(/\s+/);
        if (node.shape === 'triangle' || node.shape === 'ground' || node.shape === 'joint' || node.shape === 'arrow') {
          const ly = node.shape === 'triangle' ? node.y + 38 :
                     node.shape === 'ground'   ? node.y + 24 :
                                                 node.y + 18;
          svg.push('<text class="md-diagram-node-label" x="' + node.x + '" y="' + ly + '">' +
                   esc(wordList.join(' ').slice(0, 40)) + '</text>');
        } else {
          // rect/circle: split into up to 2 lines, sized to fit width.
          const charsPerLine = node.shape === 'rect' ? Math.max(8, Math.floor(node.w / 7)) : 12;
          const lines: string[] = [];
          let buf = '';
          for (const word of wordList) {
            if (!buf) { buf = word; continue; }
            if ((buf + ' ' + word).length <= charsPerLine) buf += ' ' + word;
            else { lines.push(buf); buf = word; if (lines.length >= 1) break; }
          }
          if (buf) lines.push(buf);
          const line1 = lines[0] || '';
          const line2 = lines[1] || '';
          svg.push('<text class="md-diagram-node-label" x="' + node.x + '" y="' + (node.y - (line2 ? 4 : -4)) + '">' + esc(line1) + '</text>');
          if (line2) svg.push('<text class="md-diagram-node-label" x="' + node.x + '" y="' + (node.y + 15) + '">' + esc(line2) + '</text>');
        }
      });
      labels.forEach((label) => {
        svg.push(
          '<text class="md-diagram-free-label" x="' + Math.max(20, Math.min(780, num(label.x, 80))) +
            '" y="' + Math.max(24, Math.min(440, num(label.y, 80))) + '">' +
            esc(String(label.text || '').slice(0, 90)) + '</text>'
        );
      });
      svg.push('</svg>');

      return (
        '<figure class="md-diagram-card">' +
          (spec.title ? '<figcaption class="md-diagram-title">' + esc(spec.title) + '</figcaption>' : '') +
          '<div class="md-diagram-stage">' + svg.join('') + '</div>' +
          (spec.caption ? '<figcaption class="md-diagram-caption">' + esc(spec.caption) + '</figcaption>' : '') +
        '</figure>'
      );
    } catch {
      return (
        '<div class="md-diagram-placeholder">' +
          '<div class="md-diagram-placeholder-title">Diagram could not be rendered</div>' +
          '<div class="md-diagram-placeholder-sub">The AI response included an invalid diagram block.</div>' +
        '</div>'
      );
    }
  }

  // Continuous 2D plot primitive — for things renderDiagram cannot represent
  // (stress-strain curves, characteristic curves, x/y data with marked
  // points). Schema accepts one or more polyline series in data coords +
  // optional named markers. We compute the data range, map to a 760×360
  // SVG box with margins for axes / labels.
  function renderPlot(raw: string): string {
    try {
      const spec = JSON.parse(raw) as {
        title?: string;
        caption?: string;
        xAxis?: { label?: string; min?: number; max?: number; unit?: string };
        yAxis?: { label?: string; min?: number; max?: number; unit?: string };
        series?: Array<{ label?: string; points?: Array<[number, number]>; dashed?: boolean }>;
        markers?: Array<{ x?: number; y?: number; label?: string }>;
      };
      const series = Array.isArray(spec.series)
        ? spec.series
            .map((s) => ({
              label: String(s.label || '').slice(0, 60),
              points: Array.isArray(s.points)
                ? s.points
                    .filter((p): p is [number, number] =>
                      Array.isArray(p) && p.length === 2 &&
                      Number.isFinite(p[0]) && Number.isFinite(p[1])
                    )
                    .slice(0, 200)
                : [],
              dashed: Boolean(s.dashed)
            }))
            .filter((s) => s.points.length >= 2)
            .slice(0, 6)
        : [];
      const markers = Array.isArray(spec.markers)
        ? spec.markers
            .filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y))
            .slice(0, 12)
        : [];
      if (!series.length) throw new Error('empty plot');

      // Derive data range from series ∪ markers ∪ explicit axis hints. An
      // explicit min/max wins so callers can pin axes to nice round numbers.
      const allXs: number[] = [];
      const allYs: number[] = [];
      series.forEach((s) => s.points.forEach(([x, y]) => { allXs.push(x); allYs.push(y); }));
      markers.forEach((m) => { allXs.push(num(m.x, 0)); allYs.push(num(m.y, 0)); });
      const xMin = num(spec.xAxis?.min, Math.min(...allXs));
      const xMax = num(spec.xAxis?.max, Math.max(...allXs));
      const yMin = num(spec.yAxis?.min, Math.min(...allYs, 0));
      const yMax = num(spec.yAxis?.max, Math.max(...allYs));
      const xRange = xMax - xMin || 1;
      const yRange = yMax - yMin || 1;

      // SVG layout. 800×420 viewBox; plot area inset for axis labels.
      const W = 800, H = 420;
      const M = { top: 24, right: 24, bottom: 56, left: 72 };
      const plotW = W - M.left - M.right;
      const plotH = H - M.top - M.bottom;
      const sx = (x: number): number => M.left + ((x - xMin) / xRange) * plotW;
      const sy = (y: number): number => M.top + plotH - ((y - yMin) / yRange) * plotH;

      const xUnit = spec.xAxis?.unit ? ' [' + String(spec.xAxis.unit) + ']' : '';
      const yUnit = spec.yAxis?.unit ? ' [' + String(spec.yAxis.unit) + ']' : '';
      const xAxisLabel = String(spec.xAxis?.label || '') + xUnit;
      const yAxisLabel = String(spec.yAxis?.label || '') + yUnit;

      // 5-tick axis labelling. round to a sensible precision based on range.
      const fmt = (v: number, range: number): string => {
        if (range >= 100) return Math.round(v).toString();
        if (range >= 10) return v.toFixed(1);
        if (range >= 1) return v.toFixed(2);
        return v.toFixed(3);
      };
      const ticks = (lo: number, hi: number): number[] =>
        Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * k) / 4);
      const xTicks = ticks(xMin, xMax);
      const yTicks = ticks(yMin, yMax);

      const svg: string[] = [
        '<svg class="md-plot-svg" viewBox="0 0 ' + W + ' ' + H +
          '" role="img" aria-label="' + esc(spec.title || 'Plot') + '">',
        // Plot frame
        '<rect class="md-plot-frame" x="' + M.left + '" y="' + M.top +
          '" width="' + plotW + '" height="' + plotH + '"/>',
        // Grid + axis ticks
      ];
      xTicks.forEach((t) => {
        const x = sx(t);
        svg.push('<line class="md-plot-grid" x1="' + x + '" y1="' + M.top +
          '" x2="' + x + '" y2="' + (M.top + plotH) + '"/>');
        svg.push('<text class="md-plot-tick" x="' + x + '" y="' + (M.top + plotH + 18) +
          '" text-anchor="middle">' + esc(fmt(t, xRange)) + '</text>');
      });
      yTicks.forEach((t) => {
        const y = sy(t);
        svg.push('<line class="md-plot-grid" x1="' + M.left + '" y1="' + y +
          '" x2="' + (M.left + plotW) + '" y2="' + y + '"/>');
        svg.push('<text class="md-plot-tick" x="' + (M.left - 8) + '" y="' + (y + 4) +
          '" text-anchor="end">' + esc(fmt(t, yRange)) + '</text>');
      });
      // Axis labels
      svg.push('<text class="md-plot-axis-label" x="' + (M.left + plotW / 2) +
        '" y="' + (H - 14) + '" text-anchor="middle">' + esc(xAxisLabel) + '</text>');
      svg.push('<text class="md-plot-axis-label" x="' + (M.left / 2 - 8) +
        '" y="' + (M.top + plotH / 2) + '" text-anchor="middle" transform="rotate(-90 ' +
        (M.left / 2 - 8) + ',' + (M.top + plotH / 2) + ')">' + esc(yAxisLabel) + '</text>');

      // Series polylines. Distinct stroke colours per series via inline CSS variable.
      const colours = ['var(--plot-c1, #2563eb)', 'var(--plot-c2, #dc2626)', 'var(--plot-c3, #16a34a)',
                       'var(--plot-c4, #ea580c)', 'var(--plot-c5, #7c3aed)', 'var(--plot-c6, #0891b2)'];
      series.forEach((s, idx) => {
        const pts = s.points.map((p) => sx(p[0]) + ',' + sy(p[1])).join(' ');
        const dash = s.dashed ? ' stroke-dasharray="6 4"' : '';
        svg.push('<polyline class="md-plot-series" fill="none" stroke="' + colours[idx % colours.length] +
          '" stroke-width="2.4"' + dash + ' points="' + pts + '"/>');
      });

      // Markers — small dot + label offset above/right of the point.
      markers.forEach((m) => {
        const mx = sx(num(m.x, 0));
        const my = sy(num(m.y, 0));
        svg.push('<circle class="md-plot-marker" cx="' + mx + '" cy="' + my + '" r="4"/>');
        if (m.label) {
          svg.push('<text class="md-plot-marker-label" x="' + (mx + 8) + '" y="' + (my - 8) +
            '">' + esc(String(m.label).slice(0, 40)) + '</text>');
        }
      });

      // Series legend, when more than one series.
      if (series.length > 1) {
        let lx = M.left + 10;
        const ly = M.top + 14;
        series.forEach((s, idx) => {
          svg.push('<rect x="' + lx + '" y="' + (ly - 8) + '" width="14" height="3" fill="' +
            colours[idx % colours.length] + '"/>');
          svg.push('<text class="md-plot-legend" x="' + (lx + 18) + '" y="' + (ly + 2) + '">' +
            esc(s.label) + '</text>');
          lx += 18 + s.label.length * 6 + 14;
        });
      }

      svg.push('</svg>');

      return (
        '<figure class="md-diagram-card">' +
          (spec.title ? '<figcaption class="md-diagram-title">' + esc(spec.title) + '</figcaption>' : '') +
          '<div class="md-diagram-stage">' + svg.join('') + '</div>' +
          (spec.caption ? '<figcaption class="md-diagram-caption">' + esc(spec.caption) + '</figcaption>' : '') +
        '</figure>'
      );
    } catch {
      return (
        '<div class="md-diagram-placeholder">' +
          '<div class="md-diagram-placeholder-title">Plot could not be rendered</div>' +
          '<div class="md-diagram-placeholder-sub">The AI response included an invalid plot block.</div>' +
        '</div>'
      );
    }
  }

  // Render a `minallo-input` block — the AI asking the student for one or more
  // missing values. Validation is strict (never trust the model's JSON): bad
  // input renders a safe fallback, never raw HTML and never a throw. The
  // delegated submit handler at module top reads data-symbol / data-unit.
  function renderInputForm(raw: string): string {
    const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');
    try {
      const spec = JSON.parse(raw) as {
        requestId?: string;
        prompt?: string;
        fields?: Array<{ symbol?: string; label?: string; unit?: string }>;
      };
      const fields = (Array.isArray(spec.fields) ? spec.fields : [])
        .filter(
          (f) => f && typeof f.symbol === 'string' && f.symbol.trim() &&
                 typeof f.label === 'string' && f.label.trim()
        )
        .slice(0, 8);
      if (!fields.length) throw new Error('no valid fields');
      const reqId = typeof spec.requestId === 'string' ? spec.requestId.slice(0, 80) : '';
      const promptText =
        typeof spec.prompt === 'string' && spec.prompt.trim()
          ? spec.prompt
          : 'Enter the missing value to continue:';
      // Already answered (this session or a previous one) → locked summary,
      // never a second fillable form / popup.
      // Symbols are sliced to 40 chars exactly like the rendered data-symbol
      // attribute, so render-time and submit-time identities always agree.
      const doneSummary = aiInputDoneSummary(
        aiInputIdentity(reqId, promptText, fields.map((f) => String(f.symbol).slice(0, 40)))
      );
      if (doneSummary !== undefined) {
        return (
          '<div class="md-ai-input-placeholder">✓ Submitted' +
          (doneSummary ? ': ' + esc(doneSummary) : '') +
          '</div>'
        );
      }
      const rows = fields
        .map((f) => {
          const sym = String(f.symbol).slice(0, 40);
          const label = String(f.label).slice(0, 80);
          const unit = typeof f.unit === 'string' ? f.unit.slice(0, 24) : '';
          return (
            '<label class="md-ai-input-field">' +
              '<span class="md-ai-input-label">' + esc(label) +
                ' <span class="md-ai-input-sym">' + esc(sym) + '</span></span>' +
              '<span class="md-ai-input-control">' +
                '<input type="text" inputmode="decimal" autocomplete="off" ' +
                  'class="md-ai-input-value" data-symbol="' + escAttr(sym) + '" ' +
                  'data-unit="' + escAttr(unit) + '" placeholder="' + escAttr(sym) + '">' +
                (unit ? '<span class="md-ai-input-unit">' + esc(unit) + '</span>' : '') +
              '</span>' +
            '</label>'
          );
        })
        .join('');
      return (
        '<form class="md-ai-input" data-request-id="' + escAttr(reqId) + '">' +
          '<div class="md-ai-input-prompt">' + esc(promptText) + '</div>' +
          '<div class="md-ai-input-fields">' + rows + '</div>' +
          '<button type="submit" class="md-ai-input-submit">Submit</button>' +
        '</form>'
      );
    } catch {
      return (
        '<div class="md-ai-input-fallback">' +
          'The AI requested a value, but the input block was malformed.' +
        '</div>'
      );
    }
  }

  // Render a `minallo-actions` block — the AI offering clickable next steps
  // ("Generate flashcards", "Open Quiz"). Validation is strict: only
  // allowlisted action ids render, labels are length-capped and escaped, and
  // malformed JSON renders nothing (the prose above it still stands alone).
  function renderActionButtons(raw: string): string {
    const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');
    try {
      const spec = JSON.parse(raw) as { actions?: Array<{ action?: string; label?: string }> };
      const buttons = (Array.isArray(spec.actions) ? spec.actions : [])
        .filter(
          (a) =>
            a && typeof a.action === 'string' &&
            (AI_ACTION_TABS[a.action] || AI_ASK_ACTIONS[a.action]) &&
            typeof a.label === 'string' && a.label.trim()
        )
        .slice(0, 3);
      if (!buttons.length) return '';
      const html = buttons
        .map((a) => {
          const label = String(a.label).trim().slice(0, 48);
          return (
            '<button type="button" class="md-ai-action" data-ai-action="' +
            escAttr(String(a.action)) + '">' + esc(label) + '</button>'
          );
        })
        .join('');
      return '<div class="md-ai-actions" role="group" aria-label="Suggested actions">' + html + '</div>';
    } catch {
      return '';
    }
  }

  function inline(s: string): string {
    // Stash already-rendered math (and code spans) under sentinel placeholders
    // BEFORE escaping, so their trusted HTML survives the esc() pass that
    // protects everything else from injecting raw HTML.
    const placeholders: string[] = [];
    const stash = (html: string): string => {
      const key = '@@MINALLO_PH_' + placeholders.length + '@@';
      placeholders.push(html);
      return key;
    };
    s = s.replace(/\\\(([^]*?)\\\)/g, (_, m: string) => stash(renderKatex(m, false)));
    s = s.replace(/\$\$([^]*?)\$\$/g, (_, m: string) => stash(renderKatex(m, true)));
    // Inline `$…$` is currency-safe: the opener must be followed by a
    // non-space, the closer preceded by a non-space and NOT followed by a
    // digit. This stops a stray literal `$` (e.g. "$5") from being treated as
    // a math opener and greedily pairing with the next real `$`, which used to
    // desync every inline formula after it (math rendered at the top of the
    // message, raw `$…$` from that point down).
    s = s.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, m: string) => stash(renderKatex(m, false)));
    s = s.replace(/`([^`]+)`/g, (_, c: string) => stash('<code>' + esc(c) + '</code>'));

    // Now everything left is user/AI text. Escape it.
    s = esc(s);

    // Apply markdown emphasis on the escaped text — these patterns only need
    // to match ASCII markers, not HTML, so escaping doesn't break them.
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Restore the stashed math/code HTML.
    s = s.replace(/@@MINALLO_PH_(\d+)@@/g, (_, idx: string) => placeholders[Number(idx)] ?? '');
    return s;
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (/^\s*\\\[/.test(line)) {
      const mathLines: string[] = [];
      if (/\\\]/.test(line)) {
        mathLines.push(line.replace(/^\s*\\\[/, '').replace(/\\\]\s*$/, ''));
      } else {
        i++;
        while (i < lines.length && !/\\\]/.test(lines[i] ?? '')) {
          mathLines.push(lines[i] ?? '');
          i++;
        }
        if (i < lines.length) mathLines.push((lines[i] ?? '').replace(/\\\]\s*$/, ''));
      }
      out.push('<div class="md-math-block">' + renderKatex(mathLines.join('\n'), true) + '</div>');
      i++;
      continue;
    }

    if (/^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line)) {
      // Scan for the closing `$$`, but stop at a blank line: an unclosed `$$`
      // opener must not swallow the rest of the message into one math block
      // (which then fails KaTeX and blanks everything below it).
      let j = i + 1;
      const mathLines2: string[] = [];
      while (j < lines.length && !/\$\$/.test(lines[j] ?? '') && (lines[j] ?? '').trim() !== '') {
        mathLines2.push(lines[j] ?? '');
        j++;
      }
      if (j < lines.length && /\$\$/.test(lines[j] ?? '')) {
        out.push('<div class="md-math-block">' + renderKatex(mathLines2.join('\n'), true) + '</div>');
        i = j + 1;
        continue;
      }
      // No closer before the blank line / EOF — treat the opener as ordinary
      // text rather than eating the tail.
      out.push('<p class="md-p">' + inline(line) + '</p>');
      i++;
      continue;
    }

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i++;
      }
      if (/^(minallo-diagram|diagram-json|diagram)$/i.test(lang)) {
        out.push(renderDiagram(code.join('\n')));
        i++;
        continue;
      }
      if (/^(minallo-plot|plot-json|plot)$/i.test(lang)) {
        out.push(renderPlot(code.join('\n')));
        i++;
        continue;
      }
      if (/^(minallo-input|input-json)$/i.test(lang)) {
        out.push(renderInputForm(code.join('\n')));
        i++;
        continue;
      }
      if (/^(minallo-actions|actions-json)$/i.test(lang)) {
        out.push(renderActionButtons(code.join('\n')));
        i++;
        continue;
      }
      // Emit `class="language-X"` on <code> so highlight.js picks up the
      // language hint when present. Without a class, hljs auto-detects.
      const langClass = lang ? ' class="language-' + esc(lang) + '"' : '';
      const langName = prettyLang(lang);
      const codeIcon =
        '<svg class="md-code-icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<polyline points="8 6 2 12 8 18"></polyline>' +
        '<polyline points="16 6 22 12 16 18"></polyline>' +
        '</svg>';
      const copyIcon =
        '<svg class="md-code-copy-icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="9" y="9" width="11" height="11" rx="2"></rect>' +
        '<path d="M5 15V5a2 2 0 0 1 2-2h10"></path>' +
        '</svg>';
      out.push(
        '<div class="md-code-block">' +
          '<div class="md-code-header">' +
            '<span class="md-code-lang-tag">' + codeIcon +
              '<span class="md-code-lang-name">' + esc(langName) + '</span>' +
            '</span>' +
            '<button type="button" class="md-code-copy" aria-label="Copy code">' +
              copyIcon +
            '</button>' +
          '</div>' +
          '<pre><code' + langClass + '>' + code.map(esc).join('\n') + '</code></pre>' +
        '</div>'
      );
      i++;
      continue;
    }

    const hm = line.match(/^(#{1,6}) (.+)/);
    if (hm && hm[1] && hm[2]) {
      const hlevel = Math.min(hm[1].length, 3);
      out.push('<h' + hlevel + ' class="md-h md-h' + hlevel + '">' + inline(hm[2]) + '</h' + hlevel + '>');
      i++;
      continue;
    }

    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      out.push('<hr class="md-hr">');
      i++;
      continue;
    }

    if (/^> /.test(line)) {
      const bqLines: string[] = [];
      while (i < lines.length && /^> /.test(lines[i] ?? '')) {
        bqLines.push(inline((lines[i] ?? '').slice(2)));
        i++;
      }
      out.push('<blockquote class="md-bq">' + bqLines.join('<br>') + '</blockquote>');
      continue;
    }

    // GFM pipe tables: a header row (`| a | b |`) immediately followed by a
    // separator (`|---|:--:|`), then body rows. Cheatsheets use these for the
    // coordinate Method Picker and the translation-vs-rotation summary. Anything
    // not matching this exact shape falls through to paragraph rendering.
    const nextLine = lines[i + 1] ?? '';
    if (
      /\|/.test(line) && /^\s*\|?.*\|.*$/.test(line) &&
      /\|/.test(nextLine) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(nextLine)
    ) {
      const splitRow = (row: string): string[] =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '')
          .split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
      const headers = splitRow(line);
      const aligns = splitRow(nextLine).map((spec) => {
        const lft = spec.startsWith(':');
        const rgt = spec.endsWith(':');
        return rgt && lft ? 'center' : rgt ? 'right' : lft ? 'left' : '';
      });
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim() !== '' && /\|/.test(lines[i] ?? '')) {
        bodyRows.push(splitRow(lines[i] ?? ''));
        i++;
      }
      const al = (idx: number): string => (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '');
      const thead = '<thead><tr>' +
        headers.map((h, idx) => '<th' + al(idx) + '>' + inline(h) + '</th>').join('') +
        '</tr></thead>';
      const tbody = '<tbody>' +
        bodyRows.map((cells) =>
          '<tr>' + headers.map((_, idx) => '<td' + al(idx) + '>' + inline(cells[idx] ?? '') + '</td>').join('') + '</tr>'
        ).join('') +
        '</tbody>';
      out.push('<table class="md-table">' + thead + tbody + '</table>');
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const olItems: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? '')) {
        olItems.push('<li>' + inline((lines[i] ?? '').replace(/^\d+\. /, '')) + '</li>');
        i++;
      }
      out.push('<ol class="md-ol">' + olItems.join('') + '</ol>');
      continue;
    }

    if (/^[•\-*] /.test(line)) {
      const ulItems: string[] = [];
      while (i < lines.length && /^[•\-*] /.test(lines[i] ?? '')) {
        ulItems.push('<li>' + inline((lines[i] ?? '').replace(/^[•\-*] /, '')) + '</li>');
        i++;
      }
      out.push('<ul class="md-ul">' + ulItems.join('') + '</ul>');
      continue;
    }

    if (line.trim() === '') {
      out.push('<div class="md-gap"></div>');
      i++;
      continue;
    }

    out.push('<p class="md-p">' + inline(line) + '</p>');
    i++;
  }

  return out.join('');
}
