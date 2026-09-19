import assert from 'node:assert/strict';
import test from 'node:test';
import { shellRuntime, streamResponse, ask } from '../helpers/chat-stream-runtime.mjs';

test('chat switch during PDF capture retains the submitted source mode and selected scope', async () => {
  let payload;
  const pdf = { documentId: 'doc-a', courseId: 'course-a', fileName: 'a.pdf', visiblePage: 7, pageCount: 10, pageText: 'page', documentRevision: 'r1' };
  const runtime = shellRuntime({
    sourceModeForActiveChat: () => 'course_files', courseFileScopeForActiveChat: () => 'specific_files',
    captureStablePdfSnapshot: async () => {
      runtime.sourceModeForActiveChat = () => 'internet';
      runtime.courseFileScopeForActiveChat = () => 'all_course_files';
      return { status: 'captured', snapshot: { activeDocument: pdf, images: [] } };
    },
    authenticatedFetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return streamResponse([{ t: 'Grounded answer' }, { done: true }]);
    },
  });
  await ask(runtime, { pdf, ids: ['doc-a'], grounding: { retrievalScope: { type: 'documents', documentIds: ['doc-a'] } },
    message: { id: 'assistant-a', requestSnapshot: { sourceMode: 'course_files', courseFileScope: 'specific_files' } } });
  assert.equal(payload.sourceMode, 'course_files');
  assert.equal(payload.courseFileScope, 'specific_files');
  assert.deepEqual(payload.documentIds, ['doc-a']);
  assert.equal(payload.courseId, 'course-a');
});

test('retry preserves original retrieval scope even when the previous resolution used fewer documents', async () => {
  let payload;
  const grounding = { retrievalScope: { type: 'documents', documentIds: ['doc-a', 'doc-b'] } };
  const runtime = shellRuntime({ authenticatedFetch: async (_url, init) => {
    payload = JSON.parse(init.body);
    return streamResponse([{ t: 'Answer' }, { done: true }]);
  } });
  await ask(runtime, { grounding, ids: ['doc-a', 'doc-b'], durable: true, message: {
    id: 'assistant-a', requestSnapshot: { sourceMode: 'course_files', courseFileScope: 'specific_files',
      groundingRequest: grounding, groundingResolution: { documentIds: ['doc-a'] } },
  } });
  assert.deepEqual(payload.groundingRequest.retrievalScope, grounding.retrievalScope);
});

test('late capture from another document cannot replace the submitted viewer evidence', async () => {
  let sent = false;
  const runtime = shellRuntime({
    captureStablePdfSnapshot: async () => ({ status: 'captured', snapshot: { activeDocument: {
      documentId: 'doc-b', courseId: 'course-b', visiblePage: 8, pageText: 'wrong document',
    }, images: [] } }),
    authenticatedFetch: async () => { sent = true; return streamResponse([{ t: 'Wrong' }, { done: true }]); },
  });
  await assert.rejects(ask(runtime, { pdf: { documentId: 'doc-a', courseId: 'course-a', visiblePage: 7 },
    grounding: { retrievalScope: { type: 'documents', documentIds: ['doc-a'] }, documentAccess: { requested: 'visible_page' } },
  }), error => error.code === 'visible_page_snapshot_unstable');
  assert.equal(sent, false);
});
