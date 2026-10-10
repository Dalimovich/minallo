import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.AI_SERVICE_URL = 'https://ai.example.test';
process.env.INTERNAL_SECRET = 'secret';

const { validateGradeWritingShape } = await import('../../backend/functions/ai-german-exam-grade-writing.ts');

const TOPIC = {
  questionId: 't1', title: 'T', statements: ['a', 'b'], communicativeSituation: 's', taskInstructions: 'i',
};

test('TELC topic shape is accepted when ids match', () => {
  assert.equal(validateGradeWritingShape({ topicId: 't1', selectedTopic: TOPIC, task: undefined }), null);
});

test('TELC shape is rejected on mismatched id, wrong statement count, or missing topic', () => {
  assert.ok(validateGradeWritingShape({ topicId: 'other', selectedTopic: TOPIC, task: undefined }));
  assert.ok(validateGradeWritingShape({ topicId: 't1', selectedTopic: { ...TOPIC, statements: ['a'] }, task: undefined }));
  assert.ok(validateGradeWritingShape({ topicId: 't1', selectedTopic: undefined, task: undefined }));
});

test('productive task shape is accepted without a TELC topic', () => {
  const task = { schemaVersion: 'productive-task-v1', id: 't', prompt: 'p', sources: [] };
  assert.equal(validateGradeWritingShape({ topicId: 't', selectedTopic: undefined, task }), null);
});

test('task must be an object and is size-capped', () => {
  assert.ok(validateGradeWritingShape({ topicId: 't', selectedTopic: undefined, task: [] }));
  assert.ok(validateGradeWritingShape({ topicId: 't', selectedTopic: undefined, task: 'x' }));
  assert.ok(validateGradeWritingShape({ topicId: 't', selectedTopic: undefined, task: { blob: 'x'.repeat(61000) } }));
});
