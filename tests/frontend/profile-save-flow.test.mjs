// Profile save flow: the saved row is authoritative; the success notification only follows a real adoption,
// never waits for the modal to close, and a failed save changes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(resolve(ROOT, 'frontend/views/profile/profile.js'), 'utf8');

function makeEnv({ upsertError = false, readbackError = false, refresh = 'instant' } = {}) {
  const log = [];
  const timers = [];
  const fieldValues = { profileGermanTest: 'Goethe', profileGermanLevel: 'C1', profileName: 'Ada', profileEmail: 'a@b.de' };
  const window = {
    _userType: 'learner', _germanTest: 'telc', _germanLevel: 'C1 Hochschule',
    isValidGermanTestLevel: () => true,
    _resolveGermanExamProfileId: () => 'goethe_c1',
    _applySavedProfile: (row) => { window._germanTest = row.german_test; window._germanLevel = row.german_level; log.push('applySavedProfile'); },
    _ensureUserProfile: (o) => { log.push('ensureUserProfile:' + JSON.stringify(o)); },
    closeWorkspaceModal: () => log.push('MODAL_CLOSED'),
    Minallo: { registerFeature() {} },
  };
  if (refresh !== 'absent') {
    window._glExamRefreshNow = () => {
      log.push('examRefresh:start');
      return refresh === 'never' ? new Promise(() => {}) : Promise.resolve().then(() => log.push('examRefresh:done'));
    };
  }
  const row = { id: 'u1', german_test: 'Goethe', german_level: 'C1' };
  const table = {
    upsert: async () => { log.push('upsert'); return upsertError ? { error: { message: 'boom' } } : { error: null }; },
    select: () => ({ eq: () => ({ single: async () => { log.push('readback'); if (readbackError) throw new Error('offline'); return row; } }) }),
  };
  const context = {
    window, console,
    document: { getElementById: (id) => (id in fieldValues ? { value: fieldValues[id] } : null), addEventListener() {} },
    localStorage: { setItem() {}, getItem() { return null; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    Promise,
    _currentUser: { id: 'u1', email: 'a@b.de' },
    _sb: { from: () => table },
    _t: (k) => k,
    MAJOR_LIST: [],
    showToast: (title, sub) => log.push('toast:' + title),
    updateAuthIndicator: () => log.push('updateAuthIndicator'),
    _userVertiefung: '', _userMajor: '',
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { context, log, window, timers };
}

const tick = () => new Promise((r) => setImmediate(r));

test('save success: profile adopted and exam refreshed BEFORE the success toast, and the modal is not closed', async () => {
  const env = makeEnv();
  await env.context.saveProfile();
  const order = env.log.filter((l) => l === 'applySavedProfile' || l.startsWith('examRefresh') || l.startsWith('toast:'));
  assert.deepEqual(order, ['applySavedProfile', 'examRefresh:start', 'examRefresh:done', 'toast:toast_profile_saved']);
  assert.ok(!env.log.includes('MODAL_CLOSED'), 'Profile stays open so the user can keep editing');
  assert.equal(env.window._germanTest, 'Goethe');
});

test('a slow manifest never holds the notification hostage (bounded wait)', async () => {
  const env = makeEnv({ refresh: 'never' });
  const saving = env.context.saveProfile();
  for (let i = 0; i < 20 && !env.timers.length; i++) await tick();
  assert.equal(env.timers.length, 1);
  assert.ok(env.timers[0].ms <= 2000);
  assert.ok(!env.log.some((l) => l.startsWith('toast:')), 'not yet');
  env.timers[0].fn();
  await saving;
  assert.ok(env.log.includes('toast:toast_profile_saved'));
});

test('German Practice never opened: save still succeeds without an exam workspace', async () => {
  const env = makeEnv({ refresh: 'absent' });
  await env.context.saveProfile();
  assert.deepEqual(env.log.filter((l) => l.startsWith('toast:')), ['toast:toast_profile_saved']);
});

test('save failure: previous profile stays active, error notification shown, exam UI untouched', async () => {
  const env = makeEnv({ upsertError: true });
  await env.context.saveProfile();
  assert.ok(!env.log.includes('applySavedProfile'));
  assert.ok(!env.log.some((l) => l.startsWith('examRefresh')));
  assert.deepEqual(env.log.filter((l) => l.startsWith('toast:')), ['toast:toast_save_failed']);
  assert.equal(env.window._germanTest, 'telc');
  assert.equal(env.window._germanLevel, 'C1 Hochschule');
});

test('row written but read-back fails: runtime is resynced from the server (never stuck on the old exam)', async () => {
  const env = makeEnv({ readbackError: true });
  await env.context.saveProfile();
  assert.ok(env.log.includes('ensureUserProfile:{"force":true}'));
  assert.ok(!env.log.includes('applySavedProfile'));
  assert.deepEqual(env.log.filter((l) => l.startsWith('toast:')), ['toast:toast_save_failed']);
});
