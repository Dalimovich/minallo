// POST /api/documents/index-existing
// Indexes a file already in the course-uploads Storage bucket. The browser
// sends only metadata; the Python service fetches the file directly.

import { requireEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const SOURCE_BUCKET = 'course-uploads';

interface DocumentRow {
  id: string;
  processing_status: string;
  storage_path: string;
}

async function _kickIndex(
  documentId: string, userId: string, courseId: string, storagePath: string
): Promise<void> {
  if (!pythonAiConfigured()) {
    console.warn('[documents-index-existing] AI service not configured — document stays unprocessed');
    return;
  }
  const r = await forwardToPython('index-document', {
    userId, courseId, documentId, storagePath
  });
  if (!r.ok) {
    const errBody = r.body as { error?: string };
    console.warn('[documents-index-existing] Python upstream failed:', r.status, errBody.error);
  }
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

  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');
  if (!storageName || typeof storageName !== 'string') return fail(400, 'storageName is required');
  if (!fileName || typeof fileName !== 'string') return fail(400, 'fileName is required');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const courseKey = _ufKey(courseId);
  const folderSegment = folder && typeof folder === 'string' ? _sanitizeFolder(folder) + '/' : '';
  const sourcePath = user.id + '/' + courseKey + '/' + folderSegment + storageName;
  const docStoragePath = SOURCE_BUCKET + ':' + sourcePath;

  const existing = await supaRequest<DocumentRow[]>(
    'GET',
    'documents?user_id=eq.' + user.id +
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
    await supaRequest('PATCH', 'documents?id=eq.' + doc.id,
      { processing_status: 'uploaded', storage_path: docStoragePath }, serviceKey);
    await supaRequest('DELETE', 'document_chunks?document_id=eq.' + doc.id, null, serviceKey)
      .catch(() => {});
    await supaRequest('DELETE', 'document_pages?document_id=eq.' + doc.id, null, serviceKey)
      .catch(() => {});
    await _kickIndex(doc.id, user.id, courseId, docStoragePath);
    return jsonResponse(200, {
      alreadyIndexed: false, documentId: doc.id, processingStatus: 'uploaded'
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
  await _kickIndex(document.id, user.id, courseId, docStoragePath);
  return jsonResponse(201, {
    documentId: document.id, processingStatus: document.processing_status
  });
};
