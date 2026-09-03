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
  assert.match(inline, /updateExamChrome/);
  assert.doesNotMatch(inline, /persist\(\); if \(!\(el instanceof HTMLTextAreaElement\)\) render\(\)/);
});

test('ExamForge mode reaches generation and answer keys are not queried by legacy UI', () => {
  assert.match(workflow, /mode: String\(p\.mode/);
  assert.doesNotMatch(legacy, /exam_questions\(\*\)/);
  assert.match(legacy, /grade\.correctAnswer/);
});

test('study-tool workspace mounting is transactional and recoverable', () => {
  const workspace = fs.readFileSync('frontend/js/features/chatbot-new/workspace-library.ts', 'utf8');
  const boundary = fs.readFileSync('frontend/js/features/chatbot-new/study-tool-boundary.ts', 'utf8');
  assert.match(workspace, /const staging = document\.createElement\('div'\)/);
  assert.match(workspace, /body\.replaceChildren/);
  assert.match(workspace, /study_tool_mount_returned_empty/);
  assert.match(boundary, /minallo:study-tool-error/);
  assert.match(boundary, /recoverChatbotShell/);
});
