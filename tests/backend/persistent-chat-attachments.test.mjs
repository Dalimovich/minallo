import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const endpoint = readFileSync('backend/functions/chat-attachments.ts', 'utf8');
const migration = readFileSync('supabase/migrations/20260727_000009_persistent_ai_chat_attachments.sql', 'utf8');
const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

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
  assert.match(shell, /action: 'preview', fileId: attachment\.fileId/);
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
