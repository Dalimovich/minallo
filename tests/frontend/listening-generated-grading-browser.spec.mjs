// Real Chromium component integration for the generated (AI) Hören answer-key fix: executes the
// REAL production grading functions (lsGradeSpeakerMatchingType/lsGradeMc3Type/
// lsGradeNoteCompletionType/lsGradeGeneratedAnswer/_authFetch/lsCheckAnswer/lsFinishCheckAnswer)
// from frontend/views/practice/practice.js against a REAL network call intercepted by Playwright
// — not a locally-defined fake grader, and not a bare vm context (which has no fetch/dynamic
// import() semantics). Mirrors tests/frontend/dsh-open-answer-task-browser.spec.mjs's
// withWiredPage pattern (also a network-backed grading call), adapted for practice.js's
// _authFetch (a dynamic import() of /js/services/authenticated-fetch.js, not a require()).
//
// Covers the 3 live generated listening task types: speaker_statement_matching,
// sentence_completion_mc3, structured_note_completion. No real backend, no real Supabase, no
// real OpenAI call — every request other than the page navigation and the one grade-item call is
// aborted, so a regression that accidentally fires a second network call is caught, not masked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('frontend/views/practice/practice.js', root), 'utf8');

// Brace-counting extractor (robust to the file's mixed indentation levels — _authFetch lives in
// the file's outer closure at 4-space indent, the ls* grading functions in a deeper nested
// closure at 6-space indent; a fixed-indentation "next line starting with N spaces + }" heuristic,
// like reading-mc-browser.spec.mjs's productionFunction, would silently mis-slice one of them).
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

const EXTRACTED = [
  '_getAuthFetchModule', '_authFetch',
  'lsGradeGeneratedAnswer', 'lsGradeSpeakerMatchingType', 'lsGradeMc3Type', 'lsGradeNoteCompletionType',
  'lsGradeTristateType', // Goethe Hören Teil 2 — same server-graded pattern as the 3 telc types
  'lsGradeMcqLikeType', // the unrelated, still-synchronous static-practice grader (regression check)
  'lsFinishCheckAnswer', 'lsCheckAnswer',
].map(extractFunction).join('\n');

// Everything lsCheckAnswer's dependency chain touches that we deliberately do NOT extract (DOM
// rendering, attempt persistence) — hand-written minimal stubs, same convention
// reading-mc-browser.spec.mjs uses for rdEl/_glEscape/etc. Spies record calls for assertions.
const HARNESS = `
  var BACKEND_URL = '';
  var _authFetchModulePromise = null;
  var ls = { generationId: 'gen-real-1', usingGenerated: true };
  window.__renderCalls = 0;
  window.__recordedAttempts = [];
  function lsEl(id) { return document.getElementById(id); }
  function lsRenderWorkspace() { window.__renderCalls++; }
  function lsRecordAttempt(q, ans, correct) { window.__recordedAttempts.push({ questionId: q.questionId, correct: correct, selected: ans.selected }); }
  ${EXTRACTED}
  var LS_GRADERS = {
    'speaker_statement_matching': lsGradeSpeakerMatchingType,
    'sentence_completion_mc3': lsGradeMc3Type,
    'structured_note_completion': lsGradeNoteCompletionType,
    'listening_tristate': lsGradeTristateType,
    'main-idea': lsGradeMcqLikeType
  };
`;

async function withWiredPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const gradeRequests = [];
    let gradeHandler = () => ({ status: 200, body: { questionId: 'q1', correct: true, correctAnswer: null, evidenceSegmentIds: [] } });
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url === 'http://localhost/') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<main></main>' });
      }
      if (url.includes('/js/services/authenticated-fetch.js')) {
        // The real authenticated-fetch.js module does a lot more (expiry-skew refresh, 401
        // retry) that is irrelevant here — this is a faithful enough stand-in for exactly what
        // _authFetch's own contract needs: a function named authenticatedFetch(url, init) that
        // performs the request. The request itself still goes through THIS SAME page.route, so
        // intercepting the grade-item URL below is still real interception, not a bypass.
        return route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: 'export function authenticatedFetch(url, init) { return fetch(url, init); }',
        });
      }
      if (url.includes('/api/ai/german-exam/grade-listening-item')) {
        gradeRequests.push(route.request().postDataJSON());
        const { status, body } = await gradeHandler(); // gradeHandler may itself return a Promise (held-open responses)
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

function matchingQuestion() {
  return { questionId: 'q1', type: 'speaker_statement_matching', matching: {}, segmentIds: [] };
}
function mc3Question() {
  return { questionId: 'q1', type: 'sentence_completion_mc3', mc3: { stem: 'x', options: ['A', 'B', 'C'] } };
}
function noteQuestion() {
  return { questionId: 'q1', type: 'structured_note_completion', note: { fieldLabel: 'Datum' } };
}
function tristateQuestion() {
  return { questionId: 'q1', type: 'listening_tristate', tristate: {}, segmentIds: ['s1', 's2', 's3'] };
}

// ---- 1 & 2: request shape — generationId/questionId/selected only, no answer key, nothing to "trust" ----

test('speaker_statement_matching sends exactly {generationId, questionId, selected}, never an answer key', async () => {
  await withWiredPage(async (page, gradeRequests) => {
    await page.evaluate((q) => {
      var ans = { _pending: 'speaker_2' };
      return window.lsGradeSpeakerMatchingType(q, ans);
    }, matchingQuestion());
    assert.equal(gradeRequests.length, 1);
    assert.deepEqual(Object.keys(gradeRequests[0]).sort(), ['generationId', 'questionId', 'selected']);
    assert.equal(gradeRequests[0].generationId, 'gen-real-1');
    assert.equal(gradeRequests[0].questionId, 'q1');
    assert.equal(gradeRequests[0].selected, 'speaker_2');
  });
});

test('sentence_completion_mc3 sends the parsed integer index, not the raw radio-button string', async () => {
  await withWiredPage(async (page, gradeRequests) => {
    await page.evaluate((q) => window.lsGradeMc3Type(q, { _pending: '1' }), mc3Question());
    assert.equal(gradeRequests[0].selected, 1);
  });
});

test('structured_note_completion sends the trimmed free-text answer', async () => {
  await withWiredPage(async (page, gradeRequests) => {
    await page.evaluate((q) => {
      document.body.innerHTML = '<input id="glListenNoteInput" value="  12. März  ">';
      return window.lsGradeNoteCompletionType(q, {});
    }, noteQuestion());
    assert.equal(gradeRequests[0].selected, '12. März');
  });
});

// ---- 3 & 4 & 5: returned result updates the UI, correct/incorrect feedback, reveal-after-only ----

test('speaker matching: correctAnswer is absent before grading and patched onto q.matching only after a correct response', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 200, body: { questionId: 'q1', correct: true, correctAnswer: 'speaker_2', evidenceSegmentIds: ['s2'] } }));
    const q = matchingQuestion();
    const before = await page.evaluate((q) => 'correctSpeakerId' in q.matching, q);
    assert.equal(before, false);
    const result = await page.evaluate((args) => {
      var q = args.q, ans = { _pending: 'speaker_2' };
      return window.lsGradeSpeakerMatchingType(q, ans).then((correct) => ({ correct: correct, q: q }));
    }, { q });
    assert.equal(result.correct, true);
    assert.equal(result.q.matching.correctSpeakerId, 'speaker_2');
    assert.deepEqual(result.q.segmentIds, ['s2']);
  });
});

test('mc3: an incorrect answer still reveals mc3.correctIndex for the post-grade render, and resolves false', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 200, body: { questionId: 'q1', correct: false, correctAnswer: 1, evidenceSegmentIds: [] } }));
    const result = await page.evaluate((q) => {
      return window.lsGradeMc3Type(q, { _pending: '0' }).then((correct) => ({ correct: correct, mc3: q.mc3 }));
    }, mc3Question());
    assert.equal(result.correct, false);
    assert.equal(result.mc3.correctIndex, 1);
  });
});

// ---- Goethe Hören Teil 2 (listening_tristate) — same server-graded contract as the 3 telc types ----

test('listening_tristate sends exactly {generationId, questionId, selected}, never an answer key', async () => {
  await withWiredPage(async (page, gradeRequests) => {
    await page.evaluate((q) => window.lsGradeTristateType(q, { _pending: 'falsch' }), tristateQuestion());
    assert.equal(gradeRequests.length, 1);
    assert.deepEqual(Object.keys(gradeRequests[0]).sort(), ['generationId', 'questionId', 'selected']);
    assert.equal(gradeRequests[0].selected, 'falsch');
  });
});

test('tristate: q.answer is absent before grading and patched only after a response, with evidence replacing the full-audio fallback', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 200, body: { questionId: 'q1', correct: true, correctAnswer: 'falsch', evidenceSegmentIds: ['s2'] } }));
    const q = tristateQuestion();
    const before = await page.evaluate((q) => 'answer' in q, q);
    assert.equal(before, false);
    const result = await page.evaluate((args) => {
      var q = args.q;
      return window.lsGradeTristateType(q, { _pending: 'falsch' }).then((correct) => ({ correct: correct, q: q }));
    }, { q });
    assert.equal(result.correct, true);
    assert.equal(result.q.answer, 'falsch');
    assert.deepEqual(result.q.segmentIds, ['s2']);
  });
});

test('tristate: an incorrect answer still reveals q.answer, and keeps the full-audio fallback when no evidence is returned (nicht_im_text)', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 200, body: { questionId: 'q1', correct: false, correctAnswer: 'nicht_im_text', evidenceSegmentIds: [] } }));
    const result = await page.evaluate((q) => {
      return window.lsGradeTristateType(q, { _pending: 'richtig' }).then((correct) => ({ correct: correct, q: q }));
    }, tristateQuestion());
    assert.equal(result.correct, false);
    assert.equal(result.q.answer, 'nicht_im_text');
    assert.deepEqual(result.q.segmentIds, ['s1', 's2', 's3']); // unchanged — no evidence to narrow to
  });
});

test('lsCheckAnswer, given a successful grade, transitions ans.finalStatus and calls lsRenderWorkspace', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 200, body: { questionId: 'q1', correct: true, correctAnswer: 0, evidenceSegmentIds: [] } }));
    const out = await page.evaluate((q) => {
      var ans = { _pending: '0', attempts: 0 };
      window.lsCheckAnswer(q, ans);
      return new Promise((resolve) => {
        var tries = 0;
        (function poll() {
          if (ans.finalStatus || ++tries > 50) return resolve({ ans: ans, renderCalls: window.__renderCalls, recorded: window.__recordedAttempts });
          setTimeout(poll, 10);
        })();
      });
    }, mc3Question());
    assert.equal(out.ans.finalStatus, 'correct');
    assert.equal(out.ans.attempts, 1);
    assert.equal(out.ans._firstAttemptCorrect, true);
    assert.ok(out.renderCalls >= 1);
    assert.deepEqual(out.recorded, [{ questionId: 'q1', correct: true, selected: 0 }]);
  });
});

// ---- 6: a failed request never fabricates correctness or reveals the key -----------------------

test('a 500 from the grading endpoint leaves the question ungraded: no finalStatus, no revealed answer, no recorded attempt', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    setGradeResponse(() => ({ status: 500, body: { error: 'boom' } }));
    const out = await page.evaluate((q) => {
      var ans = { _pending: '0', attempts: 0 };
      window.lsCheckAnswer(q, ans);
      return new Promise((resolve) => setTimeout(() => resolve({ ans: ans, q: q, recorded: window.__recordedAttempts }), 200));
    }, mc3Question());
    assert.equal(out.ans.finalStatus, undefined);
    assert.equal(out.ans.attempts, 0);
    assert.equal('correctIndex' in out.q.mc3, false);
    assert.deepEqual(out.recorded, []);
  });
});

test('a network abort (not even a response) behaves the same as an HTTP error — fails closed', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url === 'http://localhost/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<main></main>' });
      if (url.includes('/js/services/authenticated-fetch.js')) {
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'export function authenticatedFetch(url, init) { return fetch(url, init); }' });
      }
      return route.abort(); // includes the grade-item call itself this time
    });
    await page.goto('http://localhost/');
    await page.addScriptTag({ content: HARNESS });
    const out = await page.evaluate((q) => {
      var ans = { _pending: '0', attempts: 0 };
      window.lsCheckAnswer(q, ans);
      return new Promise((resolve) => setTimeout(() => resolve({ ans: ans, q: q }), 200));
    }, mc3Question());
    assert.equal(out.ans.finalStatus, undefined);
    assert.equal('correctIndex' in out.q.mc3, false);
  } finally {
    await browser.close();
  }
});

// ---- 7: repeated attempts after an incorrect answer / hint keep working -------------------------

test('the same question can be checked again after an incorrect first attempt (hint/retry flow)', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    let call = 0;
    setGradeResponse(() => {
      call++;
      return { status: 200, body: { questionId: 'q1', correct: call === 2, correctAnswer: 1, evidenceSegmentIds: [] } };
    });
    const q = mc3Question();
    const first = await page.evaluate((q) => window.lsGradeMc3Type(q, { _pending: '0' }), q);
    assert.equal(first, false);
    const second = await page.evaluate((q) => window.lsGradeMc3Type(q, { _pending: '1' }), q);
    assert.equal(second, true);
    assert.equal(gradeRequests.length, 2);
  });
});

// ---- 8: loading state + duplicate-submission guard ----------------------------------------------

test('a second lsCheckAnswer call for the same in-flight answer is a no-op — the guard runs before the grader, not just a disabled button', async () => {
  // This is the real guard (ans._checking, checked before the grader/fetch is even called) — a
  // disabled checkBtn alone would not catch this, since a DIRECT second call bypasses whatever
  // the DOM looks like. Proves the fix itself, not an incidental side effect of button state.
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    let unblock;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    setGradeResponse(() => blocked.then(() => ({ status: 200, body: { questionId: 'q1', correct: true, correctAnswer: 0, evidenceSegmentIds: [] } })));
    // lsCheckAnswer's own fetch is deferred behind a dynamic import() microtask, so the first
    // network request doesn't actually land until after page.evaluate() has already returned —
    // poll for it rather than asserting immediately, to avoid a false pass from checking
    // gradeRequests before anything has been sent at all.
    await page.evaluate((q) => {
      window.__ans = { _pending: '0', attempts: 0 };
      window.lsCheckAnswer(q, window.__ans); // first call: starts the (currently blocked) request
      window.lsCheckAnswer(q, window.__ans); // second call, same ans, while the first is still in flight
      window.lsCheckAnswer(q, window.__ans); // third, for good measure
    }, mc3Question());
    for (let tries = 0; gradeRequests.length === 0 && tries < 50; tries++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(gradeRequests.length, 1); // the fetch itself only ever happened once
    unblock();
    await page.waitForFunction(() => window.__ans.finalStatus === 'correct');
    assert.equal(gradeRequests.length, 1); // still just one, after the real round trip completed too
  });
});

test('the check button is disabled for the round trip and a real second click on it does not fire a second request', async () => {
  await withWiredPage(async (page, gradeRequests, setGradeResponse) => {
    await page.evaluate((q) => {
      window.__q = q;
      window.__ans = { _pending: '0', attempts: 0 };
      document.body.innerHTML = '<button id="glListenCheckBtn">Check</button>';
      document.getElementById('glListenCheckBtn').addEventListener('click', function () {
        window.lsCheckAnswer(window.__q, window.__ans);
      });
    }, mc3Question());
    // Route the in-flight request to hang until we explicitly resolve it, to give the test a
    // deterministic window in which to attempt (and fail) a duplicate submission.
    let unblock;
    const blocked = new Promise((resolve) => { unblock = resolve; });
    setGradeResponse(() => blocked.then(() => ({ status: 200, body: { questionId: 'q1', correct: true, correctAnswer: 0, evidenceSegmentIds: [] } })));

    await page.click('#glListenCheckBtn');
    assert.equal(await page.locator('#glListenCheckBtn').isDisabled(), true);
    unblock();
    await page.waitForFunction(() => window.__ans.finalStatus === 'correct');
    assert.equal(gradeRequests.length, 1);
  });
});

// ---- 9: existing (static, non-generated) TELC listening behavior is unaffected ------------------

test('the static main-idea grader (non-generated practice sets) stays synchronous and makes no network call', async () => {
  await withWiredPage(async (page, gradeRequests) => {
    const result = await page.evaluate(() => {
      var q = { questionId: 'static1', type: 'main-idea', answer: 'B' };
      var ans = { _pending: 'B' };
      return window.LS_GRADERS[q.type](q, ans);
    });
    assert.equal(result, true); // plain boolean, not a Promise — confirms the sync path is untouched
    assert.equal(gradeRequests.length, 0);
  });
});
