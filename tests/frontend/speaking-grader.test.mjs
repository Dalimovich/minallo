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

function loadGrader(request, toBase64) {
  const productive = load('frontend/js/features/german-exam/productive-task.ts', () => ({}));
  const speakingTask = load('frontend/js/features/german-exam/speaking-task.ts', name => {
    if (name.includes('productive-task')) return productive;
    throw new Error(`unexpected import ${name}`);
  });
  return load('frontend/js/features/german-exam/speaking-grader.ts', name => {
    if (name.includes('writing-exam')) return { writingExamRequest: request };
    if (name.includes('speaking-audio')) return { recordingBase64: toBase64 };
    if (name.includes('productive-task')) return productive;
    if (name.includes('speaking-task')) return speakingTask;
    throw new Error(`unexpected import ${name}`);
  });
}

test('createSpeakingRecordingGrader converts the blob to base64 and posts to grade-speaking-recording', async () => {
  const calls = [];
  const request = async (path, body, signal) => { calls.push({ path, body, signal }); return { kind: 'practice_feedback', dimensions: [] }; };
  const toBase64 = async blob => `base64(${blob.size})`;
  const { createSpeakingRecordingGrader } = loadGrader(request, toBase64);

  const envelope = { exam: { profileId: 'testdaf_digital' }, part: { id: 'sprechen_1' } };
  const content = { schemaVersion: 'productive-task-v1', id: 'task-9', prompt: 'Geben Sie einen Rat.', sources: [] };
  const grader = createSpeakingRecordingGrader(envelope, content, request, toBase64);

  const blob = { size: 4096, type: 'audio/webm' };
  const signal = new AbortController().signal;
  const feedback = await grader(blob, 42, signal);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, 'grade-speaking-recording');
  assert.equal(calls[0].body.profileId, 'testdaf_digital');
  assert.equal(calls[0].body.partId, 'sprechen_1');
  assert.equal(calls[0].body.task.id, 'task-9');
  assert.equal(calls[0].body.audioBase64, 'base64(4096)');
  assert.equal(calls[0].body.mimeType, 'audio/webm');
  assert.equal(calls[0].body.durationSeconds, 42);
  assert.equal(calls[0].signal, signal);
  assert.equal(feedback.kind, 'practice_feedback');
});

test('createSpeakingRecordingGrader falls back to audio/webm when the blob has no type', async () => {
  const calls = [];
  const request = async (path, body) => { calls.push(body); return { kind: 'practice_feedback', dimensions: [] }; };
  const toBase64 = async () => 'b64';
  const { createSpeakingRecordingGrader } = loadGrader(request, toBase64);

  const envelope = { exam: { profileId: 'testdaf_digital' }, part: { id: 'sprechen_2' } };
  const content = { schemaVersion: 'productive-task-v1', id: 't1', prompt: 'p', sources: [] };
  const grader = createSpeakingRecordingGrader(envelope, content, request, toBase64);

  await grader({ size: 10, type: '' }, 5, new AbortController().signal);
  assert.equal(calls[0].mimeType, 'audio/webm');
});

test('createSpeakingRecordingGrader never persists or re-sends a recordingId — the blob is converted exactly once per call', async () => {
  let base64Calls = 0;
  const toBase64 = async () => { base64Calls += 1; return 'b64'; };
  const request = async () => ({ kind: 'practice_feedback', dimensions: [] });
  const { createSpeakingRecordingGrader } = loadGrader(request, toBase64);

  const envelope = { exam: { profileId: 'testdaf_digital' }, part: { id: 'sprechen_1' } };
  const content = { schemaVersion: 'productive-task-v1', id: 't1', prompt: 'p', sources: [] };
  const grader = createSpeakingRecordingGrader(envelope, content, request, toBase64);

  await grader({ size: 1, type: 'audio/webm' }, 1, new AbortController().signal);
  assert.equal(base64Calls, 1);
});
