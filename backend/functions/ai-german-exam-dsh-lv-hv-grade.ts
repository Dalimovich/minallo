// POST /api/ai/german-exam/dsh/lv-hv/grade — DSH Leseverstehen/Hörverstehen PRACTICE grading.
// Companion to ai-german-exam-dsh-lv-hv-generate.ts — see that file's header for the full
// architecture note (practice-only, not the generic /api/ai/german-exam/* path, DSH stays
// available=false everywhere).
//
// This request carries ONLY `part`, `generationId` and the learner's `answers` — there is no
// field for grading content of any kind, and none is accepted: python-ai's
// dsh_lv_hv_grade_endpoint claims its OWN server-held state (public.
// dsh_lv_hv_practice_generations) by generationId + the authenticated user.id below, atomically,
// exactly once, before expiry. A client cannot submit replacement grading content because there
// is nowhere in this request shape to put it, and python-ai ignores any extra field anyway.
//
// Reuses exactly the existing production infrastructure (auth, active-subscription gate,
// generation cap, event rate limiting, security logging, forwardToPython) — grading calls a
// real LLM content_matcher, so it is gated exactly like generation, same as
// ai-german-exam-grade-writing.ts's own reasoning for grading a Schreiben submission.

import { jsonResponse, fail, handleOptions, upstreamFailureResponse } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const GRADE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_DSH_LV_HV_GRADE_RATE_LIMIT_MAX', '20'), 10);
const GRADE_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_DSH_LV_HV_GRADE_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);
const GRADE_UPSTREAM_TIMEOUT_MS = parseInt(optionalEnv('AI_GERMAN_EXAM_DSH_LV_HV_GRADE_UPSTREAM_TIMEOUT_MS', '105000'), 10);

const VALID_PARTS = ['lv', 'hv'];
const MAX_GENERATION_ID_LENGTH = 80;
const MAX_ITEM_ID_LENGTH = 80;
const MAX_ANSWER_LENGTH = 8000;
const MAX_ANSWERS = 100;

interface GradeResponseBody {
  [key: string]: unknown;
  error?: string;
}

interface AnswerInput {
  itemId: unknown;
  answer: unknown;
}

/** Request-shape check only; python-ai re-validates and is the only thing that ever reads the
 * actual stored grading content. */
export function validateAnswersShape(answers: unknown): string | null {
  if (!Array.isArray(answers)) return 'answers must be an array';
  if (answers.length > MAX_ANSWERS) return `answers must have at most ${MAX_ANSWERS} entries`;
  for (const entry of answers as AnswerInput[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'each answer must be an object';
    if (typeof entry.itemId !== 'string' || !entry.itemId || entry.itemId.length > MAX_ITEM_ID_LENGTH) {
      return 'each answer needs a valid itemId';
    }
    if (entry.answer !== undefined && (typeof entry.answer !== 'string' || entry.answer.length > MAX_ANSWER_LENGTH)) {
      return 'answer text is invalid or too long';
    }
  }
  return null;
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
  const generationId = body.generationId;
  if (typeof generationId !== 'string' || !generationId || generationId.length > MAX_GENERATION_ID_LENGTH) {
    return fail(400, 'generationId is required');
  }
  const answers = body.answers ?? [];
  const shapeError = validateAnswersShape(answers);
  if (shapeError) return fail(400, shapeError);

  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_german_exam_dsh_lv_hv_grade');
  if (subBlocked) return subBlocked;

  const capped = await enforceGenerationCap(serviceKey, user.id);
  if (capped) return capped;

  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_german_exam_dsh_lv_hv_grade',
    GRADE_RATE_LIMIT_MAX,
    GRADE_RATE_LIMIT_WINDOW,
    'DSH practice grading limit reached. Please try again later.'
  );
  if (limited) return limited;

  await logSecurityEvent(serviceKey, user.id, 'ai_german_exam_dsh_lv_hv_grade', { part, generation_id: generationId });

  // userId is user.id from the verified token above — never anything from `body` — so a
  // browser can never choose which user's generation it is grading.
  const upstream = await forwardToPython<GradeResponseBody>(
    'german-exam/dsh/lv-hv/grade',
    { userId: user.id, part, generationId, answers },
    GRADE_UPSTREAM_TIMEOUT_MS
  );

  if (!upstream.ok) return upstreamFailureResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
