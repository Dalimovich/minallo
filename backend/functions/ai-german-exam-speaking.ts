// Authenticated spoken-input, partner-turn and session-grading proxy.
// TTS continues to use /api/ai/tts; there is no second synthesis provider.
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');
  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');
  if ((event.body || '').length > 8 * 1024 * 1024 + 1024) return fail(413, 'Recording is too large');
  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}'); } catch { return fail(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.profileId !== 'telc_c1_hochschule' ||
      !['transcribe', 'partner', 'grade'].includes(String(body.action)) ||
      typeof body.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.sessionId)) return fail(400, 'Invalid speaking request');
  if (body.action !== 'transcribe' && (event.body || '').length > 150000) return fail(413, 'Session is too large');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const subscribed = await requireActiveSubscription(key, user.id, 'ai_german_exam_speaking');
  if (subscribed) return subscribed;
  const capped = await enforceGenerationCap(key, user.id);
  if (capped) return capped;
  const limited = await enforceEventRateLimit(key, user.id, 'ai_german_exam_speaking', 100, 60 * 60 * 1000,
    'Speaking practice limit reached. Please try again later.');
  if (limited) return limited;
  await logSecurityEvent(key, user.id, 'ai_german_exam_speaking', { action: body.action });
  const upstream = await forwardToPython('german-exam/speaking', { ...body, userId: user.id });
  return jsonResponse(upstream.status, upstream.body);
};
