// Regression for a second image-follow-up fabrication bug (QA run, live
// production, 2026-10-13), distinct from image-followup-continuation-runtime
// .test.mjs: Fix 2 (e903ffa5) only recovers PASTED images (m.images, via
// recoverTurnImages/resolveTurnImages). An image attached via "Add files"
// is a PendingFile (m.files, kind 'image') — a separate shape with its own
// `base64` field, which compactMessageForStorage strips on every shell
// re-init exactly like it blanks an image's dataUrl (see shell.ts's own
// compact.files mapping — base64 and pageImages are simply absent from it).
// Before this fix, buildApiMessages' per-file branching had no recovery for
// this case: a stripped "Add files" image fell through every kind check
// straight to the generic "(The file ... is a binary format that could not
// be read as text.)" placeholder, and the model — given a placeholder
// instead of any real evidence — fabricated a plausible-looking exercise.
// Confirmed live: IMG08 via "Add files", reload, "und a?" answered an
// invented limit problem instead of the real exercise 2a.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shellRuntime } from '../helpers/chat-stream-runtime.mjs';

const shellSource = readFileSync(new URL('../../frontend/js/features/chatbot-new/shell.ts', import.meta.url), 'utf8');

const EXTRA_NAMES = ['recoverTurnFileImages', 'fetchPreviewAsDataUrl', 'resolveAttachmentPreviewUrl', 'readAsDataUrl'];

class FakeFileReader {
  readAsDataURL(blob) {
    setTimeout(() => {
      this.result = blob && blob.__dataUrl;
      if (this.onload) this.onload();
    }, 0);
  }
}

function fileEntry(overrides = {}) {
  return {
    id: 'file-1', name: 'IMG08.png', kind: 'image', mediaType: 'image/png',
    persistentFileId: 'persist-1', ...overrides,
    // base64 intentionally absent by default — the post-reload shape.
  };
}

test('recoverTurnFileImages recovers a stripped "Add files" image via persistentFileId', async () => {
  const calls = [];
  const runtime = shellRuntime({
    window: { AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout },
    FileReader: FakeFileReader,
    authenticatedFetch: async (url, init) => {
      calls.push(url);
      const body = JSON.parse(init.body);
      assert.equal(body.action, 'preview');
      assert.equal(body.fileId, 'persist-1');
      return { ok: true, json: async () => ({ previewUrl: 'https://storage.example/signed-url' }) };
    },
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, blob: async () => ({ __dataUrl: 'data:image/png;base64,RECOVEREDFILEBYTES' }) };
    },
  }, EXTRA_NAMES);

  const map = await runtime.recoverTurnFileImages([fileEntry()]);
  assert.deepEqual(calls, ['/api/chat-attachments', 'https://storage.example/signed-url']);
  assert.equal(map.get('file-1'), 'RECOVEREDFILEBYTES');
});

test('recoverTurnFileImages leaves a genuinely unrecoverable image out of the map — never fabricates a result', async () => {
  const runtime = shellRuntime({
    window: { AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout },
    FileReader: FakeFileReader,
    authenticatedFetch: async () => ({ ok: false, json: async () => ({ error: { message: 'gone' } }) }),
    fetch: async () => { throw new Error('must not be reached — preview already failed'); },
  }, EXTRA_NAMES);

  const noPersistentId = await runtime.recoverTurnFileImages([fileEntry({ persistentFileId: undefined })]);
  assert.equal(noPersistentId.size, 0);

  const previewFails = await runtime.recoverTurnFileImages([fileEntry()]);
  assert.equal(previewFails.size, 0);
});

test('recoverTurnFileImages skips files that already have base64 or are not images — no needless network call', async () => {
  let called = false;
  const runtime = shellRuntime({
    window: { AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout },
    authenticatedFetch: async () => { called = true; throw new Error('must not be called'); },
    fetch: async () => { called = true; throw new Error('must not be called'); },
  }, EXTRA_NAMES);

  await runtime.recoverTurnFileImages([
    fileEntry({ base64: 'ALREADYHERE' }),
    { id: 'file-2', name: 'notes.txt', kind: 'text', textContent: 'hi', persistentFileId: 'persist-2' },
  ]);
  assert.equal(called, false);
});

test('buildApiMessages wires the recovered file-image bytes into a real image block', () => {
  const start = shellSource.indexOf('const recoveredFileImages = await recoverTurnFileImages(m.files || []);');
  assert.ok(start >= 0, 'buildApiMessages must call recoverTurnFileImages for m.files');
  const branch = shellSource.slice(start, start + 700);
  assert.match(branch, /f\.kind === 'image' && \(f\.base64 \|\| recoveredData\) && f\.mediaType/);
  assert.match(branch, /data: f\.base64 \|\| recoveredData!/);
});

test('an unrecoverable "Add files" image gets an explicit honest instruction, never the generic binary-format placeholder', () => {
  const start = shellSource.indexOf('const recoveredFileImages = await recoverTurnFileImages(m.files || []);');
  const binaryPlaceholderIdx = shellSource.indexOf("is a binary format that could not be read as text", start);
  const honestInstructionIdx = shellSource.indexOf('is no longer available', start);
  assert.ok(honestInstructionIdx >= 0 && honestInstructionIdx < binaryPlaceholderIdx,
    'the image-specific honest-instruction branch must come before (be checked ahead of) the generic binary-format fallback');
  const instruction = shellSource.slice(honestInstructionIdx - 200, honestInstructionIdx + 300);
  assert.match(instruction, /Do not guess its content or invent an answer/);
  assert.match(instruction, /in their own.*language/s);
  // This branch must only ever trigger for kind === 'image' — the binary
  // placeholder stays reachable for real non-image binaries.
  const guardStart = shellSource.lastIndexOf("} else if (f.kind === 'image') {", honestInstructionIdx);
  assert.ok(guardStart >= 0 && guardStart < honestInstructionIdx);
});
