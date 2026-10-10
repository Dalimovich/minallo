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

test('ExamForge keeps structured answers hidden and supports persistent per-question reveal', () => {
  assert.match(inline, /interface QuestionSolution/);
  assert.match(inline, /finalAnswer\?: string/);
  assert.match(inline, /keySteps\?: string\[\]/);
  assert.match(inline, /revealedAnswers: Record<string, boolean>/);
  assert.match(inline, /revealedFullSolutions: Record<string, boolean>/);
  assert.match(inline, /data-ef-reveal/);
  assert.match(inline, /Hide answer/);
  assert.match(inline, /Show full solution/);
  assert.match(inline, /if \(!state\.revealedAnswers\[id\]\) state\.revealedFullSolutions\[id\] = false/);
});

test('ExamForge locks exam answers until grading but permits practice reveal', () => {
  assert.match(inline, /mode === 'practice' \|\| state\.status === 'graded'/);
  assert.match(inline, /Available after submitting the exam/);
  assert.match(inline, /canReveal \? '' : ' disabled'/);
});

test('structured final answer is authoritative and uses safe Markdown/math rendering', () => {
  assert.match(inline, /validationStatus === 'validated'/);
  assert.match(inline, /structuredAnswer \|\| String\(grade\?\.correctAnswer/);
  assert.doesNotMatch(inline, /grade\.correctAnswer \? `<p><b>Correct answer:/);
  assert.match(inline, /renderMarkdown\(officialAnswer\)/);
  assert.match(inline, /keySteps\.map\(step => `<li>\$\{renderMarkdown\(step\)\}/);
  assert.match(inline, /renderMarkdown\(explanation\)/);
});

test('old persisted ExamForge attempts receive safe reveal-state defaults', () => {
  assert.match(inline, /const saved = JSON\.parse/);
  assert.match(inline, /revealedAnswers: saved\.revealedAnswers && typeof saved\.revealedAnswers === 'object' \? saved\.revealedAnswers : \{\}/);
  assert.match(inline, /revealedFullSolutions: saved\.revealedFullSolutions && typeof saved\.revealedFullSolutions === 'object' \? saved\.revealedFullSolutions : \{\}/);
});

test('the full ExamForge workspace renders math in questions, options, and feedback', () => {
  // Unlike examforge-inline.ts (the chat review widget, already using
  // renderMarkdown above), the full workspace view built every question,
  // option, and feedback string with plain HTML-escaping only — no KaTeX
  // integration at all, so any $...$/$$...$$ math the generator produced
  // (examforge.py's MATH FORMATTING rule) rendered as literal text.
  const renderExamBody = legacy.slice(legacy.indexOf('function renderExam()'), legacy.indexOf('function renderAnswerControl'));
  assert.match(renderExamBody, /var _katexOpts = \{ delimiters: \[/);
  assert.match(renderExamBody, /if \(window\.renderMathInElement\) \{ _doExamMath\(\); \}/);
  assert.match(renderExamBody, /else if \(window\._ssEnsureKatex\) \{ window\._ssEnsureKatex\(\)\.then\(_doExamMath\)/);
  // Must run on every render (feedback/grades arrive after the initial
  // render and call renderExam() again), not just once on first mount.
  assert.match(renderExamBody, /renderMathInElement\(els\.exam, _katexOpts\)/);
});

test('examforge.py instructs the generator to delimit math the same way flashcards.py does', () => {
  const examforgePy = fs.readFileSync('backend/python-ai/app/services/examforge.py', 'utf8');
  assert.match(examforgePy, /MATH FORMATTING \(STRICT/);
  assert.match(examforgePy, /NEVER write a bare LaTeX command/);
  assert.match(examforgePy, /NOT raw Unicode glyphs/);
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
