// POST /api/documents/review-pages
// Lists the OCR'd pages of a document that were flagged for student review
// (handwriting pages, or pages with [unclear] markers / low OCR confidence).
// Auth happens here (Supabase JWT); the Python service cross-checks ownership.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const _UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
  if (!documentId || typeof documentId !== 'string' || !_UUID_RE.test(documentId)) {
    return fail(400, 'documentId is invalid');
  }

  if (!pythonAiConfigured()) return fail(503, 'AI service not configured');

  const r = await forwardToPython('document-review-pages', {
    userId: user.id, documentId
  });
  if (!r.ok) {
    const errBody = r.body as { error?: string; detail?: string };
    return fail(r.status, errBody.detail || errBody.error || 'Upstream error');
  }
  return jsonResponse(200, r.body as Record<string, unknown>);
};
