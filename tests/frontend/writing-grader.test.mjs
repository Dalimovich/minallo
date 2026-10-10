import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, imports) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => imports(name), console }, {});
  return exports;
}

function loadGrader(request) {
  const productive = load('frontend/js/features/german-exam/productive-task.ts', () => ({}));
  return load('frontend/js/features/german-exam/writing-grader.ts', name => {
    if (name.includes('writing-exam')) return { writingExamRequest: request };
    if (name.includes('writing-coach-ai')) return {};
    if (name.includes('productive-task')) return productive;
    throw new Error(`unexpected import ${name}`);
  });
}

const GRADING_DIMENSIONS = ['task_fulfilment', 'coherence', 'vocabulary', 'structures'];

function resultItem(dim, scoreValue) {
  return { metadata: { rubricDimension: dim }, scoreValue };
}

test('mapWritingGradeToFeedback reads per-dimension scores from examResultItems, not the legacy rubric keys', () => {
  const { mapWritingGradeToFeedback } = loadGrader(async () => { throw new Error('not used'); });
  const text = 'Ein Forumsbeitrag mit einem Rechtschreibfehlar darin.';
  const grade = {
    analysis: { scoreExplanation: 'Solid C1 attempt.', insufficientContext: null, feedbackItems: [
      { type: 'grammar', original: 'Rechtschreibfehlar', suggestion: 'Rechtschreibfehler', explanation: 'Typo.' },
    ] },
    rubric: {}, // deliberately empty/misleading — must not be read for dimension scores
    scoreValue: 40, maxScoreValue: 60,
    examResultItems: [resultItem('task_fulfilment', 90), resultItem('coherence', 75), resultItem('vocabulary', 95), resultItem('structures', 60)],
  };

  const feedback = mapWritingGradeToFeedback(grade, GRADING_DIMENSIONS, text);

  assert.equal(feedback.kind, 'practice_feedback');
  assert.equal(feedback.dimensions.length, 4);
  assert.equal(feedback.dimensions.map(d => d.id).join(','), GRADING_DIMENSIONS.join(','));
  for (const d of feedback.dimensions) assert.equal(d.feedback, 'Solid C1 attempt.');
  const structures = feedback.dimensions.find(d => d.id === 'structures');
  assert.equal(structures.evidence.length, 1);
  assert.equal(structures.evidence[0].quote, 'Rechtschreibfehlar');
  // task_fulfilment has no matching feedbackItem type mapping — never invents evidence for it.
  assert.equal(feedback.dimensions.find(d => d.id === 'task_fulfilment').evidence.length, 0);
});

test('mapWritingGradeToFeedback never fabricates a quote the learner did not write', () => {
  const { mapWritingGradeToFeedback } = loadGrader(async () => { throw new Error('not used'); });
  const text = 'Ein völlig anderer Text.';
  const grade = {
    analysis: { scoreExplanation: 'ok', insufficientContext: null, feedbackItems: [
      { type: 'grammar', original: 'Wort das nicht im Text steht', suggestion: 'x', explanation: 'x' },
    ] },
    rubric: {}, scoreValue: 10, maxScoreValue: 60,
    examResultItems: [resultItem('structures', 50)],
  };
  const feedback = mapWritingGradeToFeedback(grade, ['structures'], text);
  assert.equal(feedback.dimensions[0].evidence.length, 0);
});

test('mapWritingGradeToFeedback reports a missing signal honestly instead of a fabricated score', () => {
  const { mapWritingGradeToFeedback } = loadGrader(async () => { throw new Error('not used'); });
  const grade = {
    analysis: { scoreExplanation: 'ok', insufficientContext: null, feedbackItems: [] },
    rubric: {}, scoreValue: null, maxScoreValue: null,
    examResultItems: [], // TestDaF's source_fidelity etc. never produce an item when unscored
  };
  const feedback = mapWritingGradeToFeedback(grade, ['source_fidelity'], 'text');
  assert.equal(feedback.dimensions[0].feedback, 'No automatic signal yet for this criterion.');
  assert.equal(feedback.dimensions[0].evidence.length, 0);
});

test('mapWritingGradeToFeedback surfaces insufficientContext on every dimension instead of a score', () => {
  const { mapWritingGradeToFeedback } = loadGrader(async () => { throw new Error('not used'); });
  const grade = {
    analysis: { scoreExplanation: 'ignored', insufficientContext: { message: 'Text zu kurz.' }, feedbackItems: [] },
    rubric: {}, scoreValue: null, maxScoreValue: 60,
    examResultItems: [],
  };
  const feedback = mapWritingGradeToFeedback(grade, GRADING_DIMENSIONS, 'kurz');
  for (const d of feedback.dimensions) { assert.equal(d.feedback, 'Text zu kurz.'); assert.equal(d.evidence.length, 0); }
});

test('createWritingGrader posts the productive-task shape (task, not selectedTopic) and maps the response', async () => {
  const calls = [];
  const request = async (path, body, signal) => {
    calls.push({ path, body, signal });
    return {
      analysis: { scoreExplanation: 'Gut.', insufficientContext: null, feedbackItems: [] },
      rubric: {}, scoreValue: 32.5, maxScoreValue: 60,
      examResultItems: [resultItem('task_fulfilment', 90)],
    };
  };
  const { createWritingGrader } = loadGrader(request);
  const envelope = { generationId: 'gen-1', exam: { profileId: 'goethe_c1' }, part: { id: 'schreiben_1' } };
  const content = { schemaVersion: 'productive-task-v1', id: 'task-9', prompt: 'Schreiben Sie ...', sources: [] };
  const grader = createWritingGrader(envelope, content, ['task_fulfilment'], request);

  const signal = new AbortController().signal;
  const feedback = await grader({ text: 'Mein Beitrag.' }, signal);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'grade-writing');
  assert.equal(calls[0].body.profileId, 'goethe_c1');
  assert.equal(calls[0].body.partId, 'schreiben_1');
  assert.equal(calls[0].body.topicId, 'task-9'); // the task's own id, no telc-style selectedTopic
  assert.equal(calls[0].body.generationId, 'gen-1');
  assert.equal(calls[0].body.task.id, 'task-9');
  assert.equal(calls[0].body.selectedTopic, undefined);
  assert.equal(calls[0].body.text, 'Mein Beitrag.');
  assert.equal(calls[0].signal, signal);
  assert.equal(feedback.kind, 'practice_feedback');
  assert.equal(feedback.dimensions[0].id, 'task_fulfilment');
});

test('createWritingGrader sends null generationId when the envelope has none', async () => {
  const calls = [];
  const request = async (path, body) => { calls.push(body); return {
    analysis: { scoreExplanation: '', insufficientContext: null, feedbackItems: [] },
    rubric: {}, scoreValue: null, maxScoreValue: null, examResultItems: [],
  }; };
  const { createWritingGrader } = loadGrader(request);
  const envelope = { exam: { profileId: 'testdaf_digital' }, part: { id: 'schreiben_1' } };
  const content = { schemaVersion: 'productive-task-v1', id: 't1', prompt: 'p', sources: [] };
  const grader = createWritingGrader(envelope, content, [], request);

  await grader({ text: 'x' }, new AbortController().signal);
  assert.equal(calls[0].generationId, null);
});
