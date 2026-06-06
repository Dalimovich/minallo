import { test } from 'node:test';
import assert from 'node:assert/strict';

// renderMarkdown reads `window` lazily (only inside the KaTeX path). Stub a
// minimal window so importing + rendering is safe in Node. The module's
// delegated DOM handlers are guarded by `typeof document !== 'undefined'`, so
// they no-op here — the submit/dispatch behaviour is covered by live testing.
globalThis.window = globalThis.window || {};

const { renderMarkdown, normalizeDecimalValue } = await import(
  '../../frontend/js/features/ai-chat/ai-markdown.ts'
);

function renderInput(spec) {
  return renderMarkdown('```minallo-input\n' + JSON.stringify(spec) + '\n```');
}

test('valid minallo-input renders a form with the field', () => {
  const html = renderInput({
    requestId: 'in-1',
    prompt: 'Enter the clamping length:',
    fields: [{ symbol: 'l_K', label: 'Clamping length', unit: 'mm' }],
  });
  assert.ok(html.includes('<form class="md-ai-input"'));
  assert.ok(html.includes('data-request-id="in-1"'));
  assert.ok(html.includes('data-symbol="l_K"'));
  assert.ok(html.includes('data-unit="mm"'));
  assert.ok(html.includes('inputmode="decimal"'));
  assert.ok(html.includes('Clamping length'));
  assert.ok(html.includes('Enter the clamping length:'));
});

test('multiple fields each render an input', () => {
  const html = renderInput({
    requestId: 'in-2',
    prompt: 'Enter the lengths:',
    fields: [
      { symbol: 'l_K', label: 'Clamping length', unit: 'mm' },
      { symbol: 'l_M', label: 'Nut length', unit: 'mm' },
    ],
  });
  assert.ok(html.includes('data-symbol="l_K"'));
  assert.ok(html.includes('data-symbol="l_M"'));
  assert.equal((html.match(/<input /g) || []).length, 2);
});

test('malformed JSON renders a safe fallback, not a form, no throw', () => {
  const html = renderMarkdown('```minallo-input\n{not valid json,,,\n```');
  assert.ok(html.includes('md-ai-input-fallback'));
  assert.ok(!html.includes('<form'));
});

test('empty / missing fields array falls back', () => {
  assert.ok(renderInput({ prompt: 'x', fields: [] }).includes('md-ai-input-fallback'));
  assert.ok(renderInput({ prompt: 'x' }).includes('md-ai-input-fallback'));
});

test('a field missing symbol or label is dropped; all-invalid falls back', () => {
  const html = renderInput({ fields: [{ label: 'no symbol' }, { symbol: 'x' }] });
  assert.ok(html.includes('md-ai-input-fallback'));
});

test('HTML/script in label and prompt is escaped (no injection)', () => {
  const html = renderInput({
    prompt: '<script>alert(1)</script>',
    fields: [{ symbol: '<b>s</b>', label: '<img src=x onerror=alert(1)>' }],
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('decimal comma normalizes to a dot between digits', () => {
  assert.equal(normalizeDecimalValue('5,5'), '5.5');
  assert.equal(normalizeDecimalValue('3,14'), '3.14');
  assert.equal(normalizeDecimalValue('12'), '12');
  assert.equal(normalizeDecimalValue('10.5'), '10.5');
});
