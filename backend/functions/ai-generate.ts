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
const _VALID_QUESTION_TYPES = ['mcq', 'true_false', 'short_answer'] as const;
type QuestionType = (typeof _VALID_QUESTION_TYPES)[number];
const _DEFAULT_QUESTION_TYPES: QuestionType[] = ['mcq', 'true_false', 'short_answer'];
const AI_GENERATE_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_GENERATE_RATE_LIMIT_MAX', '30'), 10);
const AI_GENERATE_RATE_LIMIT_WINDOW = parseInt(optionalEnv('AI_GENERATE_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const MAX_DOCUMENT_IDS = 25;
const MAX_REQUESTED_COUNT = 50;
const MAX_TOPIC_LENGTH = 500;

interface PyQuizQuestion {
  type?: string;
  options?: Record<string, unknown>;
  answer?: string | number | boolean;
  acceptableAnswers?: unknown;
  [k: string]: unknown;
}

interface PyResponse {
  questions?: PyQuizQuestion[];
  cards?: unknown[];
  text?: string;
  groundedSources?: unknown[];
  warning?: string;
}

// Normalise the Python pipeline's per-type output into stable shapes the
// frontend can render and score, regardless of question type. The output
// shapes are intentionally additive so old MCQ-only consumers keep working:
//   - mcq:          { type:'mcq', options:string[4], answer:<0-3 index>, ... }
//   - true_false:   { type:'true_false', answer:boolean, ... }
//   - short_answer: { type:'short_answer', answer:string, acceptableAnswers:string[], ... }
function _normaliseMcq(q: PyQuizQuestion): unknown {
  const opts = q.options || {};
  const arr = _LETTERS.map((L) => (typeof opts[L] === 'string' ? (opts[L] as string) : ''));
  let ansIdx = -1;
  if (typeof q.answer === 'string') {
    const m = q.answer.trim().toUpperCase().match(/^([A-D])/);
    if (m && m[1]) ansIdx = _LETTERS.indexOf(m[1] as 'A' | 'B' | 'C' | 'D');
  } else if (typeof q.answer === 'number') {
    ansIdx = q.answer;
  }
  return { ...q, type: 'mcq', options: arr, answer: ansIdx };
}

function _coerceBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'wahr', 'yes', 'ja', 't', '1'].includes(v)) return true;
    if (['false', 'falsch', 'no', 'nein', 'f', '0'].includes(v)) return false;
  }
  return null;
}

function _normaliseTrueFalse(q: PyQuizQuestion): unknown {
  // Default an unparseable boolean to `true` so the item still renders/scores
  // deterministically rather than being dropped on the frontend.
  const ans = _coerceBool(q.answer);
  return { ...q, type: 'true_false', answer: ans == null ? true : ans };
}

function _normaliseShortAnswer(q: PyQuizQuestion): unknown {
  const primary = typeof q.answer === 'string' ? q.answer.trim() : String(q.answer ?? '').trim();
  // Collect the canonical answer plus any model-supplied acceptable variants
  // into a de-duplicated list the frontend scores case/whitespace-insensitively.
  const variants: string[] = [];
  const push = (s: unknown) => {
    if (typeof s === 'string' && s.trim()) variants.push(s.trim());
  };
  push(primary);
  const rawVariants = q.acceptableAnswers ?? (q as Record<string, unknown>).accepted ?? (q as Record<string, unknown>).alternatives;
  if (Array.isArray(rawVariants)) rawVariants.forEach(push);
  const seen = new Set<string>();
  const acceptableAnswers = variants.filter((v) => {
    const k = v.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { ...q, type: 'short_answer', answer: primary, acceptableAnswers };
}

export function _normaliseQuizQuestions(questions: PyQuizQuestion[] | undefined): unknown[] {
  return (questions || []).map((q) => {
    const type = (q.type || 'mcq').toString().trim().toLowerCase();
    if (type === 'true_false') return _normaliseTrueFalse(q);
    if (type === 'short_answer') return _normaliseShortAnswer(q);
    return _normaliseMcq(q);
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
  const language = typeof body.language === 'string' ? body.language : undefined;
  // Items the learner has already seen, so generation avoids repeats. Strip
  // non-strings and cap the list so a runaway client can't bloat the prompt.
  const seenItems = Array.isArray(body.seenItems)
    ? (body.seenItems as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 200)
    : undefined;
  // Question types the client wants (mcq | true_false | short_answer). Filter
  // to the known set; fall back to the full mix when absent/empty/garbage.
  const requestedTypes = Array.isArray(body.questionTypes)
    ? (body.questionTypes as unknown[]).filter(
        (t): t is QuestionType => typeof t === 'string' && (_VALID_QUESTION_TYPES as readonly string[]).includes(t)
      )
    : [];
  const questionTypes = requestedTypes.length ? Array.from(new Set(requestedTypes)) : _DEFAULT_QUESTION_TYPES;
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
      // Stage 2: the quiz UI now renders mcq + true_false + short_answer, so we
      // forward the learner's selected types (defaulting to the full mix).
      questionTypes,
      seenItems, language,
      save: false
    };
  } else if (tool === 'flashcards') {
    endpoint = 'generate-flashcards';
    pyPayload = {
      userId: user.id, courseId, documentIds: docIds, requestedCount,
      difficulty: (typeof difficulty === 'string' ? difficulty : 'medium'),
      seenItems, language,
      save: false
    };
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
