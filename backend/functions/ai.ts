// POST /api/ai — thin proxy to the Python /chat endpoint.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceInteractiveCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const AI_CHAT_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_CHAT_RATE_LIMIT_MAX', '30'), 10);
const AI_CHAT_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_CHAT_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);

interface ChatRequestBody {
  system?: string;
  messages?: unknown;
  max_tokens?: number;
  model?: string;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Unauthorized');

  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired session');

  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_chat');
  if (subBlocked) return subBlocked;
  const monthlyCapped = await enforceInteractiveCap(serviceKey, user.id);
  if (monthlyCapped) return monthlyCapped;
  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_chat',
    AI_CHAT_RATE_LIMIT_MAX,
    AI_CHAT_RATE_LIMIT_WINDOW,
    'AI request limit reached. Please try again later.'
  );
  if (limited) return limited;

  let incoming: ChatRequestBody;
  try {
    const parsed = JSON.parse(event.body || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail(400, 'Invalid JSON body');
    }
    incoming = parsed as ChatRequestBody;
  } catch {
    return fail(400, 'Invalid JSON body');
  }

  await logSecurityEvent(serviceKey, user.id, 'ai_chat', {
    model: typeof incoming.model === 'string' ? incoming.model : null
  }).catch(() => undefined);

  const upstream = await forwardToPython('chat', {
    userId: user.id,
    system: incoming.system,
    messages: incoming.messages,
    max_tokens: incoming.max_tokens,
    model: incoming.model
  });
  return jsonResponse(upstream.status, upstream.body);
};
