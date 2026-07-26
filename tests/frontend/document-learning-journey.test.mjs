import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync('frontend/js/features/chatbot-new/shell.ts', 'utf8');
const css = readFileSync('frontend/css/courses-redesign.css', 'utf8');

test('document extraction mounts a persistent Learning Journey accordion', () => {
  assert.match(shell, /taskType === 'document_wide_extraction'/);
  assert.match(shell, /enhanceDocumentLearningJourney/);
  assert.match(shell, /document\.createElement\('details'\)/);
  assert.match(shell, /compact\.learningJourney/);
  assert.match(css, /\.ncb-learning-journey__item summary/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(shell, /questionPagesProcessed/);
  assert.match(shell, /answerSearchPagesProcessed/);
  assert.match(shell, /minallo_journey_view_/);
  assert.match(shell, /Correct answer/);
  assert.match(css, /data-view="table"/);
  assert.match(shell, /function isValidLearningJourney/);
  assert.match(shell, /marker\.questionPagesTotal > 0/);
  assert.match(shell, /No partial or out-of-scope question list was shown/);
  assert.match(shell, /marker\.manifestSealed/);
  assert.match(shell, /questionsFound === marker\.discoveredCount/);
  assert.match(shell, /Question scope complete/);
  assert.match(shell, /Answer verification incomplete/);
  assert.match(shell, /Show all answers/);
  assert.match(shell, /Hide all answers/);
  assert.match(shell, /aria-controls/);
  assert.match(shell, /card\.insertBefore\(panel/);
  assert.doesNotMatch(shell, /\? '<div class="ncb-learning-journey__answer"><span>Correct answer<\/span>'/);
});

test('combined-markdown generated exams hide the solution section by default', () => {
  assert.match(shell, /function enhanceGeneratedExamPractice/);
  assert.match(shell, /EXAM_SOLUTION_HEADING_RE/);
  assert.match(shell, /answerPanel\.hidden = true/);
  assert.match(shell, /Show answers/);
  assert.match(shell, /Hide answers/);
  assert.match(shell, /m\.examPractice/);
});
