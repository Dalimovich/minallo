// GET /api/study/daily-plan/summary?courseId=...

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import {
  fetchPlanWithTasks,
  localPlanDate,
  requireStudyAuth,
  validateCourseId
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
  const data = await fetchPlanWithTasks(auth.serviceKey, auth.user.id, courseId, planDate);
  const completed = data.tasks.filter((t) => t.status === 'completed').length;
  const activeTasks = data.tasks.filter((t) => t.status !== 'replaced');
  const remaining = activeTasks
    .filter((t) => t.status !== 'completed')
    .reduce((sum, t) => sum + (t.estimated_minutes || 0), 0);
  return jsonResponse(200, {
    hasPlan: !!data.plan,
    courseId,
    planDate,
    completedTasks: completed,
    totalTasks: activeTasks.length,
    minutesRemaining: remaining,
    mainFocus: activeTasks[0]?.title || null,
    status: data.plan?.status || 'none'
  });
};
