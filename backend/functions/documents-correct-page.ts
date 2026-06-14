// POST /api/documents/correct-page
// Saves a student's corrected transcription for one OCR'd page, then asks the
// Python service to re-chunk + re-embed the document so retrieval uses the fix.
// Auth happens here (Supabase JWT); the Python service cross-checks ownership.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { isSafeCourseId } from '../lib/validation';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const _UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const _MAX_CORRECTION_CHARS = 50_000;

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const documentId = body.documentId;
  const courseId = body.courseId;
  const pageNumber = body.pageNumber;
  const correctedText = body.correctedText;

  if (!documentId || typeof documentId !== 'string' || !_UUID_RE.test(documentId)) {
    return fail(400, 'documentId is invalid');
  }
  if (!courseId || typeof courseId !== 'string' || !isSafeCourseId(courseId)) {
    return fail(400, 'courseId is invalid');
  }
  if (typeof pageNumber !== 'number' || !Number.isInteger(pageNumber) || pageNumber < 1) {
    return fail(400, 'pageNumber must be a positive integer');
  }
  if (typeof correctedText !== 'string' || !correctedText.trim()) {
    return fail(400, 'correctedText is required');
  }
  if (correctedText.length > _MAX_CORRECTION_CHARS) {
    return fail(400, `correctedText exceeds ${_MAX_CORRECTION_CHARS} characters`);
  }

  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');

  const r = await forwardToPython('correct-document-page', {
    userId: user.id, courseId, documentId, pageNumber, correctedText
  });
  if (!r.ok) {
    const errBody = r.body as { error?: string; detail?: string };
    return fail(r.status, errBody.detail || errBody.error || 'Upstream error');
  }
  return jsonResponse(200, r.body as Record<string, unknown>);
};
