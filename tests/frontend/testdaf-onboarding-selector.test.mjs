// Explicit digital-TestDaF selector: onboarding + Profile-edit.
//
// TestDaF's TDN level (3/4/5) cannot distinguish digital from paper-based
// delivery, and paper-based has no implemented profile. This selector lets a
// user pick delivery mode explicitly; "digital" passes 'testdaf_digital' as
// the resolveGermanExamProfileIdClient() savedProfileId override (explicit
// override wins — see german-profile.ts), "paper-based" (or no explicit
// choice, for backward compatibility) preserves today's null result.
//
// This repo has no DOM testing library (see notes-file-chooser.test.mjs), so
// the DOM-driven onboarding/profile wiring is verified at the source level,
// same convention as german-learner-profile-contract.test.mjs. The pure
// resolver logic those flows call is executed directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const profileMod = await import('../../frontend/js/features/auth/german-profile.ts');
const { resolveGermanExamProfileIdClient, TESTDAF_DIGITAL_PROFILE_ID } = profileMod;

// ── resolver regression (the mechanism both flows rely on) ─────────────────

test('resolver: TESTDAF_DIGITAL_PROFILE_ID override resolves regardless of TDN level, plain call still null', () => {
  assert.equal(TESTDAF_DIGITAL_PROFILE_ID, 'testdaf_digital');
  for (const level of ['TDN 3', 'TDN 4', 'TDN 5']) {
    assert.equal(resolveGermanExamProfileIdClient('TestDaF', level, TESTDAF_DIGITAL_PROFILE_ID), 'testdaf_digital');
  }
  // paper-based / no explicit choice: unchanged, still null (no fake legacy value invented)
  assert.equal(resolveGermanExamProfileIdClient('TestDaF', 'TDN 4'), null);
  assert.equal(resolveGermanExamProfileIdClient('TestDaF', 'TDN 4', null), null);
  assert.equal(resolveGermanExamProfileIdClient('TestDaF', 'TDN 4', ''), null);
});

test('resolver: the override is generic (works for any family), not a TestDaF-only special case in the resolver itself', () => {
  assert.equal(resolveGermanExamProfileIdClient('telc', 'B2', 'testdaf_digital'), 'testdaf_digital');
});

// ── onboarding wiring (source-level, same convention as sibling suite) ─────

const onboarding = read('frontend/js/features/auth/onboarding.ts');

test('onboarding: imports TESTDAF_DIGITAL_PROFILE_ID from the shared registry, no invented local constant', () => {
  assert.match(onboarding, /import\s*\{[^}]*TESTDAF_DIGITAL_PROFILE_ID[^}]*\}\s*from\s*'\.\/german-profile\.js'/s);
});

test('onboarding: a TestDaF-only delivery-mode flag drives the override, default false (nothing guessed)', () => {
  assert.match(onboarding, /let _obTestDafDigital = false;/);
  // reset on family change (_obSelectTest) and on modal (re)open (showOnboarding)
  const selectTestFn = onboarding.slice(onboarding.indexOf('window._obSelectTest = function'));
  assert.match(selectTestFn.slice(0, 400), /_obTestDafDigital = false;/);
  const showOnboardingFn = onboarding.slice(onboarding.indexOf('export function showOnboarding'));
  assert.match(showOnboardingFn.slice(0, 200), /_obTestDafDigital = false;/);
});

test('onboarding: the mode selector is injected only for the TestDaF family, every other family unaffected', () => {
  const selectTestFn = onboarding.slice(
    onboarding.indexOf('window._obSelectTest = function'),
    onboarding.indexOf('window._obSelectLevel = function')
  );
  assert.match(selectTestFn, /if \(_obTest === 'TestDaF'\)/);
  // the else branch must clear/hide it for DSH/Goethe/telc/OESD/DSD
  const ifIdx = selectTestFn.indexOf("if (_obTest === 'TestDaF')");
  const tail = selectTestFn.slice(ifIdx);
  assert.match(tail, /}\s*else\s*{\s*modeGrid\.innerHTML = '';\s*modeWrap\.style\.display = 'none';/);
});

test('onboarding: _obSelectTestDafMode sets the flag from the clicked mode, scoped to its own grid', () => {
  const fn = onboarding.slice(
    onboarding.indexOf('window._obSelectTestDafMode = function'),
    onboarding.indexOf('};', onboarding.indexOf('window._obSelectTestDafMode = function')) + 2
  );
  assert.match(fn, /getElementById\('obTestDafModeGrid'\)/);
  assert.match(fn, /_obTestDafDigital = mode === 'digital';/);
});

test("onboarding: digital choice passes the explicit override; paper/no-choice keeps the plain legacy call (unchanged null result)", () => {
  const finishFn = onboarding.slice(
    onboarding.indexOf('window._obFinishLearner = async function'),
    onboarding.indexOf("// initOnboarding is called")
  );
  assert.match(
    finishFn,
    /_obTest === 'TestDaF' && _obTestDafDigital\s*\r?\n\s*\? resolveGermanExamProfileIdClient\(_obTest, _obLevel, TESTDAF_DIGITAL_PROFILE_ID\)\s*\r?\n\s*: resolveGermanExamProfileIdClient\(_obTest, _obLevel\)/
  );
});

test('onboarding: TELC/Goethe test-card markup and level flow are untouched (no per-family branching added there)', () => {
  const selectTestFn = onboarding.slice(
    onboarding.indexOf('window._obSelectTest = function'),
    onboarding.indexOf('window._obSelectLevel = function')
  );
  assert.doesNotMatch(selectTestFn, /Goethe|telc|DSH|OESD|DSD/);
});

// ── onboarding HTML: the selector lives only inside the TestDaF-only step, all test-family cards untouched ─

const signup = read('frontend/pages/signup.html');

test('signup.html: TestDaF mode wrap exists, hidden by default, inside step 3b only', () => {
  assert.match(signup, /id="obTestDafModeWrap"[^>]*style="display: none"/);
  assert.match(signup, /id="obTestDafModeGrid"/);
  const step3b = signup.slice(signup.indexOf('id="obStep3b"'), signup.indexOf('</div>\n  </div>\n</div>'));
  assert.match(step3b, /obTestDafModeWrap/);
});

test('signup.html: every existing test-family card is untouched (still exactly 6 cards, same data-test values)', () => {
  const cards = [...signup.matchAll(/data-test="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cards, ['TestDaF', 'DSH', 'Goethe', 'telc', 'OESD', 'DSD']);
});

// ── i18n: new strings follow the existing data-i18n pattern, present in both locales ─

const language = read('frontend/js/features/settings/language.ts');

test('i18n: TestDaF delivery-mode strings exist in both en and de blocks', () => {
  const enBlock = language.slice(language.indexOf('  en: {'), language.indexOf('  de: {'));
  const deBlock = language.slice(language.indexOf('  de: {'));
  for (const key of ['ob_testdaf_mode_question', 'ob_testdaf_mode_digital', 'ob_testdaf_mode_paper', 'ob_testdaf_mode_hint']) {
    assert.match(enBlock, new RegExp(key + ':'), `${key} missing from en`);
    assert.match(deBlock, new RegExp(key + ':'), `${key} missing from de`);
  }
});

// ── Profile edit page: same override precedence, same TestDaF-only scoping ─

const profileJs = read('frontend/views/profile/profile.js');
const profileHtml = read('frontend/views/profile/profile.html');
const userData = read('frontend/js/features/auth/user-data.ts');

test('profile.html: TestDaF mode field exists, hidden by default, reuses the shared i18n keys', () => {
  assert.match(profileHtml, /id="profileTestDafModeGroup"[^>]*style="display: none"/);
  assert.match(profileHtml, /id="profileTestDafMode"/);
  assert.match(profileHtml, /data-i18n="ob_testdaf_mode_digital"/);
  assert.match(profileHtml, /data-i18n="ob_testdaf_mode_paper"/);
});

test('profile.js: an explicit digital choice always overrides, an explicit paper choice always clears to null', () => {
  const save = profileJs.slice(profileJs.indexOf('async function saveProfile'), profileJs.indexOf('var _dbSaved = false;'));
  assert.match(save, /tdVal === 'digital'/);
  assert.match(save, /tdVal === 'paper'/);
  const digitalBranch = save.slice(save.indexOf("tdVal === 'digital'"), save.indexOf("tdVal === 'paper'"));
  assert.match(digitalBranch, /window\.TESTDAF_DIGITAL_PROFILE_ID \|\| 'testdaf_digital'/);
  const paperBranch = save.slice(save.indexOf("tdVal === 'paper'"), save.indexOf('} else {', save.indexOf("tdVal === 'paper'")));
  assert.match(paperBranch, /data\.german_exam_profile_id = null;/);
});

test('profile.js: non-TestDaF families are unaffected — tdVal is only ever non-empty when test === TestDaF', () => {
  assert.match(profileJs, /var tdVal = test === 'TestDaF' && tdSel \? tdSel\.value : '';/);
});

test('profile.js: the change handler shows/hides the field by family and clears a stale choice on family switch', () => {
  const handler = profileJs.slice(profileJs.lastIndexOf("document.addEventListener('change'"));
  assert.match(handler, /profileTestDafModeGroup/);
  assert.match(handler, /t\.value === 'TestDaF'/);
  assert.match(handler, /tdSel\.value = '';/);
});

test('user-data.ts: applyUserTypeUI shows the field only for TestDaF and pre-selects digital only when actually saved as testdaf_digital', () => {
  const fn = userData.slice(userData.indexOf('export function applyUserTypeUI'));
  assert.match(fn, /germanTest === 'TestDaF'/);
  assert.match(fn, /window\._germanExamProfileId === TESTDAF_DIGITAL_PROFILE_ID/);
});

test('backend/available flags: this change touches no exam-part availability and no backend german_exams file', () => {
  assert.doesNotMatch(onboarding, /available\s*[:=]/);
  assert.doesNotMatch(profileJs, /available\s*[:=]/);
});
