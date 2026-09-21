// Profile-driven exam workspace: navigation comes from the manifest, never a hard-coded TELC list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ws = await import('../../frontend/js/features/german-exam/exam-workspace.ts');

const part = (id, implemented = true) => ({ id, title: id, taskType: 't', implemented });
const mod = (id, label, n, implemented = true, durationSeconds = null) => ({
  id, label, durationSeconds, preparationSeconds: null, note: null,
  parts: Array.from({ length: n }, (_, i) => part(`${id}_${i + 1}`, implemented)),
});
const TELC = {
  profileId: 'telc_c1_hochschule', profileVersion: 5, displayName: 'telc Deutsch C1 Hochschule', cefrLevel: 'C1',
  modules: [mod('reading', 'Lesen', 3), mod('listening', 'Hören', 3), mod('language_elements', 'Sprachbausteine', 1),
    mod('writing', 'Schreiben', 1, true, 4200), mod('speaking', 'Sprechen', 2)],
};
const GOETHE = {
  profileId: 'goethe_c1', profileVersion: 1, displayName: 'Goethe-Zertifikat C1', cefrLevel: 'C1',
  modules: [mod('reading', 'Lesen', 4, false, 3900), mod('listening', 'Hören', 4, false, 2400),
    mod('writing', 'Schreiben', 2, false, 4500), mod('speaking', 'Sprechen', 2, false)],
};

test('TELC nav keeps Sprachbausteine; Goethe nav has exactly four modules and none of it', () => {
  assert.deepEqual(ws.buildNavModel(TELC).map((m) => m.label), ['Lesen', 'Hören', 'Sprachbausteine', 'Schreiben', 'Sprechen']);
  const g = ws.buildNavModel(GOETHE);
  assert.deepEqual(g.map((m) => m.label), ['Lesen', 'Hören', 'Schreiben', 'Sprechen']);
  assert.deepEqual(g.map((m) => m.partCount), [4, 4, 2, 2]);
  assert.equal(g.some((m) => m.skill === 'sprachbausteine'), false);
  assert.equal(g[0].durationLabel, '65 min');
});

test('overview shows the exam name and part counts, and no Sprachbausteine for Goethe', () => {
  const html = ws.renderOverviewHtml(GOETHE);
  assert.match(html, /Goethe-Zertifikat C1/);
  assert.match(html, /Prepare for your actual exam format/);
  assert.match(html, /4 parts/);
  assert.doesNotMatch(html, /Sprachbausteine/);
  assert.match(ws.renderOverviewHtml(TELC), /Sprachbausteine/);
});

test('overview escapes manifest text', () => {
  const html = ws.renderOverviewHtml({ ...TELC, displayName: '<img src=x onerror=1>' });
  assert.doesNotMatch(html, /<img/);
});

test('profile change detection', () => {
  assert.equal(ws.profileChanged('telc_c1_hochschule', 'goethe_c1'), true);
  assert.equal(ws.profileChanged('goethe_c1', 'goethe_c1'), false);
  assert.equal(ws.profileChanged(null, 'goethe_c1'), true);
  assert.equal(ws.profileChanged('', null), false);
});

test('skills the exam lacks or cannot generate yet are blocked, never routed to another exam', () => {
  const goethe = { profileId: 'goethe_c1', manifest: GOETHE, status: 'ready' };
  assert.match(ws.skillBlockReason(goethe, 'sprachbausteine'), /no such section/);
  assert.match(ws.skillBlockReason(goethe, 'reading'), /coming soon/); // no part generatable yet
  // as soon as ONE part of a module is generatable the module opens (the other parts stay disabled)
  const partial = { profileId: 'goethe_c1', status: 'ready', manifest: { ...GOETHE, modules: [{ ...mod('reading', 'Lesen', 4, false), parts: [part('lesen_1', false), part('lesen_2', false), part('lesen_3', true), part('lesen_4', false)] }] } };
  assert.equal(ws.skillBlockReason(partial, 'reading'), '');
  assert.match(ws.renderOverviewHtml(partial.manifest), /1 of 4 ready/);
  const telc = { profileId: 'telc_c1_hochschule', manifest: TELC, status: 'ready' };
  for (const s of ['reading', 'listening', 'sprachbausteine', 'writing']) assert.equal(ws.skillBlockReason(telc, s), '');
  // general practice skills and not-yet-loaded manifests are never blocked
  assert.equal(ws.skillBlockReason(goethe, 'vocab'), '');
  assert.equal(ws.skillBlockReason({ profileId: null, manifest: null, status: 'loading' }, 'reading'), '');
});

test('part availability: pending while loading, no for parts the exam lacks', () => {
  const telc = { profileId: 'p', manifest: { ...TELC, modules: [mod('listening', 'Hören', 3)] }, status: 'ready' };
  assert.equal(ws.partAvailability({ profileId: null, manifest: null, status: 'loading' }, 'listening', 'listening_1'), 'pending');
  assert.equal(ws.partAvailability(telc, 'listening', 'listening_1'), 'yes');
  assert.equal(ws.partAvailability(telc, 'listening', 'hv9'), 'no');
  assert.equal(ws.partAvailability({ profileId: 'g', manifest: GOETHE, status: 'ready' }, 'listening', 'listening_1'), 'no');
});

test('manifest fetch sends no client profile id and rejects a mismatched manifest', async () => {
  let sent;
  const ok = async (url, init) => { sent = { url, init }; return { ok: true, status: 200, json: async () => ({ profileId: 'goethe_c1', manifest: GOETHE }) }; };
  const data = await ws.fetchManifest(ok, '');
  assert.equal(data.profileId, 'goethe_c1');
  assert.equal(sent.init.body, '{}');
  const bad = async () => ({ ok: true, status: 200, json: async () => ({ profileId: 'telc_c1_hochschule', manifest: GOETHE }) });
  await assert.rejects(() => ws.fetchManifest(bad, ''), /manifest_mismatch/);
  const unsupported = async () => ({ ok: false, status: 422, json: async () => ({}) });
  await assert.rejects(() => ws.fetchManifest(unsupported, ''), (e) => e.unsupported === true);
});

test('the workspace has no exam-specific branching and the practice view is wired to it', () => {
  const src = readFileSync(resolve(ROOT, 'frontend/js/features/german-exam/exam-workspace.ts'), 'utf8');
  assert.doesNotMatch(src, /['"`](goethe_c1|telc_c1_hochschule)['"`]/);
  const practice = readFileSync(resolve(ROOT, 'frontend/views/practice/practice.js'), 'utf8');
  assert.match(practice, /_glExamSkillBlocked/);
  assert.match(practice, /_glRegisterProfileReset/);
  assert.match(practice, /initExamWorkspace/);
});

test('the Reading view takes its parts, task types and per-item points from the exam manifest', () => {
  const practice = readFileSync(resolve(ROOT, 'frontend/views/practice/practice.js'), 'utf8');
  // no exam-specific part table left except the telc fallback used before a manifest exists
  assert.doesNotMatch(practice, /RD_PART_TASK_TYPES|RD_PART_LABELS/);
  assert.match(practice, /function rdParts\(\)/);
  assert.match(practice, /window\._glExamState/);
  assert.match(practice, /rdPointsPerCorrect\(\)/);
  // renderers and graders are dispatched by task type, one entry per task type
  for (const taskType of ['text_reconstruction_sentence_matching', 'section_statement_matching', 'detail_tristate_with_global_heading', 'reading_detail_mc3', 'multi_author_statement_matching_with_none']) {
    assert.match(practice, new RegExp(`${taskType}: rdRender`), `renderer for ${taskType}`);
    assert.match(practice, new RegExp(`${taskType}: rdGrade`), `grader for ${taskType}`);
  }
  // the candidate legend must be able to label 10 candidates (Goethe Teil 3), not just 8
  assert.match(practice, /RD_LETTERS = 'ABCDEFGHIJKL'/);
  assert.doesNotMatch(practice, /var letters = 'ABCDEFGH';\s*return _glEscape\(text\)/);
});
