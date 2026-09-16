// POST /api/ai/german-exam/weaknesses — read-only weakness snapshot for a
// (profile, module). POST despite being a logical read: the shared
// forwardToPython() helper always issues a POST to python-ai regardless of
// the logical operation, and this feature deliberately does not extend that
// shared proxy to support other HTTP methods for one endpoint. Auth-only,
// light rate limit — no generation cap (no LLM call happens here); the
// weighting/recency math lives in python-ai via german_exam_adaptation, so
// this stays a thin forward instead of a second implementation in TS.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const WEAKNESSES_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_WEAKNESSES_RATE_LIMIT_MAX', '60'), 10);
const WEAKNESSES_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_WEAKNESSES_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);

const VALID_PROFILE_IDS = ['telc_c1_hochschule'];
const VALID_MODULES = ['listening'];

interface WeaknessResponseBody {
  [key: string]: unknown;
  error?: string;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');
  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_german_exam_weaknesses',
    WEAKNESSES_RATE_LIMIT_MAX,
    WEAKNESSES_RATE_LIMIT_WINDOW,
    'Weakness lookup limit reached. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const profileId = body.profileId;
  const module = body.module;
  if (typeof profileId !== 'string' || !VALID_PROFILE_IDS.includes(profileId)) {
    return fail(400, 'invalid or unsupported profileId');
  }
  if (typeof module !== 'string' || !VALID_MODULES.includes(module)) {
    return fail(400, 'invalid or unsupported module');
  }

  const upstream = await forwardToPython<WeaknessResponseBody>('german-exam/weaknesses', {
    userId: user.id,
    profileId,
    module
  });

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
