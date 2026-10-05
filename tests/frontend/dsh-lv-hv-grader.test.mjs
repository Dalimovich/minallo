import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, imports) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => imports(name), window: {}, console }, {});
  return exports;
}

function loadGrader(fetchImpl) {
  return load('frontend/js/features/german-exam/dsh-lv-hv-grader.ts', name => {
    if (name.includes('authenticated-fetch')) return { authenticatedFetch: fetchImpl };
    throw new Error(`unexpected import ${name}`);
  });
}

function okFetch(body) {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => body }; };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('dshLvHvRequest posts to /api/ai/german-exam/dsh/lv-hv/<path> with the given body and signal', async () => {
  const fetchImpl = okFetch({ ok: true });
  const { dshLvHvRequest } = loadGrader(fetchImpl);
  const signal = new AbortController().signal;
  const result = await dshLvHvRequest('generate', { part: 'lv', topic: null }, signal);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, '/api/ai/german-exam/dsh/lv-hv/generate');
  assert.equal(fetchImpl.calls[0].opts.method, 'POST');
  assert.equal(JSON.parse(fetchImpl.calls[0].opts.body).part, 'lv');
  assert.equal(fetchImpl.calls[0].opts.signal, signal);
  assert.deepEqual(result, { ok: true });
});

test('dshLvHvRequest throws with the backend detail message on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({ detail: 'Content evaluation unavailable. Your answer was not scored.' }) });
  const { dshLvHvRequest } = loadGrader(fetchImpl);
  await assert.rejects(
    () => dshLvHvRequest('grade', {}),
    (err) => { assert.match(err.message, /not scored/); return true; },
  );
});

test('generateDshLvHvPracticeTask calls the generate path with the part and topic (null when omitted), and never sends userId', async () => {
  const calls = [];
  const request = async (path, body, signal) => { calls.push({ path, body, signal }); return { part: 'lv', generationId: 'g1', content: {} }; };
  const { generateDshLvHvPracticeTask } = loadGrader(okFetch({}));
  const result = await generateDshLvHvPracticeTask('lv', undefined, request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'generate');
  assert.equal(calls[0].body.part, 'lv');
  assert.equal(calls[0].body.topic, null);
  assert.equal('userId' in calls[0].body, false);
  assert.equal(result.generationId, 'g1');
  assert.equal('gradingContent' in result, false);
});

test('generateDshLvHvPracticeTask forwards an explicit topic label', async () => {
  const calls = [];
  const request = async (path, body) => { calls.push(body); return { part: 'hv', generationId: 'g2', content: {} }; };
  const { generateDshLvHvPracticeTask } = loadGrader(okFetch({}));
  await generateDshLvHvPracticeTask('hv', 'Klimawandel', request);
  assert.equal(calls[0].topic, 'Klimawandel');
});

test('createDshLvHvGrader holds only generationId in closure (no gradingContent parameter exists) and sends answers as an itemId/answer array', async () => {
  const calls = [];
  const request = async (path, body, signal) => { calls.push({ path, body, signal }); return {
    part: 'lv', generationId: 'g1', rawPoints: 1, rawMaxPoints: 2, percent: 50,
    items: [], officialDshScore: null, officialScoreAvailable: false,
  }; };
  const { createDshLvHvGrader } = loadGrader(okFetch({}));
  const grader = createDshLvHvGrader('lv', 'g1', request);

  const signal = new AbortController().signal;
  const result = await grader({ q1: 'Antwort.', q2: 'Antwort 2.' }, signal);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'grade');
  assert.equal(calls[0].body.part, 'lv');
  assert.equal(calls[0].body.generationId, 'g1');
  assert.equal('gradingContent' in calls[0].body, false);
  assert.equal('userId' in calls[0].body, false);
  // JSON-round-tripped comparison: the body was built inside a vm sandbox realm, so its plain
  // objects have a different Object prototype than this file's literals — deepEqual's strict
  // prototype check would fail on structurally-identical-but-cross-realm objects otherwise.
  assert.equal(JSON.stringify(calls[0].body.answers), JSON.stringify([{ itemId: 'q1', answer: 'Antwort.' }, { itemId: 'q2', answer: 'Antwort 2.' }]));
  assert.equal(calls[0].signal, signal);
  assert.equal(result.officialDshScore, null);
  assert.equal(result.officialScoreAvailable, false);
});
