import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const inline = fs.readFileSync('frontend/js/features/chatbot-new/examforge-inline.ts', 'utf8');
const workflow = fs.readFileSync('frontend/js/features/chatbot-new/study-tool-workflow.ts', 'utf8');
const legacy = fs.readFileSync('frontend/views/examforge/examforge.js', 'utf8');

test('ExamForge renders real inline controls and persistent navigation', () => {
  assert.match(inline, /type="radio"/);
  assert.match(inline, /<textarea/);
  assert.match(inline, /data-ef-prev/);
  assert.match(inline, /data-ef-next/);
  assert.match(inline, /localStorage\.setItem/);
  assert.match(inline, /Review unanswered/);
});

test('ExamForge mode reaches generation and answer keys are not queried by legacy UI', () => {
  assert.match(workflow, /mode: String\(p\.mode/);
  assert.doesNotMatch(legacy, /exam_questions\(\*\)/);
  assert.match(legacy, /grade\.correctAnswer/);
});
