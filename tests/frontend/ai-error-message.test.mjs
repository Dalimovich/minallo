import assert from 'node:assert/strict';
import test from 'node:test';
import { friendlyAiErrorMessage } from '../../frontend/js/services/ai-error-message.ts';

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
