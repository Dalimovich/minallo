import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const component = readFileSync('frontend/js/features/chatbot-new/chat-attachments.ts', 'utf8');
const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');

test('chat files use one accessible reusable attachment card', () => {
  assert.match(shell, /renderAttachmentCard/);
  assert.match(component, /data-chat-attachment-id/);
  assert.match(component, /aria-label="Open/);
  assert.match(component, /chat-file-card__thumbnail/);
  assert.match(css, /grid-template-columns:\s*46px minmax\(0, 1fr\) auto/);
  assert.match(css, /text-overflow:\s*ellipsis/);
});

test('attachment viewer has working modal and question composer controls', () => {
  assert.match(component, /role="dialog" aria-modal="true"/);
  assert.match(component, /Ask Minallo about this file/);
  assert.match(component, /ev\.key === 'Escape'/);
  assert.match(component, /ev\.key === 'Enter' && !ev\.shiftKey/);
  assert.match(component, /onAsk\(question, item\)/);
  assert.match(css, /width:\s*min\(1280px, 96vw\)/);
  assert.match(css, /height:\s*min\(900px, 94vh\)/);
  assert.match(css, /height:\s*100dvh/);
});

test('file questions persist a real-id reference and hard-scope RAG to it', () => {
  assert.match(shell, /attachmentRefs:\s*ref/);
  assert.match(shell, /attachmentRefs\?\.map\(\(ref\) => \(\{ \.\.\.ref \}\)\)/);
  assert.match(shell, /documentIds:\s*\[explicitAttachment\.fileId\]/);
  assert.match(shell, /courseId:\s*explicitAttachment\.courseId/);
  assert.match(shell, /appendUserBubble\(msgs, question, \[\], \[file\], userMessage\.id\)/);
});
