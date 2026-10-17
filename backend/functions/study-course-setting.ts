// PATCH /api/study/course-settings/:courseId

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { bodyJson, requireStudyAuth, validateCourseId } from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'PATCH') return fail(405, 'Method not allowed');
  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;
  const body = bodyJson(event);
  if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
  const data = body as Record<string, unknown>;
  const courseId = validateCourseId(courseIdFromPath(event.path));
  if (typeof courseId !== 'string') return courseId;
  const patch = {
    user_id: auth.user.id,
    course_id: courseId,
    enabled: data.enabled !== false,
    exam_date: typeof data.examDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.examDate) ? data.examDate : null,
    course_priority: ['low', 'normal', 'high'].includes(String(data.coursePriority)) ? data.coursePriority : 'normal',
    daily_minutes_override: typeof data.dailyMinutesOverride === 'number' ? Math.max(15, Math.min(180, Math.round(data.dailyMinutesOverride))) : null,
    updated_at: new Date().toISOString()
  };
  const res = await supaRequest('POST', 'course_study_settings', patch, auth.serviceKey, {
    Prefer: 'resolution=merge-duplicates,return=representation'
  });
  return jsonResponse(200, { courseSetting: Array.isArray(res.body) ? res.body[0] : null });
};

function courseIdFromPath(path: string | undefined): string | null {
  const match = String(path || '').match(/\/api\/study\/course-settings\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}
