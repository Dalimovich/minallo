// POST /api/study/daily-plan/adjust

import { fail, handleOptions } from '../lib/responses';
import { bodyJson, fetchPlanWithTasks, localPlanDate, requireStudyAuth, studyPlanResponse, validateCourseId, writeStudyEvent } from '../lib/study-planner';
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
  const data = await fetchPlanWithTasks(auth.serviceKey, auth.user.id, courseId, planDate);
  if (!data.plan) return fail(404, 'Daily plan not found');

  if (mode === 'move_unfinished_tomorrow') {
    const tomorrow = new Date(planDate + 'T00:00:00Z');
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await supaRequest(
      'PATCH',
      'daily_study_tasks?daily_plan_id=eq.' + encodeURIComponent(data.plan.id) +
        '&status=in.(todo,skipped)',
      { status: 'moved', moved_to_date: tomorrow.toISOString().slice(0, 10), updated_at: new Date().toISOString() },
      auth.serviceKey,
      { Prefer: 'return=minimal' }
    );
  } else {
    await supaRequest(
      'PATCH',
      'daily_study_tasks?daily_plan_id=eq.' + encodeURIComponent(data.plan.id) +
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
    value: mode || 'regenerate_remaining',
    metadata: { planDate }
  });
  const fresh = await fetchPlanWithTasks(auth.serviceKey, auth.user.id, courseId, planDate);
  return studyPlanResponse(fresh);
};
