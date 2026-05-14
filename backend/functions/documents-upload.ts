// POST /api/documents/upload — accepts base64 PDF, stores in Storage, kicks off indexing.

import crypto from 'crypto';
import https from 'https';
import { requireEnv, optionalEnv } from '../lib/env';
import { jsonResponse, fail, handleOptions } from '../lib/responses';
import { verifySupabaseToken, extractBearerToken } from '../lib/supabase-auth';
import { supaRequest } from '../lib/supabase-admin';
import { pythonAiConfigured, forwardToPython } from '../lib/python-ai-proxy';
import { enforceEventRateLimit } from '../lib/rate-limit';
import { logSecurityEvent } from '../lib/logger';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = { 'application/pdf': 'pdf' };
const STORAGE_BUCKET = optionalEnv('RAG_STORAGE_BUCKET', 'course-uploads');
const UPLOAD_RATE_LIMIT_MAX = parseInt(optionalEnv('UPLOAD_RATE_LIMIT_MAX', '12'), 10);
const UPLOAD_RATE_LIMIT_WINDOW = parseInt(optionalEnv('UPLOAD_RATE_LIMIT_WINDOW_MS', String(60 * 60 * 1000)), 10);
const SAFE_FILE_NAME = /^[^<>:"\\|?*\x00-\x1F]{1,180}\.pdf$/i;

interface DocumentRow {
  id: string;
  file_name: string;
  course_id: string;
  source_type: string;
  processing_status: string;
  storage_path: string;
}

function uploadToStorage(
  serviceKey: string, storagePath: string, fileBuffer: Buffer, mimeType: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const supaUrl = requireEnv('SUPABASE_URL');
    const hostname = new URL(supaUrl).hostname;
    const path = '/storage/v1/object/' + STORAGE_BUCKET + '/' + storagePath;
    const req = https.request(
      {
        hostname, path, method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': mimeType,
          'Content-Length': fileBuffer.length
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 201) resolve(storagePath);
          else reject(new Error('Storage upload failed: ' + res.statusCode + ' ' + data));
        });
      }
    );
    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');

  const token = extractBearerToken(event.headers);
  if (!token) return fail(401, 'Missing authorization token');
  const user = await verifySupabaseToken(token);
  if (!user) return fail(401, 'Invalid or expired token');

  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const limited = await enforceEventRateLimit(
    serviceKey,
    user.id,
    'document_upload',
    UPLOAD_RATE_LIMIT_MAX,
    UPLOAD_RATE_LIMIT_WINDOW,
    'Upload limit reached. Please try again later.'
  );
  if (limited) return limited;

  if (Buffer.byteLength(event.body || '', 'utf8') > Math.ceil(MAX_BODY_BYTES * 1.45)) {
    return fail(413, 'Request too large (max 20 MB file)');
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; }
  catch { return fail(400, 'Invalid JSON body'); }

  const { fileName, mimeType, fileBase64, courseId, semesterId, professorName, sourceType } = body as {
    fileName?: string; mimeType?: string; fileBase64?: string; courseId?: string;
    semesterId?: string | null; professorName?: string | null; sourceType?: string;
  };

  if (!fileName || typeof fileName !== 'string') return fail(400, 'fileName is required');
  if (!SAFE_FILE_NAME.test(fileName)) return fail(400, 'fileName must be a valid PDF filename');
  if (!mimeType || !ALLOWED_TYPES[mimeType]) return fail(400, 'Only PDF files are supported');
  if (!fileBase64 || typeof fileBase64 !== 'string') return fail(400, 'fileBase64 is required');
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(fileBase64)) return fail(400, 'fileBase64 is invalid');
  if (!courseId || typeof courseId !== 'string') return fail(400, 'courseId is required');

  const fileBuffer = Buffer.from(fileBase64, 'base64');
  if (fileBuffer.length > MAX_BODY_BYTES) return fail(413, 'File too large (max 20 MB)');
  if (fileBuffer.length < 5 || fileBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    return fail(400, 'Uploaded file is not a valid PDF');
  }

  const fileExt = ALLOWED_TYPES[mimeType]!;
  const documentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const storagePath = user.id + '/' + courseId + '/' + documentHash + '.' + fileExt;
  await logSecurityEvent(serviceKey, user.id, 'document_upload', {
    course_id: courseId,
    bytes: fileBuffer.length
  });

  try {
    await uploadToStorage(serviceKey, storagePath, fileBuffer, mimeType);
  } catch (e: unknown) {
    await logSecurityEvent(serviceKey, user.id, 'document_upload_storage_failed', {
      message: e instanceof Error ? e.message : String(e)
    });
    return fail(500, 'File storage failed');
  }

  const docRow = {
    user_id: user.id,
    course_id: courseId,
    semester_id: semesterId ?? null,
    professor_name: professorName ?? null,
    file_name: fileName,
    file_type: fileExt,
    source_type: sourceType || 'lecture',
    storage_path: storagePath,
    processing_status: 'uploaded',
    document_hash: documentHash
  };

  const insertResult = await supaRequest<DocumentRow | DocumentRow[]>(
    'POST', 'documents', docRow, serviceKey, { Prefer: 'return=representation' }
  );
  if (insertResult.status !== 201) return fail(500, 'Failed to record document');

  const document = Array.isArray(insertResult.body) ? insertResult.body[0]! : insertResult.body as DocumentRow;

  if (pythonAiConfigured()) {
    const py = await forwardToPython('index-document', {
      userId: user.id, courseId, documentId: document.id, storagePath
    });
    if (!py.ok) {
      const err = (py.body as { error?: string }).error;
      console.warn('[documents-upload] Python indexing failed:', py.status, err);
    }
  } else {
    console.warn('[documents-upload] AI service not configured — document stays unprocessed');
  }

  return jsonResponse(201, {
    document: {
      id: document.id,
      fileName: document.file_name,
      courseId: document.course_id,
      sourceType: document.source_type,
      processingStatus: document.processing_status,
      storagePath: document.storage_path
    }
  });
};
