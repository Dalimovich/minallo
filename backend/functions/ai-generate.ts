// POST /api/ai/generate — proxy to Python /generate-{quiz,flashcards,notes}.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceGenerationCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const _LETTERS = ['A', 'B', 'C', 'D'] as const;
const AI_GENERATE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GENERATE_RATE_LIMIT_MAX', '30'), 10);
const AI_GENERATE_RATE_LIMIT_WINDOW = parseInt(optionalEnv('AI_GENERATE_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const MAX_DOCUMENT_IDS = 25;
const MAX_REQUESTED_COUNT = 50;
const MAX_TOPIC_LENGTH = 500;

interface PyQuizQuestion {
  type?: string;
  options?: Record<string, unknown>;
  answer?: string | number;
  [k: string]: unknown;
}

interface PyResponse {
  questions?: PyQuizQuestion[];
  cards?: unknown[];
  text?: string;
  groundedSources?: unknown[];
  warning?: string;
}

function _normaliseQuizQuestions(questions: PyQuizQuestion[] | undefined): unknown[] {
  return (questions || []).map((q) => {
    if ((q.type || 'mcq') !== 'mcq') return q;
    const opts = q.options || {};
    const arr = _LETTERS.map((L) => (typeof opts[L] === 'string' ? (opts[L] as string) : ''));
    let ansIdx = -1;
    if (typeof q.answer === 'string') {
      const m = q.answer.trim().toUpperCase().match(/^([A-D])/);
      if (m && m[1]) ansIdx = _LETTERS.indexOf(m[1] as 'A' | 'B' | 'C' | 'D');
    } else if (typeof q.answer === 'number') {
      ansIdx = q.answer;
    }
    return { ...q, options: arr, answer: ansIdx };
  });
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

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const courseId = body.courseId;
  const tool = body.tool;
  const topic = body.topic;
  const count = body.count;
  const difficulty = body.difficulty;
  const rawDocumentIds = (body.documentIds ?? body.docIds) as unknown;
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (typeof tool !== 'string' || !['flashcards', 'quiz', 'summary'].includes(tool)) {
    return fail(400, 'tool must be flashcards, quiz, or summary');
  }

  if (typeof topic === 'string' && topic.length > MAX_TOPIC_LENGTH) return fail(400, 'topic is too long');
  const docIds = Array.isArray(rawDocumentIds) && rawDocumentIds.length
    ? (rawDocumentIds as string[]).slice(0, MAX_DOCUMENT_IDS)
    : null;
  const requestedCount = Math.min(
    Math.max(parseInt(String(count), 10) || (tool === 'flashcards' ? 10 : 8), 1),
    MAX_REQUESTED_COUNT
  );
  await logSecurityEvent(serviceKey, user.id, 'ai_generate', {
    course_id: courseId,
    tool,
    requested_count: requestedCount,
    document_count: docIds ? docIds.length : 0
  });

  let endpoint: string;
  let pyPayload: Record<string, unknown>;
  if (tool === 'quiz') {
    endpoint = 'generate-quiz';
    pyPayload = {
      userId: user.id, courseId, documentIds: docIds,
      requestedCount, difficulty: (typeof difficulty === 'string' ? difficulty : 'medium'),
      // The quiz UI only renders MCQ (4-option buttons). Backend defaults to
      // mixing mcq + true_false + short_answer, which produced items with
      // no options field — the frontend then rendered 4 blank buttons. Lock
      // generation to MCQ until we add UIs for the other types.
      questionTypes: ['mcq'],
      save: false
    };
  } else if (tool === 'flashcards') {
    endpoint = 'generate-flashcards';
    pyPayload = { userId: user.id, courseId, documentIds: docIds, requestedCount, save: false };
  } else {
    endpoint = 'generate-notes';
    pyPayload = { userId: user.id, courseId, documentIds: docIds, topic: topic ?? null, save: false };
  }

  const upstream = await forwardToPython<PyResponse>(endpoint, pyPayload);
  if (!upstream.ok) {
    const err = (upstream.body as { error?: string }).error;
    return jsonResponse(200, {
      tool, items: [], text: '', sources: [],
      error: 'AI generation is temporarily unavailable: ' + (err || 'upstream ' + upstream.status)
    });
  }

  const py = upstream.body as PyResponse;
  let mapped: Record<string, unknown>;
  if (tool === 'summary') {
    mapped = { tool, items: [], text: py.text || '', sources: py.groundedSources || [] };
  } else if (tool === 'quiz') {
    mapped = { tool, items: _normaliseQuizQuestions(py.questions), sources: py.groundedSources || [] };
  } else {
    mapped = { tool, items: py.cards || [], sources: py.groundedSources || [] };
  }
  if (py.warning) mapped.error = py.warning;
  return jsonResponse(200, mapped);
};
