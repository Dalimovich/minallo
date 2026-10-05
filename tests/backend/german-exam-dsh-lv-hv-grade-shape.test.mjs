import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.AI_SERVICE_URL = 'https://ai.example.test';
process.env.INTERNAL_SECRET = 'secret';

const { validateAnswersShape } = await import('../../backend/functions/ai-german-exam-dsh-lv-hv-grade.ts');

test('a well-formed answers array is accepted', () => {
  assert.equal(validateAnswersShape([{ itemId: 'q1', answer: 'x' }, { itemId: 'q2', answer: '' }]), null);
});

test('answers must be an array, not an object/dict', () => {
  assert.ok(validateAnswersShape({ q1: 'x' }));
});

test('each answer needs a valid, bounded itemId', () => {
  assert.ok(validateAnswersShape([{ itemId: '', answer: 'x' }]));
  assert.ok(validateAnswersShape([{ itemId: 123, answer: 'x' }]));
  assert.ok(validateAnswersShape([{ itemId: 'x'.repeat(81), answer: 'x' }]));
});

test('answer text must be a bounded string when present', () => {
  assert.ok(validateAnswersShape([{ itemId: 'q1', answer: 123 }]));
  assert.ok(validateAnswersShape([{ itemId: 'q1', answer: 'x'.repeat(8001) }]));
  // Missing answer entirely is allowed (treated as empty server-side).
  assert.equal(validateAnswersShape([{ itemId: 'q1' }]), null);
});

test('extra keys on an answer entry (e.g. a forged gradingContent) are harmless, not a shape error', () => {
  // The shape check only cares about itemId/answer; python-ai's DshLvHvAnswer model (and
  // Pydantic's default extra="ignore") drop anything else regardless — this just confirms the
  // shape check itself does not choke on them, not that they have any effect downstream.
  assert.equal(validateAnswersShape([{ itemId: 'q1', answer: 'x', gradingContent: { tasks: [] } }]), null);
});

test('too many answers is rejected', () => {
  const answers = Array.from({ length: 101 }, (_, i) => ({ itemId: `q${i}`, answer: 'x' }));
  assert.ok(validateAnswersShape(answers));
});
