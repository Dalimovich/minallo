import test from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { chromium } from '@playwright/test';

// Drives the REAL renderLearnerFiles() (bundled from workspace-library.ts) in
// real Chromium. Only the learner-files module is stubbed, with promises the
// test resolves by hand, so canonical-vs-legacy ordering is fully controlled.

const stub = `
const c = () => window.__lf;
export const getLegacyLearnerScopes = () => ['german-reading', 'german-grammar'];
export const listCanonicalLearnerFiles = (o) => c().scope('german-files', o);
export const listLearnerFilesForScope = (id, o) => c().scope(id, o);
export function dedupeLearnerFiles(files) {
  const s = new Set();
  return files.filter((f) => { if (s.has(f.id)) return false; s.add(f.id); return true; });
}
export const getLearnerFileStorageScope = () => ({ id: 'german-files' });
export const uploadLearnerFile = (f) => c().upload(f);
export const indexLearnerFile = async (f) => f;
export const refreshLearnerFile = async (f) => f;
export const deleteLearnerFile = async () => {};
export const openLearnerFile = async () => {};
`;

async function bundle() {
  const result = await esbuild.build({
    entryPoints: ['frontend/js/features/chatbot-new/workspace-library.ts'],
    bundle: true, format: 'iife', globalName: '__wl', platform: 'browser', write: false, logLevel: 'silent',
    plugins: [{
      name: 'stub-learner-files',
      setup(build) {
        build.onResolve({ filter: /german\/learner-files\.js$/ }, () => ({ path: 'learner-files-stub', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js' }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

async function withPage(fn) {
  const code = await bundle();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body><div id="panel"></div></body>');
    await page.addScriptTag({ content: code });
    await page.evaluate(() => {
      window._currentUser = { id: 'user-a' };
      const pending = {};
      window.__pending = pending;
      window.__lf = {
        scope: (id) => new Promise((resolve, reject) => { pending[id] = { resolve, reject }; }),
        upload: () => new Promise(() => {}),
      };
      window.__file = (id, name, scope = 'german-files') => ({
        id, documentId: id, documentName: name, learnerFileScope: scope, name,
        _storageName: name, _folder: null, _uid: 'user-a', _uploaded: true, size: '134 KB',
        _document: { id, file_name: name, processing_status: 'ready' },
      });
      window.__start = () => { window.__done = window.__wl.renderLearnerFiles(document.getElementById('panel')); };
      window.__names = () => Array.from(document.querySelectorAll('#panel .ncb-file-row strong')).map((e) => e.textContent);
      window.__text = () => document.getElementById('panel').textContent;
    });
    await fn(page);
  } finally {
    await browser.close();
  }
}
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
const resolveScope = (page, id, files) => page.evaluate(([i, f]) => window.__pending[i].resolve(f), [id, files]);

test('A: Upload, drop zone and the loading state exist before any file request resolves', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__start());
    const t = await page.evaluate(() => window.__text());
    assert.match(t, /Upload file/);
    assert.match(t, /Drop files here to upload/);
    assert.match(t, /Loading your files/);
    assert.equal(await page.locator('.ncb-files-loading[aria-busy="true"]').count(), 1);
    assert.equal(await page.locator('.ncb-file-skeleton').count(), 1);
    assert.equal(await page.locator('.ncb-course-upload').isEnabled(), true);
  });
});

test('B/C/D: canonical file shows at once while legacy is pending; legacy merges without disturbing it', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__start());
    await resolveScope(page, 'german-files', await page.evaluate(() => [window.__file('c1', 'Training_Kurvendiskussion.pdf')]));
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__names()), ['Training_Kurvendiskussion.pdf']);
    assert.match(await page.evaluate(() => window.__text()), /Loading older files/);
    assert.doesNotMatch(await page.evaluate(() => window.__text()), /Loading your files/);
    assert.equal(await page.locator('.ncb-file-skeleton').count(), 0);
    const timing = await page.evaluate(() => window.__learnerFilesTiming);
    assert.equal(typeof timing.firstFileVisibleMs, 'number');
    assert.equal(timing.allFilesCompleteMs, null, 'not complete while legacy is pending');

    await page.evaluate(() => { window.__firstRow = document.querySelector('#panel .ncb-file-row'); });
    await resolveScope(page, 'german-reading', await page.evaluate(() => [window.__file('l1', 'legacy.pdf', 'german-reading'), window.__file('c1', 'Training_Kurvendiskussion.pdf', 'german-reading')]));
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__names()), ['Training_Kurvendiskussion.pdf', 'legacy.pdf'], 'legacy appended, duplicate id not shown twice');
    assert.equal(await page.evaluate(() => window.__firstRow === document.querySelector('#panel .ncb-file-row')), true, 'canonical card node is untouched');
    await resolveScope(page, 'german-grammar', []);
    await settle(page);
    assert.doesNotMatch(await page.evaluate(() => window.__text()), /Loading older files/);
    assert.equal(typeof (await page.evaluate(() => window.__learnerFilesTiming.allFilesCompleteMs)), 'number');
  });
});

test('E/F: no empty state while legacy loads; final empty state only after everything completes', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__start());
    await resolveScope(page, 'german-files', []);
    await settle(page);
    let t = await page.evaluate(() => window.__text());
    assert.doesNotMatch(t, /No German files yet/);
    assert.match(t, /Loading older files/);
    await resolveScope(page, 'german-reading', []);
    await settle(page);
    assert.doesNotMatch(await page.evaluate(() => window.__text()), /No German files yet/);
    await resolveScope(page, 'german-grammar', []);
    await settle(page);
    t = await page.evaluate(() => window.__text());
    assert.match(t, /No German files yet/);
    assert.doesNotMatch(t, /Loading/);
  });
});

test('G: a pending upload row survives canonical and legacy reconciliation', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__start());
    await page.setInputFiles('.ncb-course-upload-input', { name: 'fresh.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await settle(page);
    assert.equal(await page.locator('.ncb-file-row--pending').count(), 1);
    await resolveScope(page, 'german-files', await page.evaluate(() => [window.__file('c1', 'old.pdf')]));
    await settle(page);
    await resolveScope(page, 'german-reading', []);
    await resolveScope(page, 'german-grammar', []);
    await settle(page);
    assert.equal(await page.locator('.ncb-file-row--pending').count(), 1, 'pending row must survive');
    assert.deepEqual(await page.evaluate(() => window.__names()), ['old.pdf', 'fresh.pdf']);
  });
});

test('H: canonical failure keeps recovered legacy files and shows a visible Retry', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__start());
    await page.evaluate(() => window.__pending['german-files'].reject(new Error('boom')));
    await settle(page);
    await resolveScope(page, 'german-reading', await page.evaluate(() => [window.__file('l1', 'legacy.pdf', 'german-reading')]));
    await resolveScope(page, 'german-grammar', []);
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__names()), ['legacy.pdf']);
    assert.equal(await page.locator('.ncb-library-retry').isVisible(), true);
    assert.match(await page.evaluate(() => window.__text()), /Couldn’t load your files/);
    await page.click('.ncb-library-retry');
    await settle(page);
    assert.match(await page.evaluate(() => window.__text()), /Loading your files/);
  });
});

test('I: results for a previous account never render after an account switch', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => window.__start());
    await page.evaluate(() => { window._currentUser = { id: 'user-b' }; });
    await resolveScope(page, 'german-files', await page.evaluate(() => [window.__file('c1', 'user-a-secret.pdf')]));
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.__names()), []);
  });
});
