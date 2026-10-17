// POST /api/ai/german-exam/grade-speaking-recording — grade a learner's single-recording
// Sprechen submission (TestDaF-style independent speaking task), via python-ai's existing
// POST /german-exam/grade-speaking-recording endpoint (german_exam.py's
// grade_speaking_recording_endpoint -> testdaf_speaking.grade_testdaf_speaking_recording).
//
// This has been a genuine gap: the python-ai endpoint, its grading service
// (german_exam_testdaf_speaking.py), and the frontend caller (speaking-grader.ts's
// createSpeakingRecordingGrader, via writingExamRequest) have all existed and called this exact
// path, but no Cloudflare Pages Function handler was ever written for it -- the request has been
// 404ing at the edge. Modeled directly on ai-german-exam-grade-writing.ts (same profile/part/task
// shape, same auth/subscription/cap/rate-limit stack) and ai-german-exam-speaking.ts (same
// audio-size cap and isGermanSpeakingEnabled() gate, since this is also a transcription+grading
// speech-cost path). No recording is ever stored server-side -- the audio is transcribed and
// graded within this one request, then discarded (see german_exam_testdaf_speaking.py).

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { isRegisteredExamProfileId } from '../lib/german-learner-profile';
import { checkExamPart, isIdentifier } from '../lib/german-exam-manifest';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { isGermanSpeakingEnabled } from '../lib/feature-flags';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const GRADE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GERMAN_EXAM_GRADE_SPEAKING_RECORDING_RATE_LIMIT_MAX', '20'), 10);
const GRADE_RATE_LIMIT_WINDOW = parseInt(
  optionalEnv('AI_GERMAN_EXAM_GRADE_SPEAKING_RECORDING_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)),
  10
);
// Transcription + grading in one upstream call -- same reasoning as the DSH LV/HV generate
// endpoint's extended budget: python's own work takes a while, this just needs to outlast it
// while staying under Cloudflare's edge timeout.
const GRADE_UPSTREAM_TIMEOUT_MS = parseInt(optionalEnv('AI_GERMAN_EXAM_GRADE_SPEAKING_RECORDING_UPSTREAM_TIMEOUT_MS', '60000'), 10);

// Matches python-ai's GradeSpeakingRecordingRequest.audioBase64 cap exactly.
const MAX_AUDIO_BASE64_CHARS = 8 * 1024 * 1024;
const MAX_MIME_TYPE_CHARS = 100;
const MAX_TASK_JSON_CHARS = 60000; // same cap grade-writing.ts uses for its own `task` field

interface GradeSpeakingResponseBody {
  [key: string]: unknown;
  error?: string;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  // Every request to this endpoint is a speech-cost request (transcription + LLM grading) --
  // reject before touching auth or any paid-usage accounting, same as ai-german-exam-speaking.ts.
  if (!isGermanSpeakingEnabled()) return fail(403, 'Speaking practice is temporarily unavailable.');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');
  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_german_exam_grade_speaking_recording');
  if (subBlocked) return subBlocked;

  const capped = await enforceGenerationCap(serviceKey, user.id);
  if (capped) return capped;

  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_german_exam_grade_speaking_recording',
    GRADE_RATE_LIMIT_MAX,
    GRADE_RATE_LIMIT_WINDOW,
    'Speaking grading limit reached. Please try again later.'
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
  const task = body.task as Record<string, unknown> | undefined;
  const audioBase64 = body.audioBase64;
  const mimeTypeRaw = body.mimeType;
  const durationSeconds = body.durationSeconds;

  if (!isRegisteredExamProfileId(profileId)) return fail(400, 'invalid or unsupported profileId');
  if (!isIdentifier(partId) || (await checkExamPart(profileId, 'speaking', partId)) === 'unknown') {
    return fail(400, 'invalid or unsupported partId');
  }
  if (!task || typeof task !== 'object' || Array.isArray(task) || JSON.stringify(task).length > MAX_TASK_JSON_CHARS) {
    return fail(400, 'task must be an object');
  }
  if (typeof audioBase64 !== 'string' || !audioBase64 || audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
    return fail(413, 'Recording is missing or too large');
  }
  const mimeType = typeof mimeTypeRaw === 'string' && mimeTypeRaw.length <= MAX_MIME_TYPE_CHARS ? mimeTypeRaw : 'audio/webm';
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return fail(400, 'durationSeconds must be a non-negative number');
  }

  await logSecurityEvent(serviceKey, user.id, 'ai_german_exam_grade_speaking_recording', {
    profile_id: profileId,
    part_id: partId
  });

  const upstream = await forwardToPython<GradeSpeakingResponseBody>(
    'german-exam/grade-speaking-recording',
    { userId: user.id, profileId, partId, task, audioBase64, mimeType, durationSeconds },
    GRADE_UPSTREAM_TIMEOUT_MS
  );

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  return jsonResponse(200, upstream.body);
};
