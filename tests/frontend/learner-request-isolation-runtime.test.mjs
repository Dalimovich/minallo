// Reproduces the exact leak scenario flagged in review: an account that
// used Minallo as a student (old course selected, old course-files scope,
// old selected source, old open PDF, an old submitted groundingRequest) then
// switches to learner mode. None of that stale, course-scoped state is
// deleted on a role switch (see isLearnerAccount()'s doc comment in
// shell.ts), so every one of ragEligibility()'s and streamFromAskStream()'s
// inputs that could carry it must be neutralized once isLearnerAccount() is
// true — asserted here directly on the actual outgoing /ask-stream payload,
// not just on intermediate return values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellRuntime, streamResponse } from '../helpers/chat-stream-runtime.mjs';

const OLD_COURSE_ID = 'engineering-201';
const OLD_PDF = {
  documentId: 'old-doc-id', courseId: OLD_COURSE_ID, fileName: 'Statik-Skript.pdf',
  visiblePage: 12, pageCount: 40, pageText: 'Old lecture content', documentRevision: 'r7',
};
const dirtyChat = {
  courseId: OLD_COURSE_ID,
  sourceMode: 'course_files',
  courseFileScope: 'specific_files',
  selectedSourceIds: ['old-source-id'],
};
const dirtySourceLibrary = {
  items: [{
    id: 'old-source-id', courseId: OLD_COURSE_ID, name: 'Statik-Skript.pdf',
    documents: [{ id: 'old-doc-id', name: 'Statik-Skript.pdf' }],
  }],
};
const staleGrounding = {
  retrievalScope: { type: 'documents', documentIds: ['old-doc-id'] },
  viewerContext: { documentId: OLD_PDF.documentId, revision: OLD_PDF.documentRevision, visiblePage: OLD_PDF.visiblePage },
};
const staleRequestSnapshot = {
  userText: 'Erkläre mir den Dativ',
  sourceMode: 'course_files',
  courseFileScope: 'specific_files',
  courseId: OLD_COURSE_ID,
  selectedSourceIds: ['old-source-id'],
  activeDocumentId: OLD_PDF.documentId,
  activeDocumentName: OLD_PDF.fileName,
  visiblePage: OLD_PDF.visiblePage,
  groundingRequest: staleGrounding,
};

test('ragEligibility() refuses to reconstruct a course-scoped request from dirty pre-role-switch chat state', () => {
  const runtime = shellRuntime({
    window: { _userType: 'learner', AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout },
    sourceLibrary: dirtySourceLibrary,
    getActivePdfContext: () => OLD_PDF,
    listCourses: () => [{ id: OLD_COURSE_ID, files: [{ id: 'old-doc-id', name: 'Statik-Skript.pdf' }], userFolders: [] }],
    isPdfViewerVisible: () => true,
  }, ['ragEligibility', 'clipboardAttachmentText']);

  const messages = [{ role: 'user', text: 'Erkläre mir den Dativ' }];
  // Also feed the retry shortcut a stale submittedGrounding — the exact input
  // the un-fixed code used to trust unconditionally.
  const result = runtime.ragEligibility(messages, dirtyChat, dirtyChat.courseId, staleGrounding);

  // With every course-scoped input neutralized, there is no course context
  // left and the question has no internet/image/URL signal — the correct
  // outcome is "don't ground this", not a reconstructed course-scoped request.
  assert.equal(result, null);
});

test('streamFromAskStream() strips a stale, pre-role-switch requestSnapshot and scope before it reaches the network', async () => {
  let payload;
  const runtime = shellRuntime({
    window: { _userType: 'learner', AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout },
    authenticatedFetch: async (_url, init) => {
      payload = JSON.parse(init.body);
      return streamResponse([{ t: 'Der Dativ steht nach...' }, { done: true }]);
    },
    // The dirty activePdfContext param below (OLD_PDF) would otherwise try
    // to capture a real page snapshot; a learner never reaches this with a
    // real activePdfContext once ragEligibility() is fixed, but this test
    // deliberately forces the worst case to prove streamFromAskStream's own
    // guard holds regardless.
    captureStablePdfSnapshot: async () => ({ status: 'captured', snapshot: { activeDocument: OLD_PDF, images: [] } }),
  });

  // Simulate the worst case: every upstream input this function receives is
  // still dirty (as if an earlier guard had failed), not just the snapshot.
  await runtime.streamFromAskStream(
    'Erkläre mir den Dativ', /* courseId */ OLD_COURSE_ID, null, new AbortController(), [], null,
    /* documentIds */ ['old-doc-id'], /* documentNames */ ['Statik-Skript.pdf'],
    /* groundingRequest */ staleGrounding, null, true, /* activePdfContext */ OLD_PDF,
    'conversation-a', [], false, 'request-a',
    { id: 'assistant-a', requestSnapshot: staleRequestSnapshot },
  );

  assert.ok(payload, 'a learner must still get an answer for a plain question');
  assert.equal(payload.sourceMode, 'auto', 'old course_files mode must not survive the role switch');
  assert.equal(payload.courseFileScope, 'all_course_files', 'old specific_files scope must not survive the role switch');
  assert.equal(payload.groundingRequest.retrievalScope.type, 'course', 'old document-scoped retrieval must not survive the role switch');
  assert.equal(payload.groundingRequest.viewerContext, undefined, 'old viewer context must not survive the role switch');
  assert.equal(payload.documentIds, undefined, 'old document ids must not be sent once scope is not specific_files');
  assert.equal(payload.documentNames, undefined, 'old document names must not be sent once scope is not specific_files');
  assert.equal(payload.activeDocumentId, undefined, 'old open-PDF identity must not survive the role switch');

  assert.ok(payload.requestSnapshot, 'requestSnapshot must still be echoed back for the resume/regenerate contract');
  assert.equal(payload.requestSnapshot.courseId, '', 'stale courseId must be stripped from the echoed snapshot');
  assert.deepEqual(payload.requestSnapshot.selectedSourceIds, [], 'stale selectedSourceIds must be stripped from the echoed snapshot');
  assert.equal(payload.requestSnapshot.activeDocumentId, undefined, 'stale activeDocumentId must be stripped from the echoed snapshot');
  assert.equal(payload.requestSnapshot.groundingRequest, undefined, 'stale groundingRequest must be stripped from the echoed snapshot');
  assert.equal(payload.requestSnapshot.sourceMode, 'auto');
  assert.equal(payload.requestSnapshot.courseFileScope, 'all_course_files');
});
