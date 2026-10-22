import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(file, imports) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => imports(name), console, window: {}, AbortController }, {});
  return exports;
}

function loadFetchSegmentClips(fetchImpl) {
  return load('frontend/js/features/german-exam/media-task-audio.ts', name => {
    if (name.includes('authenticated-fetch')) return { authenticatedFetch: fetchImpl };
    if (name.includes('media-task')) return {};
    throw new Error(`unexpected import ${name}`);
  });
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

test('fetchSegmentClips posts the segments and returns a url/durationMs map keyed by id', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonResponse({ degraded: false, segments: [
    { id: 's1', audioUrl: '/clip/s1', durationMs: 1200 },
    { id: 's2', audioUrl: '/clip/s2', durationMs: 800 },
  ] }); };
  const { fetchSegmentClips } = loadFetchSegmentClips(fetchImpl);

  const signal = new AbortController().signal;
  const result = await fetchSegmentClips([{ id: 's1', text: 'Erster.' }, { id: 's2', text: 'Zweiter.' }], signal);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/ai\/tts-batch$/);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.segments, [{ id: 's1', text: 'Erster.' }, { id: 's2', text: 'Zweiter.' }]);
  assert.equal(body.language, 'German');
  assert.equal(calls[0].init.signal, signal);
  // Compared via JSON, not assert.deepEqual: result was built inside a separate vm context,
  // so its plain objects don't share this realm's Object prototype (structurally identical,
  // deepStrictEqual's prototype check would still fail).
  assert.equal(JSON.stringify(result), JSON.stringify({ s1: { url: '/clip/s1', durationMs: 1200 }, s2: { url: '/clip/s2', durationMs: 800 } }));
});

test('fetchSegmentClips returns null when the batch reports degraded', async () => {
  const { fetchSegmentClips } = loadFetchSegmentClips(async () => jsonResponse({ degraded: true, segments: [{ id: 's1', audioUrl: '/clip/s1', durationMs: 1000 }] }));
  const result = await fetchSegmentClips([{ id: 's1', text: 'x' }], new AbortController().signal);
  assert.equal(result, null);
});

test('fetchSegmentClips returns null when any individual segment failed, even if not globally degraded', async () => {
  const { fetchSegmentClips } = loadFetchSegmentClips(async () => jsonResponse({ degraded: false, segments: [
    { id: 's1', audioUrl: '/clip/s1', durationMs: 1000 }, { id: 's2', failed: true },
  ] }));
  const result = await fetchSegmentClips([{ id: 's1', text: 'x' }, { id: 's2', text: 'y' }], new AbortController().signal);
  assert.equal(result, null);
});

test('fetchSegmentClips returns null on a non-ok HTTP response, never throws', async () => {
  const { fetchSegmentClips } = loadFetchSegmentClips(async () => jsonResponse({}, false));
  const result = await fetchSegmentClips([{ id: 's1', text: 'x' }], new AbortController().signal);
  assert.equal(result, null);
});

test('fetchSegmentClips returns null (never throws) when the network call itself rejects', async () => {
  const { fetchSegmentClips } = loadFetchSegmentClips(async () => { throw new Error('offline'); });
  const result = await fetchSegmentClips([{ id: 's1', text: 'x' }], new AbortController().signal);
  assert.equal(result, null);
});
