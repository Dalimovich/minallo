import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('frontend/views/practice/practice.js', 'utf8');
const ast = ts.createSourceFile('practice.js', source, ts.ScriptTarget.Latest, true);
const names = ['_glCourse', '_glEnsurePracticeCourse', '_glPickSourcesThenGenerate', '_glRunGenerate'];
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);

test('file-grounded quizzes and cards send selected canonical/legacy document IDs in their own storage scopes', async () => {
  for (const tool of ['quiz', 'flashcards']) {
    const calls = [];
    const saved = [];
    const files = [
      { documentId: 'new-doc', learnerFileScope: 'german-files', _document: { id: 'new-doc', processing_status: 'ready' } },
      { documentId: 'old-doc', learnerFileScope: 'german-reading', _document: { id: 'old-doc', processing_status: 'ready' } },
      { documentId: 'pending-doc', learnerFileScope: 'german-files', _document: { id: 'pending-doc', processing_status: 'uploaded' } },
    ];
    let confirm;
    const context = vm.createContext({
      window: { activeCourseId: 'university-course', activeCourseRef: { id: 'university-course' } },
      document: { getElementById: () => null }, BACKEND_URL: '', _glActiveSkill: 'grammar', _glSkillNames: { grammar: 'Grammar' },
      _glLearnerFiles: async () => ({ listLearnerFiles: async () => files }),
      _glShowSourcePicker: (docs, callback) => {
        assert.deepEqual(docs.map(doc => doc.id), ['new-doc', 'old-doc']);
        confirm = callback;
      },
      _glSetToolMode() {}, _glSeenItems: () => [], _glRenderStudyTools() {}, showToast() {},
      _authFetch: async (url, init) => {
        calls.push({ url, ...JSON.parse(init.body) });
        return { ok: true, json: async () => ({ items: [{ question: 'Was?', front: 'Was?', back: 'What?' }] }) };
      },
      _dbSaveQuiz: async (scope, items) => saved.push({ scope, items }),
      _dbSaveCards: async (scope, items) => saved.push({ scope, items }),
    });
    vm.runInContext(functions.join('\n'), context);
    assert.equal(context._glEnsurePracticeCourse().id, 'german-grammar');
    await context._glPickSourcesThenGenerate(tool);
    assert.ok(confirm, 'ready files should open the source selector');
    await context._glRunGenerate(tool, ['new-doc', 'old-doc'], files);
    assert.deepEqual(calls.map(call => [call.courseId, call.documentIds]), [
      ['german-files', ['new-doc']], ['german-reading', ['old-doc']],
    ]);
    assert.equal(saved[0].scope, 'german-grammar', 'saved tools retain their legacy skill key');
    assert.equal(saved[0].items.length, 2);
    assert.equal(context.window.activeCourseId, 'university-course');
    assert.equal(context.window.activeCourseRef.id, 'university-course');
  }
});

test('no file-grounded action in Practice falls back to the active university course', () => {
  assert.doesNotMatch(source, /_glStorageCourse|activeCourseId\s*=|activeCourseRef\s*=/);
});
