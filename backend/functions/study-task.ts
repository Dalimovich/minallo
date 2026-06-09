// PATCH /api/study/tasks/:id
// Updates the status of a weekly_study_tasks row with validated transitions.

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { bodyJson, buildCanonicalTaskKey, requireStudyAuth, writeStudyEvent } from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

// Allowed status transitions.
const VALID_TRANSITIONS: Record<string, string[]> = {
  todo: ['in_progress', 'completed', 'skipped', 'moved'],
  in_progress: ['completed', 'skipped', 'moved'],
  completed: ['todo'], // undo only
  skipped: ['todo', 'in_progress'],
  moved: ['todo'],
};

// Task types eligible for spaced-repetition scheduling.
const LEARNING_TASK_TYPES = new Set([
  'study_lecture',
  'continue_lecture',
  'repeat_lecture',
  'study_topic',
  'read_pages',
  'review_weak_topic',
  'pre_exam_review',
]);

// Stage → interval in days. Max stage = 3; no 4th repetition.
const REPETITION_INTERVALS: Record<number, number> = {
  1: 2,
  2: 7,
  3: 16,
};

/** Add `days` calendar days to a UTC date string (YYYY-MM-DD). */
function addDaysToDateString(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Strip leading 'Study:' / 'Repeat:' / 'Continue:' prefixes for clean titles. */
function stripRepetitionPrefix(title: string): string {
  return title.replace(/^(Study|Repeat|Continue):\s*/i, '').trim();
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'PATCH') return fail(405, 'Method not allowed');

  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;
  const body = bodyJson(event);
  if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
  const data = body as Record<string, unknown>;
  const taskId = taskIdFromPath(event.path);
  if (!taskId) return fail(400, 'Task id is required');

  const newStatus = typeof data.status === 'string' ? data.status : '';
  if (!newStatus) return fail(400, 'status is required');

  // Fetch current task — widen select to include all fields needed for SR.
  const currentRes = await supaRequest<
    Array<{
      id: string;
      user_id: string;
      plan_id: string;
      course_id: string;
      subject_name: string | null;
      topic_id: string | null;
      source_file_id: string | null;
      exercise_file_id: string | null;
      solution_file_id: string | null;
      related_lecture_file_id: string | null;
      lecture_topics: string[] | null;
      task_type: string;
      task_title: string | null;
      estimated_minutes: number | null;
      source_confidence: string | null;
      page_range: string | null;
      repetition_stage: number | null;
      repetition_origin_task_id: string | null;
      status: string;
    }>
  >(
    'GET',
    'weekly_study_tasks?id=eq.' +
      encodeURIComponent(taskId) +
      '&user_id=eq.' +
      encodeURIComponent(auth.user.id) +
      '&select=id,user_id,plan_id,course_id,subject_name,topic_id,source_file_id,exercise_file_id,solution_file_id,related_lecture_file_id,lecture_topics,task_type,task_title,estimated_minutes,source_confidence,page_range,repetition_stage,repetition_origin_task_id,status&limit=1',
    null,
    auth.serviceKey
  );
  const current = Array.isArray(currentRes.body) ? currentRes.body[0] ?? null : null;
  if (!current) return fail(404, 'Task not found');

  // Validate transition.
  const allowed = VALID_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(newStatus)) {
    return fail(
      409,
      `Cannot transition task from '${current.status}' to '${newStatus}'`
    );
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: newStatus,
    status_changed_at: now,
    updated_at: now,
  };
  if (newStatus === 'moved' && typeof data.movedToDate === 'string') {
    patch['plan_date'] = data.movedToDate;
  }

  const updated = await supaRequest(
    'PATCH',
    'weekly_study_tasks?id=eq.' +
      encodeURIComponent(taskId) +
      '&user_id=eq.' +
      encodeURIComponent(auth.user.id),
    patch,
    auth.serviceKey,
    { Prefer: 'return=representation' }
  );

  await writeStudyEvent(auth.serviceKey, {
    user_id: auth.user.id,
    course_id: current.course_id,
    topic_id: current.topic_id,
    task_id: taskId,
    event_type: 'task_' + newStatus,
    metadata: { previousStatus: current.status },
  });

  // Update topic state when a study task is completed.
  if (newStatus === 'completed' && current.topic_id) {
    await supaRequest(
      'POST',
      'student_topic_state',
      {
        user_id: auth.user.id,
        course_id: current.course_id,
        topic_id: current.topic_id,
        progress_state: 'studied',
        last_studied_at: now,
        study_sessions: 1,
      },
      auth.serviceKey,
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    ).catch(() => undefined);
  }

  // Spaced-repetition scheduling on completion of learning tasks.
  if (newStatus === 'completed' && LEARNING_TASK_TYPES.has(current.task_type)) {
    scheduleRepetition(auth.serviceKey, auth.user.id, current).catch((err) => {
      console.error('[study-task] SR scheduling failed (non-fatal):', err);
    });
  }

  return jsonResponse(200, {
    task: Array.isArray(updated.body) ? updated.body[0] ?? null : null,
  });
};

/** Best-effort: schedule the next spaced-repetition review task. */
async function scheduleRepetition(
  serviceKey: string,
  userId: string,
  current: {
    id: string;
    plan_id: string;
    course_id: string;
    subject_name: string | null;
    topic_id: string | null;
    source_file_id: string | null;
    exercise_file_id: string | null;
    solution_file_id: string | null;
    related_lecture_file_id: string | null;
    lecture_topics: string[] | null;
    task_type: string;
    task_title: string | null;
    estimated_minutes: number | null;
    source_confidence: string | null;
    page_range: string | null;
    repetition_stage: number | null;
    repetition_origin_task_id: string | null;
  }
): Promise<void> {
  const nextStage = (current.repetition_stage ?? 0) + 1;

  // Stop after stage 3.
  if (nextStage > 3) return;

  const intervalDays = REPETITION_INTERVALS[nextStage];
  if (intervalDays === undefined) return;

  const todayUtc = new Date().toISOString().slice(0, 10);
  const futureDate = addDaysToDateString(todayUtc, intervalDays);

  // Resolve the origin task id: reuse chain origin if already a repetition.
  const originTaskId = current.repetition_origin_task_id ?? current.id;

  // Fetch the plan's plan_scope (needed for canonical key).
  const planRes = await supaRequest<Array<{ plan_scope: string }>>(
    'GET',
    'weekly_study_plans?id=eq.' +
      encodeURIComponent(current.plan_id) +
      '&select=plan_scope&limit=1',
    null,
    serviceKey
  );
  const planScope =
    Array.isArray(planRes.body) && planRes.body[0]
      ? planRes.body[0].plan_scope
      : 'global_week';

  const lectureTopics: string[] = Array.isArray(current.lecture_topics)
    ? current.lecture_topics
    : [];

  const canonicalKey = buildCanonicalTaskKey(
    planScope,
    futureDate,
    current.course_id,
    'repeat_lecture',
    current.source_file_id ?? '',
    '',
    '',
    lectureTopics,
    current.page_range ?? '',
    String(nextStage)
  );

  const baseTitle = stripRepetitionPrefix(current.task_title ?? '');
  const taskTitle = 'Repeat: ' + (baseTitle || current.course_id);

  const newTask: Record<string, unknown> = {
    plan_id: current.plan_id,
    user_id: userId,
    plan_date: futureDate,
    day_order: 0,
    course_id: current.course_id,
    subject_name: current.subject_name ?? null,
    topic_id: current.topic_id ?? null,
    source_file_id: current.source_file_id ?? null,
    exercise_file_id: null,
    solution_file_id: null,
    related_lecture_file_id: current.related_lecture_file_id ?? null,
    lecture_topics: lectureTopics,
    task_type: 'repeat_lecture',
    task_title: taskTitle,
    task_description: 'Spaced repetition to lock in what you studied.',
    reason: 'Spaced repetition to lock in what you studied.',
    estimated_minutes: Math.min(20, current.estimated_minutes ?? 20),
    priority_score: 0.5,
    source_confidence: current.source_confidence ?? 'high',
    page_range: current.page_range ?? null,
    repetition_stage: nextStage,
    repetition_origin_task_id: originTaskId,
    canonical_task_key: canonicalKey,
    status: 'todo',
    is_valid: true,
  };

  await supaRequest(
    'POST',
    'weekly_study_tasks',
    newTask,
    serviceKey,
    { Prefer: 'resolution=ignore-duplicates,return=minimal' }
  );

  await writeStudyEvent(serviceKey, {
    user_id: userId,
    course_id: current.course_id,
    topic_id: current.topic_id,
    task_id: current.id,
    event_type: 'repetition_scheduled',
    metadata: { stage: nextStage, dueDate: futureDate, originTaskId },
  }).catch((err) => {
    console.error('[study-task] Failed to write repetition_scheduled event:', err);
  });
}

function taskIdFromPath(path: string | undefined): string | null {
  const match = String(path || '').match(/\/api\/study\/tasks\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}
