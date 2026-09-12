import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAndMapPyTask,
  buildCanonicalTaskKey,
} from '../../backend/lib/study-planner.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLAN_ID = 'plan-001';
const USER_ID = 'user-001';
const PLAN_SCOPE = 'course_week';

function makeCounter(start = 0) {
  return { value: start };
}

function makeTask(overrides = {}) {
  return {
    id: 'pt-1',
    planDate: '2026-06-09',
    dayIndex: 0,
    courseId: 'math-101',
    subjectName: 'Mathematics',
    taskType: 'study_lecture',
    lectureFileId: 'lec-uuid-001',
    lectureFileName: 'Lecture1.pdf',
    lectureTopics: ['Derivatives', 'Limits'],
    exerciseFileId: null,
    exerciseFileName: null,
    solutionFileId: null,
    solutionFileName: null,
    relatedLectureFileId: null,
    relatedLectureFileName: null,
    relatedLectureTopics: [],
    pageRange: '1-20',
    estimatedMinutes: 45,
    reason: 'Cover core derivatives material.',
    status: 'todo',
    repetitionStage: null,
    sourceConfidence: 'high',
    ...overrides,
  };
}

// ── validateAndMapPyTask tests ────────────────────────────────────────────────

test('validateAndMapPyTask: valid study_lecture task maps correctly', () => {
  const t = makeTask();
  const counter = makeCounter();
  const row = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, counter);
  assert.ok(row !== null, 'should produce a row');
  assert.equal(row.task_type, 'study_lecture');
  assert.equal(row.plan_id, PLAN_ID);
  assert.equal(row.user_id, USER_ID);
  assert.equal(row.course_id, 'math-101');
  assert.equal(row.plan_date, '2026-06-09');
  assert.equal(row.status, 'todo');
  assert.equal(row.is_valid, true);
  assert.equal(counter.value, 1, 'counter should be incremented');
});

test('validateAndMapPyTask: invalid taskType returns null', () => {
  const t = makeTask({ taskType: 'study_topic' }); // old deterministic type, not allowed
  const row = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.equal(row, null);
});

test('validateAndMapPyTask: another invalid taskType returns null', () => {
  const t = makeTask({ taskType: 'completely_fake_type' });
  const row = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.equal(row, null);
});

test('validateAndMapPyTask: malformed planDate returns null', () => {
  const t = makeTask({ planDate: '09-06-2026' });
  const row = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.equal(row, null);
});

test('validateAndMapPyTask: empty courseId returns null', () => {
  const t = makeTask({ courseId: '' });
  const row = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.equal(row, null);
});

test('validateAndMapPyTask: check_solution_sheet maps solutionFileId to solution_file_id only', () => {
  const t = makeTask({
    taskType: 'check_solution_sheet',
    lectureFileId: null,
    exerciseFileId: null,
    solutionFileId: 'sol-uuid-007',
    solutionFileName: 'Solutions1.pdf',
    relatedLectureFileId: 'lec-uuid-001',
  });
  const row = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.ok(row !== null);
  assert.equal(row.solution_file_id, 'sol-uuid-007', 'solution_file_id should be set');
  assert.equal(row.exercise_file_id, null, 'exercise_file_id must be null for solution task');
  // source_file_id falls back to relatedLectureFileId when lectureFileId is null
  assert.equal(row.source_file_id, 'lec-uuid-001');
  assert.equal(row.related_lecture_file_id, 'lec-uuid-001');
});

test('validateAndMapPyTask: solutionFileId never leaks into exercise_file_id', () => {
  const t = makeTask({
    taskType: 'check_solution_sheet',
    exerciseFileId: null,
    solutionFileId: 'sol-uuid-999',
  });
  const row = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.ok(row !== null);
  assert.notEqual(row.exercise_file_id, 'sol-uuid-999');
  assert.equal(row.exercise_file_id, null);
});

test('validateAndMapPyTask: estimatedMinutes is clamped to [5..180]', () => {
  const tLow = makeTask({ estimatedMinutes: 1 });
  const tHigh = makeTask({ estimatedMinutes: 999 });
  const rowLow = validateAndMapPyTask(tLow, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  const rowHigh = validateAndMapPyTask(tHigh, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.equal(rowLow?.estimated_minutes, 5);
  assert.equal(rowHigh?.estimated_minutes, 180);
});

test('validateAndMapPyTask: priority_score from taskType — must-do types', () => {
  for (const type of ['exam_style_practice', 'pre_exam_review', 'review_weak_topic', 'solve_exercise_sheet']) {
    const row = validateAndMapPyTask(makeTask({ taskType: type }), PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
    assert.ok(row !== null, `should produce a row for ${type}`);
    assert.equal(row.priority_score, 0.85, `${type} should have priority 0.85`);
  }
});

test('validateAndMapPyTask: priority_score — study_lecture / continue_lecture / check_solution_sheet → 0.6', () => {
  for (const type of ['study_lecture', 'continue_lecture', 'check_solution_sheet']) {
    const row = validateAndMapPyTask(makeTask({ taskType: type }), PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
    assert.ok(row !== null);
    assert.equal(row.priority_score, 0.6, `${type} should have priority 0.6`);
  }
});

test('validateAndMapPyTask: priority_score — other types → 0.4', () => {
  for (const type of ['repeat_lecture', 'review_completed_exercise', 'generate_quiz_if_no_exercises']) {
    const row = validateAndMapPyTask(makeTask({ taskType: type }), PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
    assert.ok(row !== null);
    assert.equal(row.priority_score, 0.4, `${type} should have priority 0.4`);
  }
});

test('validateAndMapPyTask: source_confidence coerced from unknown → high', () => {
  const t = makeTask({ sourceConfidence: 'very_sure' });
  const row = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.ok(row !== null);
  assert.equal(row.source_confidence, 'high');
});

test('validateAndMapPyTask: known confidence values pass through unchanged', () => {
  for (const conf of ['confirmed', 'high', 'medium', 'low']) {
    const row = validateAndMapPyTask(makeTask({ sourceConfidence: conf }), PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
    assert.ok(row !== null);
    assert.equal(row.source_confidence, conf);
  }
});

test('validateAndMapPyTask: day_order increments across multiple calls', () => {
  const counter = makeCounter(0);
  const r1 = validateAndMapPyTask(makeTask(), PLAN_ID, USER_ID, PLAN_SCOPE, counter);
  const r2 = validateAndMapPyTask(makeTask(), PLAN_ID, USER_ID, PLAN_SCOPE, counter);
  assert.equal(r1?.day_order, 0);
  assert.equal(r2?.day_order, 1);
  assert.equal(counter.value, 2);
});

// ── buildCanonicalTaskKey tests ───────────────────────────────────────────────

test('buildCanonicalTaskKey: stable when title/reason/estimate change', () => {
  const base = buildCanonicalTaskKey(
    'course_week', '2026-06-09', 'math-101', 'study_lecture',
    'lec-001', '', '', ['Derivatives', 'Limits'], '1-20', ''
  );
  // Changing title/reason/estimate must NOT affect the key (those are not inputs)
  // We verify by computing the same key twice with same structural inputs
  const again = buildCanonicalTaskKey(
    'course_week', '2026-06-09', 'math-101', 'study_lecture',
    'lec-001', '', '', ['Derivatives', 'Limits'], '1-20', ''
  );
  assert.equal(base, again);
});

test('buildCanonicalTaskKey: changes when task_type changes', () => {
  const k1 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'study_lecture', 'lec-001', '', '', [], '', '');
  const k2 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'solve_exercise_sheet', 'lec-001', '', '', [], '', '');
  assert.notEqual(k1, k2);
});

test('buildCanonicalTaskKey: changes when lectureFileId changes', () => {
  const k1 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'study_lecture', 'lec-001', '', '', [], '', '');
  const k2 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'study_lecture', 'lec-002', '', '', [], '', '');
  assert.notEqual(k1, k2);
});

test('buildCanonicalTaskKey: changes when exerciseFileId changes', () => {
  const k1 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'solve_exercise_sheet', '', 'ex-001', '', [], '', '');
  const k2 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'solve_exercise_sheet', '', 'ex-002', '', [], '', '');
  assert.notEqual(k1, k2);
});

test('buildCanonicalTaskKey: topic order is stable (sorted)', () => {
  const k1 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'study_lecture', 'lec-001', '', '', ['Limits', 'Derivatives'], '', '');
  const k2 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'study_lecture', 'lec-001', '', '', ['Derivatives', 'Limits'], '', '');
  assert.equal(k1, k2, 'sorted topics should produce the same key regardless of input order');
});

test('buildCanonicalTaskKey: changes when solutionFileId changes', () => {
  const k1 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'check_solution_sheet', '', '', 'sol-001', [], '', '');
  const k2 = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'check_solution_sheet', '', '', 'sol-002', [], '', '');
  assert.notEqual(k1, k2);
});

test('buildCanonicalTaskKey: includes pipe separators in canonical format', () => {
  const k = buildCanonicalTaskKey('course_week', '2026-06-09', 'math-101', 'study_lecture', 'lec-001', '', '', [], '1-10', '2');
  // Key must follow: planScope|plan_date|course_id|task_type|lectureFileId|exerciseFileId|solutionFileId|sortedTopics|pageRange|repetitionStage|
  assert.ok(k.startsWith('course_week|2026-06-09|math-101|study_lecture|lec-001||'), `key format mismatch: ${k}`);
  assert.ok(k.includes('|1-10|2|'), `repetition and pageRange missing: ${k}`);
  assert.ok(k.endsWith('|'), 'key must end with trailing pipe (reserved field)');
});

test('validateAndMapPyTask: canonical_task_key is deterministic across two calls with identical inputs', () => {
  const t = makeTask({ repetitionStage: 2 });
  const r1 = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  const r2 = validateAndMapPyTask(t, PLAN_ID, USER_ID, PLAN_SCOPE, makeCounter());
  assert.ok(r1 !== null && r2 !== null);
  assert.equal(r1.canonical_task_key, r2.canonical_task_key);
});
