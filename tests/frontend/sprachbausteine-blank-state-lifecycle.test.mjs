// Source-level contract tests for the Sprachbausteine blank-workspace fix.
//
// Live reproduction (2026-09-18) found the workspace could get stuck
// indefinitely on "Loading your exam profile…" (or, per report, fully
// blank) with /generate never firing. Root cause: loadUserData()'s
// Promise.all rejected on any single query error (503/403 seen live),
// aborting the whole function before applyProfile() ever ran — leaving
// window._germanProfileLoaded permanently undefined for the session, with
// no retry and no error signal. Every module gating on that flag
// (Sprachbausteine/Lesen/Hören/Writing Coach) then waits forever.
//
// Fixed in two layers:
//   1. loadUserData/withTimeout: a query rejection resolves null instead of
//      aborting Promise.all, and a null/failed profile fetch still promotes
//      _germanProfileLoaded to true (via applyProfile({}, {authoritative:
//      true}), safe because of the hasOwnProperty guards added earlier).
//   2. Sprachbausteine itself (practice.js): an explicit uiState + watchdog
//      that forces the error/Retry card if the workspace is ever left with
//      neither a loading message, generated content, nor an error card —
//      defense-in-depth against whatever else could produce that state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const USER_DATA_TS = read('frontend/js/features/auth/user-data.ts');
const PRACTICE_JS = read('frontend/views/practice/practice.js');

// ── loadUserData must always reach a terminal profile-resolution state ────

test('withTimeout resolves null on a query rejection, not just a timeout', () => {
  assert.match(
    USER_DATA_TS,
    /p\.catch\(\(err: unknown\) => \{[\s\S]{0,200}return null;\s*\}\)/,
    'withTimeout must catch a rejected query and resolve null, so one failing query cannot abort Promise.all for the other two'
  );
});

test('loadUserData promotes _germanProfileLoaded when the profile fetch returns null', () => {
  const successPathIdx = USER_DATA_TS.indexOf("if (profile) {");
  assert.ok(successPathIdx >= 0, 'profile success branch not found');
  const elseIdx = USER_DATA_TS.indexOf('} else if (window.applyProfile) {', successPathIdx);
  assert.ok(
    elseIdx >= 0 && elseIdx < successPathIdx + 600,
    'a null profile must still call applyProfile({}, {authoritative: true}) so _germanProfileLoaded is not left unset forever'
  );
  const elseBlock = USER_DATA_TS.slice(elseIdx, elseIdx + 1000);
  assert.match(elseBlock, /applyProfile\(\{\},\s*\{\s*authoritative:\s*true\s*\}\)/);
});

test('loadUserData promotes _germanProfileLoaded even on an unexpected throw', () => {
  const catchIdx = USER_DATA_TS.indexOf("} catch (e: unknown) {");
  assert.ok(catchIdx >= 0, 'outer catch block not found');
  const catchBlock = USER_DATA_TS.slice(catchIdx, catchIdx + 600);
  assert.match(catchBlock, /console\.warn\('loadUserData error:', e\)/);
  assert.match(catchBlock, /applyProfile\(\{\},\s*\{\s*authoritative:\s*true\s*\}\)/);
});

// ── Sprachbausteine must never leave the workspace silently blank ─────────

test('sbRenderWorkspace throws instead of silently returning on missing prerequisites', () => {
  const fnIdx = PRACTICE_JS.indexOf('function sbRenderWorkspace()');
  assert.ok(fnIdx >= 0, 'sbRenderWorkspace not found');
  const fnBody = PRACTICE_JS.slice(fnIdx, fnIdx + 700);
  assert.doesNotMatch(
    fnBody,
    /if \(!textPanel \|\| !qPanel \|\| !sb\.content\) return;/,
    'the silent early return must be gone'
  );
  assert.match(
    fnBody,
    /if \(!textPanel \|\| !qPanel \|\| !sb\.content\) \{\s*throw new Error\(/,
    'missing render prerequisites must throw, not silently return'
  );
});

test('sbGenerateOrLoadPart sets an explicit uiState at each transition', () => {
  const fnIdx = PRACTICE_JS.indexOf('function sbGenerateOrLoadPart()');
  assert.ok(fnIdx >= 0, 'sbGenerateOrLoadPart not found');
  const fnBody = PRACTICE_JS.slice(fnIdx, fnIdx + 2000);
  assert.match(fnBody, /sb\.uiState = 'generating'/, 'must set uiState=generating before the network call');
  assert.match(fnBody, /sb\.uiState = 'ready'/, 'must set uiState=ready after a successful render');
});

test('every Sprachbausteine render function sets sb.uiState', () => {
  const checks = [
    ['sbShowWaitingForProfile', "sb.uiState = 'profile_loading'"],
    ['sbShowUnsupportedProfile', "sb.uiState = 'unsupported'"],
    ['sbShowGenerationError', "sb.uiState = 'error'"],
  ];
  for (const [fnName, expected] of checks) {
    const fnIdx = PRACTICE_JS.indexOf('function ' + fnName + '(');
    assert.ok(fnIdx >= 0, fnName + ' not found');
    const fnBody = PRACTICE_JS.slice(fnIdx, fnIdx + 400);
    assert.ok(fnBody.includes(expected), fnName + ' must set ' + expected);
  }
});

test('a watchdog exists that detects the illegal fully-blank state and forces the error card', () => {
  assert.match(PRACTICE_JS, /function sbWatchdogCheck\(\)/, 'sbWatchdogCheck must exist');
  assert.match(PRACTICE_JS, /function sbArmWatchdog\(\)/, 'sbArmWatchdog must exist');
  const checkIdx = PRACTICE_JS.indexOf('function sbWatchdogCheck()');
  const checkBody = PRACTICE_JS.slice(checkIdx, checkIdx + 1200);
  assert.match(checkBody, /hasLegalContent/, 'watchdog must positively detect legal content, not assume blank means broken by default');
  assert.match(checkBody, /sbShowGenerationError\(\)/, 'watchdog must force the explicit error/Retry state, never leave the workspace blank');
  // Armed on both transient states that are expected to progress.
  const waitingIdx = PRACTICE_JS.indexOf('function sbShowWaitingForProfile()');
  assert.match(PRACTICE_JS.slice(waitingIdx, waitingIdx + 700), /sbArmWatchdog\(\)/);
  const genIdx = PRACTICE_JS.indexOf('function sbGenerateOrLoadPart()');
  assert.match(PRACTICE_JS.slice(genIdx, genIdx + 2000), /sbArmWatchdog\(\)/);
});
