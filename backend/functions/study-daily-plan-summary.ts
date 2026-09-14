// GET /api/study/daily-plan/summary?courseId=...

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import {
  getDailyTasks,
  localPlanDate,
  requireStudyAuth,
  validateCourseId,
} from '../lib/study-planner';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed');

  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;
  const qs = event.queryStringParameters || {};
  const courseId = validateCourseId(qs.courseId);
  if (typeof courseId !== 'string') return courseId;
  const { planDate } = localPlanDate(qs.date, qs.timezone);

  try {
    const tasks = await getDailyTasks(
      auth.user.id,
      new Date(planDate + 'T00:00:00Z'),
      auth.serviceKey,
      courseId
    );

    const completed = tasks.filter((t) => t.status === 'completed').length;
    const activeTasks = tasks.filter((t) => t.status !== 'replaced');
    const remaining = activeTasks
      .filter((t) => t.status !== 'completed')
      .reduce((sum, t) => sum + (t.estimated_minutes || 0), 0);
    const hasUnavailable = activeTasks.some((t) => t.status === 'unavailable');

    return jsonResponse(200, {
      hasPlan: tasks.length > 0,
      courseId,
      planDate,
      completedTasks: completed,
      totalTasks: activeTasks.length,
      minutesRemaining: remaining,
      mainFocus:
        activeTasks.find((t) => t.status !== 'completed' && t.status !== 'unavailable')
          ?.task_title ?? null,
      status: tasks.length > 0 ? 'active' : 'none',
      noValidCandidates: tasks.length === 0,
      hasUnavailableSources: hasUnavailable,
    });
  } catch (err) {
    console.error('[study-daily-plan-summary] Error:', err);
    return fail(500, 'Failed to load summary');
  }
};
