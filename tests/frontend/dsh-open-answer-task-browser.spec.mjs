import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from '@playwright/test';

const source=readFileSync(new URL('../../frontend/js/features/german-exam/dsh-open-answer-task.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;

function hvContent(){
  return {lectureText:'Dies ist ein Vortrag über Forschung.\n\nEr hat zwei Absätze.',
    tasks:[{form:'questions',items:[
      {itemId:'q1',question:'Worum geht es?',requiredPoints:[{pointId:'p1',description:'Forschung',points:1}]},
      {itemId:'q2',question:'Wie viele Absätze?',requiredPoints:[{pointId:'p2',description:'zwei',points:1}]},
    ]}]};
}
function lvContent(){
  return {source:{text:'Dies ist ein Lesetext über Forschung.'},
    tasks:[{form:'questions',items:[{itemId:'q1',question:'Worum geht es?',requiredPoints:[{pointId:'p1',description:'Forschung',points:1}]}]}]};
}

async function withPage(run){
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({content:'var exports={};\n'+code});
    await run(page);
  } finally { await browser.close(); }
}

test('HV: renders the lecture text as a transcript with an explicit audio-unavailable notice',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'hv');},hvContent());
    assert.match(await page.locator('[role=status]').first().textContent(),/Audio-Synthese.*noch nicht verfügbar/);
    assert.equal(await page.locator('textarea').count(),2);
    await page.evaluate(()=>window.dispose());
    assert.equal(await page.locator('textarea').count(),0);
  });
});

test('LV: renders the reading text with the reading notice, not the HV audio notice',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'lv');},lvContent());
    const notice=await page.locator('[role=status]').first().textContent();
    assert.match(notice,/Lesen Sie den folgenden Text/);
    assert.doesNotMatch(notice,/Audio-Synthese/);
  });
});

test('collects free-text answers and submit shows an honest not-yet-scored message, never a fabricated score',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'hv');},hvContent());
    const textareas=page.locator('textarea');
    await textareas.nth(0).fill('Es geht um wissenschaftliche Forschung.');
    // leave the second unanswered
    await page.getByRole('button',{name:'Antworten einreichen'}).click();
    const status=await page.locator('[role=status]').nth(1).textContent();
    assert.match(status,/1 \/ 2 Antworten erfasst/);
    assert.match(status,/noch nicht verfügbar/);
    assert.doesNotMatch(status,/\d+\s*%|Punkte|score/i);
    assert.equal(await page.getByRole('button',{name:'Antworten einreichen'}).isDisabled(),true);
    assert.equal(await textareas.nth(0).isDisabled(),true);
  });
});

test('rejects malformed content: missing text, missing tasks, duplicate item ids',async()=>{
  await withPage(async page=>{
    const results=await page.evaluate(()=>{
      const out=[];
      const tryMount=c=>{try{exports.mountDshOpenAnswer(document.querySelector('#root'),c,'hv');return false;}catch{return true;}};
      out.push(tryMount({tasks:[{form:'questions',items:[{itemId:'q1',question:'x',requiredPoints:[{pointId:'p1',description:'x',points:1}]}]}]})); // no text
      out.push(tryMount({lectureText:'x',tasks:[]})); // no tasks
      out.push(tryMount({lectureText:'x',tasks:[{form:'questions',items:[
        {itemId:'q1',question:'a',requiredPoints:[{pointId:'p1',description:'x',points:1}]},
        {itemId:'q1',question:'b',requiredPoints:[{pointId:'p2',description:'y',points:1}]},
      ]}]})); // duplicate item id
      return out;
    });
    assert.deepEqual(results,[true,true,true]);
  });
});
