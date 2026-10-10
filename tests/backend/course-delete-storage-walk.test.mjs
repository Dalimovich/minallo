import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../backend/functions/course-delete.ts', import.meta.url), 'utf8');

// Regression coverage for a real production 502: Cloudflare's own generic
// error page (not this app's JSON error shape), reproduced on `/api/course-delete`
// for a course with enough folders/files. The storage tree walk recursed into
// every subfolder sequentially with no bound on request count or elapsed
// time, so a wide/deep enough tree could exceed the platform's own Worker
// limits and get the isolate hard-killed before any of this function's own
// error handling — including its top-level try/catch — ever ran.

test('storage tree walk lists sibling folders concurrently, not one at a time', () => {
  assert.match(source, /const results = await Promise\.all\(\s*folderPaths\.map\(\(folderPath\) => listStorageTree\(bucket, folderPath, key, output, budget\)\)\s*\)/);
  // The old sequential shape must be gone, not just supplemented.
  assert.doesNotMatch(source, /if \(!await listStorageTree\(bucket, objectPath \+ '\/', key, output\)\) return false;/);
});

test('storage tree walk enforces a request-count and wall-clock budget', () => {
  assert.match(source, /const STORAGE_ENUM_MAX_REQUESTS = \d+/);
  assert.match(source, /const STORAGE_ENUM_DEADLINE_MS = \d+/);
  assert.match(source, /if \(budget\.requestsLeft <= 0 \|\| Date\.now\(\) > budget\.deadline\) return 'partial'/);
  assert.match(source, /budget\.requestsLeft -= 1/);
});

test('the request budget leaves real margin under Cloudflare\'s free-tier 50 external-subrequest cap', () => {
  // This handler makes ~10 subrequests OUTSIDE the walk on the authoritative
  // path (token verify, documents enumeration, the storage bulk-delete, the
  // documents bulk-delete, and up to 6 parallel cleanup-table deletes). An
  // earlier version of this cap (120) was still comfortably above the
  // platform's 50/invocation ceiling on that tier and never actually
  // prevented the Worker kill it was meant to prevent. If this number ever
  // gets raised again, it must be re-derived against that same ceiling, not
  // picked to "feel generous."
  const match = source.match(/const STORAGE_ENUM_MAX_REQUESTS = (\d+)/);
  assert.ok(match, 'STORAGE_ENUM_MAX_REQUESTS constant not found');
  const NON_WALK_SUBREQUESTS = 10;
  const FREE_TIER_EXTERNAL_SUBREQUEST_LIMIT = 50;
  const budget = Number(match[1]);
  assert.ok(
    budget + NON_WALK_SUBREQUESTS < FREE_TIER_EXTERNAL_SUBREQUEST_LIMIT,
    `STORAGE_ENUM_MAX_REQUESTS (${budget}) + ~${NON_WALK_SUBREQUESTS} other handler subrequests must stay ` +
    `under Cloudflare's ${FREE_TIER_EXTERNAL_SUBREQUEST_LIMIT}/invocation free-tier limit`
  );
});

test('a genuine Supabase Storage API failure still hard-fails the request', () => {
  assert.match(source, /if \(!response\.ok\) return 'failed'/);
  assert.match(source, /if \(results\.includes\('failed'\)\) return 'failed'/);
  assert.match(source, /if \(storageEnum === 'failed'\) return fail\(502, 'COURSE_DELETE_STORAGE_ENUMERATION_FAILED'\)/);
});

test('hitting the budget degrades to deleting what was found, not a 502', () => {
  // 'partial' must reach the 200 response path, never the failure path.
  const enumCall = source.slice(source.indexOf('const storageEnum = await listStorageTree'));
  const failCheck = enumCall.slice(0, enumCall.indexOf('\n', enumCall.indexOf("if (storageEnum === 'failed')")));
  assert.doesNotMatch(failCheck, /'partial'/); // only 'failed' triggers fail(), not 'partial'
  assert.match(source, /const storageEnumerationIncomplete = storageEnum === 'partial'/);
  assert.match(source, /storageEnumerationIncomplete\s*\n\s*\}\);/); // present in the 200 jsonResponse payload
  assert.match(source, /console\.warn\('course_delete_storage_enumeration_incomplete'/);
});

test('the whole handler body is still wrapped so an unexpected exception returns JSON, not a raw crash', () => {
  assert.match(source, /catch \(error\) \{\s*console\.error\('course_delete_failed'/);
  assert.match(source, /return fail\(502, 'COURSE_DELETE_INTERNAL_FAILURE'\)/);
});
