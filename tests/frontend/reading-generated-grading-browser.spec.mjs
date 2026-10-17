// Real Chromium component integration for the generated (AI) Reading/Sprachbausteine answer-key
// fix (QA run 2, 2026-10-12): executes the REAL production grading functions
// (rdGradeDetailMc3/rdGradeTextReconstruction/rdGradeMultiAuthor/sbCheckGeneratedAnswers/
// rdGradeGeneratedAnswer/sbGradeGeneratedAnswer) from frontend/views/practice/practice.js against
// a REAL network call intercepted by Playwright. Mirrors
// tests/frontend/listening-generated-grading-browser.spec.mjs's withWiredPage pattern exactly —
// same answer-key class of bug, now closed for reading/language_elements too.
//
// Covers one task type per answer-key shape (mc3.correctIndex, top-level correctCandidateId,
// top-level correctAuthorId) plus Sprachbausteine's top-level correctIndex — not every reading
// task type, since all eight share the identical rdGradeGeneratedAnswer round trip; the per-shape
// coverage lives in the backend (test_german_exam_generator_reading_security.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('frontend/views/practice/practice.js', root), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `function ${name} not found in practice.js`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// ---- static check: no extracted grader body compares a local answer directly against a
// stripped field (the exact regression the brief's "no grading code reads those fields from
// generation content" requirement names) ---------------------------------------------------------

const GRADER_NAMES = [
  'rdGradeDetailMc3', 'rdGradeMultipleChoice', 'rdGradeTextReconstruction', 'rdGradeSectionMatching',
  'rdGradeDetailGlobal', 'rdGradeMultiAuthor', 'rdGradeContextualCloze', 'rdGradeSourceSelection',
  'sbCheckGeneratedAnswers',
];
const STRIPPED_FIELD_COMPARISON = /===\s*\(?q(\.\w+)*\.(correctIndex|correctCandidateId|correctSectionId|correctAuthorId|answerId)\b|\.(answer|correctHeadingId)\s*\)?\s*;?\s*$/;

test('no reading/sprachbausteine grader compares a local answer directly against a generation-content field', () => {
  for (const name of GRADER_NAMES) {
    const body = extractFunction(name);
    // Every grader must round-trip through rdGradeGeneratedAnswer/sbGradeGeneratedAnswer (the
    // network call) rather than reading q.correctIndex/correctCandidateId/... synchronously.
    assert.ok(
      /rdGradeGeneratedAnswer|sbGradeGeneratedAnswer/.test(body),
      `${name} must grade via the network round trip, not synchronously`
    );
  }
});

const EXTRACTED = [
  '_getAuthFetchModule', '_authFetch',
  'rdGradeGeneratedAnswer', 'rdResultsFromPairs', 'rdGradeDetailMc3', 'rdGradeTextReconstruction', 'rdGradeMultiAuthor',
].map(extractFunction).join('\n');

const HARNESS = `
  var BACKEND_URL = '';
  var _authFetchModulePromise = null;
  var rd = { generationId: 'gen-reading-1' };
  ${EXTRACTED}
`;

async function withWiredPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const gradeRequests = [];
    let gradeHandler = () => ({ status: 200, body: { questionId: 'q1', correct: true, correctAnswer: null } });
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === 'http://localhost/') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<main></main>' });
      }
      if (url.includes('/js/services/authenticated-fetch.js')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: 'export function authenticatedFetch(url, init) { return fetch(url, init); }',
        });
      }
      if (url.includes('/api/ai/german-exam/grade-item')) {
        gradeRequests.push(route.request().postDataJSON());
        const { status, body } = await gradeHandler();
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.abort();
    });
    await page.goto('http://localhost/');
    await page.addScriptTag({ content: HARNESS });
    await run(page, gradeRequests, (fn) => { gradeHandler = fn; });
  } finally {
    await browser.close();
  }
}

function mc3Question() {
  return { questionId: 'q1', skillTags: ['detail_comprehension'], mc3: { stem: 'x', options: ['A', 'B', 'C'] } };
}
function reconstructionQuestion() {
  return { questionId: 'q1', gapId: 'g1', skillTags: ['text_structure'] };
}
function multiAuthorQuestion() {
  return { questionId: 'q1', statement: 's', skillTags: ['author_intention'] };
}

test('reading_detail_mc3: grade-item request carries only {generationId, questionId, selected}, never an answer key', async () => {
  await withWiredPage(async (page, gradeRequests) => {
    await page.evaluate((q) => {
      window.rd.content = { questions: [q] };
      window.rd.genAnswers = { q1: 1 };
      return window.rdGradeDetailMc3();
    }, mc3Question());
    assert.equal(gradeRequests.length, 1);
    assert.deepEqual(Object.keys(gradeRequests[0]).sort(), ['generationId', 'questionId', 'selected']);
    assert.equal(gradeRequests[0].generationId, 'gen-reading-1');
    assert.equal(gradeRequests[0].selected, 1);
  });
});

test('reading_detail_mc3: mc3.correctIndex is absent before grading and patched on only after the response', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 200, body: { questionId: 'q1', correct: false, correctAnswer: 2 } }));
    const q = mc3Question();
    const before = 'correctIndex' in q.mc3;
    const out = await page.evaluate((q) => {
      window.rd.content = { questions: [q] };
      window.rd.genAnswers = { q1: 0 };
      return window.rdGradeDetailMc3().then((results) => ({ results: results, mc3: q.mc3 }));
    }, q);
    assert.equal(before, false);
    assert.equal(out.results.q1.correct, false);
    assert.equal(out.mc3.correctIndex, 2);
  });
});

test('text_reconstruction_sentence_matching: selects by gapId, patches correctCandidateId from the response', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 200, body: { questionId: 'q1', correct: true, correctAnswer: 'c4' } }));
    const out = await page.evaluate((q) => {
      window.rd.content = { questions: [q] };
      window.rd.genAnswers = { g1: 'c4' };
      return window.rdGradeTextReconstruction().then((results) => ({ results: results, q: q }));
    }, reconstructionQuestion());
    assert.equal(gradeRequests[0].selected, 'c4');
    assert.equal(out.results.q1.correct, true);
    assert.equal(out.q.correctCandidateId, 'c4');
  });
});

test('multi_author_statement_matching_with_none: a failed grade-item call leaves the question ungraded, never fabricating correctness', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 500, body: { error: 'boom' } }));
    const out = await page.evaluate((q) => {
      window.rd.content = { questions: [q] };
      window.rd.genAnswers = { q1: 'a' };
      return window.rdGradeMultiAuthor().then((results) => ({ results: results, q: q }));
    }, multiAuthorQuestion());
    assert.equal(out.results.q1.correct, false);
    assert.equal('correctAuthorId' in out.q, false);
  });
});
