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

test('live commentary never persists as a completed summary', () => {
  // The old "Work completed · N updates" collapsed summary must be gone —
  // renderCommentary no longer takes a `completed` flag at all.
  assert.doesNotMatch(shell, /Work completed · \$\{events\.length\}/);
  assert.doesNotMatch(shell, /details\.open = !completed/);
  assert.match(shell, /function renderCommentary\(row: HTMLElement, events: ExecutionCommentaryEvent\[\]\): void/);
  assert.match(shell, /function hideLiveCommentary\(row: HTMLElement\): void/);
  assert.match(shell, /host\.hidden = true;\s*\n\s*host\.replaceChildren\(\);/);
  assert.match(shell, /progress\.setAttribute\('aria-label'/);
  assert.match(css, /\.ncb-commentary progress/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

test('rendered rows are capped independently of the persisted history', () => {
  assert.match(shell, /const MAX_VISIBLE_COMMENTARY_ROWS = 4/);
  assert.match(shell, /events\.slice\(-MAX_VISIBLE_COMMENTARY_ROWS\)/);
});

test('durable hydration restores semantic commentary events only while still active', () => {
  assert.match(shell, /Array\.isArray\(row\.commentary_events\)/);
  assert.match(shell, /row\.commentary_events as ExecutionCommentaryEvent\[\]/);
  assert.match(
    shell,
    /m\.commentary\?\.length && m\.completionState && ACTIVE_COMPLETION_STATES\.has\(m\.completionState\)/,
  );
});

test('fast lanes suppress short-lived commentary without delaying answer tokens', () => {
  assert.match(shell, /streamMeta\.executionLane\.startsWith\('fast_'\)/);
  assert.match(shell, /window\.setTimeout\(flushFastCommentary, 850\)/);
  assert.match(shell, /pendingFastCommentary = \[\]/);
  assert.match(shell, /if \(typeof evt\.t === 'string'\)/);
  assert.match(shell, /if \(thinking && !isFastLane\) await thinking\.waitMinimum\(\)/);
});

test('the first substantive answer token removes commentary and later events are ignored', () => {
  assert.match(shell, /let answerStarted = false/);
  assert.match(shell, /if \(!answerStarted && \/\\S\/\.test\(evt\.t\)\)/);
  assert.match(shell, /answerStarted = true;/);
  assert.match(shell, /if \(row\) hideLiveCommentary\(row\);/);
  assert.match(shell, /if \(answerStarted\) \{\s*\n\s*lastEventType = 'commentary';\s*\n\s*continue;/);
});

test('live commentary and the generic thinking status never show at once', () => {
  assert.match(shell, /let commentaryActive = false/);
  assert.match(shell, /const takeOverFromThinkingStatus/);
  assert.match(shell, /typeof evt\.status === 'string' && !commentaryActive/);
});
