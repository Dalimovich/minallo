// Multi-subject weekly study planner.
// Replaces the old single-course daily-mission scheduler.

import { requireEnv, optionalEnv } from './env';
import { fail, jsonResponse } from './responses';
import { supaRequest } from './supabase-admin';
import { extractBearerToken, verifySupabaseToken } from './supabase-auth';
import { forwardToPython, pythonAiConfigured } from './python-ai-proxy';
import { isSafeCourseId } from './validation';
import type { LambdaResponse, NetlifyEvent, SupabaseUser } from './types';
import type {
  DayAllocation,
  PlanScope,
  PossibleMatch,
  ProgressState,
  ScoredSubject,
  SequencedTask,
  StudyPreferences,
  SubjectState,
  TaskCandidate,
  TaskStatus,
  TopicState,
  WeeklyStudyPlan,
  WeeklyStudyTask,
} from './study-planner-types';

// Re-export types that external modules need.
export type { PossibleMatch, WeeklyStudyTask };

// ── AI planner feature flag ────────────────────────────────────────────────────

// Accept any common truthy spelling — a value of 'true'/'ON'/'1' was silently
// disabling the AI planner because the old check required the exact string 'on'.
const AI_PLANNER_ON = ['on', 'true', '1', 'yes', 'enabled'].includes(
  optionalEnv('AI_PLANNER', 'off').trim().toLowerCase()
);

// ── AI planner contract types ─────────────────────────────────────────────────

export type AiTaskType =
  | 'study_lecture'
  | 'continue_lecture'
  | 'solve_exercise_sheet'
  | 'check_solution_sheet'
  | 'repeat_lecture'
  | 'review_weak_topic'
  | 'review_completed_exercise'
  | 'generate_quiz_if_no_exercises'
  | 'exam_style_practice'
  | 'pre_exam_review';

const ALLOWED_AI_TASK_TYPES: ReadonlySet<string> = new Set<AiTaskType>([
  'study_lecture',
  'continue_lecture',
  'solve_exercise_sheet',
  'check_solution_sheet',
  'repeat_lecture',
  'review_weak_topic',
  'review_completed_exercise',
  'generate_quiz_if_no_exercises',
  'exam_style_practice',
  'pre_exam_review',
]);

export interface PyTask {
  id: string;
  planDate: string;
  dayIndex: number;
  courseId: string;
  subjectName: string;
  taskType: string;
  lectureFileId?: string;
  lectureFileName?: string;
  lectureTopics?: string[];
  exerciseFileId?: string;
  exerciseFileName?: string;
  solutionFileId?: string;
  solutionFileName?: string;
  relatedLectureFileId?: string;
  relatedLectureFileName?: string;
  relatedLectureTopics?: string[];
  pageRange?: string;
  estimatedMinutes: number;
  reason: string;
  status: string;
  repetitionStage?: number;
  sourceConfidence: string;
}

export interface PythonPlanResponse {
  weekStartDate: string;
  subjectAllocation: Array<{
    courseId: string;
    subjectName: string;
    percentage: number;
    reason: string;
  }>;
  tasks: PyTask[];
  possibleMatches: Array<{
    courseId: string;
    exerciseFileId: string;
    exerciseFileName: string;
    possibleLectureFileId: string;
    possibleLectureFileName: string;
    confidence: 'medium' | 'low';
    reason: string;
  }>;
  unmappedFiles?: UnmappedFile[];
}

// A document the planner could not schedule because it has no topic mappings
// (so it can't participate in spaced repetition). Surfaced to the frontend so
// the user can map it.
export interface UnmappedFile {
  courseId: string;
  fileId: string;
  fileName: string;
  documentRole: string;
  reason: string;
}

// ── AI task row shape ─────────────────────────────────────────────────────────

export interface AiTaskRow {
  plan_id: string;
  user_id: string;
  plan_date: string;
  day_order: number;
  course_id: string;
  subject_name: string;
  task_type: string;
  task_title: string;
  task_description: string;
  source_file_id: string | null;
  exercise_file_id: string | null;
  solution_file_id: string | null;
  related_lecture_file_id: string | null;
  lecture_topics: string[];
  related_lecture_topics: string[];
  page_range: string | null;
  estimated_minutes: number;
  reason: string;
  status: string;
  source_confidence: string;
  priority_score: number;
  repetition_stage: number | null;
  canonical_task_key: string;
  study_state_required: string;
  exercise_available: boolean;
  is_valid: boolean;
}

// ── AI helper: derive priority_score from task type ───────────────────────────

function priorityScoreForAiTaskType(taskType: string): number {
  switch (taskType) {
    case 'exam_style_practice':
    case 'pre_exam_review':
    case 'review_weak_topic':
    case 'solve_exercise_sheet':
      return 0.85;
    case 'study_lecture':
    case 'continue_lecture':
    case 'check_solution_sheet':
      return 0.6;
    default:
      return 0.4;
  }
}

// ── AI helper: build task_title + task_description for AI task types ──────────

function buildAiTaskTitle(t: PyTask): string {
  const lectureName =
    t.lectureFileName ??
    (t.lectureTopics && t.lectureTopics.length > 0 ? t.lectureTopics[0] : null) ??
    t.relatedLectureFileName ??
    'Lecture';
  const exerciseName = t.exerciseFileName ?? 'Exercise sheet';
  const solutionName = t.solutionFileName ?? 'Solutions';

  switch (t.taskType as AiTaskType) {
    case 'study_lecture':
      return `Study: ${lectureName}`;
    case 'continue_lecture':
      return `Continue: ${lectureName}`;
    case 'solve_exercise_sheet':
      return `Practice: ${exerciseName}`;
    case 'check_solution_sheet':
      return `Check solutions: ${solutionName}`;
    case 'repeat_lecture':
      return `Repeat: ${lectureName}`;
    case 'review_weak_topic': {
      const topicName =
        (t.lectureTopics && t.lectureTopics.length > 0 ? t.lectureTopics[0] : null) ?? lectureName;
      return `Review: ${topicName}`;
    }
    case 'review_completed_exercise':
      return `Re-review: ${exerciseName}`;
    case 'generate_quiz_if_no_exercises': {
      const topicName =
        (t.lectureTopics && t.lectureTopics.length > 0 ? t.lectureTopics[0] : null) ?? lectureName;
      return `Quiz: ${topicName}`;
    }
    case 'exam_style_practice':
      return `Exam drill: ${exerciseName}`;
    case 'pre_exam_review': {
      const topicName =
        (t.lectureTopics && t.lectureTopics.length > 0 ? t.lectureTopics[0] : null) ?? lectureName;
      return `Pre-exam review: ${topicName}`;
    }
    default:
      return `Study: ${lectureName}`;
  }
}

function buildAiTaskDescription(t: PyTask): string {
  if (t.reason && t.reason.trim()) return t.reason.trim();
  const pageStr = t.pageRange ? `, ${t.pageRange}` : '';
  switch (t.taskType as AiTaskType) {
    case 'study_lecture':
    case 'continue_lecture':
      return `Read through ${t.lectureFileName ?? 'the lecture'}${pageStr}.`;
    case 'solve_exercise_sheet':
      return `Work through the exercises in ${t.exerciseFileName ?? 'the exercise sheet'}${pageStr}.`;
    case 'check_solution_sheet':
      return `Check your answers against ${t.solutionFileName ?? 'the solution sheet'}${pageStr}.`;
    case 'repeat_lecture':
      return `Revisit ${t.lectureFileName ?? 'the lecture'}${pageStr} to reinforce understanding.`;
    case 'review_weak_topic':
      return `Re-consolidate weak areas in ${t.lectureFileName ?? 'this topic'}${pageStr}.`;
    case 'review_completed_exercise':
      return `Review completed work in ${t.exerciseFileName ?? 'the exercise sheet'}${pageStr}.`;
    case 'generate_quiz_if_no_exercises':
      return `Test yourself using a generated quiz for this topic.`;
    case 'exam_style_practice':
      return `Practise exam-style questions from ${t.exerciseFileName ?? 'the exercise sheet'}${pageStr}.`;
    case 'pre_exam_review':
      return `Final review pass before the exam${pageStr}.`;
    default:
      return `Study ${t.lectureFileName ?? 'the material'}${pageStr}.`;
  }
}

// ── AI helper: coerce source_confidence ──────────────────────────────────────

function coerceSourceConfidence(raw: string): string {
  if (raw === 'confirmed' || raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'high';
}

// ── AI helper: study_state_required from AI task type ────────────────────────

function studyStateRequiredForAiType(taskType: string): string {
  if (taskType === 'solve_exercise_sheet' || taskType === 'review_completed_exercise') return 'studied';
  if (taskType === 'check_solution_sheet') return 'studied';
  if (taskType === 'exam_style_practice' || taskType === 'pre_exam_review') return 'practiced';
  return 'not_started';
}

// ── AI helper: build canonical_task_key ──────────────────────────────────────

/**
 * Stable identity key for a task within a plan.
 * Format: planScope|plan_date|course_id|task_type|lectureFileId|exerciseFileId|solutionFileId|sortedTopics|pageRange|repetitionStage|
 * Does NOT include: title, reason, estimated_minutes, priority_score, status.
 */
export function buildCanonicalTaskKey(
  planScope: string,
  planDate: string,
  courseId: string,
  taskType: string,
  lectureFileId: string,
  exerciseFileId: string,
  solutionFileId: string,
  lectureTopics: string[],
  pageRange: string,
  repetitionStage: string
): string {
  const sortedTopics = [...lectureTopics].sort().join(',');
  return [
    planScope,
    planDate,
    courseId,
    taskType,
    lectureFileId,
    exerciseFileId,
    solutionFileId,
    sortedTopics,
    pageRange,
    repetitionStage,
    '', // repetitionOriginTaskId reserved
  ].join('|');
}

// ── AI helper: validate and map a PyTask to a DB row ─────────────────────────

/**
 * Maps a Python planner task to a weekly_study_tasks row.
 * Returns null if the task is invalid (bad taskType, planDate, or courseId).
 * `dayOrderCounter` is mutated (incremented) to assign day_order.
 */
export function validateAndMapPyTask(
  t: PyTask,
  planId: string,
  userId: string,
  planScope: string,
  dayOrderCounter: { value: number }
): AiTaskRow | null {
  // Validate taskType
  if (!ALLOWED_AI_TASK_TYPES.has(t.taskType)) return null;

  // Validate planDate (YYYY-MM-DD)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.planDate)) return null;

  // Validate courseId
  if (!t.courseId || typeof t.courseId !== 'string' || !t.courseId.trim()) return null;

  // Clamp estimatedMinutes [5..180]
  const estimatedMinutes = Math.max(5, Math.min(180, t.estimatedMinutes || 30));

  // Map file IDs
  const lectureFileId = t.lectureFileId ?? null;
  const relatedLectureFileId = t.relatedLectureFileId ?? null;
  const exerciseFileId = t.exerciseFileId ?? null;
  const solutionFileId = t.solutionFileId ?? null;

  // source_file_id = lectureFileId ?? relatedLectureFileId ?? null
  const sourceFileId = lectureFileId ?? relatedLectureFileId ?? null;

  const lectureTopics = t.lectureTopics ?? [];
  const relatedLectureTopics = t.relatedLectureTopics ?? [];
  const pageRange = t.pageRange ?? null;
  const repetitionStage = t.repetitionStage ?? null;

  // Build canonical key
  const canonicalTaskKey = buildCanonicalTaskKey(
    planScope,
    t.planDate,
    t.courseId,
    t.taskType,
    lectureFileId ?? '',
    exerciseFileId ?? '',
    solutionFileId ?? '',
    lectureTopics,
    pageRange ?? '',
    repetitionStage !== null ? String(repetitionStage) : ''
  );

  const dayOrder = dayOrderCounter.value++;

  return {
    plan_id: planId,
    user_id: userId,
    plan_date: t.planDate,
    day_order: dayOrder,
    course_id: t.courseId,
    subject_name: t.subjectName,
    task_type: t.taskType,
    task_title: buildAiTaskTitle(t),
    task_description: buildAiTaskDescription(t),
    source_file_id: sourceFileId,
    exercise_file_id: exerciseFileId,
    solution_file_id: solutionFileId,
    related_lecture_file_id: relatedLectureFileId,
    lecture_topics: lectureTopics,
    related_lecture_topics: relatedLectureTopics,
    page_range: pageRange,
    estimated_minutes: estimatedMinutes,
    reason: t.reason ?? '',
    status: 'todo',
    source_confidence: coerceSourceConfidence(t.sourceConfidence ?? ''),
    priority_score: priorityScoreForAiTaskType(t.taskType),
    repetition_stage: repetitionStage,
    canonical_task_key: canonicalTaskKey,
    study_state_required: studyStateRequiredForAiType(t.taskType),
    exercise_available: t.taskType === 'solve_exercise_sheet' || t.taskType === 'review_completed_exercise',
    is_valid: true,
  };
}

// ── AI helper: diff-upsert persisted tasks ────────────────────────────────────

const PROTECTED_STATUSES = new Set(['completed', 'skipped', 'moved', 'unavailable', 'replaced']);

interface ExistingTaskStub {
  id: string;
  plan_date: string;
  status: string;
  canonical_task_key: string | null;
}

export async function persistAiTasks(
  planId: string,
  _userId: string,
  serviceKey: string,
  rows: AiTaskRow[]
): Promise<void> {
  // Fetch existing tasks for the plan
  const existingRes = await supaRequest<ExistingTaskStub[]>(
    'GET',
    'weekly_study_tasks?plan_id=eq.' +
      encodeURIComponent(planId) +
      '&select=id,plan_date,status,canonical_task_key',
    null,
    serviceKey
  );
  const existing: ExistingTaskStub[] = Array.isArray(existingRes.body) ? existingRes.body : [];

  const todayStr = new Date().toISOString().slice(0, 10);

  // Partition existing into editable vs protected
  const editableByKey = new Map<string, ExistingTaskStub>();
  const editableIds = new Set<string>();
  // Editable tasks with NO canonical_task_key. Legacy deterministic-fallback
  // inserts never set one, so they can't be matched against any incoming task —
  // which used to make them immortal: every AI regen layered fresh tasks on top
  // but could never mark these stale, leaving a plan permanently polluted with
  // pre-fix tasks (e.g. standalone "Check solutions" rows). A keyless editable
  // task carries no identity to preserve, so the fresh AI batch is authoritative:
  // sweep them all to 'replaced'.
  const keylessEditableIds: string[] = [];

  for (const ex of existing) {
    const isPast = ex.plan_date < todayStr;
    const isProtected = PROTECTED_STATUSES.has(ex.status) || isPast;
    if (isProtected) continue;
    if (ex.canonical_task_key) {
      editableByKey.set(ex.canonical_task_key, ex);
      editableIds.add(ex.id);
    } else {
      keylessEditableIds.push(ex.id);
    }
  }

  // Build incoming canonical key set
  const incomingKeys = new Set(rows.map((r) => r.canonical_task_key));

  // Rows to INSERT (no matching existing key) vs PATCH (existing key found)
  const toInsert: AiTaskRow[] = [];
  const toPatch: Array<{ id: string; fields: Partial<AiTaskRow> }> = [];
  // The AI can emit two tasks with identical canonical identity (e.g. two
  // exam-prep tasks on the same solution file + date). Inserting both violates
  // the (plan_id, canonical_task_key) unique index and 400s the entire batch,
  // leaving the plan with zero tasks. De-dupe incoming rows by key, first wins.
  const seenIncoming = new Set<string>();

  for (const row of rows) {
    if (seenIncoming.has(row.canonical_task_key)) continue;
    seenIncoming.add(row.canonical_task_key);
    const existing = editableByKey.get(row.canonical_task_key);
    if (existing) {
      // Patch mutable fields only
      toPatch.push({
        id: existing.id,
        fields: {
          task_title: row.task_title,
          task_description: row.task_description,
          reason: row.reason,
          estimated_minutes: row.estimated_minutes,
          page_range: row.page_range,
          priority_score: row.priority_score,
        },
      });
    } else {
      toInsert.push(row);
    }
  }

  // Existing editable tasks whose key is NOT in the incoming set → mark replaced.
  // Keyless editable tasks are always swept (see keylessEditableIds above).
  const toReplace: string[] = [...keylessEditableIds];
  for (const [key, ex] of editableByKey) {
    if (!incomingKeys.has(key)) {
      toReplace.push(ex.id);
    }
  }

  // INSERT in batches of 50. ignore-duplicates is a safety net against a
  // canonical key that already exists in the DB (e.g. a prior partial write).
  for (let i = 0; i < toInsert.length; i += 50) {
    const batch = toInsert.slice(i, i + 50);
    await supaRequest('POST', 'weekly_study_tasks', batch, serviceKey, {
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    });
  }

  // PATCH mutable fields per task
  for (const { id, fields } of toPatch) {
    await supaRequest(
      'PATCH',
      'weekly_study_tasks?id=eq.' + encodeURIComponent(id),
      fields,
      serviceKey,
      { Prefer: 'return=minimal' }
    );
  }

  // Mark replaced in batches of 50 (using IN filter)
  for (let i = 0; i < toReplace.length; i += 50) {
    const batch = toReplace.slice(i, i + 50);
    await supaRequest(
      'PATCH',
      'weekly_study_tasks?id=in.(' + batch.map(encodeURIComponent).join(',') + ')',
      { status: 'replaced' },
      serviceKey,
      { Prefer: 'return=minimal' }
    );
  }
}

// ── AI: find-or-create weekly_study_plans row (shared helper) ─────────────────

interface FindOrCreatePlanResult {
  planId: string;
  isNew: boolean;
  raceHandled: boolean;
}

async function findOrCreateWeeklyPlan(
  userId: string,
  weekStart: string,
  scope: PlanScope,
  courseId: string | null,
  serviceKey: string,
  generationParams: Record<string, unknown>
): Promise<FindOrCreatePlanResult> {
  const planKey =
    'weekly_study_plans?user_id=eq.' +
    encodeURIComponent(userId) +
    '&week_start_date=eq.' +
    encodeURIComponent(weekStart) +
    '&plan_scope=eq.' +
    encodeURIComponent(scope) +
    '&' +
    (courseId ? 'course_id=eq.' + encodeURIComponent(courseId) : 'course_id=is.null') +
    '&select=*&limit=1';

  const existingRes = await supaRequest<WeeklyStudyPlan[]>('GET', planKey, null, serviceKey);
  const existing = Array.isArray(existingRes.body) ? existingRes.body[0] ?? null : null;

  if (existing) {
    return { planId: existing.id, isNew: false, raceHandled: false };
  }

  const created = await supaRequest<WeeklyStudyPlan[]>(
    'POST',
    'weekly_study_plans',
    {
      user_id: userId,
      week_start_date: weekStart,
      plan_scope: scope,
      course_id: courseId ?? null,
      status: 'active',
      generation_params: generationParams,
    },
    serviceKey,
    { Prefer: 'return=representation' }
  );

  if (Array.isArray(created.body) && created.body[0]) {
    return { planId: created.body[0]!.id, isNew: true, raceHandled: false };
  }

  // Race condition: another process created it. Re-fetch.
  const raceRes = await supaRequest<WeeklyStudyPlan[]>('GET', planKey, null, serviceKey);
  const racePlan = Array.isArray(raceRes.body) ? raceRes.body[0] ?? null : null;
  if (!racePlan) throw new Error('Could not create weekly study plan');
  return { planId: racePlan.id, isNew: false, raceHandled: true };
}

// Look up an existing weekly plan's id WITHOUT creating one. Used by the AI path
// so it can decide whether to call Python before any DB write happens.
async function findExistingWeeklyPlanId(
  userId: string,
  weekStart: string,
  scope: PlanScope,
  courseId: string | null,
  serviceKey: string
): Promise<string | null> {
  const planKey =
    'weekly_study_plans?user_id=eq.' +
    encodeURIComponent(userId) +
    '&week_start_date=eq.' +
    encodeURIComponent(weekStart) +
    '&plan_scope=eq.' +
    encodeURIComponent(scope) +
    '&' +
    (courseId ? 'course_id=eq.' + encodeURIComponent(courseId) : 'course_id=is.null') +
    '&select=id&limit=1';
  const res = await supaRequest<Array<{ id: string }>>('GET', planKey, null, serviceKey);
  return Array.isArray(res.body) ? res.body[0]?.id ?? null : null;
}

// ── AI: validate possible-matches from the Python response ───────────────────

function validatePossibleMatches(raw: unknown): PossibleMatch[] {
  if (!Array.isArray(raw)) return [];
  const out: PossibleMatch[] = [];
  for (const item of raw) {
    if (
      item == null ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).courseId !== 'string' ||
      !(item as Record<string, unknown>).courseId ||
      typeof (item as Record<string, unknown>).exerciseFileId !== 'string' ||
      !(item as Record<string, unknown>).exerciseFileId ||
      typeof (item as Record<string, unknown>).possibleLectureFileId !== 'string' ||
      !(item as Record<string, unknown>).possibleLectureFileId
    ) {
      continue;
    }
    const i = item as Record<string, unknown>;
    const confidence: 'medium' | 'low' =
      i.confidence === 'medium' ? 'medium' : 'low';
    out.push({
      courseId: String(i.courseId),
      exerciseFileId: String(i.exerciseFileId),
      exerciseFileName: typeof i.exerciseFileName === 'string' ? i.exerciseFileName : '',
      possibleLectureFileId: String(i.possibleLectureFileId),
      possibleLectureFileName:
        typeof i.possibleLectureFileName === 'string' ? i.possibleLectureFileName : '',
      confidence,
      reason: typeof i.reason === 'string' ? i.reason : '',
    });
    if (out.length >= 50) break;
  }
  return out;
}

// ── AI: validate unmapped-files report from the Python response ──────────────

function validateUnmappedFiles(raw: unknown): UnmappedFile[] {
  if (!Array.isArray(raw)) return [];
  const out: UnmappedFile[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const i = item as Record<string, unknown>;
    const fileId = typeof i.fileId === 'string' ? i.fileId : '';
    if (!fileId) continue;
    out.push({
      courseId: typeof i.courseId === 'string' ? i.courseId : '',
      fileId,
      fileName: typeof i.fileName === 'string' ? i.fileName : '',
      documentRole: typeof i.documentRole === 'string' ? i.documentRole : '',
      reason: typeof i.reason === 'string' ? i.reason : '',
    });
    if (out.length >= 200) break;
  }
  return out;
}

// ── AI: generate weekly plan via Python AI proxy ──────────────────────────────

async function generateWeeklyPlanViaAI(
  userId: string,
  weekStartDate: Date,
  scope: PlanScope,
  courseId: string | null,
  serviceKey: string,
  regenerateExisting: boolean
): Promise<{ planId: string; taskCount: number; subjects: string[]; urgency: null }> {
  const weekStart = dateToString(getWeekStart(weekStartDate));

  // Look up an existing plan WITHOUT creating one. Creating the plan row before
  // Python succeeds poisons the deterministic fallback: on a Python failure we
  // throw, the caller falls through to the deterministic body, which then sees
  // an (empty) existing plan and — on the read path (regenerateExisting=false) —
  // returns it untouched, leaving a permanently empty plan. So we create the row
  // only once Python has actually returned usable tasks (below).
  const existingPlanId = await findExistingWeeklyPlanId(userId, weekStart, scope, courseId, serviceKey);

  // Read path shortcut: a plan already exists and the caller doesn't want a regen.
  if (existingPlanId && !regenerateExisting) {
    return { planId: existingPlanId, taskCount: 0, subjects: [], urgency: null };
  }

  // Source the user's real availability. An empty map makes the Python planner
  // drop EVERY task on its unavailable-day check (returning 0 tasks), which
  // silently forces a fall-through to the deterministic planner — so the AI
  // planner's pairing/role fixes never run and tasks pile onto a single day.
  // Keys are Python day indices (0=Monday); study_days uses JS getUTCDay
  // (0=Sunday), so convert with (dow + 6) % 7.
  const availPrefRes = await supaRequest<StudyPreferences[]>(
    'GET',
    'study_preferences?user_id=eq.' + encodeURIComponent(userId) + '&select=study_days,daily_study_minutes&limit=1',
    null,
    serviceKey
  );
  const availPrefs = Array.isArray(availPrefRes.body) ? availPrefRes.body[0] : undefined;
  const studyDays = availPrefs?.study_days && availPrefs.study_days.length ? availPrefs.study_days : [1, 2, 3, 4, 5];
  const dailyMinutes = Math.max(15, availPrefs?.daily_study_minutes ?? 120);
  // Anchor scheduling at today. The plan spans a Monday-start week, but a task
  // written onto a day that has already passed is invisible — the daily mission
  // only ever shows "today". So drop any study day earlier than today from the
  // availability map; the planner refuses to schedule on days it isn't given
  // (_coerce_task), so the AI never wastes tasks on the dead part of the week.
  const weekStartDateObj = getWeekStart(weekStartDate);
  const realTodayStr = dateToString(new Date());
  const dailyAvailabilityMinutes: Record<string, number> = {};
  for (const jsDow of studyDays) {
    const pyIdx = ((Number(jsDow) % 7) + 6) % 7;
    const dayStr = dateToString(addDays(weekStartDateObj, pyIdx));
    if (dayStr < realTodayStr) continue; // day already in the past → unreachable
    dailyAvailabilityMinutes[String(pyIdx)] = dailyMinutes;
  }
  // Safety net: if the whole study week is already behind us (e.g. it's the
  // weekend and study_days are Mon–Fri), still let the AI plan for the viewed
  // day so "today's mission" isn't silently empty.
  if (Object.keys(dailyAvailabilityMinutes).length === 0) {
    const viewedPyIdx = Math.round(
      (Date.parse(dateToString(weekStartDate) + 'T00:00:00Z') - weekStartDateObj.getTime()) / 86400000
    );
    if (viewedPyIdx >= 0 && viewedPyIdx <= 6) {
      dailyAvailabilityMinutes[String(viewedPyIdx)] = dailyMinutes;
    }
  }

  // Durable user pairing decisions so the AI uses confirmed exercise↔lecture
  // pairs and never re-suggests dismissed ones.
  const pairingsRes = await supaRequest<Array<{ exercise_file_id: string; lecture_file_id: string; status: string }>>(
    'GET',
    'student_exercise_pairings?user_id=eq.' + encodeURIComponent(userId) +
      (courseId ? '&course_id=eq.' + encodeURIComponent(courseId) : '') +
      '&select=exercise_file_id,lecture_file_id,status',
    null,
    serviceKey
  );
  const pairingRows = Array.isArray(pairingsRes.body) ? pairingsRes.body : [];
  const confirmedPairings = pairingRows
    .filter((p) => p.status === 'confirmed')
    .map((p) => ({ exerciseFileId: p.exercise_file_id, lectureFileId: p.lecture_file_id }));
  const dismissedPairings = pairingRows
    .filter((p) => p.status === 'dismissed')
    .map((p) => ({ exerciseFileId: p.exercise_file_id, lectureFileId: p.lecture_file_id }));

  // Call the Python AI planner FIRST — before any DB write.
  const proxyResult = await forwardToPython<PythonPlanResponse>('study-planner/generate-week', {
    userId,
    weekStartDate: weekStart,
    planScope: scope,
    courseId,
    timezone: 'UTC',
    dailyAvailabilityMinutes,
    confirmedPairings,
    dismissedPairings,
    regenerate: regenerateExisting,
  });

  if (!proxyResult.ok) {
    throw new Error(`AI planner proxy error: ${proxyResult.status}`);
  }

  const response = proxyResult.body as PythonPlanResponse;
  const rawTasks: PyTask[] = Array.isArray(response?.tasks) ? response.tasks : [];

  if (rawTasks.length === 0) {
    throw new Error('AI planner returned 0 tasks');
  }

  // Python returned usable tasks — only NOW create/find the plan row.
  const { planId, isNew, raceHandled } = await findOrCreateWeeklyPlan(
    userId,
    weekStart,
    scope,
    courseId,
    serviceKey,
    { gen_version: 'ai-planner-v1' }
  );

  // Race-handled: another request created the plan and is filling it; return early.
  if (raceHandled) {
    return { planId, taskCount: 0, subjects: [], urgency: null };
  }

  // Explicit regen of an existing plan: wipe the stale slate first. Without this
  // the merge in persistAiTasks only ever marks tasks 'replaced', so junk from
  // every prior generation accretes (we saw a single plan reach 41 tasks) and
  // past-day todos linger forever. Delete everything except the user's own
  // decisions — completed and skipped tasks are preserved as history.
  if (regenerateExisting && !isNew) {
    await supaRequest(
      'DELETE',
      'weekly_study_tasks?plan_id=eq.' + encodeURIComponent(planId) +
        '&status=in.(todo,replaced)',
      null,
      serviceKey
    );
  }

  // Validate and map
  const dayOrderCounter = { value: 0 };
  const mappedRows: AiTaskRow[] = [];
  for (const t of rawTasks) {
    const row = validateAndMapPyTask(t, planId, userId, scope, dayOrderCounter);
    if (row) mappedRows.push(row);
  }

  if (mappedRows.length === 0) {
    throw new Error('AI planner: all tasks failed validation');
  }

  await persistAiTasks(planId, userId, serviceKey, mappedRows);

  // Persist possible_matches + unmapped-files report — best-effort; a failure
  // must not break plan generation. unmapped_files rides inside generation_params
  // (JSONB, already free-form) so no schema migration is needed — the frontend
  // reads it to show "these files aren't mapped to topics yet".
  try {
    const possibleMatches = validatePossibleMatches(response.possibleMatches);
    const unmappedFiles = validateUnmappedFiles(response.unmappedFiles);
    await supaRequest(
      'PATCH',
      'weekly_study_plans?id=eq.' + encodeURIComponent(planId),
      {
        possible_matches: possibleMatches,
        generation_params: { gen_version: 'ai-planner-v1', unmapped_files: unmappedFiles },
      },
      serviceKey,
      { Prefer: 'return=minimal' }
    );
  } catch (pmErr) {
    console.error('[study-planner] Failed to persist possible_matches/unmapped_files:', pmErr);
  }

  const subjectsSeen = [...new Set(mappedRows.map((r) => r.course_id))];

  // Write study event
  await writeStudyEvent(serviceKey, {
    user_id: userId,
    course_id: courseId ?? null,
    event_type: isNew ? 'plan_generated' : 'plan_regenerated',
    metadata: {
      weekStart,
      scope,
      taskCount: mappedRows.length,
      subjects: subjectsSeen,
      source: 'ai_planner',
    },
  });

  return {
    planId,
    taskCount: mappedRows.length,
    subjects: subjectsSeen,
    urgency: null,
  };
}

// ── Auth helpers (preserved from old planner) ────────────────────────────────

interface StudyAuth {
  user: SupabaseUser;
  serviceKey: string;
}

export async function requireStudyAuth(event: NetlifyEvent): Promise<StudyAuth | LambdaResponse> {
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');
  return { user, serviceKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY') };
}

export function bodyJson(event: NetlifyEvent): Record<string, unknown> | LambdaResponse {
  try {
    return JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
}

export function validateCourseId(courseId: unknown): string | LambdaResponse {
  if (!courseId || typeof courseId !== 'string' || !isSafeCourseId(courseId)) {
    return fail(400, 'courseId is invalid');
  }
  return courseId;
}

export function localPlanDate(
  inputDate: unknown,
  timezone: unknown
): { planDate: string; userTimezone: string } {
  const userTimezone =
    typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC';
  if (typeof inputDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
    return { planDate: inputDate, userTimezone };
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: userTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const d = parts.find((p) => p.type === 'day')?.value ?? '01';
    return { planDate: `${y}-${m}-${d}`, userTimezone };
  } catch {
    return { planDate: new Date().toISOString().slice(0, 10), userTimezone: 'UTC' };
  }
}

// ── Study events ─────────────────────────────────────────────────────────────

export async function writeStudyEvent(
  serviceKey: string,
  row: Record<string, unknown>
): Promise<void> {
  // Map old "value / metadata" fields to new "event_data" shape if needed.
  const { value, metadata, ...rest } = row as {
    value?: unknown;
    metadata?: unknown;
    [k: string]: unknown;
  };
  const eventData: Record<string, unknown> =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>)
      : {};
  if (value !== undefined) eventData['value'] = value;
  await supaRequest('POST', 'study_events', { ...rest, event_data: eventData }, serviceKey, {
    Prefer: 'return=minimal',
  });
}

// ── Week utilities ────────────────────────────────────────────────────────────

/** Returns the Monday of the ISO week containing `date`. */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dateToString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Days between two ISO date strings (positive if b is after a). */
function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24)
  );
}

// ── A. Candidate collection ───────────────────────────────────────────────────

export async function collectCandidates(
  userId: string,
  serviceKey: string,
  courseId?: string
): Promise<TaskCandidate[]> {
  let url =
    'valid_task_candidates?user_id=eq.' +
    encodeURIComponent(userId) +
    '&is_valid=eq.true' +
    '&source_confidence=in.(high,confirmed)' +
    '&select=*' +
    '&order=created_at.asc' +
    '&limit=200';
  if (courseId) url += '&course_id=eq.' + encodeURIComponent(courseId);

  const res = await supaRequest<TaskCandidate[]>('GET', url, null, serviceKey);
  const all = Array.isArray(res.body) ? res.body : [];

  // If we have candidates, verify their documents are ready (fetch separately to avoid join issues)
  if (all.length > 0 && all[0]?.source_file_id) {
    const fileIds = [...new Set(all.map(c => c.source_file_id).filter(Boolean))];
    const docUrl = 'documents?id=in.(' + fileIds.map(id => encodeURIComponent(id as string)).join(',') + ')&select=id,processing_status';
    const docsRes = await supaRequest<{ id: string; processing_status: string }[]>('GET', docUrl, null, serviceKey);
    const readyDocs = new Set(
      (Array.isArray(docsRes.body) ? docsRes.body : [])
        .filter(d => d.processing_status === 'ready')
        .map(d => d.id)
    );
    return all.filter(c => !c.source_file_id || readyDocs.has(c.source_file_id as string));
  }

  return all;
}

// ── B. Subject priority scoring ───────────────────────────────────────────────

export function scoreSubject(
  state: SubjectState | null,
  candidates: TaskCandidate[]
): number {
  let score = 0;
  if (!state) {
    // No state row yet — treat as moderate priority.
    return 20;
  }

  const today = new Date().toISOString().slice(0, 10);

  // Exam proximity
  if (state.exam_date) {
    const days = daysBetween(today, state.exam_date);
    if (days >= 0 && days <= 14) score += 50;
    else if (days >= 0 && days <= 30) score += 30;
  }

  // Deadline proximity
  if (state.deadline) {
    const days = daysBetween(today, state.deadline);
    if (days >= 0 && days <= 7) score += 40;
    else if (days >= 0 && days <= 14) score += 20;
  }

  // User priority override (1 = highest → 10 = lowest)
  if (state.user_priority_override !== null) {
    score += Math.max(0, 11 - state.user_priority_override) * 3;
  } else {
    // Fallback to the general priority field (lower = more important)
    score += Math.max(0, 11 - state.priority) * 1;
  }

  // Unstudied topic ratio
  const total = Math.max(1, state.total_topics);
  const unstudied = total - state.studied_topics;
  score += Math.round((unstudied / total) * 20);

  // Weak topic count
  score += state.weak_topics * 5;

  // Staleness boost (days since last studied, capped at 30)
  if (state.last_studied_at) {
    const staleDays = Math.min(30, daysBetween(state.last_studied_at.slice(0, 10), today));
    score += Math.round(staleDays * 0.5);
  } else {
    // Never studied — strong boost
    score += 15;
  }

  // Has exercise papers
  const hasExercises = candidates.some((c) => c.exercise_available);
  if (hasExercises) score += 5;

  return score;
}

// ── C. Workload distribution ──────────────────────────────────────────────────

export function distributeAcrossWeek(
  subjects: ScoredSubject[],
  preferences: StudyPreferences,
  weekStartDate: Date
): DayAllocation[] {
  const studyDays = preferences.study_days.length > 0 ? preferences.study_days : [1, 2, 3, 4, 5];
  const dailyMinutes = Math.max(15, preferences.daily_study_minutes);

  // Build list of study dates in this week.
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStartDate, i);
    const dow = d.getUTCDay(); // 0=Sun
    if (studyDays.includes(dow)) {
      dates.push(dateToString(d));
    }
  }
  if (!dates.length) return [];
  if (!subjects.length) return [];

  // Sort subjects by score descending.
  const sorted = [...subjects].sort((a, b) => b.score - a.score);

  // How many subjects to feature daily: max 3 unless only 1 or 2 exist.
  const subjectsPerDay = Math.min(sorted.length, 3);

  // Cap single-subject share at 50% unless it's the only subject or score >> others.
  const maxSharePerSubject = sorted.length === 1 ? 1.0 : 0.5;

  const result: DayAllocation[] = dates.map((date) => ({ date, allocations: [] }));

  // Round-robin top subjects across days so every day gets variety.
  dates.forEach((_date, dayIdx) => {
    const alloc = result[dayIdx]!;
    // Rotate so different subjects lead on different days.
    const startIdx = dayIdx % sorted.length;
    const todaySubjects: ScoredSubject[] = [];
    for (let i = 0; i < subjectsPerDay; i++) {
      todaySubjects.push(sorted[(startIdx + i) % sorted.length]!);
    }

    const minutesLeft = dailyMinutes;
    const perSubject = Math.floor(minutesLeft / todaySubjects.length);

    for (const subj of todaySubjects) {
      const cappedMinutes = Math.min(perSubject, Math.floor(dailyMinutes * maxSharePerSubject));
      alloc.allocations.push({
        courseId: subj.courseId,
        subjectName: subj.subjectName,
        minutesAllocated: cappedMinutes,
        candidates: subj.candidates,
        topicStates: subj.topicStates,
      });
    }
  });

  return result;
}

// ── D. Task sequencing per subject per day ────────────────────────────────────

// Study-state rank: lower index = higher priority for study tasks.
const STATE_PRIORITY: Record<string, number> = {
  not_started: 0,
  in_progress: 1,
  weak: 2,
  studied: 3,
  practiced: 4,
  mastered: 5,
};

// Task type ordering within a plan: study before practice/quiz.
const TASK_TYPE_PLAN_RANK: Record<string, number> = {
  study_topic: 0,
  read_pages: 0,
  review_weak_topic: 1,
  solve_exercise_sheet: 2,
  practice_problem_set: 2,
  check_solution_sheet: 2,
  review_completed_exercise: 2,
  generate_quiz_if_no_exercises: 3,
  exam_style_practice: 4,
  pre_exam_review: 4,
  review_topic: 5,
};

// Stable identity for a candidate within a plan. Collapse by FILE, not topic:
// the topic map routinely extracts many sub-topics from one lecture PDF, all
// pointing back to that single file. Studying the file once covers them all, so
// a file+type pair must yield exactly one task — otherwise one PDF shows up as
// 4-6 near-identical "Study: <topic>" cards. Fall back to topic only when a
// candidate has no source file.
function candidateKey(c: TaskCandidate): string {
  if (c.source_file_id) return `file:${c.source_file_id}:${c.task_type}`;
  return `topic:${c.topic_id ?? '_'}:${c.task_type}`;
}

export function sequenceTasksForSubject(
  candidates: TaskCandidate[],
  topicStates: Map<string, TopicState>,
  targetMinutes: number,
  // Shared across every day/subject of a single plan so the same candidate is
  // never scheduled twice. When omitted (e.g. unit tests) dedup is per-call.
  alreadyScheduled?: Set<string>
): SequencedTask[] {
  // Group candidates by topic to enforce study-before-practice ordering.
  const byTopic = new Map<string, TaskCandidate[]>();
  const noTopic: TaskCandidate[] = [];
  for (const c of candidates) {
    if (!c.topic_id) {
      noTopic.push(c);
      continue;
    }
    const arr = byTopic.get(c.topic_id) ?? [];
    arr.push(c);
    byTopic.set(c.topic_id, arr);
  }

  const eligible: TaskCandidate[] = [];

  // Process each topic's candidates according to the STRICT ordering rules.
  for (const [topicId, topicCandidates] of byTopic) {
    const ts = topicStates.get(topicId);
    const state: ProgressState = ts?.progress_state ?? 'not_started';

    for (const c of topicCandidates) {
      const tt = c.task_type;

      if (tt === 'study_topic' || tt === 'read_pages') {
        // Always schedulable if not mastered.
        if (state !== 'mastered') eligible.push(c);
        continue;
      }

      if (tt === 'solve_exercise_sheet' || tt === 'practice_problem_set') {
        // Only if topic is studied or better.
        if (
          state === 'studied' ||
          state === 'practiced' ||
          state === 'mastered'
        ) {
          eligible.push(c);
        }
        continue;
      }

      if (tt === 'generate_quiz_if_no_exercises') {
        if ((state === 'studied' || state === 'practiced') && !c.exercise_available) {
          eligible.push(c);
        }
        continue;
      }

      if (tt === 'review_weak_topic') {
        if (state === 'weak') eligible.push(c);
        continue;
      }

      if (tt === 'exam_style_practice') {
        if (state === 'practiced' || state === 'mastered') eligible.push(c);
        continue;
      }

      if (tt === 'check_solution_sheet' || tt === 'review_completed_exercise') {
        // Checking solutions / re-reviewing only makes sense AFTER practising —
        // scheduling them on not-yet-studied topics is what flooded the day with
        // premature "Check solutions" tasks.
        if (state === 'practiced' || state === 'mastered') eligible.push(c);
        continue;
      }

      // Default — include unless mastered.
      if (state !== 'mastered') eligible.push(c);
    }
  }

  // Add no-topic candidates — but never premature solution-check / re-review
  // tasks: with no topic signal there's no evidence the exercise was done.
  for (const c of noTopic) {
    if (c.task_type === 'check_solution_sheet' || c.task_type === 'review_completed_exercise') continue;
    eligible.push(c);
  }

  // Sort eligible tasks: by topic state urgency, then task type plan rank.
  eligible.sort((a, b) => {
    const stA = a.topic_id
      ? (STATE_PRIORITY[topicStates.get(a.topic_id)?.progress_state ?? 'not_started'] ?? 0)
      : 3;
    const stB = b.topic_id
      ? (STATE_PRIORITY[topicStates.get(b.topic_id)?.progress_state ?? 'not_started'] ?? 0)
      : 3;
    if (stA !== stB) return stA - stB;

    // Within same state: study before practice.
    const rankA = TASK_TYPE_PLAN_RANK[a.task_type] ?? 5;
    const rankB = TASK_TYPE_PLAN_RANK[b.task_type] ?? 5;
    if (rankA !== rankB) return rankA - rankB;

    // Keep a course's files in natural sequence — Lecture/Exercise 3 before 10,
    // not "3 then 10". Only applies when both files carry a numeric suffix.
    const fnA = fileNumericSuffix(a.documents?.file_name ?? '');
    const fnB = fileNumericSuffix(b.documents?.file_name ?? '');
    if (fnA !== null && fnB !== null && fnA !== fnB) return fnA - fnB;

    // Higher priority score wins.
    return (b.priority_score ?? 0.5) - (a.priority_score ?? 0.5);
  });

  // Fill up to targetMinutes.
  const result: SequencedTask[] = [];
  let usedMinutes = 0;
  let order = 0;
  const seenTopicAndType = alreadyScheduled ?? new Set<string>();

  for (const c of eligible) {
    const key = candidateKey(c);
    if (seenTopicAndType.has(key)) continue;

    const cost = Math.max(10, Math.min(60, c.estimated_minutes || 30));
    if (result.length > 0 && usedMinutes + cost > targetMinutes + 10) continue;

    seenTopicAndType.add(key);
    result.push({
      candidate: c,
      estimatedMinutes: cost,
      dayOrder: order++,
      priorityScore: c.priority_score ?? 0.5,
    });
    usedMinutes += cost;

    if (usedMinutes >= targetMinutes) break;
  }

  // Return at least 1 task if any eligible candidate is still unscheduled.
  // Must respect the shared set, or every empty day re-adds the same task.
  if (result.length === 0) {
    const c = eligible.find((e) => !seenTopicAndType.has(candidateKey(e)));
    if (c) {
      seenTopicAndType.add(candidateKey(c));
      result.push({
        candidate: c,
        estimatedMinutes: Math.max(10, Math.min(60, c.estimated_minutes || 30)),
        dayOrder: 0,
        priorityScore: c.priority_score ?? 0.5,
      });
    }
  }

  return result;
}

// ── E. Study phase & urgency calculation ──────────────────────────────────────

type StudyPhase = 'normal' | 'exam_prep' | 'final_week' | 'crisis';

interface StudyUrgency {
  phase: StudyPhase;
  daysUntilExam: number;
  studiedPercentage: number;
  requiredDailyCompletion: number;
  isUrg: boolean;
  recommendCheatsheet: boolean;
}

async function calculateStudyUrgency(
  userId: string,
  courseId: string,
  serviceKey: string,
  today: Date
): Promise<StudyUrgency> {
  const subjectStateUrl =
    'student_subject_state?user_id=eq.' +
    encodeURIComponent(userId) +
    '&course_id=eq.' +
    encodeURIComponent(courseId) +
    '&select=*&limit=1';
  const ssRes = await supaRequest<SubjectState[]>('GET', subjectStateUrl, null, serviceKey);
  const subjectState = Array.isArray(ssRes.body) ? ssRes.body[0] : null;

  // Get topics to calculate % studied
  const topicStateUrl =
    'student_topic_state?user_id=eq.' +
    encodeURIComponent(userId) +
    '&course_id=eq.' +
    encodeURIComponent(courseId) +
    '&select=*&limit=1000';
  const tsRes = await supaRequest<TopicState[]>('GET', topicStateUrl, null, serviceKey);
  const topicStates = Array.isArray(tsRes.body) ? tsRes.body : [];

  const totalTopics = topicStates.length || 1;
  const studiedTopics = topicStates.filter(
    (t) => t.progress_state && ['studied', 'practiced', 'mastered'].includes(t.progress_state)
  ).length;
  const studiedPercentage = Math.round((studiedTopics / totalTopics) * 100);

  const daysUntilExam = subjectState?.exam_date
    ? daysBetween(dateToString(today), subjectState.exam_date)
    : 999;

  // Determine study phase
  let phase: StudyPhase = 'normal';
  if (daysUntilExam <= 7) phase = 'final_week';
  else if (daysUntilExam <= 21) phase = 'exam_prep';

  // Crisis detection: not enough studied by now
  const requiredByNow = Math.max(20, 100 - daysUntilExam * 5); // 5% per day minimum
  const isCrisis = daysUntilExam <= 7 && studiedPercentage < requiredByNow;
  if (isCrisis) phase = 'crisis';

  return {
    phase,
    daysUntilExam,
    studiedPercentage,
    requiredDailyCompletion: daysUntilExam > 0 ? Math.ceil((100 - studiedPercentage) / daysUntilExam) : 100,
    isUrg: studiedPercentage < requiredByNow,
    recommendCheatsheet: daysUntilExam <= 7 && studiedPercentage >= 70,
  };
}

// ── F. Weekly plan generation ─────────────────────────────────────────────────

export async function generateWeeklyPlan(
  userId: string,
  weekStartDate: Date,
  scope: PlanScope,
  courseId: string | null,
  serviceKey: string,
  // When false (the read path), an already-existing plan is returned untouched
  // instead of being torn down and rebuilt. This stops concurrent dashboard
  // reads from each regenerating the same plan and stacking duplicate tasks.
  // Only the explicit generate endpoint passes true.
  regenerateExisting = true
): Promise<{ planId: string; taskCount: number; subjects: string[]; urgency: StudyUrgency | null; source?: 'ai' | 'deterministic'; aiError?: string }> {
  // Diagnostic surfaced to the client so a fallback is visible without server
  // logs: why the AI planner didn't produce this plan.
  let aiError: string | undefined;
  if (!AI_PLANNER_ON) {
    aiError = 'AI planner disabled (AI_PLANNER not truthy)';
  } else if (!pythonAiConfigured()) {
    aiError = 'AI service not configured (AI_SERVICE_URL / INTERNAL_SECRET missing)';
  }

  // AI planner path: try first, fall through to deterministic on any error.
  if (AI_PLANNER_ON && pythonAiConfigured()) {
    try {
      const aiResult = await generateWeeklyPlanViaAI(
        userId,
        weekStartDate,
        scope,
        courseId,
        serviceKey,
        regenerateExisting
      );
      return { ...aiResult, source: 'ai' };
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
      console.error('[study-planner] AI planner failed, falling back to deterministic:', err);
      // Fall through to deterministic body below.
    }
  }
  const weekStart = dateToString(getWeekStart(weekStartDate));

  // Fetch preferences.
  const prefRes = await supaRequest<StudyPreferences[]>(
    'GET',
    'study_preferences?user_id=eq.' + encodeURIComponent(userId) + '&select=*&limit=1',
    null,
    serviceKey
  );
  const prefs: StudyPreferences = Array.isArray(prefRes.body) && prefRes.body[0]
    ? prefRes.body[0]
    : {
        user_id: userId,
        default_plan_scope: 'global_week',
        daily_study_minutes: 120,
        preferred_subjects: [],
        excluded_subjects: [],
        study_days: [1, 2, 3, 4, 5],
      };

  // Fetch subject states to get exam dates, priorities, exclusions.
  let subjectStateUrl =
    'student_subject_state?user_id=eq.' + encodeURIComponent(userId) + '&select=*';
  if (courseId) subjectStateUrl += '&course_id=eq.' + encodeURIComponent(courseId);
  const ssRes = await supaRequest<SubjectState[]>('GET', subjectStateUrl, null, serviceKey);
  const subjectStates = new Map<string, SubjectState>(
    Array.isArray(ssRes.body)
      ? ssRes.body.map((s) => [s.course_id, s])
      : []
  );

  // Collect excluded course IDs (from both prefs and subject state rows).
  const excludedCourses = new Set<string>([
    ...(prefs.excluded_subjects ?? []),
    ...Array.from(subjectStates.values())
      .filter((s) => s.user_excluded)
      .map((s) => s.course_id),
  ]);

  // Distribute across the week (needed early for urgency calculation).
  const weekStartObj = new Date(weekStart + 'T00:00:00Z');

  // Calculate study urgency for task filtering
  let urgency: StudyUrgency | null = null;
  if (courseId) {
    urgency = await calculateStudyUrgency(userId, courseId, serviceKey, weekStartObj);
  }

  // Collect valid candidates.
  const allCandidates = await collectCandidates(userId, serviceKey, courseId ?? undefined);

  // Seed if needed for the target course(s).
  const courseIds = courseId
    ? [courseId]
    : [...new Set(allCandidates.map((c) => c.course_id))];

  // If no candidates at all, attempt a seed for each course.
  let candidates = allCandidates;
  if (!candidates.length || !candidates.some((c) => c.task_type === 'study_topic' || c.task_type === 'read_pages')) {
    for (const cid of courseIds) {
      await seedCandidatesFromTopics(userId, cid, serviceKey);
    }
    candidates = await collectCandidates(userId, serviceKey, courseId ?? undefined);
  }

  // Filter excluded courses.
  candidates = candidates.filter((c) => !excludedCourses.has(c.course_id));

  // Phase-based task filtering
  if (urgency) {
    if (urgency.phase === 'crisis' || urgency.phase === 'final_week') {
      // Crisis/final week: only exams, quizzes, and practice
      candidates = candidates.filter((c) =>
        ['generate_quiz_if_no_exercises', 'exam_style_practice', 'solve_exercise_sheet', 'practice_problem_set'].includes(c.task_type)
      );
    } else if (urgency.phase === 'exam_prep') {
      // Exam prep: reduce lectures, increase practice
      const lectureRatio = candidates.filter((c) => c.task_type === 'study_topic' || c.task_type === 'read_pages').length /
        Math.max(1, candidates.length);
      if (lectureRatio > 0.5) {
        // Too many lectures, reduce them
        candidates = candidates.filter((c) => {
          if (c.task_type === 'study_topic' || c.task_type === 'read_pages') {
            return Math.random() > 0.4; // Keep 60% of lectures
          }
          return true;
        });
      }
    }
  }

  // Fetch topic states.
  let topicStateUrl =
    'student_topic_state?user_id=eq.' + encodeURIComponent(userId) + '&select=*';
  if (courseId) topicStateUrl += '&course_id=eq.' + encodeURIComponent(courseId);
  const tsRes = await supaRequest<TopicState[]>('GET', topicStateUrl, null, serviceKey);
  const topicStates = new Map<string, TopicState>(
    Array.isArray(tsRes.body)
      ? tsRes.body.map((t) => [t.topic_id, t])
      : []
  );

  // Group candidates by course.
  const byCourse = new Map<string, TaskCandidate[]>();
  for (const c of candidates) {
    const arr = byCourse.get(c.course_id) ?? [];
    arr.push(c);
    byCourse.set(c.course_id, arr);
  }

  // Score subjects.
  const scoredSubjects: ScoredSubject[] = [];
  for (const [cid, cands] of byCourse) {
    const state = subjectStates.get(cid) ?? null;
    const subjName =
      state?.subject_name ??
      cands[0]?.subject_name ??
      cands[0]?.course_topics?.name ??
      cid;
    const courseTopicStates = new Map<string, TopicState>(
      [...topicStates.entries()].filter(([, ts]) => ts.course_id === cid)
    );
    scoredSubjects.push({
      courseId: cid,
      subjectName: subjName,
      score: scoreSubject(state, cands),
      state,
      candidates: cands,
      topicStates: courseTopicStates,
    });
  }

  // Distribute across the week.
  const dayAllocations = distributeAcrossWeek(scoredSubjects, prefs, weekStartObj);

  // Find or create the weekly plan record.
  const planKey =
    'weekly_study_plans?user_id=eq.' +
    encodeURIComponent(userId) +
    '&week_start_date=eq.' +
    encodeURIComponent(weekStart) +
    '&plan_scope=eq.' +
    encodeURIComponent(scope) +
    '&' +
    (courseId
      ? 'course_id=eq.' + encodeURIComponent(courseId)
      : 'course_id=is.null') +
    '&select=*&limit=1';

  const existingPlanRes = await supaRequest<WeeklyStudyPlan[]>('GET', planKey, null, serviceKey);
  const existingPlan = Array.isArray(existingPlanRes.body) ? existingPlanRes.body[0] ?? null : null;
  const isRegen = !!existingPlan;

  let planId: string;
  if (existingPlan) {
    planId = existingPlan.id;
    // Read path: a plan already exists, so just hand it back. Rebuilding here is
    // what let concurrent reads delete + re-insert each other's tasks.
    if (!regenerateExisting) {
      return { planId, taskCount: 0, subjects: [], urgency };
    }
    // Delete only todo tasks — never touch completed/in_progress/skipped.
    await supaRequest(
      'DELETE',
      'weekly_study_tasks?plan_id=eq.' + encodeURIComponent(planId) + '&status=eq.todo',
      null,
      serviceKey
    );
    await supaRequest(
      'PATCH',
      'weekly_study_plans?id=eq.' + encodeURIComponent(planId),
      { regenerated_at: new Date().toISOString(), status: 'active' },
      serviceKey,
      { Prefer: 'return=minimal' }
    );
  } else {
    const created = await supaRequest<WeeklyStudyPlan[]>(
      'POST',
      'weekly_study_plans',
      {
        user_id: userId,
        week_start_date: weekStart,
        plan_scope: scope,
        course_id: courseId ?? null,
        status: 'active',
        generation_params: {
          daily_study_minutes: prefs.daily_study_minutes,
          study_days: prefs.study_days,
          gen_version: 'filekey-v4-noregen',
        },
      },
      serviceKey,
      { Prefer: 'return=representation' }
    );
    if (Array.isArray(created.body) && created.body[0]) {
      planId = created.body[0]!.id;
    } else {
      // The dashboard fires several daily-plan reads at once; with no plan yet
      // they all try to generate, and the unique (user, week, scope, course)
      // constraint rejects the losers with a 409. That's not an error — the
      // winner already created the plan and is filling its tasks. Re-fetch the
      // plan and return WITHOUT building tasks, so we don't double-insert into
      // the winner's plan. The next read picks up the winner's tasks.
      const raceRes = await supaRequest<WeeklyStudyPlan[]>('GET', planKey, null, serviceKey);
      const racePlan = Array.isArray(raceRes.body) ? raceRes.body[0] ?? null : null;
      if (!racePlan) throw new Error('Could not create weekly study plan');
      return { planId: racePlan.id, taskCount: 0, subjects: [], urgency };
    }
  }

  // Build task rows.
  const taskRows: Record<string, unknown>[] = [];
  const subjectsSeen = new Set<string>();
  let globalDayOrder = 0;
  // One candidate = one task across the whole week. distributeAcrossWeek hands the
  // same candidate list to every day, so without this each candidate would be
  // re-scheduled daily. Keyed per subject so two subjects never collide.
  const scheduledByCourse = new Map<string, Set<string>>();

  for (const dayAlloc of dayAllocations) {
    let dayOrder = 0;
    for (const alloc of dayAlloc.allocations) {
      subjectsSeen.add(alloc.courseId);
      let scheduled = scheduledByCourse.get(alloc.courseId);
      if (!scheduled) {
        scheduled = new Set<string>();
        scheduledByCourse.set(alloc.courseId, scheduled);
      }
      const tasks = sequenceTasksForSubject(
        alloc.candidates,
        alloc.topicStates,
        alloc.minutesAllocated,
        scheduled
      );

      for (const t of tasks) {
        const c = t.candidate;
        taskRows.push({
          plan_id: planId,
          user_id: userId,
          plan_date: dayAlloc.date,
          day_order: dayOrder++,
          course_id: alloc.courseId,
          subject_name: alloc.subjectName,
          topic_id: c.topic_id ?? null,
          source_file_id: c.source_file_id ?? null,
          exercise_file_id: c.exercise_file_id ?? null,
          task_type: c.task_type,
          task_title: c.task_title || buildTaskTitle(c),
          task_description: c.task_description ?? buildTaskDescription(c),
          estimated_minutes: t.estimatedMinutes,
          priority_score: t.priorityScore,
          study_state_required: c.study_state_required ?? 'not_started',
          exercise_available: c.exercise_available ?? false,
          page_range: c.page_range ?? null,
          status: 'todo',
          source_confidence: c.source_confidence,
          is_valid: true,
        });
        globalDayOrder++;
      }
    }
  }

  // Insert tasks in batches of 50.
  for (let i = 0; i < taskRows.length; i += 50) {
    const batch = taskRows.slice(i, i + 50);
    await supaRequest('POST', 'weekly_study_tasks', batch, serviceKey, {
      Prefer: 'return=minimal',
    });
  }

  // Write study event.
  await writeStudyEvent(serviceKey, {
    user_id: userId,
    course_id: courseId ?? null,
    event_type: isRegen ? 'plan_regenerated' : 'plan_generated',
    metadata: {
      weekStart,
      scope,
      taskCount: taskRows.length,
      subjects: [...subjectsSeen],
    },
  });

  return {
    planId,
    taskCount: taskRows.length,
    subjects: [...subjectsSeen],
    urgency,
    source: 'deterministic',
    aiError,
  };
}

// ── F. Daily task slice ───────────────────────────────────────────────────────

export interface DailyTasksResult {
  planId: string;
  tasks: WeeklyStudyTask[];
  possibleMatches: PossibleMatch[];
  unmappedFiles: UnmappedFile[];
}

export async function getDailyTasks(
  userId: string,
  date: Date,
  serviceKey: string,
  courseId?: string
): Promise<WeeklyStudyTask[]> {
  return (await getDailyTasksWithPlan(userId, date, serviceKey, courseId)).tasks;
}

export async function getDailyTasksWithPlan(
  userId: string,
  date: Date,
  serviceKey: string,
  courseId?: string
): Promise<DailyTasksResult> {
  const dateStr = dateToString(date);
  const weekStart = dateToString(getWeekStart(date));

  // Find the active plan for this week.
  let planUrl =
    'weekly_study_plans?user_id=eq.' +
    encodeURIComponent(userId) +
    '&week_start_date=eq.' +
    encodeURIComponent(weekStart) +
    '&status=eq.active&select=id,possible_matches,generation_params&limit=1';
  if (courseId) planUrl += '&course_id=eq.' + encodeURIComponent(courseId);
  else planUrl += '&course_id=is.null';

  const planRes = await supaRequest<
    { id: string; possible_matches: unknown; generation_params: unknown }[]
  >('GET', planUrl, null, serviceKey);
  const planRow = Array.isArray(planRes.body) ? planRes.body[0] ?? null : null;
  let planId: string | null = planRow?.id ?? null;
  let possibleMatches: PossibleMatch[] = validatePossibleMatches(planRow?.possible_matches ?? []);
  let unmappedFiles: UnmappedFile[] = validateUnmappedFiles(
    extractUnmappedFiles(planRow?.generation_params)
  );

  if (!planId) {
    // Generate a new plan on the fly. regenerateExisting=false: if a concurrent
    // read already created the plan, reuse it rather than rebuilding (which
    // would race and stack duplicate tasks).
    const scope: PlanScope = courseId ? 'course_week' : 'global_week';
    const result = await generateWeeklyPlan(
      userId,
      date,
      scope,
      courseId ?? null,
      serviceKey,
      false
    );
    planId = result.planId;
    // Fetch possible_matches + unmapped-files for the newly generated plan.
    try {
      const newPlanRes = await supaRequest<
        { possible_matches: unknown; generation_params: unknown }[]
      >(
        'GET',
        'weekly_study_plans?id=eq.' + encodeURIComponent(planId) +
          '&select=possible_matches,generation_params&limit=1',
        null,
        serviceKey
      );
      const newPlanRow = Array.isArray(newPlanRes.body) ? newPlanRes.body[0] ?? null : null;
      possibleMatches = validatePossibleMatches(newPlanRow?.possible_matches ?? []);
      unmappedFiles = validateUnmappedFiles(extractUnmappedFiles(newPlanRow?.generation_params));
    } catch {
      possibleMatches = [];
      unmappedFiles = [];
    }
  }

  // Return tasks for the specific date.
  const taskUrl =
    'weekly_study_tasks?plan_id=eq.' +
    encodeURIComponent(planId) +
    '&plan_date=eq.' +
    encodeURIComponent(dateStr) +
    '&order=day_order.asc' +
    '&select=*';

  const taskRes = await supaRequest<WeeklyStudyTask[]>('GET', taskUrl, null, serviceKey);
  const tasks = Array.isArray(taskRes.body) ? taskRes.body : [];
  await enrichTasksWithFileNames(tasks, serviceKey);

  // Hide suggestions the user already decided on. The decision is durable
  // (student_exercise_pairings), so even if a regeneration repopulated
  // possible_matches, a previously confirmed/dismissed pair never reappears.
  possibleMatches = await filterDecidedMatches(userId, possibleMatches, serviceKey);

  return { planId, tasks, possibleMatches, unmappedFiles };
}

// Pull the unmapped-files report out of a plan's generation_params JSONB blob.
function extractUnmappedFiles(generationParams: unknown): unknown {
  if (generationParams == null || typeof generationParams !== 'object') return [];
  const uf = (generationParams as Record<string, unknown>).unmapped_files;
  return Array.isArray(uf) ? uf : [];
}

// Drop possible-match suggestions whose (exercise, lecture) pair already has a
// confirmed/dismissed decision recorded.
async function filterDecidedMatches(
  userId: string,
  matches: PossibleMatch[],
  serviceKey: string
): Promise<PossibleMatch[]> {
  if (!matches.length) return matches;
  const res = await supaRequest<Array<{ exercise_file_id: string; lecture_file_id: string }>>(
    'GET',
    'student_exercise_pairings?user_id=eq.' + encodeURIComponent(userId) +
      '&select=exercise_file_id,lecture_file_id',
    null,
    serviceKey
  );
  const decided = new Set(
    (Array.isArray(res.body) ? res.body : []).map((r) => r.exercise_file_id + '|' + r.lecture_file_id)
  );
  if (!decided.size) return matches;
  return matches.filter((m) => !decided.has(m.exerciseFileId + '|' + m.possibleLectureFileId));
}

// Attach real document file names to tasks and reconcile against deletes/renames.
// - If a referenced source/exercise file no longer resolves in `documents`, the
//   task is flagged unavailable (id trusted over name; the file is truly gone).
// - If the file still exists, its current name is attached for display, so a
//   renamed file shows its new name without invalidating the task.
async function enrichTasksWithFileNames(
  tasks: WeeklyStudyTask[],
  serviceKey: string
): Promise<void> {
  if (!tasks.length) return;
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.source_file_id) ids.add(t.source_file_id);
    if (t.exercise_file_id) ids.add(t.exercise_file_id);
  }
  if (!ids.size) return;

  const idList = [...ids].slice(0, 200);
  const docRes = await supaRequest<{ id: string; file_name: string | null }[]>(
    'GET',
    'documents?id=in.(' + idList.map(encodeURIComponent).join(',') + ')&select=id,file_name',
    null,
    serviceKey
  );
  const nameById = new Map<string, string | null>(
    Array.isArray(docRes.body) ? docRes.body.map((d) => [d.id, d.file_name]) : []
  );

  for (const t of tasks) {
    if (t.source_file_id) {
      if (nameById.has(t.source_file_id)) t.source_file_name = nameById.get(t.source_file_id) ?? null;
      else if (t.status !== 'completed') {
        t.status = 'unavailable' as TaskStatus;
        t.is_valid = false;
        t.invalidation_reason = t.invalidation_reason || 'source_file_deleted';
      }
    }
    if (t.exercise_file_id) {
      if (nameById.has(t.exercise_file_id)) t.exercise_file_name = nameById.get(t.exercise_file_id) ?? null;
    }
  }
}

// ── G. Candidate seeding ──────────────────────────────────────────────────────

interface TopicSeedRow {
  id: string;
  importance: string;
  source_document_ids: string[] | null;
  name: string | null;
}

interface DocSeedRow {
  id: string;
  source_type: string | null;
  file_name: string | null;
}

function sourceTypeToNewTaskType(sourceType: string | null | undefined): string {
  if (sourceType === 'lecture') return 'study_topic';
  if (sourceType === 'exercise') return 'solve_exercise_sheet';
  // Solution sheets are NOT exercises — you check your work against them.
  if (sourceType === 'solution') return 'check_solution_sheet';
  if (sourceType === 'exam') return 'exam_style_practice';
  return 'review_topic';
}

function studyStateRequired(taskType: string): string {
  if (taskType === 'solve_exercise_sheet' || taskType === 'practice_problem_set') return 'studied';
  if (taskType === 'check_solution_sheet' || taskType === 'review_completed_exercise') return 'studied';
  if (taskType === 'exam_style_practice' || taskType === 'pre_exam_review') return 'practiced';
  return 'not_started';
}

function estimatedMinutesForType(taskType: string): number {
  if (taskType === 'study_topic' || taskType === 'read_pages') return 30;
  if (taskType === 'solve_exercise_sheet' || taskType === 'practice_problem_set') return 25;
  if (taskType === 'check_solution_sheet' || taskType === 'review_completed_exercise') return 15;
  if (taskType === 'exam_style_practice' || taskType === 'pre_exam_review') return 20;
  return 20;
}

function buildTaskTitle(c: TaskCandidate): string {
  const topicName = c.course_topics?.name ?? 'Topic';
  const fileName = c.documents?.file_name ?? '';
  switch (c.task_type) {
    case 'study_topic':
    case 'read_pages':
      return `Study: ${topicName}`;
    case 'solve_exercise_sheet':
    case 'practice_problem_set':
      return `Practice: ${topicName}${fileName ? ' (' + fileName + ')' : ''}`;
    case 'generate_quiz_if_no_exercises':
      return `Quiz: ${topicName}`;
    case 'review_weak_topic':
    case 'review_topic':
      return `Review: ${topicName}`;
    case 'exam_style_practice':
      return `Exam drill: ${topicName}`;
    default:
      return `Study: ${topicName}`;
  }
}

function buildTaskDescription(c: TaskCandidate): string {
  const fileName = c.documents?.file_name ?? 'course source';
  const pageStr = c.page_range ? `, ${c.page_range}` : '';
  switch (c.task_type) {
    case 'study_topic':
    case 'read_pages':
      return `Read through ${fileName}${pageStr}.`;
    case 'solve_exercise_sheet':
    case 'practice_problem_set':
      return `Work through the exercises in ${fileName}${pageStr}.`;
    case 'generate_quiz_if_no_exercises':
      return `Test yourself using a generated quiz for this topic.`;
    case 'review_weak_topic':
      return `Review and re-consolidate ${fileName}${pageStr}.`;
    case 'exam_style_practice':
      return `Practise exam-style questions from ${fileName}${pageStr}.`;
    default:
      return `Use ${fileName}${pageStr}.`;
  }
}

/** Extract a numeric suffix from a filename, e.g. "Lec8.pdf" → 8. */
function fileNumericSuffix(fileName: string): number | null {
  const m = fileName.replace(/\.[^.]+$/, '').match(/(\d+)$/);
  return m ? parseInt(m[1]!, 10) : null;
}

// source_type at upload is client-supplied and defaults to 'lecture', so
// untagged solution/exercise sheets arrive mislabeled. We never rewrite the
// stored value (see "no post-upload reindex"), but the planner infers a better
// type from the filename so a solution sheet isn't scheduled as a "Study" task.
// Only an explicit, default-y 'lecture'/empty value is overridden — a deliberate
// 'exercise'/'solution'/'exam' tag is always trusted.
function effectiveSourceType(stored: string | null | undefined, fileName: string | null | undefined): string {
  const trusted = stored && stored !== 'lecture' ? stored : null;
  if (trusted) return trusted;
  const n = (fileName ?? '').toLowerCase();
  // Solutions first: "..._Sol", "Solutions", "Loesung"/"Lösung", "_LSG".
  if (/(\bsol\b|sol\.|_sol|solution|lösung|loesung|musterl|\blsg\b)/.test(n)) return 'solution';
  if (/(exercise|aufgabe|übung|uebung|tutorial|problem|\bex\d|_ex\b|_ex\d)/.test(n)) return 'exercise';
  if (/(exam|klausur|prüfung|pruefung|midterm|final)/.test(n)) return 'exam';
  return stored || 'lecture';
}

export async function seedCandidatesFromTopics(
  userId: string,
  courseId: string,
  serviceKey: string
): Promise<number> {
  const topicsRes = await supaRequest<TopicSeedRow[]>(
    'GET',
    'course_topics?user_id=eq.' +
      encodeURIComponent(userId) +
      '&course_id=eq.' +
      encodeURIComponent(courseId) +
      '&select=id,importance,source_document_ids,name' +
      '&limit=100',
    null,
    serviceKey
  );
  const topics = Array.isArray(topicsRes.body) ? topicsRes.body : [];
  if (!topics.length) return 0;

  const allDocIds = new Set<string>();
  for (const t of topics) {
    const ids = Array.isArray(t.source_document_ids) ? t.source_document_ids : [];
    for (const id of ids) if (id) allDocIds.add(id);
  }
  if (!allDocIds.size) return 0;

  const docIdList = [...allDocIds].slice(0, 100);
  const docRes = await supaRequest<DocSeedRow[]>(
    'GET',
    'documents?id=in.(' +
      docIdList.map(encodeURIComponent).join(',') +
      ')' +
      '&processing_status=eq.ready' +
      '&select=id,source_type,file_name' +
      '&limit=100',
    null,
    serviceKey
  );
  const readyDocs = new Map<string, DocSeedRow>(
    Array.isArray(docRes.body) ? docRes.body.map((d) => [d.id, d]) : []
  );
  if (!readyDocs.size) return 0;

  // Build a map: numericSuffix → exercise doc id, for pairing a lecture with
  // its exercise sheet. Solution sheets are NOT exercises and must never be
  // paired here, or a lecture would link to a solution instead of a problem set.
  const exerciseByNum = new Map<number, string>();
  for (const [docId, doc] of readyDocs) {
    if (effectiveSourceType(doc.source_type, doc.file_name) === 'exercise' && doc.file_name) {
      const n = fileNumericSuffix(doc.file_name);
      if (n !== null) exerciseByNum.set(n, docId);
    }
  }

  // Delete stale auto-seeded candidates.
  await supaRequest(
    'DELETE',
    'valid_task_candidates?user_id=eq.' +
      encodeURIComponent(userId) +
      '&course_id=eq.' +
      encodeURIComponent(courseId) +
      '&candidate_reason=eq.auto_seeded_from_topic_map',
    null,
    serviceKey
  );

  const rows: Record<string, unknown>[] = [];

  for (const topic of topics) {
    const docIds = Array.isArray(topic.source_document_ids) ? topic.source_document_ids : [];
    for (const docId of docIds) {
      const doc = readyDocs.get(docId);
      if (!doc) continue;

      const srcType = effectiveSourceType(doc.source_type, doc.file_name);
      const taskType = sourceTypeToNewTaskType(srcType);
      const minutes = estimatedMinutesForType(taskType);
      const reqState = studyStateRequired(taskType);
      // Only true exercise sheets are "exercises". Solutions are checked, not solved.
      const isExercise = srcType === 'exercise';

      // Detect exercise pairing for lecture candidates.
      let exerciseFileId: string | null = null;
      if (srcType === 'lecture' && doc.file_name) {
        const n = fileNumericSuffix(doc.file_name);
        if (n !== null && exerciseByNum.has(n)) {
          exerciseFileId = exerciseByNum.get(n)!;
        }
      }

      const title = taskTitleFromSourceType(srcType, topic.name ?? 'Topic', doc.file_name ?? '');

      rows.push({
        user_id: userId,
        course_id: courseId,
        topic_id: topic.id,
        task_type: taskType,
        task_title: title,
        source_file_id: docId,
        exercise_file_id: exerciseFileId,
        estimated_minutes: minutes,
        source_confidence: 'high',
        is_valid: true,
        study_state_required: reqState,
        exercise_available: isExercise,
        candidate_reason: 'auto_seeded_from_topic_map',
      });
    }
  }

  if (!rows.length) return 0;

  await supaRequest('POST', 'valid_task_candidates', rows, serviceKey, {
    Prefer: 'return=minimal,resolution=ignore-duplicates',
  });
  return rows.length;
}

function taskTitleFromSourceType(
  sourceType: string | null | undefined,
  topicName: string,
  fileName: string
): string {
  if (sourceType === 'lecture') return `Study: ${topicName}`;
  if (sourceType === 'exercise')
    return `Practice: ${topicName}${fileName ? ' (' + fileName + ')' : ''}`;
  if (sourceType === 'solution')
    return `Check solutions: ${topicName}${fileName ? ' (' + fileName + ')' : ''}`;
  if (sourceType === 'exam') return `Exam drill: ${topicName}`;
  return `Review: ${topicName}`;
}

// ── Legacy response helpers (kept for backward-compat with existing routes) ──

export function studyPlanResponse(data: {
  plan: null;
  tasks: WeeklyStudyTask[];
  noValidCandidates?: boolean;
}): LambdaResponse {
  const completed = data.tasks.filter((t) => t.status === 'completed').length;
  const remaining = data.tasks
    .filter((t) => !['completed', 'replaced'].includes(t.status))
    .reduce((s, t) => s + (t.estimated_minutes || 0), 0);
  return jsonResponse(200, {
    hasPlan: !!data.plan,
    plan: data.plan,
    tasks: data.tasks,
    summary: {
      completedTasks: completed,
      totalTasks: data.tasks.length,
      minutesRemaining: remaining,
      status: 'active',
      noValidCandidates: !!data.noValidCandidates,
    },
  });
}
