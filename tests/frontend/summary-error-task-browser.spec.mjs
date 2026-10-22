import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';

function bundle(relativePath) {
  return ts.transpileModule(readFileSync(new URL(relativePath, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
// Both modules transpile to CommonJS requiring each other by relative path; concatenate with a
// tiny require() shim so the browser-loaded bundle resolves './productive-task.js' to the same
// `exports` object, exactly like the real ESM graph would.
const productiveCode = bundle('../../frontend/js/features/german-exam/productive-task.ts');
const summaryErrorCode = bundle('../../frontend/js/features/german-exam/summary-error-task.ts');
const code = `
var __modules = {};
(function(){ var exports = __modules['productive'] = {}; ${productiveCode} })();
(function(){ var exports = {}; var require = function(p){ return __modules['productive']; }; ${summaryErrorCode} window.summaryError = exports; })();
`;

const part = { constraints: { itemCount: 3, requiredSourceKinds: ['text', 'graphic'] } };
const content = {
  sources: [
    { id: 's1', kind: 'text', text: 'Ein Lesetext über Haustiere <img src=x onerror="window.pwned=true">.' },
    { id: 's2', kind: 'graphic', graphic: { title: 'Kosten', unit: 'Euro', columns: [{ id: 'c1', label: 'Jahr' }], rows: [{ id: 'r1', label: '2024', values: { c1: 500 } }] } },
  ],
  questions: Array.from({ length: 9 }, (_, i) => ({ questionId: `sent${i + 1}`, text: `Satz ${i + 1} der Zusammenfassung.`, skillTags: ['detail_comprehension'] })),
  correctIds: ['sent2', 'sent5', 'sent8'],
};

test('reading_summary_error_detection: browser rendering, toggle cap, grading and disposal', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent('<main><div id="root"></div></main>');
    await page.addScriptTag({ content: code });
    await page.evaluate(({ part, content }) => {
      window.part = part; window.content = content;
      window.dispose = window.summaryError.mountSummaryError(document.querySelector('#root'), part, content);
    }, { part, content });

    assert.equal(await page.locator('table').count(), 1); // the graphic renders as a table
    assert.equal(await page.locator('img').count(), 0); // source text is never injected as HTML
    assert.equal(await page.locator('[data-question-id]').count(), 9);

    // Select 3 correct sentences.
    for (const id of content.correctIds) await page.locator(`[data-question-id="${id}"]`).click();
    assert.equal(await page.locator('[aria-pressed="true"]').count(), 3);

    // A 4th selection must be rejected (cap enforced) — unmark one, remark a wrong one instead.
    await page.locator('[data-question-id="sent1"]').click();
    assert.equal(await page.locator('[aria-pressed="true"]').count(), 3); // still 3, sent1 rejected
    await page.locator(`[data-question-id="${content.correctIds[0]}"]`).click(); // unmark
    await page.locator('[data-question-id="sent1"]').click(); // now fits
    assert.equal(await page.evaluate(id => document.querySelector(`[data-question-id="${id}"]`).getAttribute('aria-pressed'), 'sent1'), 'true');
    await page.locator('[data-question-id="sent1"]').click(); // unmark again
    await page.locator(`[data-question-id="${content.correctIds[0]}"]`).click(); // remark the correct one

    await page.getByRole('button', { name: 'Submit' }).click();
    assert.match(await page.locator('[role="status"]').last().textContent(), /3 \/ 3 correct/);
    assert.equal(await page.locator('button:disabled').count(), 10); // 9 sentence buttons + submit

    await page.evaluate(() => window.dispose());
    assert.equal(await page.locator('[data-question-id]').count(), 0);

    const invalidRejected = await page.evaluate(() => {
      const broken = { ...window.content, correctIds: ['sent1'] }; // itemCount is 3
      try { window.summaryError.mountSummaryError(document.querySelector('#root'), window.part, broken); return false; }
      catch { return true; }
    });
    assert.equal(invalidRejected, true);
  } finally {
    await browser.close();
  }
});
