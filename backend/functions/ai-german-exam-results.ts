// POST /api/ai/german-exam/results — submit one part's batched attempt
// results. Auth + light rate limit only — this is the user's own result
// data, cheap, no AI calls, so it stays out of the generation-cap bucket.
//
// This function does NOT write to Supabase itself. There is exactly one
// place attempt-writing logic lives: german_exam_performance.record_attempts()
// in python-ai. This function's only job is auth/rate-limit/validate-shape,
// then forward — keeping profile/module/part/skill-tag validation (and any
// future score-normalization logic) in one backend service instead of
// duplicating validation rules between a TS edge function and Python.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import { isRegisteredExamProfileId } from '../lib/german-learner-profile';
import { checkExamPart, isIdentifier } from '../lib/german-exam-manifest';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const RESULTS_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_RESULTS_RATE_LIMIT_MAX', '60'), 10);
const RESULTS_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_RESULTS_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);

const MAX_ITEMS = 50;

interface ResultsResponseBody {
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
    'ai_german_exam_results',
    RESULTS_RATE_LIMIT_MAX,
    RESULTS_RATE_LIMIT_WINDOW,
    'Result submission limit reached. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const examFamily = body.examFamily;
  const examVariant = body.examVariant;
  const targetLevel = body.targetLevel;
  const module = body.module;
  const rawItems = body.items;

  if (typeof examFamily !== 'string' || !examFamily) return fail(400, 'examFamily is required');
  if (typeof targetLevel !== 'string' || !targetLevel) return fail(400, 'targetLevel is required');
  if (!isIdentifier(module)) return fail(400, 'invalid or unsupported module');
  if (!Array.isArray(rawItems) || rawItems.length === 0) return fail(400, 'items is required');
  if (rawItems.length > MAX_ITEMS) return fail(400, 'too many items');

  const items: Record<string, unknown>[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    // Each item carries the profile it was attempted under (a telc attempt finishing after the
    // learner switched to Goethe must still land in telc history), so validation is per item:
    // registered profile -> module exists in it -> part exists in that module.
    if (!isRegisteredExamProfileId(r.profileId)) continue;
    if (!isIdentifier(r.module) || !isIdentifier(r.partId)) continue;
    if ((await checkExamPart(r.profileId, r.module, r.partId)) === 'unknown') continue;
    if (typeof r.taskType !== 'string' || !r.taskType) continue;
    if (typeof r.itemId !== 'string' || !r.itemId) continue;
    items.push(r);
  }
  if (!items.length) return fail(400, 'no valid items in submission');

  await logSecurityEvent(serviceKey, user.id, 'ai_german_exam_results', {
    module,
    item_count: items.length,
    dropped: rawItems.length - items.length
  });

  const upstream = await forwardToPython<ResultsResponseBody>('german-exam/results', {
    userId: user.id,
    examFamily,
    examVariant: typeof examVariant === 'string' ? examVariant : null,
    targetLevel,
    module,
    items
  });

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
