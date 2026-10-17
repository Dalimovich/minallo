// G3 QA finding (report-2026-10-12.md §G3): a 4-part heading↔paragraph matching
// question answered 2/4 correct was graded as one atomic fail (0 credit).
// rdCheckAnswer's 'match' branch and rdShowEnd's score tally must award
// per-pair credit instead. Executes the real production functions via vm,
// same extraction pattern as reading-mc-browser.spec.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('frontend/views/practice/practice.js', root), 'utf8');

function productionFunction(name) {
  let start = source.indexOf(`      function ${name}(`);
  if (start < 0) start = source.indexOf(`      async function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n      }', start) + 8);
}

function makeContext(rd) {
  const elements = new Map();
  const rdEl = (id) => {
    if (!elements.has(id)) elements.set(id, { style: {}, innerHTML: '', addEventListener() {} });
    return elements.get(id);
  };
  const context = {
    rd,
    RD_CATEGORIES: ['Finding explicit information', 'Meaning in context', 'Inference', 'Author intention'],
    rdEl,
    rdRenderText() {},
    rdRenderQuestion() {},
    rdRenderTabs() {},
    rdRenderFilesPanel() {},
    rdLoadSet() {},
    rdWeakSetForCategory() {},
    rdNewText() {},
    _glEscape: (v) => String(v),
  };
  vm.createContext(context);
  vm.runInContext(['rdFmtScore', 'rdCheckAnswer', 'rdShowEnd'].map(productionFunction).join('\n'), context);
  return context;
}

function matchQuestion(answer) {
  return { type: 'match', category: 'Author intention', answer };
}

test('a 2/4 correct match answer is graded partial, not an atomic fail', async () => {
  const rd = {
    index: 0,
    questions: [matchQuestion([0, 1, 2, 3])],
    passage: { paragraphs: [{}, {}, {}, {}] },
    matchChoices: { 0: '0', 1: '1', 2: '0', 3: '1' }, // 2 right (idx 0,1), 2 wrong (idx 2,3)
    answers: {},
  };
  const ctx = makeContext(rd);
  await ctx.rdCheckAnswer();
  assert.equal(rd.answers[0].status, 'partial');
  assert.equal(rd.answers[0].correctCount, 2);
  assert.equal(rd.answers[0].totalCount, 4);
});

test('all-correct and all-wrong match answers still grade as correct/review', async () => {
  const allRight = { index: 0, questions: [matchQuestion([0, 1])], passage: { paragraphs: [{}, {}] }, matchChoices: { 0: '0', 1: '1' }, answers: {} };
  await makeContext(allRight).rdCheckAnswer();
  assert.equal(allRight.answers[0].status, 'correct');

  const allWrong = { index: 0, questions: [matchQuestion([0, 1])], passage: { paragraphs: [{}, {}] }, matchChoices: { 0: '1', 1: '0' }, answers: {} };
  await makeContext(allWrong).rdCheckAnswer();
  assert.equal(allWrong.answers[0].status, 'review');
});

test('an unfilled match question is not graded yet', async () => {
  const rd = { index: 0, questions: [matchQuestion([0, 1])], passage: { paragraphs: [{}, {}] }, matchChoices: { 0: '0' }, answers: {} };
  await makeContext(rd).rdCheckAnswer();
  assert.equal(rd.answers[0], undefined);
});

test('rdShowEnd awards fractional credit for a partial match and sums it into the total', () => {
  const rd = {
    questions: [matchQuestion([0, 1, 2, 3]), { type: 'mc', category: 'Inference', answer: 'a', options: { a: 'x', b: 'y' } }],
    answers: {
      0: { status: 'partial', correctCount: 2, totalCount: 4 },
      1: { status: 'correct' },
    },
  };
  const ctx = makeContext(rd);
  ctx.rdShowEnd();
  const end = ctx.rdEl('glReadingEnd');
  // 0.5 (match) + 1 (mc) = 1.5 / 2 correct, not 1/2 (old atomic behaviour) or 2/2.
  assert.match(end.innerHTML, /1\.5 \/ 2 correct/);
  assert.match(end.innerHTML, /75%/);
});

test('rdFmtScore drops trailing .0 but keeps real decimals', () => {
  const ctx = makeContext({ questions: [], answers: {} });
  assert.equal(ctx.rdFmtScore(2), '2');
  assert.equal(ctx.rdFmtScore(1.5), '1.5');
  assert.equal(ctx.rdFmtScore(0), '0');
});
