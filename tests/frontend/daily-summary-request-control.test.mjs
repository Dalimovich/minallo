import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const renderSource = fs.readFileSync('frontend/js/features/courses/courses-render.ts', 'utf8');

test('course count hydration never schedules a full course rerender', () => {
  const start = renderSource.indexOf('function _hydrateCardCount');
  const end = renderSource.indexOf('\nexport function renderCourses', start);
  const hydration = renderSource.slice(start, end);
  assert.doesNotMatch(hydration, /sdRenderCourses\s*\(/);
  assert.doesNotMatch(hydration, /onCountChanged/);
});

test('daily mission preview rejects stale async responses', () => {
  assert.match(renderSource, /host\.dataset\.requestKey = requestKey/);
  assert.match(renderSource, /host\.dataset\.requestKey !== requestKey/);
});

test('ten identical daily-summary callers share one request and the TTL cache', async () => {
  globalThis.window = { _sbToken: 'test-token' };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, json: async () => ({ hasPlan: false, courseId: 'c1' }) };
  };
  const { getDailyMissionSummary } = await import('../../frontend/js/services/study-service.ts');
  await Promise.all(Array.from({ length: 10 }, () => getDailyMissionSummary('c1')));
  assert.equal(calls, 1);
  await getDailyMissionSummary('c1');
  assert.equal(calls, 1);
});
