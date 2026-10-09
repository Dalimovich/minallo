// Real Chromium component integration: execute production renderer/grading/mapping functions for
// Goethe C1 Hören (multi_source_statement_matching, listening_tristate, segmented_dialogue_mc3,
// listening_detail_mc3) — the same style as reading-mc-browser.spec.mjs, but for the ls* (listening)
// side of practice.js. Deterministic fixture content only; no network, no real TTS/generation call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('frontend/views/practice/practice.js', root), 'utf8');
const manifests = JSON.parse(readFileSync(new URL('tests/e2e/fixtures/german-exam-manifests.json', root), 'utf8'));
const goetheListening = manifests.goethe_c1.modules.find((m) => m.id === 'listening');

function productionFunction(name) {
  const start = source.indexOf(`      function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n      }', start) + 8);
}
function productionVar(name, closer) {
  const start = source.indexOf(`      var ${name} = `);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf(closer, start) + closer.length);
}

// ── Pure-logic: manifest-driven part resolution (mirrors rdParts' own test) ──

test('lsParts/lsPart/lsFirstPartId/lsPartLabel resolve from the active manifest, not a hardcoded telc list', () => {
  const context = vm.createContext({ window: {}, ls: { partId: 'hoeren_2' } });
  vm.runInContext(
    ['lsParts', 'lsPart', 'lsPartLabel', 'lsFirstPartId'].map(productionFunction).join('\n') + '\n' +
    productionVar('LS_FALLBACK_PARTS', '];'),
    context
  );
  // No manifest yet: telc fallback.
  context.window._glExamState = () => ({ status: 'loading' });
  assert.equal(context.lsParts().length, 3);
  assert.equal(context.lsFirstPartId(), 'hv1');

  // Goethe C1 manifest active: all 4 hoeren parts, by their real ids — not hv1/hv2/hv3.
  context.window._glExamState = () => ({ status: 'ready', manifest: { modules: [goetheListening] } });
  const parts = context.lsParts();
  assert.deepEqual(parts.map((p) => p.id), ['hoeren_1', 'hoeren_2', 'hoeren_3', 'hoeren_4']);
  assert.equal(context.lsPart('hoeren_2').taskType, 'listening_tristate');
  assert.equal(context.lsPart('hv1'), null); // telc id does not leak into a Goethe profile
  // Every Goethe part is still gated (implemented:false in the fixture) -> no "first" part yet.
  assert.equal(context.lsFirstPartId(), null);
  assert.equal(context.lsPartLabel('hoeren_3').indexOf('Teil 3 ·'), 0);
});

// ── Pure-logic: lsMapGeneratedQuestion field-shape mapping for all 4 Goethe task types ──

test('lsMapGeneratedQuestion maps every Goethe Hören task type to the shape its renderer/grader expects', () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(productionFunction('lsMapGeneratedQuestion'), context);
  const map = context.lsMapGeneratedQuestion;
  const allSegmentIds = ['s1', 's2', 's3'];
  const speakerToSegment = { source_1: 's1', source_2: 's2', source_3: 's3' };

  // hoeren_1: multi_source_statement_matching — statement (not prompt), matching.correctSpeakerId.
  const q1 = map(
    { taskType: 'multi_source_statement_matching', title: 'Podcast' },
    { questionId: 'q1', statement: 'Quelle 2 sagt X.', skillTags: ['paraphrase_mapping'], difficulty: 'c1',
      matching: { correctSpeakerId: 'source_2', isDistractor: false } },
    speakerToSegment, allSegmentIds
  );
  assert.equal(q1.prompt, 'Quelle 2 sagt X.');
  // Array.from: q1.segmentIds was built inside the vm context's own realm, so a bare deepEqual
  // against a host-realm array literal spuriously fails on cross-realm identity, not content.
  assert.deepEqual(Array.from(q1.segmentIds), ['s2']);

  // hoeren_2: listening_tristate — statement + tristate.answer copied to base.answer for lsGradeMcqLikeType reuse.
  const q2 = map(
    { taskType: 'listening_tristate', title: 'Interview' },
    { questionId: 'q2', statement: 'Die Miete steigt jedes Jahr.', skillTags: ['detail_fact'], difficulty: 'c1',
      tristate: { answer: 'falsch', evidenceSegmentIds: ['s2'] } },
    {}, allSegmentIds
  );
  assert.equal(q2.prompt, 'Die Miete steigt jedes Jahr.');
  assert.equal(q2.answer, 'falsch');
  assert.deepEqual(Array.from(q2.segmentIds), ['s2']);
  // nicht_im_text legitimately has no evidence — falls back to the full audio, not an empty/broken replay.
  const q2b = map(
    { taskType: 'listening_tristate', title: 'Interview' },
    { questionId: 'q2b', statement: '...', tristate: { answer: 'nicht_im_text', evidenceSegmentIds: [] } },
    {}, allSegmentIds
  );
  assert.deepEqual(Array.from(q2b.segmentIds), allSegmentIds);

  // hoeren_3: segmented_dialogue_mc3 — mc3 shape + sectionId carried through.
  const q3 = map(
    { taskType: 'segmented_dialogue_mc3', title: 'Gespräch' },
    { questionId: 'q3', sectionId: 'sec2', skillTags: ['detail_fact'],
      mc3: { stem: 'Was sagt Sprecher B?', options: ['A', 'B', 'C'], correctIndex: 1, evidenceSegmentIds: ['s2'] } },
    {}, allSegmentIds
  );
  assert.equal(q3.prompt, 'Was sagt Sprecher B?');
  assert.equal(q3.sectionId, 'sec2');
  assert.equal(q3.mc3.correctIndex, 1);

  // hoeren_4: listening_detail_mc3 — identical mc3 shape, no sectionId.
  const q4 = map(
    { taskType: 'listening_detail_mc3', title: 'Vortrag' },
    { questionId: 'q4', mc3: { stem: 'Worum ging es?', options: ['A', 'B', 'C'], correctIndex: 2 } },
    {}, allSegmentIds
  );
  assert.equal(q4.mc3.correctIndex, 2);
  assert.equal(q4.sectionId, null);
});

// ── Browser: render, answer, check, grade for each of the 4 task types ──

test('Goethe Hören renderers/graders: correct option sets, official tristate wording, right/wrong grading', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div id="glListenTaskPanel"></div><div id="glListenPartSwitcher"></div></main>');
    await page.addScriptTag({
      content: `
      function _glEscape(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      var ls = { partId: 'hoeren_2', _speakerOrder: ['source_1', 'source_2', 'source_3'] };
      window._glExamState = () => ({ status: 'ready', manifest: { modules: [${JSON.stringify(goetheListening)}] } });
      ${['lsParts', 'lsPart', 'lsPartLabel', 'lsTristateLabels',
          'lsRenderSpeakerMatchingBody', 'lsGradeSpeakerMatchingType',
          'lsRenderTristateBody',
          'lsRenderMc3Body', 'lsGradeMc3Type'].map(productionFunction).join('\n')}
      ${productionVar('LS_TRISTATE_VALUES', '];')}
      ${productionVar('LS_TRISTATE_DEFAULT_LABELS', '];')}
      function lsGradeMcqLikeType(q, ans) { if (!ans._pending) return null; ans.selected = ans._pending; return ans.selected === q.answer; }
      window.lsRenderSpeakerMatchingBody = lsRenderSpeakerMatchingBody;
      window.lsGradeSpeakerMatchingType = lsGradeSpeakerMatchingType;
      window.lsRenderTristateBody = lsRenderTristateBody;
      window.lsGradeMcqLikeType = lsGradeMcqLikeType;
      window.lsRenderMc3Body = lsRenderMc3Body;
      window.lsGradeMc3Type = lsGradeMc3Type;
    ` });

    // hoeren_1 shape reused via lsRenderSpeakerMatchingBody/lsGradeSpeakerMatchingType.
    const q1 = { matching: { correctSpeakerId: 'source_2' } };
    const ans1 = {};
    await page.evaluate(({ q, html }) => { document.getElementById('glListenTaskPanel').innerHTML = html; },
      { q: q1, html: await page.evaluate((q) => window.lsRenderSpeakerMatchingBody(q, {}, false, false), q1) });
    assert.equal(await page.locator('#glListenTaskPanel .gl-listen-option').count(), 4); // 3 sources + "none of the speakers"
    ans1._pending = 'source_2';
    assert.equal(await page.evaluate((args) => window.lsGradeSpeakerMatchingType(args.q, args.a), { q: q1, a: ans1 }), true);
    ans1._pending = 'source_1';
    assert.equal(await page.evaluate((args) => window.lsGradeSpeakerMatchingType(args.q, args.a), { q: q1, a: ans1 }), false);

    // hoeren_2: official German tristate wording, sourced from the manifest's constraints, not hardcoded English.
    const q2 = { answer: 'nicht_im_text' };
    const tristateHtml = await page.evaluate((q) => window.lsRenderTristateBody(q, {}, false, false), q2);
    await page.evaluate((html) => { document.getElementById('glListenTaskPanel').innerHTML = html; }, tristateHtml);
    const optionTexts = await page.locator('#glListenTaskPanel .gl-listen-option span:last-child').allTextContents();
    assert.deepEqual(optionTexts, ['stimmt', 'stimmt nicht', 'dazu wird nichts gesagt']);
    const ans2 = { _pending: 'nicht_im_text' };
    assert.equal(await page.evaluate((args) => window.lsGradeMcqLikeType(args.q, args.a), { q: q2, a: ans2 }), true);

    // hoeren_3/4: shared mc3 renderer/grader (segmented_dialogue_mc3 and listening_detail_mc3 both
    // reuse sentence_completion_mc3's exact shape, confirmed against the backend's own validator reuse).
    const q3 = { mc3: { options: ['Alpha', 'Beta', 'Gamma'], correctIndex: 2 } };
    const mc3Html = await page.evaluate((q) => window.lsRenderMc3Body(q, {}, false, false), q3);
    await page.evaluate((html) => { document.getElementById('glListenTaskPanel').innerHTML = html; }, mc3Html);
    assert.equal(await page.locator('#glListenTaskPanel .gl-listen-option').count(), 3);
    const ans3 = { _pending: '2' };
    assert.equal(await page.evaluate((args) => window.lsGradeMc3Type(args.q, args.a), { q: q3, a: ans3 }), true);
  } finally { await browser.close(); }
});

// ── Browser: switcher reflects the active manifest's parts and gates on `implemented` ──

test('part switcher renders every Goethe Hören part id (not telc hv1/hv2/hv3) and disables ungated parts', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div id="glListenPartSwitcher"></div></main>');
    await page.addScriptTag({
      content: `
      function _glEscape(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function lsEl(id) { return document.getElementById(id); }
      var ls = { usingGenerated: false, partId: null };
      function lsGenerateOrLoadPart() { return Promise.resolve(); }
      function lsResetToPracticeTabChrome() {}
      function lsRenderPlayerChrome() {}
      function lsRenderWorkspace() {}
      function lsStartNewTest() {}
      window._glExamState = () => ({ status: 'ready', manifest: { modules: [${JSON.stringify(goetheListening)}] } });
      ${['lsParts', 'lsPart', 'lsPartLabel', 'lsWirePartSwitcher'].map(productionFunction).join('\n')}
      lsWirePartSwitcher();
    ` });
    // All 4 real Goethe part ids present, in the id="glListenPart<PARTID>" convention existing E2E
    // tests already rely on for telc (#glListenPartHV2 etc.) — just generalized to Goethe's own ids.
    for (const id of ['HOEREN_1', 'HOEREN_2', 'HOEREN_3', 'HOEREN_4']) {
      assert.equal(await page.locator('#glListenPart' + id).count(), 1, id);
    }
    // Still unavailable end to end (fixture's implemented:false) -> every part stays disabled, exactly
    // as Hören must until all 4 task types have a verified student path.
    assert.equal(await page.locator('#glListenPartSwitcher button:disabled').count(), 4);
    assert.equal(await page.locator('#glListenPartHV1').count(), 0); // telc ids do not leak into a Goethe switcher
  } finally { await browser.close(); }
});
