// GET /api/documents/list?courseId=xxx

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'GET') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const courseId = (event.queryStringParameters || {}).courseId;
  if (!courseId) return fail(400, 'courseId query parameter is required');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const base =
    'documents?user_id=eq.' + encodeURIComponent(user.id) +
    '&course_id=eq.' + encodeURIComponent(courseId);
  const order = '&order=created_at.desc';
  const BASE_COLS =
    'id,file_name,file_type,source_type,processing_status,processing_error,' +
    'page_count,extraction_quality,ocr_assessment,document_type,created_at,updated_at';
  // Document Understanding Layer fields (migration 20260610_000004).
  const UNDERSTANDING_COLS =
    ',document_type_confidence,user_document_type_override,document_understanding';

  // Try with the understanding columns; if they don't exist yet (migration not
  // applied) PostgREST 400s → body isn't an array → fall back to base columns so
  // the file list never breaks.
  let result = await supaRequest<unknown[]>(
    'GET', base + '&select=' + BASE_COLS + UNDERSTANDING_COLS + order, null, serviceKey
  );
  if (!Array.isArray(result.body)) {
    result = await supaRequest<unknown[]>(
      'GET', base + '&select=' + BASE_COLS + order, null, serviceKey
    );
  }
  if (!Array.isArray(result.body)) return fail(500, 'Failed to fetch documents');

  const documents = (result.body as Array<Record<string, unknown>>).map((r) => {
    const u = (r.document_understanding as Record<string, unknown> | null) || {};
    const classifierType =
      (r.document_type as string | null) ?? (u.document_type as string | null) ?? null;
    const override = (r.user_document_type_override as string | null) ?? null;
    const sourceType = (r.source_type as string | null) ?? null;
    // override > classifier(non-unknown) > legacy source_type > unknown
    const effective =
      override ||
      (classifierType && classifierType !== 'unknown' ? classifierType : null) ||
      sourceType ||
      'unknown';
    return {
      ...r,
      document_understanding: undefined, // don't ship the raw blob; fields are flattened
      document_type: classifierType,
      document_type_confidence:
        (r.document_type_confidence as number | null) ??
        (u.document_type_confidence as number | null) ??
        null,
      document_type_signals: (u.document_type_signals as string[] | null) ?? [],
      detected_language: (u.detected_language as string | null) ?? null,
      subject_name: (u.subject_name as string | null) ?? null,
      topic_area: (u.topic_area as string | null) ?? null,
      content_flags: (u.content_flags as Record<string, boolean> | null) ?? null,
      user_document_type_override: override,
      effective_document_type: effective,
    };
  });

  return jsonResponse(200, { documents });
};
