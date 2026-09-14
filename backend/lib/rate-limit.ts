import { supaRequest } from './supabase-admin';
import { getCorsHeaders } from './cors';
import { logSecurityEvent } from './logger';
import { optionalEnv } from './env';
import type { LambdaResponse } from './types';

// ── Monthly Fair-Use caps (split: interactive vs. generation) ──────────────
//
// Interactive AI (chat / RAG asks / writing coach / ask-stream) is cheap
// per-call (~$0.001 on gpt-4o-mini), so the cap is generous. Bulk generation
// (flashcards / quizzes / notes summary) costs more per output token and is
// the realistic abuse vector, so its cap is tighter. Both reset on the 1st
// of each UTC month.

/** @deprecated kept exported for backward compat — used to be the single
 *  combined cap. Now split into interactive + generation. */
export const AI_MONTHLY_CAP = parseInt(optionalEnv('AI_MONTHLY_CAP', '2000'), 10);

/** Combined chat / RAG / writing-coach / streaming asks. */
export const INTERACTIVE_MONTHLY_CAP = parseInt(
  optionalEnv('INTERACTIVE_MONTHLY_CAP', '2000'),
  10
);
/** Notes + quiz + flashcard generation (each item = one event). */
export const GENERATION_MONTHLY_CAP = parseInt(
  optionalEnv('GENERATION_MONTHLY_CAP', '200'),
  10
);

const INTERACTIVE_EVENT_TYPES = [
  'ai_ask',
  'ai_chat',
  'writing_coach_analyse',
  'ask_stream'
] as const;

const GENERATION_EVENT_TYPES = [
  'ai_generate',
  'notes_generate'
] as const;

// Counts recent security_events for a user within a rolling window.
export async function countRecentEvents(
  serviceKey: string,
  userId: string,
  eventType: string,
  windowMs: number
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const path =
    'security_events?user_id=eq.' + encodeURIComponent(userId) +
    '&event_type=eq.' + encodeURIComponent(eventType) +
    '&created_at=gte.' + encodeURIComponent(since) +
    '&select=id';
  const res = await supaRequest<unknown[]>('GET', path, null, serviceKey);
  return Array.isArray(res.body) ? res.body.length : 0;
}

// Counts recent messages for a user within a rolling window (chat rate limit).
export async function countRecentMessages(
  serviceKey: string,
  userId: string,
  windowMs: number
): Promise<number> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const path =
    'messages?user_id=eq.' + encodeURIComponent(userId) +
    '&created_at=gte.' + encodeURIComponent(since) +
    '&select=id';
  const res = await supaRequest<unknown[]>('GET', path, null, serviceKey);
  return Array.isArray(res.body) ? res.body.length : 0;
}

// Returns a 429 response with Retry-After header.
export function rateLimitResponse(windowMs: number, message?: string): LambdaResponse {
  return {
    statusCode: 429,
    headers: {
      ...getCorsHeaders(),
      'Retry-After': String(Math.ceil(windowMs / 1000))
    },
    body: JSON.stringify({ error: { message: message || 'Rate limit exceeded. Try again soon.' } })
  };
}

export async function enforceEventRateLimit(
  serviceKey: string,
  userId: string,
  eventType: string,
  maxEvents: number,
  windowMs: number,
  message?: string,
  metadata?: Record<string, unknown>
): Promise<LambdaResponse | null> {
  const count = await countRecentEvents(serviceKey, userId, eventType, windowMs);
  if (count < maxEvents) return null;
  await logSecurityEvent(serviceKey, userId, eventType + '_rate_limited', {
    count,
    ...(metadata || {})
  });
  return rateLimitResponse(windowMs, message);
}

// ── Calendar-month helpers ──────────────────────────────────────────────────

function _startOfMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

function _startOfNextMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
}

async function _countEventsThisMonth(
  serviceKey: string,
  userId: string,
  eventTypes: readonly string[]
): Promise<number> {
  const since = _startOfMonthIso();
  const types = eventTypes.map(encodeURIComponent).join(',');
  const path =
    'security_events?user_id=eq.' + encodeURIComponent(userId) +
    '&event_type=in.(' + types + ')' +
    '&created_at=gte.' + encodeURIComponent(since) +
    '&select=id';
  const res = await supaRequest<unknown[]>('GET', path, null, serviceKey);
  return Array.isArray(res.body) ? res.body.length : 0;
}

export async function countInteractiveEventsThisMonth(
  serviceKey: string,
  userId: string
): Promise<number> {
  return _countEventsThisMonth(serviceKey, userId, INTERACTIVE_EVENT_TYPES);
}

export async function countGenerationEventsThisMonth(
  serviceKey: string,
  userId: string
): Promise<number> {
  return _countEventsThisMonth(serviceKey, userId, GENERATION_EVENT_TYPES);
}

/** @deprecated retained for the existing /api/ai/usage callers; sums both
 *  counters into one combined number. New code should call the split helpers. */
export async function countAiEventsThisMonth(
  serviceKey: string,
  userId: string
): Promise<number> {
  return _countEventsThisMonth(serviceKey, userId, [
    ...INTERACTIVE_EVENT_TYPES,
    ...GENERATION_EVENT_TYPES
  ]);
}

type Bucket = 'interactive' | 'generation';

function _capBlockedResponse(
  bucket: Bucket,
  count: number,
  cap: number
): LambdaResponse {
  const secondsUntilReset = Math.max(
    60,
    Math.floor((new Date(_startOfNextMonthIso()).getTime() - Date.now()) / 1000)
  );
  const friendly =
    bucket === 'interactive'
      ? "You've reached this month's chat + tutor allowance (" +
        cap +
        ' AI calls). Resets on the 1st of next month.'
      : "You've reached this month's quiz / flashcard / notes generation allowance (" +
        cap +
        ' bulk operations). Chat and tutor still work. Resets on the 1st of next month.';
  return {
    statusCode: 429,
    headers: {
      ...getCorsHeaders(),
      'Retry-After': String(secondsUntilReset)
    },
    body: JSON.stringify({
      error: {
        code: 'ai_monthly_cap',
        bucket,
        message: friendly,
        used: count,
        limit: cap,
        resetsAt: _startOfNextMonthIso()
      }
    })
  };
}

/** Enforce the interactive (chat / RAG / writing-coach / stream) bucket. */
export async function enforceInteractiveCap(
  serviceKey: string,
  userId: string,
  cap: number = INTERACTIVE_MONTHLY_CAP
): Promise<LambdaResponse | null> {
  const count = await countInteractiveEventsThisMonth(serviceKey, userId);
  if (count < cap) return null;
  await logSecurityEvent(serviceKey, userId, 'ai_monthly_cap_blocked', {
    bucket: 'interactive',
    count,
    cap
  }).catch(() => undefined);
  return _capBlockedResponse('interactive', count, cap);
}

/** Enforce the generation (quiz / flashcards / notes) bucket. */
export async function enforceGenerationCap(
  serviceKey: string,
  userId: string,
  cap: number = GENERATION_MONTHLY_CAP
): Promise<LambdaResponse | null> {
  const count = await countGenerationEventsThisMonth(serviceKey, userId);
  if (count < cap) return null;
  await logSecurityEvent(serviceKey, userId, 'ai_monthly_cap_blocked', {
    bucket: 'generation',
    count,
    cap
  }).catch(() => undefined);
  return _capBlockedResponse('generation', count, cap);
}

/** @deprecated wrapper. Routes to interactive bucket so existing call sites
 *  in ai-ask / ai-writing-coach / ai (chat) keep working with the old call
 *  shape `enforceMonthlyAiCap(serviceKey, userId, cap)`. New code should call
 *  enforceInteractiveCap or enforceGenerationCap directly. */
export async function enforceMonthlyAiCap(
  serviceKey: string,
  userId: string,
  cap?: number
): Promise<LambdaResponse | null> {
  return enforceInteractiveCap(serviceKey, userId, cap ?? INTERACTIVE_MONTHLY_CAP);
}
