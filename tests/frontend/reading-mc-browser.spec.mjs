// Real Chromium component integration: execute production renderer/navigation functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);
const source = readFileSync(new URL('frontend/views/practice/practice.js', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('tests/e2e/fixtures/german-exam-manifests.json', root), 'utf8')).testdaf_digital;
function productionFunction(name) {
  const start = source.indexOf(`      function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n      }', start) + 8);
}

test('manifest scores preserve fixed-per-item exams and leave uncalibrated scores empty', () => {
  const manifests = JSON.parse(readFileSync(new URL('tests/e2e/fixtures/german-exam-manifests.json', root), 'utf8'));
  const context = vm.createContext({ window: {}, rd: {partId: 'lesen_3'}, RD_FALLBACK_PARTS: [] });
  vm.runInContext(['rdParts','rdPart','rdPointsPerCorrect'].map(productionFunction).join('\n'), context);
  context.window._glExamState = () => ({status:'ready', manifest:manifests.telc_c1_hochschule});
  assert.equal(context.rdPointsPerCorrect(), 2);
  context.window._glExamState = () => ({status:'ready', manifest});
  assert.equal(context.rdPointsPerCorrect(), null);
});

test('generic MC renders four unlabeled options, numbering, changeable answers and grading', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const parts = structuredClone(manifest.modules[0].parts);
    // Exercise the release candidate without enabling an unapproved profile in production.
    parts.find(p => p.taskType === 'reading_multiple_choice').implemented = true;
    const mc = parts.find(p => p.implemented);
    const data = {
      presentation: mc.constraints.presentation,
      text: { title: '<script>unsafe</script>', paragraphs: Array.from({ length: 6 }, (_, i) => ({ paragraphId: `p${i+1}`, text: `Absatz ${i+1}` })) },
      questions: Array.from({ length: 7 }, (_, i) => ({ questionId: `q${i+1}`, skillTags: [], mc3: { stem: `Frage ${i+1}?`, options: ['Alpha', 'Beta', 'Gamma', 'Delta'], correctIndex: 3 } })),
    };
    await page.setContent('<main><div id="glReadingWorkspace"><section id="glReadingTextPanel"></section><section id="glReadingQuestionPanel"></section></div></main>');
    await page.addStyleTag({ content: readFileSync(new URL('frontend/views/practice/practice.css', root), 'utf8') });
    await page.addScriptTag({ content: `
      var rd = {content:${JSON.stringify(data)}, partId:${JSON.stringify(mc.id)}, genAnswers:{}, genChecked:false};
      var RD_FALLBACK_PARTS = [];
      window._glExamState = () => ({status:'ready', manifest:{modules:[{id:'reading',parts:${JSON.stringify(parts)}}]}});
      function _glEscape(v) { return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      function rdEl(id) { return document.getElementById(id); }
      function rdGeneratedHeader() { return 'Reading practice'; }
      function rdShowWeakAreas() {}
      function rdStartNewTest() {}
      function rdGenerateOrLoadPart(id) { window.requestedPart = id; }
      ${['rdParts','rdPart','rdTaskTypeFor','rdPartLabel','rdFirstPartId','rdEnsureGeneratedSwitcher','rdRenderMultipleChoice','rdGradeMultipleChoice','rdCheckButtonHtml','rdWireCheckButton'].map(productionFunction).join('\n')}
      function rdCheckGeneratedAnswers() { window.results = rdGradeMultipleChoice(); rd.genChecked = true; rdRenderMultipleChoice(); }
      rdEnsureGeneratedSwitcher(); rdRenderMultipleChoice();
    ` });
    assert.equal(await page.locator('[data-part-id]').count(), 7);
    assert.equal(await page.locator('[data-part-id]:disabled').count(), 6);
    assert.equal(await page.locator('input[type=radio]').count(), 28);
    assert.equal(await page.locator('[data-paragraph-id] strong').first().textContent(), '(1)');
    assert.equal(await page.locator('.gl-reading-mc3-option span').count(), 0);
    assert.equal(await page.locator('#glReadingTextPanel script').count(), 0);
    await page.locator('[data-part-id]:enabled').click();
    assert.equal(await page.evaluate(() => window.requestedPart), mc.id);
    await page.locator('[name="mc3-q1"][value="0"]').check();
    await page.locator('[name="mc3-q1"][value="3"]').check();
    assert.equal(await page.locator('[name="mc3-q1"]:checked').count(), 1);
    await page.getByRole('button', {name:'Check answers'}).click();
    assert.equal(await page.evaluate(() => window.results.q1.correct), true);
    assert.equal(await page.evaluate(() => window.results.q2.correct), false);
    assert.equal(await page.locator('input[type=radio]:disabled').count(), 28);
    assert.equal(await page.locator('.gl-reading-opt-correct').count(), 7);
  } finally { await browser.close(); }
});
