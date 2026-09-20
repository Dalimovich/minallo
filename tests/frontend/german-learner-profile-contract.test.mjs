// End-to-end German learner-level contract (frontend half).
//
// profiles.german_test + profiles.german_level are the single source of truth.
// Onboarding creates them, Profile edits them, and every German surface reads
// them through getGermanLearnerProfile() — no hard-coded B2, no localStorage
// value overriding a newer server value, no dropped identity fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const profileMod = await import('../../frontend/js/features/auth/german-profile.ts');
const {
  GERMAN_TEST_LEVELS,
  getGermanLearnerProfile,
  germanLevelOptionsHtml,
  isValidGermanTestLevel,
  populateGermanLevelSelect,
  resolveGermanExamProfileIdClient,
} = profileMod;

function setWindow(w) {
  globalThis.window = w;
}

// ── accessor ────────────────────────────────────────────────────────────────

test('accessor: loading and error states never expose a guessed level', () => {
  setWindow({ _profileResolutionState: 'loading', _userType: 'learner', _germanTest: 'telc', _germanLevel: 'B2' });
  assert.equal(getGermanLearnerProfile().state, 'loading');
  assert.equal(getGermanLearnerProfile().targetLevel, '', 'a stale/cached level must not leak while loading');
  setWindow({ _profileResolutionState: 'error', _userType: 'learner', _germanTest: 'telc', _germanLevel: 'B2' });
  assert.equal(getGermanLearnerProfile().state, 'error');
  assert.equal(getGermanLearnerProfile().targetLevel, '');
});

test('accessor: ready learner exposes exact test + level and derives the exam profile id', () => {
  setWindow({
    _profileResolutionState: 'ready', _userType: 'learner',
    _germanTest: 'telc', _germanLevel: 'C1 Hochschule', _germanExamProfileId: null,
  });
  const p = getGermanLearnerProfile();
  assert.equal(p.state, 'ready');
  assert.equal(p.testFamily, 'telc');
  assert.equal(p.targetLevel, 'C1 Hochschule');
  // A missing runtime id must not produce a false "unsupported profile".
  assert.equal(p.examProfileId, 'telc_c1_hochschule');
});

test('accessor: telc B2 has no exam profile id and that is not an error', () => {
  setWindow({
    _profileResolutionState: 'ready', _userType: 'learner',
    _germanTest: 'telc', _germanLevel: 'B2', _germanExamProfileId: null,
  });
  const p = getGermanLearnerProfile();
  assert.equal(p.state, 'ready');
  assert.equal(p.examProfileId, null);
  assert.equal(p.targetLevel, 'B2');
});

test('accessor: exam-specific levels are kept verbatim (never coerced to CEFR)', () => {
  for (const [family, level] of [['TestDaF', 'TDN 4'], ['DSH', 'DSH-2'], ['DSD', 'DSD II (C1)']]) {
    setWindow({ _profileResolutionState: 'ready', _userType: 'learner', _germanTest: family, _germanLevel: level });
    assert.equal(getGermanLearnerProfile().targetLevel, level);
    assert.equal(getGermanLearnerProfile().testFamily, family);
  }
});

// ── catalog / exam-id ───────────────────────────────────────────────────────

test('catalog: every level is valid only for its own test family', () => {
  for (const [family, levels] of Object.entries(GERMAN_TEST_LEVELS)) {
    for (const l of levels) assert.ok(isValidGermanTestLevel(family, l), `${family}/${l}`);
  }
  assert.equal(isValidGermanTestLevel('telc', 'TDN 4'), false);
  assert.equal(isValidGermanTestLevel('', 'B2'), false);
});

test('exam profile id: telc + C1 Hochschule resolves, telc + B2 does not', () => {
  assert.equal(resolveGermanExamProfileIdClient('telc', 'C1 Hochschule'), 'telc_c1_hochschule');
  assert.equal(resolveGermanExamProfileIdClient('TELC', 'C1 Hochschule'), 'telc_c1_hochschule');
  assert.equal(resolveGermanExamProfileIdClient('Goethe', 'C1'), 'goethe_c1');
  assert.equal(resolveGermanExamProfileIdClient('goethe', 'C1'), 'goethe_c1');
  for (const level of ['B1', 'B2', 'C2']) assert.equal(resolveGermanExamProfileIdClient('Goethe', level), null);
  assert.equal(resolveGermanExamProfileIdClient('telc', 'C1'), null);
  assert.equal(resolveGermanExamProfileIdClient('telc', 'B2'), null);
  assert.equal(resolveGermanExamProfileIdClient('', ''), null);
});

// ── level selects ───────────────────────────────────────────────────────────

test('practice level options: profile level is first and selected, never B2 by default', () => {
  setWindow({
    _profileResolutionState: 'ready', _userType: 'learner',
    _germanTest: 'telc', _germanLevel: 'C1 Hochschule',
  });
  const html = germanLevelOptionsHtml();
  assert.match(html, /^<option value="C1 Hochschule" selected>C1 Hochschule<\/option>/);
  assert.equal((html.match(/ selected/g) || []).length, 1);
  assert.doesNotMatch(html, /value="B2" selected/);
});

test('practice level options: profile not ready gives a neutral placeholder, no level invented', () => {
  setWindow({ _profileResolutionState: 'loading' });
  assert.doesNotMatch(germanLevelOptionsHtml(), /B2|C1|A1/);
});

test('populateGermanLevelSelect: repopulates for the chosen test and keeps a legacy stored level visible', () => {
  const sel = { innerHTML: '', value: '', getAttribute: () => null };
  populateGermanLevelSelect(sel, 'TestDaF', 'TDN 4');
  assert.match(sel.innerHTML, /TDN 3/);
  assert.doesNotMatch(sel.innerHTML, /value="B2"/);
  assert.equal(sel.value, 'TDN 4');
  populateGermanLevelSelect(sel, 'TestDaF', 'B2'); // legacy mismatch stays visible
  assert.match(sel.innerHTML, /value="B2"/);
  assert.equal(sel.value, 'B2');
});

// ── source-level guards ─────────────────────────────────────────────────────

test('onboarding: identity fields are never dropped by the compat fallback', () => {
  const src = read('frontend/js/features/auth/onboarding.ts');
  assert.doesNotMatch(src, /delete\s+fallback\.(german_test|german_level|user_type)/);
  const m = src.match(/OB_OPTIONAL_COMPAT_FIELDS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'optional-field list must exist');
  assert.doesNotMatch(m[1], /user_type|german_test|german_level/);
});

test('onboarding: ob_done is only set after the saved profile is applied; no pre-save localStorage', () => {
  const src = read('frontend/js/features/auth/onboarding.ts');
  const applyIdx = src.indexOf('applySavedProfile(saved.row');
  const doneIdx = src.indexOf("localStorage.setItem('ob_done_'");
  assert.ok(applyIdx > 0 && doneIdx > applyIdx, 'ob_done must follow applySavedProfile');
  assert.doesNotMatch(src, /localStorage\.setItem\('ss_german_(test|level)_/);
  assert.match(src, /german_exam_profile_id:\s*resolveGermanExamProfileIdClient\(_obTest,\s*_obLevel\)/);
});

test('onboarding and profile share ONE level catalog (no local lists)', () => {
  assert.doesNotMatch(read('frontend/js/features/auth/onboarding.ts'), /_obTestLevels/);
  assert.doesNotMatch(read('frontend/views/profile/profile.html'), /<optgroup/,
    'profile level select must be filled from the shared catalog');
});

test('applyProfile: an authoritative row never back-fills level/test from old localStorage', () => {
  const src = read('frontend/js/features/auth/user-data.ts');
  assert.match(src, /authoritative \? '' : localStorage\.getItem/);
});

test('practice.js: no hard-coded B2 learner level (static sample labels excepted)', () => {
  const src = read('frontend/views/practice/practice.js');
  const offenders = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) =>
    /level:\s*'B2'|\|\|\s*'B2'|selected>B2|:\s*'B2';/.test(l) && !/meta:\s*\{ title:/.test(l));
  assert.deepEqual(offenders, [], 'hard-coded B2 defaults must come from the profile accessor');
  assert.doesNotMatch(read('frontend/views/practice/practice.html'), /value="B2" selected/);
});

test('Writing Coach reads the level through the accessor', () => {
  const src = read('frontend/js/features/writing-coach/writing-coach.ts');
  assert.match(src, /getGermanLearnerProfile\(\)\.targetLevel/);
});

test('applyProfile: a cache-sourced apply cannot override an already-authoritative runtime profile', () => {
  const src = read('frontend/js/features/auth/user-data.ts');
  const guard = src.search(/!authoritative\s*&&\s*window\._profileResolutionState === 'ready'/);
  const writer = src.indexOf('window._germanLevel = hasGermanLevel');
  assert.ok(guard > 0 && writer > guard, 'guard must run before the german globals are written');
});
