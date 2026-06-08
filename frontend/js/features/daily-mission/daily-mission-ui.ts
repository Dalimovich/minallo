// Shared Daily Mission rendering + interaction layer — multi-subject edition.
//
// Surfaces:
//   1. Dashboard Daily Mission widget   (#daily-mission-widget inside .dmw-root)
//   2. My Courses preview card          (.dm-preview-card)
//
// Chatbot surface: Daily Mission is rendered as an inline chat bubble via
// mountDailyMissionPanel() (called by shell.ts / ai-ask-bridge.ts).
// There is NO separate #daily-mission-chatbot-panel element outside the chat thread.
//
// Single shared state + API helpers; both widget surfaces re-render on any change.
// The per-course panel API (mountDailyMissionPanel / renderProgressHeaderHtml /
// renderTaskCardHtml etc.) is kept so shell.ts keeps working unchanged.

import { escapeHtml } from '../../utils/escape-html.js';
import {
  DailyMissionResponse,
  DailyMissionTask,
  generateDailyMission,
  getDailyMission,
  regenerateDailyMission,
  updateDailyMissionTask,
  findPrimaryCourseId,
  todayLocalDate,
} from '../../services/study-service.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type DailyMissionGroup = 'must_do' | 'should_do' | 'optional';

const GROUP_LABEL: Record<DailyMissionGroup, string> = {
  must_do: 'Must Do',
  should_do: 'Should Do',
  optional: 'Optional',
};

const GROUP_ORDER: DailyMissionGroup[] = ['must_do', 'should_do', 'optional'];

export interface DailyMissionPanelHandlers {
  onOpenSource?: (task: DailyMissionTask) => void;
  onGenerateQuiz?: (task: DailyMissionTask) => void;
  onCreateFlashcards?: (task: DailyMissionTask) => void;
  onOpenDeepLearn?: (task: DailyMissionTask) => void;
  onOpenExamForge?: (task: DailyMissionTask) => void;
  onOpenAi?: () => void;
}

// ─── Multi-subject shared state ────────────────────────────────────────────────

interface DailyMissionState {
  // Map of courseId → response. We load all courses' plans.
  byId: Record<string, DailyMissionResponse>;
  // Flat merged task list (populated after load)
  tasks: DailyMissionTask[];
  isLoading: boolean;
  error: string | null;
  lastLoaded: number;
  todayDate: string;
}

const _state: DailyMissionState = {
  byId: {},
  tasks: [],
  isLoading: false,
  error: null,
  lastLoaded: 0,
  todayDate: '',
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function _allCourseIds(): string[] {
  const w = window as unknown as {
    sdActiveSemId?: string;
    SEMS?: Record<string, { courses?: Array<{ id?: string }> }>;
  };
  const ids: string[] = [];
  const sems = w.SEMS || {};
  Object.values(sems).forEach((sem) => {
    (sem.courses || []).forEach((c) => { if (c.id) ids.push(c.id); });
  });
  // Deduplicate
  return ids.filter((v, i, a) => a.indexOf(v) === i);
}

function _formatDate(d: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return days[d.getDay()] + ', ' + d.getDate() + ' ' + months[d.getMonth()];
}

function _taskTypeLabel(taskType: string): string {
  const labels: Record<string, string> = {
    study_topic: 'Study',
    read_pages: 'Read',
    solve_exercise_sheet: 'Exercises',
    practice_problem_set: 'Practice',
    generate_quiz_if_no_exercises: 'Quiz',
    review_weak_topic: 'Review',
    review_topic: 'Review',
    exam_style_practice: 'Exam prep',
    create_flashcards: 'Flashcards',
    // legacy types from old system
    learn: 'Study',
    review: 'Review',
    quiz: 'Quiz',
    practice: 'Practice',
    flashcards: 'Flashcards',
    deeplearn: 'Deep Learn',
    examforge: 'Exam prep',
  };
  return labels[taskType] || 'Study';
}

function _startButtonLabel(taskType: string): string {
  const labels: Record<string, string> = {
    study_topic: 'Open File',
    read_pages: 'Open File',
    review_topic: 'Open File',
    review_weak_topic: 'Open File',
    solve_exercise_sheet: 'Open Exercises',
    practice_problem_set: 'Open Exercises',
    generate_quiz_if_no_exercises: 'Start Quiz',
    exam_style_practice: 'Start Exam',
    create_flashcards: 'Create Flashcards',
    // legacy
    learn: 'Open File',
    review: 'Open File',
    quiz: 'Start Quiz',
    practice: 'Open Exercises',
    flashcards: 'Create Flashcards',
  };
  return labels[taskType] || 'Open';
}

function _courseName(courseId: string): string {
  const w = window as unknown as {
    SEMS?: Record<string, { courses?: Array<{ id?: string; name?: string }> }>;
  };
  const sems = w.SEMS || {};
  for (const sem of Object.values(sems)) {
    const course = (sem.courses || []).find((c) => c.id === courseId);
    if (course?.name) return course.name;
  }
  return courseId;
}

// ─── Data loading ──────────────────────────────────────────────────────────────

async function loadTodaysTasks(force = false): Promise<void> {
  if (_state.isLoading) return;
  const now = Date.now();
  if (!force && _state.lastLoaded && now - _state.lastLoaded < 30_000) return;

  _state.isLoading = true;
  _state.error = null;
  _state.todayDate = todayLocalDate();
  _renderWidget();
  _renderPreviewCard();

  try {
    const ids = _allCourseIds();
    if (!ids.length) {
      _state.tasks = [];
      _state.lastLoaded = now;
      _state.isLoading = false;
      _renderWidget();
      _renderPreviewCard();
      return;
    }

    const results = await Promise.allSettled(
      ids.map((id) => getDailyMission(id).then((data) => ({ id, data })))
    );

    _state.byId = {};
    results.forEach((r) => {
      if (r.status === 'fulfilled') {
        _state.byId[r.value.id] = r.value.data;
      }
    });

    // Merge tasks, annotating each with courseId (not present in the API response)
    const merged: DailyMissionTask[] = [];
    Object.entries(_state.byId).forEach(([cid, resp]) => {
      if (resp.hasPlan && resp.tasks.length) {
        resp.tasks.forEach((t) => {
          (t as DailyMissionTask & { _courseId?: string })._courseId = cid;
          merged.push(t);
        });
      }
    });

    _state.tasks = merged;
    _state.lastLoaded = now;
  } catch (err) {
    _state.error = 'Could not load today\'s mission.';
    console.error('[DailyMission] loadTodaysTasks error:', err);
  } finally {
    _state.isLoading = false;
    _renderWidget();
    _renderPreviewCard();
  }
}

async function generatePlan(): Promise<void> {
  const ids = _allCourseIds();
  if (!ids.length) return;
  // Use active course first, fall back to first available
  const primaryId = findPrimaryCourseId() || ids[0];
  if (!primaryId) return;
  try {
    await generateDailyMission(primaryId);
    await loadTodaysTasks(true);
  } catch (err) {
    console.error('[DailyMission] generatePlan error:', err);
  }
}

async function updateTaskStatus(taskId: string, newStatus: DailyMissionTask['status']): Promise<void> {
  // Optimistic update
  const task = _state.tasks.find((t) => t.id === taskId);
  const prevStatus = task?.status;
  if (task) task.status = newStatus;
  _renderWidget();
  _renderPreviewCard();

  try {
    await updateDailyMissionTask(taskId, newStatus);
  } catch (err) {
    // Revert on failure
    if (task && prevStatus) task.status = prevStatus;
    _renderWidget();
    _renderPreviewCard();
    console.error('[DailyMission] updateTaskStatus error:', err);
  }
}

// ─── Navigation helper ─────────────────────────────────────────────────────────

function _openInAi(): void {
  try { sessionStorage.setItem('ss_daily_mission_seed', 'open'); } catch { /* noop */ }
  const w = window as unknown as {
    setNavActive?: (id: string) => void;
    showPortalSection?: (name: string) => void;
    _navigatePortal?: (name: string) => void;
  };
  if (typeof w.setNavActive === 'function') w.setNavActive('psbAIPage');
  if (typeof w._navigatePortal === 'function') w._navigatePortal('aipage');
  else if (typeof w.showPortalSection === 'function') w.showPortalSection('aipage');
}

// ─── Widget render ──────────────────────────────────────────────────────────────

function _buildTaskRowHtml(task: DailyMissionTask & { _courseId?: string }): string {
  const isDone = task.status === 'completed';
  const isSkipped = task.status === 'skipped';
  const isMoved = task.status === 'moved';
  const isUnavailable = task.status === 'unavailable' || task.status === 'replaced';
  const canAct = !isDone && !isUnavailable && !isMoved;

  const typeLabel = _taskTypeLabel(task.task_type);
  const courseName = task._courseId ? _courseName(task._courseId) : '';
  const statusCls = isDone ? ' dm-task--completed' : isSkipped ? ' dm-task--skipped' : '';

  let actions = '';
  if (canAct) {
    const startLabel = _startButtonLabel(task.task_type);
    actions += '<button type="button" class="dm-btn-start dm-task-btn dm-task-btn--primary" data-action="start" data-task-id="' + escapeHtml(task.id) + '">' + escapeHtml(startLabel) + '</button>';
    if (task.status === 'todo' || task.status === 'in_progress') {
      actions += '<button type="button" class="dm-btn-done dm-task-btn" data-action="done" data-task-id="' + escapeHtml(task.id) + '">Done</button>';
    }
    if (task.status === 'todo') {
      actions += '<button type="button" class="dm-btn-skip dm-task-btn dm-task-btn--ghost" data-action="skip" data-task-id="' + escapeHtml(task.id) + '">Skip</button>';
    }
  }

  return (
    '<div class="dm-task dm-task--' + escapeHtml(task.status) + statusCls + '" data-task-id="' + escapeHtml(task.id) + '">' +
      (courseName ? '<div class="dm-task-subject">' + escapeHtml(courseName) + '</div>' : '') +
      '<div class="dm-task-title' + (isDone ? ' is-done' : '') + '">' + escapeHtml(task.title) + '</div>' +
      '<div class="dm-task-meta">' + escapeHtml(typeLabel) + ' &middot; ' + task.estimated_minutes + 'min</div>' +
      (actions ? '<div class="dm-task-actions">' + actions + '</div>' : '') +
    '</div>'
  );
}

function _renderWidget(): void {
  const host = document.getElementById('daily-mission-widget');
  if (!host) return;

  const d = new Date();
  const dateStr = _formatDate(d);
  const tasks = _state.tasks.filter((t) => t.status !== 'replaced');
  const done = tasks.filter((t) => t.status === 'completed').length;
  const total = tasks.length;

  let inner = '';

  // Header
  inner += '<div class="dm-widget-header">';
  inner += '<span class="dm-widget-title">Today\'s Mission</span>';
  inner += '<span class="dm-widget-date">' + escapeHtml(dateStr) + '</span>';
  if (total > 0) {
    inner += '<span class="dm-widget-progress">' + done + ' / ' + total + ' done</span>';
  }
  inner += '</div>';

  // Progress bar
  if (total > 0) {
    const pct = Math.round((done / total) * 100);
    inner += '<div class="dm-progress-track" style="margin:0 0 8px"><div class="dm-progress-fill" style="width:' + pct + '%"></div></div>';
  }

  if (_state.isLoading) {
    inner += '<div class="dm-widget-loading">Loading your mission…</div>';
  } else if (_state.error) {
    inner += '<div class="dm-widget-empty">';
    inner += '<p>' + escapeHtml(_state.error) + '</p>';
    inner += '<button type="button" class="dm-btn-generate dm-cta">Retry</button>';
    inner += '</div>';
  } else if (!total) {
    inner += '<div class="dm-widget-empty">';
    inner += '<p>No mission yet for today.</p>';
    inner += '<button type="button" class="dm-btn-generate dm-cta">Plan My Week</button>';
    inner += '</div>';
  } else {
    // Show up to 5 tasks
    const visible = tasks.filter((t) => t.status !== 'skipped').slice(0, 5);
    inner += '<div class="dm-widget-tasks">';
    visible.forEach((t) => {
      inner += _buildTaskRowHtml(t as DailyMissionTask & { _courseId?: string });
    });
    inner += '</div>';
    if (tasks.length > 5) {
      inner += '<button type="button" class="dm-btn-open-ai dm-task-btn">Open in AI →</button>';
    }
  }

  host.innerHTML = '<div class="dm-widget">' + inner + '</div>';
  _bindWidgetActions(host);
}

function _bindWidgetActions(host: HTMLElement): void {
  const generate = host.querySelector('.dm-btn-generate');
  if (generate) {
    generate.addEventListener('click', () => { void generatePlan(); });
  }
  const openAi = host.querySelector('.dm-btn-open-ai');
  if (openAi) {
    openAi.addEventListener('click', _openInAi);
  }
  host.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    const action = btn.getAttribute('data-action');
    const taskId = btn.getAttribute('data-task-id');
    if (!action || !taskId) return;
    btn.addEventListener('click', () => {
      switch (action) {
        case 'start':
          void updateTaskStatus(taskId, 'in_progress');
          _openInAi();
          break;
        case 'done':
          void updateTaskStatus(taskId, 'completed');
          break;
        case 'skip':
          void updateTaskStatus(taskId, 'skipped');
          break;
        default:
          break;
      }
    });
  });
}

// ─── My Courses preview card ───────────────────────────────────────────────────

function _renderPreviewCard(): void {
  const cards = document.querySelectorAll<HTMLElement>('.dm-preview-card');
  if (!cards.length) return;

  cards.forEach((card) => {
    let html = '';

    if (_state.isLoading) {
      html = '<div class="dm-preview-skeleton"><div class="dm-skel-line dm-skel-line--wide"></div><div class="dm-skel-line"></div></div>';
    } else if (!_state.tasks.length) {
      html =
        '<div class="dm-preview-empty">' +
          '<span class="dm-preview-label">Set up your study mission</span>' +
          '<button type="button" class="dm-preview-cta dm-task-btn dm-task-btn--primary" data-dm-preview-action="generate">Plan My Week</button>' +
        '</div>';
    } else {
      const active = _state.tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped' && t.status !== 'replaced');
      const done = _state.tasks.filter((t) => t.status === 'completed').length;
      const total = _state.tasks.length;

      // Count distinct course IDs
      const courseIds = Array.from(
        new Set(_state.tasks.map((t) => (t as DailyMissionTask & { _courseId?: string })._courseId || '').filter(Boolean))
      );
      const minRemaining = active.reduce((s, t) => s + (t.estimated_minutes || 0), 0);

      const pct = total ? Math.round((done / total) * 100) : 0;

      html =
        '<div class="dm-preview-info">' +
          '<div class="dm-preview-stat">Today: <strong>' + active.length + ' tasks</strong> across <strong>' + courseIds.length + ' subject' + (courseIds.length !== 1 ? 's' : '') + '</strong> &middot; ' + minRemaining + 'min remaining</div>' +
          '<div class="dm-progress-track" style="height:4px;margin:6px 0"><div class="dm-progress-fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button type="button" class="dm-preview-cta dm-task-btn dm-task-btn--primary" data-dm-preview-action="open-ai">View Mission →</button>';
    }

    card.innerHTML = html;

    const genBtn = card.querySelector<HTMLButtonElement>('[data-dm-preview-action="generate"]');
    if (genBtn) genBtn.addEventListener('click', () => { void generatePlan(); });

    const aiBtn = card.querySelector<HTMLButtonElement>('[data-dm-preview-action="open-ai"]');
    if (aiBtn) aiBtn.addEventListener('click', _openInAi);
  });
}

// ─── Global API ────────────────────────────────────────────────────────────────

(window as unknown as {
  _dailyMission?: {
    reload: () => Promise<void>;
    generatePlan: () => Promise<void>;
  };
})._dailyMission = {
  // Note: there is no `open()` method — the chatbot renders Daily Mission as
  // an inline chat bubble via mountDailyMissionPanel(); a separate panel element
  // must NOT exist outside the chat thread.
  reload: () => loadTodaysTasks(true),
  generatePlan,
};

// Auto-load when courses data is ready
function _tryAutoLoad(): void {
  if (_allCourseIds().length) {
    void loadTodaysTasks();
  }
}

// Start loading after a short delay to let SEMS/courses data settle
setTimeout(_tryAutoLoad, 2500);
window.addEventListener('ss-ready', () => { setTimeout(_tryAutoLoad, 1200); }, { once: true });
window.addEventListener('ss:courses-ready', () => { void loadTodaysTasks(true); });

// ─── ─────────────────────────────────────────────────────────────────────────
// LEGACY API (kept for shell.ts + chatbot compatibility)
// ─── ─────────────────────────────────────────────────────────────────────────

function pageLabel(task: DailyMissionTask): string {
  if (!task.page_start) return '';
  if (!task.page_end || task.page_end === task.page_start) return ' · p.' + task.page_start;
  return ' · p.' + task.page_start + '-' + task.page_end;
}

function statusBadge(status: DailyMissionTask['status']): string {
  if (status === 'completed') return '<span class="dm-badge dm-badge--done">Done</span>';
  if (status === 'in_progress') return '<span class="dm-badge dm-badge--progress">In progress</span>';
  if (status === 'skipped') return '<span class="dm-badge dm-badge--skipped">Skipped</span>';
  if (status === 'moved') return '<span class="dm-badge dm-badge--moved">Moved</span>';
  if (status === 'unavailable') return '<span class="dm-badge dm-badge--unavailable">Source unavailable</span>';
  if (status === 'replaced') return '<span class="dm-badge dm-badge--replaced">Replaced</span>';
  return '';
}

/** Renders the compact "X/Y done · N min left" header used across all surfaces. */
export function renderProgressHeaderHtml(data: DailyMissionResponse): string {
  const s = data.summary;
  const pct = s.totalTasks ? Math.round((s.completedTasks / s.totalTasks) * 100) : 0;
  return (
    '<div class="dm-progress-head">' +
      '<div class="dm-progress-row">' +
        '<strong>' + s.completedTasks + '/' + s.totalTasks + '</strong> done' +
        '<span class="dm-progress-sep">&middot;</span>' +
        '<span>' + s.minutesRemaining + ' min left</span>' +
      '</div>' +
      '<div class="dm-progress-track"><div class="dm-progress-fill" style="width:' + pct + '%"></div></div>' +
    '</div>'
  );
}

/** Renders one task card (used by per-course chatbot panel). */
export function renderTaskCardHtml(task: DailyMissionTask): string {
  const isDone = task.status === 'completed';
  const isUnavailable = task.status === 'unavailable' || task.status === 'replaced';
  const isMoved = task.status === 'moved';
  const canAct = !isDone && !isUnavailable && !isMoved;

  const actions: string[] = [];
  if (canAct) {
    if (task.status === 'todo') {
      const isStudyTask = task.task_type === 'learn' || task.task_type === 'review';
      const isQuizTask = task.task_type === 'quiz';
      const isPracticeTask = task.task_type === 'practice';
      const startLabel = isStudyTask ? 'Open File' : isQuizTask ? 'Start Quiz' : isPracticeTask ? 'Open Exercises' : 'Start';
      const startAction = isStudyTask ? 'start-study' : isQuizTask ? 'start-quiz' : isPracticeTask ? 'start-practice' : 'start';
      actions.push('<button type="button" class="dm-task-btn dm-task-btn--primary" data-dm-action="' + startAction + '" data-dm-task="' + escapeHtml(task.id) + '">' + startLabel + '</button>');
    }
    if (task.status === 'in_progress') {
      actions.push('<button type="button" class="dm-task-btn dm-task-btn--primary" data-dm-action="done" data-dm-task="' + escapeHtml(task.id) + '">Done</button>');
    }
    actions.push('<button type="button" class="dm-task-btn" data-dm-action="skip" data-dm-task="' + escapeHtml(task.id) + '">Skip</button>');
    actions.push('<button type="button" class="dm-task-btn" data-dm-action="move" data-dm-task="' + escapeHtml(task.id) + '">Move</button>');
  }
  if (isDone) {
    actions.push('<button type="button" class="dm-task-btn" data-dm-action="undo" data-dm-task="' + escapeHtml(task.id) + '">Undo</button>');
  }
  if (!isUnavailable && task.source_file_id !== null && task.source_file_id !== undefined) {
    actions.push('<button type="button" class="dm-task-btn" data-dm-action="open-source" data-dm-task="' + escapeHtml(task.id) + '">Open Source</button>');
  }
  if (task.reason) {
    actions.push('<button type="button" class="dm-task-btn dm-task-btn--ghost" data-dm-action="why" data-dm-task="' + escapeHtml(task.id) + '">Why?</button>');
  }
  if (canAct || isDone) {
    if (task.task_type === 'flashcards' || task.task_type === 'review') {
      actions.push('<button type="button" class="dm-task-btn dm-task-btn--ghost" data-dm-action="gen-flashcards" data-dm-task="' + escapeHtml(task.id) + '">Create Flashcards</button>');
    }
    if (task.task_type === 'deeplearn') {
      actions.push('<button type="button" class="dm-task-btn dm-task-btn--ghost" data-dm-action="open-deeplearn" data-dm-task="' + escapeHtml(task.id) + '">Open DeepLearn</button>');
    }
    if (task.task_type === 'examforge') {
      actions.push('<button type="button" class="dm-task-btn dm-task-btn--ghost" data-dm-action="open-examforge" data-dm-task="' + escapeHtml(task.id) + '">Generate ExamForge</button>');
    }
  }

  return (
    '<div class="dm-task-card dm-task-card--' + escapeHtml(task.status) + '" data-dm-task-card="' + escapeHtml(task.id) + '">' +
      '<div class="dm-task-main">' +
        '<div class="dm-task-title-row">' +
          '<span class="dm-task-check' + (isDone ? ' is-done' : '') + '" aria-hidden="true">' + (isDone ? '✓' : '') + '</span>' +
          '<span class="dm-task-title' + (isDone ? ' is-done' : '') + '">' + escapeHtml(task.title) + '</span>' +
          statusBadge(task.status) +
        '</div>' +
        (task.description ? '<div class="dm-task-desc">' + escapeHtml(task.description) + pageLabel(task) + '</div>' : '') +
        '<div class="dm-task-meta">' + task.estimated_minutes + ' min</div>' +
      '</div>' +
      (actions.length ? '<div class="dm-task-actions">' + actions.join('') + '</div>' : '') +
      '<div class="dm-task-reason" data-dm-reason hidden>' + escapeHtml(task.reason || '') + '</div>' +
    '</div>'
  );
}

export function renderTaskGroupHtml(group: DailyMissionGroup, tasks: DailyMissionTask[]): string {
  const visible = tasks.filter((t) => t.status !== 'replaced');
  if (!visible.length) return '';
  return (
    '<div class="dm-task-group" data-dm-group="' + group + '">' +
      '<div class="dm-task-group-head">' + GROUP_LABEL[group] + '</div>' +
      visible.map(renderTaskCardHtml).join('') +
    '</div>'
  );
}

export function renderSetupStateHtml(courseName: string): string {
  return (
    '<div class="dm-state dm-state--setup">' +
      '<div class="dm-state-title">Set up today’s mission</div>' +
      '<p class="dm-state-text">Minallo will turn ' + escapeHtml(courseName) + '’s confirmed course files into a short, trusted study plan for today.</p>' +
      '<button type="button" class="dm-cta" data-dm-action="generate">Set Up Mission</button>' +
    '</div>'
  );
}

export function renderEmptyStateHtml(): string {
  return (
    '<div class="dm-state dm-state--empty">' +
      '<div class="dm-state-title">No mission yet for today</div>' +
      '<p class="dm-state-text">Choose a course with confirmed sources and ask Minallo to build today’s plan.</p>' +
    '</div>'
  );
}

export function renderUnavailableStateHtml(): string {
  return (
    '<div class="dm-state dm-state--unavailable">' +
      '<div class="dm-state-title">Minallo needs confirmed course sources</div>' +
      '<p class="dm-state-text">Today’s plan can only use source-confirmed course files. Review your Course Map or upload/index your lecture files first.</p>' +
    '</div>'
  );
}

export function renderCompletedStateHtml(): string {
  return (
    '<div class="dm-state dm-state--completed">' +
      '<div class="dm-state-title">Mission complete for today 🎉</div>' +
      '<p class="dm-state-text">You finished every trusted task in today’s plan. Nice work — come back tomorrow for a fresh mission.</p>' +
    '</div>'
  );
}

interface MountOptions {
  courseName?: string;
  handlers?: DailyMissionPanelHandlers;
}

/** Mounts the full per-course Daily Mission panel into `host`.
 *  Used by the chatbot Daily Mission mode (per-course context). */
export async function mountDailyMissionPanel(host: HTMLElement, courseId: string, opts?: MountOptions): Promise<void> {
  const courseName = opts?.courseName || 'this course';
  const handlers = opts?.handlers || {};
  host.classList.add('dm-panel');
  host.innerHTML = '<div class="dm-loading">Loading today’s mission…</div>';

  let data: DailyMissionResponse;
  try {
    data = await getDailyMission(courseId);
  } catch {
    host.innerHTML = '<div class="dm-state dm-state--error"><p class="dm-state-text">Could not load today’s mission. Please try again.</p></div>';
    return;
  }

  const paint = (next: DailyMissionResponse): void => {
    data = next;
    if (data.summary.noValidCandidates) {
      host.innerHTML = renderUnavailableStateHtml();
      return;
    }
    if (!data.hasPlan || !data.tasks.length) {
      host.innerHTML = renderSetupStateHtml(courseName);
      bindGenerate();
      return;
    }
    if (data.summary.totalTasks > 0 && data.summary.completedTasks >= data.summary.totalTasks) {
      host.innerHTML = renderCompletedStateHtml() + renderProgressHeaderHtml(data) +
        GROUP_ORDER.map((g) => renderTaskGroupHtml(g, data.tasks.filter((t) => t.priority_group === g))).join('');
      bindTaskActions();
      return;
    }
    host.innerHTML =
      renderProgressHeaderHtml(data) +
      GROUP_ORDER.map((g) => renderTaskGroupHtml(g, data.tasks.filter((t) => t.priority_group === g))).join('');
    bindTaskActions();
  };

  const refresh = async (): Promise<void> => {
    try {
      const fresh = await getDailyMission(courseId);
      paint(fresh);
    } catch { /* keep last good render */ }
  };

  const bindGenerate = (): void => {
    const btn = host.querySelector<HTMLButtonElement>('[data-dm-action="generate"]');
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Building your mission…';
      generateDailyMission(courseId)
        .then(paint)
        .catch(() => {
          btn.disabled = false;
          btn.textContent = 'Set Up Mission';
        });
    });
  };

  const findTask = (id: string): DailyMissionTask | undefined => data.tasks.find((t) => t.id === id);

  const setTaskStatus = async (taskId: string, status: DailyMissionTask['status'], btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true;
    try {
      await updateDailyMissionTask(taskId, status);
      await refresh();
    } catch {
      btn.disabled = false;
    }
  };

  const bindTaskActions = (): void => {
    host.querySelectorAll<HTMLButtonElement>('[data-dm-action]').forEach((btn) => {
      const action = btn.getAttribute('data-dm-action');
      const taskId = btn.getAttribute('data-dm-task');
      if (!action || action === 'generate') return;
      const task = taskId ? findTask(taskId) : undefined;
      btn.addEventListener('click', () => {
        if (!task) return;
        switch (action) {
          case 'start': void setTaskStatus(task.id, 'in_progress', btn); break;
          case 'start-study':
            handlers.onOpenSource?.(task);
            void setTaskStatus(task.id, 'in_progress', btn);
            break;
          case 'start-quiz':
            handlers.onGenerateQuiz?.(task);
            void setTaskStatus(task.id, 'in_progress', btn);
            break;
          case 'start-practice':
            handlers.onOpenSource?.(task);
            void setTaskStatus(task.id, 'in_progress', btn);
            break;
          case 'done': void setTaskStatus(task.id, 'completed', btn); break;
          case 'skip': void setTaskStatus(task.id, 'skipped', btn); break;
          case 'undo': void setTaskStatus(task.id, 'todo', btn); break;
          case 'move': void setTaskStatus(task.id, 'moved', btn); break;
          case 'open-source': handlers.onOpenSource?.(task); break;
          case 'gen-quiz': handlers.onGenerateQuiz?.(task); break;
          case 'gen-flashcards': handlers.onCreateFlashcards?.(task); break;
          case 'open-deeplearn': handlers.onOpenDeepLearn?.(task); break;
          case 'open-examforge': handlers.onOpenExamForge?.(task); break;
          case 'why': {
            const card = btn.closest('.dm-task-card');
            const reasonEl = card?.querySelector<HTMLElement>('[data-dm-reason]');
            if (reasonEl) reasonEl.hidden = !reasonEl.hidden;
            break;
          }
          default: break;
        }
      });
    });
  };

  paint(data);
}

/** Regenerates today's plan and re-paints. */
export async function regenerateAndRepaint(host: HTMLElement, courseId: string, opts?: MountOptions): Promise<void> {
  await regenerateDailyMission(courseId);
  await mountDailyMissionPanel(host, courseId, opts);
}
