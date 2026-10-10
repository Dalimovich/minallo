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

// ── profile.js save: server first, then runtime, then cache ────────────────

test('profile.js saveProfile persists german_test + german_level + exam profile id together', () => {
  assert.match(PROFILE_JS, /data\.german_test\s*=\s*test/, 'saveProfile must write german_test');
  assert.match(PROFILE_JS, /data\.german_level\s*=\s*level/, 'saveProfile must write german_level');
  assert.match(PROFILE_JS, /data\.german_exam_profile_id\s*=/, 'saveProfile must re-resolve german_exam_profile_id');
});

test('profile.js saveProfile applies the real saved row via _applySavedProfile (no partial data, no direct global writes)', () => {
  assert.match(PROFILE_JS, /\.select\('\*'\)\.eq\('id',\s*_currentUser\.id\)\.single\(\)/, 'saveProfile must read the saved row back');
  assert.match(PROFILE_JS, /window\._applySavedProfile\(saved\)/, 'saveProfile must apply the saved server row');
  assert.doesNotMatch(PROFILE_JS, /window\._germanLevel\s*=/, 'saveProfile must not write runtime globals directly');
  assert.doesNotMatch(PROFILE_JS, /localStorage\.setItem\('ss_german_level_/, 'saveProfile must not write the german level cache itself');
});

test('profile.js compat retry never drops german_test / german_level', () => {
  assert.doesNotMatch(PROFILE_JS, /delete\s+_fb\.german_(test|level)/);
  assert.doesNotMatch(PROFILE_JS, /delete\s+_fb\.user_type/);
});

// ── loadUserData dedup must not commit before a real fetch can start ───────

test('loadUserData does not commit the dedup window before window._sb is confirmed ready', () => {
  const fnStart = USER_DATA_TS.indexOf('async function runLoadUserData');
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
