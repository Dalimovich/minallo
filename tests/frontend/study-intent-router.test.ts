import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStudyIntent, detectStudyIntents, routeStudyIntent } from '../../frontend/js/features/ai-chat/intent-router.ts';
import { resolveStudyToolSource } from '../../frontend/js/features/chatbot-new/study-tool-workflow.ts';

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

test('ExamForge commands route before RAG while explanatory questions do not', () => {
  for (const input of ['examforge', 'ExamForge', 'exam forge', 'examforg', 'open examforge', 'make me a practice exam', 'test me on this PDF']) {
    assert.equal(routeStudyIntent(input, 'course-1')?.intent, 'examforge', input);
  }
  for (const input of ['What is ExamForge?', 'How does ExamForge grading work?', 'Why did ExamForge fail?']) {
    assert.equal(routeStudyIntent(input, 'course-1'), null, input);
  }
});

test('extracts ExamForge configuration parameters', () => {
  const result = detectStudyIntent('Make a hard German practice exam with 12 MCQ questions');
  assert.equal(result.intent, 'examforge_create');
  assert.deepEqual(result.extractedParameters, { count: 12, difficulty: 'hard', language: 'de', mode: 'practice', questionTypes: ['mcq'] });
});

test('routes every interactive tool and preserves multi-intent actions', () => {
  assert.equal(routeStudyIntent('flashcards', 'c')?.intent, 'flashcards');
  assert.equal(routeStudyIntent('deep learn', 'c')?.intent, 'deep_learn');
  const multi = detectStudyIntents('Create flashcards and a cheatsheet from this PDF');
  assert.deepEqual(multi.actions.map((action) => action.intent), ['flashcards_create', 'cheatsheet_create']);
});

test('explicit named source is retained for application-owned resolution', () => {
  const route = routeStudyIntent('Create a cheatsheet from Lecture 6 instead', 'c');
  assert.equal(route?.sourcePhrase, 'lecture 6');
  assert.equal(route?.explicitSourceReference, true);
});

test('feature mentions and academic lookalikes remain normal RAG', () => {
  for (const input of ['What are flashcards useful for?', 'What is deep learning?', 'The professor wrote a note here.', 'Explain this summary theorem.', 'What is an exam?', 'This lecture discusses sheet-metal forming.', 'Explain the cheat detection method.']) {
    assert.equal(routeStudyIntent(input, 'c'), null, input);
  }
});

test('open PDF becomes the default source when no manual files are selected', () => {
  const resolved = resolveStudyToolSource('course-1', [], [], {
    courseId: 'course-1', documentId: 'doc-open', fileName: 'Open.pdf',
    visiblePage: 4, pageCount: 20, pageText: ''
  });
  assert.equal(resolved.source.scope, 'current_document');
  assert.deepEqual(resolved.source.documentIds, ['doc-open']);
  assert.match(resolved.label, /Open document.*Open\.pdf/);
});

test('manually selected files override the open PDF and preserve every ID', () => {
  const resolved = resolveStudyToolSource('course-1', ['selection'], [{
    id: 'selection', courseId: 'course-1', documents: [
      { id: 'doc-b', name: 'B.pdf' }, { id: 'doc-c', name: 'C.pdf' }
    ]
  }], {
    courseId: 'course-1', documentId: 'doc-a', fileName: 'A.pdf',
    visiblePage: 1, pageCount: 10, pageText: ''
  });
  assert.equal(resolved.source.scope, 'selected_documents');
  assert.deepEqual(resolved.source.documentIds, ['doc-b', 'doc-c']);
});
