// POST /api/ai/ask — thin proxy to the Python /ask endpoint.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit, enforceInteractiveCap } from '../lib/rate-limit';
import { requireActiveSubscription } from '../lib/subscription-gate';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

// Dropped from 60 → 30/hour. Matches the /ask-stream Python limit so the two
// surfaces share one budget. 30/hr × 24 ≈ 720/day, well below abusive but
// still ample for legitimate study use.
const AI_ASK_RATE_LIMIT_MAX = parseInt(optionalEnv('AI_ASK_RATE_LIMIT_MAX', '30'), 10);
const AI_ASK_RATE_LIMIT_WINDOW = parseInt(optionalEnv('AI_ASK_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const MAX_QUESTION_LENGTH = 8000;
const MAX_DOCUMENT_IDS = 25;

interface GroundedSource {
  fileName?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  sectionTitle?: string | null;
}

interface VerificationBody {
  status?: string;            // verified | partially_verified | missing_context
  reasons?: string[];
  details?: Record<string, unknown>;
}

interface AskResponseBody {
  answer?: string;
  retrievalMode?: string;
  tutorMode?: string | null;
  verification?: VerificationBody | null;  // Phase 10 — supplied by Python /ask
  groundedSources?: GroundedSource[];
  cacheHit?: boolean;
  model?: string | null;
}

function _confidenceFromVerification(v?: VerificationBody | null, retrievalMode?: string): string {
  // Verification is authoritative when Python returned it (Phase 10). Falls
  // back to the legacy retrieval-mode mapping only when verification is
  // missing entirely (e.g. an older cached response).
  const status = v && v.status;
  if (status === 'verified') return 'high';
  if (status === 'partially_verified') return 'medium';
  if (status === 'missing_context') return 'low';
  return retrievalMode === 'strong' ? 'high' : 'low';
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
  const subBlocked = await requireActiveSubscription(serviceKey, user.id, 'ai_ask');
  if (subBlocked) return subBlocked;
  const monthlyCapped = await enforceInteractiveCap(serviceKey, user.id);
  if (monthlyCapped) return monthlyCapped;
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

  // Tutor-mode overlay: explain | solve | quiz. The Python layer normalises
  // and falls back to default; we still validate here so a bad client value
  // doesn't trigger the upstream call at all.
  const ALLOWED_TUTOR_MODES = ['explain', 'solve', 'quiz'] as const;
  const tutorMode: string | null =
    typeof body.tutorMode === 'string' &&
    (ALLOWED_TUTOR_MODES as readonly string[]).includes(body.tutorMode)
      ? body.tutorMode
      : null;

  const documentIds: string[] | null = Array.isArray(body.documentIds)
    ? (body.documentIds as string[]).slice(0, MAX_DOCUMENT_IDS)
    : null;
  // activeDocumentId is a ranking hint (the PDF the user is reading), NOT a
  // hard filter. Falls back to body.documentId for legacy callers that sent
  // the open file as a single-doc filter — we now treat it as a hint so the
  // model can still pull in lecture/exercise/formula sheets from the course.
  const activeDocumentId: string | null =
    typeof body.activeDocumentId === 'string' && body.activeDocumentId
      ? body.activeDocumentId
      : typeof body.documentId === 'string' && body.documentId
        ? body.documentId
        : null;
  const activeFileName = typeof body.activeFileName === 'string' ? body.activeFileName : null;
  const openFileContext = typeof body.openFileContext === 'string' ? body.openFileContext.slice(0, 20000) : null;
  await logSecurityEvent(serviceKey, user.id, 'ai_ask', {
    course_id: courseId,
    document_count: documentIds ? documentIds.length : 0,
    active_document: activeDocumentId ? 1 : 0,
  });

  const upstream = await forwardToPython<AskResponseBody>('ask', {
    userId: user.id,
    courseId,
    documentIds,
    activeDocumentId,
    question,
    tutorMode,
    activeFileName,
    openFileContext,
    // bypassCache is intentionally NOT forwarded from the client — the answer
    // cache is our biggest cost mitigation, so the public API is not allowed
    // to defeat it. Cache invalidation happens automatically via
    // document_version_hash when documents change.
    bypassCache: false
  });

  if (!upstream.ok) return jsonResponse(upstream.status, upstream.body);
  const py = upstream.body as AskResponseBody;
  return jsonResponse(200, {
    answer: py.answer || '',
    retrievalMode: py.retrievalMode || 'strong',
    tutorMode: py.tutorMode ?? null,
    // Confidence is derived from Phase-10 deterministic verification when
    // available — NOT from retrievalMode alone. The previous mapping showed a
    // green 'high' badge on answers the verifier had flagged missing_context
    // (e.g. no [Source N] anchor, fabricated filename refs).
    confidence: _confidenceFromVerification(py.verification, py.retrievalMode),
    verification: py.verification ?? null,
    unsupported: py.retrievalMode !== 'strong',
    sources: _mapSources(py.groundedSources),
    cacheHit: Boolean(py.cacheHit),
    model: py.model ?? null
  });
};
