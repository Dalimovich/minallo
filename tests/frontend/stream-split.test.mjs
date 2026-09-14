import { test } from 'node:test';
import assert from 'node:assert/strict';

// The streaming side panel splits each batched paint into a stable markdown
// prefix and an unclosed-math tail; only the stable part is rendered, so raw
// LaTeX never flashes. tsx resolves the .ts module directly.
import { splitStableStreamText } from '../../frontend/js/features/ai-chat/ai-markdown.ts';

test('plain text is fully stable', () => {
  const r = splitStableStreamText('The angular velocity describes rotation speed.');
  assert.equal(r.stable, 'The angular velocity describes rotation speed.');
  assert.equal(r.tail, '');
});

test('unclosed \\( holds back from the opener', () => {
  const r = splitStableStreamText('The formula is \\( F = m');
  assert.equal(r.stable, 'The formula is ');
  assert.equal(r.tail, '\\( F = m');
});

test('closed \\(…\\) is stable', () => {
  const r = splitStableStreamText('We get \\( F = ma \\) as expected');
  assert.equal(r.stable, 'We get \\( F = ma \\) as expected');
  assert.equal(r.tail, '');
});

test('unclosed $$ block (multi-line) stays in the tail', () => {
  const r = splitStableStreamText('Definition:\n$$\n\\omega = \\frac{d\\theta}');
  assert.equal(r.stable, 'Definition:\n');
  assert.equal(r.tail, '$$\n\\omega = \\frac{d\\theta}');
});

test('closed $$…$$ is stable', () => {
  const r = splitStableStreamText('$$ E = mc^2 $$ done');
  assert.equal(r.tail, '');
});

test('unclosed \\[ holds back from the opener', () => {
  const r = splitStableStreamText('Hence\n\\[ x = \\frac{1}{2}');
  assert.equal(r.stable, 'Hence\n');
  assert.equal(r.tail, '\\[ x = \\frac{1}{2}');
});

test('single-$ inline math unclosed on the current line is held back', () => {
  const r = splitStableStreamText('so $x + y');
  assert.equal(r.stable, 'so ');
  assert.equal(r.tail, '$x + y');
});

test('single-$ cancelled by a newline — a lone $ is literal text', () => {
  const r = splitStableStreamText('costs $5 today\nnext line');
  assert.equal(r.stable, 'costs $5 today\nnext line');
  assert.equal(r.tail, '');
});

test('"$ 5" (space after $) never opens math', () => {
  const r = splitStableStreamText('that is $ 5 per month');
  assert.equal(r.stable, 'that is $ 5 per month');
  assert.equal(r.tail, '');
});

test('closed inline $x$ is stable', () => {
  const r = splitStableStreamText('with $x$ small');
  assert.equal(r.stable, 'with $x$ small');
  assert.equal(r.tail, '');
});

test('math delimiters inside a code fence are literal', () => {
  const src = '```python\nprice = "$total"\n```\nafter';
  const r = splitStableStreamText(src);
  assert.equal(r.stable, src);
  assert.equal(r.tail, '');
});

test('math delimiters inside inline code are literal', () => {
  const r = splitStableStreamText('use `$HOME` to find it');
  assert.equal(r.stable, 'use `$HOME` to find it');
  assert.equal(r.tail, '');
});

test('trailing lone backslash is held back (may become \\( next token)', () => {
  const r = splitStableStreamText('therefore \\');
  assert.equal(r.stable, 'therefore ');
  assert.equal(r.tail, '\\');
});

test('trailing lone $ is held back (may become $$ next token)', () => {
  const r = splitStableStreamText('therefore $');
  assert.equal(r.stable, 'therefore ');
  assert.equal(r.tail, '$');
});

test('second display block streaming while first is closed', () => {
  const r = splitStableStreamText('$$a$$ middle $$b');
  assert.equal(r.stable, '$$a$$ middle ');
  assert.equal(r.tail, '$$b');
});
