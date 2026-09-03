// POST /api/admin/retrieval-logs
// Admin-only. Returns recent retrieval_debug_log rows for inspection.
// Body: { userId?: uuid, courseId?: string, limit?: number, id?: uuid }
//   - id      → return that single row in full
//   - userId  → filter by user
//   - courseId → filter by course
//   - limit   → max 100, default 25
//
// Service-role read bypasses RLS so admins can inspect any user's bad
// answers. The endpoint is gated by the same public.admins check used
// elsewhere (admin-users.ts, documents-reindex-course.ts).

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { logSecurityEvent } from '../lib/logger';
import { isUuid } from '../lib/validation';
import type { LambdaResponse, NetlifyEvent, SupabaseUser } from '../lib/types';

interface AdminRow { user_id: string }

interface DebugRowLite {
  id: string;
  user_id: string;
  course_id: string;
  endpoint: string;
  question: string;
  active_document_id: string | null;
  selected_document_ids: string[];
  retrieval_strategy: string | null;
  retrieval_mode: string | null;
  candidate_doc_count: number | null;
  cache_hit: boolean;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  created_at: string;
}

interface DebugRowFull extends DebugRowLite {
  exercise_hit: unknown;
  chunk_metadata: unknown;
  error: string | null;
}

async function isAdmin(user: SupabaseUser, serviceKey: string): Promise<boolean> {
  const res = await supaRequest<AdminRow[]>(
    'GET',
    'admins?user_id=eq.' + encodeURIComponent(user.id) + '&select=user_id&limit=1',
    null, serviceKey,
  );
  const rows = Array.isArray(res.body) ? res.body : [];
  return Boolean(rows[0] && rows[0].user_id === user.id);
}

const LITE_COLUMNS =
  'id,user_id,course_id,endpoint,question,active_document_id,selected_document_ids,' +
  'retrieval_strategy,retrieval_mode,candidate_doc_count,cache_hit,model,' +
  'prompt_tokens,completion_tokens,duration_ms,created_at';

const FULL_COLUMNS = LITE_COLUMNS + ',exercise_hit,chunk_metadata,error';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const caller = await verifySupabaseToken(token);
  if (!caller || !caller.id) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!(await isAdmin(caller, serviceKey))) {
    await logSecurityEvent(serviceKey, caller.id, 'admin_access_denied', {
      route: 'retrieval-logs',
    });
    return fail(403, 'Unauthorized');
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const rowId = typeof body.id === 'string' ? body.id : null;
  const userId = typeof body.userId === 'string' ? body.userId : null;
  const courseId = typeof body.courseId === 'string' ? body.courseId : null;
  const rawLimit = typeof body.limit === 'number' ? body.limit : 25;
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));

  if (rowId) {
    if (!isUuid(rowId)) return fail(400, 'Invalid id');
    const res = await supaRequest<DebugRowFull[]>(
      'GET',
      'retrieval_debug_log?id=eq.' + encodeURIComponent(rowId) +
        '&select=' + FULL_COLUMNS + '&limit=1',
      null, serviceKey,
    );
    const rows = Array.isArray(res.body) ? res.body : [];
    if (!rows[0]) return fail(404, 'Not found');
    return jsonResponse(200, { row: rows[0] });
  }

  if (userId && !isUuid(userId)) return fail(400, 'Invalid userId');

  // List mode: latest N rows, optionally filtered. Order desc by created_at.
  const filters: string[] = [];
  if (userId) filters.push('user_id=eq.' + encodeURIComponent(userId));
  if (courseId) filters.push('course_id=eq.' + encodeURIComponent(courseId));
  const queryStr =
    (filters.length ? filters.join('&') + '&' : '') +
    'select=' + LITE_COLUMNS +
    '&order=created_at.desc&limit=' + limit;

  const res = await supaRequest<DebugRowLite[]>(
    'GET', 'retrieval_debug_log?' + queryStr, null, serviceKey,
  );
  if (res.status < 200 || res.status >= 300) {
    return fail(500, 'Could not load logs');
  }
  await logSecurityEvent(serviceKey, caller.id, 'admin_retrieval_logs_view', {
    user_filter: userId ? 1 : 0,
    course_filter: courseId ? 1 : 0,
    limit,
  });
  return jsonResponse(200, { rows: Array.isArray(res.body) ? res.body : [] });
};
