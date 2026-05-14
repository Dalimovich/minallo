// POST /api/ai/ask — thin proxy to the Python /ask endpoint.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const AI_ASK_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_ASK_RATE_LIMIT_MAX', '60'), 10);
const AI_ASK_RATE_LIMIT_WINDOW = parseInt(optionalEnv('AI_ASK_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const MAX_QUESTION_LENGTH = 8000;
const MAX_DOCUMENT_IDS = 25;

interface GroundedSource {
  fileName?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  sectionTitle?: string | null;
}

interface AskResponseBody {
  answer?: string;
  retrievalMode?: string;
  groundedSources?: GroundedSource[];
  cacheHit?: boolean;
  model?: string | null;
}

interface MappedSource {
  file_name: string;
  pages: string | null;
  section?: string | null;
}

function _mapSources(groundedSources: GroundedSource[] | undefined): MappedSource[] {
  return (groundedSources || []).map((s) => {
    const ps = s.pageStart ?? null;
    const pe = s.pageEnd ?? null;
    let pages: string | null = null;
    if (ps && pe) pages = ps === pe ? String(ps) : `${ps}-${pe}`;
    else if (ps) pages = String(ps);
    return { file_name: s.fileName || 'Unknown', pages, section: s.sectionTitle ?? null };
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
  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'ai_ask',
    AI_ASK_RATE_LIMIT_MAX,
    AI_ASK_RATE_LIMIT_WINDOW,
    'AI request limit reached. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const courseId = body.courseId;
  const question = body.question;
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (!question || typeof question !== 'string') return fail(400, 'question is required');
  if (question.length > MAX_QUESTION_LENGTH) return fail(400, 'question is too long');

  const documentIds: string[] | null = Array.isArray(body.documentIds)
    ? (body.documentIds as string[]).slice(0, MAX_DOCUMENT_IDS)
    : typeof body.documentId === 'string' ? [body.documentId] : null;
  await logSecurityEvent(serviceKey, user.id, 'ai_ask', {
    course_id: courseId,
    document_count: documentIds ? documentIds.length : 0
  });

  const upstream = await forwardToPython<AskResponseBody>('ask', {
    userId: user.id,
    courseId,
    documentIds,
    question,
    bypassCache: Boolean(body.bypassCache)
  });

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  const py = upstream.body as AskResponseBody;
  return jsonResponse(200, {
    answer: py.answer || '',
    retrievalMode: py.retrievalMode || 'strong',
    confidence: py.retrievalMode === 'strong' ? 'high' : 'low',
    unsupported: py.retrievalMode !== 'strong',
    sources: _mapSources(py.groundedSources),
    cacheHit: Boolean(py.cacheHit),
    model: py.model ?? null
  });
};
