// POST /api/ai/german-exam/grade-listening-item — grade one submitted Hören answer.
//
// Closes the answer-key exposure audited 2026-10-10: the generated (AI) Hören path used to embed
// every answer field (matching.correctSpeakerId, mc3.correctIndex, note.correctFill,
// tristate.answer) directly in the generate response, graded client-side in practice.js. That
// content is now stripped server-side at generation time (german_exam_generator.
// _secure_listening_envelope) and held in public.german_exam_listening_practice_generations; this
// endpoint is the only way to learn whether an answer was correct — it forwards to python-ai's
// POST /german-exam/listening/grade-item, which reads that server-held state back by
// (generationId, userId, questionId) and never trusts anything else the browser supplies.
//
// Auth + light rate limit only, same "cheap, no AI call" classification as
// ai-german-exam-results.ts: this is a deterministic lookup+compare, not a generation or an LLM
// grading call, so it stays out of the subscription/generation-cap gates those use.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

// Rate limit sizing, reviewed 2026-10-10: for a 3-4 option answer space (listening_tristate,
// the mc3 types), NO rate limit that still allows normal retries (the UI's own hint flow attempts
// twice per question) meaningfully stops a scripted client from learning one specific question's
// answer — that takes at most 3-4 calls regardless of the hourly ceiling. This is an inherent
// property of any "check my answer" API that reveals correct/incorrect per submission, not a gap
// unique to this endpoint (the same is true of every multiple-choice quiz product). What a lower
// ceiling actually bounds is ACCOUNT-LEVEL scale: how many DIFFERENT questions across however
// many generations one account can enumerate this way per hour. 120/hour comfortably covers
// legitimate use (a full Hören part is ~6-9 questions, at most a few retries each, and a learner
// doing several parts in one sitting) while cutting the previous 300 ceiling closer to that
// actual legitimate ceiling.
const RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_GRADE_LISTENING_RATE_LIMIT_MAX', '120'), 10);
const RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_GRADE_LISTENING_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);

interface GradeListeningItemResponseBody {
  questionId?: string;
  correct?: boolean;
  correctAnswer?: unknown;
  evidenceSegmentIds?: string[];
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
    'ai_german_exam_grade_listening_item',
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW,
    'Too many answer checks. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const generationId = body.generationId;
  const questionId = body.questionId;
  const selected = body.selected;

  if (typeof generationId !== 'string' || !generationId) return fail(400, 'generationId is required');
  if (typeof questionId !== 'string' || !questionId) return fail(400, 'questionId is required');
  if (typeof selected !== 'string' && typeof selected !== 'number') return fail(400, 'selected is required');

  await logSecurityEvent(serviceKey, user.id, 'ai_german_exam_grade_listening_item', { questionId });

  // userId is the Supabase-verified user above, never anything the request body could supply —
  // see GradeListeningItemRequest's own docstring in app/routers/german_exam.py for why that
  // model has no field a client could use to replace the stored answer.
  const upstream = await forwardToPython<GradeListeningItemResponseBody>('german-exam/listening/grade-item', {
    userId: user.id,
    generationId,
    questionId,
    selected
  });

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
