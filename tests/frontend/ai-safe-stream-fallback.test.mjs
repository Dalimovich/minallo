import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../frontend/js/features/ai-chat/ai-ask.ts', import.meta.url),
  'utf8',
);

test('contextual tutoring never silently falls back to the legacy ask route', () => {
  const fallback = source.slice(
    source.indexOf('function fallbackToRag'),
    source.indexOf('function finalize'),
  );
  assert.equal(fallback.includes('sendRagRequest'), false);
  assert.match(fallback, /_recoveryStarted/);
  assert.match(fallback, /_activeReader\?\.cancel/);
});

test('stale generations are rejected before every visible token and event', () => {
  assert.match(source, /function queueToken[\s\S]*myGenId !== state\.currentGenId/);
  assert.match(source, /JSON\.parse\(line\.slice\(6\)\)[\s\S]*myGenId !== state\.currentGenId/);
});
