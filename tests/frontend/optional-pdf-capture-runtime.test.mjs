import assert from 'node:assert/strict';
import test from 'node:test';
import { shellRuntime, streamResponse, ask } from '../helpers/chat-stream-runtime.mjs';

test('optional PDF render failure still submits a general question to authoritative evidence routing', async () => {
  let payload;
  const pdf = { documentId: 'doc-a', courseId: 'course-a', fileName: 'a.pdf', visiblePage: 7, pageCount: 10, pageText: 'Lecture text' };
  const runtime = shellRuntime({
    captureStablePdfSnapshot: async () => ({ status: 'capture_failed', reason: 'renderer unavailable' }),
    authenticatedFetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return streamResponse([{ t: 'General quadratic formula explanation' }, { done: true, sourceScope: 'general_knowledge' }]);
    },
  });
  const result = await ask(runtime, { question: 'What is the quadratic formula?', pdf });
  assert.equal(result.text, 'General quadratic formula explanation');
  assert.equal(payload.activeDocumentId, 'doc-a');
  assert.equal(payload.visualContextMeta.renderedImageCount, 0);
  assert.deepEqual(payload.groundingRequest.retrievalScope, { type: 'course' });
});

test('required visible-page failure remains typed and preserves selected retrieval scope', async () => {
  let payload;
  const runtime = shellRuntime({
    captureStablePdfSnapshot: async () => ({ status: 'capture_failed', reason: 'renderer unavailable' }),
    authenticatedFetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return streamResponse([{ error: true, code: 'visible_page_capture_failed', retryable: true }]);
    },
  });
  const grounding = { retrievalScope: { type: 'documents', documentIds: ['doc-a'] }, documentAccess: { requested: 'visible_page' } };
  await assert.rejects(ask(runtime, { question: 'Read this formula', grounding,
    pdf: { documentId: 'doc-a', courseId: 'course-a', fileName: 'a.pdf', visiblePage: 7, pageText: '' },
  }), error => error.code === 'visible_page_capture_failed');
  assert.deepEqual(payload?.groundingRequest, grounding);
});
