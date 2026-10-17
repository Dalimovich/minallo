import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('local and persisted conversation identities are separate and creation is single-flight', () => {
  assert.match(shell, /persistedId:\s*string \| null/);
  assert.match(shell, /persistenceStatus:\s*'local' \| 'creating' \| 'persisted' \| 'failed'/);
  assert.match(shell, /inFlightConversationCreates/);
  assert.match(shell, /clientConversationId:\s*chat\.id/);
  assert.match(shell, /clientMessageId:\s*context\.message\?\.id/);
  assert.match(shell, /durable!\.conversationId/);
});

test('grounded requests fail closed and artifact matching excludes broad creation words', () => {
  assert.match(shell, /code:\s*'rag_service_unavailable'/);
  assert.doesNotMatch(shell, /generatedArtifactIsExplicit[^;]+generated\|created/);
  assert.match(shell, /visualUpload:\s*true/);
  assert.match(shell, /if \(!data\) return \[\]/);
});
