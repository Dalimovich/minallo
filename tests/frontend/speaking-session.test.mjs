import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadModule(file, imports = () => ({})) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: imports, console });
  return exports;
}

const { SpeakingSession, speakingProfileStatus } = loadModule('frontend/js/features/speaking/speaking-session.ts', name => {
  if (name.includes('writing-exam')) return { writingExamRequest: async () => { throw new Error('unused default request'); } };
  return {};
});

const sprechen1Task = {
  generationId: 'gen-sp1', part: { id: 'sprechen_1' },
  content: { questions: [{ questionId: 'a', title: 'Thema A', taskInstructions: 'Sprechen Sie über A.' }, { questionId: 'b', title: 'Thema B', taskInstructions: 'Sprechen Sie über B.' }] }
};
const sprechen2Task = {
  generationId: 'gen-sp2', part: { id: 'sprechen_2' },
  content: { quote: 'Wissen ist Macht.', sourceLabel: 'Übungsmaterial', guidingPoints: ['Punkt 1', 'Punkt 2', 'Punkt 3', 'Punkt 4'] }
};

function harness() {
  const calls = [];
  const responses = new Map();
  const request = async (path, body) => {
    calls.push({ path, body });
    const key = `${path}:${body.partId || body.stage || body.action || ''}`;
    const factory = responses.get(key) || responses.get(path);
    if (!factory) throw new Error(`no stub for ${key}`);
    return factory(body);
  };
  const session = new SpeakingSession('sess-1', request);
  return { session, calls, responses };
}

test('speakingProfileStatus distinguishes loading, ready and unsupported (profile-load race)', () => {
  assert.equal(speakingProfileStatus({ loaded: false, id: null }), 'loading');
  assert.equal(speakingProfileStatus({ loaded: true, id: 'telc_c1_hochschule' }), 'ready');
  assert.equal(speakingProfileStatus({ loaded: true, family: 'telc', level: 'C1 Hochschule' }), 'ready');
  assert.equal(speakingProfileStatus({ loaded: true, id: null, family: 'telc', level: 'B2' }), 'unsupported');
  assert.equal(speakingProfileStatus({ loaded: true, id: null, family: 'TestDaF', level: 'TDN 4' }), 'unsupported');
});

test('official two-part structure: sprechen_1 requires exactly two topics', async () => {
  const h = harness();
  h.responses.set('generate:sprechen_1', () => ({ ...sprechen1Task, content: { questions: [sprechen1Task.content.questions[0]] } }));
  await assert.rejects(h.session.load('sprechen_1'), /unvollständig/);
});

test('official two-part structure: sprechen_2 requires a quote and guiding points', async () => {
  const h = harness();
  h.responses.set('generate:sprechen_2', () => ({ ...sprechen2Task, content: { ...sprechen2Task.content, guidingPoints: ['only one'] } }));
  await assert.rejects(h.session.load('sprechen_2'), /unvollständig/);
});

test('load caches per part and de-duplicates in-flight requests', async () => {
  const h = harness();
  let calls = 0;
  h.responses.set('generate:sprechen_1', () => { calls++; return sprechen1Task; });
  const [a, b] = await Promise.all([h.session.load('sprechen_1'), h.session.load('sprechen_1')]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  await h.session.load('sprechen_1');
  assert.equal(calls, 1);
});

test('Teil 1A -> Teil 1B stage progression follows choose -> prepare -> presentation -> own_followup -> listen -> summary -> questions -> part1_done', async () => {
  const h = harness();
  h.responses.set('generate:sprechen_1', () => sprechen1Task);
  await h.session.load('sprechen_1');
  assert.equal(h.session.stage, 'choose');
  h.session.choose('a');
  assert.equal(h.session.stage, 'prepare');
  h.session.startPresentation();
  assert.equal(h.session.stage, 'presentation');

  h.responses.set('speaking:presentation', () => ({ role: 'learner', stage: 'presentation', text: 'transcript', evidence: 'ok' }));
  h.responses.set('speaking:own_followup', body => ({ role: body.action === 'transcribe' ? 'learner' : 'partner', stage: 'own_followup', text: 'x', evidence: 'ok' }));
  await h.session.submitRecording('base64', 'audio/webm');
  assert.equal(h.session.stage, 'own_followup');

  h.responses.set('speaking:partner_presentation', () => ({ role: 'partner', stage: 'partner_presentation', text: 'Partnervortrag', evidence: 'ok' }));
  await h.session.submitRecording('base64', 'audio/webm');
  assert.equal(h.session.stage, 'listen');

  assert.throws(() => h.session.startSummary(), /Hören/);
  h.session.listened = true;
  h.session.startSummary();
  assert.equal(h.session.stage, 'summary');

  h.responses.set('speaking:summary', () => ({ role: 'learner', stage: 'summary', text: 'Zusammenfassung', evidence: 'ok' }));
  await h.session.submitRecording('base64', 'audio/webm');
  assert.equal(h.session.stage, 'questions');

  h.responses.set('speaking:questions', () => ({ role: 'learner', stage: 'questions', text: 'Frage', evidence: 'ok' }));
  h.responses.set('speaking:partner_answer', () => ({ role: 'partner', stage: 'partner_answer', text: 'Antwort', evidence: 'ok' }));
  await h.session.submitRecording('base64', 'audio/webm');
  assert.equal(h.session.stage, 'part1_done');
});

test('Teil 2 requires two learner discussion turns before grading and evaluates exactly once', async () => {
  const h = harness();
  h.responses.set('generate:sprechen_2', () => sprechen2Task);
  h.session.stage = 'part1_done';
  h.responses.set('speaking:discussion', () => ({ role: 'partner', stage: 'discussion', text: 'Gegenargument', evidence: 'ok' }));
  await h.session.startDiscussion();
  assert.equal(h.session.stage, 'discussion');
  assert.equal(h.session.canGrade, false);

  h.session.turns.push({ role: 'learner', stage: 'discussion', text: 'Meine Meinung', evidence: 'ok' });
  assert.equal(h.session.canGrade, false);
  h.session.turns.push({ role: 'learner', stage: 'discussion', text: 'Noch ein Argument', evidence: 'ok' });
  assert.equal(h.session.canGrade, true);

  let gradeCalls = 0;
  h.responses.set('speaking:grade', () => {
    gradeCalls++;
    return {
      scoreValue: 20, maxScoreValue: 32, officialMaxScoreValue: 48,
      rubric: {
        presentation: { score: 5, maxScore: 6, scope: 'part' },
        summary_followup: { score: 3, maxScore: 4, scope: 'part' },
        discussion: { score: 5, maxScore: 6, scope: 'part' },
        fluency: { score: 6, maxScore: 8, scope: 'global' },
        repertoire: { score: 6, maxScore: 8, scope: 'global' },
        grammatical_correctness: { score: 6, maxScore: 8, scope: 'global' },
        pronunciation_intonation: { score: null, maxScore: 8, scope: 'global' }
      },
      unavailableReason: 'Aussprache benötigt Audionachweis und ist hier nicht verfügbar.',
      feedback: { strengths: [], weaknesses: [], improvements: [] }, examResultItems: []
    };
  });
  await h.session.evaluate();
  assert.equal(h.session.stage, 'graded');
  assert.equal(gradeCalls, 1);
  await h.session.evaluate();
  assert.equal(gradeCalls, 1, 'a second evaluate() call must not re-grade');
});

test('no fabricated pronunciation score: a null rubric score from the backend is passed through untouched', async () => {
  const h = harness();
  h.session.grade = {
    scoreValue: 20, maxScoreValue: 32, officialMaxScoreValue: 48,
    rubric: { pronunciation_intonation: { score: null, maxScore: 8, scope: 'global' } },
    unavailableReason: 'no audio evidence', feedback: {}, examResultItems: []
  };
  assert.equal(h.session.grade.rubric.pronunciation_intonation.score, null);
});

test('save() persists exactly once and is idempotent on repeated calls', async () => {
  const h = harness();
  h.session.tasks.sprechen_1 = sprechen1Task;
  h.session.grade = {
    scoreValue: 20, maxScoreValue: 32, officialMaxScoreValue: 48, rubric: {}, unavailableReason: '',
    feedback: {}, examResultItems: [{ firstAttemptCorrect: null, finalCorrect: null, metadata: {} }]
  };
  let saveCalls = 0;
  h.responses.set('results', body => { saveCalls++; assert.equal(body.module, 'speaking'); return { accepted: body.items.length, dropped: 0 }; });
  await Promise.all([h.session.save(), h.session.save()]);
  assert.equal(saveCalls, 1, 'concurrent save() calls must share the in-flight request');
  assert.equal(h.session.saved, true);
  await h.session.save();
  assert.equal(saveCalls, 1, 'save() after success must not re-POST');
});

test('save() never marks saved when the server drops rows, so a later retry can still fire', async () => {
  const h = harness();
  h.session.grade = { scoreValue: 20, maxScoreValue: 32, officialMaxScoreValue: 48, rubric: {}, unavailableReason: '', feedback: {}, examResultItems: [{ firstAttemptCorrect: null, finalCorrect: null, metadata: {} }] };
  h.responses.set('results', () => ({ accepted: 0, dropped: 1 }));
  await assert.rejects(h.session.save());
  assert.equal(h.session.saved, false);
});

test('speaking-audio.ts owns only its own recorder/Audio element and never touches Hören TTS internals', () => {
  const source = fs.readFileSync('frontend/js/features/speaking/speaking-audio.ts', 'utf8');
  assert.doesNotMatch(source, /window\.speechSynthesis/);
  assert.doesNotMatch(source, /speechSynthesis\.cancel/);
  assert.doesNotMatch(source, /from ['"].*hoeren/i);
});
