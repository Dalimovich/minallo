import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const css = readFileSync('frontend/views/chatbot/chatbot.css', 'utf8');

test('commentary is a distinct persisted assistant-turn region', () => {
  assert.match(shell, /commentary\?: ExecutionCommentaryEvent\[\]/);
  assert.match(shell, /class="ncb-commentary-host" hidden/);
  assert.match(shell, /evt\.type === 'commentary'/);
  assert.match(shell, /message\.commentary = events\.slice\(-24\)/);
});

test('reconnect events deduplicate by eventId and replace by replaceKey', () => {
  assert.match(shell, /item\.eventId === event\.eventId/);
  assert.match(shell, /item\.replaceKey === event\.replaceKey/);
  assert.match(shell, /events\[replacement\] = event/);
});

test('completed work collapses and progress remains accessible on mobile', () => {
  assert.match(shell, /details\.open = !completed/);
  assert.match(shell, /progress\.setAttribute\('aria-label'/);
  assert.match(css, /\.ncb-commentary progress/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

test('durable hydration restores semantic commentary events', () => {
  assert.match(shell, /Array\.isArray\(row\.commentary_events\)/);
  assert.match(shell, /row\.commentary_events as ExecutionCommentaryEvent\[\]/);
});

test('fast lanes suppress short-lived commentary without delaying answer tokens', () => {
  assert.match(shell, /streamMeta\.executionLane\.startsWith\('fast_'\)/);
  assert.match(shell, /window\.setTimeout\(flushFastCommentary, 850\)/);
  assert.match(shell, /pendingFastCommentary = \[\]/);
  assert.match(shell, /if \(typeof evt\.t === 'string'\)/);
  assert.match(shell, /if \(thinking && !isFastLane\) await thinking\.waitMinimum\(\)/);
});
