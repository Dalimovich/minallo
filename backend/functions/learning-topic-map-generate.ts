// POST /api/learning/topic-map-generate
// (Re)builds the per-course Topic Map (Learning Agent Core, Phase 1). The
// Python service runs the rebuild in the background and returns the current map.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { isSafeCourseId } from '../lib/validation';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const courseId = body.courseId;
  if (!courseId || typeof courseId !== 'string' || !isSafeCourseId(courseId)) {
    return fail(400, 'courseId is invalid');
  }
  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');

  const r = await forwardToPython('course-topic-map/generate', { userId: user.id, courseId });
  if (!r.ok) {
    const e = r.body as { error?: string; detail?: string };
    return fail(r.status, e.detail || e.error || 'Upstream error');
  }
  return jsonResponse(200, r.body as Record<string, unknown>);
};
