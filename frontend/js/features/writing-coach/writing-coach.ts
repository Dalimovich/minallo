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
import { transitionLearnerWorkspace } from '../chatbot-new/experience-mode.js';
import { WritingExamSession, writingExamRequest, writingProfileReady, type WritingGrade } from './writing-exam.js';

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
let _examMode = true;
let _opened = false;
let _session = new WritingExamSession();
let _selectedTopic = '';
let _examDraft = '';
let _grade: WritingGrade | null = null;
let _saving = false;
let _saved = false;
let _generating = false;

export function initWritingCoach(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => _tryWire());
  } else {
    _tryWire();
  }
  (window as unknown as { _wcOpen: typeof openWritingCoach })._wcOpen = openWritingCoach;
  window.addEventListener('ss-profile-updated', () => {
    if (_opened) void _prepareMode();
  });
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
  void transitionLearnerWorkspace('writing-coach').then(() => {
    if (document.getElementById('ncbRoot')?.dataset.workspaceView === 'writing-coach') {
      document.getElementById('wcInput')?.focus();
    }
  });
  _tryWire();
  _opened = true;
  void _prepareMode();

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
  document.getElementById('wcExamMode')?.addEventListener('click', () => _switchMode(true));
  document.getElementById('wcGenericMode')?.addEventListener('click', () => _switchMode(false));
  // Level is no longer user-selected here; it comes from the profile.
  // Wire the "Go to Profile" button in the empty state.
  const goProfile = document.getElementById('wcGoProfile');
  goProfile?.addEventListener('click', () => {
    const w = window as unknown as { showPortalSection?: (s: string) => void };
    if (typeof w.showPortalSection === 'function') w.showPortalSection('profile');
  });

  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  if (ta) {
    ta.value = _examMode ? _examDraft : localStorage.getItem(DRAFT_KEY) || '';
    ta.addEventListener('input', () => {
      if (_examMode) _examDraft = ta.value;
      else localStorage.setItem(DRAFT_KEY, ta.value);
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
  btn.disabled = !!_activeAbort || _saving || ta.value.trim().length < MIN_CHARS ||
    (_examMode ? !_selectedTopic || !_session.task || !!_grade : !_profileLevel());
  const count = document.getElementById('wcWordCount');
  if (count) count.textContent = `${ta.value.trim().split(/\s+/).filter(Boolean).length} Wörter${_examMode ? ' · Ziel: mindestens 350' : ''}`;
}

function _switchMode(exam: boolean): void {
  if (_activeAbort || _saving || _examMode === exam) return;
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  if (ta) {
    if (_examMode) _examDraft = ta.value;
    else localStorage.setItem(DRAFT_KEY, ta.value);
    ta.value = exam ? _examDraft : localStorage.getItem(DRAFT_KEY) || '';
    ta.readOnly = exam && !!_grade;
  }
  _examMode = exam;
  const results = document.getElementById('wcResults');
  if (results) results.hidden = true;
  void _prepareMode();
  if (exam && _grade) _renderExamGrade();
}

async function _prepareMode(): Promise<void> {
  if (_examMode && window._germanProfileLoaded && !writingProfileReady()) {
    _switchMode(false);
    return;
  }
  const generic = document.getElementById('wcGenericControls');
  const taskRoot = document.getElementById('wcExamTask');
  const examButton = document.getElementById('wcExamMode') as HTMLButtonElement | null;
  if (generic) generic.hidden = _examMode;
  if (taskRoot) taskRoot.hidden = !_examMode;
  if (examButton) examButton.disabled = !!window._germanProfileLoaded && !writingProfileReady();
  const btn = document.getElementById('wcAnalyze');
  if (btn) {
    btn.removeAttribute('data-i18n');
    btn.textContent = _examMode ? 'Bewerten' : 'Analyze with AI';
  }
  if (!_examMode) { _renderProfileLevel(); _updateAnalyzeEnabled(); return; }
  const writer = document.getElementById('wcWriter');
  const noLevel = document.getElementById('wcNoLevel');
  if (writer) writer.hidden = false;
  if (noLevel) noLevel.hidden = true;
  _updateAnalyzeEnabled();
  if (!taskRoot || _session.task || _generating) return;
  if (!writingProfileReady()) {
    taskRoot.textContent = 'Prüfungsprofil wird geladen …';
    return;
  }
  _generating = true;
  taskRoot.textContent = 'Zwei Schreibthemen werden erstellt …';
  const session = _session;
  try {
    await session.generate();
    if (_session === session) _renderTopics();
  } catch (error) {
    taskRoot.innerHTML = `<p class="wc-error">${_escape(friendlyAiErrorMessage(error))}</p><button type="button" id="wcGenerateRetry" class="ncb-wc-btn-secondary">Erneut versuchen</button>`;
    document.getElementById('wcGenerateRetry')?.addEventListener('click', () => { void _prepareMode(); });
  } finally {
    _generating = false;
    _updateAnalyzeEnabled();
  }
}

function _renderTopics(): void {
  const root = document.getElementById('wcExamTask');
  if (!root || !_session.task) return;
  root.innerHTML = `<h3>telc C1 Hochschule · C1 · Schreiben</h3><p>Wählen Sie ein Thema. Schreiben Sie mindestens 350 Wörter. Bearbeitungszeit: 70 Minuten.</p>` +
    _session.task.content.questions.map((topic, index) => `<section class="wc-result-section">
      <label><input type="radio" name="wcTopic" value="${_escape(topic.questionId)}" ${_grade || _activeAbort ? 'disabled' : ''} ${_selectedTopic === topic.questionId ? 'checked' : ''}> <strong>Thema ${index === 0 ? 'A' : 'B'}: ${_escape(topic.title)}</strong></label>
      <p>${_escape(topic.communicativeSituation)}</p><p style="white-space:pre-line">${_escape(topic.taskInstructions)}</p></section>`).join('');
  root.querySelectorAll<HTMLInputElement>('input[name="wcTopic"]').forEach(input => {
    input.addEventListener('change', () => { _selectedTopic = input.value; _updateAnalyzeEnabled(); });
  });
}

async function _gradeExam(): Promise<void> {
  const task = _session.task;
  const topic = task?.content.questions.find(t => t.questionId === _selectedTopic);
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  if (!task || !topic || !ta || _activeAbort || _grade || ta.value.trim().length < MIN_CHARS) return;
  const loading = document.getElementById('wcLoading');
  const results = document.getElementById('wcResults');
  _activeAbort = new AbortController();
  ta.readOnly = true;
  _renderTopics();
  if (loading) loading.hidden = false;
  _updateAnalyzeEnabled();
  try {
    _grade = await writingExamRequest<WritingGrade>('grade-writing', {
      profileId: task.exam.profileId, partId: task.part.id, generationId: task.generationId,
      topicId: topic.questionId, selectedTopic: topic, writingCoachTaskType: topic.writingCoachTaskType,
      text: ta.value.trim()
    }, _activeAbort.signal);
    _renderTopics();
    _renderExamGrade();
    await _saveExamGrade();
  } catch (error) {
    if (results) {
      results.hidden = false;
      results.innerHTML = `<p class="wc-error">${_escape(friendlyAiErrorMessage(error))}</p>`;
    }
  } finally {
    _activeAbort = null;
    if (loading) loading.hidden = true;
    ta.readOnly = !!_grade;
    _renderTopics();
    _updateAnalyzeEnabled();
  }
}

function _renderExamGrade(): void {
  if (!_grade) return;
  _renderResults(_grade.analysis);
  const root = document.getElementById('wcResults');
  if (!root) return;
  const dimensions: [string, string][] = [['taskFulfilment', 'Aufgabengerechtheit'], ['correctness', 'Korrektheit'], ['repertoire', 'Repertoire'], ['communicativeDesign', 'Kommunikative Gestaltung']];
  root.insertAdjacentHTML('afterbegin', `<section class="wc-result-section"><h3>Schreiben: ${_grade.scoreValue ?? '–'} / ${_grade.maxScoreValue}</h3><p>KI-Übungseinschätzung anhand der vier telc-Dimensionen.</p><dl>${dimensions.map(([key, label]) => `<dt>${label}</dt><dd>${_grade!.rubric[key] ?? '–'} / 100</dd>`).join('')}</dl></section>`);
  root.insertAdjacentHTML('beforeend', '<p id="wcSaveStatus" role="status"></p><div id="wcWeakAreas"></div>');
  if (_saved) void _loadWritingWeaknesses();
}

async function _saveExamGrade(): Promise<void> {
  if (!_grade || !_session.task || _saving || _saved) return;
  const status = document.getElementById('wcSaveStatus');
  if (!_grade.examResultItems.length) {
    if (status) status.textContent = 'Noch keine zuverlässige Bewertung. Ergänzen Sie Ihren Text.';
    return;
  }
  _saving = true;
  if (status) status.textContent = 'Bewertung wird gespeichert …';
  try {
    const saved = await writingExamRequest<{ accepted: number; dropped: number }>('results', {
      examFamily: _session.task.exam.family, examVariant: _session.task.exam.variant,
      targetLevel: _session.task.exam.cefrLevel, module: 'writing', items: _grade.examResultItems
    });
    if (saved.accepted !== _grade.examResultItems.length || saved.dropped) throw new Error('Die Bewertung konnte nicht vollständig gespeichert werden.');
    _saved = true;
    if (status) status.textContent = 'Bewertung gespeichert.';
    await _loadWritingWeaknesses();
  } catch {
    if (status) {
      status.innerHTML = 'Speichern fehlgeschlagen. Ihr Text und Ihre Bewertung bleiben erhalten. <button type="button" id="wcSaveRetry" class="ncb-wc-btn-secondary">Speichern erneut versuchen</button>';
      document.getElementById('wcSaveRetry')?.addEventListener('click', () => { void _saveExamGrade(); });
    }
  } finally { _saving = false; _updateAnalyzeEnabled(); }
}

async function _loadWritingWeaknesses(): Promise<void> {
  const root = document.getElementById('wcWeakAreas');
  if (!root) return;
  try {
    const snapshot = await writingExamRequest<{ tags: Record<string, { score: number; nAttempts: number; confidence: string }> }>('weaknesses', { profileId: 'telc_c1_hochschule', module: 'writing' });
    const tags = Object.entries(snapshot.tags).filter(([, value]) => value.confidence !== 'cold_start').sort((a, b) => a[1].score - b[1].score);
    root.innerHTML = '<h3>Weak Areas · Schreiben</h3>' + (tags.length ? `<ul>${tags.map(([tag, value]) => `<li>${_escape(tag.replace(/_/g, ' '))}: ${Math.round(value.score * 100)}% (${value.nAttempts} Bewertungen)</li>`).join('')}</ul>` : '<p>Nach drei bewerteten Texten werden Ihre Übungsschwerpunkte sichtbar.</p>');
  } catch { root.textContent = 'Übungsschwerpunkte konnten nicht geladen werden.'; }
}

async function _analyze(): Promise<void> {
  if (_examMode) { await _gradeExam(); return; }
  if (_activeAbort) return;
  const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
  const btn = document.getElementById('wcAnalyze') as HTMLButtonElement | null;
  const loading = document.getElementById('wcLoading');
  const results = document.getElementById('wcResults');
  if (!ta || !btn) return;

  const text = ta.value.trim();
  const level = _profileLevel();
  if (text.length < MIN_CHARS || !level) return;

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
  if (!_examMode) sections.push(_renderScore(a.score, a.scoreExplanation, a.estimatedLevel));
  if (a.strengths.length) sections.push(_renderStrengths(a.strengths));

  const mistakes = a.feedbackItems.filter((i) => i.type === 'grammar' || i.type === 'pattern' && i.isActualError);
  const vocab = a.feedbackItems.filter((i) => i.type === 'vocabulary');
  const style = a.feedbackItems.filter((i) => i.type === 'style' || (i.type === 'pattern' && !i.isActualError));

  sections.push(_renderItemSection('Mistakes Explained', mistakes, 'No grammar issues found.'));
  sections.push(_renderItemSection('Vocabulary Improvements', vocab, 'No vocabulary suggestions.'));
  sections.push(_renderItemSection('Style / Register Improvements', style, 'No style suggestions.'));

  sections.push(`${_examMode ? '<details><summary>Überarbeitete Fassungen ansehen</summary>' : ''}
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
  ${_examMode ? '</details>' : ''}`);

  if (a.structureFeedback) sections.push(_renderStructure(a.structureFeedback));
  if (a.examReadiness && !_examMode) sections.push(_renderExam(a.examReadiness));

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
  if (again && _examMode) again.textContent = _grade?.analysis.insufficientContext ? 'Text ergänzen' : 'Neue Schreibaufgabe';
  again?.addEventListener('click', _resetForm);
}

function _resetForm(): void {
  if (_examMode) {
    if (_saving || _activeAbort) return;
    if (_grade?.examResultItems.length && !_saved) { void _saveExamGrade(); return; }
    const insufficient = !!_grade?.analysis.insufficientContext;
    _grade = null;
    _saved = false;
    const ta = document.getElementById('wcInput') as HTMLTextAreaElement | null;
    if (ta) {
      ta.readOnly = false;
      if (!insufficient) ta.value = '';
      ta.focus();
    }
    if (!insufficient) {
      _session = new WritingExamSession();
      _selectedTopic = '';
      _examDraft = '';
    } else _renderTopics();
    const results = document.getElementById('wcResults');
    if (results) results.hidden = true;
    void _prepareMode();
    return;
  }
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
