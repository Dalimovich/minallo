// POST /api/ai/examforge - proxy to Python ExamForge endpoints.

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
const MAX_REQUESTED_COUNT = 20;
const MAX_TOPIC_LENGTH = 500;
const VALID_QUESTION_TYPES = new Set(['mcq', 'true_false', 'short_answer']);

interface PyExamForgeResponse {
  sessionId?: string | null;
  title?: string;
  requestedCount?: number;
  actualCount?: number;
  questions?: unknown[];
  topicMap?: unknown[];
  groundedSources?: unknown[];
  warning?: string;
  error?: string;
}

interface PyQuizFallbackResponse {
  requestedCount?: number;
  actualCount?: number;
  questions?: unknown[];
  groundedSources?: unknown[];
  warning?: string;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  error?: string;
}

function _docIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_DOCUMENT_IDS);
}

function _questionTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ['mcq', 'true_false', 'short_answer'];
  const types = raw.filter((x): x is string => typeof x === 'string' && VALID_QUESTION_TYPES.has(x));
  return types.length ? types.slice(0, 3) : ['mcq', 'true_false', 'short_answer'];
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

  const action = typeof body.action === 'string' ? body.action : 'generate';
  if (action === 'grade') {
    const examSessionId = body.examSessionId;
    const examQuestionId = body.examQuestionId;
    const userAnswer = body.userAnswer;
    if (typeof examSessionId !== 'string') return fail(400, 'examSessionId is required');
    if (typeof examQuestionId !== 'string') return fail(400, 'examQuestionId is required');
    if (typeof userAnswer !== 'string') return fail(400, 'userAnswer is required');
    const upstream = await forwardToPython('grade-examforge-answer', {
      userId: user.id,
      examSessionId,
      examQuestionId,
      userAnswer,
    });
    return jsonResponse(upstream.ok ? 200 : 502, upstream.body);
  }

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

  const courseId = body.courseId;
  const topic = body.topic;
  const difficulty = body.difficulty;
  const count = body.count ?? body.requestedCount;
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (typeof topic === 'string' && topic.length > MAX_TOPIC_LENGTH) return fail(400, 'topic is too long');
  const requestedCount = Math.min(Math.max(parseInt(String(count), 10) || 6, 1), MAX_REQUESTED_COUNT);
  const docIds = _docIds(body.documentIds ?? body.docIds);
  const questionTypes = _questionTypes(body.questionTypes);

  await logSecurityEvent(serviceKey, user.id, 'ai_generate', {
    course_id: courseId,
    tool: 'examforge',
    requested_count: requestedCount,
    question_types: questionTypes,
    document_count: docIds ? docIds.length : 0,
  });

  const language = body.language;
  const upstream = await forwardToPython<PyExamForgeResponse>('generate-examforge', {
    userId: user.id,
    courseId,
    documentIds: docIds,
    requestedCount,
    difficulty: typeof difficulty === 'string' ? difficulty : 'medium',
    questionTypes,
    topic: typeof topic === 'string' ? topic : null,
    language: typeof language === 'string' ? language : null,
    save: true,
  });
  if (!upstream.ok) {
    if (upstream.status === 404) {
      const fallback = await forwardToPython<PyQuizFallbackResponse>('generate-quiz', {
        userId: user.id,
        courseId,
        documentIds: docIds,
        requestedCount,
        difficulty: typeof difficulty === 'string' ? difficulty : 'medium',
        questionTypes,
        language: typeof language === 'string' ? language : null,
        save: false,
      });
      if (fallback.ok) {
        // The quiz fallback produces questions that were never persisted to
        // exam_sessions/exam_questions, so they have no gradeable ids. Return
        // an error (not a fake-working exam) so the UI does not let the user
        // start an exam that can never be graded or tracked.
        return jsonResponse(200, {
          sessionId: null,
          title: typeof topic === 'string' && topic.trim() ? topic.trim() : 'ExamForge',
          requestedCount,
          actualCount: 0,
          questions: [],
          topicMap: [],
          groundedSources: [],
          error: 'ExamForge could not save this exam, so it cannot be graded. Please try again.',
        });
      }
    }
    const err = (upstream.body as { error?: string }).error;
    return jsonResponse(200, {
      sessionId: null,
      title: 'ExamForge',
      requestedCount,
      actualCount: 0,
      questions: [],
      topicMap: [],
      groundedSources: [],
      error: 'ExamForge is temporarily unavailable: ' + (err || 'upstream ' + upstream.status),
    });
  }
  return jsonResponse(200, upstream.body);
};
