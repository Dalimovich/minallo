// Deep Learn study tool — chatbot-popup-native workspace (Learning Agent).
//
// Guided, single-topic deep-dive grounded in the user's own files:
// explanation -> worked example -> one reveal-able self-check question.
// The topic picker is populated from the course Topic Map; a free-text box
// covers anything not in the map. Generation + grounding are server-side
// (generateDeepLearn); sources are clickable (popup via window.openCitedSource).
//
// This module replaces the retired legacy Course Overview "Deep Learn" tab
// UI. It is mounted directly into the chatbot overlay by
// openStudyToolWorkspace('deep_learn', ...) in workspace-library.ts — there is
// no more standalone Course Overview tab for this tool.

import { escapeHtml } from '../../utils/escape-html.js';
import type { CourseFile, CourseFolder, LibraryCourse } from './workspace-library.js';
import type {
  CourseDocument,
  CourseTopic,
  DeepLearnResult,
  SavedNote,
} from '../../services/ai-service.js';

function aiService(): Promise<typeof import('../../services/ai-service.js')> {
  return import('../../services/ai-service.js');
}

// ── types ────────────────────────────────────────────────────────────────

type Formula = NonNullable<NonNullable<DeepLearnResult['structuredLesson']>['keyFormulas']>[number];
type WorkedExample = NonNullable<NonNullable<DeepLearnResult['structuredLesson']>['workedExamples']>[number];
type MethodGuideItem = NonNullable<NonNullable<DeepLearnResult['structuredLesson']>['methodGuide']>[number];
type AdaptiveBlock = NonNullable<NonNullable<DeepLearnResult['structuredLesson']>['adaptiveBlocks']>[number];
type CheckItem = NonNullable<NonNullable<DeepLearnResult['structuredLesson']>['selfCheck']>[number];
type PracticeTask = NonNullable<NonNullable<DeepLearnResult['structuredLesson']>['practiceTasks']>[number];
type GroundedSource = NonNullable<DeepLearnResult['groundedSources']>[number];

interface CourseVisual {
  title?: string;
  explanation?: string;
  thumbnailUrl?: string;
  pageNumber?: number | string;
  documentId?: string;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
}

// The live API/persisted-note payload carries a couple of fields the shared
// ai-service.ts DeepLearnResult type doesn't declare (lessonLanguage,
// courseVisuals) — extend locally rather than touching that exported type.
type StructuredLesson = NonNullable<DeepLearnResult['structuredLesson']> & {
  lessonLanguage?: string;
  courseVisuals?: CourseVisual[];
};

interface PrintOpts {
  course: string;
  title: string;
  markdown: string;
}

interface Els {
  courseName: string;
  select: HTMLSelectElement | null;
  text: HTMLInputElement | null;
  mode: HTMLSelectElement | null;
  language: HTMLSelectElement | null;
  gen: HTMLButtonElement | null;
  result: HTMLElement;
  saved: HTMLElement | null;
  savedList: HTMLElement | null;
  _print?: PrintOpts;
}

export interface DeepLearnMountOptions {
  initialParameters?: {
    topic?: string;
    lessonMode?: string;
    lessonLanguage?: string;
    language?: string;
    learningGoals?: string[];
  };
  initialDocumentIds?: string[];
  initialVisualIds?: string[];
  initialSourceChunkIds?: string[];
  initialExistingLessonId?: string;
  recommendationId?: string;
  autoStart?: boolean;
  [key: string]: unknown;
}

// ── small utilities ─────────────────────────────────────────────────────

function esc(s: unknown): string {
  return escapeHtml(s == null ? '' : String(s));
}

function asList<T>(v: T[] | undefined | null): T[] {
  return Array.isArray(v) ? v.filter(Boolean) : [];
}

// The real markdown+KaTeX renderer lives in the AI render bridge, which the
// app loads lazily (only when the chatbot opens). Until then window.renderMarkdown
// is a plain escapeHtml stub — so without this Deep Learn shows raw "##" and
// "$$". Ensure the bridge AND KaTeX before rendering.
function ensureRenderers(): Promise<unknown> {
  const ps: Array<Promise<unknown>> = [];
  if (typeof window._ensureAiRenderBridge === 'function') ps.push(window._ensureAiRenderBridge());
  if (typeof window._ssEnsureKatex === 'function') ps.push(window._ssEnsureKatex());
  return Promise.all(ps);
}

function renderMarkdownInto(el: HTMLElement | null, md: string): void {
  if (!el) return;
  const doRender = (): void => {
    el.innerHTML = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(md) : esc(md);
    window._renderMath?.(el);
    window._renderCode?.(el);
  };
  ensureRenderers().then(doRender).catch(doRender);
}

// Flatten a live lesson into one markdown doc for the printable view.
function composeLesson(res: DeepLearnResult): string {
  if (res.structuredLesson) return structuredToMarkdown(res.structuredLesson as StructuredLesson);
  const parts: string[] = [];
  if (res.lesson && res.lesson.trim()) parts.push(res.lesson.trim());
  if (res.workedExample && res.workedExample.trim()) parts.push('## Worked example\n\n' + res.workedExample.trim());
  if (res.check?.question) {
    let b = '## Check yourself\n\n' + res.check.question;
    if (res.check.answer) b += '\n\n**Answer:** ' + res.check.answer;
    if (res.check.explanation) b += '\n\n*' + res.check.explanation + '*';
    parts.push(b);
  }
  return parts.join('\n\n');
}

function parseStructuredNote(note: { content_markdown?: string } | null): StructuredLesson | null {
  try {
    const parsed = JSON.parse(note?.content_markdown || '') as { structuredLesson?: unknown };
    return parsed && parsed.structuredLesson && typeof parsed.structuredLesson === 'object'
      ? (parsed.structuredLesson as StructuredLesson)
      : null;
  } catch {
    return null;
  }
}

function structuredToMarkdown(lesson: StructuredLesson): string {
  const parts: string[] = ['# ' + (lesson.title || 'Deep Learn')];
  if (lesson.learningGoal) parts.push('## Learning Goal\n\n' + lesson.learningGoal);
  if (lesson.bigPicture) parts.push('## Big Picture\n\n' + lesson.bigPicture);
  if (lesson.simpleExplanation) parts.push('## Simple Explanation\n\n' + lesson.simpleExplanation);
  if (lesson.intuition) parts.push('## Intuition\n\n' + lesson.intuition);
  if (lesson.coreExplanation) parts.push('## Core Explanation\n\n' + lesson.coreExplanation);
  if (asList(lesson.keyDetails).length) {
    parts.push('## Key Details from Your Sources\n\n' + asList(lesson.keyDetails).map((s) => '- ' + s).join('\n'));
  }
  if (asList(lesson.keyFormulas).length) {
    parts.push('## Key Formulas\n\n' + asList(lesson.keyFormulas).map((f) =>
      // keyFormulas.formula is raw LaTeX with NO $ delimiters by contract (the
      // live formula-card renderer adds them itself) — but this function's
      // output becomes the PERSISTED note content_markdown, so a note
      // reopened later from Saved has no live JS path to add them. Wrap here
      // too, or the formula renders as raw text every time after the first view.
      '**Formula:** ' + (f.formula ? '$$' + f.formula + '$$' : '') +
      '\n\n**Meaning:** ' + (f.meaning || '') +
      '\n\n**Variables:** ' + (f.variables || '') +
      '\n\n**Use when / conditions:** ' + (f.conditions || '') +
      (f.relevance ? '\n\n**Relevance:** ' + f.relevance : '') +
      (f.confidence ? '\n\n**Confidence:** ' + f.confidence : '') +
      (f.commonMistake ? '\n\n**Common mistake:** ' + f.commonMistake : '') +
      '\n\n**Source:** ' + (f.source || '')
    ).join('\n\n---\n\n'));
  }
  if (asList(lesson.stepByStepMethod).length) {
    parts.push('## Step-by-Step Method\n\n' + asList(lesson.stepByStepMethod).map((s, i) => (i + 1) + '. ' + s).join('\n'));
  }
  if (asList(lesson.methodGuide).length) {
    parts.push('## Which Method Should I Use?\n\n' + asList(lesson.methodGuide).map((m) =>
      '**' + (m.method || 'Method') + '**' +
      (m.useWhen ? '\n\nUse when: ' + m.useWhen : '') +
      (m.avoidWhen ? '\n\nAvoid when: ' + m.avoidWhen : '') +
      (m.source ? '\n\nSource: ' + m.source : '')
    ).join('\n\n---\n\n'));
  }
  asList(lesson.adaptiveBlocks).forEach((b) => {
    let body = b.body || '';
    if (asList(b.items).length) body += (body ? '\n\n' : '') + asList(b.items).map((s) => '- ' + s).join('\n');
    if (b.source) body += (body ? '\n\n' : '') + '**Source:** ' + b.source;
    if (body.trim()) parts.push('## ' + (b.title || b.type || 'Learning Block') + '\n\n' + body);
  });
  let examples: WorkedExample[] = asList(lesson.workedExamples);
  if (!examples.length && lesson.workedExample) examples = [lesson.workedExample as WorkedExample];
  examples.forEach((worked) => {
    if (!(worked.problem || asList(worked.solutionSteps).length)) return;
    parts.push('## ' + (worked.title || (worked.isMiniExample ? 'Mini-example' : 'Worked Example')) + '\n\n' +
      (worked.problem ? '**Problem:** ' + worked.problem + '\n\n' : '') +
      asList(worked.solutionSteps).map((s, i) => (i + 1) + '. ' + s).join('\n') +
      (worked.finalAnswer ? '\n\n**Final answer:** ' + worked.finalAnswer : '') +
      (worked.sourceOrBasis ? '\n\n**Source or basis:** ' + worked.sourceOrBasis : ''));
  });
  if (asList(lesson.commonMistakes).length) parts.push('## Common Mistakes\n\n' + asList(lesson.commonMistakes).map((s) => '- ' + s).join('\n'));
  if (asList(lesson.examTraps).length) parts.push('## Exam Traps\n\n' + asList(lesson.examTraps).map((s) => '- ' + s).join('\n'));
  if (asList(lesson.selfCheck).length) {
    parts.push('## Self-Check\n\n' + asList(lesson.selfCheck).map((c) =>
      '**Question:** ' + (c.question || '') +
      (c.hint ? '\n\n**Hint:** ' + c.hint : '') +
      '\n\n**Answer:** ' + (c.answer || '') +
      (c.explanation ? '\n\n**Explanation:** ' + c.explanation : '')
    ).join('\n\n'));
  }
  if (asList(lesson.practiceTasks).length) {
    parts.push('## Practice Tasks\n\n' + asList(lesson.practiceTasks).map((t) =>
      '**Task:** ' + (t.prompt || '') + (t.goal ? '\n\nGoal: ' + t.goal : '') + (t.source ? '\n\nSource: ' + t.source : '')
    ).join('\n\n'));
  }
  if (lesson.nextStep) parts.push('## Next Step\n\n' + lesson.nextStep);
  if (asList(lesson.nextTopics).length) parts.push('## Next Topics\n\n' + asList(lesson.nextTopics).map((s) => '- ' + s).join('\n'));
  if (asList(lesson.groundedSources).length) parts.push('## Sources\n\n' + asList(lesson.groundedSources).map((s) => '- ' + s).join('\n'));
  return parts.filter(Boolean).join('\n\n');
}

function previewFromLesson(lesson: StructuredLesson | null, fallback: string): string {
  let raw = lesson
    ? [lesson.learningGoal, lesson.intuition, lesson.coreExplanation].filter(Boolean).join(' ')
    : fallback;
  raw = String(raw || '').replace(/[#$*_`>\-[\]{}"]/g, ' ').replace(/\s+/g, ' ').trim();
  return raw.length > 150 ? raw.slice(0, 150) + '…' : raw;
}

function sourceSummary(note: SavedNote | null): string {
  const sources = note?.note_sources;
  if (!Array.isArray(sources) || !sources.length) return '';
  return sources.slice(0, 2).map((s) => {
    const fn = s.fileName || s.file_name || 'Source';
    const pg = s.pageStart == null ? '' : ', p.' + s.pageStart;
    return fn + pg;
  }).join(' · ');
}

function renderList(el: HTMLElement | null, items: string[], ordered: boolean): void {
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<p class="dl-muted">No strong course evidence for this section.</p>';
    return;
  }
  const tag = ordered ? 'ol' : 'ul';
  el.innerHTML = '<' + tag + '>' + items.map((x) => '<li>' + esc(x) + '</li>').join('') + '</' + tag + '>';
}

function bindSourceClicks(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>('.src-cite').forEach((el) => {
    el.addEventListener('click', () => {
      const fn = el.getAttribute('data-src-file');
      if (!fn || typeof window.openCitedSource !== 'function') return;
      window.openCitedSource({ fileName: fn, page: Number(el.getAttribute('data-src-page')) || null }, 'popup');
    });
  });
}

let dlRun = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BuildStepsProgress {
  id: number;
  stop: () => void;
}

function startBuildSteps(els: Els, topic: string): BuildStepsProgress {
  const runId = ++dlRun;
  const steps = [
    'Checking whether your files cover this topic',
    'Retrieving definitions, formulas, examples, and traps',
    'Planning the tutor path',
    'Writing the guided lesson',
    'Validating citations and sources',
  ];
  let idx = 0;
  els.result.innerHTML =
    '<div class="dl-build" data-run="' + runId + '">' +
      '<div class="dl-build-title">Teaching ' + esc(topic) + '</div>' +
      '<div class="dl-build-steps">' + steps.map((s, i) =>
        '<div class="dl-build-step' + (i === 0 ? ' is-active' : '') + '" data-step="' + i + '">' +
          '<span class="dl-step-dot"></span><span>' + esc(s) + '</span></div>'
      ).join('') + '</div>' +
    '</div>';
  const timer = window.setInterval(() => {
    if (runId !== dlRun || !els.result.querySelector('.dl-build')) {
      clearInterval(timer);
      return;
    }
    idx = Math.min(idx + 1, steps.length - 1);
    els.result.querySelectorAll('.dl-build-step').forEach((el, i) => {
      el.classList.toggle('is-done', i < idx);
      el.classList.toggle('is-active', i === idx);
    });
  }, 1200);
  return {
    id: runId,
    stop: () => clearInterval(timer),
  };
}

function revealLessonSections(els: Els, runId: number): void {
  const card = els.result.querySelector<HTMLElement>('.dl-lesson-card');
  if (!card) return;
  const sections = Array.from(card.querySelectorAll<HTMLElement>('.dl-study-section, .dl-section, .dl-check, .dl-sources'));
  if (!sections.length) return;
  const head = card.querySelector('.dl-lesson-head');
  const status = document.createElement('div');
  status.className = 'dl-writing-line';
  status.textContent = 'Writing section 1 of ' + sections.length;
  if (head?.nextSibling) card.insertBefore(status, head.nextSibling);
  else card.insertBefore(status, card.firstChild);
  sections.forEach((section) => section.classList.add('dl-progress-hidden'));
  const printBtn = card.querySelector<HTMLButtonElement>('[data-dl-print]');
  if (printBtn) printBtn.disabled = true;
  void (async () => {
    for (let i = 0; i < sections.length; i += 1) {
      if (runId !== dlRun || !card.isConnected) return;
      const title = sections[i]!.querySelector('h4');
      status.textContent = 'Writing section ' + (i + 1) + ' of ' + sections.length + (title ? ': ' + title.textContent : '');
      await sleep(i === 0 ? 120 : 520);
      sections[i]!.classList.remove('dl-progress-hidden');
      sections[i]!.classList.add('dl-progress-visible');
      await sleep(360);
    }
    if (runId !== dlRun) return;
    const lang = card.getAttribute('data-lang') || 'en';
    status.textContent = (LABELS[lang] || LABELS.en)!.lessonComplete;
    if (printBtn) printBtn.disabled = false;
  })();
}

function renderResultProgressive(els: Els, res: DeepLearnResult, runId: number): void {
  if (runId !== dlRun) return;
  els.result.style.visibility = 'hidden';
  renderResult(els, res);
  const card = els.result.querySelector<HTMLElement>('.dl-lesson-card');
  if (!card) {
    els.result.style.visibility = '';
    return;
  }
  const sections = Array.from(card.querySelectorAll<HTMLElement>('.dl-study-section, .dl-section, .dl-check, .dl-sources'));
  sections.forEach((section) => section.classList.add('dl-progress-hidden'));
  els.result.style.visibility = '';
  revealLessonSections(els, runId);
}

// ── labels (bilingual UI copy for the structured lesson) ───────────────────

interface Labels {
  kicker: string; learningGoal: string; bigPicture: string; simple: string; core: string;
  keyDetails: string; formulaCards: string; methodGuide: string; stepByStep: string; examples: string;
  commonMistakes: string; examTraps: string; selfCheck: string; practiceTasks: string; nextStep: string;
  sources: string; downloadPdf: string; hint: string; showAnswer: string; explainSteps: string;
  variables: string; useWhen: string; commonMistake: string; source: string; coreFormula: string;
  relatedConcept: string; prompt: string; result: string; task: string; goal: string; useWhenShort: string;
  avoidWhen: string; example: string; miniExample: string; learningBlock: string; lessonComplete: string;
}

const LABELS: Record<string, Labels> = {
  en: {
    kicker: 'Guided tutor lesson', learningGoal: 'Learning Goal', bigPicture: 'Big Picture',
    simple: 'Simple Explanation', core: 'Core Concepts', keyDetails: 'Key Details from Your Sources',
    formulaCards: 'Formula Cards', methodGuide: 'Which Method Should I Use?', stepByStep: 'Step-by-Step Method',
    examples: 'Examples / Applications', commonMistakes: 'Common Mistakes', examTraps: 'Exam Traps',
    selfCheck: 'Self-Check', practiceTasks: 'Practice Tasks', nextStep: 'Next Step', sources: 'Sources',
    downloadPdf: 'Download PDF', hint: 'Hint', showAnswer: 'Show answer', explainSteps: 'Explain step-by-step',
    variables: 'Variables', useWhen: 'Use when / conditions', commonMistake: 'Common mistake', source: 'Source',
    coreFormula: 'Core formula', relatedConcept: 'Related concept', prompt: 'Prompt', result: 'Result',
    task: 'Task', goal: 'Goal', useWhenShort: 'Use when', avoidWhen: 'Avoid when', example: 'Example',
    miniExample: 'Mini-example', learningBlock: 'Learning Block', lessonComplete: 'Lesson complete',
  },
  de: {
    kicker: 'Geführte Tutorlektion', learningGoal: 'Lernziel', bigPicture: 'Gesamtbild',
    simple: 'Einfache Erklärung', core: 'Kernkonzepte', keyDetails: 'Wichtige Details aus deinen Quellen',
    formulaCards: 'Formelkarten', methodGuide: 'Welche Methode soll ich verwenden?', stepByStep: 'Schritt-für-Schritt-Methode',
    examples: 'Beispiele / Anwendungen', commonMistakes: 'Häufige Fehler', examTraps: 'Prüfungsfallen',
    selfCheck: 'Selbsttest', practiceTasks: 'Übungsaufgaben', nextStep: 'Nächster Schritt', sources: 'Quellen',
    downloadPdf: 'PDF herunterladen', hint: 'Hinweis', showAnswer: 'Antwort zeigen', explainSteps: 'Schritt für Schritt erklären',
    variables: 'Variablen', useWhen: 'Anwenden wenn / Bedingungen', commonMistake: 'Häufiger Fehler', source: 'Quelle',
    coreFormula: 'Kernformel', relatedConcept: 'Verwandtes Konzept', prompt: 'Aufgabe', result: 'Endergebnis',
    task: 'Aufgabe', goal: 'Ziel', useWhenShort: 'Anwenden wenn', avoidWhen: 'Vermeiden wenn', example: 'Beispiel',
    miniExample: 'Kurzbeispiel', learningBlock: 'Lernblock', lessonComplete: 'Lektion abgeschlossen',
  },
};

function l(lesson: StructuredLesson | undefined, key: keyof Labels): string {
  const lang = lesson?.lessonLanguage || 'en';
  const labels = LABELS[lang] || LABELS.en!;
  return labels[key] || LABELS.en![key];
}

// ── structured (adaptive) lesson rendering ─────────────────────────────────

function renderStructuredResult(els: Els, res: DeepLearnResult, lesson: StructuredLesson): void {
  const formulas = asList(lesson.keyFormulas);
  const checks = asList(lesson.selfCheck);
  const sources: GroundedSource[] = res.groundedSources || [];
  let examples: WorkedExample[] = asList(lesson.workedExamples);
  if (!examples.length && lesson.workedExample) examples = [lesson.workedExample as WorkedExample];
  examples = examples.filter((w) => w && (w.problem || asList(w.solutionSteps).length || w.finalAnswer));

  const sections: string[] = [];
  const addSection = (title: string, cls: string): void => {
    sections.push('<section class="dl-study-section"><h4>' + esc(title) + '</h4><div class="' + cls + '"></div></section>');
  };
  if (lesson.learningGoal) addSection(l(lesson, 'learningGoal'), 'dl-learning-goal');
  if (lesson.bigPicture) addSection(l(lesson, 'bigPicture'), 'dl-big-picture');
  if (lesson.simpleExplanation || lesson.intuition) addSection(l(lesson, 'simple'), 'dl-simple');
  if (lesson.coreExplanation) addSection(l(lesson, 'core'), 'dl-core');
  if (asList(lesson.keyDetails).length) addSection(l(lesson, 'keyDetails'), 'dl-key-details');
  if (formulas.length) addSection(l(lesson, 'formulaCards'), 'dl-formulas');
  if (asList(lesson.methodGuide).length) addSection(l(lesson, 'methodGuide'), 'dl-method-guide');
  asList(lesson.adaptiveBlocks).forEach((b, i) => {
    sections.push('<section class="dl-study-section dl-adaptive-section"><h4>' + esc(b.title || b.type || l(lesson, 'learningBlock')) + '</h4><div class="dl-adaptive-block" data-block="' + i + '"></div></section>');
  });
  if (asList(lesson.stepByStepMethod).length) addSection(l(lesson, 'stepByStep'), 'dl-method');
  if (examples.length) addSection(l(lesson, 'examples'), 'dl-examples');
  if (asList(lesson.commonMistakes).length) addSection(l(lesson, 'commonMistakes'), 'dl-mistakes');
  if (asList(lesson.examTraps).length) addSection(l(lesson, 'examTraps'), 'dl-traps');
  if (checks.length) addSection(l(lesson, 'selfCheck'), 'dl-checks');
  if (asList(lesson.practiceTasks).length) addSection(l(lesson, 'practiceTasks'), 'dl-practice-tasks');
  if (lesson.nextStep) addSection(l(lesson, 'nextStep'), 'dl-next-step');
  addSection(l(lesson, 'sources'), 'dl-source-list');

  els._print = {
    course: els.courseName || '',
    title: lesson.title || res.title || res.topic || 'Lesson',
    markdown: structuredToMarkdown(lesson),
  };
  els.result.innerHTML =
    '<article class="dl-lesson-card dl-structured" data-lang="' + esc(lesson.lessonLanguage || 'en') + '">' +
      '<div class="dl-lesson-head"><div><p class="dl-kicker">' + esc(l(lesson, 'kicker')) + '</p><h3>' + esc(lesson.title || res.title || res.topic || 'Lesson') + '</h3>' +
      '<div class="dl-lesson-meta">' + esc([lesson.lessonMode, lesson.subjectArea || els.courseName, lesson.contentType].filter(Boolean).join(' · ')) + '</div></div>' +
      '<button type="button" class="dl-btn dl-download" data-dl-print>' + esc(l(lesson, 'downloadPdf')) + '</button></div>' +
      ((res.citationWarning || lesson.citationWarning) ? '<div class="dl-warning">' + esc(res.citationWarning || lesson.citationWarning) + '</div>' : '') +
      sections.join('') +
    '</article>';

  renderMarkdownInto(els.result.querySelector('.dl-learning-goal'), lesson.learningGoal || '');
  renderMarkdownInto(els.result.querySelector('.dl-big-picture'), lesson.bigPicture || '');
  renderMarkdownInto(els.result.querySelector('.dl-simple'), lesson.simpleExplanation || lesson.intuition || '');
  renderMarkdownInto(els.result.querySelector('.dl-core'), lesson.coreExplanation || '');
  renderList(els.result.querySelector('.dl-key-details'), asList(lesson.keyDetails), false);
  renderList(els.result.querySelector('.dl-method'), asList(lesson.stepByStepMethod), true);
  renderList(els.result.querySelector('.dl-mistakes'), asList(lesson.commonMistakes), false);
  renderList(els.result.querySelector('.dl-traps'), asList(lesson.examTraps), false);
  renderMarkdownInto(els.result.querySelector('.dl-next-step'), lesson.nextStep || '');

  const formulaHost = els.result.querySelector<HTMLElement>('.dl-formulas');
  if (formulaHost) {
    formulaHost.innerHTML = formulas.map((f, i) => {
      const rel = (f.relevance || '').toLowerCase() === 'related' ? l(lesson, 'relatedConcept') : (f.relevance || '');
      const confidence = f.confidence ? ' · ' + f.confidence : '';
      return '<details class="dl-formula-box" open>' +
        '<summary><span class="dl-formula-title">' + esc(f.meaning || f.formula || 'Formula') + '</span>' +
        (rel || confidence ? '<span class="dl-formula-meta">' + esc((rel || l(lesson, 'coreFormula')) + confidence) + '</span>' : '') +
        '</summary>' +
        '<div class="dl-formula-main" data-formula="' + i + '"></div>' +
        '<dl><dt>' + esc(l(lesson, 'variables')) + '</dt><dd>' + esc(f.variables || '') + '</dd>' +
        '<dt>' + esc(l(lesson, 'useWhen')) + '</dt><dd>' + esc(f.conditions || '') + '</dd>' +
        (f.commonMistake ? '<dt>' + esc(l(lesson, 'commonMistake')) + '</dt><dd>' + esc(f.commonMistake) + '</dd>' : '') +
        '<dt>' + esc(l(lesson, 'source')) + '</dt><dd>' + esc(f.source || 'Missing source') + '</dd></dl></details>';
    }).join('');
    formulaHost.querySelectorAll<HTMLElement>('.dl-formula-main').forEach((el) => {
      const f: Formula = formulas[Number(el.getAttribute('data-formula') || 0)] || {};
      renderMarkdownInto(el, f.formula ? '$$' + f.formula + '$$' : '');
    });
  }

  const methodHost = els.result.querySelector<HTMLElement>('.dl-method-guide');
  if (methodHost) {
    methodHost.innerHTML = asList(lesson.methodGuide).map((m: MethodGuideItem) =>
      '<div class="dl-method-card"><strong>' + esc(m.method || 'Method') + '</strong>' +
      (m.useWhen ? '<p><b>' + esc(l(lesson, 'useWhenShort')) + ':</b> ' + esc(m.useWhen) + '</p>' : '') +
      (m.avoidWhen ? '<p><b>' + esc(l(lesson, 'avoidWhen')) + ':</b> ' + esc(m.avoidWhen) + '</p>' : '') +
      (m.source ? '<p class="dl-source-basis">' + esc(m.source) + '</p>' : '') + '</div>'
    ).join('');
  }

  els.result.querySelectorAll<HTMLElement>('.dl-adaptive-block').forEach((host) => {
    const b: AdaptiveBlock = asList(lesson.adaptiveBlocks)[Number(host.getAttribute('data-block') || 0)] || {};
    host.innerHTML = (b.body ? '<div class="dl-adaptive-body"></div>' : '') +
      (asList(b.items).length ? '<ul>' + asList(b.items).map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      (b.source ? '<p class="dl-source-basis">' + esc(b.source) + '</p>' : '');
    if (b.body) renderMarkdownInto(host.querySelector('.dl-adaptive-body'), b.body);
  });

  const exampleHost = els.result.querySelector<HTMLElement>('.dl-examples');
  if (exampleHost) {
    exampleHost.innerHTML = examples.map((worked) =>
      '<div class="dl-example-card">' +
        '<h5>' + esc(worked.title || (worked.isMiniExample ? l(lesson, 'miniExample') : l(lesson, 'example'))) + (worked.difficulty ? ' · ' + esc(worked.difficulty) : '') + '</h5>' +
        (worked.problem ? '<p><strong>' + esc(l(lesson, 'prompt')) + ':</strong> ' + esc(worked.problem) + '</p>' : '') +
        (asList(worked.solutionSteps).length ? '<ol>' + asList(worked.solutionSteps).map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' : '') +
        (worked.finalAnswer ? '<p><strong>' + esc(l(lesson, 'result')) + ':</strong> ' + esc(worked.finalAnswer) + '</p>' : '') +
        (worked.sourceOrBasis ? '<p class="dl-source-basis">' + esc(worked.sourceOrBasis) + '</p>' : '') +
      '</div>'
    ).join('');
  }

  const checkHost = els.result.querySelector<HTMLElement>('.dl-checks');
  if (checkHost) {
    checkHost.innerHTML = checks.map((c, i) =>
      '<div class="dl-check-card"><p class="dl-check-q">' + esc(c.question || '') + '</p>' +
        '<div class="dl-check-actions">' +
          '<button class="dl-btn dl-reveal" type="button" data-check="' + i + '" data-part="hint">' + esc(l(lesson, 'hint')) + '</button>' +
          '<button class="dl-btn dl-reveal" type="button" data-check="' + i + '" data-part="answer">' + esc(l(lesson, 'showAnswer')) + '</button>' +
          '<button class="dl-btn dl-reveal" type="button" data-check="' + i + '" data-part="explain">' + esc(l(lesson, 'explainSteps')) + '</button>' +
        '</div><div class="dl-check-a" hidden></div></div>'
    ).join('');
    checkHost.querySelectorAll<HTMLButtonElement>('.dl-reveal').forEach((btn) => {
      btn.addEventListener('click', () => {
        const c: CheckItem = checks[Number(btn.getAttribute('data-check') || 0)] || {};
        const part = btn.getAttribute('data-part') || 'answer';
        const card = btn.closest<HTMLElement>('.dl-check-card');
        const ansEl = card?.querySelector<HTMLElement>('.dl-check-a');
        if (!ansEl) return;
        const md = part === 'hint'
          ? (c.hint || 'Start by identifying the key concept from the lesson.')
          : part === 'explain'
            ? (asList(c.stepByStep).length ? asList(c.stepByStep).map((s, i) => (i + 1) + '. ' + s).join('\n') : (c.explanation || c.answer || ''))
            : ((c.answer || '') + (c.explanation ? '\n\n*' + c.explanation + '*' : ''));
        renderMarkdownInto(ansEl, md);
        ansEl.removeAttribute('hidden');
      });
    });
  }

  const practiceHost = els.result.querySelector<HTMLElement>('.dl-practice-tasks');
  if (practiceHost) {
    practiceHost.innerHTML = asList(lesson.practiceTasks).map((t: PracticeTask) =>
      '<div class="dl-practice-card"><p><strong>' + esc(l(lesson, 'task')) + ':</strong> ' + esc(t.prompt || '') + '</p>' +
      (t.goal ? '<p><strong>' + esc(l(lesson, 'goal')) + ':</strong> ' + esc(t.goal) + '</p>' : '') +
      (t.source ? '<p class="dl-source-basis">' + esc(t.source) + '</p>' : '') + '</div>'
    ).join('');
  }

  const courseVisuals = asList(lesson.courseVisuals);
  if (courseVisuals.length) {
    const article = els.result.querySelector<HTMLElement>('.dl-structured');
    const visualSection = document.createElement('section');
    visualSection.className = 'dl-section dl-course-visuals';
    visualSection.innerHTML = '<h4>Professor\'s course visuals</h4><div class="dl-course-visual-grid"></div>';
    const visualGrid = visualSection.querySelector<HTMLElement>('.dl-course-visual-grid')!;
    courseVisuals.forEach((visual) => {
      const figure = document.createElement('figure');
      figure.className = 'dl-course-visual';
      figure.innerHTML = (visual.thumbnailUrl
        ? '<img loading="lazy" alt="' + esc(visual.title || 'Course visual') + '" src="' + esc(visual.thumbnailUrl) + '">' : '') +
        '<figcaption><strong>' + esc(visual.title || 'Course visual') + '</strong>' +
        '<p>' + esc(visual.explanation || '') + '</p>' +
        '<button type="button" class="dl-course-visual-open">Open source page ' + esc(visual.pageNumber || '') + '</button></figcaption>';
      figure.querySelector<HTMLButtonElement>('.dl-course-visual-open')!.addEventListener('click', () => {
        window.openCitedSource?.({
          documentId: visual.documentId, page: typeof visual.pageNumber === 'number' ? visual.pageNumber : Number(visual.pageNumber) || null,
          boundingBox: visual.boundingBox || null,
        }, 'popup');
      });
      visualGrid.appendChild(figure);
    });
    article?.appendChild(visualSection);
  }

  const sourceHost = els.result.querySelector<HTMLElement>('.dl-source-list');
  if (sourceHost) {
    sourceHost.innerHTML = sources.length ? sources.map((s) => {
      const pg = s.pageStart == null ? '' : s.pageStart;
      return '<button type="button" class="src-cite" data-src-file="' + esc(s.fileName || '') +
        '" data-src-page="' + esc(pg) + '">' + esc(s.label || s.fileName || 'Source') + '</button>';
    }).join('') : asList(lesson.groundedSources).map((s) => '<span class="dl-source-chip">' + esc(s) + '</span>').join('');
    if (!sourceHost.innerHTML) sourceHost.innerHTML = '<p class="dl-muted">No clickable sources were returned.</p>';
    bindSourceClicks(sourceHost);
  }

  // Many fields above (worked examples, adaptive items, practice tasks, check
  // questions, formula variables…) are built with esc() and never went through
  // renderMarkdownInto, so their $…$ / $$…$$ / \[…\] math stayed raw. esc leaves
  // those delimiters intact, so one KaTeX pass over the whole card renders the
  // math everywhere in a single shot (idempotent — already-rendered fields have
  // no raw delimiters left).
  ensureRenderers().then(() => {
    window._renderMath?.(els.result);
  }).catch(() => undefined);

  const dlBtn = els.result.querySelector<HTMLButtonElement>('[data-dl-print]');
  if (dlBtn) dlBtn.addEventListener('click', () => { if (els._print) openPrint(els._print); });
}

// ── printable white lesson view + download (PDF via the browser) ──────────

let printEl: HTMLElement | null = null;
let printEsc: ((e: KeyboardEvent) => void) | null = null;

function closePrint(): void {
  if (printEsc) { document.removeEventListener('keydown', printEsc); printEsc = null; }
  if (printEl) { printEl.remove(); printEl = null; }
}

// Lazy-load html2pdf once so "Download PDF" yields a file directly — no
// browser print dialog.
function ensureHtml2Pdf(): Promise<NonNullable<Window['html2pdf']>> {
  if (window.html2pdf) return Promise.resolve(window.html2pdf);
  if (window._ssHtml2PdfP) return window._ssHtml2PdfP as Promise<NonNullable<Window['html2pdf']>>;
  const promise = new Promise<NonNullable<Window['html2pdf']>>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js';
    s.onload = (): void => { if (window.html2pdf) resolve(window.html2pdf); else reject(new Error('pdf lib failed to load')); };
    s.onerror = (): void => {
      // Evict cache + dead tag so the next download retries instead of
      // failing for the rest of the session.
      window._ssHtml2PdfP = null;
      s.remove();
      reject(new Error('pdf lib failed to load'));
    };
    document.head.appendChild(s);
  });
  window._ssHtml2PdfP = promise;
  return promise;
}

function safeName(s: string): string {
  return String(s || 'lesson').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'lesson';
}

function downloadPdf(el: Element, filename: string): Promise<void> {
  return ensureHtml2Pdf().then((h2p) =>
    h2p().set({
      margin: [10, 10, 12, 10],
      filename,
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    }).from(el).save()
  );
}

// Add colour to the printable lesson: section headings + known bold labels.
function decorateLesson(root: HTMLElement | null): void {
  if (!root) return;
  const RED = ['Common mistake:', 'Common mistakes:', 'Common Mistakes'];
  const GREEN = ['Answer:', 'Final answer:'];
  const MUTED = ['Source:', 'Source or basis:'];
  const KEY = ['Formula:', 'Problem:', 'Question:', 'Meaning:'];
  root.querySelectorAll('strong').forEach((s) => {
    const t = (s.textContent || '').trim();
    if (RED.indexOf(t) >= 0) s.classList.add('dl-c-warn');
    else if (GREEN.indexOf(t) >= 0) s.classList.add('dl-c-ok');
    else if (MUTED.indexOf(t) >= 0) s.classList.add('dl-c-muted');
    else if (KEY.indexOf(t) >= 0) s.classList.add('dl-c-key');
  });
}

function renderLessonInto(el: HTMLElement, md: string): void {
  const done = (): void => {
    el.innerHTML = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(md) : esc(md);
    window._renderMath?.(el);
    window._renderCode?.(el);
    decorateLesson(el);
  };
  ensureRenderers().then(done).catch(done);
}

function openPrint(opts: PrintOpts): void {
  closePrint();
  const ov = document.createElement('div');
  ov.className = 'dl-print-overlay ss-print-root';
  ov.innerHTML =
    '<div class="ss-print-bar">' +
      '<span class="ss-print-bar-title">' + esc(opts.title || 'Lesson') + '</span>' +
      '<div class="ss-print-bar-actions">' +
        '<button type="button" class="ss-print-btn" data-act="download">⤓ Download PDF</button>' +
        '<button type="button" class="ss-print-btn" data-act="close">Close</button>' +
      '</div>' +
    '</div>' +
    '<div class="ss-print-scroll">' +
      '<article class="ss-print-doc">' +
        '<header class="ss-print-head">' +
          (opts.course ? '<div class="ss-print-course">' + esc(opts.course) + '</div>' : '') +
          '<h1>' + esc(opts.title || 'Lesson') + '</h1>' +
        '</header>' +
        '<div class="ss-print-body"></div>' +
      '</article>' +
    '</div>';
  document.body.appendChild(ov);
  printEl = ov;
  const body = ov.querySelector<HTMLElement>('.ss-print-body');
  if (body) renderLessonInto(body, opts.markdown || '');
  ov.querySelector('[data-act="close"]')?.addEventListener('click', closePrint);
  const dlBtn = ov.querySelector<HTMLButtonElement>('[data-act="download"]');
  if (dlBtn) {
    dlBtn.addEventListener('click', () => {
      const doc = ov.querySelector<HTMLElement>('.ss-print-doc');
      if (!doc) return;
      const label = dlBtn.textContent || '';
      dlBtn.disabled = true;
      dlBtn.textContent = 'Generating…';
      downloadPdf(doc, safeName(opts.title || 'lesson') + '.pdf').then(() => {
        dlBtn.disabled = false; dlBtn.textContent = label;
      }).catch(() => {
        dlBtn.disabled = false; dlBtn.textContent = label;
        window.showToast?.('Download failed', 'Could not generate the PDF. Please try again.');
      });
    });
  }
  printEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') closePrint(); };
  document.addEventListener('keydown', printEsc);
}

// ── plain (non-structured) lesson rendering ─────────────────────────────

function renderResult(els: Els, res: DeepLearnResult): void {
  if (!res || res.error) {
    els.result.innerHTML = '<div class="dl-msg dl-error">I couldn\'t create that lesson just now. Please try again in a moment.</div>';
    return;
  }
  if ((!res.lesson || !res.lesson.trim()) && res.warning) {
    els.result.innerHTML = '<div class="dl-msg">' + esc(res.warning) + '</div>';
    return;
  }
  if (res.structuredLesson && typeof res.structuredLesson === 'object') {
    renderStructuredResult(els, res, res.structuredLesson as StructuredLesson);
    return;
  }
  const sources = res.groundedSources || [];
  const hasCheck = !!res.check?.question;
  els._print = {
    course: els.courseName || '',
    title: res.title || res.topic || 'Lesson',
    markdown: composeLesson(res),
  };
  els.result.innerHTML =
    '<div class="dl-lesson-card">' +
      '<div class="dl-lesson-head">' +
        '<h3>' + esc(res.title || res.topic || 'Lesson') + '</h3>' +
        '<button type="button" class="dl-btn dl-download" data-dl-print>⤓ Download PDF</button>' +
      '</div>' +
      '<div class="dl-section dl-lesson-body"></div>' +
      (res.workedExample && res.workedExample.trim()
        ? '<h4>Worked example</h4><div class="dl-section dl-example-body"></div>'
        : '') +
      (hasCheck
        ? '<div class="dl-check">' +
            '<h4>Check yourself</h4>' +
            '<p class="dl-check-q"></p>' +
            '<button class="dl-btn dl-reveal" id="dlReveal" type="button">Show answer</button>' +
            '<div class="dl-check-a" hidden></div>' +
          '</div>'
        : '') +
      (sources.length
        ? '<div class="dl-sources">Sources: ' +
            sources.map((s) => {
              const pg = s.pageStart == null ? '' : s.pageStart;
              return '<span class="src-cite" title="Open this source" data-src-file="' + esc(s.fileName || '') +
                '" data-src-page="' + esc(pg) + '">' + esc(s.fileName || 'Source') + (pg ? ', p.' + esc(pg) : '') + '</span>';
            }).join(' · ') +
          '</div>'
        : '') +
    '</div>';

  renderMarkdownInto(els.result.querySelector('.dl-lesson-body'), res.lesson || '');
  renderMarkdownInto(els.result.querySelector('.dl-example-body'), res.workedExample || '');

  if (hasCheck && res.check) {
    const q = els.result.querySelector('.dl-check-q');
    if (q) q.textContent = res.check.question;
    const reveal = els.result.querySelector<HTMLButtonElement>('#dlReveal');
    const ans = els.result.querySelector<HTMLElement>('.dl-check-a');
    if (reveal && ans) {
      reveal.addEventListener('click', () => {
        if (ans.hasAttribute('hidden')) {
          renderMarkdownInto(ans, (res.check?.answer || '') + (res.check?.explanation ? '\n\n*' + res.check.explanation + '*' : ''));
          ans.removeAttribute('hidden');
          reveal.textContent = 'Hide answer';
        } else {
          ans.setAttribute('hidden', '');
          reveal.textContent = 'Show answer';
        }
      });
    }
  }

  const dlBtn = els.result.querySelector<HTMLButtonElement>('[data-dl-print]');
  if (dlBtn) dlBtn.addEventListener('click', () => { if (els._print) openPrint(els._print); });

  bindSourceClicks(els.result);
}

// ── topic picker (from the course Topic Map) ────────────────────────────

function fillTopicSelect(sel: HTMLSelectElement | null, topics: CourseTopic[]): void {
  if (!sel || !sel.isConnected) return;
  sel.innerHTML = '<option value="">Choose a topic…</option>' +
    topics.map((t) => {
      const imp = t.importance ? ' (' + t.importance + ')' : '';
      return '<option value="' + esc(t.name) + '">' + esc(t.name) + imp + '</option>';
    }).join('');
}

// The Topic Map is auto-derived from the user's indexed files, but nothing
// builds it until something asks. So when it's empty we trigger a build and
// poll until the rolled-up topics appear — the user never has to know the
// map exists. The free-text box stays available the whole time as a fallback.
function buildAndPollTopics(svc: typeof import('../../services/ai-service.js'), sel: HTMLSelectElement | null, courseId: string): void {
  if (!svc.generateCourseTopicMap) {
    if (sel) sel.innerHTML = '<option value="">No topic map yet — type a topic below</option>';
    return;
  }
  if (sel) sel.innerHTML = '<option value="">Building your topic map…</option>';
  const poll = (tries: number): void => {
    svc.getCourseTopicMap(courseId).then((topics) => {
      if (!sel || !sel.isConnected) return;
      if (topics?.length) { fillTopicSelect(sel, topics); return; }
      if (tries < 4) { setTimeout(() => poll(tries + 1), 2500); return; }
      sel.innerHTML = '<option value="">No topics found — type a topic below</option>';
    }).catch(() => {
      if (sel) sel.innerHTML = '<option value="">Type a topic below</option>';
    });
  };
  svc.generateCourseTopicMap(courseId)
    .then((topics) => {
      if (!sel || !sel.isConnected) return;
      if (topics?.length) { fillTopicSelect(sel, topics); return; }
      setTimeout(() => poll(0), 2500);
    })
    .catch(() => {
      if (sel) sel.innerHTML = '<option value="">No topic map yet — type a topic below</option>';
    });
}

function populateTopics(svc: typeof import('../../services/ai-service.js'), sel: HTMLSelectElement | null, courseId: string): void {
  svc.getCourseTopicMap(courseId)
    .then((topics) => {
      if (!sel || !sel.isConnected) return;
      if (topics?.length) { fillTopicSelect(sel, topics); return; }
      // Empty map → build it from the user's files, then poll for the result.
      buildAndPollTopics(svc, sel, courseId);
    })
    .catch(() => {
      if (sel) sel.innerHTML = '<option value="">Type a topic below</option>';
    });
}

// ── saved lessons (persisted as notes of type 'deep_learn') ────────────────

function fmtDate(s: string | undefined): string {
  if (!s) return '';
  try {
    return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function viewSaved(svc: typeof import('../../services/ai-service.js'), els: Els, id: string): void {
  if (!id || !svc.getNoteById) return;
  els.result.innerHTML = '<div class="dl-msg dl-loading">Loading lesson…</div>';
  svc.getNoteById(id).then((note) => {
    if (!note) { els.result.innerHTML = '<div class="dl-msg dl-error">Could not load this lesson.</div>'; return; }
    const structured = parseStructuredNote(note);
    if (structured) {
      renderStructuredResult(els, {
        title: note.title,
        topic: note.title,
        lesson: '',
        workedExample: '',
        structuredLesson: structured,
        groundedSources: (note.note_sources || []) as GroundedSource[],
      }, structured);
      return;
    }
    els._print = { course: els.courseName || '', title: note.title || 'Lesson', markdown: note.content_markdown || '' };
    els.result.innerHTML =
      '<div class="dl-lesson-card"><div class="dl-lesson-head"><h3>' + esc(note.title || 'Lesson') + '</h3>' +
      '<button type="button" class="dl-btn dl-download" data-dl-print>⤓ Download PDF</button></div>' +
      '<div class="dl-section dl-saved-body"></div></div>';
    renderMarkdownInto(els.result.querySelector('.dl-saved-body'), note.content_markdown || '');
    const dlBtn = els.result.querySelector<HTMLButtonElement>('[data-dl-print]');
    if (dlBtn) dlBtn.addEventListener('click', () => { if (els._print) openPrint(els._print); });
  }).catch(() => {
    els.result.innerHTML = '<div class="dl-msg dl-error">Could not load this lesson.</div>';
  });
}

function renderSavedListRich(svc: typeof import('../../services/ai-service.js'), els: Els, courseId: string, lessons: SavedNote[]): void {
  if (!els.saved || !els.savedList) return;
  if (!lessons.length) {
    els.saved.setAttribute('hidden', '');
    els.savedList.innerHTML = '';
    return;
  }
  els.saved.removeAttribute('hidden');
  els.savedList.innerHTML = lessons.map((n) => {
    const structured = parseStructuredNote(n);
    const preview = previewFromLesson(structured, n.content_markdown || n.preview || '');
    const source = sourceSummary(n);
    return '<div class="dl-saved-item">' +
      '<div class="dl-saved-main">' +
        '<div class="dl-saved-meta"><span class="dl-saved-title">' + esc(n.title || 'Lesson') + '</span>' +
        '<span class="dl-saved-date">' + esc(fmtDate(n.created_at || n.updated_at)) + '</span></div>' +
        (source ? '<div class="dl-saved-source">' + esc(source) + '</div>' : '') +
        (preview ? '<div class="dl-saved-preview">' + esc(preview) + '</div>' : '') +
      '</div>' +
      '<div class="dl-saved-actions">' +
        '<button type="button" class="dl-saved-open" data-id="' + esc(n.id) + '">Open</button>' +
        '<button type="button" class="dl-saved-regenerate" data-topic="' + esc(n.title || '') + '">Regenerate</button>' +
        '<button type="button" class="dl-saved-del" data-id="' + esc(n.id) + '" title="Delete lesson" aria-label="Delete lesson">×</button>' +
      '</div>' +
    '</div>';
  }).join('');
  els.savedList.querySelectorAll<HTMLButtonElement>('.dl-saved-open').forEach((b) => {
    b.addEventListener('click', () => viewSaved(svc, els, b.getAttribute('data-id') || ''));
  });
  els.savedList.querySelectorAll<HTMLButtonElement>('.dl-saved-del').forEach((b) => {
    b.addEventListener('click', () => {
      b.disabled = true;
      svc.deleteNote(b.getAttribute('data-id') || '').then(() => loadSaved(svc, els, courseId));
    });
  });
  els.savedList.querySelectorAll<HTMLButtonElement>('.dl-saved-regenerate').forEach((b) => {
    b.addEventListener('click', () => {
      if (els.text) els.text.value = (b.getAttribute('data-topic') || '').replace(/\s+—\s+Version\s+\d+$/i, '');
      if (els.select) els.select.value = '';
      els.gen?.click();
    });
  });
}

function loadSaved(svc: typeof import('../../services/ai-service.js'), els: Els, courseId: string): void {
  if (!svc.listCourseNotes || !courseId) return;
  svc.listCourseNotes(courseId).then((notes) => {
    const lessons = (notes || []).filter((n) => n.type === 'deep_learn');
    renderSavedListRich(svc, els, courseId, lessons);
  }).catch(() => { /* non-fatal: saved list is additive */ });
}

// ── source picker (choose which indexed files to ground the lesson on) ────

interface FolderIndex {
  fileToFolder: Record<string, string>;
  live: Record<string, boolean>;
}

function courseFileFolderIndex(course: LibraryCourse): FolderIndex {
  const fileToFolder: Record<string, string> = {};
  const live: Record<string, boolean> = {};
  ((course.files || []) as CourseFile[]).forEach((f) => {
    if (f?.name) live[f.name] = true;
  });
  ((course.userFolders || []) as CourseFolder[]).forEach((fd) => {
    (fd.files || []).forEach((f) => {
      if (!f?.name) return;
      live[f.name] = true;
      fileToFolder[f.name] = fd.name || 'Folder';
    });
  });
  return { fileToFolder, live };
}

interface GroupedDocs {
  map: Record<string, CourseDocument[]>;
  order: string[];
  other: CourseDocument[];
}

function groupDocsByFolder(docs: CourseDocument[], course: LibraryCourse): GroupedDocs {
  const idx = courseFileFolderIndex(course);
  const liveNames = Object.keys(idx.live);
  let list = docs;
  if (liveNames.length) {
    list = (docs || []).filter((d) => !!idx.live[d.file_name || d.fileName || '']);
  }
  const map: Record<string, CourseDocument[]> = {};
  const order: string[] = [];
  const other: CourseDocument[] = [];
  (list || []).forEach((d) => {
    const name = d.file_name || d.fileName || '';
    const folder = idx.fileToFolder[name];
    if (folder) {
      if (!map[folder]) { map[folder] = []; order.push(folder); }
      map[folder]!.push(d);
    } else {
      other.push(d);
    }
  });
  return { map, order, other };
}

function showSourcePicker(docs: CourseDocument[], course: LibraryCourse, onConfirm: (documentIds: string[] | null) => void): void {
  document.getElementById('dlSourcePickerOverlay')?.remove();
  const grouped = groupDocsByFolder(docs, course);
  const itemHtml = (d: CourseDocument): string =>
    '<label class="qzsp-item">' +
      '<input type="checkbox" class="qzsp-cb" value="' + esc(d.id) + '" checked>' +
      '<span class="qzsp-name">' + esc(d.file_name || d.fileName || 'Untitled') + '</span>' +
    '</label>';
  const folderHtml = (name: string, docsInFolder: CourseDocument[], idx: number | string): string =>
    '<div class="qzsp-folder" data-folder-idx="' + esc(idx) + '">' +
      '<div class="qzsp-folder-header open">' +
        '<span class="qzsp-folder-toggle">&#x25BE;</span>' +
        '<span class="qzsp-folder-name">' + esc(name) + '</span>' +
        '<span class="qzsp-folder-count">' + docsInFolder.length + ' file' + (docsInFolder.length === 1 ? '' : 's') + '</span>' +
        '<button class="qzsp-folder-selall" data-folder-act="all" type="button">Select all</button>' +
        '<button class="qzsp-folder-selall qzsp-folder-clear" data-folder-act="none" type="button">Clear</button>' +
      '</div>' +
      '<div class="qzsp-folder-files">' + docsInFolder.map(itemHtml).join('') + '</div>' +
    '</div>';
  let sections = grouped.order.map((name, i) => folderHtml(name, grouped.map[name] || [], i)).join('');
  if (grouped.other.length) sections += folderHtml('Other files', grouped.other, 'other');

  const ov = document.createElement('div');
  ov.id = 'dlSourcePickerOverlay';
  ov.className = 'qzsp-overlay';
  ov.innerHTML =
    '<div class="qzsp-modal">' +
      '<div class="qzsp-head"><span class="qzsp-title">Choose lesson sources</span>' +
        '<button class="qzsp-close" type="button" aria-label="Close">&times;</button></div>' +
      '<p class="qzsp-sub">Select which indexed files Deep Learn should use. Folder controls affect only files inside that folder.</p>' +
      '<div class="qzsp-list qzsp-folder-list">' + sections + '</div>' +
      '<div class="qzsp-actions">' +
        '<button class="qzsp-btn-ghost" id="dlSpAll" type="button">Select all</button>' +
        '<button class="qzsp-btn-ghost" id="dlSpClear" type="button">Clear</button>' +
        '<button class="qzsp-btn-primary" id="dlSpConfirm" type="button">Generate from selected</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  const close = (): void => { ov.remove(); };
  ov.querySelector('.qzsp-close')?.addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelectorAll<HTMLElement>('.qzsp-folder-header').forEach((head) => {
    head.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-folder-act]')) return;
      const folder = head.closest<HTMLElement>('.qzsp-folder');
      const files = folder?.querySelector<HTMLElement>('.qzsp-folder-files');
      const open = files ? files.style.display !== 'none' : false;
      if (files) files.style.display = open ? 'none' : 'flex';
      const toggle = head.querySelector('.qzsp-folder-toggle');
      if (toggle) toggle.innerHTML = open ? '&#x25B8;' : '&#x25BE;';
      head.classList.toggle('open', !open);
    });
  });
  ov.querySelectorAll<HTMLElement>('[data-folder-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const folder = btn.closest<HTMLElement>('.qzsp-folder');
      const checked = btn.getAttribute('data-folder-act') === 'all';
      folder?.querySelectorAll<HTMLInputElement>('.qzsp-cb').forEach((cb) => { cb.checked = checked; });
    });
  });
  ov.querySelector('#dlSpAll')?.addEventListener('click', () => {
    ov.querySelectorAll<HTMLInputElement>('.qzsp-cb').forEach((cb) => { cb.checked = true; });
  });
  ov.querySelector('#dlSpClear')?.addEventListener('click', () => {
    ov.querySelectorAll<HTMLInputElement>('.qzsp-cb').forEach((cb) => { cb.checked = false; });
  });
  ov.querySelector('#dlSpConfirm')?.addEventListener('click', () => {
    const ids: string[] = [];
    ov.querySelectorAll<HTMLInputElement>('.qzsp-cb:checked').forEach((cb) => ids.push(cb.value));
    if (!ids.length) {
      window.showToast?.('No files selected', 'Select at least one indexed file.');
      return;
    }
    close();
    onConfirm(ids.length === (docs || []).length ? null : ids);
  });
}

// ── CSS injection ────────────────────────────────────────────────────────

const STYLE_ID = 'deepLearnWorkspaceCss';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = DEEP_LEARN_CSS;
  document.head.appendChild(style);
}

// ── mount ───────────────────────────────────────────────────────────────

const ROOT_HTML =
  '<div class="dl-root" data-deeplearn-root>' +
    '<div class="dl-head">' +
      '<h2>Deep Learn</h2>' +
      '<p>A guided, grounded deep-dive into one topic — explanation, a worked example, and a self-check, all from your uploaded files.</p>' +
    '</div>' +
    '<div class="dl-controls">' +
      '<select id="dlTopicSelect" class="dl-select"><option value="">Loading topics…</option></select>' +
      '<input type="text" id="dlTopicText" class="dl-topic" placeholder="…or type any topic">' +
      '<select id="dlLessonMode" class="dl-select dl-mode-select" title="Lesson mode">' +
        '<option value="exam">Exam preparation</option>' +
        '<option value="simple">Simple explanation</option>' +
        '<option value="professor">Professor-style</option>' +
        '<option value="application">Practical application</option>' +
        '<option value="revision">Fast revision</option>' +
      '</select>' +
      '<select id="dlLessonLanguage" class="dl-select dl-language-select" title="Lesson language">' +
        '<option value="same">Same as course</option>' +
        '<option value="de">German</option>' +
        '<option value="en">English</option>' +
      '</select>' +
      '<button class="dl-btn dl-btn-primary" id="dlGenerate" type="button">Teach me this</button>' +
    '</div>' +
    '<div class="dl-saved" id="dlSaved" hidden>' +
      '<div class="dl-saved-head">Saved lessons</div>' +
      '<div class="dl-saved-list" id="dlSavedList"></div>' +
    '</div>' +
    '<div class="dl-result" id="dlResult"></div>' +
  '</div>';

/** Mount the Deep Learn study tool into `target`. Synchronous: sets
 *  target.innerHTML before returning (openStudyToolWorkspace checks
 *  target.firstElementChild immediately after calling this). */
export function mountDeepLearnWorkspace(
  target: HTMLElement,
  course: LibraryCourse,
  options: Record<string, unknown> = {}
): void {
  if (!target) return;
  ensureStyles();
  target.innerHTML = ROOT_HTML;
  const root = target.querySelector<HTMLElement>('[data-deeplearn-root]');
  if (!root) return;
  const courseId = course.id || window.activeCourseId || '';
  const els: Els = {
    courseName: course.name || course.short || '',
    select: root.querySelector('#dlTopicSelect'),
    text: root.querySelector('#dlTopicText'),
    mode: root.querySelector('#dlLessonMode'),
    language: root.querySelector('#dlLessonLanguage'),
    gen: root.querySelector('#dlGenerate'),
    result: root.querySelector('#dlResult')!,
    saved: root.querySelector('#dlSaved'),
    savedList: root.querySelector('#dlSavedList'),
  };

  const opts = (options || {}) as DeepLearnMountOptions;
  const initial = opts.initialParameters || {};
  const initialDocumentIds = Array.isArray(opts.initialDocumentIds) ? opts.initialDocumentIds.filter(Boolean) : [];
  const initialVisualIds = Array.isArray(opts.initialVisualIds) ? opts.initialVisualIds.filter(Boolean) : [];
  const initialExistingLessonId = opts.initialExistingLessonId || '';
  if (els.text && initial.topic) els.text.value = initial.topic;
  if (els.mode && initial.lessonMode) els.mode.value = initial.lessonMode;
  if (els.language && (initial.lessonLanguage || initial.language)) {
    els.language.value = initial.lessonLanguage || initial.language || 'same';
  }

  let docsPromise: Promise<CourseDocument[]> | null = null;
  function loadCourseDocs(): Promise<CourseDocument[]> {
    if (!docsPromise) {
      docsPromise = aiService()
        .then((svc) => {
          const list = typeof svc.prefetchCourseDocuments === 'function'
            ? svc.prefetchCourseDocuments(courseId)
            : svc.listCourseDocuments(courseId);
          return list.then((docs) =>
            typeof svc.filterDocsByCourseFiles === 'function'
              ? svc.filterDocsByCourseFiles(docs, courseId) : docs
          );
        })
        .catch((err) => {
          docsPromise = null;
          throw err;
        });
    }
    return docsPromise;
  }

  aiService().then((svc) => {
    populateTopics(svc, els.select, courseId);
    loadSaved(svc, els, courseId);
    if (initialExistingLessonId) viewSaved(svc, els, initialExistingLessonId);
  });
  if (courseId) loadCourseDocs().catch(() => { /* retry on click */ });

  // Selecting a topic from the map clears the free-text box and vice-versa.
  els.select?.addEventListener('change', () => {
    if (els.select?.value && els.text) els.text.value = '';
  });
  els.text?.addEventListener('input', () => {
    if (els.text?.value && els.select) els.select.value = '';
  });

  function doGenerate(documentIds: string[] | null): void {
    const topic = (els.text?.value || els.select?.value || '').trim();
    if (!topic) {
      window.showToast?.('Pick a topic', 'Choose a topic from the list or type one.');
      return;
    }
    if (els.gen) els.gen.disabled = true;
    els.result.innerHTML = '<div class="dl-msg dl-loading">Building your lesson on "' + esc(topic) + '"…</div>';
    const progress = startBuildSteps(els, topic);
    aiService()
      .then((svc) => {
        const generateOpts: Record<string, unknown> = {};
        if (documentIds && documentIds.length) generateOpts.documentIds = documentIds;
        if (initialVisualIds.length) generateOpts.visualIds = initialVisualIds;
        if (Array.isArray(initial.learningGoals) && initial.learningGoals.length) {
          generateOpts.learningGoals = initial.learningGoals;
        }
        if (Array.isArray(opts.initialSourceChunkIds) && opts.initialSourceChunkIds.length) {
          generateOpts.sourceChunkIds = opts.initialSourceChunkIds;
        }
        if (opts.recommendationId) generateOpts.recommendationId = opts.recommendationId;
        if (els.mode?.value) generateOpts.lessonMode = els.mode.value;
        if (els.language?.value) generateOpts.lessonLanguage = els.language.value;
        if (els.courseName) generateOpts.courseName = els.courseName;
        const major = window._userMajor || (() => { try { return localStorage.getItem('ss_major') || ''; } catch { return ''; } })();
        if (major) generateOpts.studentMajor = major;
        return svc.generateDeepLearn(
          courseId, topic, generateOpts as Parameters<typeof svc.generateDeepLearn>[2]
        ).then((res) => {
          if (els.gen) els.gen.disabled = false;
          progress.stop();
          renderResultProgressive(els, res, progress.id);
          // A new lesson was just saved — refresh the saved list.
          if (res?.noteId) loadSaved(svc, els, courseId);
        });
      })
      .catch(() => {
        if (els.gen) els.gen.disabled = false;
        progress.stop();
        els.result.innerHTML = '<div class="dl-msg dl-error">I couldn\'t create that lesson just now. Please try again in a moment.</div>';
      });
  }

  els.gen?.addEventListener('click', () => {
    if (!courseId) return;
    const topic = (els.text?.value || els.select?.value || '').trim();
    if (!topic) {
      window.showToast?.('Pick a topic', 'Choose a topic from the list or type one.');
      return;
    }
    if (els.gen) els.gen.disabled = true;
    loadCourseDocs()
      .then((docs) => {
        if (els.gen) els.gen.disabled = false;
        const ready = (docs || []).filter((d) => d.processing_status === 'ready');
        if (!ready.length) {
          els.result.innerHTML = '<div class="dl-msg">No indexed files yet. Upload and index a PDF first.</div>';
          return;
        }
        showSourcePicker(ready, course, (documentIds) => doGenerate(documentIds));
      })
      .catch(() => {
        if (els.gen) els.gen.disabled = false;
        els.result.innerHTML = '<div class="dl-msg dl-error">Could not load your files. Please try again.</div>';
      });
  });

  // A chatbot recommendation is itself the explicit user click. Reuse the
  // supplied authorised document scope and start exactly once after mount;
  // ordinary navigation continues to show the source picker.
  if (opts.autoStart === true && initial.topic && !initialExistingLessonId) {
    setTimeout(() => {
      if (!els.gen || els.gen.dataset.autoStarted === 'true') return;
      els.gen.dataset.autoStarted = 'true';
      doGenerate(initialDocumentIds.length ? initialDocumentIds : null);
    }, 0);
  }
}

// ── styles (ported from the retired legacy Deep Learn view's stylesheet;
//    pruned of the course-tab-panel-only rules — none of the feature-intrinsic
//    lesson/formula/adaptive/saved/print CSS below depended on the old
//    Course Overview tab layout, so this is close to a straight port) ──────

const DEEP_LEARN_CSS = `
.dl-root {
  padding: 18px 20px;
  color: var(--text, #e2e8f0);
}
.dl-head h2 { margin: 0 0 4px; font-size: 1.25rem; }
.dl-head p {
  margin: 0 0 16px;
  opacity: 0.75;
  font-size: 0.9rem;
  max-width: 62ch;
}
.dl-controls {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 18px;
}
.dl-select,
.dl-topic {
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #1e293b);
  background: var(--card-inner, rgba(255, 255, 255, 0.05));
  color: var(--text, #e2e8f0);
  font-size: 0.9rem;
}
.dl-select { flex: 1 1 240px; min-width: 200px; }
.dl-topic { flex: 1 1 200px; min-width: 160px; }
.dl-mode-select { flex: 0 1 190px; min-width: 170px; }
.dl-language-select { flex: 0 1 160px; min-width: 145px; }
.dl-btn {
  padding: 9px 18px;
  border-radius: 8px;
  border: 1px solid transparent;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
}
.dl-btn-primary { background: #6366f1; color: #fff; }
.dl-btn-primary:hover { background: #5457e6; }
.dl-btn-primary:disabled { opacity: 0.55; cursor: default; }

.dl-msg {
  padding: 18px;
  border-radius: 8px;
  background: var(--card-inner, rgba(255, 255, 255, 0.05));
  font-size: 0.9rem;
}
.dl-msg.dl-error { color: #fca5a5; }
.dl-msg.dl-loading { opacity: 0.85; }

.dl-lesson-card {
  border: 1px solid var(--border, #1e293b);
  border-radius: 10px;
  background: var(--card, #0f172a);
  padding: 16px 18px;
}
.dl-lesson-card h3 { margin: 0 0 10px; font-size: 1.1rem; }
.dl-lesson-card h4 { margin: 16px 0 6px; font-size: 0.98rem; }
.dl-section { font-size: 0.92rem; line-height: 1.55; }
.dl-section ul { margin: 4px 0 10px; padding-left: 20px; }

.dl-check {
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid var(--border, #1e293b);
  border-radius: 8px;
  background: var(--card-inner, rgba(255, 255, 255, 0.04));
}
.dl-check-q { font-weight: 600; margin: 0 0 10px; }
.dl-reveal {
  background: transparent;
  border: 1px solid var(--border, #1e293b);
  color: var(--text, #e2e8f0);
}
.dl-reveal:hover { background: rgba(255, 255, 255, 0.06); }
.dl-check-a { margin-top: 10px; font-size: 0.9rem; line-height: 1.5; }

.dl-sources {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border, #1e293b);
  font-size: 0.8rem;
  opacity: 0.85;
}

.dl-lesson-head { display: flex; align-items: center; gap: 10px; }
.dl-lesson-head h3 { margin: 0; }
.dl-download {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--border, #334155);
  color: var(--text, #e2e8f0);
  font-size: 0.82rem;
  padding: 5px 12px;
}
.dl-download:hover { background: rgba(255, 255, 255, 0.07); }

/* Source picker (.qzsp-*): intentionally NOT styled here. The retired legacy
   stylesheet had a dead .dl-sp-* block that never matched the picker's
   actual markup (.qzsp-*, shared with Practice/Flashcards/Cheatsheet) -- the
   picker has in fact always been styled by the always-loaded global rules in
   frontend/css/styles.css. Duplicating them here would risk drifting out of
   sync with that shared component, so this module relies on the global CSS
   exactly like the other study tools do. */

/* Printable white lesson view */
.dl-print-overlay {
  position: fixed;
  inset: 0;
  z-index: 4200;
  display: flex;
  flex-direction: column;
  background: #5b6066;
}
.ss-print-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: #0f172a;
  color: #e2e8f0;
  border-bottom: 1px solid #1e293b;
}
.ss-print-bar-title { font-weight: 600; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-print-bar-actions { margin-left: auto; display: flex; gap: 8px; }
.ss-print-btn {
  border: 1px solid #334155;
  background: #1e293b;
  color: #e2e8f0;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 0.85rem;
  cursor: pointer;
}
.ss-print-btn:hover { background: #334155; }
.ss-print-scroll { flex: 1 1 auto; overflow: auto; padding: 22px; }
.ss-print-doc {
  display: block;
  max-width: 780px;
  margin: 0 auto;
  background: #fff;
  color: #111827;
  padding: 30px 38px 40px;
  border-radius: 4px;
  box-shadow: 0 6px 30px rgba(0, 0, 0, 0.4);
  line-height: 1.55;
}
.ss-print-head { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 16px; }
.ss-print-course { font-size: 0.78rem; color: #6b7280; }
.ss-print-head h1 { font-size: 1.4rem; margin: 2px 0 0; color: #111827; }
.ss-print-body { font-size: 0.92rem; color: #111827; }
.ss-print-body h2 {
  font-size: 1.05rem;
  margin: 18px 0 6px;
  color: #1d4ed8;
  border-bottom: 1px solid #bfdbfe;
  padding-bottom: 3px;
}
.ss-print-body h3, .ss-print-body h4 { margin: 12px 0 4px; color: #334155; }
.ss-print-body ul { padding-left: 20px; }
.ss-print-body .katex-display { overflow-x: auto; }
/* Coloured bold labels in the printable lesson */
.ss-print-body .dl-c-warn { color: #b91c1c; }
.ss-print-body .dl-c-ok { color: #047857; }
.ss-print-body .dl-c-muted { color: #6b7280; }
.ss-print-body .dl-c-key { color: #1d4ed8; }

/* Saved lessons — fade/slide in instead of popping in via [hidden] toggle,
   which causes a jarring layout jump that feels like a page refresh. */
.dl-saved {
  margin-bottom: 18px;
  overflow: hidden;
  max-height: 600px;
  opacity: 1;
  transition: opacity 0.18s ease, max-height 0.22s ease, margin 0.22s ease;
}
.dl-saved[hidden] {
  display: block;
  margin-bottom: 0;
  max-height: 0;
  opacity: 0;
  pointer-events: none;
}
.dl-result {
  animation: dl-fade-in 0.16s ease;
}
@keyframes dl-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .dl-saved, .dl-result { transition: none; animation: none; }
}
.dl-saved-head {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.6;
  margin-bottom: 8px;
}
.dl-saved-list { display: flex; flex-direction: column; gap: 6px; }
.dl-saved-item {
  display: flex;
  align-items: stretch;
  gap: 6px;
}
.dl-saved-open {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #1e293b);
  background: var(--card-inner, rgba(255, 255, 255, 0.04));
  color: var(--text, #e2e8f0);
  font-size: 0.88rem;
  cursor: pointer;
  text-align: left;
}
.dl-saved-open:hover { background: rgba(255, 255, 255, 0.07); }
.dl-saved-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dl-saved-date { flex: 0 0 auto; opacity: 0.55; font-size: 0.8rem; }
.dl-saved-del {
  flex: 0 0 auto;
  width: 34px;
  border-radius: 8px;
  border: 1px solid var(--border, #1e293b);
  background: transparent;
  color: var(--text, #e2e8f0);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
}
.dl-saved-del:hover { background: rgba(248, 113, 113, 0.15); color: #fca5a5; opacity: 1; }

/* Structured guided lesson */
.dl-kicker {
  margin: 0 0 4px;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #93c5fd;
  font-weight: 700;
}
.dl-lesson-meta {
  margin-top: 4px;
  color: var(--muted, #94a3b8);
  font-size: 0.78rem;
  font-weight: 700;
}
.dl-warning {
  margin: 10px 0 0;
  padding: 10px 12px;
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.10);
  color: #fcd34d;
  font-size: 0.86rem;
}
.dl-study-section {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--border, #1e293b);
  border-radius: 8px;
  background: var(--card-inner, rgba(255, 255, 255, 0.035));
}
.dl-study-section h4 {
  margin: 0 0 8px;
  color: var(--text, #e2e8f0);
}
.dl-muted {
  margin: 0;
  color: var(--muted, #94a3b8);
  font-size: 0.88rem;
}
.dl-formulas {
  display: grid;
  gap: 10px;
}
.dl-formula-box {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(96, 165, 250, 0.24);
  background: rgba(59, 130, 246, 0.08);
}
.dl-formula-main {
  margin-bottom: 10px;
  overflow-x: auto;
}
.dl-formula-box dl {
  display: grid;
  grid-template-columns: minmax(100px, 150px) 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 0.88rem;
}
.dl-formula-box dt {
  color: #bfdbfe;
  font-weight: 700;
}
.dl-formula-box dd {
  margin: 0;
  color: var(--text, #e2e8f0);
}
.dl-worked ol,
.dl-method ol,
.dl-mistakes ul {
  margin: 6px 0 0;
  padding-left: 22px;
}
.dl-source-basis {
  color: var(--muted, #94a3b8);
  font-size: 0.88rem;
}
.dl-checks {
  display: grid;
  gap: 10px;
}
.dl-check-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dl-check-card {
  padding: 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.035);
}
.dl-method-guide,
.dl-examples,
.dl-practice-tasks {
  display: grid;
  gap: 10px;
}
.dl-method-card,
.dl-example-card,
.dl-practice-card {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(96, 165, 250, 0.18);
  background: rgba(59, 130, 246, 0.055);
}
.dl-example-card h5 {
  margin: 0 0 8px;
  font-size: 0.92rem;
  color: var(--text, #e2e8f0);
}
.dl-formula-box summary {
  cursor: pointer;
  font-weight: 800;
}
.dl-formula-title {
  color: #bfdbfe;
}
.dl-formula-meta {
  display: inline-flex;
  margin-left: 8px;
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid rgba(96, 165, 250, 0.24);
  background: rgba(59, 130, 246, 0.10);
  color: #93c5fd;
  font-size: 0.72rem;
  font-weight: 800;
  vertical-align: 1px;
}
.dl-source-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dl-source-list .src-cite,
.dl-source-chip {
  display: inline-flex;
  align-items: center;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(147, 197, 253, 0.26);
  background: rgba(59, 130, 246, 0.10);
  color: #bfdbfe;
  font-size: 0.8rem;
}
.dl-source-list .src-cite {
  cursor: pointer;
}

/* Rich saved lesson rows */
.dl-saved-main {
  flex: 1 1 auto;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #1e293b);
  background: var(--card-inner, rgba(255, 255, 255, 0.04));
}
.dl-saved-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.dl-saved-source,
.dl-saved-preview {
  margin-top: 4px;
  color: var(--muted, #94a3b8);
  font-size: 0.78rem;
  line-height: 1.35;
}
.dl-saved-preview {
  color: rgba(226, 232, 240, 0.78);
}
.dl-saved-actions {
  display: flex;
  gap: 6px;
  align-items: stretch;
}
.dl-saved-actions button {
  flex: 0 0 auto;
  width: auto;
  opacity: 1;
  border-radius: 8px;
  border: 1px solid var(--border, #1e293b);
  background: transparent;
  color: var(--text, #e2e8f0);
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
  padding: 0 10px;
}
.dl-saved-actions button:hover {
  background: rgba(255, 255, 255, 0.07);
}

/* Progressive generation */
.dl-build {
  padding: 16px 18px;
  border: 1px solid var(--border, #1e293b);
  border-radius: 10px;
  background: var(--card, #0f172a);
}
.dl-build-title {
  margin-bottom: 12px;
  font-weight: 700;
}
.dl-build-steps {
  display: grid;
  gap: 8px;
}
.dl-build-step {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--muted, #94a3b8);
  font-size: 0.88rem;
}
.dl-step-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  border: 1px solid #64748b;
}
.dl-build-step.is-active {
  color: var(--text, #e2e8f0);
}
.dl-build-step.is-active .dl-step-dot {
  border-color: #93c5fd;
  background: #60a5fa;
  box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.14);
}
.dl-build-step.is-done .dl-step-dot {
  border-color: #34d399;
  background: #34d399;
}
.dl-writing-line {
  margin: 10px 0 2px;
  color: #93c5fd;
  font-size: 0.82rem;
  font-weight: 700;
}
.dl-progress-hidden {
  display: none;
}

/* Unified course-tool redesign */
.dl-root {
  --dl-accent: #6366f1;
  --dl-accent-2: #0ea5e9;
  --dl-surface: color-mix(in srgb, var(--card, #0f172a) 88%, transparent);
  --dl-nested: var(--card-inner, rgba(255, 255, 255, 0.05));
  --dl-line: var(--border, #1e293b);
  display: grid;
  gap: 14px;
}

.dl-head {
  display: grid;
  gap: 4px;
}

.dl-head h2,
.dl-lesson-card h3,
.dl-study-section h4,
.dl-build-title {
  color: var(--text, #e2e8f0);
  letter-spacing: 0;
}

.dl-head p,
.dl-muted,
.dl-source-basis {
  color: var(--muted, #94a3b8);
  opacity: 1;
}

.dl-controls,
.dl-saved,
.dl-lesson-card,
.dl-msg,
.dl-build {
  border: 1px solid var(--dl-line);
  border-radius: 12px;
  background: var(--dl-surface);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
}

.dl-controls,
.dl-saved {
  padding: 14px;
  margin-bottom: 0;
}

.dl-controls {
  align-items: stretch;
}

.dl-select,
.dl-topic {
  border-radius: 10px;
  background: var(--dl-nested);
  border-color: var(--dl-line);
}

.dl-btn-primary {
  background: linear-gradient(135deg, var(--dl-accent), var(--dl-accent-2));
  border-color: transparent;
  color: #fff;
  box-shadow: 0 12px 28px rgba(99, 102, 241, 0.18);
}

.dl-lesson-card,
.dl-build {
  padding: 16px;
}

.dl-lesson-head {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--dl-line);
  margin-bottom: 12px;
}

.dl-study-section,
.dl-check,
.dl-formula-box,
.dl-check-card,
.dl-saved-main,
.dl-saved-open {
  background: var(--dl-nested);
  border-color: var(--dl-line);
}

.dl-saved-actions button,
.dl-download,
.dl-reveal {
  border-radius: 8px;
}

body:not(.night) .dl-root {
  --dl-accent: #2563eb;
  --dl-accent-2: #0ea5e9;
  --dl-surface: var(--lm-card-bg);
  --dl-nested: var(--lm-nested-bg);
  --dl-line: var(--lm-card-border);
  color: var(--lm-text);
}

body:not(.night) .dl-head h2,
body:not(.night) .dl-lesson-card h3,
body:not(.night) .dl-study-section h4,
body:not(.night) .dl-build-title,
body:not(.night) .dl-saved-title,
body:not(.night) .dl-check-q {
  color: var(--lm-text) !important;
}

body:not(.night) .dl-head p,
body:not(.night) .dl-muted,
body:not(.night) .dl-source-basis,
body:not(.night) .dl-saved-date,
body:not(.night) .dl-saved-source,
body:not(.night) .dl-saved-preview,
body:not(.night) .dl-build-step,
body:not(.night) .dl-sources {
  color: var(--lm-muted) !important;
}

body:not(.night) .dl-controls,
body:not(.night) .dl-saved,
body:not(.night) .dl-lesson-card,
body:not(.night) .dl-msg,
body:not(.night) .dl-build {
  background: var(--lm-card-bg) !important;
  border-color: var(--lm-card-border) !important;
  box-shadow: var(--lm-card-shadow) !important;
  color: var(--lm-text) !important;
}

body:not(.night) .dl-select,
body:not(.night) .dl-topic,
body:not(.night) .dl-study-section,
body:not(.night) .dl-check,
body:not(.night) .dl-formula-box,
body:not(.night) .dl-check-card,
body:not(.night) .dl-saved-main,
body:not(.night) .dl-saved-open,
body:not(.night) .dl-saved-actions button,
body:not(.night) .dl-download,
body:not(.night) .dl-reveal {
  background: var(--lm-nested-bg) !important;
  border-color: var(--lm-nested-border) !important;
  color: var(--lm-text) !important;
  box-shadow: var(--lm-nested-shadow) !important;
}

body:not(.night) .dl-saved-open:hover,
body:not(.night) .dl-saved-actions button:hover,
body:not(.night) .dl-download:hover,
body:not(.night) .dl-reveal:hover {
  background: rgba(239, 246, 255, 0.96) !important;
  border-color: var(--lm-card-border-strong) !important;
}

body:not(.night) .dl-btn-primary {
  color: #fff !important;
  border-color: rgba(37, 99, 235, 0.70) !important;
  background: linear-gradient(135deg, #2563eb, #0ea5e9) !important;
  box-shadow: 0 12px 28px rgba(37, 99, 235, 0.22) !important;
}

body:not(.night) .dl-kicker,
body:not(.night) .dl-writing-line,
body:not(.night) .dl-formula-box dt,
body:not(.night) .dl-source-list .src-cite,
body:not(.night) .dl-source-chip {
  color: #1d4ed8 !important;
}
body:not(.night) .dl-lesson-meta {
  color: var(--lm-muted) !important;
}
body:not(.night) .dl-method-card,
body:not(.night) .dl-example-card,
body:not(.night) .dl-practice-card {
  background: var(--lm-nested-bg) !important;
  border-color: var(--lm-nested-border) !important;
  color: var(--lm-text) !important;
  box-shadow: var(--lm-nested-shadow) !important;
}
body:not(.night) .dl-example-card h5,
body:not(.night) .dl-formula-title {
  color: #1d4ed8 !important;
}
body:not(.night) .dl-formula-meta {
  background: rgba(37, 99, 235, 0.08) !important;
  border-color: rgba(37, 99, 235, 0.18) !important;
  color: #1d4ed8 !important;
}

body:not(.night) .dl-source-list .src-cite,
body:not(.night) .dl-source-chip {
  background: rgba(37, 99, 235, 0.10) !important;
  border-color: rgba(37, 99, 235, 0.24) !important;
}

body:not(.night) .dl-warning {
  background: rgba(245, 158, 11, 0.10) !important;
  border-color: rgba(245, 158, 11, 0.30) !important;
  color: #92400e !important;
}

.dl-progress-visible {
  animation: dlFadeIn 200ms ease-out;
}
.dl-download:disabled {
  opacity: 0.45;
  cursor: default;
}
@keyframes dlFadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.dl-course-visual-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; }
.dl-course-visual { margin: 0; min-width: 0; overflow: hidden; border: 1px solid rgba(148,163,184,.25); border-radius: 12px; }
.dl-course-visual img { display: block; width: 100%; max-height: 280px; object-fit: contain; background: #fff; }
.dl-course-visual figcaption { padding: 10px; overflow-wrap: anywhere; }
.dl-course-visual figcaption p { margin: 5px 0 9px; }
.dl-course-visual-open { border: 0; border-radius: 8px; padding: 7px 10px; background: #2563eb; color: #fff; font: inherit; cursor: pointer; }
.dl-course-visual-open:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
`;
