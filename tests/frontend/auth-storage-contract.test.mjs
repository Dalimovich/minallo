// Source-level contract tests for the auth storage scheme.
//
// The auth code lives in four spread-out files (auth-bootstrap.js,
// supabase.js, reset-password.html, auth-modal.ts) and they MUST agree on
// the storage keys, or a session goes silently into the void on the next
// reload. We've now had two separate regressions where one of these wrote
// the legacy sb_token/sb_refresh keys while the others read sb_sess_*.
//
// These tests don't execute the JS — they read the source and assert the
// invariants. They're cheap and catch the most common regression class.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const AUTH_BOOTSTRAP = read('frontend/js/auth-bootstrap.js');
const SUPABASE_JS = read('frontend/js/supabase.js');
const RESET_HTML = read('frontend/reset-password.html');
const AUTH_MODAL = read('frontend/js/features/auth/auth-modal.ts');
const ONBOARDING_TS = read('frontend/js/features/auth/onboarding.ts');
const SETTINGS_VIEW_JS = read('frontend/views/settings/settings.js');
const USER_DATA_TS = read('frontend/js/features/auth/user-data.ts');
const APP_TS = read('frontend/js/app.ts');
const LOADER_TS = read('frontend/js/loader.ts');
const CHATBOT_DISPATCHER = read('frontend/views/chatbot/chatbot.js');

test('free accounts are not shown the paywall automatically during login', () => {
  assert.doesNotMatch(
    USER_DATA_TS,
    /setTimeout\(\s*window\._showPaywall/,
    'the paywall must only open after an explicit upgrade or gated-feature action'
  );
});

// ── stay-signed-in across browser restart ───────────────────────────────────
test('auth-bootstrap treats sb_sess_refresh as "logged in" for boot routing', () => {
  // After a real browser restart sessionStorage is gone; only the refresh
  // token in localStorage remains. Boot must enter the app shell so
  // supabase.js can run restoreSession() and exchange the refresh token.
  assert.match(
    AUTH_BOOTSTRAP,
    /localStorage\.getItem\(['"]sb_sess_refresh['"]\)/,
    'auth-bootstrap.js must consult sb_sess_refresh during boot routing'
  );
});

test('authenticated boot and successful sign-in always enter the chatbot workspace', () => {
  assert.match(AUTH_BOOTSTRAP, /if \(loggedIn\) \{[\s\S]*sessionStorage\.setItem\('ss_portal_tab', 'aipage'\)/);
  assert.match(AUTH_BOOTSTRAP, /window\.location\.replace\(window\.location\.pathname \+ '#portal=aipage'\)/);
  assert.match(SUPABASE_JS, /var _targetSec = 'aipage'/);
  assert.match(SUPABASE_JS, /var _resumePdfImmediately = false/);
});

test('authenticated boot mounts the chatbot before revealing the application', () => {
  assert.match(AUTH_BOOTSTRAP, /document\.body\.classList\.add\('minallo-chatbot-booting'\)/);
  assert.doesNotMatch(AUTH_BOOTSTRAP, /minalloChatbotBootGuard|Opening Minallo/, 'no second boot overlay competes with the logo cover');
  assert.match(CHATBOT_DISPATCHER, /window\._ncbMountPromise = Promise\.all/);
  assert.match(LOADER_TS, /await loadPortalRoute\('aipage'\)/);
  assert.match(LOADER_TS, /await mountPromise/);
  assert.match(LOADER_TS, /navigate\('aipage'\)/);
  assert.match(LOADER_TS, /document\.body\.classList\.remove\('minallo-chatbot-booting'\)/);
  assert.match(LOADER_TS, /chatbot home failed to mount[\s\S]*MinalloBoot\?\.recovery\('auth'\)/);
});

test('authenticated application permanently detaches the legacy visible shell', () => {
  assert.match(AUTH_BOOTSTRAP, /document\.body\.classList\.add\('minallo-chatbot-only'\)/);
  assert.match(AUTH_BOOTSTRAP, /minallo-chatbot-only #portal \.sidebar[\s\S]*display:none!important/);
  assert.match(AUTH_BOOTSTRAP, /portal \.portal-section:not\(#psec-aipage\)\{display:none!important\}/);
  assert.match(AUTH_BOOTSTRAP, /minallo-chatbot-only #psec-aipage[\s\S]*position:fixed!important/);
  assert.match(LOADER_TS, /function detachLegacyPortalRuntime/);
  assert.match(LOADER_TS, /legacyHost\.style\.setProperty\('display', 'none', 'important'\)/);
  assert.match(LOADER_TS, /\.portal-section:not\(#psec-aipage\)/);
  assert.match(LOADER_TS, /legacyHost!\.appendChild\(section\)/);
  assert.match(LOADER_TS, /detachLegacyPortalRuntime\(\);[\s\S]*loadAppScript\(\)/);
  assert.match(LOADER_TS, /if \(!chatbotRoot \|\| chatbotRoot\.hidden \|\| !chatbotRoot\.querySelector\('\.ncb-card'\)\)/);
});

test('automatic boot recovery preserves the authenticated session', () => {
  const recoverStart = AUTH_BOOTSTRAP.indexOf("if (qp.get('recover') === '1')");
  const fullResetStart = AUTH_BOOTSTRAP.indexOf("if (qp.get('reset') === '1')");
  assert.ok(recoverStart >= 0 && fullResetStart > recoverStart);
  const automaticRecovery = AUTH_BOOTSTRAP.slice(recoverStart, fullResetStart);
  assert.doesNotMatch(automaticRecovery, /sb_sess_token|sb_sess_refresh|ss_logged_in/);
  assert.match(automaticRecovery, /ss_last_section', 'aipage'/);
  assert.match(AUTH_BOOTSTRAP, /window\.location\.replace\(window\.location\.pathname \+ '\?recover=1'\)/);
  assert.doesNotMatch(AUTH_BOOTSTRAP, /window\.location\.replace\(window\.location\.pathname \+ '\?reset=1'\)/);
});

// ── no path writes the legacy sb_token / sb_refresh keys ───────────────────
function assertNoLegacyWrites(name, source) {
  // Reading the legacy keys is fine (for cleanup/migration); WRITING them is
  // the regression we want to catch. Match `setItem('sb_token'` etc.
  const writeLegacy = /\.setItem\(\s*['"]sb_(token|refresh)['"]/g;
  const matches = [...source.matchAll(writeLegacy)];
  assert.equal(
    matches.length, 0,
    `${name} writes legacy keys: ${matches.map((m) => m[0]).join(', ')}`
  );
}

test('auth-bootstrap.js does not write legacy sb_token / sb_refresh', () => {
  assertNoLegacyWrites('auth-bootstrap.js', AUTH_BOOTSTRAP);
});

test('reset-password.html does not write legacy sb_token / sb_refresh', () => {
  assertNoLegacyWrites('reset-password.html', RESET_HTML);
});

test('auth-modal.ts does not write legacy sb_token / sb_refresh', () => {
  assertNoLegacyWrites('auth-modal.ts', AUTH_MODAL);
});

// ── reset-password lands the user signed in (canonical keys + flag) ────────
test('reset-password writes sb_sess_token to sessionStorage', () => {
  // The recovery JWT is short-lived and tab-scoped, same as a normal access
  // token. Storing it in sessionStorage matches _sbStoreSession in supabase.js.
  assert.match(
    RESET_HTML,
    /sessionStorage\.setItem\(\s*['"]sb_sess_token['"]/,
    'reset-password must write sb_sess_token to sessionStorage'
  );
});

test('reset-password writes sb_sess_refresh to localStorage', () => {
  assert.match(
    RESET_HTML,
    /localStorage\.setItem\(\s*['"]sb_sess_refresh['"]/,
    'reset-password must write sb_sess_refresh to localStorage'
  );
});

test('reset-password flips ss_logged_in so boot routes into the app shell', () => {
  // Without this, auth-bootstrap may still drop the user on the landing
  // page if the timing of token writes vs. reload check goes against us.
  assert.match(
    RESET_HTML,
    /sessionStorage\.setItem\(\s*['"]ss_logged_in['"]\s*,\s*['"]true['"]/,
    'reset-password must set ss_logged_in=true before redirect'
  );
});

// ── signup that returns an access_token uses the canonical keys ────────────
test('auth-modal signup writes sb_sess_token to sessionStorage', () => {
  assert.match(
    AUTH_MODAL,
    /sessionStorage\.setItem\(\s*['"]sb_sess_token['"]\s*,\s*signUpResult\.access_token/,
    'auth-modal signup must write sb_sess_token to sessionStorage'
  );
});

test('auth-modal signup writes sb_sess_refresh to localStorage', () => {
  assert.match(
    AUTH_MODAL,
    /localStorage\.setItem\(\s*['"]sb_sess_refresh['"]/,
    'auth-modal signup must write sb_sess_refresh to localStorage'
  );
});

// ── ss_show_auth must not outlive a successful sign-in ──────────────────────
// QA finding, 2026-10-13: clicking "Sign in" on the landing page sets
// sessionStorage ss_show_auth='true' (auth-bootstrap.js) so boot shows the
// modal instead of silently auto-restoring a session. Nothing cleared it on
// success — only the sign-OUT paths (_showModal's own cleanup,
// _clearSavedAuth) did. Every reload after a landing-page-triggered sign-in
// hit supabase.js's `showAuth` boot check again, re-showing a stale modal
// and returning early WITHOUT verifying the stored session or calling
// _enterApp — leaving window._currentUser null (and anything that depends on
// it, e.g. course data via _loadUserCourses) despite a perfectly valid
// stored token. Confirmed live: profiles.courses had real data server-side
// that never reached window.SEMS client-side.
test('a successful SIGNED_IN clears ss_show_auth so the next boot does not re-show a stale modal', () => {
  const signedInStart = AUTH_MODAL.indexOf("if (event === 'SIGNED_IN')");
  assert.ok(signedInStart >= 0, "onAuthStateChange SIGNED_IN branch not found in auth-modal.ts");
  const signedInEnd = AUTH_MODAL.indexOf("else if (event === 'SIGNED_OUT')", signedInStart);
  assert.ok(signedInEnd > signedInStart, "could not locate the end of the SIGNED_IN branch");
  const branch = AUTH_MODAL.slice(signedInStart, signedInEnd);
  assert.match(
    branch,
    /sessionStorage\.removeItem\(\s*['"]ss_show_auth['"]\s*\)/,
    'the SIGNED_IN handler must clear ss_show_auth so a later reload restores the session instead of re-showing the modal'
  );
});

// ── Google One Tap matches the password-flow storage shape ─────────────────
test('Google One Tap writes sb_sess_token to sessionStorage (not localStorage)', () => {
  // Persisting the bearer access token in localStorage was a security
  // inconsistency vs. the password path. Force the same sessionStorage scope.
  assert.match(
    AUTH_BOOTSTRAP,
    /sessionStorage\.setItem\(\s*['"]sb_sess_token['"]\s*,\s*d\.access_token/,
    'Google One Tap must write sb_sess_token to sessionStorage'
  );
  // And it must NOT write the access token to localStorage anywhere.
  const localStorageAccessWrite =
    /localStorage\.setItem\(\s*['"]sb_sess_token['"]/.exec(AUTH_BOOTSTRAP);
  assert.equal(
    localStorageAccessWrite, null,
    'Google One Tap must not persist the access token in localStorage'
  );
});

// ── logout clears the profile/courses caches that boot reads eagerly ───────
test('logout clears ss_last_uid so the next account does not flash on boot', () => {
  // app.ts reads ss_last_uid + profile_cache_<uid> at module top level,
  // before auth resolves. If we don't clear them, user B briefly sees user
  // A's name and courses on the next sign-in.
  assert.match(
    SUPABASE_JS,
    /\.removeItem\(\s*['"]ss_last_uid['"]/,
    'signOut must remove ss_last_uid'
  );
});

test('logout sweeps all profile_cache_<uid> entries', () => {
  // Any uid could be cached, so the cleanup needs to iterate keys.
  assert.match(
    SUPABASE_JS,
    /profile_cache_/,
    'signOut must touch profile_cache_* keys'
  );
  assert.match(
    SUPABASE_JS,
    /localStorage\.removeItem\(\s*_?\w+\s*\)/,
    'signOut must remove iterated localStorage keys (profile_cache_* sweep)'
  );
});

// ── logout also wipes onboarding answers ───────────────────────────────────
test('logout removes the global onboarding keys', () => {
  for (const key of ['ss_user_type', 'ss_major', 'ss_vertiefung']) {
    const re = new RegExp(`\\.removeItem\\(\\s*['"]${key}['"]`);
    assert.match(SUPABASE_JS, re, `signOut must remove ${key}`);
  }
});

test('logout sweeps per-uid onboarding keys', () => {
  for (const prefix of ['ss_user_type_', 'ss_german_test_', 'ss_german_level_']) {
    assert.match(
      SUPABASE_JS,
      new RegExp(prefix),
      `signOut must sweep ${prefix}<uid> entries`
    );
  }
});

// ── _obLogout delegates instead of doing its own broken cleanup ────────────
test('_obLogout delegates to the central sb.auth.signOut', () => {
  // The hand-rolled cleanup used to remove sb_sess_refresh from
  // sessionStorage (wrong: it lives in localStorage), leaving the refresh
  // token on disk so the next boot silently re-authed the user. Forcing
  // delegation to the central signOut prevents this regression.
  assert.match(
    ONBOARDING_TS,
    /sb\.auth\.signOut\s*\(/,
    '_obLogout must call sb.auth.signOut to share the central cleanup'
  );
});

test('_obLogout does not pretend sb_sess_refresh lives in sessionStorage', () => {
  // Old code: sessionStorage.removeItem('sb_sess_refresh') — wrong storage.
  // The refresh token is in localStorage (so it survives a tab close); a
  // sessionStorage cleanup is harmless but a sign someone misunderstood
  // the scheme.
  const wrongClear = /sessionStorage\.removeItem\(\s*['"]sb_sess_refresh['"]/;
  // Allowed only inside the central signOut (supabase.js), where both
  // storages are scrubbed defensively. Disallow in onboarding.
  assert.equal(
    wrongClear.test(ONBOARDING_TS), false,
    '_obLogout must not call sessionStorage.removeItem("sb_sess_refresh") in isolation'
  );
});

// ── settings logout no longer maintains its own duplicated cleanup ─────────
test('settings logout calls sb.auth.signOut and does not re-implement cleanup', () => {
  assert.match(
    SETTINGS_VIEW_JS,
    /sb\.auth\.signOut\s*\(/,
    'settings logout must delegate to sb.auth.signOut'
  );
  // The old code removed ss_user_type / minallo_trial_used inline. Those
  // are now centralised in supabase.js; settings.js should not duplicate.
  const inlineUserType = /localStorage\.removeItem\(\s*['"]ss_user_type['"]/;
  assert.equal(
    inlineUserType.test(SETTINGS_VIEW_JS), false,
    'settings.js should not duplicate the ss_user_type cleanup that lives in signOut'
  );
});

// ── _germanProfileLoaded must only be promoted by an AUTHORITATIVE apply ───
// Regression coverage for the Sprachbausteine/Lesen/Hören/Writing-Coach
// "unsupported profile" bug: applyProfile() used to set
// window._germanProfileLoaded = true unconditionally, including from the
// boot-time cached profile_cache_<uid> apply. If that cache predated
// german_test/german_level being set (or was otherwise stale), every exam
// module treated the resulting null profile id as a DEFINITIVE
// "unsupported" verdict instead of waiting for the real network fetch —
// even though the account's actual profile (telc + C1 Hochschule) resolves
// correctly once the fresh row arrives.
test('applyProfile() only sets window._germanProfileLoaded=true when authoritative', () => {
  const fnStart = USER_DATA_TS.indexOf('export function applyProfile(');
  assert.ok(fnStart >= 0, 'applyProfile() not found in user-data.ts');
  const fnEnd = USER_DATA_TS.indexOf('\nexport function applyUserTypeUI', fnStart);
  assert.ok(fnEnd > fnStart, 'could not locate the end of applyProfile()');
  const fnBody = USER_DATA_TS.slice(fnStart, fnEnd);

  assert.match(
    fnBody,
    /const authoritative = opts\.authoritative !== false;/,
    'applyProfile must derive an `authoritative` flag, defaulting to true'
  );
  assert.match(
    fnBody,
    /if \(authoritative\)\s*window\._germanProfileLoaded = true;/,
    'window._germanProfileLoaded must only be set true inside an `if (authoritative)` guard'
  );
  // The bare, unconditional assignment (the historical bug) must be gone.
  assert.doesNotMatch(
    fnBody,
    /(?<!if \(authoritative\)\s*)window\._germanProfileLoaded = true;\s*\n\s*window\.dispatchEvent/,
    'window._germanProfileLoaded must not be set unconditionally right before the ss-profile-updated dispatch'
  );
});

// ── cross-account activeCourseId/course-name leak (QA audit, 2026-10-13) ───
// Signing out of account A and into account B in the same browser tab left
// account A's course id/name visible to account B: window.activeCourseId
// (a plain in-memory global) was never reset by signOut(), and two unscoped
// storage keys (workspace-library.ts's RECENT_COURSE_KEY in localStorage,
// PDF_SESSION_KEY in sessionStorage) were never swept, unlike the already
// correctly-namespaced ss_ncb_*:<uid> / studyLibraryState() caches. No actual
// file-content leak was found (backend ownership checks held) but the stale
// course id/name rendering is itself a privacy/isolation defect.
test('logout resets the in-memory activeCourseId global', () => {
  assert.match(
    SUPABASE_JS,
    /window\.activeCourseId = null;/,
    'signOut must reset window.activeCourseId so the next account on this browser never sees it'
  );
});

test('logout sweeps the unscoped recent-course and open-pdf session keys', () => {
  assert.match(
    SUPABASE_JS,
    /['"]minallo:chatbot-recent-course['"]/,
    'signOut must remove the unscoped chatbot-recent-course key'
  );
  assert.match(
    SUPABASE_JS,
    /sessionStorage\.removeItem\(\s*['"]minallo:chatbot-open-pdf['"]\s*\)/,
    'signOut must remove the unscoped chatbot-open-pdf sessionStorage key'
  );
});

// ── cross-account PDF viewer state leak (V12 follow-up, 2026-10-14) ───────
// getActivePdfContext() doesn't gate on PDF viewer DOM visibility, only on
// __minalloPdfViewerState (courseId/documentId/pdfDoc) — a plain in-memory
// module store signOut() never touched. Discovered while fixing V12 (German-
// learner mode dropping file/page context): once learners were also allowed
// to use getActivePdfContext(), the same still-open-PDF-from-account-A risk
// that activeCourseId already closed for the course NAME would have reopened
// for the PDF's actual identity/text if B asked a question before opening
// any file of their own.
test('logout clears the in-memory PDF viewer state (courseId/documentId/pdfDoc)', () => {
  assert.match(
    SUPABASE_JS,
    /import\(['"]\.\/features\/pdf-viewer\/active-pdf-context\.js['"]\)/,
    'signOut must dynamically import active-pdf-context.js (classic script, no static import)'
  );
  assert.match(
    SUPABASE_JS,
    /clearActivePdfViewerState\(\)/,
    'signOut must call clearActivePdfViewerState() so the next account on this browser never inherits an open PDF identity'
  );
});

// ── account-change-via-refresh (release-readiness audit, 2026-10-14) ──────
// A token refresh (NOT an explicit sign-out/sign-in) that resolves to a
// DIFFERENT user than this tab last knew about — e.g. another tab in the
// same browser signed into a different account and overwrote the shared
// sb_sess_* storage this tab's own background refresh then read — must wipe
// the OLD account's course/PDF/chat-scoped local state before adopting the
// new identity, same as signOut()'s cross-account fix. An ORDINARY refresh
// of the SAME user must not pay that cost on every refresh cycle.
test('signOut and a cross-account token refresh share one account-state-wipe function', () => {
  const defCount = (SUPABASE_JS.match(/function _sbClearAccountScopedState\(\)/g) || []).length;
  assert.equal(defCount, 1, '_sbClearAccountScopedState must be defined exactly once and reused, not duplicated');
  const callCount = (SUPABASE_JS.match(/_sbClearAccountScopedState\(\);/g) || []).length;
  assert.equal(callCount, 2, 'expected exactly two call sites: signOut() and refreshSession()\'s user-id-mismatch branch');
});

test('refreshSession only wipes account-scoped state when the refreshed user id actually differs', () => {
  const refreshBody = SUPABASE_JS.slice(
    SUPABASE_JS.indexOf('refreshSession: function ()'),
    SUPABASE_JS.indexOf('restoreSession: function ()')
  );
  assert.match(
    refreshBody,
    /d\.user\.id !== _currentUser\.id/,
    'must compare the refreshed user id against the previously known _currentUser, not assume every refresh is the same user'
  );
  assert.match(
    refreshBody,
    /_currentUser && _currentUser\.id && d\.user\.id !== _currentUser\.id\) \{\s*\n\s*_sbClearAccountScopedState\(\);/,
    'the wipe must be gated on the id-mismatch condition, not called unconditionally on every refresh'
  );
});

test('every cache-sourced applyProfile() call site marks itself non-authoritative', () => {
  // loadUserData()'s cached-profile branch, before the real network fetch.
  assert.match(
    USER_DATA_TS,
    /if \(cp && window\.applyProfile\) window\.applyProfile\(cp, \{ authoritative: false \}\);/,
    'loadUserData() must pass { authoritative: false } for the profile_cache_<uid> apply'
  );
  // app.ts's two boot-time cache applies (initial paint + profile section
  // HTML re-apply) — both read the exact same profile_cache_<uid> key.
  const bootCacheCalls = [...APP_TS.matchAll(/applyProfile\(([^)]+)\)/g)]
    .filter((call) => !call[1].startsWith('p: unknown'));
  assert.ok(bootCacheCalls.length >= 2, 'expected at least 2 applyProfile() calls in app.ts');
  for (const call of bootCacheCalls) {
    assert.match(
      call[1],
      /\{\s*authoritative:\s*false\s*\}/,
      `app.ts applyProfile(${call[1]}) reads from profile_cache_<uid> and must pass { authoritative: false }`
    );
  }
});
