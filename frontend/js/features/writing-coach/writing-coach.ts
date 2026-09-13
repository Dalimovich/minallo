// Writing Coach — view logic (mount, submit, localStorage).
//
// Writing Coach is a workspace mode INSIDE the modern chatbot shell
// (#ncbRoot, see frontend/views/chatbot/chatbot.html's
// .ncb-writing-coach-panel and frontend/js/features/chatbot-new/
// experience-mode.ts's setLearnerWorkspaceView) rather than a separate
// #psec-german page. Its markup ships as part of chatbot.html directly (no
// separate fetch+inject step); this module only waits for that markup to
// exist (chatbot.html itself is lazy-fetched by chatbot.js) and wires it.
// AI calls are delegated to writing-coach-ai — unchanged by this move.

import {
  analyzeParagraph,
  FeedbackItem,
  ScoreBlock,
  StructureFeedback,
  ExamReadiness,
  InsufficientContext,
  TaskType,
  WritingAnalysis,
} from './writing-coach-ai.js';
import { friendlyAiErrorMessage } from '../../services/ai-error-message.js';
import { setLearnerWorkspaceView } from '../chatbot-new/experience-mode.js';

const DRAFT_KEY = 'ss_writing_coach_draft';
const TASK_KEY = 'ss_writing_coach_task';
const MIN_CHARS = 10;
const DEFAULT_TASK: TaskType = 'freier_text';

/** Read the user's German level from the profile (loaded into window by
 * user-data.ts). The trainer is read-only on this value — editing happens
 * on the Profile page. */
function _profileLevel(): string {
  const w = window as unknown as { _germanLevel?: string };
  return (w._germanLevel || '').trim();
}

function _activeTaskType(): TaskType {
  const stored = (localStorage.getItem(TASK_KEY) || '').trim() as TaskType;
  const allowed: TaskType[] = [
    'email',
    'stellungnahme',
    'argumentation',
    'zusammenfassung',
    'bericht',
    'motivationsschreiben',
    'freier_text',
  ];
  return (allowed as string[]).includes(stored) ? stored : DEFAULT_TASK;
}

let _wired = false;
let _activeAbort: AbortController | null = null;

export function initWritingCoach(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => _tryWire());
  } else {
    _tryWire();
  }
  (window as unknown as { _wcOpen: typeof openWritingCoach })._wcOpen = openWritingCoach;
}

/** Public entry point — called both by router.js's legacy portal sidebar
 * item and by the [data-workspace-view="writing-coach"] click delegation in
 * experience-mode.ts. Switches the shell into Writing Coach view and does
 * this view's own render/focus setup. Retries briefly since chatbot.html
 * (and therefore #wcInput) may not have finished its own async fetch/inject
 * into #ncbRoot yet when this fires. */
export function openWritingCoach(attempt = 0): void {
  if (!document.getElementById('wcInput')) {
    if (attempt > 40) return;
    window.setTimeout(() => openWritingCoach(attempt + 1), 250);
    return;
  }
  setLearnerWorkspaceView('writing-coach');
  _renderProfileLevel();
  _updateAnalyzeEnabled();
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  ta?.focus();
}

function _tryWire(attempt = 0): void {
  if (_wired) return;
  if (!document.getElementById('wcInput')) {
    if (attempt > 40) return;
    window.setTimeout(() => _tryWire(attempt + 1), 250);
    return;
  }
  _wired = true;
  _wire();
}

function _wire(): void {
  // Level is no longer user-selected here; it comes from the profile.
  // Wire the "Go to Profile" button in the empty state.
  const goProfile = document.getElementById('wcGoProfile');
  goProfile?.addEventListener('click', () => {
    const w = window as unknown as { showPortalSection?: (s: string) => void };
    if (typeof w.showPortalSection === 'function') w.showPortalSection('profile');
  });

  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  if (ta) {
    ta.value = localStorage.getItem(DRAFT_KEY) || '';
    let saveTimer: number | null = null;
    ta.addEventListener('input', () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        localStorage.setItem(DRAFT_KEY, ta.value);
      }, 500);
      _updateAnalyzeEnabled();
    });
  }

  const taskSel = document.getElementById('wcTaskType') as HTMLSelectElement | null;
  if (taskSel) {
    taskSel.value = _activeTaskType();
    taskSel.addEventListener('change', () => {
      localStorage.setItem(TASK_KEY, taskSel.value);
    });
  }

  const btn = document.getElementById('wcAnalyze');
  btn?.addEventListener('click', () => {
    void _analyze();
  });

  _updateAnalyzeEnabled();
}

/** Toggle between the writer card and the empty state based on whether
 * the user has a German level on their profile, and stamp the imported
 * level into the read-only badge. */
function _renderProfileLevel(): void {
  const level = _profileLevel();
  const writer = document.getElementById('wcWriter');
  const noLevel = document.getElementById('wcNoLevel');
  const valueEl = document.getElementById('wcLevelValue');
  if (level) {
    if (valueEl) valueEl.textContent = level;
    if (writer) writer.hidden = false;
    if (noLevel) noLevel.hidden = true;
  } else {
    if (writer) writer.hidden = true;
    if (noLevel) noLevel.hidden = false;
  }
}

function _updateAnalyzeEnabled(): void {
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  const btn = document.getElementById('wcAnalyze') as HTMLButtonElement | null;
  if (!ta || !btn) return;
  // Also requires a profile level to grade against.
  btn.disabled = ta.value.trim().length < MIN_CHARS || !_profileLevel();
}

async function _analyze(): Promise<void> {
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  const btn = document.getElementById('wcAnalyze') as HTMLButtonElement | null;
  const loading = document.getElementById('wcLoading');
  const results = document.getElementById('wcResults');
  if (!ta || !btn) return;

  const text = ta.value.trim();
  const level = _profileLevel();
  if (text.length < MIN_CHARS || !level) return;

  if (_activeAbort) _activeAbort.abort();
  _activeAbort = new AbortController();

  btn.disabled = true;
  if (loading) loading.hidden = false;
  if (results) {
    results.hidden = true;
    results.innerHTML = '';
  }

  try {
    const analysis = await analyzeParagraph({
      text,
      profileLevel: level,
      taskType: _activeTaskType(),
      signal: _activeAbort.signal,
    });
    _renderResults(analysis);
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    console.error('[writing-coach] analyze error:', e);
    if (results) {
      results.hidden = false;
      const msg = friendlyAiErrorMessage(e);
      results.innerHTML = `<div class="wc-error">${_escape(msg)}</div>`;
    }
  } finally {
    if (loading) loading.hidden = true;
    btn.disabled = ta.value.trim().length < MIN_CHARS;
    _activeAbort = null;
  }
}

// ── Result rendering ──────────────────────────────────────────────────────
//
// Minimal rendering of the full response shape. The dedicated inline-highlight
// UI from the spec lands in the next slice; for now we just lay out the data
// so nothing is silently dropped.

function _renderResults(a: WritingAnalysis): void {
  const root = document.getElementById('wcResults');
  if (!root) return;
  root.hidden = false;

  if (a.insufficientContext) {
    root.innerHTML = _renderInsufficient(a.insufficientContext) + _renderFeedbackList(a.feedbackItems);
    _wireAgain();
    return;
  }

  const sections: string[] = [];
  sections.push(_renderScore(a.score, a.scoreExplanation, a.estimatedLevel));
  if (a.strengths.length) sections.push(_renderStrengths(a.strengths));

  const mistakes = a.feedbackItems.filter((i) => i.type === 'grammar' || i.type === 'pattern' && i.isActualError);
  const vocab = a.feedbackItems.filter((i) => i.type === 'vocabulary');
  const style = a.feedbackItems.filter((i) => i.type === 'style' || (i.type === 'pattern' && !i.isActualError));

  sections.push(_renderItemSection('Mistakes Explained', mistakes, 'No grammar issues found.'));
  sections.push(_renderItemSection('Vocabulary Improvements', vocab, 'No vocabulary suggestions.'));
  sections.push(_renderItemSection('Style / Register Improvements', style, 'No style suggestions.'));

  sections.push(`
    <section class="wc-result-section">
      <h3 class="wc-result-title">Corrected Version</h3>
      <p class="wc-result-subtitle">Same idea, same voice — language errors removed.</p>
      <p class="wc-corrected">${_escape(a.correctedText)}</p>
    </section>
    <section class="wc-result-section">
      <h3 class="wc-result-title">Improved Version</h3>
      <p class="wc-result-subtitle">How a strong ${_escape(a.profileLevel)} writer might phrase this. Use as inspiration, not a template.</p>
      <div class="wc-ai-warning">This improved version is a model answer. Do not copy it blindly — reuse the structure and vocabulary in your own words.</div>
      <p class="wc-improved">${_escape(a.improvedText)}</p>
    </section>
  `);

  if (a.structureFeedback) sections.push(_renderStructure(a.structureFeedback));
  if (a.examReadiness) sections.push(_renderExam(a.examReadiness));

  if (a.practiceRecommendations.length) {
    const tips = a.practiceRecommendations.map((t) => `<li>${_escape(t)}</li>`).join('');
    sections.push(`
      <section class="wc-result-section">
        <h3 class="wc-result-title">Practice Recommendations</h3>
        <ul class="wc-tips">${tips}</ul>
      </section>
    `);
  }

  if (a.longitudinalNote) {
    sections.push(`
      <section class="wc-result-section">
        <h3 class="wc-result-title">Progress note</h3>
        <p>${_escape(a.longitudinalNote)}</p>
      </section>
    `);
  }

  sections.push(`
    <div class="wc-result-actions">
      <button id="wcAgain" class="wc-btn-secondary" type="button">Write another</button>
    </div>
  `);

  root.innerHTML = sections.join('');
  _wireAgain();
}

function _renderScore(score: ScoreBlock, explanation: string, estimated: string): string {
  const cell = (label: string, v: number | null): string =>
    `<div class="wc-score-cell"><div class="wc-score-label">${_escape(label)}</div><div class="wc-score-value">${v == null ? '—' : v}</div></div>`;
  return `
    <section class="wc-result-section wc-score-section">
      <h3 class="wc-result-title">Score</h3>
      <div class="wc-score-grid">
        ${cell('Overall', score.overall)}
        ${cell('Grammar', score.grammar)}
        ${cell('Vocabulary', score.vocabulary)}
        ${cell('Structure', score.structure)}
        ${cell('Style', score.style)}
        ${cell('Task', score.taskFulfillment)}
      </div>
      ${estimated ? `<p class="wc-estimated">Estimated level: <strong>${_escape(estimated)}</strong></p>` : ''}
      ${explanation ? `<details class="wc-score-explain"><summary>Why this score?</summary><p>${_escape(explanation)}</p></details>` : ''}
    </section>
  `;
}

function _renderStrengths(strengths: string[]): string {
  const items = strengths.map((s) => `<li>${_escape(s)}</li>`).join('');
  return `
    <section class="wc-result-section wc-strengths-section">
      <h3 class="wc-result-title">Strengths</h3>
      <ul class="wc-strengths">${items}</ul>
    </section>
  `;
}

function _renderItemSection(title: string, items: FeedbackItem[], emptyMsg: string): string {
  const body = items.length
    ? `<div class="wc-issue-grid">${items.map(_issueCard).join('')}</div>`
    : `<p class="wc-empty">${_escape(emptyMsg)}</p>`;
  return `
    <section class="wc-result-section">
      <h3 class="wc-result-title">${_escape(title)}</h3>
      ${body}
    </section>
  `;
}

function _issueCard(item: FeedbackItem): string {
  const colorClass = `wc-color-${_colorForItem(item)}`;
  const severity = item.severity === 'optional' ? 'Suggestion' : item.severity;
  const ruleCard = item.ruleCard
    ? `<details class="wc-rule-card"><summary>Learn this rule</summary>
         <p><strong>${_escape(item.ruleCard.title)}</strong></p>
         <p>${_escape(item.ruleCard.rule)}</p>
         ${item.ruleCard.example ? `<p><em>${_escape(item.ruleCard.example)}</em></p>` : ''}
         ${item.ruleCard.miniExerciseHint ? `<p>${_escape(item.ruleCard.miniExerciseHint)}</p>` : ''}
       </details>`
    : '';
  const count = item.type === 'pattern' && item.count && item.count > 1
    ? `<span class="wc-issue-count">×${item.count}</span>`
    : '';
  return `
    <div class="wc-issue ${colorClass}" data-severity="${_escape(item.severity)}" data-confidence="${_escape(item.confidence)}">
      <div class="wc-issue-header">
        <span class="wc-issue-dot"></span>
        <span class="wc-issue-type">${_escape(item.label || item.category || item.type)}</span>
        <span class="wc-issue-severity">${_escape(severity)}</span>
        ${count}
      </div>
      <div class="wc-issue-change">
        <span class="wc-issue-original">${_escape(item.original)}</span>
        <span class="wc-issue-arrow">→</span>
        <span class="wc-issue-correction">${_escape(item.suggestion)}</span>
      </div>
      <p class="wc-issue-explanation">${_escape(item.explanation)}</p>
      ${ruleCard}
    </div>
  `;
}

function _colorForItem(item: FeedbackItem): string {
  if (item.type === 'grammar') return 'red';
  if (item.type === 'vocabulary') return 'yellow';
  if (item.type === 'style') return 'blue';
  // pattern colour follows whether it's an actual error
  return item.isActualError ? 'red' : 'blue';
}

function _renderStructure(s: StructureFeedback): string {
  const missing = s.missing.length
    ? `<ul class="wc-structure-missing">${s.missing.map((m) => `<li>${_escape(m)}</li>`).join('')}</ul>`
    : '';
  return `
    <section class="wc-result-section">
      <h3 class="wc-result-title">Structure feedback</h3>
      <p><strong>${_escape(s.verdict)}</strong> — ${_escape(s.note)}</p>
      ${missing}
    </section>
  `;
}

function _renderExam(e: ExamReadiness): string {
  const missing = e.missing.length
    ? `<ul class="wc-exam-missing">${e.missing.map((m) => `<li>${_escape(m)}</li>`).join('')}</ul>`
    : '';
  return `
    <section class="wc-result-section wc-exam-section" data-verdict="${_escape(e.verdict)}">
      <h3 class="wc-result-title">Exam readiness</h3>
      <p><strong>${e.wouldPass ? 'Likely passes' : 'Not yet'}</strong> — verdict: ${_escape(e.verdict)}</p>
      <p>${_escape(e.note)}</p>
      ${missing}
    </section>
  `;
}

function _renderInsufficient(ic: InsufficientContext): string {
  return `
    <section class="wc-result-section wc-insufficient">
      <h3 class="wc-result-title">Need more text</h3>
      <p>${_escape(ic.message)}</p>
    </section>
  `;
}

function _renderFeedbackList(items: FeedbackItem[]): string {
  if (!items.length) {
    return `<div class="wc-result-actions"><button id="wcAgain" class="wc-btn-secondary" type="button">Write another</button></div>`;
  }
  return _renderItemSection('Surface issues we could still spot', items, '') +
    `<div class="wc-result-actions"><button id="wcAgain" class="wc-btn-secondary" type="button">Write another</button></div>`;
}

function _wireAgain(): void {
  const again = document.getElementById('wcAgain');
  again?.addEventListener('click', _resetForm);
}

function _resetForm(): void {
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  const results = document.getElementById('wcResults');
  if (ta) {
    ta.value = '';
    ta.focus();
  }
  localStorage.removeItem(DRAFT_KEY);
  if (results) {
    results.hidden = true;
    results.innerHTML = '';
  }
  _updateAnalyzeEnabled();
}

function _escape(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}
