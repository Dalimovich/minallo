import assert from 'node:assert/strict';
import test from 'node:test';

import { beginSafeStreamRecovery } from '../../frontend/js/features/ai-chat/stream-recovery.ts';

test('stream recovery cancels and aborts exactly once', async () => {
  let cancellations = 0;
  const reader = { async cancel() { cancellations += 1; } };
  const controller = new AbortController();
  const state = { started: false };

  assert.equal(beginSafeStreamRecovery(state, reader, controller), true);
  await Promise.resolve();
  assert.equal(controller.signal.aborted, true);
  assert.equal(cancellations, 1);

  assert.equal(beginSafeStreamRecovery(state, reader, controller), false);
  await Promise.resolve();
  assert.equal(cancellations, 1);
});
