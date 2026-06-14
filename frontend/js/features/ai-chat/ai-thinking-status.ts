import { escapeHtml } from '../../utils/escape-html.js';

export type ThinkingContext =
  | 'exercise-solver'
  | 'course-qa'
  | 'summary'
  | 'quiz'
  | 'flashcards'
  | 'general';

export interface AIThinkingStatus {
  el: HTMLElement;
  set: (text: string) => void;
  remove: (immediate?: boolean) => void;
  waitMinimum: () => Promise<void>;
}

interface ThinkingContextInput {
  problemSolver?: unknown;
  tool?: string | null;
  tutorMode?: string | null;
  hasCourseMaterial?: boolean;
  courseId?: string | null;
  selectedCourseId?: string | null;
  selectedSourceCount?: number;
  filesCount?: number;
  question?: string;
}

interface CreateThinkingStatusOptions {
  context: ThinkingContext;
  host: HTMLElement | null;
  surface?: 'panel' | 'chatbot';
  compact?: boolean;
  minimumMs?: number;
  rotateMs?: number;
  append?: boolean;
}

const FIRST_THINKING_MESSAGE = 'Retrieving relevant content';

const THINKING_MESSAGES: Record<ThinkingContext, string[]> = {
  'exercise-solver': [
    'Analyzing the exercise',
    'Setting up the equations',
    'Preparing the solution'
  ],
  'course-qa': [
    'Checking course material',
    'Matching the question with your documents',
    'Preparing the explanation'
  ],
  summary: [
    'Reading the material',
    'Extracting key points',
    'Preparing the summary'
  ],
  quiz: [
    'Finding key concepts',
    'Creating quiz questions',
    'Preparing the quiz'
  ],
  flashcards: [
    'Extracting definitions',
    'Finding important concepts',
    'Preparing flashcards'
  ],
  general: ['Understanding your question', 'Preparing the answer']
};

function messagesForContext(context: ThinkingContext): string[] {
  return [FIRST_THINKING_MESSAGE, ...(THINKING_MESSAGES[context] || THINKING_MESSAGES.general)];
}

export function getThinkingContext(input: ThinkingContextInput = {}): ThinkingContext {
  const tool = String(input.tool || '').toLowerCase();
  const question = String(input.question || '').toLowerCase();
  const tutorMode = String(input.tutorMode || '').toLowerCase();

  if (input.problemSolver || tutorMode === 'solve') return 'exercise-solver';
  if (tool === 'summary' || /\bsummari[sz]e\b|\bsummary\b/.test(question)) return 'summary';
  if (tool === 'quiz' || tutorMode === 'quiz' || /\bquiz\b/.test(question)) return 'quiz';
  if (tool === 'flashcards' || /\bflashcards?\b/.test(question)) return 'flashcards';
  if (
    input.hasCourseMaterial ||
    input.courseId ||
    input.selectedCourseId ||
    (input.selectedSourceCount || 0) > 0 ||
    (input.filesCount || 0) > 0
  ) {
    return 'course-qa';
  }
  return 'general';
}

function thinkingHtml(text: string, surface: 'panel' | 'chatbot', compact: boolean): string {
  const classes =
    'ai-thinking-card' +
    (surface === 'chatbot' ? ' ai-thinking-card--chatbot' : '') +
    (compact ? ' ai-thinking-card--compact' : '');
  if (surface === 'panel') {
    // Side panel: subtle ChatGPT-style dots only — no status copy, no orb,
    // no tool names. Status text still lands in a screen-reader-only span
    // so assistive tech keeps getting the progress updates.
    return (
      '<div class="' + classes + ' ai-thinking-card--dots" aria-live="polite" role="status">' +
      '<span class="ai-thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
      '<span class="ai-thinking-sr">' + escapeHtml(displayThinkingText(text)) + '</span>' +
      '</div>'
    );
  }
  return (
    '<div class="' + classes + '" aria-live="polite">' +
    '<span class="ai-thinking-orb" aria-hidden="true">' +
    '<span class="ai-thinking-orb-core"></span>' +
    '</span>' +
    '<span class="ai-thinking-copy">' +
    '<span class="ai-thinking-text">' + escapeHtml(displayThinkingText(text)) + '</span>' +
    '<span class="ai-thinking-wave" aria-hidden="true"><span></span><span></span><span></span></span>' +
    '</span>' +
    '</div>'
  );
}

function displayThinkingText(text: string): string {
  return (text || FIRST_THINKING_MESSAGE).replace(/\.*$/, '');
}

export function createAIThinkingStatus(options: CreateThinkingStatusOptions): AIThinkingStatus | null {
  const host = options.host;
  if (!host) return null;

  const surface = options.surface || 'panel';
  const messages = messagesForContext(options.context);
  const minimumMs = Math.max(options.minimumMs ?? 500, 0);
  const rotateMs = Math.max(options.rotateMs ?? 800, 500);
  const createdAt = Date.now();
  const append = options.append !== false;

  const wrap = document.createElement('div');
  wrap.className =
    surface === 'chatbot'
      ? 'ai-thinking-status ai-thinking-status--chatbot'
      : 'ai-msg-wrap typing-wrap ai-thinking-status';
  wrap.setAttribute('data-ai-transient', 'thinking');

  if (surface === 'chatbot') {
    wrap.innerHTML = thinkingHtml(messages[0] || FIRST_THINKING_MESSAGE, surface, !!options.compact);
  } else {
    wrap.innerHTML =
      '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
      '<div class="msg-body">' +
      thinkingHtml(messages[0] || FIRST_THINKING_MESSAGE, surface, !!options.compact) +
      '</div>';
  }

  if (append) host.appendChild(wrap);
  else host.replaceChildren(wrap);

  let index = 0;
  let removed = false;
  let manualUntil = 0;
  const timer = window.setInterval(() => {
    if (removed) return;
    if (Date.now() < manualUntil) return;
    index = (index + 1) % messages.length;
    const text = wrap.querySelector<HTMLElement>('.ai-thinking-text, .ai-thinking-sr');
    if (text) text.textContent = messages[index] || FIRST_THINKING_MESSAGE;
  }, rotateMs);

  const waitMinimum = (): Promise<void> => {
    const remaining = minimumMs - (Date.now() - createdAt);
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, remaining));
  };

  return {
    el: wrap,
    set(text: string): void {
      const node = wrap.querySelector<HTMLElement>('.ai-thinking-text, .ai-thinking-sr');
      if (node && text) {
        node.textContent = displayThinkingText(text);
        manualUntil = Date.now() + Math.max(rotateMs + 450, 1200);
      }
    },
    remove(immediate = false): void {
      if (removed) return;
      removed = true;
      clearInterval(timer);
      if (!wrap.parentNode) return;
      if (immediate) {
        wrap.remove();
        return;
      }
      wrap.classList.add('ai-thinking-status--hide');
      window.setTimeout(() => wrap.remove(), 180);
    },
    waitMinimum
  };
}
