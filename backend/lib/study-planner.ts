import { requireEnv } from './env';
import { fail, jsonResponse } from './responses';
import { supaRequest } from './supabase-admin';
import { extractBearerToken, verifySupabaseToken } from './supabase-auth';
import { isSafeCourseId } from './validation';
import type { LambdaResponse, NetlifyEvent, SupabaseUser } from './types';

type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'skipped' | 'moved' | 'unavailable' | 'replaced';

interface StudyAuth {
  user: SupabaseUser;
  serviceKey: string;
}

interface CandidateRow {
  id: string;
  course_id: string;
  topic_id: string;
  task_type: string;
  source_file_id: string;
  page_start: number | null;
  page_end: number | null;
  estimated_minutes: number;
  candidate_reason: string | null;
  course_topics?: { name?: string; importance?: string } | null;
  documents?: { file_name?: string; processing_status?: string } | null;
}

interface TopicStateRow {
  topic_id: string;
  state: string;
}

const STATE_RANK: Record<string, number> = {
  weak: 0,
  not_started: 1,
  started: 2,
  reviewed: 3,
  practiced: 4,
  good: 5,
  exam_ready: 6
};

const IMPORTANCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

// Learn first, then review, then reinforce — keeps study before quiz in every plan
const TASK_TYPE_RANK: Record<string, number> = {
  learn: 0, review: 1, practice: 2, quiz: 3, flashcards: 4, deeplearn: 5, examforge: 6
};

interface PlanRow {
  id: string;
  user_id: string;
  plan_date: string;
  user_timezone: string;
  plan_scope: string;
  course_id: string;
  status: string;
  generation_status: string;
  total_estimated_minutes: number;
  generated_reason?: string | null;
}

interface TaskRow {
  id: string;
  daily_plan_id: string;
  user_id: string;
  course_id: string;
  topic_id?: string | null;
  valid_task_candidate_id?: string | null;
  source_file_id?: string | null;
  status: TaskStatus;
  estimated_minutes: number;
  priority_group: string;
  title: string;
  order_index: number;
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

export function localPlanDate(inputDate: unknown, timezone: unknown): { planDate: string; userTimezone: string } {
  const userTimezone = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC';
  if (typeof inputDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inputDate)) {
    return { planDate: inputDate, userTimezone };
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: userTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value || '1970';
    const m = parts.find((p) => p.type === 'month')?.value || '01';
    const d = parts.find((p) => p.type === 'day')?.value || '01';
    return { planDate: y + '-' + m + '-' + d, userTimezone };
  } catch {
    return { planDate: new Date().toISOString().slice(0, 10), userTimezone: 'UTC' };
  }
}

export async function fetchPlanWithTasks(
  serviceKey: string,
  userId: string,
  courseId: string,
  planDate: string
): Promise<{ plan: PlanRow | null; tasks: TaskRow[] }> {
  const planRes = await supaRequest<PlanRow[]>(
    'GET',
    'daily_study_plans?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&plan_scope=eq.course' +
      '&plan_date=eq.' + encodeURIComponent(planDate) +
      '&select=*' +
      '&limit=1',
    null,
    serviceKey
  );
  const plan = Array.isArray(planRes.body) ? planRes.body[0] || null : null;
  if (!plan) return { plan: null, tasks: [] };
  const taskRes = await supaRequest<TaskRow[]>(
    'GET',
    'daily_study_tasks?daily_plan_id=eq.' + encodeURIComponent(plan.id) +
      '&select=*' +
      '&order=order_index.asc',
    null,
    serviceKey
  );
  return { plan, tasks: Array.isArray(taskRes.body) ? taskRes.body : [] };
}

export async function ensurePlan(
  serviceKey: string,
  userId: string,
  courseId: string,
  planDate: string,
  userTimezone: string
): Promise<PlanRow> {
  const existing = await fetchPlanWithTasks(serviceKey, userId, courseId, planDate);
  if (existing.plan) return existing.plan;
  const created = await supaRequest<PlanRow[]>(
    'POST',
    'daily_study_plans',
    {
      user_id: userId,
      course_id: courseId,
      plan_scope: 'course',
      plan_date: planDate,
      user_timezone: userTimezone,
      generation_status: 'generating',
      generation_attempts: 1
    },
    serviceKey,
    { Prefer: 'return=representation' }
  );
  if (!Array.isArray(created.body) || !created.body[0]) {
    throw new Error('Could not create daily study plan');
  }
  return created.body[0];
}

export async function generateDailyPlan(
  serviceKey: string,
  userId: string,
  courseId: string,
  planDate: string,
  userTimezone: string,
  availableMinutes?: number,
  regenerate?: boolean
): Promise<{ plan: PlanRow | null; tasks: TaskRow[]; setupRequired?: boolean; noValidCandidates?: boolean }> {
  const existing = await fetchPlanWithTasks(serviceKey, userId, courseId, planDate);
  if (existing.plan && existing.tasks.length && !regenerate) return existing;

  const plan = existing.plan || await ensurePlan(serviceKey, userId, courseId, planDate, userTimezone);
  const prefsMinutes = Number.isFinite(availableMinutes) && availableMinutes && availableMinutes > 0
    ? Math.min(180, Math.max(15, Math.round(availableMinutes)))
    : 45;

  const [candidatesRes, statesRes] = await Promise.all([
    supaRequest<CandidateRow[]>(
      'GET',
      'valid_task_candidates?user_id=eq.' + encodeURIComponent(userId) +
        '&course_id=eq.' + encodeURIComponent(courseId) +
        '&is_valid=eq.true' +
        '&source_confidence=in.(high,confirmed)' +
        '&select=*,course_topics(name,importance),documents(file_name,processing_status)' +
        '&order=created_at.asc' +
        '&limit=40',
      null,
      serviceKey
    ),
    supaRequest<TopicStateRow[]>(
      'GET',
      'student_topic_state?user_id=eq.' + encodeURIComponent(userId) +
        '&course_id=eq.' + encodeURIComponent(courseId) +
        '&select=topic_id,state',
      null,
      serviceKey
    )
  ]);
  let candidates = Array.isArray(candidatesRes.body)
    ? candidatesRes.body.filter((c) => c.documents?.processing_status === 'ready')
    : [];

  // Auto-seed valid_task_candidates from course_topics. Runs when the table is
  // empty OR when no learn/practice tasks exist (handles first run and migration
  // from the old review-only seeding — seedCandidatesFromTopics deletes stale
  // auto-seeded rows first so the re-seed always uses the latest source_type logic).
  const needsSeed = !candidates.length ||
    !candidates.some((c) => c.task_type === 'learn' || c.task_type === 'practice');
  if (needsSeed) {
    const seeded = await seedCandidatesFromTopics(serviceKey, userId, courseId);
    if (seeded > 0) {
      const refetchRes = await supaRequest<CandidateRow[]>(
        'GET',
        'valid_task_candidates?user_id=eq.' + encodeURIComponent(userId) +
          '&course_id=eq.' + encodeURIComponent(courseId) +
          '&is_valid=eq.true' +
          '&source_confidence=in.(high,confirmed)' +
          '&select=*,course_topics(name,importance),documents(file_name,processing_status)' +
          '&order=created_at.asc' +
          '&limit=40',
        null,
        serviceKey
      );
      candidates = Array.isArray(refetchRes.body)
        ? refetchRes.body.filter((c) => c.documents?.processing_status === 'ready')
        : [];
    }
  }
  const candidateIds = new Set(candidates.map((c) => c.id));
  const stateByTopic = new Map<string, string>();
  if (Array.isArray(statesRes.body)) {
    for (const row of statesRes.body) stateByTopic.set(row.topic_id, row.state);
  }

  // Idempotent regeneration: never delete or reset completed tasks; mark
  // unfinished tasks whose candidate is gone/invalid as replaced or unavailable,
  // then top up remaining time budget with fresh candidates.
  let keptMinutes = 0;
  let nextOrder = 1;
  const usedCandidateIds = new Set<string>();
  if (regenerate && existing.plan && existing.tasks.length) {
    for (const task of existing.tasks) {
      if (task.status === 'completed' || task.status === 'in_progress') {
        keptMinutes += task.estimated_minutes || 0;
        if (task.valid_task_candidate_id) usedCandidateIds.add(task.valid_task_candidate_id);
        nextOrder = Math.max(nextOrder, task.order_index + 1);
        continue;
      }
      if (task.status === 'todo' || task.status === 'skipped') {
        const candidateId = task.valid_task_candidate_id || null;
        const candidateStillValid = !!candidateId && candidateIds.has(candidateId);
        const sourceGone = !!task.source_file_id && candidates.every((c) => c.source_file_id !== task.source_file_id);
        const nextStatus = sourceGone ? 'unavailable' : (candidateStillValid ? null : 'replaced');
        if (nextStatus) {
          await supaRequest(
            'PATCH',
            'daily_study_tasks?id=eq.' + encodeURIComponent(task.id),
            { status: nextStatus, updated_at: new Date().toISOString() },
            serviceKey,
            { Prefer: 'return=minimal' }
          );
          await writeStudyEvent(serviceKey, {
            user_id: userId,
            course_id: courseId,
            topic_id: task.topic_id || null,
            task_id: task.id,
            event_type: 'task_' + nextStatus,
            value: nextStatus,
            metadata: { reason: sourceGone ? 'source_unavailable' : 'candidate_invalidated', regenerated: true }
          });
        } else {
          keptMinutes += task.estimated_minutes || 0;
          if (candidateId) usedCandidateIds.add(candidateId);
          nextOrder = Math.max(nextOrder, task.order_index + 1);
        }
        continue;
      }
      // moved / replaced / unavailable: leave untouched
      nextOrder = Math.max(nextOrder, task.order_index + 1);
    }
  }

  const remainingMinutes = Math.max(0, prefsMinutes - keptMinutes);
  const freshCandidates = candidates.filter((c) => !usedCandidateIds.has(c.id));

  if (!freshCandidates.length && !remainingMinutes) {
    await markPlanGenerated(serviceKey, plan.id, prefsMinutes, regenerate ? 'regenerated_no_remaining_time' : 'no_valid_candidates');
    const after = await fetchPlanWithTasks(serviceKey, userId, courseId, planDate);
    return { ...after, noValidCandidates: !regenerate && !after.tasks.length };
  }

  if (!freshCandidates.length) {
    await markPlanGenerated(serviceKey, plan.id, keptMinutes, regenerate ? 'regenerated_from_existing' : 'no_valid_candidates');
    await writeStudyEvent(serviceKey, {
      user_id: userId,
      course_id: courseId,
      event_type: 'plan_generated',
      value: regenerate ? 'regenerated_from_existing' : 'no_valid_candidates',
      metadata: { planDate }
    });
    const after = await fetchPlanWithTasks(serviceKey, userId, courseId, planDate);
    return { ...after, noValidCandidates: !regenerate && !after.tasks.length };
  }

  const ranked = rankCandidates(freshCandidates, stateByTopic);
  const selected = selectCandidates(ranked, remainingMinutes || prefsMinutes);
  const startIdx = nextOrder - 1;
  const taskRows = selected.map((c, idx) => {
    const topicName = c.course_topics?.name || 'course topic';
    const fileName = c.documents?.file_name || 'course source';
    const overallIdx = startIdx + idx;
    const group = overallIdx === 0 ? 'must_do' : overallIdx < 3 ? 'should_do' : 'optional';
    return {
      daily_plan_id: plan.id,
      user_id: userId,
      course_id: courseId,
      topic_id: c.topic_id,
      valid_task_candidate_id: c.id,
      task_type: c.task_type,
      priority_group: group,
      title: taskTitle(c.task_type, topicName),
      description: taskDescription(c.task_type, fileName, pageLabel(c.page_start, c.page_end)),
      reason: templateReason(group, stateByTopic.get(c.topic_id)),
      reason_code: group === 'must_do' ? 'next_in_course_map' : 'source_grounded_candidate',
      reason_metadata: {
        sourceConfidence: 'high_or_confirmed',
        topicImportance: c.course_topics?.importance || 'medium',
        topicState: stateByTopic.get(c.topic_id) || 'not_started'
      },
      source_file_id: c.source_file_id,
      page_start: c.page_start,
      page_end: c.page_end,
      estimated_minutes: c.estimated_minutes,
      status: 'todo',
      order_index: nextOrder + idx
    };
  });
  await supaRequest(
    'POST',
    'daily_study_tasks',
    taskRows,
    serviceKey,
    { Prefer: 'return=minimal' }
  );
  const total = keptMinutes + taskRows.reduce((sum, t) => sum + t.estimated_minutes, 0);
  const reason = regenerate ? 'regenerated_from_valid_candidates' : 'generated_from_valid_candidates';
  await markPlanGenerated(serviceKey, plan.id, total, reason);
  await writeStudyEvent(serviceKey, {
    user_id: userId,
    course_id: courseId,
    event_type: regenerate ? 'plan_regenerated' : 'plan_generated',
    value: reason,
    metadata: { planDate, taskCount: taskRows.length, keptMinutes }
  });
  const fresh = await fetchPlanWithTasks(serviceKey, userId, courseId, planDate);
  return { plan: fresh.plan || plan, tasks: fresh.tasks };
}

export async function writeStudyEvent(serviceKey: string, row: Record<string, unknown>): Promise<void> {
  await supaRequest('POST', 'study_events', row, serviceKey, { Prefer: 'return=minimal' });
}

export function studyPlanResponse(data: { plan: PlanRow | null; tasks: TaskRow[]; noValidCandidates?: boolean }): LambdaResponse {
  const completed = data.tasks.filter((t) => t.status === 'completed').length;
  const remaining = data.tasks.filter((t) => !['completed', 'replaced'].includes(t.status)).reduce((s, t) => s + (t.estimated_minutes || 0), 0);
  return jsonResponse(200, {
    hasPlan: !!data.plan,
    plan: data.plan,
    tasks: data.tasks,
    summary: {
      completedTasks: completed,
      totalTasks: data.tasks.length,
      minutesRemaining: remaining,
      status: data.plan?.status || 'none',
      noValidCandidates: !!data.noValidCandidates
    }
  });
}

async function markPlanGenerated(serviceKey: string, planId: string, total: number, reason: string): Promise<void> {
  await supaRequest(
    'PATCH',
    'daily_study_plans?id=eq.' + encodeURIComponent(planId),
    {
      generation_status: 'completed',
      total_estimated_minutes: total,
      generated_reason: reason,
      updated_at: new Date().toISOString()
    },
    serviceKey,
    { Prefer: 'return=minimal' }
  );
}

function rankCandidates(candidates: CandidateRow[], stateByTopic: Map<string, string>): CandidateRow[] {
  return [...candidates].sort((a, b) => {
    const stateA = STATE_RANK[stateByTopic.get(a.topic_id) || 'not_started'] ?? 1;
    const stateB = STATE_RANK[stateByTopic.get(b.topic_id) || 'not_started'] ?? 1;
    if (stateA !== stateB) return stateA - stateB;
    const impA = IMPORTANCE_RANK[a.course_topics?.importance || 'medium'] ?? 1;
    const impB = IMPORTANCE_RANK[b.course_topics?.importance || 'medium'] ?? 1;
    if (impA !== impB) return impA - impB;
    // Within same topic priority: study before quiz/practice
    const typeA = TASK_TYPE_RANK[a.task_type] ?? 99;
    const typeB = TASK_TYPE_RANK[b.task_type] ?? 99;
    return typeA - typeB;
  });
}

function selectCandidates(candidates: CandidateRow[], minutes: number): CandidateRow[] {
  const maxTasks = minutes <= 15 ? 1 : minutes <= 30 ? 2 : minutes <= 60 ? 3 : 5;
  const seen = new Set<string>();
  const out: CandidateRow[] = [];
  let used = 0;
  for (const c of candidates) {
    const key = [c.topic_id, c.source_file_id, c.task_type].join(':');
    if (seen.has(key)) continue;
    const cost = Math.max(10, Math.min(45, c.estimated_minutes || 20));
    if (out.length && used + cost > minutes) continue;
    seen.add(key);
    out.push({ ...c, estimated_minutes: cost });
    used += cost;
    if (out.length >= maxTasks) break;
  }
  return out.length ? out : candidates.slice(0, 1);
}

function taskTitle(taskType: string, topicName: string): string {
  if (taskType === 'learn') return 'Study: ' + topicName;
  if (taskType === 'review') return 'Review: ' + topicName;
  if (taskType === 'practice') return 'Practice: ' + topicName + ' (exercises)';
  if (taskType === 'quiz') return 'Quiz: ' + topicName;
  if (taskType === 'flashcards') return 'Flashcards: ' + topicName;
  if (taskType === 'deeplearn') return 'Deep Learn: ' + topicName;
  if (taskType === 'examforge') return 'ExamForge drill: ' + topicName;
  return 'Study: ' + topicName;
}

function taskDescription(taskType: string, fileName: string, pageStr: string): string {
  if (taskType === 'learn') return 'Read through ' + fileName + pageStr + '.';
  if (taskType === 'practice') return 'Work through the exercises in ' + fileName + pageStr + '.';
  if (taskType === 'quiz') return 'Test yourself using ' + fileName + pageStr + '.';
  return 'Use ' + fileName + pageStr + '.';
}

function pageLabel(start: number | null, end: number | null): string {
  if (!start) return '';
  if (!end || end === start) return ', page ' + start;
  return ', pages ' + start + '-' + end;
}

function templateReason(group: string, topicState?: string): string {
  if (group === 'must_do') {
    if (topicState === 'weak') return 'You marked this topic as weak — it is the top priority today.';
    if (topicState === 'not_started' || !topicState) return 'This is the next source-confirmed topic in your course map.';
    return 'This keeps your progress moving on a confirmed course topic.';
  }
  if (group === 'should_do') return 'This task is grounded in a confirmed course source.';
  return 'Optional extra practice if you have more time today.';
}

interface TopicSeedRow {
  id: string;
  importance: string;
  source_document_ids: string[] | null;
}

interface DocSeedRow {
  id: string;
  source_type: string | null;
}

function sourceTypeToTaskType(sourceType: string | null | undefined): string {
  if (sourceType === 'lecture') return 'learn';
  if (sourceType === 'exercise' || sourceType === 'solution') return 'practice';
  if (sourceType === 'exam') return 'quiz';
  return 'review';
}

async function seedCandidatesFromTopics(
  serviceKey: string,
  userId: string,
  courseId: string
): Promise<number> {
  const topicsRes = await supaRequest<TopicSeedRow[]>(
    'GET',
    'course_topics?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=id,importance,source_document_ids' +
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

  // Fetch ready documents with their source_type to map lecture→learn, exercise→practice
  const docIdList = [...allDocIds].slice(0, 100);
  const docRes = await supaRequest<DocSeedRow[]>(
    'GET',
    'documents?id=in.(' + docIdList.map(encodeURIComponent).join(',') + ')' +
      '&processing_status=eq.ready' +
      '&select=id,source_type' +
      '&limit=100',
    null,
    serviceKey
  );
  const readyDocs = new Map<string, string | null>(
    Array.isArray(docRes.body) ? docRes.body.map((d) => [d.id, d.source_type]) : []
  );
  if (!readyDocs.size) return 0;

  // Delete stale auto-seeded candidates so re-seeds always use the latest logic
  await supaRequest(
    'DELETE',
    'valid_task_candidates?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&candidate_reason=eq.auto_seeded_from_topic_map',
    null,
    serviceKey
  );

  const rows: Record<string, unknown>[] = [];
  for (const topic of topics) {
    const docIds = Array.isArray(topic.source_document_ids) ? topic.source_document_ids : [];
    for (const docId of docIds) {
      if (!readyDocs.has(docId)) continue;
      const sourceType = readyDocs.get(docId);
      const taskType = sourceTypeToTaskType(sourceType);
      const minutes = taskType === 'learn' ? 25 : taskType === 'practice' ? 20 : taskType === 'quiz' ? 15 : 20;
      rows.push({
        user_id: userId,
        course_id: courseId,
        topic_id: topic.id,
        task_type: taskType,
        source_file_id: docId,
        page_start: null,
        page_end: null,
        estimated_minutes: minutes,
        source_confidence: 'high',
        is_valid: true,
        candidate_reason: 'auto_seeded_from_topic_map'
      });
    }
  }
  if (!rows.length) return 0;

  await supaRequest(
    'POST',
    'valid_task_candidates',
    rows,
    serviceKey,
    { Prefer: 'return=minimal,resolution=ignore-duplicates' }
  );
  return rows.length;
}
