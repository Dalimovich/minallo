// Exam profile switching: the saved exam selection drives the German exam workspace immediately.
// Race safety, stale-state clearing and manifest-driven rendering, with no DOM and no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const ws = await import('../../frontend/js/features/german-exam/exam-workspace.ts');

const part = (id, implemented = true) => ({ id, title: id, taskType: 't', implemented });
const mod = (id, label, n) => ({ id, label, durationSeconds: null, preparationSeconds: null, note: null, parts: Array.from({ length: n }, (_, i) => part(`${id}_${i + 1}`)) });
const MANIFESTS = {
  telc_c1_hochschule: { profileId: 'telc_c1_hochschule', profileVersion: 5, displayName: 'telc C1 Hochschule', cefrLevel: 'C1',
    modules: [mod('reading', 'Lesen', 3), mod('listening', 'Hören', 3), mod('language_elements', 'Sprachbausteine', 1), mod('writing', 'Schreiben', 1)] },
  goethe_c1: { profileId: 'goethe_c1', profileVersion: 1, displayName: 'Goethe-Zertifikat C1', cefrLevel: 'C1',
    modules: [mod('reading', 'Lesen', 4), mod('listening', 'Hören', 4), mod('writing', 'Schreiben', 2), mod('speaking', 'Sprechen', 2)] },
  testdaf_digital: { profileId: 'testdaf_digital', profileVersion: 1, displayName: 'Digitaler TestDaF', cefrLevel: null,
    modules: [mod('reading', 'Lesen', 3), mod('listening', 'Hören', 3), mod('writing', 'Schreiben', 2), mod('speaking', 'Sprechen', 7)] },
};
// the SERVER resolves the saved selection; the client only sends the request
const SERVER = { 'telc|C1 Hochschule': 'telc_c1_hochschule', 'Goethe|C1': 'goethe_c1', 'TestDaF|TDN 4': 'testdaf_digital' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A workspace wired to fakes. `saved.key` is the saved exam selection; `fetches` records every manifest request. */
function harness({ startKey = 'telc|C1 Hochschule', autoRespond = true } = {}) {
  const saved = { key: startKey, ready: true };
  const fetches = [];
  const rendered = [];
  const resets = [];
  const blocked = [];
  const session = { openPart: 'sprachbausteine_1', prefetched: 'telc-task', pending: true, tts: 'playing', activeSkill: '' };
  const ctl = ws.createExamWorkspace(
    {
      resolveProfileId: () => null,
      savedProfileKey: () => (saved.ready ? saved.key : ''),
      profileReady: () => saved.ready,
      onProfileChange: (prev, next) => {
        resets.push([prev, next]);
        session.openPart = null; session.prefetched = null; session.pending = false; session.tts = null;
      },
      activeSkill: () => session.activeSkill,
      onActiveSkillBlocked: (skill, reason) => blocked.push([skill, reason]),
    },
    {
      fetchManifest: (signal) => {
        const d = deferred();
        const entry = { key: saved.key, signal, ...d, aborted: false };
        signal.addEventListener('abort', () => { entry.aborted = true; });
        fetches.push(entry);
        if (autoRespond) settle(entry);
        return d.promise;
      },
      render: (s) => rendered.push({ status: s.status, profileId: s.profileId, labels: s.manifest ? ws.buildNavModel(s.manifest).map((m) => m.label) : [] }),
    },
  );
  // what the server would answer for the selection a request was SENT for
  function settle(entry, key = entry.key) {
    const id = SERVER[key];
    if (!id) entry.reject(Object.assign(new Error('unsupported'), { unsupported: true }));
    else entry.resolve({ profileId: id, manifest: MANIFESTS[id] });
  }
  return { ctl, saved, fetches, rendered, resets, blocked, session, settle };
}

test('TELC -> Goethe: on save the previous exam vanishes immediately, then the Goethe manifest renders', async () => {
  const h = harness({ autoRespond: false });
  const first = h.ctl.refresh();
  h.settle(h.fetches[0]);
  await first;
  assert.deepEqual(h.ctl.state.manifest.modules.map((m) => m.label), ['Lesen', 'Hören', 'Sprachbausteine', 'Schreiben']);

  h.saved.key = 'Goethe|C1'; // profile save succeeded -> ss-profile-updated
  const switching = h.ctl.refresh();
  // synchronously after the event: no TELC structure, loading state, previous exam's transient state dropped
  assert.equal(h.ctl.state.status, 'loading');
  assert.equal(h.ctl.state.manifest, null);
  assert.equal(h.ctl.state.profileId, null);
  assert.equal(h.rendered.at(-1).status, 'loading');
  assert.deepEqual(h.rendered.at(-1).labels, []);
  assert.equal(h.session.openPart, null);
  assert.equal(h.session.prefetched, null);
  assert.equal(h.session.pending, false);
  assert.equal(h.session.tts, null);
  assert.deepEqual(h.resets.at(-1), ['telc_c1_hochschule', null]);

  h.settle(h.fetches[1]);
  await switching;
  assert.equal(h.ctl.state.status, 'ready');
  assert.equal(h.ctl.state.profileId, 'goethe_c1');
  const labels = ws.buildNavModel(h.ctl.state.manifest).map((m) => m.label);
  assert.deepEqual(labels, ['Lesen', 'Hören', 'Schreiben', 'Sprechen']);
  assert.ok(!labels.includes('Sprachbausteine'));
  assert.ok(!ws.renderOverviewHtml(h.ctl.state.manifest).includes('Sprachbausteine'));
});

test('Goethe -> TestDaF -> TELC: every saved selection shows its own manifest, with no exam registry on the client', async () => {
  const h = harness({ startKey: 'Goethe|C1' });
  await h.ctl.refresh();
  assert.equal(h.ctl.state.profileId, 'goethe_c1');
  h.saved.key = 'TestDaF|TDN 4';
  await h.ctl.refresh();
  assert.equal(h.ctl.state.profileId, 'testdaf_digital');
  assert.deepEqual(ws.buildNavModel(h.ctl.state.manifest).map((m) => m.label), ['Lesen', 'Hören', 'Schreiben', 'Sprechen']);
  assert.equal(ws.buildNavModel(h.ctl.state.manifest)[3].partCount, 7);
  h.saved.key = 'telc|C1 Hochschule';
  await h.ctl.refresh();
  assert.equal(h.ctl.state.profileId, 'telc_c1_hochschule');
  assert.ok(ws.buildNavModel(h.ctl.state.manifest).some((m) => m.label === 'Sprachbausteine'));
});

test('a selection the server cannot resolve is "unsupported", never the previous exam', async () => {
  const h = harness({ startKey: 'Goethe|C1' });
  await h.ctl.refresh();
  h.saved.key = 'DSH|DSH-2';
  await h.ctl.refresh();
  assert.equal(h.ctl.state.status, 'unsupported');
  assert.equal(h.ctl.state.manifest, null);
  assert.equal(h.ctl.state.profileId, null);
});

test('stale state: an open TELC Sprachbausteine part is cleared and no TELC part stays selected under Goethe', async () => {
  const h = harness();
  h.session.activeSkill = 'sprachbausteine';
  await h.ctl.refresh();
  assert.equal(h.blocked.length, 0, 'Sprachbausteine is a valid TELC section');
  h.session.openPart = 'sprachbausteine_1'; h.session.prefetched = 'telc-task';
  h.saved.key = 'Goethe|C1';
  await h.ctl.refresh();
  assert.equal(h.session.openPart, null);
  assert.equal(h.session.prefetched, null);
  // the still-open skill does not exist in the new exam: the workspace asks the view to leave it
  assert.equal(h.blocked.length, 1);
  assert.equal(h.blocked[0][0], 'sprachbausteine');
  assert.match(h.blocked[0][1], /no such section/);
});

test('race: a late response for the OLD exam never replaces the new exam, and is not cached under the new selection', async () => {
  const h = harness({ autoRespond: false });
  const p1 = h.ctl.refresh(); // TELC request starts
  h.saved.key = 'Goethe|C1'; // user saves Goethe
  const p2 = h.ctl.refresh(); // Goethe request starts
  assert.equal(h.fetches.length, 2);
  assert.equal(h.fetches[0].aborted, true, 'the superseded request is aborted');
  h.settle(h.fetches[1]);
  await p2;
  assert.equal(h.ctl.state.profileId, 'goethe_c1');
  // TELC response arrives late (an aborted fetch may still resolve)
  h.settle(h.fetches[0]);
  await p1;
  assert.equal(h.ctl.state.profileId, 'goethe_c1');
  assert.equal(h.ctl.state.status, 'ready');
  assert.deepEqual(ws.buildNavModel(h.ctl.state.manifest).map((m) => m.label), ['Lesen', 'Hören', 'Schreiben', 'Sprechen']);
  // and switching back to TELC fetches TELC fresh rather than reusing a mislabelled entry
  h.saved.key = 'telc|C1 Hochschule';
  const p3 = h.ctl.refresh();
  assert.equal(h.fetches.length, 3);
  h.settle(h.fetches[2]);
  await p3;
  assert.equal(h.ctl.state.profileId, 'telc_c1_hochschule');
});

test('race: a late failure for the old exam cannot flip the new exam to an error', async () => {
  const h = harness({ autoRespond: false });
  const p1 = h.ctl.refresh();
  h.saved.key = 'Goethe|C1';
  const p2 = h.ctl.refresh();
  h.settle(h.fetches[1]);
  await p2;
  h.fetches[0].reject(new Error('network'));
  await p1;
  assert.equal(h.ctl.state.status, 'ready');
  assert.equal(h.ctl.state.profileId, 'goethe_c1');
});

test('a throwing reset hook can never leave the UI on the previous exam', async () => {
  const saved = { key: 'telc|C1 Hochschule' };
  const rendered = [];
  const ctl = ws.createExamWorkspace(
    { resolveProfileId: () => null, savedProfileKey: () => saved.key, profileReady: () => true,
      onProfileChange: () => { throw new Error('reset hook blew up'); }, activeSkill: () => '', onActiveSkillBlocked: () => {} },
    { fetchManifest: async () => ({ profileId: SERVER[saved.key], manifest: MANIFESTS[SERVER[saved.key]] }), render: (s) => rendered.push(s.status) },
  );
  await ctl.refresh();
  saved.key = 'Goethe|C1';
  await ctl.refresh();
  assert.equal(ctl.state.profileId, 'goethe_c1');
  assert.equal(ctl.state.status, 'ready');
});

test('repeated events for the same saved exam neither reset state nor refetch', async () => {
  const h = harness();
  await h.ctl.refresh();
  const resetsBefore = h.resets.length;
  await h.ctl.refresh();
  await h.ctl.refresh();
  assert.equal(h.resets.length, resetsBefore);
  assert.equal(h.fetches.length, 1, 'the manifest is cached per saved selection');
});

test('profile still loading: loading state, nothing guessed; loads once ready', async () => {
  const h = harness();
  h.saved.ready = false;
  await h.ctl.refresh();
  assert.equal(h.ctl.state.status, 'loading');
  assert.equal(h.fetches.length, 0);
  h.saved.ready = true;
  await h.ctl.refresh();
  assert.equal(h.ctl.state.status, 'ready');
});

test('whenSettled resolves only after the new manifest is applied (what a Profile save waits on)', async () => {
  const h = harness({ startKey: 'telc|C1 Hochschule', autoRespond: false });
  h.saved.key = 'Goethe|C1';
  void h.ctl.refresh();
  let done = false;
  h.ctl.whenSettled().then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  h.settle(h.fetches[0]);
  await h.ctl.whenSettled();
  assert.equal(h.ctl.state.profileId, 'goethe_c1');
});

test('a failed manifest request shows an error state (retryable), never stale structure', async () => {
  const h = harness({ autoRespond: false });
  const p = h.ctl.refresh();
  h.fetches[0].reject(new Error('manifest_http_502'));
  await p;
  assert.equal(h.ctl.state.status, 'error');
  assert.equal(h.ctl.state.manifest, null);
});
