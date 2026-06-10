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
import { handleSourceClick } from '../pdf-viewer/source-link.js';
import {
  confirmPossibleMatch,
  DailyMissionResponse,
  DailyMissionTask,
  generateDailyMission,
  getDailyMission,
  getDoneFiles,
  saveDoneFiles,
  PossibleMatch,
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
  // Merged possible-match suggestions across all loaded plans
  possibleMatches: PossibleMatch[];
  // planId keyed by courseId (for the confirm/dismiss endpoint)
  planIdByCourse: Record<string, string>;
  isLoading: boolean;
  error: string | null;
  lastLoaded: number;
  todayDate: string;
  selectedCourseId: string | null;
  examDates: Record<string, string>; // courseId → exam date (YYYY-MM-DD)
  urgencyMeta?: {
    message: string;
    recommendExamGeneration: boolean;
    recommendCheatsheet: boolean;
    daysUntilExam?: number;
    studiedPercentage?: number;
  };
}

const _state: DailyMissionState = {
  byId: {},
  tasks: [],
  possibleMatches: [],
  planIdByCourse: {},
  isLoading: false,
  error: null,
  lastLoaded: 0,
  todayDate: '',
  selectedCourseId: null,
  examDates: {},
  urgencyMeta: undefined,
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
    // AI-planner task types
    study_lecture: 'Study',
    continue_lecture: 'Continue',
    repeat_lecture: 'Repeat',
    solve_exercise_sheet: 'Exercises',
    practice_problem_set: 'Practice',
    generate_quiz_if_no_exercises: 'Quiz',
    review_weak_topic: 'Review',
    review_topic: 'Review',
    exam_style_practice: 'Exam prep',
    check_solution_sheet: 'Check Solutions',
    review_completed_exercise: 'Review Exercise',
    pre_exam_review: 'Pre-Exam Review',
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
    study_lecture: 'Open File',
    continue_lecture: 'Open File',
    repeat_lecture: 'Open File',
    review_topic: 'Open File',
    review_weak_topic: 'Open File',
    solve_exercise_sheet: 'Open Exercises',
    practice_problem_set: 'Open Exercises',
    generate_quiz_if_no_exercises: 'Start Quiz',
    exam_style_practice: 'Start Exam',
    check_solution_sheet: 'Open Solutions',
    review_completed_exercise: 'Open Exercises',
    pre_exam_review: 'Start Review',
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

interface CourseFileLite { id: string; name: string }

// All files for a course (top-level + folders), de-duped by id. Used by the
// "Mark completed files" picker. Mirrors the shape the PDF source resolver reads.
function _courseFiles(courseId: string): CourseFileLite[] {
  const w = window as unknown as {
    SEMS?: Record<string, { courses?: Array<{ id?: string; files?: Array<Record<string, unknown>>; userFolders?: Array<{ files?: Array<Record<string, unknown>> }> }> }>;
  };
  let course: { files?: Array<Record<string, unknown>>; userFolders?: Array<{ files?: Array<Record<string, unknown>> }> } | undefined;
  for (const sem of Object.values(w.SEMS || {})) {
    const found = (sem.courses || []).find((c) => c.id === courseId);
    if (found) { course = found; break; }
  }
  if (!course) return [];
  const out: CourseFileLite[] = [];
  const seen = new Set<string>();
  const push = (arr?: Array<Record<string, unknown>>): void => {
    (arr || []).forEach((f) => {
      const id = String(f.id || '');
      const name = String(f.name || f._storageName || '');
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, name: name || id });
    });
  };
  push(course.files);
  (course.userFolders || []).forEach((fd) => push(fd.files));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Data loading ──────────────────────────────────────────────────────────────

// Watch the current widget host for its content being cleared and restore it
// from memory. The dashboard recreates this element on resize/move, so the
// observer is (re)bound to whichever element is live at call time.
let _widgetObserver: MutationObserver | null = null;
let _observedHost: HTMLElement | null = null;
function _watchWidgetElement(): void {
  const host = document.getElementById('daily-mission-widget');
  if (!host || host === _observedHost) return;

  if (_widgetObserver) _widgetObserver.disconnect();
  _observedHost = host;
  _widgetObserver = new MutationObserver(() => {
    if (_state.tasks.length > 0 && !host.querySelector('.dm-widget')) {
      _renderWidget();
    }
  });
  _widgetObserver.observe(host, { childList: true, subtree: true });
}

async function loadTodaysTasks(force = false): Promise<void> {
  if (_state.isLoading) return;
  const now = Date.now();
  if (!force && _state.lastLoaded && now - _state.lastLoaded < 30_000) return;

  // Check if auth token is available; if not, retry in 500ms
  const token = (window as unknown as { _sbToken?: string })._sbToken;
  if (!token) {
    setTimeout(() => { void loadTodaysTasks(force); }, 500);
    return;
  }

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
        // Capture urgency metadata if present
        if ((r.value.data as any).meta) {
          _state.urgencyMeta = (r.value.data as any).meta;
        }
      }
    });

    // Merge tasks, annotating each with courseId (not present in the API response)
    const merged: DailyMissionTask[] = [];
    const mergedMatches: PossibleMatch[] = [];
    const planIdByCourse: Record<string, string> = {};
    Object.entries(_state.byId).forEach(([cid, resp]) => {
      if (resp.hasPlan && resp.tasks.length) {
        resp.tasks.forEach((t) => {
          (t as DailyMissionTask & { _courseId?: string })._courseId = cid;
          merged.push(t);
        });
      }
      if (resp.planId) planIdByCourse[cid] = resp.planId;
      if (resp.possibleMatches && resp.possibleMatches.length) {
        resp.possibleMatches.forEach((m) => {
          // Avoid duplicates (same exercise+lecture pair from multiple course responses)
          const isDup = mergedMatches.some(
            (x) => x.exerciseFileId === m.exerciseFileId && x.possibleLectureFileId === m.possibleLectureFileId
          );
          if (!isDup) mergedMatches.push(m);
        });
      }
    });

    _state.tasks = merged;
    _state.possibleMatches = mergedMatches;
    _state.planIdByCourse = planIdByCourse;
    _state.lastLoaded = now;

    // Show exam date modal if tasks exist but no exam dates
    const courseIds = [...new Set(
      merged
        .map((t) => (t as DailyMissionTask & { _courseId?: string })._courseId)
        .filter((id): id is string => !!id)
    )];
    const missingDates = courseIds.filter((id) => !_state.examDates[id]);

    if (merged.length > 0 && missingDates.length > 0) {
      setTimeout(() => { void showExamDateModal(missingDates); }, 500);
    }
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
  // Use selected course if available, otherwise use active course, fall back to first available
  const courseId = _state.selectedCourseId || findPrimaryCourseId() || ids[0];
  if (!courseId) {
    console.error('[DailyMission] No course selected for plan generation');
    return;
  }
  try {
    await generateDailyMission(courseId);
    await loadTodaysTasks(true);
  } catch (err) {
    console.error('[DailyMission] generatePlan error:', err instanceof Error ? err.message : String(err));
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

// ─── Exam date management ────────────────────────────────────────────────────

async function loadExamDates(): Promise<void> {
  const token = (window as unknown as { _sbToken?: string })._sbToken;
  if (!token) {
    setTimeout(() => { void loadExamDates(); }, 500);
    return;
  }
  try {
    const res = await fetch('/api/study/exam-dates', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (res.ok) {
      const data = await res.json() as { examDates: Record<string, string> };
      _state.examDates = data.examDates || {};
    }
  } catch (err) {
    console.error('[DailyMission] loadExamDates error:', err);
  }
}

async function saveExamDate(courseId: string, examDate: string): Promise<boolean> {
  const token = (window as unknown as { _sbToken?: string })._sbToken || '';
  try {
    const res = await fetch('/api/study/exam-dates', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token
      },
      body: JSON.stringify({ courseId, examDate })
    });
    if (res.ok) {
      _state.examDates[courseId] = examDate;
      return true;
    }
  } catch (err) {
    console.error('[DailyMission] saveExamDate error:', err);
  }
  return false;
}

function showExamDateModal(forceShowCourseIds?: string[]): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    // If forced to show specific courses, use those; otherwise use all courses with tasks
    let courseIds: string[];
    if (forceShowCourseIds) {
      courseIds = forceShowCourseIds;
    } else {
      courseIds = [...new Set(_state.tasks.map((t) => (t as DailyMissionTask & { _courseId?: string })._courseId || '').filter(Boolean))];
    }
    if (!courseIds.length) { resolve(null); return; }

    const modal = document.createElement('div');
    modal.className = 'dm-exam-modal-overlay';
    modal.innerHTML = '<div class="dm-exam-modal">' +
      '<div class="dm-exam-modal-header">' +
        '<h3>Set Exam Dates</h3>' +
        '<p>Enter exam dates so we can plan your study timeline</p>' +
      '</div>' +
      '<div class="dm-exam-modal-form">' +
        courseIds.map(cid => '<div class="dm-exam-input-group">' +
          '<label>' + escapeHtml(_courseName(cid)) + '</label>' +
          '<input type="date" class="dm-exam-date-input" data-course-id="' + escapeHtml(cid) + '" value="' + (_state.examDates[cid] || '') + '">' +
        '</div>').join('') +
      '</div>' +
      '<div class="dm-exam-modal-actions">' +
        '<button type="button" class="dm-btn-exam-cancel">Cancel</button>' +
        '<button type="button" class="dm-btn-exam-save dm-task-btn--primary">Save Exam Dates</button>' +
      '</div>' +
    '</div>';

    document.body.appendChild(modal);

    const saveBtn = modal.querySelector('.dm-btn-exam-save') as HTMLButtonElement;
    const cancelBtn = modal.querySelector('.dm-btn-exam-cancel') as HTMLButtonElement;

    const close = () => { modal.remove(); };

    cancelBtn.addEventListener('click', () => { close(); resolve(null); });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      const inputs = modal.querySelectorAll<HTMLInputElement>('.dm-exam-date-input');
      const dates: Record<string, string> = {};
      let allSaved = true;

      for (const input of inputs) {
        const courseId = input.getAttribute('data-course-id');
        const date = input.value;
        if (courseId && date) {
          dates[courseId] = date;
          const saved = await saveExamDate(courseId, date);
          if (!saved) allSaved = false;
        }
      }

      if (allSaved) {
        close();
        resolve(dates);
        void loadTodaysTasks(true);
      } else {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Exam Dates';
      }
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) { close(); resolve(null); }
    });
  });
}

// ─── Edit menu: exam date + completed files ──────────────────────────────────

function _editTargetCourseId(): string | null {
  return _state.selectedCourseId || findPrimaryCourseId() || _allCourseIds()[0] || null;
}

function _showEditMenu(anchor: HTMLElement): void {
  document.querySelector('.dm-edit-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'dm-edit-menu';
  menu.innerHTML =
    '<button type="button" class="dm-edit-menu-item" data-edit-action="exam-date">Change exam date</button>' +
    '<button type="button" class="dm-edit-menu-item" data-edit-action="done-files">Mark completed files</button>';
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';

  const close = (): void => {
    menu.remove();
    document.removeEventListener('click', onDoc, true);
  };
  const onDoc = (ev: MouseEvent): void => {
    if (!menu.contains(ev.target as Node)) close();
  };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);

  menu.querySelectorAll<HTMLButtonElement>('[data-edit-action]').forEach((b) => {
    b.addEventListener('click', () => {
      const action = b.getAttribute('data-edit-action');
      close();
      if (action === 'exam-date') {
        // When a single course is selected, edit just that one; otherwise show all.
        if (_state.selectedCourseId) void showExamDateModal([_state.selectedCourseId]);
        else void showExamDateModal();
        return;
      }
      if (action === 'done-files') {
        const cid = _editTargetCourseId();
        if (cid) void _showDoneFilesModal(cid);
      }
    });
  });
}

async function _showDoneFilesModal(courseId: string): Promise<void> {
  const files = _courseFiles(courseId);
  const overlay = document.createElement('div');
  overlay.className = 'dm-done-modal-overlay';
  overlay.innerHTML = '<div class="dm-done-modal">' +
    '<div class="dm-done-modal-header">' +
      '<h3>Completed files</h3>' +
      '<p>' + escapeHtml(_courseName(courseId)) + ' — check files you’ve already studied. The planner treats them as known material for spaced repetition instead of introducing them as new lectures.</p>' +
    '</div>' +
    '<div class="dm-done-modal-list"><div class="dm-done-loading">Loading…</div></div>' +
    '<div class="dm-done-modal-actions">' +
      '<button type="button" class="dm-btn-done-cancel">Cancel</button>' +
      '<button type="button" class="dm-btn-done-save dm-task-btn--primary" disabled>Save</button>' +
    '</div>' +
  '</div>';
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('.dm-done-modal-list') as HTMLElement;
  const saveBtn = overlay.querySelector('.dm-btn-done-save') as HTMLButtonElement;
  const cancelBtn = overlay.querySelector('.dm-btn-done-cancel') as HTMLButtonElement;
  const close = (): void => { overlay.remove(); };
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  if (!files.length) {
    listEl.innerHTML = '<div class="dm-done-empty">No files found for this course.</div>';
    return;
  }

  let done: string[] = [];
  try { done = await getDoneFiles(courseId); } catch { /* default to none */ }
  if (!overlay.isConnected) return;
  const doneSet = new Set(done);
  listEl.innerHTML = files.map((f) =>
    '<label class="dm-done-row">' +
      '<input type="checkbox" class="dm-done-check" value="' + escapeHtml(f.id) + '"' + (doneSet.has(f.id) ? ' checked' : '') + '>' +
      '<span class="dm-done-name">' + escapeHtml(f.name) + '</span>' +
    '</label>'
  ).join('');
  saveBtn.disabled = false;

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    const checked = Array.from(listEl.querySelectorAll<HTMLInputElement>('.dm-done-check:checked')).map((c) => c.value);
    try {
      await saveDoneFiles(courseId, checked);
      // Marking files done flips their topics to 'studied', so regenerate the
      // plan: tasks covering now-known material are dropped (the planner only
      // keeps it for spaced repetition).
      saveBtn.textContent = 'Updating plan…';
      try { await regenerateDailyMission(courseId); } catch { /* keep prior plan on failure */ }
      await loadTodaysTasks(true);
      close();
      (window as unknown as { showToast?: (t: string, m: string) => void }).showToast?.('Saved', 'Completed files updated and plan refreshed.');
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      console.error('[DailyMission] saveDoneFiles error:', err);
    }
  });
}

// ─── Navigation helper ─────────────────────────────────────────────────────────

// Task types whose relevant document is the exercise sheet, not the lecture.
const _EXERCISE_TASK_TYPES = new Set<string>([
  'solve_exercise_sheet',
  'practice_problem_set',
  'review_completed_exercise',
  'exam_style_practice',
  'practice',
]);

// Open the PDF a task points at in the source popup viewer. For exercise/practice
// tasks the exercise sheet is the relevant file; otherwise the lecture/source
// file. Returns false when the task carries no resolvable file so the caller can
// fall back to opening the AI chat.
function _openTaskSource(task: DailyMissionTask): boolean {
  const preferExercise = _EXERCISE_TASK_TYPES.has(task.task_type);
  const fileId = preferExercise
    ? (task.exercise_file_id || task.source_file_id)
    : (task.source_file_id || task.exercise_file_id);
  const fileName = preferExercise
    ? (task.exercise_file_name || task.source_file_name)
    : (task.source_file_name || task.exercise_file_name);
  if (!fileId && !fileName) return false;
  const rangeFirst = task.page_range ? parseInt(task.page_range.match(/\d+/)?.[0] || '', 10) : NaN;
  const page = Number.isFinite(rangeFirst) ? rangeFirst : (task.page_start ?? null);
  // 'sidebar' opens the file in the full PDF viewer page (and highlights Courses
  // in the nav). It falls back to an in-place popup when the file can't be
  // resolved to an open viewer.
  handleSourceClick(
    { fileName: fileName || null, documentId: fileId || null, page },
    'sidebar'
  );
  return true;
}

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

function _buildTaskRowHtml(task: DailyMissionTask & { _courseId?: string }, withCheckbox = false): string {
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

  // A leading tick square that marks the task done (used in the Today's Tasks
  // modal). Checking it completes the task; unchecking reverts it to todo —
  // both flow through updateTaskStatus, so the AI planner sees the change.
  const titleHtml = '<div class="dm-task-title' + (isDone ? ' is-done' : '') + '">' + escapeHtml(task.title) + '</div>';
  const titleBlock = withCheckbox && !isUnavailable && !isMoved
    ? '<div class="dm-task-titlewrap">' +
        '<input type="checkbox" class="dm-task-check-toggle" data-action="toggle-done" data-task-id="' + escapeHtml(task.id) + '"' + (isDone ? ' checked' : '') + ' aria-label="Mark task done">' +
        titleHtml +
      '</div>'
    : titleHtml;

  return (
    '<div class="dm-task dm-task--' + escapeHtml(task.status) + statusCls + '" data-task-id="' + escapeHtml(task.id) + '">' +
      (courseName ? '<div class="dm-task-subject">' + escapeHtml(courseName) + '</div>' : '') +
      titleBlock +
      taskFileLabel(task) +
      '<div class="dm-task-meta">' + escapeHtml(typeLabel) + ' &middot; ' + task.estimated_minutes + 'min' + pageLabel(task) + '</div>' +
      (actions ? '<div class="dm-task-actions">' + actions + '</div>' : '') +
    '</div>'
  );
}

function _renderWidget(): void {
  const host = document.getElementById('daily-mission-widget');
  if (!host) return;

  const d = new Date();
  const dateStr = _formatDate(d);

  // Filter tasks by selected course if one is selected
  let displayTasks = _state.tasks.filter((t) => t.status !== 'replaced');
  if (_state.selectedCourseId) {
    displayTasks = displayTasks.filter((t) => (t as DailyMissionTask & { _courseId?: string })._courseId === _state.selectedCourseId);
  }

  const done = displayTasks.filter((t) => t.status === 'completed').length;
  const total = displayTasks.length;

  let inner = '';

  // Header with course picker
  inner += '<div class="dm-widget-header">';
  inner += '<div class="dm-widget-title-row">';
  inner += '<span class="dm-widget-title">Today\'s Mission</span>';
  inner += '<span class="dm-widget-date">' + escapeHtml(dateStr) + '</span>';
  inner += '</div>';

  // Course picker — show all system courses if > 1, mark which have tasks
  const taskCourseIds = [...new Set(_state.tasks.map((t) => (t as DailyMissionTask & { _courseId?: string })._courseId || '').filter(Boolean))];
  const allSystemCourseIds = _allCourseIds();

  inner += '<div class="dm-picker-row">';
  if (allSystemCourseIds.length > 1) {
    inner += '<select class="dm-course-picker">';
    inner += '<option value="">All Courses</option>';
    allSystemCourseIds.forEach((cid) => {
      const selected = _state.selectedCourseId === cid ? ' selected' : '';
      const hasTasks = taskCourseIds.includes(cid) ? '' : ' (no tasks)';
      inner += '<option value="' + escapeHtml(cid) + '"' + selected + '>' + escapeHtml(_courseName(cid)) + hasTasks + '</option>';
    });
    inner += '</select>';
  }
  inner += '<button type="button" class="dm-edit-btn" title="Edit study settings" aria-label="Edit study settings">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
    '</button>';
  inner += '</div>';

  if (total > 0) {
    inner += '<span class="dm-widget-progress">' + done + ' / ' + total + ' done</span>';
  }
  inner += '</div>';

  // Urgency alert
  if (_state.urgencyMeta?.message) {
    inner += '<div class="dm-widget-alert dm-widget-alert--warning">' + escapeHtml(_state.urgencyMeta.message) + '</div>';
  }

  // Study progress & exam countdown
  if (_state.urgencyMeta?.daysUntilExam !== undefined) {
    const studied = _state.urgencyMeta.studiedPercentage ?? 0;
    const daysLeft = _state.urgencyMeta.daysUntilExam;
    inner += '<div class="dm-widget-urgency">';
    inner += '<div class="dm-urgency-row">';
    inner += '<span class="dm-urgency-label">Progress: ' + studied + '%</span>';
    inner += '<span class="dm-urgency-time">' + daysLeft + ' days left</span>';
    inner += '</div>';
    inner += '<div class="dm-urgency-bar" style="background: rgba(255,255,255,0.1)">';
    inner += '<div class="dm-urgency-fill" style="width:' + studied + '%; background:' + (studied >= 70 ? '#22c55e' : studied >= 50 ? '#f59e0b' : '#ef4444') + '"></div>';
    inner += '</div>';
    inner += '</div>';
  }

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
  } else {
    // Show all tasks in scrollable container (filtered by course)
    const visible = displayTasks.filter((t) => t.status !== 'skipped');

    if (visible.length === 0) {
      // No visible tasks (either none exist or all are skipped)
      inner += '<div class="dm-widget-empty">';
      inner += '<p>' + (total === 0 ? 'No mission yet for today.' : 'All tasks skipped for now.') + '</p>';
      inner += '<button type="button" class="dm-btn-generate dm-cta">' + (total === 0 ? 'Plan My Week' : 'Regenerate') + '</button>';
      inner += '</div>';
    } else {
      inner += '<div class="dm-widget-tasks dm-widget-tasks--scrollable">';
      visible.forEach((t) => {
        inner += _buildTaskRowHtml(t as DailyMissionTask & { _courseId?: string });
      });
      inner += '</div>';

      // Action buttons for crisis/final week
      inner += '<div class="dm-widget-actions">';
      if (_state.urgencyMeta?.recommendExamGeneration) {
        inner += '<button type="button" class="dm-btn-generate-exam dm-task-btn dm-task-btn--primary" title="Generate practice exam from course materials">📋 Generate Exam</button>';
      }
      if (_state.urgencyMeta?.recommendCheatsheet) {
        inner += '<button type="button" class="dm-btn-generate-cheatsheet dm-task-btn" title="Generate study cheatsheet">📄 Generate Cheatsheet</button>';
      }
      inner += '</div>';

      // Possible match suggestions
      const visibleMatches = _state.possibleMatches.filter((m) => {
        if (!_state.selectedCourseId) return true;
        return m.courseId === _state.selectedCourseId;
      });
      if (visibleMatches.length > 0) {
        inner += '<div class="dm-widget-matches">';
        inner += '<div class="dm-widget-matches-heading">Suggested pairings</div>';
        visibleMatches.forEach((m) => {
          const planId = _state.planIdByCourse[m.courseId] ?? '';
          inner += '<div class="dm-widget-match-card">';
          inner += '<div class="dm-widget-match-pair">' +
            escapeHtml(m.exerciseFileName) +
            ' <span class="dm-widget-match-arrow">&#8596;</span> ' +
            escapeHtml(m.possibleLectureFileName) +
            '</div>';
          if (m.reason) {
            inner += '<div class="dm-widget-match-reason">' + escapeHtml(m.reason) + '</div>';
          }
          inner += '<div class="dm-widget-match-actions">';
          inner += '<button type="button"' +
            ' class="dm-task-btn dm-task-btn--primary dm-btn-match"' +
            ' data-dm-match-action="confirm"' +
            ' data-exercise-file-id="' + escapeHtml(m.exerciseFileId) + '"' +
            ' data-lecture-file-id="' + escapeHtml(m.possibleLectureFileId) + '"' +
            ' data-plan-id="' + escapeHtml(planId) + '"' +
            '>Confirm</button>';
          inner += '<button type="button"' +
            ' class="dm-task-btn dm-task-btn--ghost dm-btn-match"' +
            ' data-dm-match-action="dismiss"' +
            ' data-exercise-file-id="' + escapeHtml(m.exerciseFileId) + '"' +
            ' data-lecture-file-id="' + escapeHtml(m.possibleLectureFileId) + '"' +
            ' data-plan-id="' + escapeHtml(planId) + '"' +
            '>Dismiss</button>';
          inner += '</div>';
          inner += '</div>';
        });
        inner += '</div>';
      }
    }
  }

  host.innerHTML = '<div class="dm-widget">' + inner + '</div>';
  _bindWidgetActions(host);

  // Content-height sizing: ask the dashboard to grow/shrink this widget's tile
  // to fit the full task list, scrolling only once it would exceed the screen.
  // The dashboard owns the grid track height, so it exposes this hook; it is a
  // no-op on the chatbot/preview surfaces (which don't define it).
  const dash = window as unknown as { _dwFitDailyMission?: () => void };
  if (typeof dash._dwFitDailyMission === 'function') {
    requestAnimationFrame(() => dash._dwFitDailyMission!());
  }
}

function _bindWidgetActions(host: HTMLElement): void {
  const generate = host.querySelector('.dm-btn-generate');
  if (generate) {
    generate.addEventListener('click', () => { void generatePlan(); });
  }

  // Course picker
  const picker = host.querySelector<HTMLSelectElement>('.dm-course-picker');
  if (picker) {
    picker.addEventListener('change', (e) => {
      _state.selectedCourseId = (e.target as HTMLSelectElement).value || null;

      // Show exam date modal if switching to a course without exam date
      if (_state.selectedCourseId && !_state.examDates[_state.selectedCourseId]) {
        setTimeout(() => { void showExamDateModal([_state.selectedCourseId!]); }, 300);
      }

      _renderWidget();
      _bindWidgetActions(host);
    });
  }

  // Edit (study settings) button → small menu: exam date / completed files
  const editBtn = host.querySelector<HTMLButtonElement>('.dm-edit-btn');
  if (editBtn) {
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _showEditMenu(editBtn);
    });
  }

  // Generate exam button
  const genExamBtn = host.querySelector<HTMLButtonElement>('.dm-btn-generate-exam');
  if (genExamBtn) {
    genExamBtn.addEventListener('click', async () => {
      const courseId = _state.selectedCourseId || findPrimaryCourseId();
      if (!courseId) return;
      genExamBtn.disabled = true;
      genExamBtn.textContent = '⏳ Generating...';
      try {
        // Store generation request and navigate to chatbot
        try { sessionStorage.setItem('ss_daily_mission_seed', 'generate_exam'); } catch {}
        _openInAi();
      } finally {
        genExamBtn.disabled = false;
        genExamBtn.textContent = '📋 Generate Exam';
      }
    });
  }

  // Generate cheatsheet button
  const genCheatBtn = host.querySelector<HTMLButtonElement>('.dm-btn-generate-cheatsheet');
  if (genCheatBtn) {
    genCheatBtn.addEventListener('click', async () => {
      const courseId = _state.selectedCourseId || findPrimaryCourseId();
      if (!courseId) return;
      genCheatBtn.disabled = true;
      genCheatBtn.textContent = '⏳ Generating...';
      try {
        // Store generation request and navigate to chatbot
        try { sessionStorage.setItem('ss_daily_mission_seed', 'generate_cheatsheet'); } catch {}
        _openInAi();
      } finally {
        genCheatBtn.disabled = false;
        genCheatBtn.textContent = '📄 Generate Cheatsheet';
      }
    });
  }

  host.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    const action = btn.getAttribute('data-action');
    const taskId = btn.getAttribute('data-task-id');
    if (!action || !taskId) return;
    btn.addEventListener('click', () => {
      switch (action) {
        case 'start': {
          void updateTaskStatus(taskId, 'in_progress');
          const task = _state.tasks.find((t) => t.id === taskId);
          if (!task || !_openTaskSource(task)) _openInAi();
          break;
        }
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

  // Possible match confirm / dismiss buttons
  host.querySelectorAll<HTMLButtonElement>('.dm-btn-match[data-dm-match-action]').forEach((btn) => {
    const matchAction = btn.getAttribute('data-dm-match-action') as 'confirm' | 'dismiss' | null;
    const exerciseFileId = btn.getAttribute('data-exercise-file-id');
    const lectureFileId = btn.getAttribute('data-lecture-file-id');
    const planId = btn.getAttribute('data-plan-id');
    if (!matchAction || !exerciseFileId || !lectureFileId || !planId) return;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      confirmPossibleMatch(planId, exerciseFileId, lectureFileId, matchAction, _state.todayDate)
        .then(() => {
          // Remove the entry from local state immediately for instant feedback.
          _state.possibleMatches = _state.possibleMatches.filter(
            (m) =>
              !(m.exerciseFileId === exerciseFileId && m.possibleLectureFileId === lectureFileId)
          );
          // If confirming, reload tasks so the new task appears.
          if (matchAction === 'confirm') {
            void loadTodaysTasks(true);
          } else {
            _renderWidget();
          }
        })
        .catch((err: unknown) => {
          btn.disabled = false;
          console.error('[DailyMission] match action error:', err);
        });
    });
  });
}

// ─── My Courses preview card ───────────────────────────────────────────────────

function _showTasksModal(): void {
  const modal = document.createElement('div');
  modal.className = 'dm-tasks-modal-overlay';
  modal.innerHTML = '<div class="dm-tasks-modal">' +
    '<div class="dm-tasks-modal-header">' +
      '<h3>Today\'s Tasks</h3>' +
      '<button type="button" class="dm-modal-close" aria-label="Close">×</button>' +
    '</div>' +
    '<div class="dm-tasks-modal-content">';

  const active = _state.tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped' && t.status !== 'replaced');

  if (active.length === 0) {
    modal.innerHTML += '<div class="dm-modal-empty">No active tasks for today</div>';
  } else {
    GROUP_ORDER.forEach((group) => {
      const groupTasks = active.filter((t) => (t as any).priority_group === group || (!((t as any).priority_group) && group === 'should_do'));
      if (groupTasks.length > 0) {
        modal.innerHTML += '<div class="dm-modal-group">' +
          '<div class="dm-modal-group-title">' + GROUP_LABEL[group] + '</div>';
        groupTasks.forEach((t) => {
          modal.innerHTML += _buildTaskRowHtml(t as DailyMissionTask & { _courseId?: string }, true);
        });
        modal.innerHTML += '</div>';
      }
    });
  }

  modal.innerHTML += '</div></div>';
  document.body.appendChild(modal);

  const closeBtn = modal.querySelector('.dm-modal-close') as HTMLButtonElement;
  const close = () => { modal.remove(); };

  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  // Bind task actions within modal
  modal.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((btn) => {
    const action = btn.getAttribute('data-action');
    const taskId = btn.getAttribute('data-task-id');
    if (!action || !taskId) return;
    btn.addEventListener('click', () => {
      switch (action) {
        case 'start': {
          void updateTaskStatus(taskId, 'in_progress');
          const task = _state.tasks.find((t) => t.id === taskId);
          if (!task || !_openTaskSource(task)) _openInAi();
          close();
          break;
        }
        case 'done':
          void updateTaskStatus(taskId, 'completed');
          _renderPreviewCard();
          break;
        case 'skip':
          void updateTaskStatus(taskId, 'skipped');
          _renderPreviewCard();
          break;
        case 'toggle-done': {
          const checked = (btn as unknown as HTMLInputElement).checked;
          void updateTaskStatus(taskId, checked ? 'completed' : 'todo');
          // Reflect completion on the row immediately (it stays visible in the modal).
          const row = modal.querySelector('.dm-task[data-task-id="' + taskId + '"]');
          row?.classList.toggle('dm-task--completed', checked);
          row?.querySelector('.dm-task-title')?.classList.toggle('is-done', checked);
          _renderPreviewCard();
          break;
        }
        default:
          break;
      }
    });
  });
}

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
        '<button type="button" class="dm-preview-cta dm-task-btn dm-task-btn--primary" data-dm-preview-action="view-tasks">View Tasks →</button>';
    }

    card.innerHTML = html;

    const genBtn = card.querySelector<HTMLButtonElement>('[data-dm-preview-action="generate"]');
    if (genBtn) genBtn.addEventListener('click', () => { void generatePlan(); });

    const tasksBtn = card.querySelector<HTMLButtonElement>('[data-dm-preview-action="view-tasks"]');
    if (tasksBtn) tasksBtn.addEventListener('click', _showTasksModal);
  });
}

// ─── Dashboard widget entry point ────────────────────────────────────────────

/** Paints the Daily Mission dashboard widget into #daily-mission-widget.
 *  Called by dashboard-widget.js every time it (re)creates the widget element
 *  on resize/move. Always repaints immediately so the dashboard's stale
 *  "Loading…" placeholder is replaced with our UI (tasks from memory, or the
 *  empty/loading state). Repaints from memory — no API call — when tasks are
 *  already loaded, so the list never disappears on resize.
 *
 *  Exported (not just on window._dailyMission) so the dashboard can call it
 *  straight off the imported module namespace. That avoids the global being
 *  clobbered by a second module instance (e.g. the chatbot's import). */
export function renderDashboardWidget(): void {
  _renderWidget();
  _watchWidgetElement();
  if (_state.tasks.length === 0 && !_state.isLoading) {
    void _loadSequential();
  }
}

// ─── Global API ────────────────────────────────────────────────────────────────

(window as unknown as {
  _dailyMission?: {
    reload: () => Promise<void>;
    generatePlan: () => Promise<void>;
    render: () => void;
  };
})._dailyMission = {
  // Note: there is no `open()` method — the chatbot renders Daily Mission as
  // an inline chat bubble via mountDailyMissionPanel(); a separate panel element
  // must NOT exist outside the chat thread.
  reload: () => loadTodaysTasks(true),
  generatePlan,
  render: renderDashboardWidget,
};

// Start loading after a short delay to let SEMS/courses data settle
// Load exam dates FIRST, then load tasks (to avoid race condition)
async function _loadSequential(): Promise<void> {
  await loadExamDates();
  void loadTodaysTasks();
}

setTimeout(_loadSequential, 2500);
window.addEventListener('ss-ready', () => { setTimeout(_loadSequential, 1200); }, { once: true });
window.addEventListener('ss:courses-ready', () => {
  _watchWidgetElement();
  void _loadSequential();
});

// ─── ─────────────────────────────────────────────────────────────────────────
// LEGACY API (kept for shell.ts + chatbot compatibility)
// ─── ─────────────────────────────────────────────────────────────────────────

function pageLabel(task: DailyMissionTask): string {
  // New plan model carries a free-form page_range string; fall back to the
  // legacy numeric page_start/page_end pair for older cached tasks.
  if (task.page_range) return ' · p.' + task.page_range;
  if (!task.page_start) return '';
  if (!task.page_end || task.page_end === task.page_start) return ' · p.' + task.page_start;
  return ' · p.' + task.page_start + '-' + task.page_end;
}

// The file a task points at — for "check solutions"/"review" tasks the relevant
// document is the source file itself; for a study task with a paired exercise we
// also surface that exercise sheet's name.
function taskFileLabel(task: DailyMissionTask): string {
  const name = task.source_file_name || task.exercise_file_name;
  return name ? '<div class="dm-task-file">' + escapeHtml(name) + '</div>' : '';
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
        taskFileLabel(task) +
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
