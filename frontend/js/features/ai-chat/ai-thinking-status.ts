import { escapeHtml } from '../../utils/escape-html.js';

export type ThinkingContext =
  | 'exercise-solver'
  | 'course-qa'
  | 'summary'
  | 'quiz'
  | 'flashcards'
  | 'general';

export type AssistantStatus =
  | 'reading_question'
  | 'checking_selected_file'
  | 'searching_course_material'
  | 'reading_selected_part'
  | 'reading_relevant_sections'
  | 'collecting_sources'
  | 'checking_cache'
  | 'reading_figure'
  | 'generating_answer'
  | 'writing_answer'
  | 'no_strong_match'
  | 'preparing_quiz'
  | 'preparing_flashcards'
  | 'preparing_examforge'
  | 'preparing_summary'
  | 'preparing_deep_explanation'
  | 'preparing_step_solution'
  | 'checking_app_context';

export interface AIThinkingStatus {
  el: HTMLElement;
  set: (status: AssistantStatus | string) => void;
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
  status?: AssistantStatus;
  surface?: 'panel' | 'chatbot';
  compact?: boolean;
  minimumMs?: number;
  append?: boolean;
}

export const assistantStatusText: Record<AssistantStatus, string> = {
  reading_question:
    "I'm reading your question and checking what context is needed.",
  checking_selected_file:
    "I'm checking the selected course file for the relevant section.",
  searching_course_material:
    "I'm searching through your uploaded course material for the best match.",
  reading_selected_part:
    "I'm reading the selected part before connecting it to your question.",
  reading_relevant_sections:
    "I'm looking for the sections that directly support the answer.",
  collecting_sources:
    "I'm collecting the source references before writing the final answer.",
  checking_cache:
    "I'm checking whether this question has already been answered from the same material.",
  reading_figure:
    "I'm reading the relevant figure or diagram.",
  generating_answer:
    "I'm preparing the answer from the material I found.",
  writing_answer:
    "I'm writing the answer based on the material I found.",
  no_strong_match:
    "I couldn't find a strong match in the uploaded material, so I'm preparing a careful answer.",
  preparing_quiz:
    "I'm finding the important concepts to turn them into quiz questions.",
  preparing_flashcards:
    "I'm extracting key terms and definitions from your material.",
  preparing_examforge:
    "I'm analyzing the course topics and building an exam-style structure.",
  preparing_summary:
    "I'm identifying the main points before creating the summary.",
  preparing_deep_explanation:
    "I'm reading the relevant section carefully before explaining it step by step.",
  preparing_step_solution:
    "I'm reading the exercise carefully before writing the solution steps.",
  checking_app_context:
    "I'm checking the Minallo workspace context that matches your question.",
};

const CONTEXT_INITIAL_STATUS: Record<ThinkingContext, AssistantStatus> = {
  'exercise-solver': 'preparing_step_solution',
  'course-qa': 'searching_course_material',
  summary: 'preparing_summary',
  quiz: 'preparing_quiz',
  flashcards: 'preparing_flashcards',
  general: 'reading_question',
};

function isAssistantStatus(value: string): value is AssistantStatus {
  return Object.prototype.hasOwnProperty.call(assistantStatusText, value);
}

function statusToText(status: AssistantStatus | string): string {
  if (isAssistantStatus(status)) return assistantStatusText[status];
  return status || assistantStatusText.reading_question;
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

export function getInitialAssistantStatus(input: ThinkingContextInput = {}): AssistantStatus {
  const tool = String(input.tool || '').toLowerCase();
  const tutorMode = String(input.tutorMode || '').toLowerCase();
  const question = String(input.question || '').toLowerCase();

  if (input.problemSolver || tutorMode === 'solve') return 'preparing_step_solution';
  if (tool === 'examforge' || /\bexamforge\b|\bexam\b/.test(question)) return 'preparing_examforge';
  if (tool === 'quiz' || tutorMode === 'quiz' || /\bquiz\b/.test(question)) return 'preparing_quiz';
  if (tool === 'flashcards' || /\bflashcards?\b/.test(question)) return 'preparing_flashcards';
  if (tool === 'summary' || /\bsummari[sz]e\b|\bsummary\b/.test(question)) return 'preparing_summary';
  if (/\b(deep\s*learn|deep explanation|step by step|explain deeply)\b/.test(question)) {
    return 'preparing_deep_explanation';
  }
  if ((input.selectedSourceCount || 0) === 1 || input.selectedCourseId) return 'checking_selected_file';
  if ((input.selectedSourceCount || 0) > 1 || (input.filesCount || 0) > 1) {
    return 'searching_course_material';
  }
  if (input.hasCourseMaterial || input.courseId) return 'searching_course_material';
  return CONTEXT_INITIAL_STATUS[getThinkingContext(input)];
}

function thinkingHtml(text: string, surface: 'panel' | 'chatbot', compact: boolean): string {
  const classes =
    'ai-thinking-card' +
    (surface === 'chatbot' ? ' ai-thinking-card--chatbot' : '') +
    (compact ? ' ai-thinking-card--compact' : '');
  if (surface === 'panel') {
    return (
      '<div class="' + classes + ' ai-thinking-card--live" aria-live="polite" role="status">' +
      '<span class="ai-thinking-dot" aria-hidden="true"></span>' +
      '<span class="ai-thinking-text">' + escapeHtml(displayThinkingText(text)) + '</span>' +
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
  return (text || assistantStatusText.reading_question).trim();
}

export function createAIThinkingStatus(options: CreateThinkingStatusOptions): AIThinkingStatus | null {
  const host = options.host;
  if (!host) return null;

  const surface = options.surface || 'panel';
  const firstText = statusToText(options.status || CONTEXT_INITIAL_STATUS[options.context]);
  const minimumMs = Math.max(options.minimumMs ?? 500, 0);
  const createdAt = Date.now();
  const append = options.append !== false;

  const wrap = document.createElement('div');
  wrap.className =
    surface === 'chatbot'
      ? 'ai-thinking-status ai-thinking-status--chatbot'
      : 'ai-msg-wrap typing-wrap ai-thinking-status';
  wrap.setAttribute('data-ai-transient', 'thinking');

  if (surface === 'chatbot') {
    wrap.innerHTML = thinkingHtml(firstText, surface, !!options.compact);
  } else {
    wrap.innerHTML =
      '<div class="msg-sender bot-sender"><span class="msg-sender-dot"></span>Minallo AI</div>' +
      '<div class="msg-body">' +
      thinkingHtml(firstText, surface, !!options.compact) +
      '</div>';
  }

  if (append) host.appendChild(wrap);
  else host.replaceChildren(wrap);

  let removed = false;

  const waitMinimum = (): Promise<void> => {
    const remaining = minimumMs - (Date.now() - createdAt);
    if (remaining <= 0) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, remaining));
  };

  return {
    el: wrap,
    set(status: AssistantStatus | string): void {
      const node = wrap.querySelector<HTMLElement>('.ai-thinking-text');
      if (node && status) node.textContent = displayThinkingText(statusToText(status));
    },
    remove(immediate = false): void {
      if (removed) return;
      removed = true;
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
