import assert from 'node:assert/strict';
import test from 'node:test';

global.window = {};
const { renderMarkdown, splitStableStreamText } = await import('../../frontend/js/features/ai-chat/ai-markdown.ts');

test('semantic learning directives render safely and hide directive syntax', () => {
  const html = renderMarkdown(':::definition Covariance\nA measure with **meaning**.\n:::');
  assert.match(html, /learning-block--definition/);
  assert.match(html, /aria-label="Definition"/);
  assert.match(html, /<strong>meaning<\/strong>/);
  assert.doesNotMatch(html, /:::/);
});

test('unknown and malformed directives are not interpreted as components', () => {
  const unknown = renderMarkdown(':::script\n<script>alert(1)</script>\n:::');
  assert.doesNotMatch(unknown, /learning-block/);
  assert.doesNotMatch(unknown, /<script>/);
  assert.match(unknown, /&lt;script&gt;/);
});

test('keyboard markup and formulas expose real controls', () => {
  const html = renderMarkdown('Press [[kbd:Ctrl + V]].\n\n$$\nx+y\n$$');
  assert.match(html, /class="ai-kbd"/);
  assert.match(html, /formula-copy/);
  assert.match(html, /aria-label="Copy formula"/);
});

test('streaming buffers an unfinished semantic block without raw directive flash', () => {
  const partial = 'Stable paragraph.\n\n:::warning Real issue\nPartial warning';
  const split = splitStableStreamText(partial);
  assert.equal(split.stable, 'Stable paragraph.\n\n');
  assert.match(split.tail, /^:::warning/);
  const complete = splitStableStreamText(partial + '\n:::');
  assert.equal(complete.tail, '');
});
