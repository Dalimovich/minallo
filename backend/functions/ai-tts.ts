// POST /api/ai/tts — thin authenticated proxy to the Python /tts/generate
// endpoint. Public clients never reach python-ai (let alone the isolated
// Qwen TTS host behind it) without a valid Supabase session, an active
// subscription, and a rate limit, same gating order as ai-ask.ts.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

// Hören segments are short sentences, not chat turns — a generous per-hour
// budget still bounds worst-case Qwen TTS cost/load far below abuse levels.
const TTS_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_TTS_RATE_LIMIT_MAX', '120'), 10);
const TTS_RATE_LIMIT_WINDOW = parseInt(optionalEnv('AI_TTS_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const MAX_TEXT_LENGTH = 2000;
const ALLOWED_LANGUAGES = ['German'];

interface TTSResponseBody {
  audioUrl?: string;
  durationMs?: number;
  provider?: string;
  voice?: string;
  cacheHit?: boolean;
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

  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_tts');
  if (subBlocked) return subBlocked;

  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_tts',
    TTS_RATE_LIMIT_MAX,
    TTS_RATE_LIMIT_WINDOW,
    'Listening audio request limit reached. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const text = body.text;
  if (!text || typeof text !== 'string') return fail(400, 'text is required');
  if (text.length > MAX_TEXT_LENGTH) return fail(400, 'text is too long');

  const language = typeof body.language === 'string' && ALLOWED_LANGUAGES.includes(body.language)
    ? body.language
    : 'German';

  await logSecurityEvent(serviceKey, user.id, 'ai_tts', { text_length: text.length });

  const upstream = await forwardToPython<TTSResponseBody>('tts/generate', {
    text,
    language,
    voice: undefined
  });

  // A 503 here is expected/normal whenever Qwen isn't configured or
  // temporarily unhealthy — the frontend's own fallback to browser
  // SpeechSynthesis handles it silently, so we just pass the status through
  // rather than treating it as an application error.
  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  const py = upstream.body as TTSResponseBody;
  return jsonResponse(200, {
    audioUrl: py.audioUrl || '',
    durationMs: py.durationMs || 0,
    provider: py.provider || 'qwen3-tts',
    voice: py.voice || '',
    cacheHit: Boolean(py.cacheHit)
  });
};
