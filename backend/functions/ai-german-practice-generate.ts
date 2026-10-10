// POST /api/ai/german-practice/generate — general Wortschatz/Grammatik
// practice generation. NOT part of the German Exam Engine: no exam profile is
// required, so a learner at any level can use it. userId always comes from the
// verified token, never from the request body.

import { jsonResponse, fail, handleOptions, upstreamFailureResponse } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_PRACTICE_RATE_LIMIT_MAX', '60'), 10);
const RATE_LIMIT_WINDOW = parseInt(optionalEnv('AI_GERMAN_PRACTICE_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const UPSTREAM_TIMEOUT_MS = parseInt(optionalEnv('AI_GERMAN_PRACTICE_UPSTREAM_TIMEOUT_MS', '55000'), 10);

const VALID_MODULES = ['vocabulary', 'grammar'];
const MAX_LEVEL_LENGTH = 40;
const MAX_TOPIC_LENGTH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringArray(v: unknown, maxItems: number, maxLen: number): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== 'string' || s.length > maxLen) return null;
    out.push(s);
  }
  return out;
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

  const { module, topic } = body;
  // The level is NOT taken from the request: python-ai reads the authenticated
  // profile. Only an explicit session-only override may be sent.
  const overrideRaw = body.sessionLevelOverride;
  if (typeof module !== 'string' || !VALID_MODULES.includes(module)) return fail(400, 'invalid module');
  if (overrideRaw !== undefined && overrideRaw !== null && (typeof overrideRaw !== 'string' || overrideRaw.length > MAX_LEVEL_LENGTH)) {
    return fail(400, 'invalid level');
  }
  const sessionLevelOverride = typeof overrideRaw === 'string' && overrideRaw.trim() ? overrideRaw.trim() : null;
  if (typeof topic !== 'string' || topic.length > MAX_TOPIC_LENGTH) return fail(400, 'invalid topic');
  const countRaw = body.count === undefined ? 10 : body.count;
  if (typeof countRaw !== 'number' || !Number.isInteger(countRaw) || countRaw < 3 || countRaw > 15) {
    return fail(400, 'invalid count');
  }
  const sourceDocumentIds = stringArray(body.sourceDocumentIds, 5, 64);
  if (!sourceDocumentIds || !sourceDocumentIds.every((id) => UUID_RE.test(id))) {
    return fail(400, 'invalid sourceDocumentIds');
  }
  const avoidPrompts = stringArray(body.avoidPrompts, 40, 300);
  const weakAreas = stringArray(body.weakAreas, 8, 80);
  if (!avoidPrompts || !weakAreas) return fail(400, 'invalid avoidPrompts/weakAreas');

  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_german_practice_generate');
  if (subBlocked) return subBlocked;
  const capped = await enforceGenerationCap(serviceKey, user.id);
  if (capped) return capped;
  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_german_practice_generate',
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW,
    'Practice generation limit reached. Please try again later.'
  );
  if (limited) return limited;

  await logSecurityEvent(serviceKey, user.id, 'ai_german_practice_generate', {
    module,
    session_level_override: sessionLevelOverride,
    count: countRaw,
    from_documents: sourceDocumentIds.length > 0
  });

  const upstream = await forwardToPython<Record<string, unknown>>(
    'german-practice/generate',
    {
      userId: user.id,
      module,
      sessionLevelOverride,
      topic,
      count: countRaw,
      sourceDocumentIds: sourceDocumentIds.length ? sourceDocumentIds : null,
      avoidPrompts,
      weakAreas
    },
    UPSTREAM_TIMEOUT_MS
  );
  if (!upstream.ok) return upstreamFailureResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
