// DELETE /api/documents/delete

import https from 'https';
import { requireEnv, optionalEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface DocumentRow {
  id: string;
  storage_path: string | null;
  course_id: string;
}

function storageDelete(serviceKey: string, bucket: string, storagePath: string): Promise<number> {
  return new Promise((resolve) => {
    const supaUrl = requireEnv('SUPABASE_URL');
    const body = JSON.stringify({ prefixes: [storagePath] });
    const req = https.request(
      {
        hostname: new URL(supaUrl).hostname,
        path: '/storage/v1/object/bulk/' + encodeURIComponent(bucket),
        method: 'DELETE',
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', () => resolve(500));
    req.write(body);
    req.end();
  });
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'DELETE' && event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON'); }

  const documentId = body.documentId;
  if (!documentId || typeof documentId !== 'string') return fail(400, 'documentId is required');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const docResult = await supaRequest<DocumentRow[]>(
    'GET',
    'documents?id=eq.' + encodeURIComponent(documentId) +
      '&user_id=eq.' + user.id +
      '&select=id,storage_path,course_id&limit=1',
    null, serviceKey
  );

  if (!Array.isArray(docResult.body) || !docResult.body[0]) {
    return fail(404, 'Document not found or access denied');
  }

  const doc = docResult.body[0];

  await supaRequest('DELETE', 'document_chunks?document_id=eq.' + documentId + '&user_id=eq.' + user.id, null, serviceKey);
  await supaRequest('DELETE', 'document_pages?document_id=eq.' + documentId + '&user_id=eq.' + user.id, null, serviceKey);
  await supaRequest('DELETE',
    'retrieval_cache?user_id=eq.' + user.id + '&course_id=eq.' + encodeURIComponent(doc.course_id),
    null, serviceKey
  ).catch((e: unknown) => {
    console.error('[documents-delete] cache purge error:', e instanceof Error ? e.message : String(e));
  });

  if (doc.storage_path) {
    let bucket = optionalEnv('RAG_STORAGE_BUCKET', 'course-uploads');
    let storagePath = doc.storage_path;
    const colon = storagePath.indexOf(':');
    if (colon > 0 && storagePath.indexOf('/') > colon) {
      bucket = storagePath.substring(0, colon);
      storagePath = storagePath.substring(colon + 1);
    }
    await storageDelete(serviceKey, bucket, storagePath);
  }

  await supaRequest('DELETE', 'documents?id=eq.' + documentId + '&user_id=eq.' + user.id, null, serviceKey);
  return jsonResponse(200, { ok: true });
};
