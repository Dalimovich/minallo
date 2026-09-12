import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const shell = fs.readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');

test('Learning Journey renders structured sections and persists the expanded section', () => {
  assert.match(shell, /marker\.sections/);
  assert.match(shell, /ncb-learning-journey__section/);
  assert.match(shell, /minallo_journey_section_/);
  assert.match(shell, /section\.statistics\.answersVerified/);
});

test('unresolved questions never receive the verified check state', () => {
  assert.match(shell, /const verified = question\.answerStatus === 'verified'/);
  assert.match(shell, /verified \? '✓'.*source_unavailable.*'×' : '!'/s);
});

test('question order is numeric rather than lexicographic', () => {
  assert.match(shell, /a\.number\.split\('\.'\)\.map\(Number\)/);
  assert.match(shell, /\(ap\[1\] \|\| 0\) - \(bp\[1\] \|\| 0\)/);
});
