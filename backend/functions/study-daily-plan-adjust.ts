// POST /api/study/daily-plan/adjust
// Moves or replaces unfinished tasks for the day.

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import {
  bodyJson,
  getDailyTasks,
  localPlanDate,
  requireStudyAuth,
  validateCourseId,
  writeStudyEvent,
} from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;
  const body = bodyJson(event);
  if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
  const payload = body as Record<string, unknown>;
  const courseId = validateCourseId(payload.courseId);
  if (typeof courseId !== 'string') return courseId;
  const mode = typeof payload.mode === 'string' ? payload.mode : '';
  const { planDate } = localPlanDate(payload.date, payload.timezone);

  // Find active plan id for this week + course.
  const dateObj = new Date(planDate + 'T00:00:00Z');
  const dow = dateObj.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const weekStart = new Date(dateObj);
  weekStart.setUTCDate(weekStart.getUTCDate() + diff);
  const weekStartStr = weekStart.toISOString().slice(0, 10);

  const planRes = await supaRequest<Array<{ id: string }>>(
    'GET',
    'weekly_study_plans?user_id=eq.' +
      encodeURIComponent(auth.user.id) +
      '&week_start_date=eq.' +
      encodeURIComponent(weekStartStr) +
      '&course_id=eq.' +
      encodeURIComponent(courseId) +
      '&status=eq.active&select=id&limit=1',
    null,
    auth.serviceKey
  );
  const plan = Array.isArray(planRes.body) ? planRes.body[0] ?? null : null;
  if (!plan) return fail(404, 'Weekly plan not found');

  if (mode === 'move_unfinished_tomorrow') {
    const tomorrow = new Date(planDate + 'T00:00:00Z');
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await supaRequest(
      'PATCH',
      'weekly_study_tasks?plan_id=eq.' +
        encodeURIComponent(plan.id) +
        '&plan_date=eq.' +
        encodeURIComponent(planDate) +
        '&status=in.(todo,skipped)',
      {
        status: 'moved',
        plan_date: tomorrow.toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      },
      auth.serviceKey,
      { Prefer: 'return=minimal' }
    );
  } else {
    await supaRequest(
      'PATCH',
      'weekly_study_tasks?plan_id=eq.' +
        encodeURIComponent(plan.id) +
        '&plan_date=eq.' +
        encodeURIComponent(planDate) +
        '&status=in.(todo,skipped)',
      { status: 'replaced', updated_at: new Date().toISOString() },
      auth.serviceKey,
      { Prefer: 'return=minimal' }
    );
  }

  await writeStudyEvent(auth.serviceKey, {
    user_id: auth.user.id,
    course_id: courseId,
    event_type: 'plan_adjusted',
    metadata: { planDate, mode: mode || 'replace_remaining' },
  });

  const freshTasks = await getDailyTasks(
    auth.user.id,
    dateObj,
    auth.serviceKey,
    courseId
  );
  const completed = freshTasks.filter((t) => t.status === 'completed').length;
  const remaining = freshTasks
    .filter((t) => !['completed', 'replaced'].includes(t.status))
    .reduce((s, t) => s + (t.estimated_minutes || 0), 0);

  return jsonResponse(200, {
    hasPlan: freshTasks.length > 0,
    tasks: freshTasks,
    summary: {
      completedTasks: completed,
      totalTasks: freshTasks.length,
      minutesRemaining: remaining,
      status: 'active',
    },
  });
};
