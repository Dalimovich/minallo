// Component integration with real modules/CSS and deterministic storage/indexing responses.
// Run after npm run build:frontend, with the frontend server running on E2E_BASE_URL.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const base = process.env.E2E_BASE_URL || 'http://localhost:5177';
const practice = ts.createSourceFile('practice.js', fs.readFileSync('frontend/views/practice/practice.js', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['rdRenderFilesPanel', 'gmRenderFilesPanel', 'vcRenderFilesPanel'];
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(practice));
  ts.forEachChild(node, visit);
}
visit(practice);
assert.equal(functions.length, names.length);
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const stored = new Map([
      ['german-files', [{ name: 'grammar.pdf', _storageName: 'grammar.pdf' }]],
      ['german-reading', [{ name: 'telc.pdf', _storageName: 'telc.pdf' }]],
    ]);
    const docs = new Map([
      ['german-files', [{ id: 'canonical', file_name: 'grammar.pdf', storage_path: 'course-uploads:fixture-user/german-files/grammar.pdf', processing_status: 'ready' }]],
      ['german-reading', [{ id: 'legacy', file_name: 'telc.pdf', storage_path: 'course-uploads:fixture-user/german-reading/telc.pdf', processing_status: 'ready' }]],
    ]);
    let ready = false;
    let failIndexOnce = true;
    await page.route('**/__learner-files-test', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/views/chatbot/chatbot.css"></head><body class="night" style="background:#111827"><main style="max-width:520px;margin:20px auto;padding:12px"><section class="ncb-library-panel" data-library-panel="files" style="display:block"></section><div id="glReadingFilesPanel"></div><div id="glGramFiles"></div><div id="glVocabFiles"></div></main></body></html>',
    }));
    await page.route('**/api/documents/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/list')) {
        const rows = docs.get(url.searchParams.get('courseId')) || [];
        await route.fulfill({ json: { documents: rows.map(doc => ({ ...doc, processing_status: doc.id.startsWith('new-') ? (ready ? 'ready' : 'uploaded') : doc.processing_status })) } });
      } else if (url.pathname.endsWith('/index-existing')) {
        const data = request.postDataJSON();
        assert.ok(data.fileName.endsWith('.pdf'), 'the existing backend only indexes PDFs');
        if (data.fileName === 'index-retry.pdf' && failIndexOnce) {
          failIndexOnce = false;
          await route.fulfill({ status: 502, json: { processingStatus: 'failed', indexingStarted: false, error: 'Indexing failed' } });
          return;
        }
        const id = 'new-' + data.storageName;
        docs.set(data.courseId, [...(docs.get(data.courseId) || []).filter(doc => doc.id !== id), {
          id, file_name: data.fileName, storage_path: `course-uploads:fixture-user/${data.courseId}/${data.storageName}`, processing_status: 'uploaded',
        }]);
        await route.fulfill({ json: { documentId: id, processingStatus: 'uploaded', indexingStarted: true } });
      } else if (url.pathname.endsWith('/delete')) {
        await route.fulfill({ json: { ok: true } });
      } else throw new Error('Unexpected endpoint: ' + url.pathname);
    });
    await page.exposeFunction('fixtureList', scope => stored.get(scope) || []);
    await page.exposeFunction('fixtureUpload', (scope, name) => {
      assert.equal(scope, 'german-files');
      stored.set(scope, [...(stored.get(scope) || []), { name, _storageName: name.replaceAll(' ', '_') }]);
    });
    await page.route('https://storage.invalid/storage/v1/object/course-uploads', async route => {
      const path = route.request().postDataJSON().prefixes[0];
      const [, scope, name] = path.split('/');
      stored.set(scope, (stored.get(scope) || []).filter(file => file._storageName !== name));
      await route.fulfill({ json: [] });
    });
    await page.goto(base + '/__learner-files-test');
    await page.evaluate(async () => {
      window._currentUser = { id: 'fixture-user' };
      window.SUPA_URL = 'https://storage.invalid';
      window._sbToken = 'fixture.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + '.fixture';
      window.activeCourseId = 'student-course';
      window.activeCourseRef = { id: 'student-course' };
      window.SEMS = { one: { courses: [{ id: 'student-course' }] } };
      window._ufSanitizeName = name => name.replaceAll(' ', '_');
      window._ufFetchBytes = async (_uid, scope, name) => {
        window.lastFileRead = { scope: scope.id, name };
        return new TextEncoder().encode('Deutsch lernen.');
      };
      window._ssValidateUploadFile = (file, options) => {
        if (file.size > options.maxBytes) throw Error('Too large');
        if (!/\.(pdf|txt|docx|png|jpe?g)$/.test(file.name)) throw Error('Unsupported');
      };
      window.listingWait = new Promise(resolve => { window.releaseListing = resolve; });
      window._ufMerge = async scope => {
        const files = await window.fixtureList(scope.id);
        await window.listingWait;
        scope.files = files;
      };
      window.uploadWait = new Promise(resolve => { window.releaseUpload = resolve; });
      window.failOnce = true;
      window._ufUpload = async (_uid, scope, file) => {
        await window.uploadWait;
        if (file.name === 'retry.txt' && window.failOnce) { window.failOnce = false; throw Error('Temporary upload failure'); }
        await window.fixtureUpload(scope.id, file.name);
      };
      window.showToast = () => {};
      window.libraryModule = await import('/js/features/chatbot-new/workspace-library.js');
      window.learnerModule = await import('/js/features/german/learner-files.js');
      window.renderPromise = window.libraryModule.renderLearnerFiles(document.querySelector('[data-library-panel="files"]'));
    });
    const panel = page.locator('[data-library-panel="files"]');
    assert.equal(await panel.getByRole('button', { name: 'Upload file', exact: true }).isVisible(), true);
    assert.equal(await panel.getByText('Drop files here to upload').isVisible(), true);
    assert.ok((await panel.locator('.ncb-root-drop').boundingBox()).height >= 200);
    const chooser = page.waitForEvent('filechooser');
    await panel.getByRole('button', { name: 'Upload file', exact: true }).click();
    await (await chooser).setFiles({ name: 'new-notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') });
    assert.equal(await panel.locator('.ncb-file-row--pending').count(), 1);
    await page.evaluate(async () => { window.releaseListing(); await window.renderPromise; });
    assert.equal(await panel.locator('.ncb-file-row--pending').count(), 1, 'late listing must not remove an upload');
    await page.evaluate(() => window.releaseUpload());
    await panel.locator('.ncb-file-row--pending').getByText('Indexing', { exact: true }).first().waitFor();
    assert.equal(await panel.locator('.ncb-file-row--pending').getByText('Indexed', { exact: true }).count(), 0);
    ready = true;
    await panel.locator('.study-file-card').filter({ hasText: 'new-notes.pdf' }).waitFor();
    assert.equal(await panel.locator('.study-file-card').count(), 3);

    await panel.locator('.ncb-root-drop').evaluate(element => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['Deutsch'], 'retry.txt', { type: 'text/plain' }));
      dataTransfer.items.add(new File(['Deutsch'], 'sibling.txt', { type: 'text/plain' }));
      element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
      if (!element.classList.contains('is-drag-target')) throw Error('Missing drag highlight');
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    const failed = panel.locator('.ncb-file-row--pending').filter({ hasText: 'retry.txt' });
    await failed.getByRole('button', { name: 'Retry' }).waitFor();
    assert.equal(await failed.getByText('Upload failed', { exact: true }).count(), 2);
    await panel.locator('.study-file-card').filter({ hasText: 'sibling.txt' }).waitFor();
    await failed.getByRole('button', { name: 'Retry' }).click();
    await panel.locator('.study-file-card').filter({ hasText: 'retry.txt' }).waitFor();
    await panel.locator('input[type="file"]').setInputFiles({ name: 'index-retry.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') });
    const indexFailure = panel.locator('.ncb-file-row--pending').filter({ hasText: 'index-retry.pdf' });
    await indexFailure.getByRole('button', { name: 'Retry' }).waitFor();
    assert.equal(await indexFailure.getByText('Indexing failed', { exact: true }).count(), 2);
    await indexFailure.getByRole('button', { name: 'Retry' }).click();
    await panel.locator('.study-file-card').filter({ hasText: 'index-retry.pdf' }).waitFor();
    await page.evaluate(async () => {
      await window.libraryModule.renderLearnerFiles(document.querySelector('[data-library-panel="files"]'), true);
    });
    assert.equal(await panel.locator('.study-file-card').count(), 6, 'uploaded files survive a fresh panel load');

    await page.addScriptTag({ content: `
      var _currentUser = window._currentUser;
      function _glLearnerFiles() { return Promise.resolve(window.learnerModule); }
      function _glEscape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'); }
      var rdEl = id => document.getElementById(id), gmEl = rdEl, vcEl = rdEl;
      ${functions.join('\n')}
    ` });
    await page.evaluate(async () => { await rdRenderFilesPanel(true); await gmRenderFilesPanel(); await vcRenderFilesPanel(); });
    for (const name of ['glReadingFile', 'glGramFile', 'glVocabFile']) {
      assert.equal(await page.locator(`input[name="${name}"]`).count(), 6);
      const values = await page.locator(`input[name="${name}"]`).evaluateAll(inputs => inputs.map(input => input.value));
      assert.ok(values.includes('canonical') && values.includes('legacy') && values.includes('new-new-notes.pdf'));
    }
    assert.equal(await page.evaluate(() => window.activeCourseId), 'student-course');
    assert.equal(await page.evaluate(() => window.SEMS.one.courses.length), 1);
    const popupPromise = page.waitForEvent('popup');
    await panel.locator('.study-file-card').filter({ hasText: 'retry.txt' }).getByRole('button', { name: 'Open', exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForURL('blob:**');
    assert.deepEqual(await page.evaluate(() => window.lastFileRead), { scope: 'german-files', name: 'retry.txt' });
    await popup.close();
    page.once('dialog', dialog => dialog.accept());
    await panel.locator('.study-file-card').filter({ hasText: 'telc.pdf' }).getByRole('button', { name: 'Delete telc.pdf' }).click();
    await panel.locator('.study-file-card').filter({ hasText: 'telc.pdf' }).waitFor({ state: 'detached' });
    await page.evaluate(async () => {
      await window.libraryModule.renderLearnerFiles(document.querySelector('[data-library-panel="files"]'), true);
    });
    assert.equal(await panel.locator('.study-file-card').count(), 5);
    assert.equal(await page.evaluate(() => window.activeCourseId), 'student-course');
    await page.evaluate(() => {
      for (const id of ['glReadingFilesPanel', 'glGramFiles', 'glVocabFiles']) document.getElementById(id).hidden = true;
    });
    await page.screenshot({ path: `test-results/learner-files-${viewport.width}.png`, fullPage: true });
    stored.clear();
    await page.evaluate(async () => {
      await window.libraryModule.renderLearnerFiles(document.querySelector('[data-library-panel="files"]'), true);
    });
    assert.equal(await panel.getByText('No German files yet.', { exact: false }).isVisible(), true);
    assert.equal(await panel.getByRole('button', { name: 'Upload file', exact: true }).isVisible(), true);
    assert.equal(await panel.getByText('Drop files here to upload').isVisible(), true);
    assert.ok((await panel.locator('.ncb-root-drop').boundingBox()).height >= 200);
    await page.screenshot({ path: `test-results/learner-files-empty-${viewport.width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Learner Files and three Practice selectors: passed at ${viewport.width}px`);
  }
} finally {
  await browser.close();
}
