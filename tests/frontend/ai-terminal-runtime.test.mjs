import assert from 'node:assert/strict';
import test from 'node:test';
import { shellRuntime, streamResponse, encodeEvents, ask } from '../helpers/chat-stream-runtime.mjs';

test('native read rejection preserves the partial answer in a typed recoverable error', async () => {
  let read = 0, cancelled = 0;
  const runtime = shellRuntime({ authenticatedFetch: async () => ({ ok: true, body: { getReader: () => ({
    read: async () => { if (!read++) return { done: false, value: encodeEvents([{ t: 'Keep this explanation.' }]) }; throw new TypeError('network disconnected'); },
    cancel: async () => { cancelled++; },
  }) } }) });
  await assert.rejects(ask(runtime), error => {
    assert.equal(error.code, 'stream_transport_interrupted');
    assert.equal(error.metadata.partialAnswer, 'Keep this explanation.');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(cancelled, 1);
});

test('done is terminal even when the connection stays open and trailing events arrive', async () => {
  let reads = 0, cancelled = 0;
  const runtime = shellRuntime({ authenticatedFetch: async () => ({ ok: true, body: { getReader: () => ({
    read: async () => { if (reads++) throw new Error('must not wait for EOF'); return { done: false, value: encodeEvents([
      { t: 'Final answer.' }, { done: true }, { t: 'Stale token' }, { error: true, code: 'late_error' },
    ]) }; },
    cancel: async () => { cancelled++; },
  }) } }) });
  const result = await ask(runtime);
  assert.equal(result.text, 'Final answer.');
  assert.equal(reads, 1);
  assert.equal(cancelled, 1);
});

for (const [name, events, code, partial] of [
  ['empty completion', [{ done: true }], 'empty_completed_response', ''],
  ['EOF without done', [{ t: 'Partial' }], 'stream_ended_without_terminal_event', 'Partial'],
  ['failure before token', [{ error: true, code: 'general_generation_failed', retryable: true }], 'general_generation_failed', ''],
  ['failure after token', [{ t: 'Partial' }, { error: true, code: 'grounded_generation_failed', retryable: true }], 'grounded_generation_failed', 'Partial'],
]) test(`${name} is recoverable and the next request remains usable`, async () => {
  const runtime = shellRuntime({ authenticatedFetch: async () => streamResponse(events) });
  await assert.rejects(ask(runtime), error => {
    assert.equal(error.code, code); assert.equal(error.metadata.partialAnswer, partial); return true;
  });
  runtime.authenticatedFetch = async () => streamResponse([{ t: 'Next answer' }, { done: true }]);
  assert.equal((await ask(runtime)).text, 'Next answer');
});

test('malformed and wrong-request frames cannot contaminate a valid answer', async () => {
  let sent = false;
  const runtime = shellRuntime({ authenticatedFetch: async () => ({ ok: true, body: { getReader: () => ({
    read: async () => sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode(
      'data: invalid-json\n\ndata: {"t":"Wrong","requestId":"other-request"}\n\ndata: {"t":"Right"}\n\ndata: {"done":true}\n\n'
    ) }), cancel: async () => {},
  }) } }) });
  assert.equal((await ask(runtime)).text, 'Right');
});
