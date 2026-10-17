import assert from 'node:assert/strict';
import test from 'node:test';
import { SseParser } from '../../frontend/js/services/sse-parser.ts';

function parse(chunks) {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  parser.finish();
  return events;
}

test('parses data fields with or without a space and CRLF framing', () => {
  assert.deepEqual(parse(['data:{"t":"a"}\r\n\r\ndata: {"done":true}\r\n\r\n']).map((e) => e.data), [
    '{"t":"a"}', '{"done":true}'
  ]);
});

test('reassembles split chunks, multiple events, comments, and multiline data', () => {
  const result = parse([': ping\n\ndata: {"t"', ':"a"}\n\nevent: note\ndata: first\ndata: second\n\n']);
  assert.deepEqual(result, [
    { event: undefined, id: undefined, data: '{"t":"a"}' },
    { event: 'note', id: undefined, data: 'first\nsecond' }
  ]);
});

test('flushes a final event without a trailing newline or blank line', () => {
  assert.equal(parse(['data: {"done":true}'])[0].data, '{"done":true}');
});
