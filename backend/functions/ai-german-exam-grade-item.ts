// POST /api/ai/german-exam/grade-item — grade one submitted Reading/Sprachbausteine answer.
//
// Generalizes ai-german-exam-grade-listening-item.ts beyond listening: QA run 2 (2026-10-12)
// found the generated (AI) Reading and Sprachbausteine paths embedded every answer field
// (correctIndex, correctCandidateId, correctSectionId, correctAuthorId, correctHeadingId,
// answerId, tristate.answer, evidenceParagraphIds/evidenceQuote/evidenceIds) directly in the
// generate response, graded client-side in practice.js. That content is now stripped server-side
// at generation time (german_exam_generator._secure_envelope) for every module, the same way
// listening already was, and held in public.german_exam_listening_practice_generations (table
// name is historical — the shape is module-agnostic). This endpoint is the only way to learn
// whether a Reading/Sprachbausteine answer was correct — it forwards to python-ai's POST
// /german-exam/grade-item, which reads that server-held state back by (generationId, userId,
// questionId) and never trusts anything else the browser supplies.
//
// Auth + light rate limit only, same "cheap, no AI call" classification as
// ai-german-exam-grade-listening-item.ts: a deterministic lookup+compare, not a generation or an
// LLM grading call.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

// Same sizing rationale as ai-german-exam-grade-listening-item.ts's RATE_LIMIT_MAX: no rate limit
// that still allows normal retries meaningfully stops a scripted client from learning one
// specific question's answer. 120/hour comfortably covers a learner doing several Reading/
// Sprachbausteine parts in one sitting.
const RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_GRADE_ITEM_RATE_LIMIT_MAX', '120'), 10);
const RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_GRADE_ITEM_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);

interface GradeItemResponseBody {
  questionId?: string;
  correct?: boolean;
  correctAnswer?: unknown;
  evidenceParagraphIds?: string[];
  evidenceQuote?: string | null;
  evidenceIds?: string[];
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
    'ai_german_exam_grade_item',
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

  await logSecurityEvent(serviceKey, user.id, 'ai_german_exam_grade_item', { questionId });

  // userId is the Supabase-verified user above, never anything the request body could supply —
  // see GradeItemRequest's own docstring in app/routers/german_exam.py for why that model has no
  // field a client could use to replace the stored answer.
  const upstream = await forwardToPython<GradeItemResponseBody>('german-exam/grade-item', {
    userId: user.id,
    generationId,
    questionId,
    selected
  });

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
