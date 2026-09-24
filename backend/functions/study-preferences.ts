// GET/PATCH /api/study/preferences

import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { bodyJson, requireStudyAuth } from '../lib/study-planner';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  const auth = await requireStudyAuth(event);
  if ('statusCode' in auth) return auth;

  if (event.httpMethod === 'GET') {
    const res = await supaRequest(
      'GET',
      'study_preferences?user_id=eq.' + encodeURIComponent(auth.user.id) + '&select=*&limit=1',
      null,
      auth.serviceKey
    );
    return jsonResponse(200, { preferences: Array.isArray(res.body) ? res.body[0] || null : null });
  }
  if (event.httpMethod !== 'PATCH') return fail(405, 'Method not allowed');
  const body = bodyJson(event);
  if ((body as LambdaResponse).statusCode) return body as LambdaResponse;
  const data = body as Record<string, unknown>;
  const patch = {
    user_id: auth.user.id,
    daily_minutes: clampInt(data.dailyMinutes, 15, 180, 45),
    preferred_load: ['light', 'normal', 'intensive'].includes(String(data.preferredLoad)) ? data.preferredLoad : 'normal',
    default_task_count: clampInt(data.defaultTaskCount, 1, 5, 3),
    updated_at: new Date().toISOString()
  };
  const res = await supaRequest('POST', 'study_preferences', patch, auth.serviceKey, {
    Prefer: 'resolution=merge-duplicates,return=representation'
  });
  return jsonResponse(200, { preferences: Array.isArray(res.body) ? res.body[0] : null });
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? Math.round(v) : fallback;
  return Math.max(min, Math.min(max, n));
}
