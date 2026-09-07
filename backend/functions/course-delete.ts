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

// Cloudflare Workers cap both how long a single invocation may run and how
// many outgoing fetches ("subrequests") it may make. This walk used to be
// fully sequential — one request per page, then one more recursive call per
// subfolder, each fully awaited before the next started — so a course with
// many folders (or a folder with many thousands of files) could exceed
// either limit and get the isolate hard-killed by the platform. That
// surfaces to the browser as a raw Cloudflare 502 HTML page with no JSON
// body at all: this function's own try/catch never runs, because the whole
// isolate is terminated before it gets the chance. Siblings now list
// concurrently (depth, not folder count, drives wall-clock time), and a
// hard request/time budget makes the walk degrade to "delete what we found
// within budget" instead of running unbounded — any objects beyond the
// budget are logged as an incomplete sweep rather than blocking deletion of
// the course itself, which is what the user is actually waiting on.
const STORAGE_ENUM_MAX_REQUESTS = 120;
const STORAGE_ENUM_DEADLINE_MS = 20_000;

interface StorageEnumBudget { requestsLeft: number; deadline: number }
type StorageEnumResult = 'ok' | 'partial' | 'failed';

async function listStorageTree(
  bucket: string,
  prefix: string,
  key: string,
  output: Set<string>,
  budget: StorageEnumBudget
): Promise<StorageEnumResult> {
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    if (budget.requestsLeft <= 0 || Date.now() > budget.deadline) return 'partial';
    budget.requestsLeft -= 1;
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
    if (!response.ok) return 'failed';
    const parsed = await response.json().catch(() => []) as StorageObject[];
    const entries = Array.isArray(parsed) ? parsed : [];
    const folderPaths: string[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
      const objectPath = prefix + entry.name;
      if (entry.id == null) folderPaths.push(objectPath + '/');
      else output.add(objectPath);
    }
    if (folderPaths.length) {
      const results = await Promise.all(
        folderPaths.map((folderPath) => listStorageTree(bucket, folderPath, key, output, budget))
      );
      if (results.includes('failed')) return 'failed';
      if (results.includes('partial')) return 'partial';
    }
    if (entries.length < pageSize) break;
  }
  return 'ok';
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
    const storageEnum = await listStorageTree(bucket, storagePrefix, key, storagePaths, {
      requestsLeft: STORAGE_ENUM_MAX_REQUESTS,
      deadline: Date.now() + STORAGE_ENUM_DEADLINE_MS
    });
    if (storageEnum === 'failed') return fail(502, 'COURSE_DELETE_STORAGE_ENUMERATION_FAILED');
    const storageEnumerationIncomplete = storageEnum === 'partial';
    if (storageEnumerationIncomplete) {
      console.warn('course_delete_storage_enumeration_incomplete', {
        userId: user.id, courseId, foundSoFar: storagePaths.size
      });
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
    // Run optional cleanup concurrently. Sequential 12-second REST timeouts
    // could otherwise hold the response for more than a minute after the
    // authoritative Storage/document deletion had already succeeded.
    const cleanupResults = await Promise.all(courseTables.map(async (table) => {
      const deletion = await supaRequest(
        'DELETE', `${table}?user_id=eq.${uid}&course_id=eq.${cid}`, null, key
      );
      return { table, status: deletion.status };
    }));
    // These are non-authoritative convenience artifacts and schema support
    // differs between compatibility generations. Once Storage and documents
    // are gone, a missing table/column must not strand the course in the UI.
    const cleanupWarnings = cleanupResults
      .filter((result) => !successful(result.status))
      .map((result) => `${result.table}:${result.status}`);

    if (cleanupWarnings.length) {
      console.warn('course_delete_cleanup_warnings', {
        userId: user.id, courseId, cleanupWarnings
      });
    }

    return jsonResponse(200, {
      ok: true,
      deletedDocuments: documents.length,
      deletedStorageObjects: storagePaths.size,
      cleanupWarnings,
      // true only when the storage walk hit its request/time budget before
      // finishing — the course and its tracked documents are still fully
      // deleted either way; this just flags that some untracked storage
      // objects may remain for a later sweep.
      storageEnumerationIncomplete
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
