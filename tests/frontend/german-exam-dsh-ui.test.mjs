// DSH exam UI is generated from the exam profile/manifest — never a modified copy of another exam's screen.
//
// The manifests below are the REAL ones, generated from the Python profile files: telc/Goethe/TestDaF from
// tests/e2e/fixtures/german-exam-manifests.json and DSH from tests/frontend/fixtures/dsh-manifest.json (the
// backend branch adds a drift test for both; once DSH is in the shared fixture the shared one wins). They go
// through the real renderers. No DOM, no network. Assertions check what is PRESENT in the rendered structure —
// not whether something is merely hidden with CSS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFESTS = JSON.parse(readFileSync(resolve(ROOT, 'tests/e2e/fixtures/german-exam-manifests.json'), 'utf8'));
MANIFESTS.dsh ??= JSON.parse(readFileSync(resolve(ROOT, 'tests/frontend/fixtures/dsh-manifest.json'), 'utf8'));
const ws = await import('../../frontend/js/features/german-exam/exam-workspace.ts');
const preview = await import('../../frontend/js/features/german-exam/exam-structure-preview.ts');
const gp = await import('../../frontend/js/features/auth/german-profile.ts');

const DSH = MANIFESTS.dsh;
const ALL = ['telc_c1_hochschule', 'goethe_c1', 'testdaf_digital', 'dsh'];
const SAVED = {
  'telc|C1 Hochschule': 'telc_c1_hochschule',
  'Goethe|C1': 'goethe_c1',
  'TestDaF|TDN 4': 'testdaf_digital',
  'DSH|DSH-1': 'dsh',
  'DSH|DSH-2': 'dsh',
  'DSH|DSH-3': 'dsh',
};
const KEY_OF = { telc_c1_hochschule: 'telc|C1 Hochschule', goethe_c1: 'Goethe|C1', testdaf_digital: 'TestDaF|TDN 4', dsh: 'DSH|DSH-2' };
const EXAM_SKILLS = ['reading', 'listening', 'sprachbausteine', 'writing'];
const visibleCards = (state) => EXAM_SKILLS.filter((s) => !ws.staticExamCardState(state, s).hidden);
const ready = (id) => ({ profileId: id, manifest: MANIFESTS[id], status: 'ready' });
const moduleIds = (html) => [...html.matchAll(/data-exam-module="([^"]+)"/g)].map((m) => m[1]);

/** A workspace wired to fakes; the "server" answers with the manifest of the saved key at REQUEST time. */
function harness(startKey) {
  const saved = { key: startKey };
  const requests = [];
  const renders = [];
  const ctl = ws.createExamWorkspace(
    {
      resolveProfileId: () => null,
      savedProfileKey: () => saved.key,
      profileReady: () => true,
      onProfileChange: () => {},
      activeSkill: () => '',
      onActiveSkillBlocked: () => {},
    },
    {
      fetchManifest: async () => {
        const key = saved.key;
        requests.push(key);
        const profileId = SAVED[key];
        return { profileId, manifest: MANIFESTS[profileId] };
      },
      render: (s) => renders.push({ status: s.status, profileId: s.profileId, html: s.manifest ? ws.renderOverviewHtml(s.manifest) : '', state: { ...s } }),
    },
  );
  return { saved, requests, renders, ctl, last: () => renders[renders.length - 1] };
}

// ---- 1. onboarding -------------------------------------------------------------------------
test('1. onboarding offers DSH-1/2/3 and its preview has the DSH structure without Sprachbausteine', () => {
  assert.deepEqual(gp.GERMAN_TEST_LEVELS.DSH, ['DSH-1', 'DSH-2', 'DSH-3']);
  assert.equal(gp.GERMAN_TEST_LABELS.DSH, 'DSH');
  for (const level of ['DSH-1', 'DSH-2', 'DSH-3']) {
    assert.equal(gp.isValidGermanTestLevel('DSH', level), true);
    assert.equal(gp.resolveGermanExamProfileIdClient('DSH', level), 'dsh');
    const html = preview.renderExamPreviewHtml(preview.previewForSelection('DSH', level));
    assert.deepEqual(moduleIds(html), ['listening', 'reading', 'scientific_structures', 'writing', 'speaking']);
    assert.doesNotMatch(html, /sprachbaustein/i);
    assert.match(html, /data-exam-module-code="HV"[\s\S]*data-exam-module-code="LV"[\s\S]*data-exam-module-code="WS"[\s\S]*data-exam-module-code="TP"/);
    assert.match(html, /Wissenschaftssprachliche Strukturen/);
    assert.match(html, /Mündliche Prüfung/);
    assert.match(html, /individual universities may have registered local regulations/);
  }
  assert.equal(preview.previewForSelection('DSH', ''), null); // no level chosen yet: nothing to describe
  assert.equal(preview.previewForSelection('DSH', 'C1'), null);
});

test('onboarding preview of another exam does not contain DSH structure, and vice versa', () => {
  const telc = preview.renderExamPreviewHtml(preview.previewForSelection('telc', 'C1 Hochschule'));
  assert.match(telc, /Sprachbausteine/);
  assert.doesNotMatch(telc, /data-exam-module-code|Wissenschaftssprachliche|HV|Textproduktion/);
});

// ---- 2/3. navigation/overview from the DSH profile ------------------------------------------
test('2+3. the DSH navigation has exactly HV/LV/WS/TP/Mündliche Prüfung and no Sprachbausteine', () => {
  const nav = ws.buildNavModel(DSH);
  assert.deepEqual(nav.map((m) => [m.id, m.code, m.label]), [
    ['listening', 'HV', 'Hörverstehen'],
    ['reading', 'LV', 'Leseverstehen'],
    ['scientific_structures', 'WS', 'Wissenschaftssprachliche Strukturen'],
    ['writing', 'TP', 'Textproduktion'],
    ['speaking', null, 'Mündliche Prüfung'],
  ]);
  assert.equal(nav.some((m) => m.skill === 'sprachbausteine' || m.id === 'language_elements'), false);
  assert.deepEqual(nav.map((m) => m.partCount), [1, 1, 1, 1, 1]);
  const html = ws.renderOverviewHtml(DSH);
  assert.deepEqual(moduleIds(html), ['listening', 'reading', 'scientific_structures', 'writing', 'speaking']);
  assert.doesNotMatch(html, /sprachbaustein/i);
  assert.match(html, /DSH practice based on the HRK framework/);
  assert.match(html, /gl-exam-disclaimer/);
});

test('unavailable does not mean invisible: every DSH module and part is shown with the standard unavailable state', () => {
  const html = ws.renderOverviewHtml(DSH);
  assert.equal((html.match(/coming soon/g) || []).length, 5); // one standard unavailable chip per module
  assert.equal(ws.buildNavModel(DSH).flatMap((m) => m.parts).length, 5);
  assert.ok(ws.buildNavModel(DSH).flatMap((m) => m.parts).every((p) => p.implemented === false));
  assert.ok(ws.buildNavModel(DSH).every((m) => m.available === false && m.availableParts === 0));
  assert.match(ws.skillBlockReason(ready('dsh'), 'reading'), /coming soon/);
  assert.match(ws.skillBlockReason(ready('dsh'), 'sprachbausteine'), /no such section/);
});

test('DSH shows no static legacy exam card and no chatbot exam link at all; the others keep theirs', () => {
  assert.deepEqual(visibleCards(ready('dsh')), []);
  for (const skill of ['reading', 'listening', 'sprachbausteine']) assert.equal(ws.chatPanelLinkHidden(ready('dsh'), skill), true);
  assert.deepEqual(visibleCards(ready('telc_c1_hochschule')), ['reading', 'listening', 'sprachbausteine', 'writing']);
  assert.deepEqual(visibleCards(ready('goethe_c1')), ['reading', 'listening', 'writing']);
  assert.deepEqual(visibleCards(ready('testdaf_digital')), ['reading', 'listening', 'writing']);
  assert.equal(ws.chatPanelLinkHidden(ready('telc_c1_hochschule'), 'sprachbausteine'), false);
  assert.equal(ws.chatPanelLinkHidden(ready('goethe_c1'), 'sprachbausteine'), true); // exam has no such module
  assert.equal(ws.chatPanelLinkHidden(ready('dsh'), 'vocab'), false); // general practice is not an exam module
});

test('while a manifest loads or fails, no exam card or link is shown (never a previous exam)', () => {
  for (const status of ['loading', 'error']) {
    const state = { profileId: null, manifest: null, status };
    assert.deepEqual(visibleCards(state), []);
    assert.equal(ws.chatPanelLinkHidden(state, 'sprachbausteine'), true);
  }
});

// ---- 4-9. profile switching ---------------------------------------------------------------------
const FOREIGN = {
  telc_c1_hochschule: ['Sprachbausteine', 'Lesen', 'Hören', 'Schreiben', 'Sprechen'],
  goethe_c1: ['Goethe', 'Lesen', 'Hören', 'Schreiben', 'Sprechen'],
  testdaf_digital: ['TestDaF', 'Lesen', 'Hören', 'Schreiben', 'Sprechen'],
};

for (const from of ['telc_c1_hochschule', 'goethe_c1', 'testdaf_digital']) {
  test(`4-8. ${from} -> DSH removes the old exam's UI, then DSH -> ${from} restores it`, async () => {
    const h = harness(KEY_OF[from]);
    await h.ctl.refresh();
    const before = h.last();
    assert.equal(before.profileId, from);
    assert.deepEqual(moduleIds(before.html), MANIFESTS[from].modules.map((m) => m.id));

    h.saved.key = KEY_OF.dsh;
    const p = h.ctl.refresh();
    // immediately after the switch: loading, and NOT a single module of the previous exam
    assert.equal(h.ctl.state.status, 'loading');
    assert.equal(h.ctl.state.manifest, null);
    assert.equal(h.last().html, '');
    assert.deepEqual(visibleCards(h.ctl.state), []);
    await p;
    const dsh = h.last();
    assert.equal(dsh.profileId, 'dsh');
    assert.deepEqual(moduleIds(dsh.html), ['listening', 'reading', 'scientific_structures', 'writing', 'speaking']);
    for (const word of FOREIGN[from]) assert.equal(dsh.html.includes(word), false, `stale "${word}" from ${from} left in the DSH structure`);
    assert.deepEqual(visibleCards(h.ctl.state), []);

    h.saved.key = KEY_OF[from];
    await h.ctl.refresh();
    const back = h.last();
    assert.equal(back.profileId, from);
    assert.equal(back.html, before.html); // byte-identical restore of the previous exam's structure
    assert.equal(back.html.includes('DSH'), false);
    assert.equal(back.html.includes('Wissenschaftssprachliche'), false);
    assert.deepEqual(visibleCards(h.ctl.state), visibleCards(ready(from)));
  });
}

test('9. no stale module counts: every switch shows exactly the target exam part counts', async () => {
  const h = harness(KEY_OF.telc_c1_hochschule);
  await h.ctl.refresh();
  for (const id of ['dsh', 'goethe_c1', 'dsh', 'testdaf_digital', 'telc_c1_hochschule', 'dsh']) {
    h.saved.key = KEY_OF[id];
    await h.ctl.refresh();
    assert.deepEqual(ws.buildNavModel(h.ctl.state.manifest).map((m) => [m.id, m.partCount]), MANIFESTS[id].modules.map((m) => [m.id, m.parts.length]));
    assert.equal(h.last().profileId, id);
  }
});

test('10. no request uses the previous exam profile: generation bodies come only from the current ready state', async () => {
  const h = harness(KEY_OF.telc_c1_hochschule);
  await h.ctl.refresh();
  const staleState = h.ctl.state; // a mounted workspace holds this same object
  assert.equal(ws.buildGenerateRequestBody(staleState, 'language_elements', 'sprachbausteine_1').profileId, 'telc_c1_hochschule');
  h.saved.key = KEY_OF.dsh;
  const p = h.ctl.refresh();
  assert.throws(() => ws.buildGenerateRequestBody(staleState, 'language_elements', 'sprachbausteine_1'), /exam_not_ready/); // mid-switch
  await p;
  // after the switch the SAME object describes DSH: telc's part is gone, and the profile id is DSH's
  assert.throws(() => ws.buildGenerateRequestBody(staleState, 'language_elements', 'sprachbausteine_1'), /part_not_in_current_exam/);
  assert.deepEqual(ws.buildGenerateRequestBody(staleState, 'reading', 'lv_1'), { profileId: 'dsh', module: 'reading', partId: 'lv_1', mode: 'adaptive_practice' });
  // and every manifest request was made for the key that was saved at that moment
  assert.deepEqual(h.requests, [KEY_OF.telc_c1_hochschule, KEY_OF.dsh]);
});

test('10b. a slow response for the OLD selection is discarded and never applied to DSH', async () => {
  const saved = { key: KEY_OF.telc_c1_hochschule };
  const gates = [];
  const ctl = ws.createExamWorkspace(
    { resolveProfileId: () => null, savedProfileKey: () => saved.key, profileReady: () => true, onProfileChange: () => {}, activeSkill: () => '', onActiveSkillBlocked: () => {} },
    {
      fetchManifest: (signal) => new Promise((resolve, reject) => {
        const key = saved.key;
        gates.push({ key, resolve: () => resolve({ profileId: SAVED[key], manifest: MANIFESTS[SAVED[key]] }) });
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      render: () => {},
    },
  );
  const first = ctl.refresh();
  saved.key = KEY_OF.dsh;
  const second = ctl.refresh();
  gates[0].resolve(); // telc answers late
  gates[1]?.resolve();
  await Promise.all([first, second]);
  assert.equal(ctl.state.profileId, 'dsh');
  assert.equal(ctl.state.manifest.modules.some((m) => m.id === 'language_elements'), false);
});

test('11. reloading while DSH is selected keeps the DSH structure', async () => {
  const first = harness(KEY_OF.dsh);
  await first.ctl.refresh();
  const reloaded = harness(KEY_OF.dsh); // a new page load = a new workspace over the same saved selection
  await reloaded.ctl.refresh();
  assert.equal(reloaded.last().profileId, 'dsh');
  assert.equal(reloaded.last().html, first.last().html);
  assert.deepEqual(reloaded.requests, [KEY_OF.dsh]);
  assert.deepEqual(visibleCards(reloaded.ctl.state), []);
});

test('12. DSH-1 / DSH-2 / DSH-3 never change the underlying DSH structure', async () => {
  const seen = [];
  for (const level of ['DSH-1', 'DSH-2', 'DSH-3']) {
    const h = harness(`DSH|${level}`);
    await h.ctl.refresh();
    seen.push(h.last().html);
    assert.equal(h.last().profileId, 'dsh');
  }
  assert.equal(new Set(seen).size, 1);
  const previews = ['DSH-1', 'DSH-2', 'DSH-3'].map((l) => JSON.stringify(preview.previewForSelection('DSH', l)));
  assert.equal(new Set(previews).size, 1);
});

// ---- generic-ness & leakage --------------------------------------------------------------------------
test('the frontend has no per-exam branching: DSH appears only as data, never as a code path', () => {
  for (const file of ['exam-workspace.ts', 'exam-structure-preview.ts', 'task-workspace.ts']) {
    // Only CODE is scanned: comments and the generated data block (which legitimately has a "dsh" entry) are not.
    const src = readFileSync(resolve(ROOT, 'frontend/js/features/german-exam', file), 'utf8')
      .replace(/\/\* GENERATED:BEGIN \*\/[\s\S]*?\/\* GENERATED:END \*\//, '')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(src, /['"`]dsh['"`]|=== ?['"`]DSH['"`]|profileId ?=== ?['"`]/i, file);
  }
});

test('legacy exams keep the exact overview they had (no code badge, no part list, no disclaimer)', () => {
  for (const id of ['telc_c1_hochschule', 'goethe_c1', 'testdaf_digital']) {
    const html = ws.renderOverviewHtml(MANIFESTS[id]);
    assert.doesNotMatch(html, /gl-exam-code|gl-exam-modules--manifest|gl-exam-disclaimer/);
  }
});

test('the profile registries map every DSH level to the one dsh profile in every layer', () => {
  for (const id of ALL) assert.ok(MANIFESTS[id], `manifest fixture is missing ${id}`);
  for (const level of ['DSH-1', 'DSH-2', 'DSH-3']) assert.equal(SAVED[`DSH|${level}`], gp.resolveGermanExamProfileIdClient('DSH', level));
});
