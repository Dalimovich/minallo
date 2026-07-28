import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleNext,
  normalizeState,
  isValidRating,
  MIN_EASE,
  DEFAULT_EASE
} from '../../backend/lib/flashcard-sr.ts';

const T0 = Date.UTC(2026, 5, 10, 0, 0, 0); // fixed "now"
const DAY = 24 * 60 * 60 * 1000;

function dueDays(scheduled) {
  return Math.round((new Date(scheduled.dueAt).getTime() - T0) / DAY);
}

test('isValidRating accepts the four ratings and rejects others', () => {
  for (const r of ['again', 'hard', 'good', 'easy']) assert.equal(isValidRating(r), true);
  for (const r of ['Again', 'ok', '', null, undefined, 3]) assert.equal(isValidRating(r), false);
});

test('normalizeState fills safe defaults for missing/garbage input', () => {
  const s = normalizeState(null);
  assert.equal(s.intervalDays, 0);
  assert.equal(s.easeFactor, DEFAULT_EASE);
  assert.equal(s.reviewCount, 0);
  assert.equal(s.lapseCount, 0);

  const g = normalizeState({ intervalDays: -5, easeFactor: 0.1, reviewCount: -1, lapseCount: NaN });
  assert.equal(g.intervalDays, 0);
  assert.equal(g.easeFactor, MIN_EASE); // floored
  assert.equal(g.reviewCount, 0);
  assert.equal(g.lapseCount, 0);
});

test('new card + good → 1 day, review_count 1, ease unchanged', () => {
  const s = scheduleNext(null, 'good', T0);
  assert.equal(s.intervalDays, 1);
  assert.equal(dueDays(s), 1);
  assert.equal(s.reviewCount, 1);
  assert.equal(s.lapseCount, 0);
  assert.equal(s.easeFactor, DEFAULT_EASE);
  assert.equal(s.rating, 'good');
});

test('new card + easy → 6 days (graduates faster) and ease rises', () => {
  const s = scheduleNext(null, 'easy', T0);
  assert.equal(s.intervalDays, 6);
  assert.equal(dueDays(s), 6);
  assert.ok(s.easeFactor > DEFAULT_EASE);
});

test('second good review jumps to 6 days', () => {
  const first = scheduleNext(null, 'good', T0);
  const second = scheduleNext(first, 'good', T0);
  assert.equal(second.intervalDays, 6);
  assert.equal(second.reviewCount, 2);
});

test('third good review grows by ease factor (6 → ~15)', () => {
  let s = scheduleNext(null, 'good', T0);
  s = scheduleNext(s, 'good', T0); // 6
  s = scheduleNext(s, 'good', T0); // 6 * 2.5 = 15
  assert.equal(s.intervalDays, 15);
  assert.equal(s.reviewCount, 3);
});

test('again is a lapse: interval resets to 0, due in 1 day, ease drops, lapse_count++', () => {
  let s = scheduleNext(null, 'good', T0);
  s = scheduleNext(s, 'good', T0); // interval 6, ease 2.5
  const lapsed = scheduleNext(s, 'again', T0);
  assert.equal(lapsed.intervalDays, 0);
  assert.equal(dueDays(lapsed), 1);
  assert.equal(lapsed.reviewCount, 0);
  assert.equal(lapsed.lapseCount, 1);
  assert.ok(lapsed.easeFactor < s.easeFactor);
  assert.ok(lapsed.easeFactor >= MIN_EASE);
});

test('hard grows slower than good and lowers ease', () => {
  let base = scheduleNext(null, 'good', T0);
  base = scheduleNext(base, 'good', T0); // interval 6, ease 2.5
  const hard = scheduleNext(base, 'hard', T0);
  const good = scheduleNext(base, 'good', T0);
  assert.ok(hard.intervalDays < good.intervalDays);
  assert.ok(hard.easeFactor < base.easeFactor);
});

test('ease factor never drops below the SM-2 minimum 1.3', () => {
  let s = { intervalDays: 10, easeFactor: 1.35, reviewCount: 3, lapseCount: 0 };
  for (let i = 0; i < 10; i++) s = scheduleNext(s, 'again', T0);
  assert.ok(s.easeFactor >= MIN_EASE);
});

test('intervals always grow by at least one day on success', () => {
  let s = scheduleNext({ intervalDays: 0.2, easeFactor: 1.3, reviewCount: 5, lapseCount: 0 }, 'hard', T0);
  assert.ok(s.intervalDays >= 1);
});
