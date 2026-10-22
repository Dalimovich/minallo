// POST /api/ai/german-exam/dsh/lv-hv/generate — DSH Leseverstehen/Hörverstehen PRACTICE
// generation. Explicitly NOT the generic /api/ai/german-exam/generate path: every DSH
// PartBlueprint.available stays false, so that path (and its profile/manifest availability
// check) correctly refuses DSH forever by design — this is a separate, dedicated sandbox for
// exercising the DSH generation + raw content-point grading pipeline
// (german_exam_dsh_generators.py / german_exam_dsh_grading.py), not gated by or tied to the
// learner's own saved exam profile, and never counted as, or confused with, an official DSH
// exam delivery.
//
// Reuses exactly the existing production infrastructure every other german-exam AI endpoint
// uses (see ai-german-exam-grade-writing.ts / ai-german-exam-generate.ts for the same pattern):
// Supabase auth, active-subscription gate, generation cap, event rate limiting, security
// logging, forwardToPython. No new auth/billing/rate-limit mechanism is introduced here.
//
// The response forwarded back to the browser is exactly what python-ai's
// dsh_lv_hv_generate_endpoint returns: {part, generationId, content} — content has already had
// every answer-key field stripped server-side (german_exam_dsh_grading.
// strip_answer_key_for_learner), and the full grading-essential content is held server-side in
// public.dsh_lv_hv_practice_generations, owned by this request's authenticated user.id — never
// returned to the browser. `userId` forwarded to python-ai is `user.id` from the verified
// Supabase token below, never anything the client could supply.

import { jsonResponse, fail, handleOptions, upstreamFailureResponse } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const GENERATE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_DSH_LV_HV_GENERATE_RATE_LIMIT_MAX', '30'), 10);
const GENERATE_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_DSH_LV_HV_GENERATE_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);
// Mirrors ai-german-exam-generate.ts's own timeout reasoning: the DSH generator runs the same
// shape of generate-then-independently-audit pipeline (up to 2 bounded regenerations), so it
// gets the same budget — python budget < this timeout < Cloudflare's ~120s edge limit.
const GENERATE_UPSTREAM_TIMEOUT_MS = parseInt(optionalEnv('AI_GERMAN_EXAM_DSH_LV_HV_GENERATE_UPSTREAM_TIMEOUT_MS', '105000'), 10);

const VALID_PARTS = ['lv', 'hv'];
const MAX_TOPIC_LENGTH = 200;

interface GenerateResponseBody {
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

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid body');

  const part = body.part;
  if (typeof part !== 'string' || !VALID_PARTS.includes(part)) return fail(400, "part must be 'lv' or 'hv'");
  const topicRaw = body.topic;
  let topic: string | undefined;
  if (topicRaw !== undefined && topicRaw !== null) {
    if (typeof topicRaw !== 'string' || topicRaw.length > MAX_TOPIC_LENGTH) return fail(400, 'invalid topic');
    topic = topicRaw;
  }

  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_german_exam_dsh_lv_hv_generate');
  if (subBlocked) return subBlocked;

  const capped = await enforceGenerationCap(serviceKey, user.id);
  if (capped) return capped;

  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_german_exam_dsh_lv_hv_generate',
    GENERATE_RATE_LIMIT_MAX,
    GENERATE_RATE_LIMIT_WINDOW,
    'DSH practice generation limit reached. Please try again later.'
  );
  if (limited) return limited;

  await logSecurityEvent(serviceKey, user.id, 'ai_german_exam_dsh_lv_hv_generate', { part });

  const upstream = await forwardToPython<GenerateResponseBody>(
    'german-exam/dsh/lv-hv/generate',
    { userId: user.id, part, topic: topic || null },
    GENERATE_UPSTREAM_TIMEOUT_MS
  );

  if (!upstream.ok) return upstreamFailureResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
