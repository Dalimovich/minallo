import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {chromium} from '@playwright/test';
const fixtures=JSON.parse(readFileSync(new URL('../e2e/fixtures/productive-tasks.json',import.meta.url),'utf8'));
const code=ts.transpileModule(readFileSync(new URL('../../frontend/js/features/german-exam/productive-task.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
for(const fixture of fixtures)test(fixture.part.taskType+': editor, source table, autosave, feedback, failure and timer',async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.setContent('<main id="root"></main>');await page.clock.install();
 await page.addScriptTag({content:'var exports={};\n'+code});
 await page.evaluate(f=>{window.f=f;window.data=new Map();window.store={getItem:k=>window.data.get(k),setItem:(k,v)=>window.data.set(k,v)};
  window.fail=true;window.grader=async s=>{if(window.fail)throw new Error('offline failure');return {kind:'practice_feedback',wordCount:exports.wordCount(s.text),dimensions:f.part.gradingDimensions.map(id=>({id,feedback:'Feedback <b>literal</b>',evidence:[{quote:s.text}]}))};};
  f.content.prompt+='<img src=x>';window.dispose=exports.mountWriting(document.querySelector('#root'),f.part,f.content,'user:exercise',window.grader,window.store);},fixture);
 assert.equal(await page.locator('img').count(),0);
 if(fixture.part.taskType==='text_graph_summary'){assert.equal(await page.locator('table').count(),1);assert.match(await page.locator('table').textContent(),/Bibliothek/);}
 await page.getByRole('textbox').fill('Mein kurzer Beitrag.');assert.equal(await page.locator('output').first().textContent(),'3 words');
 await page.evaluate(()=>{window.dispose();window.dispose=exports.mountWriting(document.querySelector('#root'),window.f.part,window.f.content,'user:exercise',window.grader,window.store);});
 assert.equal(await page.getByRole('textbox').inputValue(),'Mein kurzer Beitrag.');
 await page.getByRole('button',{name:'Submit'}).click();assert.match(await page.locator('[role=status]').textContent(),/failed/);
 await page.evaluate(()=>{window.fail=false;});await page.getByRole('button',{name:'Submit'}).click();assert.equal(await page.locator('[role=status]').textContent(),'Submitted');
 assert.equal(await page.locator('blockquote').count(),fixture.part.gradingDimensions.length);assert.equal(await page.locator('b').count(),0);
 await page.evaluate(()=>{window.dispose();window.dispose=exports.mountWriting(document.querySelector('#root'),window.f.part,window.f.content,'another-user:exercise',window.grader,window.store);});
 assert.equal(await page.getByRole('textbox').inputValue(),'');
 await page.clock.fastForward(fixture.part.constraints.practiceTimeLimitSeconds*1000+1000);
 assert.equal(await page.getByRole('textbox').getAttribute('readonly'),'');
 await page.evaluate(()=>window.dispose());assert.equal(await page.locator('textarea').count(),0);
 }finally{await browser.close();}
});
