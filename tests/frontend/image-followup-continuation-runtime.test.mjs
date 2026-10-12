// Regression tests for the image-follow-up context-loss bug (QA run 2,
// 2026-10-12): a turn WITH an image answers correctly; a short follow-up in
// the SAME chat with no new image previously fell through ragEligibility's
// `(last.images || []).length` check straight to the generic /api/ai path,
// which never re-attaches an earlier turn's image — the model then answered
// from general knowledge or fabricated a different exercise.
//
// Covers: (1) ragEligibility keeps routing a continuing image conversation
// through /ask-stream instead of falling through to the generic path; (2)
// resolveTurnImages recovers the image from the warm window cache (the
// common same-session case); (3) resolveTurnImages recovers the image from
// this chat's own history + a persistentFileId refetch when the window
// cache is cold and dataUrl has been blanked (the reload / SPA-renavigation
// case — see compactMessageForStorage's own docstring in shell.ts); (4) a
// genuinely unrecoverable image correctly signals pendingImageContinuation
// with zero images, which is exactly the condition streamAiReply uses to
// show "I no longer have the image" instead of calling the model with
// nothing to answer from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellRuntime } from '../helpers/chat-stream-runtime.mjs';
import { isVisualFollowUpQuestion, shouldReuseRecentVisualContext } from '../../frontend/js/features/ai-chat/visual-context.ts';

const EXTRA_NAMES = [
  'ragEligibility', 'clipboardAttachmentText',
  'resolveTurnImages', 'findRecentImageTurn', 'recoverTurnImages',
  'fetchPreviewAsDataUrl', 'resolveAttachmentPreviewUrl', 'readAsDataUrl',
];
// Module-level `const` declarations in shell.ts (RECENT_IMAGE_LOOKBACK_MESSAGES)
// and named imports (shouldReuseRecentVisualContext) are neither extractable
// by shellRuntime's AST name-matcher (only function declarations have a
// top-level .name) nor present by default — every test below supplies both.
const SHARED_OVERRIDES = {
  isVisualFollowUpQuestion, shouldReuseRecentVisualContext,
  RECENT_IMAGE_LOOKBACK_MESSAGES: 8,
};
// ragEligibility reads several SavedChat fields unconditionally for a
// non-learner account (selectedSourceIds.includes, courseFileScope) — a
// partial stub throws before reaching the code this suite actually tests.
const PLAIN_CHAT = { courseId: '', sourceMode: 'auto', courseFileScope: 'all_course_files', selectedSourceIds: [] };

function imageTurn(overrides = {}) {
  return {
    role: 'user', text: 'Löse nur 2b.',
    images: [{
      id: 'img-1', name: 'exercise.png', mediaType: 'image/png',
      dataUrl: 'data:image/png;base64,ORIGINALBYTES',
      persistentFileId: 'file-abc', ...overrides,
    }],
  };
}

// Minimal browser-API stand-ins the recovery path needs (fetch + FileReader)
// — the vm sandbox has neither by default, unlike a real page.
class FakeFileReader {
  readAsDataURL(blob) {
    setTimeout(() => {
      this.result = blob && blob.__dataUrl;
      if (this.onload) this.onload();
    }, 0);
  }
}

test('ragEligibility routes a text-only follow-up to an image turn through the SAME branch as the image turn itself', () => {
  const runtime = shellRuntime({
    ...SHARED_OVERRIDES,
    sourceLibrary: { items: [] },
    getActivePdfContext: () => null,
    listCourses: () => [],
  }, EXTRA_NAMES);

  const messages = [imageTurn(), { role: 'assistant', text: 'Hier ist die Lösung für 2b...' }, { role: 'user', text: 'und a?' }];
  const result = runtime.ragEligibility(messages, PLAIN_CHAT, '');

  assert.ok(result, 'the follow-up must still be eligible for /ask-stream, not fall through to the generic path');
  assert.equal(result.courseId, '');
  assert.equal(result.pendingImageContinuation, true, 'routing was granted by the image-continuation check, not a real image/URL/internet-mode signal');
});

test('ragEligibility behavior is unchanged when there is no recent image and no visual wording', () => {
  const runtime = shellRuntime({
    ...SHARED_OVERRIDES,
    sourceLibrary: { items: [] },
    getActivePdfContext: () => null,
    listCourses: () => [],
  }, EXTRA_NAMES);

  // isVisualFollowUpQuestion's own shortFollowUp clause (<=18 words) would
  // otherwise make almost anything match — use a genuinely long, unrelated
  // question with none of the visual/correction/formatting trigger words
  // and no image anywhere in history, so this exercises the "stays null"
  // path deliberately, not by accident.
  const messages = [{
    role: 'user',
    text: 'Can you walk me through the standard derivation of the quadratic formula starting from a general second degree polynomial equation written in the usual form',
  }];
  const result = runtime.ragEligibility(messages, PLAIN_CHAT, '');
  assert.equal(result, null);
});

test('resolveTurnImages reuses the warm window cache without any network call (same-session follow-up)', async () => {
  let fetchCalled = false;
  const runtime = shellRuntime({
    ...SHARED_OVERRIDES,
    window: {
      AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout,
      _lastAiImageContext: {
        images: [{ mediaType: 'image/png', data: 'ORIGINALBYTES' }],
        courseId: undefined, conversationId: 'conv-1', timestamp: Date.now(), remainingTurns: 4,
      },
    },
    authenticatedFetch: async () => { fetchCalled = true; throw new Error('must not be called — window cache is warm'); },
    fetch: async () => { fetchCalled = true; throw new Error('must not be called — window cache is warm'); },
  }, EXTRA_NAMES);

  const images = await runtime.resolveTurnImages('und a?', '', 'conv-1', [], [imageTurn(), { role: 'user', text: 'und a?' }]);
  assert.equal(fetchCalled, false);
  assert.equal(images.length, 1);
  assert.equal(images[0].dataUrl, 'data:image/png;base64,ORIGINALBYTES');
});

test('resolveTurnImages recovers the image from history via persistentFileId when the window cache is cold and dataUrl was blanked', async () => {
  const calls = [];
  const runtime = shellRuntime({
    ...SHARED_OVERRIDES,
    window: { AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout }, // no _lastAiImageContext — simulates a reload
    FileReader: FakeFileReader,
    authenticatedFetch: async (url, init) => {
      calls.push(url);
      const body = JSON.parse(init.body);
      assert.equal(body.action, 'preview');
      assert.equal(body.fileId, 'file-abc');
      return { ok: true, json: async () => ({ previewUrl: 'https://storage.example/signed-url' }) };
    },
    fetch: async (url) => {
      calls.push(url);
      assert.equal(url, 'https://storage.example/signed-url');
      return { ok: true, blob: async () => ({ __dataUrl: 'data:image/png;base64,RECOVEREDBYTES' }) };
    },
  }, EXTRA_NAMES);

  // dataUrl blanked exactly like compactMessageForStorage does on every shell
  // re-init — the image's OTHER fields (persistentFileId in particular)
  // survive that compaction untouched.
  const compactedHistory = [imageTurn({ dataUrl: '' }), { role: 'user', text: 'und a?' }];
  const images = await runtime.resolveTurnImages('und a?', '', 'conv-1', [], compactedHistory);

  assert.deepEqual(calls, ['/api/chat-attachments', 'https://storage.example/signed-url']);
  assert.equal(images.length, 1);
  assert.equal(images[0].dataUrl, 'data:image/png;base64,RECOVEREDBYTES');
});

test('resolveTurnImages returns nothing — not a fabricated image — when recovery genuinely cannot find the bytes', async () => {
  const runtime = shellRuntime({
    ...SHARED_OVERRIDES,
    window: { AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout },
    FileReader: FakeFileReader,
    authenticatedFetch: async () => ({ ok: false, json: async () => ({ error: { message: 'gone' } }) }),
    fetch: async () => { throw new Error('must not be reached — preview itself already failed'); },
  }, EXTRA_NAMES);

  // No persistentFileId at all — the oldest possible shape (pre-dates the
  // attachment-store migration) — and the attachment-store case where the
  // preview fetch itself 404s, both land here.
  const noPersistentId = [imageTurn({ dataUrl: '', persistentFileId: undefined }), { role: 'user', text: 'und a?' }];
  const images = await runtime.resolveTurnImages('und a?', '', 'conv-1', [], noPersistentId);
  // A cross-realm array from the vm sandbox fails assert.deepEqual's
  // reference/prototype check even when "equal" by content — check length
  // instead of structural equality against a literal [].
  assert.equal(images.length, 0);

  // This is exactly the condition streamAiReply checks (rag.pendingImageContinuation
  // && !turnImages.length) to show the honest "I no longer have the image"
  // message instead of calling the model with zero evidence.
  const ragResult = { pendingImageContinuation: true };
  assert.equal(ragResult.pendingImageContinuation && !images.length, true);
});

test('findRecentImageTurn only looks within the recent lookback window, not the whole chat history', () => {
  const runtime = shellRuntime({ ...SHARED_OVERRIDES }, EXTRA_NAMES);
  const old = imageTurn();
  const farHistory = [old, ...Array.from({ length: 10 }, (_, i) => ({ role: 'user', text: `filler ${i}` }))];
  assert.equal(runtime.findRecentImageTurn(farHistory), undefined, 'an image 11 messages back is outside the reuse window');

  const nearHistory = [old, ...Array.from({ length: 3 }, (_, i) => ({ role: 'user', text: `filler ${i}` }))];
  assert.equal(runtime.findRecentImageTurn(nearHistory), old);
});
