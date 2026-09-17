import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const task = {
  generationId: 'gen-writing', exam: { profileId: 'telc_c1_hochschule', family: 'telc', variant: 'C1 Hochschule', cefrLevel: 'C1', profileVersion: 4 },
  part: { id: 'schreiben_1' }, content: { questions: ['a', 'b'].map(questionId => ({
    statements: ["Position A", "Position B"], questionId, title: `Topic ${questionId}`, communicativeSituation: 'Universität', taskInstructions: 'Begründen Sie Ihre Position.', writingCoachTaskType: 'argumentation'
  })) }
};
const analysis = { score: {}, scoreExplanation: '', estimatedLevel: 'C1', strengths: ['Good structure'], feedbackItems: [],
  correctedText: 'CORRECTED', improvedText: 'REWRITE', profileLevel: 'C1 Hochschule', practiceRecommendations: ['Use transitions'], insufficientContext: null };
const grade = { analysis, rubric: { taskFulfilment: 75, correctness: 75, repertoire: 75, communicativeDesign: 75 },
  scoreValue: 36, maxScoreValue: 48, examResultItems: [{ firstAttemptCorrect: null, finalCorrect: null, metadata: { rubric: {} } }] };

function harness({ failSave = false, generic = false } = {}) {
  const elements = new Map();
  class Element {
    value = ''; hidden = false; disabled = false; readOnly = false; textContent = ''; innerHTML = ''; dataset = {}; handlers = {};
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); }
    fire(name) { for (const fn of this.handlers[name] || []) fn({ target: this }); }
    focus() {} removeAttribute() {}
    insertAdjacentHTML(where, html) { this.innerHTML = where === 'afterbegin' ? html + this.innerHTML : this.innerHTML + html; }
    querySelectorAll() {
      this.radios = ['a', 'b'].map(value => Object.assign(new Element(), { value }));
      return this.radios;
    }
  }
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const events = {};
  const storage = new Map([['ss_writing_coach_draft', 'My generic draft']]);
  const window = { addEventListener: (name, fn) => { events[name] = fn; }, setTimeout, clearTimeout };
  if (generic) Object.assign(window, { _germanProfileLoaded: true, _germanLevel: 'B2' });
  const calls = [];
  let resolveGenerate;
  const generated = new Promise(resolve => { resolveGenerate = resolve; });
  const request = async (path, body) => {
    calls.push({ path, body });
    if (path === 'generate') return generated;
    if (path === 'grade-writing') return grade;
    if (path === 'results') {
      if (failSave) { failSave = false; throw new Error('offline'); }
      return { accepted: 1, dropped: 0 };
    }
    return { tags: { grammar_accuracy: { score: 0.4, nAttempts: 3, confidence: 'low' } } };
  };
  const globals = { window, document: { readyState: 'complete', getElementById: el },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    AbortController, DOMException, console, setTimeout, clearTimeout };
  function load(file, imports) {
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { ...globals, exports, require: name => imports(name) });
    return exports;
  }
  const exam = load('frontend/js/features/writing-coach/writing-exam.ts', () => ({}));
  const Session = exam.WritingExamSession;
  const coach = load('frontend/js/features/writing-coach/writing-coach.ts', name => {
    if (name.includes('writing-exam')) return { ...exam, writingExamRequest: request, WritingExamSession: class extends Session { constructor() { super(request); } } };
    if (name.includes('writing-coach-ai')) return { analyzeParagraph: async body => { calls.push({ path: 'generic', body }); return analysis; } };
    if (name.includes('ai-error')) return { friendlyAiErrorMessage: e => e.message };
    return { transitionLearnerWorkspace: async () => {} };
  });
  coach.initWritingCoach(); coach.openWritingCoach();
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const profile = () => { Object.assign(window, { _germanProfileLoaded: true, _germanExamProfileId: 'telc_c1_hochschule', _germanLevel: 'C1 Hochschule' }); events['ss-profile-updated'](); };
  return { el, calls, profile, resolveGenerate: () => resolveGenerate(task), tick, coach, storage };
}

test('profile arriving late and repeated opens generate exactly once; exam hides generic controls', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  h.profile(); h.profile(); h.coach.openWritingCoach();
  assert.equal(h.calls.filter(c => c.path === 'generate').length, 1);
  h.resolveGenerate(); await h.tick();
  h.profile(); await h.tick();
  assert.equal(h.calls.filter(c => c.path === 'generate').length, 1);
  assert.equal(h.el('wcGenericControls').hidden, true);
  assert.match(h.el('wcExamTask').innerHTML, /Thema A/);
  assert.match(h.el('wcExamTask').innerHTML, /Thema B/);
  assert.equal(h.el('wcAnalyze').disabled, true);
});

test('selected task reaches grader, save retry reuses grade, weakness reads follow save, essay stays intact', async () => {
  const h = harness({ failSave: true });
  h.profile(); h.resolveGenerate(); await h.tick();
  h.el('wcExamTask').radios[1].fire('change');
  const essay = 'Meine eigene Antwort mit Argumenten und Beispielen.';
  h.el('wcInput').value = essay; h.el('wcInput').fire('input');
  assert.equal(h.el('wcAnalyze').disabled, false);
  h.el('wcAnalyze').fire('click'); await h.tick();
  assert.equal(h.calls.find(c => c.path === 'grade-writing').body.selectedTopic.questionId, 'b');
  assert.equal(h.calls.some(c => c.path === 'weaknesses'), false);
  assert.equal(h.el('wcInput').value, essay);
  assert.match(h.el('wcResults').innerHTML, /<details><summary>/);
  h.el('wcSaveRetry').fire('click'); await h.tick();
  assert.equal(h.calls.filter(c => c.path === 'grade-writing').length, 1);
  assert.deepEqual(h.calls.slice(-2).map(c => c.path), ['results', 'weaknesses']);
  assert.equal(h.calls.find(c => c.path === 'results').body.items[0].firstAttemptCorrect, null);
  assert.match(h.el('wcWeakAreas').innerHTML, /grammar accuracy/);
});

test('generic Writing Coach keeps profile controls, saved draft and original endpoint', async () => {
  const h = harness({ generic: true });
  assert.equal(h.el('wcGenericControls').hidden, false);
  assert.equal(h.el('wcExamTask').hidden, true);
  assert.equal(h.el('wcInput').value, 'My generic draft');
  h.el('wcAnalyze').fire('click'); await h.tick();
  assert.equal(h.calls[0].path, 'generic');
  assert.equal(h.calls[0].body.profileLevel, 'B2');
  assert.equal(h.calls.some(c => c.path === 'generate'), false);
});
