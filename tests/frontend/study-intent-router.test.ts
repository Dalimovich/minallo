import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStudyIntent } from '../../frontend/js/features/ai-chat/intent-router.ts';

const detects = (message: string, intent: string): void => {
  const result = detectStudyIntent(message);
  assert.equal(result.intent, intent, `${message}: ${JSON.stringify(result)}`);
};

test('recognises exact, reversed, abbreviated and misspelled tool aliases', () => {
  for (const value of ['Make a sheet cheat from this PDF', 'cheatshet', 'create a cheat-sheet']) detects(value, 'cheatsheet_create');
  for (const value of ['Create 10 FCs from this lecture', 'flaschcards', 'make flashcrads']) detects(value, 'flashcards_create');
  detects('open examforg', 'examforge_create');
  detects('start deep lern', 'deep_learn_create');
  detects('nots from this pdf', 'notes_generate');
});

test('uses semantic descriptions only in command context', () => {
  detects('Put all the formulas and important rules on one compact page', 'cheatsheet_create');
  detects('Turn this lecture into cards with a question on one side and an answer on the other', 'flashcards_create');
  assert.equal(detectStudyIntent('The lecture mentions cheat sheets.').intent, 'unknown');
  assert.equal(detectStudyIntent('What is deep learning?').intent, 'unknown');
  assert.equal(detectStudyIntent('The process examines sheet metal').intent, 'unknown');
});

test('extracts role-labelled numbers without confusing page and count', () => {
  const result = detectStudyIntent('Make 10 hard flashcards from page 6 in German');
  assert.deepEqual(result.extractedParameters, { count: 10, page: 6, difficulty: 'hard', language: 'de' });
  assert.equal(result.shouldOpenConfiguration, true);
});

test('ambiguous sheet wording remains unknown', () => {
  assert.equal(detectStudyIntent('make a sheet').intent, 'unknown');
});
