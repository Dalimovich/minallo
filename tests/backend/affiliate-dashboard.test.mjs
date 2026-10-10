import assert from 'node:assert/strict';
import test from 'node:test';
import { isRecentSignup } from '../../backend/functions/affiliate-dashboard.ts';

const NOW = Date.parse('2026-07-20T12:00:00.000Z');

test('affiliate attribution accepts a newly created account', () => {
  assert.equal(isRecentSignup('2026-07-20T11:55:00.000Z', NOW), true);
});

test('affiliate attribution allows delayed email confirmation within seven days', () => {
  assert.equal(isRecentSignup('2026-07-14T12:00:00.000Z', NOW), true);
});

test('affiliate attribution rejects an existing account older than seven days', () => {
  assert.equal(isRecentSignup('2026-07-13T11:59:59.000Z', NOW), false);
});

test('affiliate attribution rejects missing, invalid, and future timestamps', () => {
  assert.equal(isRecentSignup(undefined, NOW), false);
  assert.equal(isRecentSignup('not-a-date', NOW), false);
  assert.equal(isRecentSignup('2026-07-20T12:00:01.000Z', NOW), false);
});
