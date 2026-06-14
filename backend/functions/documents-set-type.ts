// POST /api/documents/set-type   { documentId, documentType }
//
// Persists a USER override of the detected document type (Document Understanding
// Layer). Stored in documents.user_document_type_override — SEPARATE from the
// classifier's document_type — and authoritative for future AI behaviour.
// Pass documentType: null to clear the override and fall back to the classifier.
//
// Auth: Supabase JWT. Ownership is verified before any write.

import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { requireEnv } from '../lib/env';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Must stay in sync with the documents_user_doc_type_override_chk constraint
// (migration 20260610_000004_document_understanding.sql).
const ALLOWED_TYPES = new Set([
  'exam', 'lecture', 'exercise_sheet', 'solution_sheet', 'summary', 'slides',
  'textbook_chapter', 'assignment', 'cheat_sheet', 'formula_sheet', 'unknown',
]);

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

  const documentId = typeof body.documentId === 'string' ? body.documentId : '';
  if (!documentId || !UUID_RE.test(documentId)) {
    return fail(400, 'Valid documentId is required');
  }

  // null / '' clears the override; otherwise it must be a known type.
  const raw = body.documentType;
  let override: string | null;
  if (raw === null || raw === '' || raw === undefined) {
    override = null;
  } else if (typeof raw === 'string' && ALLOWED_TYPES.has(raw)) {
    override = raw;
  } else {
    return fail(400, 'documentType must be a known type or null');
  }

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  // Verify ownership before writing.
  const owned = await supaRequest<Array<{ id: string }>>(
    'GET',
    'documents?id=eq.' + encodeURIComponent(documentId) +
      '&user_id=eq.' + encodeURIComponent(user.id) + '&select=id&limit=1',
    null, serviceKey
  );
  if (!Array.isArray(owned.body) || owned.body.length === 0) {
    return fail(404, 'Document not found');
  }

  const res = await supaRequest<Array<Record<string, unknown>>>(
    'PATCH',
    'documents?id=eq.' + encodeURIComponent(documentId) +
      '&user_id=eq.' + encodeURIComponent(user.id) +
      '&select=id,document_type,document_type_confidence,user_document_type_override',
    { user_document_type_override: override, updated_at: new Date().toISOString() },
    serviceKey,
    { Prefer: 'return=representation' }
  );

  if (res.status >= 300) {
    console.error('[documents-set-type] update failed', res.status, res.body);
    return fail(500, 'Failed to save document type');
  }

  const row = Array.isArray(res.body) ? res.body[0] ?? null : null;
  const classifierType = (row?.document_type as string | null) ?? null;
  const effective =
    override ||
    (classifierType && classifierType !== 'unknown' ? classifierType : null) ||
    'unknown';
  return jsonResponse(200, {
    documentId,
    userDocumentTypeOverride: override,
    effectiveDocumentType: effective,
  });
};
