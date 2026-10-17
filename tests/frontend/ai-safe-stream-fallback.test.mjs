import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../../frontend/js/features/ai-chat/ai-ask.ts', import.meta.url),
  'utf8',
);

test('contextual tutoring never silently falls back to the legacy ask route', () => {
  const fallback = source.slice(
    source.indexOf('function handleClientStreamFailure'),
    source.indexOf('function finalize'),
  );
  assert.equal(fallback.includes('sendRagRequest'), false);
  assert.match(fallback, /_recoveryStarted/);
  assert.match(fallback, /beginSafeStreamRecovery\(_recoveryState, _activeReader, _streamController\)/);
});

test('transport failures use typed messages and the old generic rejection is gone', () => {
  assert.match(source, /type ClientStreamFailureCode/);
  assert.match(source, /stream_closed_without_terminal_event/);
  assert.equal(
    source.includes('The grounded document check was interrupted. Your question is preserved'),
    false,
  );
});

test('dense technical pages use PNG crops and send visual evidence metadata', () => {
  assert.match(source, /denseVisualTask\s*\?\s*canvas\.toDataURL\('image\/png'\)/);
  assert.match(source, /region: 'formula_area'/);
  assert.match(source, /region: 'answer_grid'/);
  assert.match(source, /visualEvidenceExpected: _visualEvidenceExpected/);
  assert.match(source, /renderedImageCount: _openFileImages\?\.length \|\| 0/);
});

test('visible page exercise text is selected before the full-document match', () => {
  const visibleMatch = source.indexOf('_normVisibleText.includes(_normTerm)');
  const documentMatch = source.indexOf('_normText.indexOf(_normTerm)', visibleMatch);
  assert.ok(visibleMatch >= 0);
  assert.ok(documentMatch > visibleMatch);
  assert.match(source, /CURRENTLY VISIBLE PDF PAGE.*Source 0/);
});

test('stale generations are rejected before every visible token and event', () => {
  assert.match(source, /function queueToken[\s\S]*myGenId !== state\.currentGenId/);
  assert.match(source, /JSON\.parse\(line\.slice\(6\)\)[\s\S]*myGenId !== state\.currentGenId/);
});
