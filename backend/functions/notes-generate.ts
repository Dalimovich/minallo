// POST /api/notes/generate — proxy to Python /notes-generate.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { optionalEnv, requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import { logSecurityEvent } from '../lib/logger';
import { supaRequest } from '../lib/supabase-admin';
import { isSafeCourseId, isUuid } from '../lib/validation';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const NOTES_RATE_LIMIT_MAX = parseInt(optionalEnv('NOTES_RATE_LIMIT_MAX', '30'), 10);
const NOTES_RATE_LIMIT_WINDOW = parseInt(optionalEnv('NOTES_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const MAX_PDF_TEXT_LENGTH = 250000;
const MAX_SECTIONS = 80;

interface DocumentOwnerRow {
  id: string;
  user_id: string;
  course_id: string;
}

async function verifyDocumentOwner(
  serviceKey: string,
  userId: string,
  courseId: string,
  documentId: string
): Promise<boolean> {
  const result = await supaRequest<DocumentOwnerRow[]>(
    'GET',
    'documents?id=eq.' + encodeURIComponent(documentId) +
      '&user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=id,user_id,course_id&limit=1',
    null,
    serviceKey
  );
  return Array.isArray(result.body) && result.body[0]?.id === documentId;
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
    'notes_generate',
    NOTES_RATE_LIMIT_MAX,
    NOTES_RATE_LIMIT_WINDOW,
    'Notes generation limit reached. Please try again later.'
  );
  if (limited) return limited;

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  if (typeof body.courseId !== 'string' || !isSafeCourseId(body.courseId)) {
    return fail(400, 'courseId is invalid');
  }
  if (typeof body.tool !== 'string' || !['notes', 'summary'].includes(body.tool)) {
    return fail(400, 'tool must be notes or summary');
  }
  if (typeof body.mode === 'string' &&
      !['generate', 'section', 'merge', 'analyze'].includes(body.mode)) {
    return fail(400, 'mode is invalid');
  }
  if (typeof body.scope === 'string' &&
      !['document', 'page', 'section', 'range'].includes(body.scope)) {
    return fail(400, 'scope is invalid');
  }
  if (body.documentId != null && (typeof body.documentId !== 'string' || !isUuid(body.documentId))) {
    return fail(400, 'documentId is invalid');
  }
  if (body.documentId) {
    const ownsDocument = await verifyDocumentOwner(
      serviceKey,
      user.id,
      body.courseId,
      body.documentId
    );
    if (!ownsDocument) {
      await logSecurityEvent(serviceKey, user.id, 'notes_generate_denied', {
        course_id: body.courseId,
        document_id: body.documentId
      });
      return fail(404, 'Document not found or access denied');
    }
  }
  if (typeof body.pdfText === 'string' && body.pdfText.length > MAX_PDF_TEXT_LENGTH) {
    return fail(413, 'pdfText is too large');
  }
  if (body.sections != null && !Array.isArray(body.sections)) {
    return fail(400, 'sections must be an array');
  }
  if (Array.isArray(body.sections) && body.sections.length > MAX_SECTIONS) {
    return fail(400, 'Too many sections');
  }
  await logSecurityEvent(serviceKey, user.id, 'notes_generate', {
    course_id: body.courseId,
    tool: body.tool,
    scope: body.scope ?? 'document'
  });

  const upstream = await forwardToPython('notes-generate', {
    userId:         user.id,
    courseId:       body.courseId,
    documentId:     body.documentId ?? null,
    tool:           body.tool,
    mode:           body.mode ?? 'generate',
    scope:          body.scope ?? 'document',
    fileName:       body.fileName ?? null,
    pdfText:        body.pdfText ?? null,
    language:       body.language ?? 'same_as_source',
    detailLevel:    body.detailLevel ?? 'balanced',
    currentPage:    body.currentPage != null ? Number(body.currentPage) : null,
    pageRange:      body.pageRange ?? null,
    topicTitle:     body.topicTitle ?? null,
    sections:       body.sections ?? null,
    effectivePages: body.effectivePages != null ? Number(body.effectivePages) : null,
    title:          body.title ?? null
  });
  return jsonResponse(upstream.status, upstream.body);
};
