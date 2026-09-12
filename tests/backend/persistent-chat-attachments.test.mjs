import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const endpoint = readFileSync('backend/functions/chat-attachments.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20260727_000009_persistent_ai_chat_attachments.sql', 'utf8');
const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const pagesShimGenerator = readFileSync('scripts/generate-pages-shims.mjs', 'utf8');

test('Cloudflare Pages exposes the persistent attachment endpoint', () => {
  assert.match(pagesShimGenerator, /\['chat-attachments',\s*'chat-attachments'\]/);
});

test('sent chat files use private object storage and permanent database records', () => {
  assert.match(endpoint, /const BUCKET = 'chat-attachments'/);
  assert.match(endpoint, /POST', 'ai_chat_files'/);
  assert.match(migration, /create table if not exists public\.ai_chat_files/);
  assert.match(migration, /storage_bucket text not null/);
  assert.match(migration, /storage_path text not null/);
});

test('message/file relation is durable, ordered, and protected by ownership checks', () => {
  assert.match(migration, /create table if not exists public\.ai_chat_message_attachments/);
  assert.match(migration, /references public\.ai_chat_messages\(conversation_id, client_message_id\)/);
  assert.match(endpoint, /Conversation access denied/);
  assert.match(endpoint, /Attachment access denied/);
  assert.match(endpoint, /action === 'hydrate'/);
});

test('frontend persists before rendering sent state and refreshes preview URLs', () => {
  const persist = shell.indexOf('await persistMessageAttachments(userMessage)');
  const render = shell.indexOf('appendUserBubble(msgs, text, images, files, userMessage.id)', persist);
  assert.ok(persist >= 0 && render > persist);
  assert.match(shell, /action: 'preview', fileId/);
  assert.match(shell, /resolveAttachmentPreviewUrl\(attachment\.fileId\)/);
  assert.match(shell, /Your draft is still available/);
  assert.match(shell, /persistentFileId/);
});

test('PDF attachments create exact RAG document identities without filename lookup', () => {
  assert.match(endpoint, /source_type: 'chat_attachment'/);
  assert.match(endpoint, /document_id: documentId/);
  assert.match(endpoint, /forwardToPython\('index-document'/);
  assert.match(shell, /fileId: attachment\.documentId/);
});

test('metadata failure removes uploaded objects and document records', () => {
  assert.match(endpoint, /DELETE', `documents\?id=eq\./);
  assert.match(endpoint, /storageRequest\('DELETE'/);
});

test('unsafe original filenames never become object storage paths', () => {
  assert.match(endpoint, /safeExtension\(filename, mimeType\)/);
  assert.match(endpoint, /`\$\{user\.id\}\/\$\{fileId\}\$\{safeExtension/);
  assert.doesNotMatch(endpoint, /`\$\{user\.id\}\/\$\{fileId\}\/\$\{filename\}`/);
  assert.match(endpoint, /original_filename: filename/);
});

test('attachment failures expose structured stages without leaking file data', () => {
  assert.match(endpoint, /chat_attachment_send_failed/);
  assert.match(endpoint, /storage_policy_denied/);
  assert.match(endpoint, /message_attachment_relation_failed/);
  assert.match(shell, /class AttachmentSendError/);
  assert.match(shell, /Your draft is still available/);
});

test('direct uploads are idempotent across auth retries and repeated sends', () => {
  assert.match(shell, /clientUploadId: item\.id/);
  assert.match(shell, /\}, \{ safeToRetry: true \}\)/);
  assert.match(endpoint, /idempotentFileId\(user\.id, clientUploadId, contentHash\)/);
  assert.match(endpoint, /if \(Array\.isArray\(prior\.body\) && prior\.body\[0\]\) return uploadResult/);
});

test('an identical ready PDF reuses its durable chat file instead of uploading again', () => {
  const lookup = endpoint.indexOf('document_hash=eq.${contentHash}');
  const storageUpload = endpoint.indexOf("storageRequest('POST'", lookup);
  assert.ok(lookup >= 0 && storageUpload > lookup);
  assert.match(endpoint, /source_type=eq\.chat_attachment/);
  assert.match(endpoint, /processing_status=eq\.ready/);
  assert.match(endpoint, /document_id=eq\.\$\{encodeURIComponent\(documentId\)\}/);
  assert.match(endpoint, /return uploadResult\(existingFile\.body\[0\]\)/);
});

test('composer locks while attachments persist and direct attachment owns the request snapshot', () => {
  assert.match(shell, /state\.isSending = true;\s*sendBtn\.disabled = true;\s*try \{\s*await persistMessageAttachments/);
  assert.match(shell, /activeDocumentId: directAttachment\?\.fileId \|\| pdf\?\.documentId/);
  assert.match(shell, /activeDocumentName: directAttachment\?\.filename \|\| pdf\?\.fileName/);
});
