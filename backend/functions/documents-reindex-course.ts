// POST /api/documents/reindex-course
// Admin-only. Reindexes every document in a given (userId, courseId).
// Marks rows as 'uploaded', clears chunks/pages, and kicks the Python
// indexer per document. Returns counts; does not wait for completion.

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { logSecurityEvent } from '../lib/logger';
import { isUuid } from '../lib/validation';
import type { LambdaResponse, NetlifyEvent, SupabaseUser } from '../lib/types';

interface AdminRow { user_id: string }
interface DocumentRow {
  id: string;
  storage_path: string;
}

async function isAdmin(user: SupabaseUser, serviceKey: string): Promise<boolean> {
  const res = await supaRequest<AdminRow[]>(
    'GET',
    'admins?user_id=eq.' + encodeURIComponent(user.id) + '&select=user_id&limit=1',
    null, serviceKey
  );
  const rows = Array.isArray(res.body) ? res.body : [];
  return Boolean(rows[0] && rows[0].user_id === user.id);
}

async function kickIndex(
  documentId: string, userId: string, courseId: string, storagePath: string
): Promise<boolean> {
  if (!pythonAiConfigured()) return false;
  const r = await forwardToPython('index-document', {
    userId, courseId, documentId, storagePath
  });
  return r.ok;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const caller = await verifySupabaseToken(token);
  if (!caller || !caller.id) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!(await isAdmin(caller, serviceKey))) {
    await logSecurityEvent(serviceKey, caller.id, 'admin_access_denied', { route: 'reindex-course' });
    return fail(403, 'Unauthorized');
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const userId = body.userId;
  const courseId = body.courseId;
  const dryRun = body.dryRun === true;

  if (typeof userId !== 'string' || !isUuid(userId)) return fail(400, 'userId (uuid) is required');
  if (typeof courseId !== 'string' || !courseId) return fail(400, 'courseId is required');

  const docsRes = await supaRequest<DocumentRow[]>(
    'GET',
    'documents?user_id=eq.' + encodeURIComponent(userId) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&select=id,storage_path',
    null, serviceKey
  );
  const docs = Array.isArray(docsRes.body) ? docsRes.body : [];

  if (dryRun) {
    return jsonResponse(200, { dryRun: true, count: docs.length });
  }

  let kicked = 0;
  let failed = 0;
  for (const doc of docs) {
    await supaRequest('PATCH', 'documents?id=eq.' + encodeURIComponent(doc.id),
      { processing_status: 'uploaded' }, serviceKey);
    await supaRequest('DELETE', 'document_chunks?document_id=eq.' + encodeURIComponent(doc.id), null, serviceKey)
      .catch(() => {});
    await supaRequest('DELETE', 'document_pages?document_id=eq.' + encodeURIComponent(doc.id), null, serviceKey)
      .catch(() => {});
    const ok = await kickIndex(doc.id, userId, courseId, doc.storage_path);
    if (ok) kicked++; else failed++;
  }

  await logSecurityEvent(serviceKey, caller.id, 'admin_reindex_course', {
    target_user_id: userId, course_id: courseId, total: docs.length, kicked, failed
  });

  return jsonResponse(200, { total: docs.length, kicked, failed });
};
