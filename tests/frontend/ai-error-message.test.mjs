import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAiError, friendlyAiErrorMessage } from '../../frontend/js/services/ai-error-message.ts';

test('maps typed stream errors without falling through to generic interruption copy', () => {
  assert.match(
    friendlyAiErrorMessage({ code: 'request_superseded', message: 'ignored' }),
    /newer question/i,
  );
  assert.match(
    friendlyAiErrorMessage({ code: 'stream_ended_without_terminal_event' }),
    /confirmed complete/i,
  );
});

test('typed classification retains retry and partial-answer policy', () => {
  assert.deepEqual(classifyAiError({ code: 'request_superseded', retryable: true }), {
    code: 'request_superseded',
    title: 'Response replaced',
    message: 'This answer was replaced by your newer question.',
    retryable: true,
    preservePartialAnswer: false,
    action: 'none',
  });
  const stalled = classifyAiError({ code: 'stream_inactivity_timeout' });
  assert.equal(stalled.preservePartialAnswer, true);
  assert.equal(stalled.action, 'continue');
  const internal = classifyAiError({ code: 'internal_error', retryable: false, stage: 'unknown' });
  assert.equal(internal.retryable, false);
  assert.equal(internal.action, 'none');
  assert.doesNotMatch(internal.message, /internal error/i);
});
