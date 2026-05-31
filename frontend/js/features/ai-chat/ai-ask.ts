import {
  sendAiRequest,
  sendRagRequest,
  listCourseDocuments,
  submitRagFeedback,
  type CourseDocument,
  type RagAskResponse,
} from '../../services/ai-service.js';
import { extractPdfText } from '../pdf-viewer/pdf-text-extraction.js';
import { getPane } from '../pdf-viewer/pdf-panes.js';
import { getCompareFileName } from '../pdf-viewer/pdf-compare.js';
import { bindMessageActionButtons } from './ai-message-actions.js';
import { escapeHtml } from '../../utils/escape-html.js';

/** The subscription gate (HTTP 402 / "subscription required") should read as a
 * calm upgrade prompt, not a raw server error. */
function _isSubscriptionError(msg: string): boolean {
  return /\b402\b/.test(msg) || /subscription/i.test(msg);
}
function _subscriptionMsg(): string {
  const v = typeof window._t === 'function' ? window._t('cb_need_subscription') : '';
  return v && v !== 'cb_need_subscription'
    ? v
    : 'You need an active subscription to use the AI tutor. Open **Subscription** in the menu to unlock it.';
}

interface AskAiState {
  generationStopped: boolean;
  currentGenId: number;
  activeTypeTimer: ReturnType<typeof setTimeout> | null;
  activeThinkTimer: ReturnType<typeof setInterval> | null;
  [k: string]: unknown;
}

interface StopButton extends HTMLButtonElement {
  __ssAbortBound?: boolean;
}

interface AiContentBlock { text?: string }
interface AiMessage { role: 'user' | 'assistant' | 'system'; content: unknown }
interface AiResponse {
  content?: AiContentBlock[];
  error?: { message?: string };
  _streamWrap?: HTMLElement | null;
  _ragData?: { id?: string; [k: string]: unknown } | null;
}

interface RagMeta {
  courseId: string;
  question: string;
  answerCacheId?: string | null;
}

interface ProblemSolverOptions {
  mode: string;
  problem: string;
  studentWork?: string;
}

interface SseDoneEvent {
  done: true;
  sources?: Array<{ file_name?: string; pages?: string | null; section?: string | null }>;
  confidence?: string;
  question_type?: string;
  unsupported?: boolean;
  answerCacheId?: string;
  [k: string]: unknown;
}

interface PdfPage {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
  getTextContent: () => Promise<{ items: Array<{ str: string }> }>;
}

interface PdfDocLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
}

function _getTime(): string {
  const d = new Date();
  return (
    d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
  );
}

function stripSourceMarkers(text: string): string {
  return (text || '')
    .replace(/\s*\[Source\s+\d+\]/gi, '')
    .replace(/\s+\./g, '.')
    .replace(/\s+,/g, ',')
    .trim();
}

function _sourceLine(s: { file_name?: string; pages?: string | null; section?: string | null }): string {
  let line = s.file_name || 'Unknown';
  if (s.pages) {
    const pages = String(s.pages);
    line += /^\d/.test(pages) ? ', p.' + pages : ', ' + pages;
  }
  if (s.section) line += ' · ' + s.section;
  return line;
}

function appendSourcesDropdown(
  bubble: HTMLElement | null,
  sources?: Array<{ file_name?: string; pages?: string | null; section?: string | null }>
): void {
  if (!bubble || !sources || !sources.length || bubble.querySelector('.ai-rag-sources')) return;
  const details = document.createElement('details');
  details.className = 'ai-rag-sources';
  const summary = document.createElement('summary');
  summary.textContent = 'Sources';
  const list = document.createElement('ul');
  sources.forEach((s) => {
    const item = document.createElement('li');
    item.textContent = _sourceLine(s);
    list.appendChild(item);
  });
  details.append(summary, list);
  bubble.appendChild(details);
}

// ── Auto-scroll controller ──────────────────────────────────────────────────
let _userScrolledUp = false;
let _scrollListenerAttached = false;
function _ensureScrollTracker(): void {
  if (_scrollListenerAttached) return;
  const el = document.getElementById('aiMsgs') || document.querySelector<HTMLElement>('.ai-msgs');
  if (!el) return;
  el.addEventListener('scroll', () => {
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    _userScrolledUp = dist > 60;
  });
  _scrollListenerAttached = true;
}
function _autoScroll(el: HTMLElement | null): void {
  if (!el) return;
  if (_userScrolledUp) return;
  el.scrollTop = el.scrollHeight;
}

const MINALLO_APP_CONTEXT =
  '\n\nMINALLO APP CONTEXT.\n' +
  'You are running inside Minallo at minallo.de — a study platform + AI tutor for university students. ' +
  'When the user asks a product / navigation question, give numbered step-by-step instructions naming the exact sidebar item, tab and button. ' +
  'Do NOT say "look for the Upload button" or "check the interface" — use the map below. App questions do NOT need [Source N] citations.\n\n' +

  'SIDEBAR (top → bottom):\n' +
  '1. Home — dashboard, greeting, study widget, recent courses, calendar.\n' +
  '2. Courses — semesters and courses. Inside a course: Files | Notes | Summaries | Quiz | Flashcards | Forum | Calendar tabs.\n' +
  '3. Lecture Notes — every auto-generated note / summary across courses.\n' +
  '4. Editor — Writer (rich-text + AI rewrite/shorten/expand), PDF Editor (annotate/sign/fill), PDF Merger (combine PDFs).\n' +
  '5. Chatbot — general Minallo AI chat. Supports file + image uploads.\n' +
  '6. Chat — student/friend chat rooms (Öffentlich / Freunde / Nur mit Einladung). Toggles: NSFW, Slow-mode.\n' +
  '7. Games — "🎮 Game Room" hub. Tetris, Chess, Flappy Bird, and Solitaire with 7 variants (Klondike, Spider, Freecell, Pyramid, Scorpion, TriPeaks, Vegas).\n' +
  '8. Study Lounge — total minutes, current/longest streak, opened files, per-course breakdown, weekly chart, Reset stats button.\n' +
  '9. Profile — account profile.\n' +
  '10. Settings — language DE/EN, German level + test type, sign-out, delete account.\n' +
  '11. Subscription — plan, period end, Stripe billing portal, PayPal pause/resume/cancel/reactivate, retention discount.\n' +
  '12. Admin — admin-only tools (visible only to admins).\n' +
  'Top bar "Study" = focus timer. Sidebar bottom "Night" = dark/light toggle. Footer: Impressum + Privacy Policy.\n\n' +

  'UPLOAD A DOCUMENT: 1) Click Courses in the sidebar. 2) Open the semester, open the course. ' +
  '3) On the Files tab, click "+ Upload" or drag-and-drop. Allowed: PDF, TXT, DOCX, PNG, JPG. Max 25 MB (6 MB for images). ' +
  '4) Indexing runs automatically; once finished, open the PDF and use the AI panel on the right.\n\n' +

  'PDF VIEWER: toolbar = Page/zoom/Fit/Single-page/Annotate/Download. Right rail = AI chat, Problem solver, Notes, Summary. ' +
  'Open a second PDF tab to enter split view (each pane has its own controls; Annotate + Download stay shared). ' +
  'Annotate popover: Pen / Highlight / Text / Eraser, six colours + custom, thickness, Undo, Clear, Save, Upload back to course.\n\n' +

  'PROBLEM SOLVER MODES (AI panel "Problem" button): Hint (nudge), Setup (Given/Required/Formula), Check (verify student work), Solve (full solution), Practice (similar problem).\n\n' +

  'GENERATING STUDY MATERIAL: inside a course, the Notes / Summaries / Quiz / Flashcards tabs each have a "Generate" button — pick source file(s) and options.\n\n' +

  'STYLE: Numbered steps. Name the exact UI element. Suggest the next action. ' +
  'Never claim you don\'t know which website you\'re in — you ARE Minallo AI on Minallo. ' +
  'If a feature does NOT exist in the map above, say so plainly; do not invent one.';

export function _resetScrollFollow(): void {
  _userScrolledUp = false;
  const el = document.getElementById('aiMsgs') || document.querySelector<HTMLElement>('.ai-msgs');
  if (el) el.scrollTop = el.scrollHeight;
}

export async function pdfToImages(maxPages?: number): Promise<string[]> {
  const pdfDoc = window.pdfDoc as PdfDocLike | null | undefined;
  if (!pdfDoc) return [];
  const currentPage = window.pdfPage && window.pdfPage >= 1 ? window.pdfPage : 1;
  return pdfDocToImages(pdfDoc, currentPage, maxPages);
}

async function pdfDocToImages(
  pdfDoc: PdfDocLike,
  currentPage: number = 1,
  maxPages?: number
): Promise<string[]> {
  const limit = maxPages || 6;
  const total = pdfDoc.numPages;
  const half = Math.floor(limit / 2);
  let startPage = Math.max(1, currentPage - half);
  const endPage = Math.min(total, startPage + limit - 1);
  if (endPage - startPage + 1 < limit) startPage = Math.max(1, endPage - limit + 1);
  const imgs: string[] = [];
  for (let i = startPage; i <= endPage; i++) {
    try {
      const page = await pdfDoc.getPage(i);
      const vp = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      const b64 = dataUrl.split(',')[1];
      if (b64) imgs.push(b64);
    } catch { /* skip failed page */ }
  }
  return imgs;
}

export function addTyping(): HTMLElement | null {
  const aiMsgs = document.getElementById('aiMsgs') || document.querySelector<HTMLElement>('.ai-msgs');
  if (!aiMsgs) return null;
  _ensureScrollTracker();
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg-wrap typing-wrap';
  wrap.innerHTML =
    '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
    '<div class="typing-bubble"><span></span><span></span><span></span></div>';
  aiMsgs.appendChild(wrap);
  _autoScroll(aiMsgs);
  return wrap;
}

// ── Per-course chat history (localStorage) ──────────────────────────────────
const _HISTORY_MAX = 40;
const _HISTORY_PREFIX = 'ss_course_qa_';

interface HistoryPair {
  q: string;
  a: string;
  ts?: number;
}

function _historyKey(courseId?: string | null): string {
  return _HISTORY_PREFIX + (courseId || 'default');
}
function _loadCourseHistory(courseId?: string | null): HistoryPair[] {
  try { return JSON.parse(localStorage.getItem(_historyKey(courseId)) || '[]'); } catch { return []; }
}
function _saveCourseHistory(courseId: string | null | undefined, pairs: HistoryPair[]): void {
  try {
    let trimmed = pairs;
    if (trimmed.length > _HISTORY_MAX) trimmed = trimmed.slice(trimmed.length - _HISTORY_MAX);
    localStorage.setItem(_historyKey(courseId), JSON.stringify(trimmed));
  } catch { /* quota */ }
}
function _appendCourseHistory(courseId: string | null | undefined, question: string, answer: string): void {
  const pairs = _loadCourseHistory(courseId);
  // If the most recent pair has the same question, this is a regenerate —
  // replace its answer instead of appending a duplicate pair. Without this,
  // restoring history after a regenerate renders both the old and the new
  // answer back-to-back.
  const last = pairs.length ? pairs[pairs.length - 1] : null;
  if (last && (last.q || '').trim() === (question || '').trim()) {
    last.a = answer;
    last.ts = Date.now();
  } else {
    pairs.push({ q: question, a: answer, ts: Date.now() });
  }
  _saveCourseHistory(courseId, pairs);
}

function _renderHistoryPairs(pairs: HistoryPair[] | null, aiMsgs: HTMLElement): void {
  if (!pairs || !pairs.length) return;
  pairs.forEach((pair) => {
    const uWrap = window.addUserMsg ? (window.addUserMsg as (text: string, skipSave?: boolean) => HTMLElement | null)(pair.q, true) : null;
    if (uWrap) uWrap.setAttribute('data-restored', 'true');
    const wrap = document.createElement('div');
    wrap.className = 'ai-msg-wrap';
    wrap.setAttribute('data-restored', 'true');
    wrap.innerHTML =
      '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
      '<div class="msg-body"><div class="ai-bubble bot restored-answer"></div></div>';
    const bubble = wrap.querySelector<HTMLElement>('.ai-bubble.bot');
    if (bubble) {
      bubble.setAttribute('data-raw', pair.a);
      const _doRender = (): void => {
        bubble.innerHTML = window.renderMarkdown ? window.renderMarkdown(pair.a) : escapeHtml(pair.a);
      };
      if (window._ssEnsureKatex) {
        window._ssEnsureKatex().then(_doRender).catch(_doRender);
      } else {
        _doRender();
      }
    }
    aiMsgs.appendChild(wrap);
  });
  aiMsgs.scrollTop = aiMsgs.scrollHeight;
}

export function restoreCourseHistory(courseId: string | null | undefined): void {
  if (!courseId) return;
  const aiMsgs = document.getElementById('aiMsgs') || document.querySelector<HTMLElement>('.ai-msgs');
  if (!aiMsgs) return;
  if (aiMsgs.querySelectorAll('.ai-msg-wrap:not(.typing-wrap)').length > 0) return;

  const supaUrl = window._SUPA || '';
  const tok = window._sbToken || '';
  if (supaUrl && tok) {
    fetch(
      supaUrl + '/rest/v1/chat_history?course_id=eq.' + encodeURIComponent(courseId) +
        '&order=created_at.asc&limit=40',
      {
        headers: {
          apikey: window._SAKEY || '',
          Authorization: 'Bearer ' + tok,
        },
      }
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((rows: Array<{ question: string; answer: string }> | null) => {
        if (rows && rows.length) {
          const pairs = rows.map((r) => ({ q: r.question, a: r.answer }));
          _renderHistoryPairs(pairs, aiMsgs);
        } else {
          _renderHistoryPairs(_loadCourseHistory(courseId), aiMsgs);
        }
      })
      .catch(() => {
        _renderHistoryPairs(_loadCourseHistory(courseId), aiMsgs);
      });
  } else {
    _renderHistoryPairs(_loadCourseHistory(courseId), aiMsgs);
  }
}

export function clearCourseHistory(courseId: string): void {
  try { localStorage.removeItem(_historyKey(courseId)); } catch { /* ignore */ }
  // Also drop the active Problem Solver context — a wiped chat shouldn't
  // inherit the previous session's PS overlay on its first new turn.
  try {
    const _w = window as unknown as { _activePsContext?: unknown };
    if (_w._activePsContext) _w._activePsContext = undefined;
  } catch { /* ignore */ }
}

export function initAskAI(
  state: AskAiState
): (
  question: string,
  skipUserBubble?: boolean,
  opts?: { forceRefresh?: boolean; problemSolver?: ProblemSolverOptions }
) => unknown {
  return function askAI(
    question: string,
    skipUserBubble?: boolean,
    opts?: { forceRefresh?: boolean; problemSolver?: ProblemSolverOptions }
  ): unknown {
    if (!question) return;
    // Persist Problem Solver context across follow-up turns. The first
    // submission from document-rail.ts arrives with opts.problemSolver
    // set; the student's reply ("I don't know") goes through the plain
    // chat input which calls askAI(q) with no opts. Without this, the
    // backend would see no problem_mode on turn 2 and fall back to
    // STRONG mode (full worked solution), breaking the Hint Ladder.
    const _w = window as unknown as { _activePsContext?: ProblemSolverOptions };
    if (opts?.problemSolver) {
      _w._activePsContext = opts.problemSolver;
    } else if (_w._activePsContext) {
      opts = { ...(opts || {}), problemSolver: _w._activePsContext };
    }
    if (window._abortCurrentStream) window._abortCurrentStream();
    state.generationStopped = false;
    state.currentGenId++;
    const myGenId = state.currentGenId;

    if (window.pinAI) window.pinAI();

    const _chatHistory = window.serializeChatDOM ? window.serializeChatDOM() : [];
    if (!skipUserBubble && window.addUserMsg) window.addUserMsg(question);

    const _aiSendBtn = document.getElementById('aiSend') as HTMLButtonElement | null;
    const _stopBtn = document.getElementById('stopBtn') as StopButton | null;
    if (_aiSendBtn) _aiSendBtn.disabled = true;
    if (_stopBtn) {
      _stopBtn.style.display = 'flex';
      if (!_stopBtn.__ssAbortBound) {
        _stopBtn.addEventListener('click', () => {
          if (window._abortCurrentStream) window._abortCurrentStream();
        });
        _stopBtn.__ssAbortBound = true;
      }
    }

    const aiMsgs = document.getElementById('aiMsgs')!;
    const aiPanel = document.getElementById('aiPanel');
    _ensureScrollTracker();
    _userScrolledUp = false;
    const _isProblemSolver = !!opts?.problemSolver;

    const thinkWrap = document.createElement('div');
    thinkWrap.className = 'ai-msg-wrap typing-wrap';
    thinkWrap.innerHTML =
      '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
      '<div class="typing-bubble"><span></span><span></span><span></span></div>';
    aiMsgs.appendChild(thinkWrap);
    aiMsgs.scrollTop = aiMsgs.scrollHeight;

    const pdfDoc = window.pdfDoc as PdfDocLike | null | undefined;
    let pdfFullText = window.pdfFullText || '';
    const _compareName = _isProblemSolver ? null : getCompareFileName();
    let _compareText = _compareName ? (getPane('right').pdfFullText || '') : '';
    const _comparePdfDoc = _compareName
      ? (getPane('right').pdfDoc as PdfDocLike | null)
      : null;
    const _lang = window._lang || localStorage.getItem('ss_lang') || 'en';
    const activeFileName = window.activeFileName || '';
    const currentCourseShort = window.currentCourseShort || '';
    const _MATH_PROMPT = (window as unknown as { _MATH_PROMPT?: string })._MATH_PROMPT || '';
    const _docList = _compareName
      ? '"' + activeFileName + '" AND "' + _compareName + '" (a second document the student is comparing against)'
      : '"' + activeFileName + '"';
    let sysPrompt =
      (window._userType === 'learner'
        ? 'You are Minallo, a German language tutor helping a student prepare for ' +
          (window._germanTest || 'a German exam') +
          (window._germanLevel ? ' at level ' + window._germanLevel : '') +
          '. Always reply in ' + (_lang === 'de' ? 'German' : 'English') +
          '. The student is reading ' + _docList +
          '. ALWAYS base your answers on the actual document content below. Be thorough but concise.'
        : 'You are Minallo, a friendly tutor for TU Braunschweig engineering students. Always reply in ' +
          (_lang === 'de' ? 'German' : 'English') +
          '. The student is reading ' + _docList + ' from ' + currentCourseShort +
          '. ALWAYS base your answers on the actual document content provided below. Do not use general knowledge when the document covers the topic. Be thorough but concise.') +
      MINALLO_APP_CONTEXT +
      _MATH_PROMPT;

    const _leftTextReady =
      pdfDoc && !pdfFullText.trim()
        ? extractPdfText(pdfDoc, 30).then((t) => {
            if (t) {
              window.pdfFullText = t;
              pdfFullText = t;
            }
          })
        : Promise.resolve();
    // Same on-demand extraction for the right (compare) pane. Without this,
    // a question asked right after toggling split runs before pdf-compare's
    // deferred extractText() completes, so the AI gets DOCUMENT 2 = "" and
    // silently answers from DOCUMENT 1 only.
    const _rightTextReady =
      _compareName && _comparePdfDoc && !_compareText.trim()
        ? extractPdfText(_comparePdfDoc, 30).then((t) => {
            if (t) {
              getPane('right').pdfFullText = t;
              _compareText = t;
            }
          })
        : Promise.resolve();
    const _textReady = Promise.all([_leftTextReady, _rightTextReady]);

    _textReady
      .then(() => {
        if (!pdfDoc) return [];
        const _pp = window.pdfPage as number | undefined;
        const _ppt = (window as unknown as { pdfPageTexts?: Record<number, string> }).pdfPageTexts;
        const _currentPageText = _pp && _ppt ? (_ppt[_pp] || '') : '';
        const _visibleTextWeak =
          pdfFullText.trim().length < 500 ||
          !_currentPageText.trim() ||
          _currentPageText.trim().length < 80;
        return _visibleTextWeak ? pdfToImages(1) : [];
      })
      .then(async (pageImages: string[]) => {
        let userContent: unknown;
        const isHandwritten = pdfFullText.trim().length < 100;
        if (pageImages.length) {
          sysPrompt += isHandwritten
            ? '\n\nThis document is handwritten or scanned. Pages are provided as images — read all handwritten text, equations, and diagrams carefully.'
            : '\n\nThe open PDF pages are included as images below. The document may contain handwritten solutions, diagrams, or worked examples alongside printed text. Read both the extracted text AND the images — if the images show a worked solution with specific values, use those exact values.';
          userContent = ([{ type: 'text', text: question }] as Array<Record<string, unknown>>).concat(
            pageImages.map((b64) => ({
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,' + b64 },
            }))
          );
        } else {
          if (_compareText) {
            sysPrompt +=
              '\n\nDOCUMENT 1 — "' + activeFileName + '":\n' + (pdfFullText || '(document text not yet extracted)') +
              '\n\nDOCUMENT 2 — "' + _compareName + '":\n' + _compareText;
          } else {
            sysPrompt +=
              '\n\nDOCUMENT CONTENT:\n' + (pdfFullText || '(document text not yet extracted)');
          }
          userContent = question;
        }

        const _courseId = window.activeCourseId || window.currentCourseId || '';
        let _activeDocId = (window as unknown as { activeRagDocumentId?: string | null }).activeRagDocumentId || null;
        // In split view, resolve the compare-pane doc ID too. The backend
        // treats documentIds as preference hints, while still searching the
        // whole course for professor lecture/formula support.
        let _compareDocId: string | null = null;
        if (_courseId) {
          try {
            const _docs: CourseDocument[] = await listCourseDocuments(_courseId);
            const _readyDocs = _docs.filter((d) => d.processing_status === 'ready');
            // If the user is reading a specific file, resolve its UUID so the
            // backend can boost that PDF without ignoring other course files.
            if (!_activeDocId && activeFileName) {
              const _open = _readyDocs.find(
                (d) => (d.file_name || '').toLowerCase() === activeFileName.toLowerCase()
              );
              if (_open?.id) _activeDocId = _open.id;
            }
            if (_compareName) {
              const _cmp = _readyDocs.find(
                (d) => (d.file_name || '').toLowerCase() === _compareName.toLowerCase()
              );
              if (_cmp?.id) _compareDocId = _cmp.id;
            }
          } catch { /* keep IDs as-is; backend will search the whole course */ }
        }

        // Extract a focused excerpt from the open PDF around the mentioned exercise/topic.
        let _openFileCtx = '';
        if (pdfFullText && pdfFullText.trim().length > 50) {
          const _rawText = pdfFullText;
          const _exercisePatterns: RegExp[] = [
            /\b(aufgabe\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(aufgabe\s*\d+\s*[a-z]\b)/i,
            /\b(ü?bung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(uebung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(beispiel\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(l[oö]sung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(loesung\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(teilaufgabe\s+[a-z\d])\b/i,
            /\b(exercise\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(task\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(problem\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(example\s*\d+[\.,]?\d*\s*[a-z]?)\b/i,
            /\b(\d+\.\d+[a-z]?)\b/i,
            /\b(\d+\s*[a-z]\s*\))/i,
            /\b(\d+[a-z])\b/i,
          ];
          const _subqPattern = /\b([a-d])\s*\)?$|\b(?:question|teil|part|aufgabe|mach|solve|löse)\s+([a-d])\b/i;
          const _subqMatch = question.match(_subqPattern);
          let _matchTerm: string | null = null;
          for (const pat of _exercisePatterns) {
            const _m = question.match(pat);
            if (_m && _m[0]) { _matchTerm = _m[0].trim(); break; }
          }
          if (_matchTerm) {
            const _normDe = (s: string): string =>
              s.replace(/ü/g, 'ue').replace(/ö/g, 'oe').replace(/ä/g, 'ae')
                .replace(/Ü/g, 'Ue').replace(/Ö/g, 'Oe').replace(/Ä/g, 'Ae')
                .replace(/ß/g, 'ss').toLowerCase();
            const _normTerm = _normDe(_matchTerm);
            const _normText = _normDe(_rawText);
            let _idx = _normText.indexOf(_normTerm);
            if (_idx < 0) {
              const _compactTerm = _normTerm.replace(/\s+/g, '');
              const _compactText = _normText.replace(/\s+/g, '');
              const _cidx = _compactText.indexOf(_compactTerm);
              if (_cidx >= 0) {
                let _charCount = 0;
                let _rawIdx = 0;
                for (let _ri = 0; _ri < _rawText.length && _charCount < _cidx; _ri++) {
                  if (_rawText[_ri]!.trim()) _charCount++;
                  _rawIdx = _ri;
                }
                _idx = _rawIdx;
              }
            }
            if (_idx >= 0) {
              (window as unknown as { _lastExerciseIdx?: number })._lastExerciseIdx = _idx;
              _openFileCtx = _rawText.slice(Math.max(0, _idx - 600), _idx + 8000);
            }
          }
          const _lastExerciseIdx = (window as unknown as { _lastExerciseIdx?: number })._lastExerciseIdx;
          if (!_openFileCtx && _subqMatch && _lastExerciseIdx != null) {
            const _subqLetter = (_subqMatch[1] || _subqMatch[2] || '').toLowerCase();
            const _exerciseSlice = _rawText.slice(_lastExerciseIdx, _lastExerciseIdx + 4000);
            const _subqRel = _subqLetter
              ? _exerciseSlice.search(new RegExp('\\b' + _subqLetter + '\\s*[\\)\\.]', 'i'))
              : -1;
            if (_subqRel > 0) {
              const _subqAbs = _lastExerciseIdx + _subqRel;
              _openFileCtx = _rawText.slice(Math.max(0, _subqAbs - 600), _subqAbs + 6000);
            } else {
              _openFileCtx = _rawText.slice(Math.max(0, _lastExerciseIdx - 600), _lastExerciseIdx + 8000);
            }
          }
          if (!_openFileCtx) {
            // No exercise term matched — fall back to the page the user is
            // currently looking at, since their question is most likely about
            // what's on screen. pdfPageTexts is populated per page as it
            // renders (or pre-extracted up front by pdf-viewer). Falls all
            // the way back to the document start only as a last resort.
            const _pp = window.pdfPage as number | undefined;
            const _ppt = (window as unknown as { pdfPageTexts?: Record<number, string> }).pdfPageTexts;
            const _pageParts: string[] = [];
            if (_pp && _ppt) {
              [_pp - 1, _pp, _pp + 1].forEach((pageNo) => {
                const pageText = _ppt[pageNo];
                if (pageNo > 0 && pageText && pageText.trim().length > 30) {
                  _pageParts.push('[PDF page ' + pageNo + ']\n' + pageText.trim());
                }
              });
            }
            const _currentPageText = _pageParts.join('\n\n');
            if (_currentPageText && _currentPageText.trim().length > 60) {
              _openFileCtx = _currentPageText.slice(0, 12000);
            } else {
              _openFileCtx = _rawText.slice(0, 12000);
            }
          }
        }
        const _currentPageNo = window.pdfPage && window.pdfPage >= 1 ? window.pdfPage : 1;
        const _visibleTextWeak =
          !!pdfDoc &&
          (
            isHandwritten ||
            !_openFileCtx ||
            _openFileCtx.trim().length < 500
          );
        let _openFileImages = _visibleTextWeak && pageImages[0]
          ? [{ mediaType: 'image/jpeg', data: pageImages[0], page: _currentPageNo }]
          : undefined;
        let _streamActiveFileName = activeFileName;
        let _streamOpenFileCtx = _openFileCtx;
        if (_compareName) {
          const _leftExcerpt = (_openFileCtx || pdfFullText || '').slice(0, 9500);
          const _rightExcerpt = _compareText.slice(0, 9500);
          const _rightPane = getPane('right');
          const _rightPageNo = _rightPane.pdfPage && _rightPane.pdfPage >= 1 ? _rightPane.pdfPage : 1;
          const _rightTextWeak = !_rightExcerpt || _rightExcerpt.trim().length < 500;
          let _splitImages = _openFileImages ? [..._openFileImages] : [];
          if (_rightTextWeak && _comparePdfDoc) {
            const _rightImages = await pdfDocToImages(_comparePdfDoc, _rightPageNo, 1);
            if (_rightImages[0]) {
              _splitImages.push({ mediaType: 'image/jpeg', data: _rightImages[0], page: _rightPageNo });
            }
          }
          if (_splitImages.length) _openFileImages = _splitImages.slice(0, 2);
          _streamActiveFileName = activeFileName
            ? activeFileName + ' + ' + _compareName
            : _compareName;
          _streamOpenFileCtx =
            'SPLIT VIEW: the student has two PDFs open and is asking about both. ' +
            'Use BOTH documents when the question asks what they contain, to compare them, or to use both as sources.\n\n' +
            'DOCUMENT 1 — "' + (activeFileName || 'left PDF') + '":\n' +
            (_leftExcerpt || '(left PDF text not yet extracted)') +
            '\n\nDOCUMENT 2 — "' + _compareName + '":\n' +
            (_rightExcerpt || '(right PDF text not yet extracted)');
        }

        // RAG-first routing: any question with a course_id goes through
        // /ask-stream so the Phase-1 verification + math-template gating +
        // confidence-from-verification on the Python backend always apply.
        // The previous gate (`if (_hasRag)`) let questions fall through to
        // free-form Claude whenever the course had zero ready docs or
        // listCourseDocuments() failed transiently — bypassing all grounding
        // and letting the model invent textbook formulas. /ask-stream
        // handles the "no chunks" case correctly (returns the weak prompt
        // with low confidence) so it's safe to always prefer it.
        if (_courseId) {
          const _modeToggle = document.getElementById('aiModeStrict') as HTMLInputElement | null;
          const _ragMode = !_modeToggle || _modeToggle.checked ? 'strict' : 'general';

          return new Promise<AiResponse>((resolve) => {
            const token = window._sbToken || '';

            let ansWrap: HTMLElement | null = null;
            let bubble: HTMLElement | null = null;
            let rawText = '';
            const metaPattern = /<!--META-->[\s\S]*?<!--\/META-->/g;
            const _tokenQueue: string[] = [];
            let _renderTimer: ReturnType<typeof setTimeout> | null = null;
            let _pendingMeta: SseDoneEvent | null | undefined = undefined;
            const CFG = window.AI_TYPING || ({} as Partial<NonNullable<Window['AI_TYPING']>>);
            const TOKEN_INTERVAL = CFG.streamTokenInterval || 38;

            let _renderedBlockCount = 0;
            // Both `evt.done` and the reader's `result.done` can race to call
            // finalize() — guard so history/feedback bar aren't doubled.
            let _finalized = false;

            function splitBlocks(text: string): string[] {
              const blocks: string[] = [];
              const lines = text.split('\n');
              let buf: string[] = [];
              let inCode = false;
              let inMath = false;
              let inLatex = false;
              for (let i = 0; i < lines.length; i++) {
                const line = lines[i] ?? '';
                if (!inCode && /^```/.test(line)) inCode = true;
                else if (inCode && /^```/.test(line)) { buf.push(line); inCode = false; blocks.push(buf.join('\n')); buf = []; continue; }
                if (!inLatex && /^\s*\\\[/.test(line)) inLatex = true;
                else if (inLatex && /\\\]/.test(line)) { buf.push(line); inLatex = false; blocks.push(buf.join('\n')); buf = []; continue; }
                if (!inMath && /^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line)) inMath = true;
                else if (inMath && /\$\$/.test(line)) { buf.push(line); inMath = false; blocks.push(buf.join('\n')); buf = []; continue; }
                if (!inCode && !inMath && !inLatex && line.trim() === '' && buf.length) {
                  blocks.push(buf.join('\n'));
                  buf = [];
                } else {
                  buf.push(line);
                }
              }
              if (buf.length) blocks.push(buf.join('\n'));
              return blocks.filter((b) => b.trim());
            }

            function renderBlock(_text: string): HTMLElement {
              const div = document.createElement('div');
              div.className = 'ss-rendered-block';
              div.style.opacity = '0';
              div.style.transition = 'opacity 0.2s ease';
              return div;
            }

            function applyKatexToBlock(div: HTMLElement, text: string): void {
              const done = (): void => {
                div.innerHTML = window.renderMarkdown ? window.renderMarkdown(text) : escapeHtml(text);
                div.style.opacity = '1';
                _autoScroll(aiMsgs);
              };
              if (window._ssEnsureKatex) {
                window._ssEnsureKatex().then(done).catch(() => {
                  div.innerHTML = window.renderMarkdown ? window.renderMarkdown(text) : escapeHtml(text);
                  div.style.opacity = '1';
                });
              } else {
                done();
              }
            }

            function updateBlockRender(): void {
              if (!bubble) return;
              // Keep data-raw current with the accumulated stream so serializers
              // (per-file save in chat.js, per-course in ai-message-actions.ts)
              // can persist the in-progress text properly. Without this, if a
              // save fires mid-stream (panel close, course switch, page unload),
              // serializeChatDOM falls back to textContent which flattens the
              // rendered KaTeX/markdown HTML and produces a cropped/corrupted
              // answer on reload.
              bubble.setAttribute('data-raw', rawText);
              const display = rawText.replace(metaPattern, '').trimEnd();
              const blocks = splitBlocks(display);

              let typingSpan = bubble.querySelector<HTMLElement>('.ss-typing-span');
              if (!typingSpan) {
                typingSpan = document.createElement('span');
                typingSpan.className = 'ss-typing-span';
                typingSpan.style.whiteSpace = 'pre-wrap';
                bubble.appendChild(typingSpan);
              }

              const completedCount = blocks.length - 1;
              while (_renderedBlockCount < completedCount) {
                const blockText = stripSourceMarkers(blocks[_renderedBlockCount] || '');
                const div = renderBlock(blockText);
                bubble.insertBefore(div, typingSpan);
                applyKatexToBlock(div, blockText);
                _renderedBlockCount++;
              }

              const typingText = stripSourceMarkers((blocks[blocks.length - 1] || '').replace(/<!--META-->[\s\S]*$/, ''));
              typingSpan.textContent = typingText;
              _autoScroll(aiMsgs);
            }

            function fullRender(text: string): void {
              if (!bubble) return;
              const display = stripSourceMarkers(text.replace(metaPattern, '').trim());
              if (!display) return;
              const _doFullRender = (): void => {
                if (!bubble) return;
                bubble.innerHTML = window.renderMarkdown ? window.renderMarkdown(display) : escapeHtml(display);
                _autoScroll(aiMsgs);
              };
              if (window._ssEnsureKatex) {
                window._ssEnsureKatex().then(_doFullRender).catch(_doFullRender);
              } else {
                _doFullRender();
              }
            }

            function drainQueue(): void {
              if (!_tokenQueue.length) {
                _renderTimer = null;
                if (_pendingMeta !== undefined) finalize(_pendingMeta);
                return;
              }
              const tok = _tokenQueue.shift()!;
              rawText += tok;
              if (bubble) updateBlockRender();
              _renderTimer = setTimeout(drainQueue, TOKEN_INTERVAL);
            }

            function queueToken(tok: string): void {
              _tokenQueue.push(tok);
              if (!_renderTimer) _renderTimer = setTimeout(drainQueue, TOKEN_INTERVAL);
            }

            window._activeStreamRender = function (): void {
              if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
              while (_tokenQueue.length) rawText += _tokenQueue.shift()!;
              fullRender(rawText);
            };

            function ensureBubble(): void {
              if (ansWrap) return;
              thinkWrap.style.transition = 'opacity .15s';
              thinkWrap.style.opacity = '0';
              setTimeout(() => thinkWrap.remove(), 160);

              ansWrap = document.createElement('div');
              ansWrap.className = 'ai-msg-wrap';
              ansWrap.innerHTML =
                '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
                '<div class="msg-body"><div class="ai-bubble bot" style="min-height:20px"></div></div>';
              aiMsgs.appendChild(ansWrap);
              _autoScroll(aiMsgs);
              bubble = ansWrap.querySelector<HTMLElement>('.ai-bubble.bot');
              // Mark the bubble as actively streaming so serializers know to
              // either skip it or persist its data-raw value rather than the
              // partially-rendered DOM contents.
              if (bubble) bubble.setAttribute('data-streaming', 'true');
            }

            const _streamController = new AbortController();
            window._abortCurrentStream = (): void => _streamController.abort();

            // Collect the last 4 messages (≈ 2 Q&A pairs) so the backend can
            // resolve follow-up references like "explain the formula above"
            // without having to re-derive them from retrieval alone. Backend
            // hard-caps this further (max 6 messages, 2k chars total), so
            // it's safe to send a few more here than strictly needed.
            let _previousTurns: Array<{ role: string; text: string }> = [];
            try {
              const _allMsgs = typeof window.serializeChatDOM === 'function'
                ? window.serializeChatDOM()
                : [];
              // Drop the current user message if it's already in the DOM
              // (addUserMsg ran above). We want prior turns, not the one
              // being asked right now.
              const _prior: Array<{ role: string; text: string }> = [];
              for (let _ci = _allMsgs.length - 1; _ci >= 0; _ci--) {
                const m = _allMsgs[_ci]!;
                const _txt = (m.text || '').trim();
                if (!_txt) continue;
                if (m.role === 'user' && _txt === question.trim()) continue; // skip current
                _prior.unshift({ role: m.role, text: _txt });
                if (_prior.length >= 4) break;
              }
              _previousTurns = _prior;
            } catch { /* ignore — sending [] is safe */ }

            const _aiHost = (window.AI_SERVICE_URL || '').replace(/\/$/, '');
            if (!_aiHost) { fallbackToRag(); return; }

            fetch(_aiHost + '/ask-stream', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
              signal: _streamController.signal,
              body: JSON.stringify({
                // documentIds is a preference hint for answer quality. Even
                // in split view, the backend still searches the whole course
                // so professor lecture/formula PDFs can support the answer.
                courseId: _courseId,
                question: question,
                documentIds:
                  _activeDocId && _compareDocId
                    ? [_activeDocId, _compareDocId]
                    : undefined,
                activeDocumentId: _activeDocId || undefined,
                // Tell the backend which file the user is reading and give it
                // a slice of the actually-visible text. Without this the model
                // sees only retrieved chunks, which can miss the section the
                // user is pointing at when they say "this question".
                activeFileName: _streamActiveFileName || undefined,
                openFileContext: _streamOpenFileCtx || undefined,
                openFileImages: _openFileImages,
                // Recent chat history so the model can resolve anaphoric
                // references ("the formula above", "explain that again").
                previousTurns: _previousTurns.length ? _previousTurns : undefined,
                // Problem Solver modes carry their own behavior contract.
                // Keep the base mode direct so "Solve" can produce the full
                // answer instead of inheriting the Socratic tutor overlay.
                tutorMode: 'explain',
                problemSolver: opts?.problemSolver || undefined,
                bypassCache: opts && opts.forceRefresh ? true : undefined,
              }),
            })
              .then((res) => {
                if (!res.ok || !res.body || !res.body.getReader) { fallbackToRag(); return; }
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let sseBuffer = '';
                function read(): void {
                  reader.read().then((result) => {
                    if (result.done) { finalize(_pendingMeta || null); return; }
                    sseBuffer += decoder.decode(result.value, { stream: true });
                    const lines = sseBuffer.split('\n');
                    sseBuffer = lines.pop() || '';
                    lines.forEach((line) => {
                      if (!line.startsWith('data: ')) return;
                      try {
                        const evt = JSON.parse(line.slice(6)) as Partial<SseDoneEvent> & { t?: string; error?: unknown };
                        if (evt.t) {
                          ensureBubble();
                          queueToken(evt.t);
                        }
                        if (evt.done) {
                          _pendingMeta = evt as SseDoneEvent;
                          if (!_renderTimer && !_tokenQueue.length) finalize(_pendingMeta);
                        }
                        if (evt.error) fallbackToRag();
                      } catch { /* ignore malformed line */ }
                    });
                    read();
                  }).catch(() => fallbackToRag());
                }
                read();
              })
              .catch((err: unknown) => {
                if (err && (err as { name?: string }).name === 'AbortError') {
                  if (thinkWrap && thinkWrap.parentNode) thinkWrap.remove();
                  // Drop a partial streaming bubble entirely instead of letting
                  // its cropped contents get persisted by saveChatForFile on
                  // the next unload/showPortal trigger. The user explicitly
                  // aborted — don't overwrite the prior complete answer (which
                  // still lives in localStorage / Supabase) with a half-stream.
                  if (ansWrap && ansWrap.querySelector('.ai-bubble.bot[data-streaming="true"]')) {
                    ansWrap.remove();
                    ansWrap = null;
                  }
                  const _sb = document.getElementById('aiSend') as HTMLButtonElement | null;
                  if (_sb) _sb.disabled = false;
                  const _st = document.getElementById('stopBtn');
                  if (_st) _st.style.display = 'none';
                  resolve({ content: [{ text: '' }] });
                } else {
                  fallbackToRag();
                }
              });

            function fallbackToRag(): void {
              if (ansWrap) ansWrap.remove();
              if (thinkWrap && !thinkWrap.parentNode) {
                thinkWrap.className = 'ai-msg-wrap typing-wrap';
                thinkWrap.innerHTML =
                  '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
                  '<div class="typing-bubble"><span></span><span></span><span></span></div>';
                aiMsgs.appendChild(thinkWrap);
              }
              sendRagRequest(
                _courseId,
                question,
                _ragMode,
                _activeDocId || undefined,
                _streamActiveFileName || undefined,
                _streamOpenFileCtx || undefined
              )
                .then((data: RagAskResponse) => {
                  if (thinkWrap && thinkWrap.parentNode) thinkWrap.remove();
                  let answer = stripSourceMarkers(data.answer || 'No answer found.');
                  resolve({ content: [{ text: answer }], _ragData: data as unknown as AiResponse['_ragData'] });
                })
                .catch((err: unknown) => {
                  if (thinkWrap && thinkWrap.parentNode) thinkWrap.remove();
                  const msg = err instanceof Error ? ' (' + err.message + ')' : '';
                  resolve({ content: [{ text: '❌ Could not reach the AI' + msg + '. Please try again.' }] });
                });
            }

            function finalize(meta: SseDoneEvent | null | undefined): void {
              if (_finalized) return;
              _finalized = true;
              window._activeStreamRender = null;
              const sources = (meta && meta.sources) || [];
              const unsupported = !!(meta && meta.unsupported);

              const cleanText = stripSourceMarkers(rawText.replace(metaPattern, '').trim());
              if (!cleanText) {
                if (ansWrap) { ansWrap.remove(); ansWrap = null; }
                fallbackToRag();
                return;
              }

              let fullAnswer = cleanText;
              if (unsupported && !sources.length) {
                fullAnswer =
                  '⚠️ *No matching course materials found — answering from general knowledge.*\n\n' +
                  fullAnswer;
              }
              if (_ragMode === 'general') fullAnswer += '\n\n🌐 general mode';

              const _cacheId = (meta && meta.answerCacheId) || null;
              (window as unknown as { _lastRagMeta?: RagMeta })._lastRagMeta = {
                courseId: _courseId,
                question,
                answerCacheId: _cacheId,
              };

              _appendCourseHistory(_courseId, question, fullAnswer);

              if (bubble) {
                bubble.setAttribute('data-raw', fullAnswer);
                bubble.removeAttribute('data-streaming');
              }

              fullRender(fullAnswer);
              appendSourcesDropdown(bubble, sources);

              if (ansWrap && !ansWrap.querySelector('.rag-feedback-bar')) {
                const _mb = ansWrap.querySelector<HTMLElement>('.msg-body');
                if (_mb) {
                  _mb.appendChild(
                    _buildRagFeedbackBar({ courseId: _courseId, question, answerCacheId: _cacheId })
                  );
                }
              }

              resolve({
                content: [{ text: fullAnswer }],
                _streamWrap: ansWrap,
                _ragData: meta as unknown as AiResponse['_ragData'],
              });
            }
          });
        }

        let prior = _chatHistory.slice(-20);
        let firstUser = 0;
        while (firstUser < prior.length && prior[firstUser]!.role !== 'user') firstUser++;
        prior = prior.slice(firstUser);
        const messages: AiMessage[] = [];
        prior.forEach((m) => {
          messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text || '' });
        });
        messages.push({ role: 'user', content: userContent });

        return sendAiRequest({ max_tokens: 1024, system: sysPrompt, messages });
      })
      .then((data: unknown) => {
        const d = data as AiResponse;
        if (myGenId !== state.currentGenId) {
          if (!d._streamWrap) thinkWrap.remove();
          return;
        }

        if (d._streamWrap) {
          const streamBubble = d._streamWrap.querySelector<HTMLElement>('.ai-bubble.bot');
          const rawFinal = d.content ? d.content.map((b) => b.text || '').join('') : '';
          if (streamBubble) {
            const _typingSpan = streamBubble.querySelector('.ss-typing-span');
            if (_typingSpan) _typingSpan.remove();
            if (window._ssEnsureKatex) {
              window._ssEnsureKatex().then(() => {
                if (window._renderMath && streamBubble) window._renderMath(streamBubble);
                if (window._renderCode && streamBubble) window._renderCode(streamBubble);
                streamBubble.querySelectorAll<HTMLElement>('.ss-rendered-block').forEach((sd) => {
                  sd.style.opacity = '1';
                });
                _autoScroll(aiMsgs);
              }).catch(() => {});
            }
          }
          if (window._aiResponseActions && rawFinal && !d._streamWrap.querySelector('.ai-action-bar')) {
            const mb = d._streamWrap.querySelector<HTMLElement>('.msg-body');
            if (mb) {
              const actions = window._aiResponseActions(rawFinal, 'panel') as Node | null;
              if (actions) mb.appendChild(actions);
            }
          }
          const _sb0 = document.getElementById('aiSend') as HTMLButtonElement | null;
          if (_sb0) _sb0.disabled = false;
          const _st0 = document.getElementById('stopBtn');
          if (_st0) _st0.style.display = 'none';
          if (window.spawnConfetti) window.spawnConfetti();
          _autoScroll(aiMsgs);
          return;
        }

        if (thinkWrap && thinkWrap.parentNode) {
          thinkWrap.style.transition = 'opacity .3s';
          thinkWrap.style.opacity = '0';
          setTimeout(() => thinkWrap.remove(), 320);
        }

        const _ragMeta: RagMeta | null = d._ragData
          ? {
              courseId: window.activeCourseId || '',
              question,
              answerCacheId: (d._ragData.id as string | undefined) || null,
            }
          : null;

        const rawTextLocal = d.error
          ? _isSubscriptionError(d.error.message || '')
            ? _subscriptionMsg()
            : '❌ Error: ' + (d.error.message || JSON.stringify(d.error))
          : d.content
            ? d.content.map((b) => b.text || '').join('')
            : 'No response';
        const displayTextLocal = d._ragData ? stripSourceMarkers(rawTextLocal) : rawTextLocal;

        // Persist non-RAG answers too. The RAG/stream path saves history inside
        // finalize(); without this the non-RAG branch silently dropped chat
        // history on reload for users with no indexed course docs.
        if (!d.error && displayTextLocal && displayTextLocal !== 'No response') {
          _appendCourseHistory(window.activeCourseId || window.currentCourseId || '', question, displayTextLocal);
        }

        const ansWrap = document.createElement('div');
        ansWrap.className = 'ai-msg-wrap';
        const tNow = _getTime();
        ansWrap.innerHTML =
          '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
          '<div class="msg-body">' +
          '<div class="ai-bubble bot" style="min-height:20px"></div>' +
          '<div class="msg-meta" style="display:none">' +
          '<span class="msg-time">' + tNow + '</span>' +
          '<button class="msg-action-btn" data-action="copy">' +
          (window._t ? window._t('copy_btn') : 'Copy') +
          '</button>' +
          '</div>' +
          '</div>';
        bindMessageActionButtons(ansWrap);
        aiMsgs.appendChild(ansWrap);
        _autoScroll(aiMsgs);

        setTimeout(() => {
          const bubble = ansWrap.querySelector<HTMLElement>('.ai-bubble.bot');
          const meta = ansWrap.querySelector<HTMLElement>('.msg-meta');
          if (!bubble || !meta) return;
          const tokens = displayTextLocal.match(/\S+\s*/g) || [];
          let idx = 0;
          let displayed = '';
          const _fbCfg = window.AI_TYPING || ({} as Partial<NonNullable<Window['AI_TYPING']>>);
          const WORDS_PER_FRAME = _fbCfg.fallbackWordsPerFrame || 1;
          const FRAME_INTERVAL = _fbCfg.fallbackFrameInterval || 38;

          function frame(): void {
            if (state.generationStopped || myGenId !== state.currentGenId) {
              bubble!.innerHTML = window.renderMarkdown
                ? window.renderMarkdown(displayed)
                : displayed;
              meta!.style.display = 'flex';
              const eb = ansWrap.querySelector('.ai-action-bar');
              if (!eb && displayed.trim() && window._aiResponseActions) {
                const mb = ansWrap.querySelector<HTMLElement>('.msg-body');
                const actions = window._aiResponseActions(displayed, 'panel') as Node | null;
                if (mb && actions) mb.appendChild(actions);
              }
              return;
            }
            if (idx >= tokens.length) {
              bubble!.innerHTML = window.renderMarkdown ? window.renderMarkdown(displayTextLocal) : escapeHtml(displayTextLocal);
              appendSourcesDropdown(bubble, (d._ragData as RagAskResponse | undefined)?.sources);
              if (window._renderMath) window._renderMath(bubble);
              if (window._renderCode) window._renderCode(bubble);
              meta!.style.display = 'flex';
              if (!ansWrap.querySelector('.ai-action-bar') && window._aiResponseActions) {
                const mb = ansWrap.querySelector<HTMLElement>('.msg-body');
                const actions = window._aiResponseActions(displayTextLocal, 'panel') as Node | null;
                if (mb && actions) mb.appendChild(actions);
              }
              if (_ragMeta && !ansWrap.querySelector('.rag-feedback-bar')) {
                const mb = ansWrap.querySelector<HTMLElement>('.msg-body');
                if (mb) mb.appendChild(_buildRagFeedbackBar(_ragMeta));
              }
              const _sb1 = document.getElementById('aiSend') as HTMLButtonElement | null;
              if (_sb1) _sb1.disabled = false;
              const _st1 = document.getElementById('stopBtn');
              if (_st1) _st1.style.display = 'none';
              if (window.spawnConfetti) window.spawnConfetti();
              state.activeTypeTimer = null;
              return;
            }
            const appEl = document.getElementById('app');
            const panelHidden =
              document.hidden ||
              !!(appEl && appEl.style.display === 'none') ||
              !aiPanel!.classList.contains('visible');
            const batch = panelHidden ? tokens.length : WORDS_PER_FRAME;
            for (let w = 0; w < batch && idx < tokens.length; w++) displayed += tokens[idx++];
            bubble!.innerHTML =
              (window.renderMarkdown ? window.renderMarkdown(displayed) : escapeHtml(displayed)) +
              (idx < tokens.length ? '<span class="stream-cursor">▋</span>' : '');
            if (!panelHidden && aiMsgs.scrollHeight - aiMsgs.scrollTop - aiMsgs.clientHeight < 80) {
              aiMsgs.scrollTop = aiMsgs.scrollHeight;
            }
            state.activeTypeTimer = setTimeout(frame, panelHidden ? 0 : FRAME_INTERVAL);
          }

          state.activeTypeTimer = setTimeout(frame, FRAME_INTERVAL);
        }, 60);
      })
      .catch((e: unknown) => {
        thinkWrap.remove();
        const msg = e instanceof Error ? e.message : String(e);
        if (window.addBotMsg)
          window.addBotMsg(_isSubscriptionError(msg) ? _subscriptionMsg() : '❌ Error: ' + msg);
        const _sb2 = document.getElementById('aiSend') as HTMLButtonElement | null;
        if (_sb2) _sb2.disabled = false;
        const _st2 = document.getElementById('stopBtn');
        if (_st2) _st2.style.display = 'none';
      });
  };
}

function _buildRagFeedbackBar(meta: RagMeta): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'rag-feedback-bar';
  bar.innerHTML =
    '<span class="rag-fb-label">Was this helpful?</span>' +
    '<button class="rag-fb-btn rag-fb-yes" title="Helpful">👍</button>' +
    '<button class="rag-fb-btn rag-fb-no" title="Not helpful">👎</button>' +
    '<button class="rag-fb-btn rag-fb-wrong" title="Wrong answer">⚠️</button>' +
    '<button class="rag-fb-btn rag-fb-cite" title="Missing citation">📄</button>';

  function _send(rating: string): void {
    bar.querySelectorAll<HTMLButtonElement>('.rag-fb-btn').forEach((b) => {
      b.disabled = true;
    });
    const label = bar.querySelector('.rag-fb-label');
    if (label) label.textContent = 'Thanks for your feedback!';
    submitRagFeedback(meta.courseId, meta.question, rating, meta.answerCacheId || null).catch(() => {});
  }

  bar.querySelector('.rag-fb-yes')?.addEventListener('click', () => _send('helpful'));
  bar.querySelector('.rag-fb-no')?.addEventListener('click', () => _send('not_helpful'));
  bar.querySelector('.rag-fb-wrong')?.addEventListener('click', () => _send('wrong_answer'));
  bar.querySelector('.rag-fb-cite')?.addEventListener('click', () => _send('missing_citation'));

  return bar;
}
