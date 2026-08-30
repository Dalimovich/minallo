// DELETE /api/course-delete — permanently removes an owned course's artifacts.

import { optionalEnv, requireEnv } from '../lib/env';
import { extractBearerToken, verifySupabaseToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { isSafeCourseId } from '../lib/validation';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

interface DocumentRow { id: string; storage_path: string | null }
interface StorageObject { name?: string; id?: string | null }

function courseStorageKey(courseId: string): string {
  return courseId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function successful(status: number): boolean {
  return status >= 200 && status < 300;
}

async function storageRequest(path: string, init: RequestInit, key: string): Promise<Response> {
  const url = requireEnv('SUPABASE_URL').replace(/\/$/, '') + path;
  return fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
}

async function listStorageTree(
  bucket: string,
  prefix: string,
  key: string,
  output: Set<string>
): Promise<boolean> {
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const response = await storageRequest(
      `/storage/v1/object/list/${encodeURIComponent(bucket)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          prefix, limit: pageSize, offset,
          sortBy: { column: 'name', order: 'asc' }
        })
      },
      key
    );
    if (!response.ok) return false;
    const parsed = await response.json().catch(() => []) as StorageObject[];
    const entries = Array.isArray(parsed) ? parsed : [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
      const objectPath = prefix + entry.name;
      if (entry.id == null) {
        if (!await listStorageTree(bucket, objectPath + '/', key, output)) return false;
      } else {
        output.add(objectPath);
      }
    }
    if (entries.length < pageSize) break;
  }
  return true;
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'DELETE' && event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  const user = token ? await verifySupabaseToken(token) : null;
  if (!user) return fail(401, 'Invalid or expired token');

  let body: { courseId?: unknown };
  try { body = JSON.parse(event.body || '{}') as { courseId?: unknown }; }
  catch { return fail(400, 'Invalid JSON'); }
  const courseId = String(body.courseId || '').trim();
  if (!courseId || !isSafeCourseId(courseId)) return fail(400, 'courseId is invalid');

  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const uid = encodeURIComponent(user.id);
  const cid = encodeURIComponent(courseId);
  const bucket = optionalEnv('RAG_STORAGE_BUCKET', 'course-uploads');

  try {
    const docsResult = await supaRequest<DocumentRow[]>(
      'GET', `documents?user_id=eq.${uid}&course_id=eq.${cid}&select=id,storage_path`, null, key
    );
    if (!successful(docsResult.status) || !Array.isArray(docsResult.body)) {
      return fail(502, 'COURSE_DELETE_DOCUMENT_ENUMERATION_FAILED');
    }
    const documents = docsResult.body;

    const storagePaths = new Set<string>();
    const storagePrefix = `${user.id}/${courseStorageKey(courseId)}/`;
    if (!await listStorageTree(bucket, storagePrefix, key, storagePaths)) {
      return fail(502, 'COURSE_DELETE_STORAGE_ENUMERATION_FAILED');
    }
    for (const document of documents) {
      if (document.storage_path?.startsWith(`${bucket}:`)) {
        storagePaths.add(document.storage_path.slice(bucket.length + 1));
      }
    }
    if (storagePaths.size > 0) {
      const storageDeletion = await storageRequest(
        `/storage/v1/object/bulk/${encodeURIComponent(bucket)}`,
        { method: 'DELETE', body: JSON.stringify({ prefixes: [...storagePaths] }) },
        key
      );
      if (!storageDeletion.ok) return fail(502, 'COURSE_DELETE_STORAGE_FAILED');
    }

    // Document-owned pages, chunks, manifests, jobs, and derived data cascade.
    const documentDeletion = await supaRequest(
      'DELETE', `documents?user_id=eq.${uid}&course_id=eq.${cid}`, null, key
    );
    if (!successful(documentDeletion.status)) return fail(502, 'COURSE_DELETE_DOCUMENTS_FAILED');

    const courseTables = [
      'retrieval_cache', 'flashcard_decks', 'exam_sessions', 'notes',
      'course_notes', 'ai_question_cache'
    ];
    for (const table of courseTables) {
      const deletion = await supaRequest(
        'DELETE', `${table}?user_id=eq.${uid}&course_id=eq.${cid}`, null, key
      );
      // Optional tables can be absent on older projects. Other failures are
      // reported with the exact stage instead of escaping as Cloudflare 1101.
      if (!successful(deletion.status) && deletion.status !== 404) {
        return fail(502, `COURSE_DELETE_RELATED_DATA_FAILED:${table}`);
      }
    }

    return jsonResponse(200, {
      ok: true,
      deletedDocuments: documents.length,
      deletedStorageObjects: storagePaths.size
    });
  } catch (error) {
    console.error('course_delete_failed', {
      userId: user.id,
      courseId,
      error: error instanceof Error ? error.message : String(error)
    });
    return fail(502, 'COURSE_DELETE_INTERNAL_FAILURE');
  }
};
