// Shared Daily Mission rendering + interaction layer.
//
// This is the single source of truth for how a daily plan is painted and how
// task actions are wired up. The dashboard widget, My Courses preview card,
// and the chatbot Daily Mission panel all read the same backend plan through
// these helpers so they stay in sync (per the Daily Mission UI plan: "do not
// duplicate task logic between surfaces").
//
// The chatbot is NOT the planner — every action here calls the backend and
// waits for confirmation before reflecting a new state. Nothing is mutated
// locally without an API round-trip.

import { escapeHtml } from '../../utils/escape-html.js';
import {
  DailyMissionResponse,
  DailyMissionTask,
  generateDailyMission,
  getDailyMission,
  regenerateDailyMission,
  updateDailyMissionTask
} from '../../services/study-service.js';

export type DailyMissionGroup = 'must_do' | 'should_do' | 'optional';

const GROUP_LABEL: Record<DailyMissionGroup, string> = {
  must_do: 'Must Do',
  should_do: 'Should Do',
  optional: 'Optional'
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
        '<span class="dm-progress-sep">·</span>' +
        '<span>' + s.minutesRemaining + ' min left</span>' +
      '</div>' +
      '<div class="dm-progress-track"><div class="dm-progress-fill" style="width:' + pct + '%"></div></div>' +
    '</div>'
  );
}

/** Renders one task card. `disableActionsFor` can mark unavailable tasks so
 *  broken "Open Source" buttons never render (Phase 3 acceptance test). */
export function renderTaskCardHtml(task: DailyMissionTask): string {
  const isDone = task.status === 'completed';
  const isUnavailable = task.status === 'unavailable' || task.status === 'replaced';
  const isMoved = task.status === 'moved';
  const canAct = !isDone && !isUnavailable && !isMoved;

  const actions: string[] = [];
  if (canAct) {
    if (task.status === 'todo') {
      // Primary start action — label and behaviour depend on task type
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
        '<div class="dm-task-meta">' + task.estimated_minutes + ' min' + '</div>' +
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

/** Mounts the full Daily Mission experience (progress header + grouped task
 *  cards + actions) into `host`. Used by the chatbot Daily Mission mode —
 *  the richest of the three surfaces per the plan ("the full V1 experience"). */
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
    } catch { /* keep the last good render on transient refresh errors */ }
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

/** Regenerates today's plan (idempotent, preserves completed tasks) and
 *  re-paints. Exposed for the chatbot's "regenerate my plan" affordance. */
export async function regenerateAndRepaint(host: HTMLElement, courseId: string, opts?: MountOptions): Promise<void> {
  await regenerateDailyMission(courseId);
  await mountDailyMissionPanel(host, courseId, opts);
}
