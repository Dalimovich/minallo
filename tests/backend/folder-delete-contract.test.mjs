import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../backend/functions/folder-delete.ts', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../../scripts/generate-pages-shims.mjs', import.meta.url), 'utf8');

test('folder deletion is authenticated and owner/course scoped', () => {
  assert.match(source, /verifySupabaseToken/);
  assert.match(source, /documents\?user_id=eq\.\$\{uid\}&course_id=eq\.\$\{cid\}/);
  assert.match(source, /document\.storage_path\.startsWith\(durablePrefix\)/);
  assert.match(source, /documents\?id=eq\.\$\{encodeURIComponent\(document\.id\)\}&user_id=eq\.\$\{uid\}&course_id=eq\.\$\{cid\}/);
});

test('folder deletion removes storage, documents, and retrieval cache', () => {
  assert.match(source, /storage\/v1\/object\/list/);
  assert.match(source, /storage\/v1\/object\/bulk/);
  assert.match(source, /for \(let offset = 0; ; offset \+= pageSize\)/);
  assert.match(source, /'DELETE'/);
  assert.match(source, /retrieval_cache\?user_id=eq\.\$\{uid\}&course_id=eq\.\$\{cid\}/);
});

test('Cloudflare generator publishes folder and course deletion routes', () => {
  assert.match(routes, /\['folder-delete',\s+'folder-delete'\]/);
  assert.match(routes, /\['course-delete',\s+'course-delete'\]/);
});
