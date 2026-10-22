// POST /api/ai/tts-batch — one authenticated call for a whole Hören lesson's
// worth of segments, instead of the frontend firing one /api/ai/tts request
// per segment in parallel. python-ai's /tts/generate-batch checks the cache
// for every segment up front and fans out only the misses through a small
// server-side concurrency limit (TTS_BATCH_MAX_CONCURRENCY) — that's the
// actual backstop against one browser session opening 8-12 simultaneous
// generations against a single Qwen instance. This endpoint exists so the
// browser can no longer bypass that by calling the single-segment endpoint
// N times in parallel itself.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

// A "batch" is one lesson's worth of generation calls, not one segment — a
// much lower per-hour ceiling than the single-segment endpoint's, sized so a
// user replaying/generating several listening sets per session stays well
// under it while still bounding worst-case Qwen load from one account.
const TTS_BATCH_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_TTS_BATCH_RATE_LIMIT_MAX', '20'), 10);
const TTS_BATCH_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_TTS_BATCH_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);
// A cold batch of up to 30 segments, generated 1-2 at a time server-side,
// can legitimately take a while — longer than the shared AI_UPSTREAM_TIMEOUT_MS
// default that other (single-call) AI endpoints use. See forwardToPython's
// timeoutMs override.
const TTS_BATCH_UPSTREAM_TIMEOUT_MS = parseInt(
  optionalEnv('AI_TTS_BATCH_UPSTREAM_TIMEOUT_MS', String(5 * 60 * 1000)),
  10
);
const MAX_SEGMENTS = 30;
const MAX_TEXT_LENGTH = 2000;
const ALLOWED_LANGUAGES = ['German'];

interface TTSBatchSegmentResult {
  id: string;
  audioUrl?: string;
  durationMs?: number;
  provider?: string;
  cacheHit?: boolean;
  failed?: boolean;
}

interface TTSBatchResponseBody {
  segments?: TTSBatchSegmentResult[];
  degraded?: boolean;
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

  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_tts_batch');
  if (subBlocked) return subBlocked;

  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_tts_batch',
    TTS_BATCH_RATE_LIMIT_MAX,
    TTS_BATCH_RATE_LIMIT_WINDOW,
    'Listening audio request limit reached. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const rawSegments = body.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) return fail(400, 'segments is required');
  if (rawSegments.length > MAX_SEGMENTS) return fail(400, 'too many segments');

  const segments: { id: string; text: string }[] = [];
  for (const raw of rawSegments) {
    if (!raw || typeof raw !== 'object') return fail(400, 'invalid segment');
    const id = (raw as Record<string, unknown>).id;
    const text = (raw as Record<string, unknown>).text;
    if (!id || typeof id !== 'string') return fail(400, 'segment id is required');
    if (!text || typeof text !== 'string') return fail(400, 'segment text is required');
    if (text.length > MAX_TEXT_LENGTH) return fail(400, 'segment text is too long');
    segments.push({ id, text });
  }

  const language =
    typeof body.language === 'string' && ALLOWED_LANGUAGES.includes(body.language) ? body.language : 'German';

  await logSecurityEvent(serviceKey, user.id, 'ai_tts_batch', { segment_count: segments.length });

  const upstream = await forwardToPython<TTSBatchResponseBody>(
    'tts/generate-batch',
    { segments, language },
    TTS_BATCH_UPSTREAM_TIMEOUT_MS
  );

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  const py = upstream.body as TTSBatchResponseBody;
  return jsonResponse(200, {
    segments: (py.segments || []).map((s) => ({
      id: s.id,
      audioUrl: s.audioUrl || null,
      durationMs: s.durationMs || 0,
      provider: s.provider || null,
      cacheHit: Boolean(s.cacheHit),
      failed: Boolean(s.failed)
    })),
    degraded: Boolean(py.degraded)
  });
};
