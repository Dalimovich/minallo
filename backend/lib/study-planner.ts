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
  availableMinutes?: number
): Promise<{ plan: PlanRow | null; tasks: TaskRow[]; setupRequired?: boolean; noValidCandidates?: boolean }> {
  const existing = await fetchPlanWithTasks(serviceKey, userId, courseId, planDate);
  if (existing.plan && existing.tasks.length) return existing;

  const plan = existing.plan || await ensurePlan(serviceKey, userId, courseId, planDate, userTimezone);
  const prefsMinutes = Number.isFinite(availableMinutes) && availableMinutes && availableMinutes > 0
    ? Math.min(180, Math.max(15, Math.round(availableMinutes)))
    : 45;

  const candidatesRes = await supaRequest<CandidateRow[]>(
    'GET',
    'valid_task_candidates?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&is_valid=eq.true' +
      '&source_confidence=in.(high,confirmed)' +
      '&select=*,course_topics(name,importance),documents(file_name,processing_status)' +
      '&order=created_at.asc' +
      '&limit=20',
    null,
    serviceKey
  );
  const candidates = Array.isArray(candidatesRes.body)
    ? candidatesRes.body.filter((c) => c.documents?.processing_status === 'ready')
    : [];

  if (!candidates.length) {
    await markPlanGenerated(serviceKey, plan.id, 0, 'no_valid_candidates');
    await writeStudyEvent(serviceKey, {
      user_id: userId,
      course_id: courseId,
      event_type: 'plan_generated',
      value: 'no_valid_candidates',
      metadata: { planDate }
    });
    const after = await fetchPlanWithTasks(serviceKey, userId, courseId, planDate);
    return { ...after, noValidCandidates: true };
  }

  const selected = selectCandidates(candidates, prefsMinutes);
  const taskRows = selected.map((c, idx) => {
    const topicName = c.course_topics?.name || 'course topic';
    const fileName = c.documents?.file_name || 'course source';
    const group = idx === 0 ? 'must_do' : idx < 3 ? 'should_do' : 'optional';
    return {
      daily_plan_id: plan.id,
      user_id: userId,
      course_id: courseId,
      topic_id: c.topic_id,
      valid_task_candidate_id: c.id,
      task_type: c.task_type,
      priority_group: group,
      title: taskTitle(c.task_type, topicName),
      description: 'Use ' + fileName + pageLabel(c.page_start, c.page_end) + '.',
      reason: templateReason(group),
      reason_code: group === 'must_do' ? 'next_in_course_map' : 'source_grounded_candidate',
      reason_metadata: {
        sourceConfidence: 'high_or_confirmed',
        topicImportance: c.course_topics?.importance || 'medium'
      },
      source_file_id: c.source_file_id,
      page_start: c.page_start,
      page_end: c.page_end,
      estimated_minutes: c.estimated_minutes,
      status: 'todo',
      order_index: idx + 1
    };
  });
  const insert = await supaRequest<TaskRow[]>(
    'POST',
    'daily_study_tasks',
    taskRows,
    serviceKey,
    { Prefer: 'return=representation' }
  );
  const total = taskRows.reduce((sum, t) => sum + t.estimated_minutes, 0);
  await markPlanGenerated(serviceKey, plan.id, total, 'generated_from_valid_candidates');
  await writeStudyEvent(serviceKey, {
    user_id: userId,
    course_id: courseId,
    event_type: 'plan_generated',
    value: 'generated_from_valid_candidates',
    metadata: { planDate, taskCount: taskRows.length }
  });
  const fresh = await fetchPlanWithTasks(serviceKey, userId, courseId, planDate);
  return { plan: fresh.plan || plan, tasks: Array.isArray(insert.body) ? insert.body : fresh.tasks };
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
  if (taskType === 'quiz') return 'Quiz yourself on ' + topicName;
  if (taskType === 'flashcards') return 'Review flashcards for ' + topicName;
  if (taskType === 'practice') return 'Practice ' + topicName;
  if (taskType === 'deeplearn') return 'Deep Learn: ' + topicName;
  if (taskType === 'examforge') return 'Mini ExamForge drill: ' + topicName;
  if (taskType === 'review') return 'Review ' + topicName;
  return 'Learn ' + topicName;
}

function pageLabel(start: number | null, end: number | null): string {
  if (!start) return '';
  if (!end || end === start) return ', page ' + start;
  return ', pages ' + start + '-' + end;
}

function templateReason(group: string): string {
  if (group === 'must_do') return 'This is the next source-confirmed topic in your course map.';
  if (group === 'should_do') return 'This task is grounded in a confirmed course source.';
  return 'Optional extra practice if you have more time today.';
}
