// /api/notes — list, update, delete

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const params = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    if (params.id) {
      const full = await supaRequest<unknown[]>(
        'GET',
        'notes?select=*&id=eq.' + encodeURIComponent(params.id) +
        '&user_id=eq.' + encodeURIComponent(user.id),
        null, serviceKey
      ).catch(() => ({ status: 0, body: [] as unknown[] }));
      const rows = Array.isArray(full.body) ? full.body : [];
      return jsonResponse(200, { note: rows[0] || null });
    }
    let path = 'notes?select=id,title,type,course_id,document_id,source_page_start,source_page_end,content_markdown,note_sources,created_at,updated_at' +
      '&user_id=eq.' + encodeURIComponent(user.id) +
      '&order=created_at.desc&limit=100';
    if (params.courseId)   path += '&course_id=eq.'   + encodeURIComponent(params.courseId);
    if (params.documentId) path += '&document_id=eq.' + encodeURIComponent(params.documentId);
    const result = await supaRequest<unknown[]>('GET', path, null, serviceKey)
      .catch(() => ({ status: 0, body: [] as unknown[] }));
    const rows = Array.isArray(result.body) ? result.body : [];
    return jsonResponse(200, { notes: rows });
  }

  if (event.httpMethod === 'PATCH') {
    const id = params.id;
    if (!id) return fail(400, 'id is required');
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
    catch { return fail(400, 'Invalid JSON'); }
    const patch: Record<string, unknown> = {};
    if (typeof body.title === 'string')            patch.title = body.title;
    if (typeof body.content_markdown === 'string') patch.content_markdown = body.content_markdown;
    if (!Object.keys(patch).length) return fail(400, 'Nothing to update');
    patch.updated_at = new Date().toISOString();
    await supaRequest('PATCH',
      'notes?id=eq.' + encodeURIComponent(id) + '&user_id=eq.' + encodeURIComponent(user.id),
      patch, serviceKey, { Prefer: 'return=minimal' });
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    const id = params.id;
    if (!id) return fail(400, 'id is required');
    await supaRequest('DELETE',
      'notes?id=eq.' + encodeURIComponent(id) + '&user_id=eq.' + encodeURIComponent(user.id),
      null, serviceKey, { Prefer: 'return=minimal' });
    return jsonResponse(200, { ok: true });
  }

  return fail(405, 'Method not allowed');
};
