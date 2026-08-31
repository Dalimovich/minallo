import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../backend/functions/folder-delete.ts', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../../scripts/generate-pages-shims.mjs', import.meta.url), 'utf8');
const courseDelete = fs.readFileSync(new URL('../../backend/functions/course-delete.ts', import.meta.url), 'utf8');
const pagesAdapter = fs.readFileSync(new URL('../../backend/lib/pages-adapter.ts', import.meta.url), 'utf8');
const supabaseAdmin = fs.readFileSync(new URL('../../backend/lib/supabase-admin.ts', import.meta.url), 'utf8');

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

test('course deletion recursively removes storage and database artifacts', () => {
  assert.match(courseDelete, /async function listStorageTree/);
  assert.match(courseDelete, /if \(entry\.id == null\)/);
  assert.match(courseDelete, /documents\?user_id=eq\.\$\{uid\}&course_id=eq\.\$\{cid\}/);
  assert.match(courseDelete, /COURSE_DELETE_DOCUMENTS_FAILED/);
  assert.match(courseDelete, /COURSE_DELETE_INTERNAL_FAILURE/);
  assert.match(courseDelete, /Promise\.all\(courseTables\.map/);
  assert.match(courseDelete, /const cleanupWarnings = cleanupResults/);
  assert.doesNotMatch(courseDelete, /COURSE_DELETE_RELATED_DATA_FAILED/);
});

test('an uncaught exception anywhere in a Pages Function handler cannot surface as Cloudflare\'s generic Error 1101 crash page', () => {
  // requireEnv() throwing (missing env var), or a fetch() promise rejecting
  // with no local catch, used to propagate straight out of pagesAdapter's
  // handler invocation. Cloudflare then returns its own opaque HTML crash
  // page instead of any JSON error body — invisible to the frontend and to
  // anyone without direct Workers log access. Three layers must all hold:
  // the adapter itself, the shared Supabase REST helper, and folder-delete's
  // own direct Storage fetch call (which does not go through supaRequest).
  assert.match(pagesAdapter, /try\s*\{\s*const result = await handler\(event, \{\} as NetlifyContext\);/);
  assert.match(pagesAdapter, /catch \(raw: unknown\) \{/);
  assert.match(supabaseAdmin, /catch \(err: unknown\) \{[\s\S]{0,1200}return \{ status: 0, body:/);
  assert.match(source, /async function storageRequest\(/);
  assert.match(source, /try \{\s*return await fetch\(supabaseUrl \+ path/);
  assert.match(source, /catch \(err: unknown\) \{[\s\S]{0,700}status: 502/);
});
