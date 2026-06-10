// POST /api/ai/deep-learn — proxy to the Python Deep Learn endpoint.
//
// Learning Agent Phase 5. Generates a grounded, single-topic deep-dive
// (explanation → worked example → self-check) from the user's own materials.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const AI_GENERATE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GENERATE_RATE_LIMIT_MAX', '30'), 10);
const AI_GENERATE_RATE_LIMIT_WINDOW = parseInt(optionalEnv('AI_GENERATE_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const MAX_DOCUMENT_IDS = 25;
const MAX_TOPIC_LENGTH = 500;

interface PyDeepLearnResponse {
  noteId?: string | null;
  topic?: string;
  title?: string | null;
  lesson?: string;
  workedExample?: string;
  structuredLesson?: unknown;
  check?: unknown;
  groundedSources?: unknown[];
  citationWarning?: string;
  evidenceSummary?: Record<string, number>;
  warning?: string;
  error?: string;
}

function _docIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_DOCUMENT_IDS);
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
  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_generate');
  if (subBlocked) return subBlocked;

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const courseId = body.courseId;
  const topic = body.topic;
  const lessonMode = body.lessonMode;
  const lessonLanguage = body.lessonLanguage;
  // Personalization the lesson prompt consumes (deep_learn._student_context_prompt).
  const courseName = typeof body.courseName === 'string' ? body.courseName : null;
  const studentMajor = typeof body.studentMajor === 'string' ? body.studentMajor : null;
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (!topic || typeof topic !== 'string' || !topic.trim()) return fail(400, 'topic is required');
  if (topic.length > MAX_TOPIC_LENGTH) return fail(400, 'topic is too long');
  const docIds = _docIds(body.documentIds ?? body.docIds);

  const monthlyCapped = await enforceGenerationCap(serviceKey, user.id);
  if (monthlyCapped) return monthlyCapped;
  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_generate',
    AI_GENERATE_RATE_LIMIT_MAX,
    AI_GENERATE_RATE_LIMIT_WINDOW,
    'Generation limit reached. Please try again later.'
  );
  if (limited) return limited;

  await logSecurityEvent(serviceKey, user.id, 'ai_generate', {
    course_id: courseId,
    tool: 'deep_learn',
    document_count: docIds ? docIds.length : 0,
  });

  const upstream = await forwardToPython<PyDeepLearnResponse>('generate-deep-learn', {
    userId: user.id,
    courseId,
    topic,
    documentIds: docIds,
    lessonMode: typeof lessonMode === 'string' ? lessonMode : null,
    lessonLanguage: typeof lessonLanguage === 'string' ? lessonLanguage : null,
    courseName,
    studentMajor,
  });
  if (!upstream.ok) {
    const err = (upstream.body as { error?: string }).error;
    return jsonResponse(200, {
      topic,
      title: topic,
      lesson: '',
      workedExample: '',
      check: null,
      groundedSources: [],
      error: 'Deep Learn is temporarily unavailable: ' + (err || 'upstream ' + upstream.status),
    });
  }
  return jsonResponse(200, upstream.body);
};
