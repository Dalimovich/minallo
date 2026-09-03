// GET /api/ai/mastery?courseId=... — current user's per-topic mastery for a course.
//
// Used by the dashboard mastery panel and by the chatbot's "weak topics"
// surfacing in Phase 3. Sorted weakest-first.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface MasteryRow {
  topic: string;
  attempts: number;
  correct: number;
  mastery_score: number;
  last_practiced_at: string | null;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const qs = (event.queryStringParameters || {}) as Record<string, string | undefined>;
  const courseId = qs.courseId;
  if (!courseId) return fail(400, 'courseId is required');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const path =
    'user_topic_mastery?user_id=eq.' + encodeURIComponent(user.id) +
    '&course_id=eq.' + encodeURIComponent(courseId) +
    '&select=topic,attempts,correct,mastery_score,last_practiced_at' +
    '&order=mastery_score.asc';
  const res = await supaRequest<MasteryRow[]>('GET', path, null, serviceKey);
  return jsonResponse(200, { mastery: Array.isArray(res.body) ? res.body : [] });
};
