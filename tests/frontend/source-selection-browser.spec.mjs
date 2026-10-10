import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';
const fixtures = JSON.parse(readFileSync(new URL('../e2e/fixtures/source-selection.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../../frontend/js/features/german-exam/source-selection.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }}).outputText;
for (const fixture of fixtures) {
  test(fixture.part.taskType + ': browser selection, escaping, validation, submission and disposal', async () => {
    const browser = await chromium.launch({headless:true});
    try {
      const page = await browser.newPage({viewport:{width:390,height:844}});
      await page.setContent('<main><div id="source"></div><div id="questions"></div></main>');
      await page.addScriptTag({content:'var exports = {};\n' + code});
      await page.evaluate(({part,content}) => {
        content.source.paragraphs[0].text += '<img src=x onerror="window.pwned=true">';
        window.part=part; window.content=content; window.answers={};
        window.dispose=exports.mountSelection(document.querySelector('#source'),document.querySelector('#questions'),part,content,window.answers);
      }, fixture);
      assert.equal(await page.locator('select').count(),fixture.part.constraints.itemCount);
      assert.equal(await page.locator('img').count(),0);
      const q = fixture.content.questions[0];
      const select=page.locator('select').first();
      const opts=q.options||fixture.content.options;
      await select.selectOption(opts.find(o=>o.id!==q.answerId).id);
      await select.selectOption(q.answerId);
      assert.equal(await page.evaluate(id=>window.answers[id],q.id),q.answerId);
      const score=await page.evaluate(()=>exports.gradeSelection(window.content,window.answers));
      assert.equal(score[q.id].correct,true);
      await page.evaluate(()=>exports.mountSelection(document.querySelector('#source'),document.querySelector('#questions'),window.part,window.content,window.answers,true));
      assert.equal(await page.locator('select:disabled').count(),fixture.part.constraints.itemCount);
      await page.evaluate(()=>window.dispose());
      assert.equal(await page.locator('select').count(),0);
      assert.equal(await page.evaluate(()=>{window.content.questions[0].answerId='absent'; try {exports.mountSelection(document.querySelector('#source'),document.querySelector('#questions'),window.part,window.content,{});return false;} catch{return true;}}),true);
      assert.equal(await page.locator('select').count(),0);
    } finally {await browser.close();}
  });
}
