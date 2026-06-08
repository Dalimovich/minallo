// GET /api/study/daily-plan?date=YYYY-MM-DD&courseId=...

import { fail, handleOptions } from '../lib/responses';
import {
  fetchPlanWithTasks,
  localPlanDate,
  requireStudyAuth,
  studyPlanResponse,
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
  return studyPlanResponse(data);
};
