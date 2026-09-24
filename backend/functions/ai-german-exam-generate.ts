// POST /api/ai/german-exam/generate — shared German Exam Engine content
// generation. Hören is the first consumer, but this endpoint is NOT
// Hören-specific: `module` selects the adapter server-side
// (backend/python-ai/app/services/german_exam_generator.py).
//
// This endpoint's work is LLM generation + deterministic validation +
// per-item repair ONLY — TTS is deliberately out of scope (the returned
// content has no audioUrl/durationMs fields at all). The frontend calls the
// existing /api/ai/tts-batch separately, via lsPlayer's own setSegments(),
// after this call returns. See services/german_exam_listening.py's module
// docstring for the full reasoning (reusability across modules that don't
// need TTS, and a Qwen outage must not fail content generation).

import { jsonResponse, fail, handleOptions, upstreamFailureResponse } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { isGermanSpeakingEnabled } from '../lib/feature-flags';
import { logSecurityEvent } from '../lib/logger';
import { getGermanLearnerProfile, unsupportedExamProfileMessage } from '../lib/german-learner-profile';
import { checkExamPart, checkExamPartAvailability, isIdentifier } from '../lib/german-exam-manifest';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const GENERATE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_GENERATE_RATE_LIMIT_MAX', '30'), 10);
const GENERATE_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_GENERATE_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);
// This endpoint's work is generation + validation + repair only (no TTS
// chained behind it) — started at forwardToPython()'s shared 120s default,
// but a production release-smoke run (2026-09-17) measured a real Lesen
// generate call taking 99s to succeed and a later one 502ing at the 120s
// upstream timeout — semantic-verification repair/regeneration passes can
// push latency past that ceiling. A later run then hit Cloudflare's own
// ~120s edge limit (HTTP 524 HTML page), so holding this request for 180s
// only wasted work: the client was already gone. The chain is now
// python budget (95s, GERMAN_GEN_BUDGET_S) < this timeout (105s) < edge (~120s),
// so a slow generation ends as a structured error with a reference id, never a
// 524. AI_GERMAN_EXAM_GENERATE_UPSTREAM_TIMEOUT_MS still overrides it.
const GENERATE_UPSTREAM_TIMEOUT_MS = parseInt(optionalEnv('AI_GERMAN_EXAM_GENERATE_UPSTREAM_TIMEOUT_MS', '105000'), 10);

// No flat module/part allowlists: which modules and parts exist depends on the
// learner's exam profile, so they are checked against that profile's manifest
// (authoritative in python-ai, cached — see lib/german-exam-manifest.ts).
const VALID_MODES = ['adaptive_practice'];
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

  // Cheap feature-disabled rejection for Sprechen, BEFORE any paid-usage
  // accounting (subscription gate, generation cap, rate limit) or upstream
  // forwarding — a disabled feature must never create billable usage. Body
  // is parsed once here for this check; the full parse+validation below is
  // unconditional and re-parses it for every other module, so this early
  // exit only short-circuits the speaking case.
  let earlyBody: Record<string, unknown> = {};
  try {
    earlyBody = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  if (earlyBody.module === 'speaking' && !isGermanSpeakingEnabled()) {
    return fail(403, 'Speaking practice is temporarily unavailable.');
  }

  // The exam profile comes from the authenticated user's SAVED profile
  // (profiles.german_test + german_level), never the request. A missing or
  // stale browser profileId still resolves correctly; a contradictory one
  // loses to the server.
  const learner = await getGermanLearnerProfile(serviceKey, user.id);
  if (!learner) return fail(503, 'Your profile could not be loaded right now. Please try again.');
  const profileId = learner.examProfileId;
  if (!profileId) {
    return fail(422, unsupportedExamProfileMessage(learner));
  }
  const clientDisagrees = typeof earlyBody.profileId === 'string' && earlyBody.profileId !== '' && earlyBody.profileId !== profileId;

  // Shape + profile-aware structure checks BEFORE any paid-usage accounting, so a request
  // for a part that isn't in this learner's exam (e.g. sprachbausteine_1 for goethe_c1)
  // never consumes generation cap or rate limit.
  if (!isIdentifier(earlyBody.module)) return fail(400, 'invalid or unsupported module');
  if (!isIdentifier(earlyBody.partId)) return fail(400, 'invalid or unsupported partId');
  const partCheck = await checkExamPart(profileId, earlyBody.module, earlyBody.partId);
  if (partCheck === 'unknown') return fail(400, 'invalid or unsupported module/partId for your exam');
  // In the exam's structure but not generatable yet (e.g. every DSH part today): reject BEFORE
  // subscription/cap/rate-limit accounting so an unavailable part can never consume paid usage.
  if ((await checkExamPartAvailability(profileId, earlyBody.module, earlyBody.partId)) === 'unavailable') {
    return fail(422, 'This exam part is not available yet.');
  }

  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_german_exam_generate');
  if (subBlocked) return subBlocked;

  const capped = await enforceGenerationCap(serviceKey, user.id);
  if (capped) return capped;

  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_german_exam_generate',
    GENERATE_RATE_LIMIT_MAX,
    GENERATE_RATE_LIMIT_WINDOW,
    'Exam content generation limit reached. Please try again later.'
  );
  if (limited) return limited;

  const body: Record<string, unknown> = earlyBody;

  const module = body.module;
  const partId = body.partId;
  const mode = typeof body.mode === 'string' ? body.mode : 'adaptive_practice';
  const topicRaw = body.topic;
  // Prefetch/speculative generation: same auth, same subscription gate, same
  // generation cap and rate limit as a normal call — a prefetch is real
  // OpenAI usage and must count honestly against the same budget, not a
  // separate unmetered allowance. What keeps it from silently chewing
  // through that budget is frontend discipline (one prefetch in flight,
  // only when no prepared result is already held, no re-trigger on repeated
  // navigation) — see practice.js's lsPrefetch. Server-side this flag only
  // controls whether the chosen topic is recorded as "used" immediately
  // (it isn't, for speculative calls — see POST /german-exam/consume).
  const speculative = body.speculative === true;

  if (!isIdentifier(module)) return fail(400, 'invalid or unsupported module');
  if (!isIdentifier(partId)) return fail(400, 'invalid or unsupported partId');
  if (!VALID_MODES.includes(mode)) {
    return fail(400, 'invalid mode');
  }
  let topic: string | undefined;
  if (topicRaw !== undefined && topicRaw !== null) {
    if (typeof topicRaw !== 'string' || topicRaw.length > MAX_TOPIC_LENGTH) {
      return fail(400, 'invalid topic');
    }
    topic = topicRaw;
  }

  await logSecurityEvent(serviceKey, user.id, 'ai_german_exam_generate', {
    profile_id: profileId,
    client_profile_id_mismatch: clientDisagrees || undefined,
    module,
    part_id: partId,
    mode,
    speculative
  });

  const upstream = await forwardToPython<GenerateResponseBody>(
    'german-exam/generate',
    { userId: user.id, profileId, module, partId, mode, topic: topic || null, speculative },
    GENERATE_UPSTREAM_TIMEOUT_MS
  );

  if (!upstream.ok) return upstreamFailureResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
