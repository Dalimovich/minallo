// DELETE /api/course-delete — permanently removes a user's course artifacts.
import { requireEnv, optionalEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'DELETE' && event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  const token = extractBearerToken(event.headers);
  const user = token ? await verifySupabaseToken(token) : null;
  if (!user) return fail(401, 'Invalid or expired token');
  let body: { courseId?: string };
  try { body = JSON.parse(event.body || '{}') as { courseId?: string }; }
  catch { return fail(400, 'Invalid JSON'); }
  const courseId = String(body.courseId || '').trim();
  if (!courseId || courseId.length > 160) return fail(400, 'courseId is required');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const uid = encodeURIComponent(user.id);
  const cid = encodeURIComponent(courseId);

  const docs = await supaRequest<Array<{ id: string }>>('GET', `documents?user_id=eq.${uid}&course_id=eq.${cid}&select=id`, null, key);
  const ids = Array.isArray(docs.body) ? docs.body.map((doc) => doc.id).filter(Boolean) : [];
  for (const id of ids) {
    const encoded = encodeURIComponent(id);
    await supaRequest('DELETE', `document_chunks?user_id=eq.${uid}&document_id=eq.${encoded}`, null, key).catch(() => undefined);
    await supaRequest('DELETE', `document_pages?user_id=eq.${uid}&document_id=eq.${encoded}`, null, key).catch(() => undefined);
  }
  const courseTables = ['retrieval_cache', 'flashcard_decks', 'exam_sessions', 'notes', 'course_notes', 'ai_question_cache'];
  for (const table of courseTables) {
    await supaRequest('DELETE', `${table}?user_id=eq.${uid}&course_id=eq.${cid}`, null, key).catch(() => undefined);
  }
  await supaRequest('DELETE', `documents?user_id=eq.${uid}&course_id=eq.${cid}`, null, key);

  const supaUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const bucket = optionalEnv('RAG_STORAGE_BUCKET', 'course-uploads');
  await fetch(`${supaUrl}/storage/v1/object/bulk/${encodeURIComponent(bucket)}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [`${user.id}/${courseId}/`] })
  });
  return jsonResponse(200, { ok: true, deletedDocuments: ids.length });
};
