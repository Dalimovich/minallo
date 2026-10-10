import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAiError } from '../../frontend/js/services/ai-error-message.ts';
import { shellRuntime } from '../helpers/chat-stream-runtime.mjs';

test('sign-in recovery invokes the actual application auth bridge', async () => {
  let clicked, signedIn = 0, appended;
  const runtime = shellRuntime({
    window: { landShowAuth: mode => { assert.equal(mode, 'signin'); signedIn++; } },
    document: { querySelector: () => null, createElement: () => ({ addEventListener: (_event, callback) => { clicked = callback; } }) },
  }, ['attachStructuredRecoveryAction']);
  runtime.attachStructuredRecoveryAction({ querySelector: () => null }, { appendChild: el => { appended = el; } }, {}, classifyAiError({ code: 'session_expired' }));
  assert.equal(appended.textContent, 'Sign in');
  await clicked();
  assert.equal(signedIn, 1);
});
