// POST /api/study/daily-plan/generate

import { fail, handleOptions } from '../lib/responses';
import {
  bodyJson,
  generateDailyPlan,
  localPlanDate,
  requireStudyAuth,
  studyPlanResponse,
  validateCourseId
} from '../lib/study-planner';
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
  const { planDate, userTimezone } = localPlanDate(payload.date, payload.timezone);
  const minutes = typeof payload.availableMinutes === 'number' ? payload.availableMinutes : undefined;
  const data = await generateDailyPlan(auth.serviceKey, auth.user.id, courseId, planDate, userTimezone, minutes);
  return studyPlanResponse(data);
};
