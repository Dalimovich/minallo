import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shell = fs.readFileSync(path.join(root, 'frontend/js/features/chatbot-new/shell.ts'), 'utf8');
const deepLearn = fs.readFileSync(path.join(root, 'frontend/js/features/chatbot-new/deep-learn-workspace.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend/views/chatbot/chatbot.css'), 'utf8');

test('chat renders structured recommendations without parsing answer markdown', () => {
  assert.match(shell, /meta\.learningRecommendations/);
  assert.match(shell, /item\.kind === 'deep_learn'/);
  assert.doesNotMatch(shell, /answerBuf.*deep.learn/i);
});

test('recommendation transfers the complete launch context', () => {
  for (const field of ['topic', 'documentIds', 'sourceChunkIds', 'visualIds', 'lessonMode', 'lessonLanguage', 'learningGoals']) {
    assert.match(shell, new RegExp(field));
  }
  // Deep Learn is a chatbot-overlay-native workspace (mountDeepLearnWorkspace,
  // via openStudyToolWorkspace) — there is no more Course Overview tab launch
  // queue (__minalloDeepLearnLaunch) to hand parameters through.
  assert.match(deepLearn, /initialVisualIds/);
  assert.match(deepLearn, /opts\.autoStart === true/);
});

test('recommendations require a click and support dismissal fatigue', () => {
  assert.match(shell, /addEventListener\('click'/);
  assert.match(shell, /ncb_deep_learn_dismissed_/);
  assert.match(shell, /7 \* 24 \* 60 \* 60 \* 1000/);
});

test('visual cards are source-labelled, accessible and contained', () => {
  assert.match(shell, /Visual from your course/);
  assert.match(shell, /External visual example/);
  assert.match(shell, /aria-label', 'Visual aids'/);
  assert.match(css, /\.ncb-visual-aids[\s\S]*max-width: 100%/);
  assert.match(css, /\.ncb-visual-aid img[\s\S]*width: 100%/);
});

