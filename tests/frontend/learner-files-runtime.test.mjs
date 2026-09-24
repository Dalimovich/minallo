import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('frontend/js/features/german/learner-files.ts', 'utf8');
const ast = ts.createSourceFile('learner-files.ts', source, ts.ScriptTarget.Latest, true);
const code = ts.transpileModule(ast.statements.filter(n => !ts.isImportDeclaration(n))
  .map(n => n.getText(ast).replace(/^export /, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function runtime() {
  const stored = {
    'german-files': [{ name: 'grammar notes.pdf', _storageName: 'grammar_notes.pdf' }],
    'german-reading': [{ name: 'telc.pdf', _storageName: 'telc.pdf' }],
    'university-course': [{ name: 'private-lecture.pdf' }],
  };
  const docs = {
    'german-files': [{ id: 'canonical-doc', file_name: 'grammar notes.pdf', storage_path: 'course-uploads:learner/german-files/grammar_notes.pdf', processing_status: 'ready' }],
    'german-reading': [{ id: 'legacy-doc', file_name: 'telc.pdf', storage_path: 'learner/german-reading/telc.pdf', processing_status: 'ready' }],
  };
  const calls = [];
  const window = {
    SUPA_URL: 'https://storage.invalid',
    _currentUser: { id: 'learner' }, activeCourseId: 'university-course',
    activeCourseRef: { id: 'university-course' }, SEMS: { semester: { courses: [{ id: 'university-course' }] } },
    _ufMerge: async scope => { calls.push(['list', scope.id]); scope.files = stored[scope.id] || []; },
    _ssValidateUploadFile: (file, opts) => {
      if (file.size > opts.maxBytes) throw Error('Too large');
      if (!/\.(pdf|txt|docx|png|jpe?g)$/.test(file.name)) throw Error('Unsupported');
    },
    _ufSanitizeName: name => name.replaceAll(' ', '_'),
    _ufUpload: async (uid, scope, file, progress, folder) => {
      calls.push(['upload', uid, scope.id, folder]);
      stored[scope.id].push({ name: file.name, _storageName: window._ufSanitizeName(file.name) });
      progress?.(100);
    },
    _ufFetchBytes: async (uid, scope, name, folder) => {
      calls.push(['read', uid, scope.id, name, folder]); return new Uint8Array([1, 2]);
    },
  };
  const context = vm.createContext({ window, Uint8Array, Blob, URL,
    MAX_UPLOAD_BYTES: 20 * 1024 * 1024, clearCourseDocumentCache() {},
    listCourseDocuments: async scope => docs[scope] || [],
    authenticatedSupabaseFetch: async (url, init) => {
      const path = JSON.parse(init.body).prefixes[0];
      calls.push(['delete', path]);
      const [, scope, name] = path.split('/');
      stored[scope] = stored[scope].filter(file => file._storageName !== name);
      return { ok: true };
    },
    authenticatedFetch: async (url, init) => {
      calls.push(['api', url, JSON.parse(init.body)]);
      return { ok: true, json: async () => ({ documentId: 'new-doc', processingStatus: 'uploaded', indexingStarted: true }) };
    },
  });
  vm.runInContext(code, context);
  return { api: context, window, calls, stored, docs };
}

test('canonical and legacy files share a flat library, including legacy folders, without course leakage', async () => {
  const r = runtime();
  const merge = r.window._ufMerge;
  r.window._ufMerge = async scope => {
    await merge(scope);
    if (scope.id === 'german-grammar') scope.userFolders = [{ name: 'old', files: [{ name: 'notes.txt' }] }];
  };
  const files = await r.api.listLearnerFiles();
  assert.deepEqual(Array.from(files, f => f.id), ['canonical-doc', 'legacy-doc', 'storage:learner/german-grammar/old/notes.txt']);
  assert.equal(files[2]._folder, 'old');
  assert.equal(r.calls.some(c => c[1] === 'university-course'), false);
  assert.equal(r.window.activeCourseId, 'university-course');
  assert.equal(r.window.SEMS.semester.courses.length, 1);
});

test('deduplication uses document identity, not filename', async () => {
  const r = runtime();
  r.stored['german-grammar'] = [{ name: 'telc.pdf', _storageName: 'telc.pdf' }];
  r.docs['german-grammar'] = [{ id: 'legacy-doc', file_name: 'telc.pdf', storage_path: 'learner/german-grammar/telc.pdf' }];
  assert.equal((await r.api.listLearnerFiles()).length, 2);
  r.docs['german-grammar'][0].id = 'different-doc';
  assert.equal((await r.api.listLearnerFiles()).length, 3);
});

test('new uploads only use german-files and become selectable on a fresh library read', async () => {
  const r = runtime();
  const uploaded = await r.api.uploadLearnerFile({ name: 'new notes.pdf', size: 30 });
  assert.deepEqual(r.calls[0], ['upload', 'learner', 'german-files', null]);
  assert.equal(uploaded.learnerFileScope, 'german-files');
  assert.ok((await r.api.listLearnerFiles()).some(f => f._storageName === 'new_notes.pdf'));
  const indexing = await r.api.indexLearnerFile(uploaded);
  assert.equal(indexing._document.processing_status, 'uploaded', 'starting a job is not indexing success');
  assert.equal(r.calls.find(c => c[0] === 'api')[2].courseId, 'german-files');
  assert.equal(r.window.activeCourseId, 'university-course');
});

test('validation rejects oversized and unsupported uploads before storage', async () => {
  const r = runtime();
  await assert.rejects(r.api.uploadLearnerFile({ name: 'big.pdf', size: 21 * 1024 * 1024 }), /Too large/);
  await assert.rejects(r.api.uploadLearnerFile({ name: 'script.html', size: 10 }), /Unsupported/);
  assert.equal(r.calls.length, 0);
});

test('legacy bytes and deletion retain the actual scope and exact storage name', async () => {
  const r = runtime();
  const file = await r.api.getLearnerFile('legacy-doc');
  await r.api.readLearnerFile(file);
  await r.api.deleteLearnerFile(file);
  assert.deepEqual(r.calls.find(c => c[0] === 'read'), ['read', 'learner', 'german-reading', 'telc.pdf', null]);
  assert.deepEqual(r.calls.find(c => c[0] === 'delete'), ['delete', 'learner/german-reading/telc.pdf']);
  assert.equal((await r.api.listLearnerFiles()).length, 1);
});

test('account switches reject stale entries and in-flight listings', async () => {
  const r = runtime();
  const file = await r.api.getLearnerFile('legacy-doc');
  r.window._currentUser = { id: 'other-user' };
  await assert.rejects(r.api.readLearnerFile(file), /not in your learner library/);
  await assert.rejects(r.api.deleteLearnerFile(file), /not in your learner library/);
  const pending = r.api.listLearnerFiles();
  r.window._currentUser = { id: 'third-user' };
  await assert.rejects(pending, /account changed/);
});

test('failed storage listing is not an empty library', async () => {
  const r = runtime();
  r.window._ufMerge = async () => {};
  await assert.rejects(r.api.listLearnerFiles(), /Could not load/);
});
