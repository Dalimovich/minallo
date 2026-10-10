import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load() {
  const exports = {};
  const code = ts.transpileModule(
    fs.readFileSync('frontend/js/features/german-exam/ordering-task.ts', 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  vm.runInNewContext(code, { exports, require: () => ({}), console }, {});
  return exports;
}

const PART = { constraints: { itemCount: 5 } };

function validContent() {
  const questions = Array.from({ length: 5 }, (_, i) => ({ questionId: `p${i + 1}`, text: `Paragraph ${i + 1}`, skillTags: ['text_structure'] }));
  return { questions, correctOrder: questions.map(q => q.questionId) };
}

test('validateOrdering accepts well-formed content', () => {
  const { validateOrdering } = load();
  assert.doesNotThrow(() => validateOrdering(PART, validContent()));
});

test('validateOrdering rejects wrong item count', () => {
  const { validateOrdering } = load();
  const c = validContent();
  c.questions = c.questions.slice(0, 4);
  assert.throws(() => validateOrdering(PART, c));
});

test('validateOrdering rejects a paragraph missing text', () => {
  const { validateOrdering } = load();
  const c = validContent();
  c.questions[2].text = '';
  assert.throws(() => validateOrdering(PART, c));
});

test('validateOrdering rejects duplicate paragraph ids', () => {
  const { validateOrdering } = load();
  const c = validContent();
  c.questions[1].questionId = c.questions[0].questionId;
  assert.throws(() => validateOrdering(PART, c));
});

test('validateOrdering rejects a correctOrder that is not a permutation of the ids', () => {
  const { validateOrdering } = load();
  const c = validContent();
  c.correctOrder = ['p1', 'p2', 'p3', 'p4', 'p1']; // p5 missing, p1 duplicated
  assert.throws(() => validateOrdering(PART, c));
});

test('gradeOrdering scores each paragraph by its assigned vs correct position', () => {
  const { gradeOrdering } = load();
  const c = validContent();
  c.correctOrder = ['p3', 'p1', 'p5', 'p2', 'p4']; // correct positions: p3=1, p1=2, p5=3, p2=4, p4=5
  const answers = { p1: '2', p2: '4', p3: '1', p4: '3', p5: '5' }; // p4 and p5 deliberately swapped (wrong)
  const result = gradeOrdering(c, answers);
  assert.equal(result.p1.correct, true);
  assert.equal(result.p2.correct, true);
  assert.equal(result.p3.correct, true);
  assert.equal(result.p4.correct, false);
  assert.equal(result.p5.correct, false);
  assert.deepEqual(result.p1.skillTags, ['text_structure']);
});

test('gradeOrdering treats an unanswered paragraph as incorrect, never a silent pass', () => {
  const { gradeOrdering } = load();
  const c = validContent();
  const result = gradeOrdering(c, {});
  assert.equal(Object.values(result).every(r => r.correct === false), true);
});
