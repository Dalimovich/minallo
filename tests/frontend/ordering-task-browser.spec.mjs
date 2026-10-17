import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';

const source = readFileSync(new URL('../../frontend/js/features/german-exam/ordering-task.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

const part = { constraints: { itemCount: 5 } };
const questions = Array.from({ length: 5 }, (_, i) => ({
  questionId: `p${i + 1}`, text: `Absatz ${i + 1} mit eigenem Inhalt und XSS-Test <img src=x onerror="window.pwned=true">.`,
  skillTags: ['text_structure'],
}));
const content = { questions, correctOrder: ['p3', 'p1', 'p5', 'p2', 'p4'] };

test('paragraph_ordering: browser rendering, escaping, grading and disposal', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent('<main><div id="root"></div></main>');
    await page.addScriptTag({ content: 'var exports = {};\n' + code });
    await page.evaluate(({ part, content }) => {
      window.part = part; window.content = content; window.answers = {};
      window.dispose = exports.mountOrdering(document.querySelector('#root'), part, content, window.answers);
    }, { part, content });

    assert.equal(await page.locator('select').count(), 5);
    assert.equal(await page.locator('img').count(), 0); // paragraph text is never injected as HTML

    // Assign the correct position to every paragraph per content.correctOrder.
    for (const [position, questionId] of content.correctOrder.entries()) {
      await page.locator(`[data-question-id="${questionId}"] select`).selectOption(String(position + 1));
    }
    const answers = await page.evaluate(() => window.answers);
    assert.equal(answers.p3, '1');
    assert.equal(answers.p4, '5');

    const score = await page.evaluate(() => exports.gradeOrdering(window.content, window.answers));
    assert.equal(Object.values(score).every(r => r.correct), true);

    await page.evaluate(() => {
      window.dispose = exports.mountOrdering(document.querySelector('#root'), window.part, window.content, window.answers, true);
    });
    assert.equal(await page.locator('select:disabled').count(), 5);
    assert.equal(await page.locator('p:text("Correct")').count(), 5);

    await page.evaluate(() => window.dispose());
    assert.equal(await page.locator('select').count(), 0);

    const invalidRejected = await page.evaluate(() => {
      const broken = { questions: window.content.questions, correctOrder: ['p1', 'p2'] };
      try { exports.mountOrdering(document.querySelector('#root'), window.part, broken, {}); return false; }
      catch { return true; }
    });
    assert.equal(invalidRejected, true);
    assert.equal(await page.locator('select').count(), 0);
  } finally {
    await browser.close();
  }
});
