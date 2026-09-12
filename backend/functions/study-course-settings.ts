// GET /api/study/course-settings

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { requireStudyAuth } from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed');
  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;
  const res = await supaRequest(
    'GET',
    'course_study_settings?user_id=eq.' + encodeURIComponent(auth.user.id) + '&select=*',
    null,
    auth.serviceKey
  );
  return jsonResponse(200, { courseSettings: Array.isArray(res.body) ? res.body : [] });
};
