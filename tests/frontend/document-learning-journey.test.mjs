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
});
