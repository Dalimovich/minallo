import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadModule(file) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: () => ({}) });
  return exports;
}

const { ExamSession } = loadModule('frontend/js/features/german-exam/exam-session.ts');

function part(id) { return { id, taskType: 'x', implemented: true }; }
function manifest(overrides = {}) {
  return {
    profileId: 'testdaf_digital', profileVersion: 3,
    deliveryPolicy: { fixedTaskOrder: true, backNavigationAllowed: false, additionalUnscoredTrialTasks: true },
    modules: [
      { id: 'reading', label: 'Lesen', durationSeconds: 100, parts: [part('lesen_1'), part('lesen_2')] },
      { id: 'listening', label: 'Hören', durationSeconds: 50, parts: [part('hoeren_1')] },
    ],
    ...overrides,
  };
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, v); }
  removeItem(k) { this.map.delete(k); }
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a manifest with no navigable parts is rejected outright', () => {
  assert.throws(() => new ExamSession(manifest({ modules: [{ id: 'reading', label: 'Lesen', durationSeconds: null, parts: [] }] })));
});

test('fixedTaskOrder blocks moving to the next part before the current one is submitted, allows it after', () => {
  const c = clock();
  const session = new ExamSession(manifest(), { now: c.now });
  assert.equal(session.advance(), false, 'fixed order: cannot advance without submitting first');
  assert.equal(session.currentPart.id, 'lesen_1');
  session.submitCurrentPart({ answer: 'a' });
  assert.equal(session.advance(), true);
  assert.equal(session.currentPart.id, 'lesen_2');
});

test('backNavigationAllowed=false blocks returning to a completed part', () => {
  const c = clock();
  const session = new ExamSession(manifest(), { now: c.now });
  session.submitCurrentPart('a'); session.advance();
  assert.equal(session.canNavigateTo(0, 0), false);
  assert.throws(() => session.goToPart(0, 0));
});

test('free-navigation profile (no deliveryPolicy) allows backward navigation and skipping ahead', () => {
  const session = new ExamSession(manifest({ deliveryPolicy: null }));
  session.goToPart(0, 1);
  assert.equal(session.currentPart.id, 'lesen_2');
  session.goToPart(0, 0);
  assert.equal(session.currentPart.id, 'lesen_1');
});

test('module timer counts down and tick() auto-locks the module once its deadline passes, marking unfinished parts expired', () => {
  const c = clock();
  const session = new ExamSession(manifest(), { now: c.now });
  assert.equal(session.remainingModuleSeconds(), 100);
  c.advance(60_000);
  assert.equal(session.remainingModuleSeconds(), 40);
  c.advance(41_000);
  session.tick();
  assert.equal(session.progressFor('reading', 'lesen_1').submissionState, 'expired');
  assert.equal(session.progressFor('reading', 'lesen_2').submissionState, 'expired');
  assert.equal(session.currentModule.id, 'listening', 'auto-advanced into the next module');
});

test('a module with no durationSeconds never expires', () => {
  const session = new ExamSession(manifest({
    modules: [{ id: 'writing', label: 'Schreiben', durationSeconds: null, parts: [part('schreiben_1')] }],
  }));
  assert.equal(session.remainingModuleSeconds(), null);
  session.tick();
  assert.equal(session.progressFor('writing', 'schreiben_1').submissionState, 'not_started');
});

test('autosave persists progress and a new session for the same profile/version resumes from storage', () => {
  const storage = new FakeStorage();
  const c = clock();
  const first = new ExamSession(manifest(), { now: c.now, storage });
  first.submitCurrentPart('a'); first.advance();
  const second = new ExamSession(manifest(), { now: c.now, storage });
  assert.equal(second.currentPart.id, 'lesen_2');
  assert.equal(second.progressFor('reading', 'lesen_1').submissionState, 'submitted');
});

test('a corrupted recovery snapshot starts a fresh session instead of throwing', () => {
  const storage = new FakeStorage();
  storage.setItem('german-exam-session:testdaf_digital:3', 'not json{{{');
  const session = new ExamSession(manifest(), { storage });
  assert.equal(session.currentPart.id, 'lesen_1');
});

test('recovery state for a different profileVersion is ignored (structural drift must not resume into a stale part index)', () => {
  const storage = new FakeStorage();
  const c = clock();
  const v3 = new ExamSession(manifest(), { now: c.now, storage });
  v3.submitCurrentPart('a'); v3.advance();
  const v4 = new ExamSession(manifest({ profileVersion: 4 }), { now: c.now, storage });
  assert.equal(v4.currentPart.id, 'lesen_1');
});

test('hasUnsavedRisk is true only while the current part is in-progress (e.g. an active recording), not after submission', () => {
  const session = new ExamSession(manifest());
  assert.equal(session.hasUnsavedRisk(), false);
  session.recordAnswer('draft');
  assert.equal(session.hasUnsavedRisk(), true);
  session.submitCurrentPart('final');
  assert.equal(session.hasUnsavedRisk(), false);
});

test('finalSummary never fabricates trial tasks — it only counts real modules and labels the trial-task policy', () => {
  const c = clock();
  const session = new ExamSession(manifest(), { now: c.now });
  session.submitCurrentPart('a'); session.advance();
  session.submitCurrentPart('b'); session.advance();
  session.submitCurrentPart('c'); session.advance();
  const summary = session.finalSummary();
  assert.equal(summary.finished, true);
  assert.deepEqual([...summary.modulesCompleted], ['reading', 'listening']);
  assert.equal(summary.totalModules, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.trialTasksPolicy)), { simulatesScoredCoreOnly: true, additionalUnscoredTrialTasksInOfficialExam: true });
});

test('advancing past the last module finishes the session and further navigation is refused', () => {
  const session = new ExamSession(manifest());
  session.submitCurrentPart('a'); session.advance();
  session.submitCurrentPart('b'); session.advance();
  session.submitCurrentPart('c'); session.advance();
  assert.equal(session.finished, true);
  assert.throws(() => session.goToPart(0, 0));
  assert.throws(() => session.submitCurrentPart('late'));
});
