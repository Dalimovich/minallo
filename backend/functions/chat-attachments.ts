import crypto from 'crypto';
import { requireEnv } from '../lib/env';
import { extractBearerToken, verifySupabaseToken } from '../lib/supabase-auth';
import { fail, handleOptions, jsonResponse } from '../lib/responses';
import { supaRequest } from '../lib/supabase-admin';
import { forwardToPython, pythonAiConfigured } from '../lib/python-ai-proxy';
import type { LambdaResponse, NetlifyEvent } from '../lib/types';

const BUCKET = 'chat-attachments';
const MAX_BYTES = 25 * 1024 * 1024;
const SAFE_MIME = /^(application\/pdf|image\/(png|jpeg|webp)|text\/(plain|markdown)|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation)))$/i;

function attachmentFailure(statusCode: number, stage: string, code: string, message: string, retryable = true): LambdaResponse {
  return jsonResponse(statusCode, { error: { stage, code, message, retryable } });
}

function safeExtension(filename: string, mimeType: string): string {
  const match = filename.toLowerCase().match(/\.[a-z0-9]{1,10}$/);
  if (match) return match[0];
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'text/plain') return '.txt';
  if (mimeType === 'text/markdown') return '.md';
  return '';
}

interface FileRow { id: string; owner_id: string; document_id?: string | null; original_filename: string; storage_bucket: string; storage_path: string; mime_type: string; size_bytes?: number; indexing_status?: string | null }

async function storageRequest(method: string, path: string, body?: Buffer, contentType = 'application/octet-stream'): Promise<Response> {
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(requireEnv('SUPABASE_URL').replace(/\/$/, '') + '/storage/v1/' + path, {
    method, headers: { apikey: key, Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': contentType, 'x-upsert': 'false' } : { 'Content-Type': 'application/json' }) },
    body
  });
}

export const handler = async (event: NetlifyEvent): Promise<LambdaResponse> => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return fail(405, 'Method not allowed');
  const token = extractBearerToken(event.headers);
  const user = token ? await verifySupabaseToken(token) : null;
  if (!user) return fail(401, 'Invalid or expired token');
  let body: Record<string, unknown>;
  try { body = JSON.parse(event.body || '{}') as Record<string, unknown>; } catch { return fail(400, 'Invalid JSON'); }
  const action = String(body.action || '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (action === 'upload') {
    const filename = String(body.filename || '').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 180);
    const mimeType = String(body.mimeType || 'application/octet-stream');
    const encoded = String(body.base64 || '');
    if (!filename || !SAFE_MIME.test(mimeType) || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) return attachmentFailure(400, 'validation', 'unsupported_attachment', 'Unsupported attachment', false);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES) return attachmentFailure(413, 'validation', bytes.length ? 'file_too_large' : 'file_missing', 'Attachment is empty or too large', false);
    const fileId = crypto.randomUUID();
    const storagePath = `${user.id}/${fileId}${safeExtension(filename, mimeType)}`;
    const upload = await storageRequest('POST', `object/${BUCKET}/${storagePath}`, bytes);
    if (!upload.ok) {
      console.error('chat_attachment_send_failed', { stage: 'storage_upload', code: 'storage_upload_failed', fileName: filename, mimeType, sizeBytes: bytes.length, storageBucket: BUCKET, storagePath, status: upload.status });
      return attachmentFailure(502, 'storage_upload', upload.status === 403 ? 'storage_policy_denied' : 'storage_upload_failed', 'Attachment storage failed');
    }
    let documentId: string | null = null;
    let indexingStatus: string | null = null;
    const courseId = typeof body.courseId === 'string' ? body.courseId : null;
    if (mimeType === 'application/pdf' && courseId) {
      const doc = await supaRequest<Array<{ id: string }> | { id: string }>('POST', 'documents', {
        user_id: user.id, course_id: courseId, file_name: filename, file_type: 'pdf',
        source_type: 'chat_attachment', storage_path: `${BUCKET}:${storagePath}`,
        processing_status: 'uploaded', document_hash: crypto.createHash('sha256').update(bytes).digest('hex')
      }, key, { Prefer: 'return=representation' });
      const created = Array.isArray(doc.body) ? doc.body[0] : doc.body;
      if (doc.status !== 201 || !created?.id) {
        await storageRequest('DELETE', `object/${BUCKET}/${storagePath}`).catch(() => undefined);
        return attachmentFailure(500, 'file_record', 'document_record_failed', 'Attachment document record could not be saved');
      }
      documentId = created.id;
      indexingStatus = 'processing';
      if (!pythonAiConfigured() || !(await forwardToPython('index-document', { userId: user.id, courseId, documentId, storagePath: `${BUCKET}:${storagePath}` })).ok) {
        indexingStatus = 'failed';
        await supaRequest('PATCH', `documents?id=eq.${encodeURIComponent(documentId)}`, { processing_status: 'failed' }, key);
      }
    }
    const insert = await supaRequest<FileRow | FileRow[]>('POST', 'ai_chat_files', {
      id: fileId, owner_id: user.id, course_id: typeof body.courseId === 'string' ? body.courseId : null,
      document_id: documentId,
      original_filename: filename, storage_bucket: BUCKET, storage_path: storagePath,
      mime_type: mimeType, size_bytes: bytes.length, upload_status: 'ready', indexing_status: indexingStatus
    }, key, { Prefer: 'return=representation' });
    if (insert.status !== 201) {
      if (documentId) await supaRequest('DELETE', `documents?id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(user.id)}`, null, key).catch(() => undefined);
      await storageRequest('DELETE', `object/${BUCKET}/${storagePath}`).catch(() => undefined);
      return attachmentFailure(500, 'file_record', 'file_record_failed', 'Attachment metadata could not be saved');
    }
    return jsonResponse(201, { fileId, documentId, filename, mimeType, sizeBytes: bytes.length, indexingStatus });
  }

  if (action === 'link') {
    const fileId = String(body.fileId || ''), conversationId = String(body.conversationId || ''), messageId = String(body.messageId || '');
    const owned = await supaRequest<FileRow[]>('GET', `ai_chat_files?id=eq.${encodeURIComponent(fileId)}&owner_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`, null, key);
    if (!Array.isArray(owned.body) || !owned.body[0]) return fail(403, 'Attachment access denied');
    const conversation = await supaRequest<Array<{ id: string }>>('GET', `ai_chat_conversations?id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`, null, key);
    if (!Array.isArray(conversation.body) || !conversation.body[0]) return fail(403, 'Conversation access denied');
    const messageText = String(body.messageText || '').trim();
    if (!messageText) return fail(400, 'messageText is required');
    const message = await supaRequest('POST', 'ai_chat_messages', {
      conversation_id: conversationId, user_id: user.id, client_message_id: messageId,
      role: 'user', content: messageText
    }, key, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (message.status < 200 || message.status >= 300) return attachmentFailure(409, 'message_creation', 'message_creation_failed', 'Message could not be persisted');
    const inserted = await supaRequest('POST', 'ai_chat_message_attachments', {
      conversation_id: conversationId, client_message_id: messageId, file_id: fileId,
      attachment_order: Number(body.order) || 0, page_number: Number(body.page) || null
    }, key, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    if (inserted.status < 200 || inserted.status >= 300) return attachmentFailure(409, 'message_attachment_relation', 'message_attachment_relation_failed', 'Attachment could not be linked to this message');
    return jsonResponse(200, { linked: true });
  }

  if (action === 'preview') {
    const fileId = String(body.fileId || '');
    const found = await supaRequest<FileRow[]>('GET', `ai_chat_files?id=eq.${encodeURIComponent(fileId)}&owner_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`, null, key);
    const file = Array.isArray(found.body) ? found.body[0] : null;
    if (!file) return fail(404, 'This file is no longer available');
    const signed = await storageRequest('POST', `object/sign/${file.storage_bucket}/${file.storage_path}`, Buffer.from(JSON.stringify({ expiresIn: 300 })), 'application/json');
    if (!signed.ok) return fail(signed.status === 403 ? 403 : 502, signed.status === 403 ? 'You do not have access to this file' : 'Preview could not be created');
    const data = await signed.json() as { signedURL?: string; signedUrl?: string };
    let previewUrl = data.signedURL || data.signedUrl || '';
    if (previewUrl && !previewUrl.startsWith('http')) previewUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '') + (previewUrl.startsWith('/storage') ? '' : '/storage/v1') + previewUrl;
    return jsonResponse(200, { fileId: file.id, filename: file.original_filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, previewUrl, documentId: file.document_id, indexingStatus: file.indexing_status });
  }
  if (action === 'hydrate') {
    const conversationId = String(body.conversationId || '');
    const conversation = await supaRequest<Array<{ id: string }>>('GET', `ai_chat_conversations?id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`, null, key);
    if (!Array.isArray(conversation.body) || !conversation.body[0]) return fail(403, 'Conversation access denied');
    const relations = await supaRequest<Array<{ id: string; client_message_id: string; file_id: string; attachment_order: number; page_number?: number }>>('GET', `ai_chat_message_attachments?conversation_id=eq.${encodeURIComponent(conversationId)}&select=id,client_message_id,file_id,attachment_order,page_number&order=attachment_order.asc`, null, key);
    const rows = Array.isArray(relations.body) ? relations.body : [];
    const ids = Array.from(new Set(rows.map(row => row.file_id)));
    const files = ids.length ? await supaRequest<FileRow[]>('GET', `ai_chat_files?id=in.(${ids.map(encodeURIComponent).join(',')})&owner_id=eq.${encodeURIComponent(user.id)}&select=id,document_id,original_filename,mime_type,size_bytes,indexing_status`, null, key) : { status: 200, body: [] as FileRow[] };
    const byId = new Map((Array.isArray(files.body) ? files.body : []).map(file => [file.id, file]));
    return jsonResponse(200, { attachments: rows.map(row => ({ ...row, file: byId.get(row.file_id) || null })) });
  }
  return fail(400, 'Unknown action');
};
