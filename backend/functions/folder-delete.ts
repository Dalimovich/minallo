// DELETE /api/folder-delete — permanently removes one owned course folder.
// Folder names are currently browser metadata; the durable contents are the
// indexed document rows and Storage objects below the folder's exact prefix.

import { optionalEnv, requireEnv } from '../lib/env';
import { extractBearerToken, verifySupabaseToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { isSafeCourseId } from '../lib/validation';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface DocumentRow {
  id: string;
  storage_path: string | null;
}

interface StorageObject {
  name?: string;
}

function courseStorageKey(courseId: string): string {
  return courseId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sanitizeStorageSegment(value: string): string {
  return value
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[^a-zA-Z0-9._\-() ]/g, '_')
    .replace(/ +/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+(?=\.[^.]+$)/g, '');
}

function successful(status: number): boolean {
  return status >= 200 && status < 300;
}

async function storageRequest(
  path: string,
  init: RequestInit,
  serviceKey: string
): Promise<Response> {
  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  try {
    return await fetch(supabaseUrl + path, {
      ...init,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
  } catch (err: unknown) {
    // fetch() rejecting (DNS/connection failure) previously propagated
    // straight out of this handler uncaught — every caller below only
    // checks `.ok` on the RESOLVED response, none expects the promise
    // itself to reject. Return a synthetic non-ok Response instead so the
    // existing `if (!...Response.ok)` checks catch it the same way they'd
    // catch a real Supabase 5xx.
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `Supabase Storage request failed: ${message}` }), {
      status: 502
    });
  }
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'DELETE' && event.httpMethod !== 'POST') {
    return fail(405, 'Method not allowed');
  }

  const token = extractBearerToken(event.headers);
  const user = token ? await verifySupabaseToken(token) : null;
  if (!user) return fail(401, 'Invalid or expired token');

  let body: { courseId?: unknown; folderName?: unknown };
  try {
    body = JSON.parse(event.body || '{}') as { courseId?: unknown; folderName?: unknown };
  } catch {
    return fail(400, 'Invalid JSON');
  }

  const courseId = String(body.courseId || '').trim();
  const folderName = String(body.folderName || '').trim();
  const storageFolder = sanitizeStorageSegment(folderName);
  if (!courseId || !isSafeCourseId(courseId)) return fail(400, 'courseId is invalid');
  if (!folderName || folderName.length > 160 || !storageFolder) {
    return fail(400, 'folderName is invalid');
  }

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const uid = encodeURIComponent(user.id);
  const cid = encodeURIComponent(courseId);
  const bucket = optionalEnv('RAG_STORAGE_BUCKET', 'course-uploads');
  const folderPrefix = `${user.id}/${courseStorageKey(courseId)}/${storageFolder}/`;
  const durablePrefix = `${bucket}:${folderPrefix}`;

  // Authorization is expressed in the query itself: only this user's rows in
  // this course can become deletion candidates. Filter the exact normalized
  // folder prefix server-side so duplicate filenames elsewhere are untouched.
  const documentsResult = await supaRequest<DocumentRow[]>(
    'GET',
    `documents?user_id=eq.${uid}&course_id=eq.${cid}&select=id,storage_path`,
    null,
    serviceKey
  );
  if (!successful(documentsResult.status) || !Array.isArray(documentsResult.body)) {
    return fail(502, 'Could not enumerate folder documents');
  }
  const documents = documentsResult.body.filter((document) =>
    typeof document.storage_path === 'string' && document.storage_path.startsWith(durablePrefix)
  );

  // Include unindexed uploads as well as indexed document paths. Storage list
  // returns names relative to folderPrefix, and uploads do not create nested
  // directories beneath a user-created folder.
  const storagePaths = new Set<string>();
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const listResponse = await storageRequest(
      `/storage/v1/object/list/${encodeURIComponent(bucket)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          prefix: folderPrefix,
          limit: pageSize,
          offset,
          sortBy: { column: 'name', order: 'asc' }
        })
      },
      serviceKey
    );
    if (!listResponse.ok) return fail(502, 'Could not enumerate folder storage');
    const listed = await listResponse.json().catch(() => []) as StorageObject[];
    const page = Array.isArray(listed) ? listed : [];
    for (const item of page) {
      if (item && typeof item.name === 'string' && item.name) {
        storagePaths.add(folderPrefix + item.name);
      }
    }
    if (page.length < pageSize) break;
  }
  for (const document of documents) {
    if (document.storage_path?.startsWith(`${bucket}:`)) {
      storagePaths.add(document.storage_path.slice(bucket.length + 1));
    }
  }

  if (storagePaths.size > 0) {
    const deleteStorageResponse = await storageRequest(
      `/storage/v1/object/bulk/${encodeURIComponent(bucket)}`,
      { method: 'DELETE', body: JSON.stringify({ prefixes: [...storagePaths] }) },
      serviceKey
    );
    if (!deleteStorageResponse.ok) return fail(502, 'Could not delete folder storage');
  }

  // Every document-owned table uses ON DELETE CASCADE. Deleting the owned
  // document rows is therefore the authoritative database deletion for pages,
  // chunks, manifests, revisions, exercises, formulas, and related artifacts.
  for (const document of documents) {
    const deletion = await supaRequest(
      'DELETE',
      `documents?id=eq.${encodeURIComponent(document.id)}&user_id=eq.${uid}&course_id=eq.${cid}`,
      null,
      serviceKey
    );
    if (!successful(deletion.status)) return fail(502, 'Could not delete folder documents');
  }

  const cacheDeletion = await supaRequest(
    'DELETE',
    `retrieval_cache?user_id=eq.${uid}&course_id=eq.${cid}`,
    null,
    serviceKey
  );
  if (!successful(cacheDeletion.status) && cacheDeletion.status !== 404) {
    return fail(502, 'Folder deleted but retrieval cache invalidation failed');
  }

  return jsonResponse(200, {
    ok: true,
    deletedDocuments: documents.length,
    deletedStorageObjects: storagePaths.size
  });
};
