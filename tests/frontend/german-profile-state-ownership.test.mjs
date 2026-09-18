// Source-level contract tests for German Exam Engine profile-state ownership.
//
// window._userType / _germanTest / _germanLevel / _germanExamProfileId /
// _germanProfileLoaded must have exactly one writer: auth/user-data.ts's
// applyProfile(). We've now hit two separate regressions from other code
// touching these:
//   - music-services.ts re-hydrated _userType/_germanTest/_germanLevel from
//     localStorage ~20s into boot, which could clobber values applyProfile()
//     had already set authoritatively moments earlier.
//   - profile.js's saveProfile() called applyProfile() with a partial object
//     (only the fields its form edits) as if it were a full authoritative
//     snapshot, which downgraded german_test/german_exam_profile_id to
//     "cleared" on every profile save.
// Both produced the same user-facing symptom: Sprachbausteine (and Lesen/
// Hören/Writing Coach, which read the same globals) showing "unsupported
// profile" for a learner whose profile does resolve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const USER_DATA_TS = read('frontend/js/features/auth/user-data.ts');
const MUSIC_SERVICES_TS = read('frontend/js/features/music/music-services.ts');
const PROFILE_JS = read('frontend/views/profile/profile.js');

const GERMAN_PROFILE_GLOBALS = [
  'window._userType',
  'window._germanTest',
  'window._germanLevel',
  'window._germanExamProfileId',
  'window._germanProfileLoaded',
];

function assertNoWrites(name, source) {
  for (const g of GERMAN_PROFILE_GLOBALS) {
    const escaped = g.replace(/[.[\]]/g, '\\$&');
    const writePattern = new RegExp(escaped + '\\s*=(?!=)');
    assert.doesNotMatch(
      source,
      writePattern,
      `${name} must not write ${g} — only auth/user-data.ts's applyProfile() may`
    );
  }
}

test('music-services.ts never writes any German profile global', () => {
  assertNoWrites('music-services.ts', MUSIC_SERVICES_TS);
});

test('user-data.ts is the sole writer of the German profile globals', () => {
  for (const g of GERMAN_PROFILE_GLOBALS) {
    const escaped = g.replace(/[.[\]]/g, '\\$&');
    const writePattern = new RegExp(escaped + '\\s*=(?!=)');
    assert.match(
      USER_DATA_TS,
      writePattern,
      `user-data.ts should still be the writer of ${g}`
    );
  }
});

// ── applyProfile must not let a partial object downgrade resolved state ────

test('applyProfile guards german_test/german_level/german_exam_profile_id with hasOwnProperty before overriding', () => {
  const hasOwnChecks = [
    "hasOwnProperty.call(p, 'user_type')",
    "hasOwnProperty.call(p, 'german_test')",
    "hasOwnProperty.call(p, 'german_level')",
    "hasOwnProperty.call(p, 'german_exam_profile_id')",
  ];
  for (const check of hasOwnChecks) {
    assert.ok(
      USER_DATA_TS.includes(check),
      `applyProfile must guard on ${check} so a partial object can't downgrade already-resolved state`
    );
  }
});

// ── profile.js save must not clobber the full profile cache with a partial ─

test('profile.js saveProfile merges onto the existing profile_cache_<uid> instead of overwriting it', () => {
  assert.match(
    PROFILE_JS,
    /Object\.assign\(\{\},\s*existingCache,\s*data\)/,
    'saveProfile must merge its partial `data` onto the existing full cache before writing profile_cache_<uid>'
  );
});

test('profile.js saveProfile calls applyProfile with the merged cache, not the raw partial data', () => {
  assert.match(
    PROFILE_JS,
    /window\.applyProfile\(mergedCache\)/,
    'saveProfile must pass the merged (full) object to applyProfile, not the bare partial `data`'
  );
});

// ── loadUserData dedup must not commit before a real fetch can start ───────

test('loadUserData does not commit the dedup window before window._sb is confirmed ready', () => {
  const fnStart = USER_DATA_TS.indexOf('export async function loadUserData');
  assert.ok(fnStart >= 0, 'loadUserData not found');
  const sbCheckIdx = USER_DATA_TS.indexOf('if (!sb) return;', fnStart);
  assert.ok(sbCheckIdx >= 0, 'loadUserData must still check window._sb readiness');
  const commitIdx = USER_DATA_TS.indexOf('_lastLoadUid = uid;', fnStart);
  assert.ok(commitIdx >= 0, '_lastLoadUid commit not found');
  assert.ok(
    commitIdx > sbCheckIdx,
    'the dedup commit (_lastLoadUid = uid) must happen AFTER the `if (!sb) return;` guard, ' +
    'so a call that bails out early because sb was not ready does not block the next real attempt for 30s'
  );
});
