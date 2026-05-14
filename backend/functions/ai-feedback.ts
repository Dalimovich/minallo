// POST /api/ai/feedback — proxy to Python /feedback.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');
  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON body'); }

  const upstream = await forwardToPython('feedback', {
    userId: user.id,
    courseId: body.courseId,
    question: body.question,
    rating: body.rating,
    answerCacheId: body.answerCacheId ?? null,
    feedbackText: body.feedbackText ?? null,
    reason: body.reason ?? null
  });
  return jsonResponse(upstream.status === 200 ? 201 : upstream.status, upstream.body);
};
