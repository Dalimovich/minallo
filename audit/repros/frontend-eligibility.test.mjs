// Runtime regressions: actual production eligibility, explicit state seams.
// Run: node --import tsx --test audit/repros/frontend-eligibility.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellRuntime } from '../../tests/helpers/chat-stream-runtime.mjs';

function runtime(overrides = {}) {
  return shellRuntime({
    sourceLibrary: { items: [] }, getActivePdfContext: () => null,
    isPdfViewerVisible: () => false, listCourses: () => [],
    resolveRequestCourseId: () => 'course-a', ...overrides,
  }, ['ragEligibility']);
}

test('unavailable selected source cannot resolve to the generic eligibility path', () => {
  const r = runtime();
  const chat = { selectedSourceIds: ['missing-source'], courseFileScope: 'specific_files',
    sourceMode: 'auto', courseId: 'course-a' };
  // An explicit unavailable scope must fail visibly or preserve stable IDs;
  // null instructs streamAiReply to use generic generation for Auto mode.
  let result;
  try { result = r.ragEligibility([{ role: 'user', text: 'Explain torque' }], chat, 'course-a'); }
  catch (error) { assert.match(error.code, /document|source|scope/); return; }
  assert.notEqual(result, null, 'Explicit selected scope silently entered generic path');
  assert.equal(result.groundingRequest.retrievalScope.type, 'documents');
});

test('unrelated Internet question survives incomplete incidental viewer state', () => {
  const r = runtime({ isPdfViewerVisible: () => true });
  const chat = { selectedSourceIds: [], courseFileScope: 'all_course_files',
    sourceMode: 'internet', courseId: 'course-a' };
  const result = r.ragEligibility([{ role: 'user', text: 'Explain torque' }], chat, 'course-a');
  assert.ok(result, 'Internet question must reach evidence planning');
  assert.equal(result.activePdfContext, null);
});
