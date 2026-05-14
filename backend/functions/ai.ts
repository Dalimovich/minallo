// POST /api/ai — thin proxy to the Python /chat endpoint.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

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

  const upstream = await forwardToPython('chat', {
    userId: user.id,
    system: incoming.system,
    messages: incoming.messages,
    max_tokens: incoming.max_tokens,
    model: incoming.model
  });
  return jsonResponse(upstream.status, upstream.body);
};
