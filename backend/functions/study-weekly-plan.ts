// GET  /api/study/weekly-plan?weekStart=YYYY-MM-DD&courseId=...
//   → return full week tasks grouped by date
// POST /api/study/weekly-plan/generate
//   → generateWeeklyPlan for userId

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import {
  bodyJson,
  generateWeeklyPlan,
  localPlanDate,
  requireStudyAuth,
  validateCourseId,
} from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';
import type { PlanScope, WeeklyStudyTask } from '../lib/study-planner-types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;

  // ── GET: fetch full week grouped by date ─────────────────────────────────
  if (event.httpMethod === 'GET') {
    const qs = event.queryStringParameters || {};
    const courseId = validateCourseId(qs.courseId);
    if (typeof courseId !== 'string') return courseId;

    // weekStart defaults to the Monday of the current week.
    const { planDate: weekStartStr } = localPlanDate(qs.weekStart, qs.timezone);

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
    if (!plan) {
      return jsonResponse(200, { hasPlan: false, weekStart: weekStartStr, tasksByDate: {} });
    }

    const tasksRes = await supaRequest<WeeklyStudyTask[]>(
      'GET',
      'weekly_study_tasks?plan_id=eq.' +
        encodeURIComponent(plan.id) +
        '&order=plan_date.asc,day_order.asc&select=*',
      null,
      auth.serviceKey
    );
    const tasks = Array.isArray(tasksRes.body) ? tasksRes.body : [];
    const tasksByDate: Record<string, WeeklyStudyTask[]> = {};
    for (const t of tasks) {
      const arr = tasksByDate[t.plan_date] ?? [];
      arr.push(t);
      tasksByDate[t.plan_date] = arr;
    }

    return jsonResponse(200, {
      hasPlan: true,
      planId: plan.id,
      weekStart: weekStartStr,
      tasksByDate,
      totalTasks: tasks.length,
    });
  }

  // ── POST: generate / regenerate ──────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    const body = bodyJson(event);
    if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
    const payload = body as Record<string, unknown>;

    const courseId = validateCourseId(payload.courseId);
    if (typeof courseId !== 'string') return courseId;

    const { planDate } = localPlanDate(payload.weekStart ?? payload.date, payload.timezone);
    const scope: PlanScope = payload.scope === 'global_week' ? 'global_week' : 'course_week';

    const result = await generateWeeklyPlan(
      auth.user.id,
      new Date(planDate + 'T00:00:00Z'),
      scope,
      courseId,
      auth.serviceKey
    );

    return jsonResponse(200, {
      planId: result.planId,
      taskCount: result.taskCount,
      subjects: result.subjects,
      weekStart: planDate,
    });
  }

  return fail(405, 'Method not allowed');
};
