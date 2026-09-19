// POST /api/ai/german-exam/grade-writing — grade a learner's Schreiben
// submission for a generated telc C1 Hochschule writing task.
//
// This is a SEPARATE endpoint from /german-exam/generate + /german-exam/
// results on purpose (see german_exam_writing_grading.py's module
// docstring): generation produces the two topics and is verified by the
// shared objective-exercise pipeline; THIS call analyses the learner's own
// free-text essay via the existing Writing Coach evaluator
// (writing_coach.analyse_writing — reused, not duplicated) and returns a
// rubric mapped onto the official telc dimensions, plus a ready-to-submit
// examResultItems array the frontend forwards verbatim to
// POST /german-exam/results (same pattern Lesen/Hören use after grading
// client-side; here the "grading" step just happens to need a real LLM
// call instead of a client-side comparison).
//
// Real prose analysis is a real OpenAI call — same generation-cap/rate-limit/
// subscription gating as /german-exam/generate, not the cheap bucket
// /german-exam/results uses.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const GRADE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_GRADE_WRITING_RATE_LIMIT_MAX', '20'), 10);
const GRADE_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_GRADE_WRITING_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);
const GRADE_UPSTREAM_TIMEOUT_MS = optionalEnv('AI_GERMAN_EXAM_GRADE_WRITING_UPSTREAM_TIMEOUT_MS', '')
  ? parseInt(optionalEnv('AI_GERMAN_EXAM_GRADE_WRITING_UPSTREAM_TIMEOUT_MS', ''), 10)
  : undefined;

const VALID_PROFILE_IDS = ['telc_c1_hochschule'];
const VALID_PART_IDS = ['schreiben_1'];
// Mirrors writing_coach.py's ALLOWED_TASK_TYPES — kept as a literal copy
// here (TS edge function, can't import the Python module) rather than a
// runtime dependency; python-ai re-validates this server-side regardless.
const VALID_WRITING_COACH_TASK_TYPES = [
  'email',
  'stellungnahme',
  'argumentation',
  'zusammenfassung',
  'bericht',
  'motivationsschreiben',
  'freier_text'
];
const MAX_TEXT_CHARS = 8000; // matches writing_coach.py's own cap

interface GradeWritingResponseBody {
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

  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_german_exam_grade_writing');
  if (subBlocked) return subBlocked;

  const capped = await enforceGenerationCap(serviceKey, user.id);
  if (capped) return capped;

  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_german_exam_grade_writing',
    GRADE_RATE_LIMIT_MAX,
    GRADE_RATE_LIMIT_WINDOW,
    'Writing grading limit reached. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return fail(400, 'Invalid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Invalid body');

  const profileId = body.profileId;
  const partId = body.partId;
  const topicId = body.topicId;
  const generationId = body.generationId;
  const writingCoachTaskTypeRaw = body.writingCoachTaskType;
  const text = body.text;
  const selectedTopic = body.selectedTopic as Record<string, unknown> | undefined;
  if (!selectedTopic || typeof selectedTopic !== 'object' || Array.isArray(selectedTopic) ||
      selectedTopic.questionId !== topicId ||
      !Array.isArray(selectedTopic.statements) || selectedTopic.statements.length !== 2 ||
      !selectedTopic.statements.every(s => typeof s === 'string' && s.trim() && s.length <= 2000) ||
      !['title', 'communicativeSituation', 'taskInstructions'].every(key =>
        typeof selectedTopic[key] === 'string' && (selectedTopic[key] as string).trim().length > 0 &&
        (selectedTopic[key] as string).length <= 6000)) {
    return fail(400, 'selectedTopic with title, situation and instructions is required');
  }

  if (typeof profileId !== 'string' || !VALID_PROFILE_IDS.includes(profileId)) {
    return fail(400, 'invalid or unsupported profileId');
  }
  if (typeof partId !== 'string' || !VALID_PART_IDS.includes(partId)) {
    return fail(400, 'invalid or unsupported partId');
  }
  if (typeof topicId !== 'string' || !topicId) {
    return fail(400, 'topicId is required');
  }
  if (typeof text !== 'string' || !text.trim()) {
    return fail(400, 'text is required');
  }
  if (text.length > MAX_TEXT_CHARS) {
    return fail(400, `text is too long (max ${MAX_TEXT_CHARS} characters)`);
  }
  const writingCoachTaskType =
    typeof writingCoachTaskTypeRaw === 'string' && VALID_WRITING_COACH_TASK_TYPES.includes(writingCoachTaskTypeRaw)
      ? writingCoachTaskTypeRaw
      : 'freier_text';

  await logSecurityEvent(serviceKey, user.id, 'ai_german_exam_grade_writing', {
    profile_id: profileId,
    part_id: partId,
    topic_id: topicId
  });

  const upstream = await forwardToPython<GradeWritingResponseBody>(
    'german-exam/grade-writing',
    {
      userId: user.id,
      profileId,
      partId,
      topicId,
      generationId: typeof generationId === 'string' ? generationId : null,
      writingCoachTaskType,
      selectedTopic,
      text
    },
    GRADE_UPSTREAM_TIMEOUT_MS
  );

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
