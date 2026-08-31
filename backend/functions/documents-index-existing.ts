// POST /api/documents/index-existing
// Indexes a file already in the course-uploads Storage bucket. The browser
// sends only metadata; the Python service fetches the file directly.

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { isSafeCourseId, isSafePdfStorageName } from '../lib/validation';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const SOURCE_BUCKET = 'course-uploads';

interface DocumentRow {
  id: string;
  processing_status: string;
  storage_path: string;
}

async function _kickIndex(
  documentId: string, userId: string, courseId: string, storagePath: string,
  force: boolean
): Promise<{ started: true } | { started: false; error: string }> {
  if (!pythonAiConfigured()) {
    console.warn('[documents-index-existing] AI service not configured — document stays unprocessed');
    return { started: false, error: 'AI indexing service is not configured' };
  }
  const r = await forwardToPython('index-document', {
    userId, courseId, documentId, storagePath, force
  });
  if (!r.ok) {
    const errBody = r.body as { error?: string };
    console.warn('[documents-index-existing] Python upstream failed:', r.status, errBody.error);
    return { started: false, error: errBody.error || `Indexing service returned ${r.status}` };
  }
  return { started: true };
}

async function _markIndexFailed(
  documentId: string, serviceKey: string, preserveActive: boolean
): Promise<void> {
  // A document that was already 'ready' (a healthy active revision) before
  // this reindex attempt must not be disabled just because kicking off the
  // REBUILD failed — the active revision's own rows are untouched by an
  // attempt that never even started. Only a document with no prior valid
  // state gets marked failed.
  if (preserveActive) return;
  await supaRequest('PATCH', 'documents?id=eq.' + encodeURIComponent(documentId),
    { processing_status: 'failed' }, serviceKey);
}

function _ufKey(courseId: string): string {
  return courseId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function _sanitizeFolder(f: string): string {
  return String(f)
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[^a-zA-Z0-9._\-() ]/g, '_')
    .replace(/ +/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+(?=\.[^.]+$)/g, '');
}

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

  const courseId = body.courseId;
  const storageName = body.storageName;
  const fileName = body.fileName;
  const sourceType = body.sourceType;
  const folder = body.folder;
  const professorName = body.professorName;
  const lectureNumber = body.lectureNumber;
  const exerciseNumber = body.exerciseNumber;
  const language = body.language;
  const isOfficialProfMaterial = body.isOfficialProfMaterial;
  const forceReindex = body.forceReindex;

  if (!courseId || typeof courseId !== 'string' || !isSafeCourseId(courseId)) {
    return fail(400, 'courseId is invalid');
  }
  if (!storageName || typeof storageName !== 'string' || !isSafePdfStorageName(storageName)) {
    return fail(400, 'storageName is invalid');
  }
  if (!fileName || typeof fileName !== 'string' || !isSafePdfStorageName(fileName)) {
    return fail(400, 'fileName is invalid');
  }

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const courseKey = _ufKey(courseId);
  const folderSegment = folder && typeof folder === 'string' ? _sanitizeFolder(folder) + '/' : '';
  const sourcePath = user.id + '/' + courseKey + '/' + folderSegment + storageName;
  const docStoragePath = SOURCE_BUCKET + ':' + sourcePath;

  const existing = await supaRequest<DocumentRow[]>(
    'GET',
    'documents?user_id=eq.' + encodeURIComponent(user.id) +
      '&course_id=eq.' + encodeURIComponent(courseId) +
      '&storage_path=eq.' + encodeURIComponent(docStoragePath) +
      '&select=id,processing_status,storage_path&limit=1',
    null, serviceKey
  );

  if (Array.isArray(existing.body) && existing.body[0]) {
    const doc = existing.body[0];
    if (!forceReindex && doc.processing_status === 'ready' && doc.storage_path === docStoragePath) {
      return jsonResponse(200, {
        alreadyIndexed: true, documentId: doc.id, processingStatus: 'ready'
      });
    }
    // Do NOT delete document_chunks/document_pages here. The Python indexer
    // (index_document, force=true) builds a new candidate index revision and
    // only activates it once the rebuild is verified — deleting the active
    // revision's data upfront would destroy a working index before its
    // replacement is proven to work. Just keep storage_path current and let
    // the indexer own every status/data transition.
    if (doc.storage_path !== docStoragePath) {
      await supaRequest('PATCH', 'documents?id=eq.' + encodeURIComponent(doc.id),
        { storage_path: docStoragePath }, serviceKey);
    }
    const indexing = await _kickIndex(doc.id, user.id, courseId, docStoragePath, Boolean(forceReindex));
    if (!indexing.started) {
      const hadHealthyRevision = doc.processing_status === 'ready';
      await _markIndexFailed(doc.id, serviceKey, hadHealthyRevision);
      return jsonResponse(502, {
        code: 'uploaded_not_indexed', error: indexing.error,
        documentId: doc.id,
        processingStatus: hadHealthyRevision ? doc.processing_status : 'failed',
        indexingStarted: false,
      });
    }
    return jsonResponse(200, {
      alreadyIndexed: false, documentId: doc.id, processingStatus: 'uploaded', indexingStarted: true
    });
  }

  const docRow = {
    user_id: user.id,
    course_id: courseId,
    file_name: fileName,
    file_type: 'pdf',
    source_type: typeof sourceType === 'string' ? sourceType : 'lecture',
    storage_path: docStoragePath,
    processing_status: 'uploaded',
    professor_name: typeof professorName === 'string' ? professorName : null,
    lecture_number: Number.isFinite(lectureNumber) ? lectureNumber as number : null,
    exercise_number: Number.isFinite(exerciseNumber) ? exerciseNumber as number : null,
    language: typeof language === 'string' ? language : 'en',
    is_official_prof_material: isOfficialProfMaterial === true
  };

  const insertResult = await supaRequest<DocumentRow | DocumentRow[]>(
    'POST', 'documents', docRow, serviceKey, { Prefer: 'return=representation' }
  );
  if (insertResult.status !== 201) {
    return fail(500, 'Failed to record document: ' + JSON.stringify(insertResult.body));
  }
  const document = Array.isArray(insertResult.body) ? insertResult.body[0]! : insertResult.body as DocumentRow;
  const indexing = await _kickIndex(document.id, user.id, courseId, docStoragePath, false);
  if (!indexing.started) {
    await _markIndexFailed(document.id, serviceKey, false);
    return jsonResponse(502, {
      code: 'uploaded_not_indexed', error: indexing.error,
      documentId: document.id, processingStatus: 'failed', indexingStarted: false,
    });
  }
  return jsonResponse(201, {
    documentId: document.id, processingStatus: document.processing_status, indexingStarted: true
  });
};
