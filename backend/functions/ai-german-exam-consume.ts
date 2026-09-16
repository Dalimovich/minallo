// POST /api/ai/german-exam/consume — mark a previously-speculative
// (prefetched) generation's topic as actually used. Auth + light rate
// limit only — no AI call, just a topic-history write, same bucket
// treatment as ai-german-exam-results.ts.
//
// Called exactly once, only when prefetched content is actually applied to
// a real session (lsLoadGeneratedPart consuming a held prefetch result) —
// never for a normal (non-speculative) generate call, which already
// records its topic usage immediately server-side inside generate_task().

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const CONSUME_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_CONSUME_RATE_LIMIT_MAX', '60'), 10);
const CONSUME_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_CONSUME_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);

const VALID_PROFILE_IDS = ['telc_c1_hochschule'];
const VALID_MODULES = ['listening', 'reading'];
const VALID_PART_IDS = ['hv1', 'hv2', 'hv3', 'lesen_1', 'lesen_2', 'lesen_3'];

interface ConsumeResponseBody {
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
    'ai_german_exam_consume',
    CONSUME_RATE_LIMIT_MAX,
    CONSUME_RATE_LIMIT_WINDOW,
    'Please try again shortly.'
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
  const partId = body.partId;
  const topicId = body.topicId;
  const generationId = body.generationId;

  if (typeof profileId !== 'string' || !VALID_PROFILE_IDS.includes(profileId)) {
    return fail(400, 'invalid or unsupported profileId');
  }
  if (typeof module !== 'string' || !VALID_MODULES.includes(module)) {
    return fail(400, 'invalid or unsupported module');
  }
  if (typeof partId !== 'string' || !VALID_PART_IDS.includes(partId)) {
    return fail(400, 'invalid or unsupported partId');
  }
  if (typeof topicId !== 'string' || !topicId) return fail(400, 'topicId is required');

  const upstream = await forwardToPython<ConsumeResponseBody>('german-exam/consume', {
    userId: user.id,
    profileId,
    module,
    partId,
    topicId,
    generationId: typeof generationId === 'string' ? generationId : null
  });

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
