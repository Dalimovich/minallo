// The general rule behind every exam screen: an exam shows EXACTLY the sections its own manifest lists.
//   * a section that only some exams have (Sprachbausteine, DSH's WS, ...) is absent from all the others;
//   * a section added to one exam later appears only in that exam.
// Checked against the real generated manifests, for the overview, the practice cards and the chatbot links,
// and against a synthetic new section so the rule cannot silently depend on today's exam list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFESTS = JSON.parse(readFileSync(resolve(ROOT, 'tests/e2e/fixtures/german-exam-manifests.json'), 'utf8'));
MANIFESTS.dsh ??= JSON.parse(readFileSync(resolve(ROOT, 'tests/frontend/fixtures/dsh-manifest.json'), 'utf8'));
const ws = await import('../../frontend/js/features/german-exam/exam-workspace.ts');

const ids = Object.keys(MANIFESTS);
const ready = (manifest) => ({ profileId: manifest.profileId, manifest, status: 'ready' });
const moduleIds = (manifest) => manifest.modules.map((m) => m.id);
const overviewModules = (manifest) => [...ws.renderOverviewHtml(manifest).matchAll(/data-exam-module="([^"]+)"/g)].map((m) => m[1]);
const CARD_SKILLS = ['reading', 'listening', 'sprachbausteine', 'writing'];
// the legacy card/link for a skill exists only when the manifest has the module mapped to that skill
const expectedSkills = (manifest) =>
  manifest.presentation?.moduleCards === 'manifest'
    ? []
    : CARD_SKILLS.filter((skill) => manifest.modules.some((m) => ws.MODULE_SKILL[m.id] === skill));

test('every exam overview lists exactly its own manifest sections, in its own order', () => {
  for (const id of ids) assert.deepEqual(overviewModules(MANIFESTS[id]), moduleIds(MANIFESTS[id]), id);
});

test('a section that is not in an exam manifest never appears in that exam', () => {
  for (const id of ids) {
    const own = new Set(moduleIds(MANIFESTS[id]));
    for (const other of ids) {
      if (other === id) continue;
      for (const moduleId of moduleIds(MANIFESTS[other])) {
        if (own.has(moduleId)) continue;
        assert.equal(overviewModules(MANIFESTS[id]).includes(moduleId), false, `${moduleId} (only in ${other}) leaked into ${id}`);
        assert.equal(ws.buildNavModel(MANIFESTS[id]).some((m) => m.id === moduleId), false);
      }
    }
  }
});

test('practice cards and chatbot links exist exactly for the sections the exam has', () => {
  for (const id of ids) {
    const state = ready(MANIFESTS[id]);
    const expected = expectedSkills(MANIFESTS[id]);
    const cards = CARD_SKILLS.filter((s) => !ws.staticExamCardState(state, s).hidden);
    const links = CARD_SKILLS.filter((s) => !ws.chatPanelLinkHidden(state, s));
    assert.deepEqual(cards, expected, `${id} cards`);
    assert.deepEqual(links, expected, `${id} chatbot links`);
  }
});

test('the chatbot Sprechen link follows the manifest too', () => {
  for (const id of ids) assert.equal(ws.chatSpeakingLinkHidden(ready(MANIFESTS[id])), !moduleIds(MANIFESTS[id]).includes('speaking'), id);
  const noSpeaking = structuredClone(MANIFESTS.dsh);
  noSpeaking.modules = noSpeaking.modules.filter((m) => m.id !== 'speaking');
  assert.equal(ws.chatSpeakingLinkHidden(ready(noSpeaking)), true);
  assert.equal(ws.chatSpeakingLinkHidden({ profileId: null, manifest: null, status: 'loading' }), true);
});

test('Sprachbausteine shows for the exam that has it and for no other', () => {
  const withIt = ids.filter((id) => moduleIds(MANIFESTS[id]).includes('language_elements'));
  assert.deepEqual(withIt, ['telc_c1_hochschule']);
  for (const id of ids) {
    const visible = !ws.staticExamCardState(ready(MANIFESTS[id]), 'sprachbausteine').hidden;
    assert.equal(visible, withIt.includes(id), id);
    assert.equal(overviewModules(MANIFESTS[id]).includes('language_elements'), withIt.includes(id), id);
  }
});

test('a NEW section added to one exam appears only in that exam', () => {
  for (const target of ids) {
    const changed = structuredClone(MANIFESTS);
    changed[target].modules.push({
      id: 'vocabulary_in_context', label: 'Wortschatz im Kontext', durationSeconds: null, preparationSeconds: null, note: null,
      parts: [{ id: 'wk_1', title: 'Wortschatz', taskType: 'x', implemented: false }],
    });
    for (const id of ids) {
      const shown = overviewModules(changed[id]).includes('vocabulary_in_context');
      assert.equal(shown, id === target, `${id} vs new section of ${target}`);
      assert.equal(ws.buildNavModel(changed[id]).some((m) => m.label === 'Wortschatz im Kontext'), id === target);
    }
  }
});

test('removing a section from one exam removes it there and changes nothing in the others', () => {
  const changed = structuredClone(MANIFESTS);
  changed.telc_c1_hochschule.modules = changed.telc_c1_hochschule.modules.filter((m) => m.id !== 'language_elements');
  assert.equal(overviewModules(changed.telc_c1_hochschule).includes('language_elements'), false);
  assert.equal(ws.staticExamCardState(ready(changed.telc_c1_hochschule), 'sprachbausteine').hidden, true);
  for (const id of ids.filter((x) => x !== 'telc_c1_hochschule')) assert.deepEqual(overviewModules(changed[id]), overviewModules(MANIFESTS[id]));
});

test('the unavailable state is per section: only the sections without a generatable part say "coming soon"', () => {
  const m = structuredClone(MANIFESTS.telc_c1_hochschule);
  const reading = ws.buildNavModel(m).find((x) => x.id === 'reading');
  assert.equal(reading.available, true); // telc reading is generatable today
  const html = ws.renderOverviewHtml(MANIFESTS.dsh);
  assert.equal((html.match(/coming soon/g) || []).length, MANIFESTS.dsh.modules.length); // every DSH section, none of telc's
});
