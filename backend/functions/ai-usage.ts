// GET /api/ai/usage — current user's AI-call usage for this calendar month.
//
// Returns two independent counters:
//   • interactive: chat / RAG / writing-coach / stream asks (large cap)
//   • generation: quiz / flashcards / notes summaries (smaller cap)
// The frontend renders one banner per bucket once it crosses 80% of its cap.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import {
  INTERACTIVE_MONTHLY_CAP,
  GENERATION_MONTHLY_CAP,
  countInteractiveEventsThisMonth,
  countGenerationEventsThisMonth
} from '../lib/rate-limit';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

function _startOfNextMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
}

function _bucket(used: number, limit: number): {
  used: number; limit: number; remaining: number; percentUsed: number;
} {
  const percentUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return { used, limit, remaining: Math.max(0, limit - used), percentUsed };
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return fail(405, 'Method not allowed');
  }

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const [interactiveUsed, generationUsed] = await Promise.all([
    countInteractiveEventsThisMonth(serviceKey, user.id),
    countGenerationEventsThisMonth(serviceKey, user.id)
  ]);
  const interactive = _bucket(interactiveUsed, INTERACTIVE_MONTHLY_CAP);
  const generation = _bucket(generationUsed, GENERATION_MONTHLY_CAP);
  const resetsAt = _startOfNextMonthIso();

  return jsonResponse(200, {
    interactive: { ...interactive, resetsAt },
    generation: { ...generation, resetsAt },
    resetsAt,
    // Back-compat fields for any client still on the single-counter shape.
    // Reports the bucket closest to its cap so old UIs still warn correctly.
    used: interactive.percentUsed >= generation.percentUsed ? interactive.used : generation.used,
    limit: interactive.percentUsed >= generation.percentUsed ? interactive.limit : generation.limit,
    remaining: interactive.percentUsed >= generation.percentUsed ? interactive.remaining : generation.remaining,
    percentUsed: Math.max(interactive.percentUsed, generation.percentUsed)
  });
};
