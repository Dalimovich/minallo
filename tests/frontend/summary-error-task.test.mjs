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

function loadSummaryError() {
  const productive = load('frontend/js/features/german-exam/productive-task.ts', () => ({}));
  return load('frontend/js/features/german-exam/summary-error-task.ts', name => {
    if (name.includes('productive-task')) return productive;
    throw new Error(`unexpected import ${name}`);
  });
}

const PART = { constraints: { itemCount: 3, requiredSourceKinds: ['text', 'graphic'] } };

function graphic() {
  return { title: 'Kosten', unit: 'Euro', columns: [{ id: 'c1', label: 'Jahr' }], rows: [{ id: 'r1', label: '2024', values: { c1: 500 } }] };
}

function validContent() {
  const questions = Array.from({ length: 9 }, (_, i) => ({ questionId: `sent${i + 1}`, text: `Satz ${i + 1}.`, skillTags: ['detail_comprehension'] }));
  return {
    sources: [{ id: 's1', kind: 'text', text: 'Ein Lesetext.' }, { id: 's2', kind: 'graphic', graphic: graphic() }],
    questions,
    correctIds: ['sent2', 'sent5', 'sent8'],
  };
}

test('validateSummaryError accepts well-formed content', () => {
  const { validateSummaryError } = loadSummaryError();
  assert.doesNotThrow(() => validateSummaryError(PART, validContent()));
});

test('validateSummaryError rejects a missing required source kind', () => {
  const { validateSummaryError } = loadSummaryError();
  const c = validContent();
  c.sources = c.sources.filter(s => s.kind !== 'graphic');
  assert.throws(() => validateSummaryError(PART, c));
});

test('validateSummaryError rejects too few summary sentences', () => {
  const { validateSummaryError } = loadSummaryError();
  const c = validContent();
  c.questions = c.questions.slice(0, 3); // itemCount is 3, need more than that
  assert.throws(() => validateSummaryError(PART, c));
});

test('validateSummaryError rejects correctIds not among the summary sentences', () => {
  const { validateSummaryError } = loadSummaryError();
  const c = validContent();
  c.correctIds = ['sent2', 'sent5', 'sent_unknown'];
  assert.throws(() => validateSummaryError(PART, c));
});

test('validateSummaryError rejects duplicate sentence ids', () => {
  const { validateSummaryError } = loadSummaryError();
  const c = validContent();
  c.questions[1].questionId = c.questions[0].questionId;
  assert.throws(() => validateSummaryError(PART, c));
});

test('gradeSummaryError counts only genuinely correct selections, never over-credits', () => {
  const { gradeSummaryError } = loadSummaryError();
  const c = validContent();
  const result = gradeSummaryError(c, new Set(['sent2', 'sent5', 'sent9'])); // sent9 is wrong guess
  assert.equal(result.correct, 2);
  assert.equal(result.total, 3);
});

test('gradeSummaryError with no selections scores zero, never a silent pass', () => {
  const { gradeSummaryError } = loadSummaryError();
  const c = validContent();
  const result = gradeSummaryError(c, new Set());
  assert.equal(result.correct, 0);
});
