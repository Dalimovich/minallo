import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isLikelyVisualAssignmentQuestion,
  shouldReuseRecentVisualContext,
} from '../../frontend/js/features/ai-chat/visual-context.ts';

const now = Date.now();
const context = {
  images: [{ mediaType: 'image/jpeg', data: 'pixels', page: 36 }],
  courseId: 'course-1',
  documentId: 'doc-1',
  fileName: 'exercise.pdf',
  page: 36,
  conversationId: 'conversation-1',
  timestamp: now,
  remainingTurns: 4,
};
const current = {
  courseId: 'course-1',
  documentId: 'doc-1',
  fileName: 'exercise.pdf',
  page: 36,
  conversationId: 'conversation-1',
};

test('exercise requests are rendered as dense visible-page images', () => {
  assert.equal(isLikelyVisualAssignmentQuestion('answer Aufgabe 14.1'), true);
  assert.equal(isLikelyVisualAssignmentQuestion('match numbers 1 to 9'), true);
});

test('correction and formatting follow-ups retain the visual thread', () => {
  assert.equal(
    shouldReuseRecentVisualContext('you only mentioned 7, there are 2 missing', context, current, now),
    true,
  );
  assert.equal(
    shouldReuseRecentVisualContext(
      'give me the name in german and the explanation in english',
      context,
      current,
      now,
    ),
    true,
  );
  assert.equal(
    shouldReuseRecentVisualContext('try answering it again', context, current, now),
    true,
  );
  assert.equal(
    shouldReuseRecentVisualContext('explain number 8', context, current, now),
    true,
  );
});

test('a page change prevents stale image reuse', () => {
  assert.equal(
    shouldReuseRecentVisualContext('check again', context, { ...current, page: 37 }, now),
    false,
  );
});

test('expired and exhausted image contexts are not reused', () => {
  assert.equal(
    shouldReuseRecentVisualContext('complete the answer', context, current, now + 16 * 60 * 1000),
    false,
  );
  assert.equal(
    shouldReuseRecentVisualContext('complete the answer', { ...context, remainingTurns: 0 }, current, now),
    false,
  );
});
