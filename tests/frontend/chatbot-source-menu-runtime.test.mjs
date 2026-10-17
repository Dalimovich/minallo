import test from 'node:test';
import assert from 'node:assert/strict';
import { shellRuntime } from '../helpers/chat-stream-runtime.mjs';

function menu(chat) {
  let saved = 0;
  let imported = 0;
  let modes = [];
  let scopes = [];
  const button = (dataset) => ({ dataset, addEventListener(_, fn) { this.click = () => fn({ stopPropagation() {} }); }, focus() {} });
  const list = {
    set innerHTML(html) {
      modes = [...html.matchAll(/data-source-mode="([^"]+)"/g)].map(m => button({ sourceMode: m[1] }));
      scopes = [...html.matchAll(/data-course-file-scope="([^"]+)"/g)].map(m => button({ courseFileScope: m[1] }));
    },
    querySelectorAll(selector) { return selector === '.ncb-source-mode' ? modes : scopes; },
    querySelector() { return null; },
  };
  const label = {};
  const root = { querySelector(selector) {
    if (selector === '.ncb-add-files-source-list') return list;
    if (selector === '.ncb-add-files-source-label') return label;
    if (selector === '.ncb-import-btn') return { click() { imported++; } };
    return null;
  } };
  const r = shellRuntime({ chatStore: { getActive: () => chat }, saveChatStore() { saved++; },
    escapeHtml: x => x, tStr: (_, fallback) => fallback,
  }, ['renderAddFilesSourceMenu', 'renderAddFilesSourceLabel', 'sourceModeLabel']);
  r.renderAddFilesSourceMenu(root);
  return { mode(value) { modes.find(b => b.dataset.sourceMode === value).click(); },
    scope(value) { scopes.find(b => b.dataset.courseFileScope === value).click(); },
    get scopes() { return scopes.length; }, get saved() { return saved; }, get imported() { return imported; }, label };
}

test('every source mode persists independently of selections and scope', () => {
  const chat = { sourceMode: 'course_files', courseFileScope: 'specific_files', selectedSourceIds: ['file-a'] };
  const ui = menu(chat);
  for (const mode of ['auto', 'course_files', 'course_plus_general', 'general', 'internet']) {
    ui.mode(mode);
    assert.equal(chat.sourceMode, mode);
    assert.deepEqual(chat.selectedSourceIds, ['file-a']);
    assert.equal(chat.courseFileScope, 'specific_files');
    assert.ok(chat.updatedAt > 0);
    assert.match(ui.label.textContent, /^Source: /);
    assert.equal(ui.scopes, ['course_files', 'course_plus_general'].includes(mode) ? 2 : 0);
  }
  assert.equal(ui.saved, 5);
});

test('both course modes reuse Import from Course only for an empty selected scope', () => {
  for (const sourceMode of ['course_files', 'course_plus_general']) {
    const chat = { sourceMode, courseFileScope: 'all_course_files', selectedSourceIds: [] };
    const ui = menu(chat);
    ui.scope('specific_files');
    assert.equal(chat.courseFileScope, 'specific_files');
    assert.equal(ui.imported, 1);
    chat.selectedSourceIds.push('file-a');
    ui.scope('all_course_files');
    ui.scope('specific_files');
    assert.equal(ui.imported, 1);
    assert.deepEqual(chat.selectedSourceIds, ['file-a']);
    assert.equal(ui.saved, 3);
  }
});

test('course modes route All files course-wide and Selected files to retained selections', () => {
  const r = shellRuntime({
    sourceLibrary: { items: [{ id: 'file-a', courseId: 'course-a', name: 'Lecture.pdf', documents: [{ id: 'doc-a', name: 'Lecture.pdf' }] }] },
    getActivePdfContext: () => null, isPdfViewerVisible: () => false,
    listCourses: () => [], resolveRequestCourseId: () => 'course-a',
  }, ['ragEligibility', 'clipboardAttachmentText']);
  for (const sourceMode of ['course_files', 'course_plus_general']) {
    const chat = { sourceMode, courseFileScope: 'all_course_files', selectedSourceIds: ['file-a'], courseId: 'course-a' };
    const all = r.ragEligibility([{ role: 'user', text: 'Explain torque' }], chat, 'course-a');
    assert.equal(all.groundingRequest.retrievalScope.type, 'course');
    assert.deepEqual(Array.from(all.documentIds), []);
    chat.courseFileScope = 'specific_files';
    const selected = r.ragEligibility([{ role: 'user', text: 'Explain torque' }], chat, 'course-a');
    assert.equal(selected.groundingRequest.retrievalScope.type, 'documents');
    assert.deepEqual(Array.from(selected.documentIds), ['doc-a']);
  }
});
