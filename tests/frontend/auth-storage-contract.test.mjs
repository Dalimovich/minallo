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
  assert.match(AUTH_BOOTSTRAP, /id = 'minalloChatbotBootGuard'/);
  assert.match(CHATBOT_DISPATCHER, /window\._ncbMountPromise = Promise\.all/);
  assert.match(LOADER_TS, /await loadPortalRoute\('aipage'\)/);
  assert.match(LOADER_TS, /await mountPromise/);
  assert.match(LOADER_TS, /navigate\('aipage'\)/);
  assert.match(LOADER_TS, /document\.body\.classList\.remove\('minallo-chatbot-booting'\)/);
  assert.match(LOADER_TS, /Minallo could not open\.[\s\S]*Retry/);
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
