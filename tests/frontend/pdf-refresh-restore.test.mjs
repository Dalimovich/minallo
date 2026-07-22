import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const AUTH = read('frontend/js/supabase.js');
const DATA = read('frontend/js/app-data.js');

test('refreshing an open PDF primes the viewer instead of showing Courses', () => {
  assert.match(AUTH, /_resumePdfImmediately/);
  assert.match(AUTH, /selectTopLevelView\(['"]file['"]\)/);
  assert.match(AUTH, /Reopening PDF/);
  assert.match(
    AUTH,
    /if \(_resumePdfImmediately\)[\s\S]*?else if \(typeof showPortalSection/,
    'course dashboard navigation must be skipped while restoring a PDF'
  );
  const cachedOpen = AUTH.indexOf('_ssOpenCachedRestoredPdf(_savedSt.courseId, _savedSt.fileName)');
  const userDataLoad = AUTH.indexOf('loadUserData(user.id)');
  assert.ok(cachedOpen >= 0, 'cached PDF restore is invoked during page refresh');
  assert.ok(userDataLoad >= 0, 'normal user data loading still runs');
  assert.ok(cachedOpen < userDataLoad, 'the PDF restore starts before remote user data loading');
});

test('cached PDF opens before the storage listing refresh completes', () => {
  const cacheOpen = DATA.indexOf('var _prcOpenedFromCache =');
  const networkMerge = DATA.indexOf('Promise.race([_ufMerge(_prcCourse), _restoreTimeout])');
  assert.ok(cacheOpen >= 0, 'cached restore path is present');
  assert.ok(networkMerge >= 0, 'background storage refresh is present');
  assert.ok(cacheOpen < networkMerge, 'cached open must begin before waiting for storage refresh');
  assert.match(DATA, /_fastFile\.storageName/);
  assert.match(DATA, /window\._ssOpenCachedRestoredPdf = function/);
});
