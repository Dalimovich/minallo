import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {chromium} from '@playwright/test';
const code=ts.transpileModule(readFileSync(new URL('../../frontend/js/features/german-exam/module-result.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;

async function withPage(fn){
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({content:'var exports={};\n'+code});
    return await fn(page);
  } finally { await browser.close(); }
}

test('TELC-style module (objective + verified scoring) shows raw correctness and the official-style score',async()=>{
  await withPage(async page=>{
    const result=await page.evaluate(()=>{
      exports.renderModuleResult(document.querySelector('#root'),{id:'reading',label:'Lesen'},
        {kind:'module_result',module:'reading',objective:{kind:'practice_raw_result',correct:6,total:8,percent:75},
         official:{kind:'official_style_scaled_result',points:12,maxPoints:16,pass:true}});
      return document.querySelector('#root').textContent;
    });
    assert.match(result,/6 \/ 8 correct \(practice\)/);
    assert.match(result,/75%/);
    assert.match(result,/12 \/ 16 points/);
    assert.match(result,/passing/);
  });
});

test('TestDaF-style module (objective, no verified scoring) shows practice correctness only — never a fabricated score',async()=>{
  await withPage(async page=>{
    const html=await page.evaluate(()=>{
      exports.renderModuleResult(document.querySelector('#root'),{id:'reading',label:'Lesen'},
        {kind:'module_result',module:'reading',objective:{kind:'practice_raw_result',correct:5,total:7,percent:null}});
      return document.querySelector('#root').textContent;
    });
    assert.match(html,/5 \/ 7 correct \(practice\)/);
    assert.doesNotMatch(html,/%/);
    assert.match(html,/No official scaled score is available/);
    assert.doesNotMatch(html,/TDN/i);
    assert.doesNotMatch(html,/pass/i);
  });
});

test('productive module (writing/speaking) shows formative coverage, never a numeric score',async()=>{
  await withPage(async page=>{
    const html=await page.evaluate(()=>{
      exports.renderModuleResult(document.querySelector('#root'),{id:'speaking',label:'Sprechen'},
        {kind:'module_result',module:'speaking',productive:{kind:'practice_formative_result',partsCompleted:3,totalParts:7}});
      return document.querySelector('#root').textContent;
    });
    assert.match(html,/Formative feedback given for 3 \/ 7 tasks/);
    assert.doesNotMatch(html,/points|score|%/i);
  });
});

test('rejects a module result carrying a fabricated tdn/scaledScore key',async()=>{
  await withPage(async page=>{
    const threw=await page.evaluate(()=>{
      try{
        exports.renderModuleResult(document.querySelector('#root'),{id:'reading',label:'Lesen'},
          {kind:'module_result',module:'reading',objective:{kind:'practice_raw_result',correct:5,total:7,percent:71.4},
           official:{kind:'official_style_scaled_result',points:12,maxPoints:16,tdn:'TDN 4'}});
        return false;
      }catch{return true;}
    });
    assert.equal(threw,true);
  });
});

test('rejects an official result with no backing objective result, and an impossible count',async()=>{
  await withPage(async page=>{
    const results=await page.evaluate(()=>{
      const out=[];
      try{exports.renderModuleResult(document.querySelector('#root'),{id:'reading',label:'Lesen'},
        {kind:'module_result',module:'reading',official:{kind:'official_style_scaled_result',points:12,maxPoints:16}});out.push(false);}catch{out.push(true);}
      try{exports.renderModuleResult(document.querySelector('#root'),{id:'reading',label:'Lesen'},
        {kind:'module_result',module:'reading',objective:{kind:'practice_raw_result',correct:9,total:8,percent:112}});out.push(false);}catch{out.push(true);}
      try{exports.renderModuleResult(document.querySelector('#root'),{id:'reading',label:'Lesen'},{kind:'module_result',module:'reading'});out.push(false);}catch{out.push(true);}
      return out;
    });
    assert.deepEqual(results,[true,true,true]);
  });
});

test('renderExamResultSummary renders one independent section per module, never a combined verdict',async()=>{
  await withPage(async page=>{
    const sectionCount=await page.evaluate(()=>{
      exports.renderExamResultSummary(document.querySelector('#root'),[
        {manifest:{id:'reading',label:'Lesen'},result:{kind:'module_result',module:'reading',objective:{kind:'practice_raw_result',correct:5,total:7,percent:null}}},
        {manifest:{id:'listening',label:'Hören'},result:{kind:'module_result',module:'listening',objective:{kind:'practice_raw_result',correct:6,total:7,percent:null}}},
        {manifest:{id:'writing',label:'Schreiben'},result:{kind:'module_result',module:'writing',productive:{kind:'practice_formative_result',partsCompleted:1,totalParts:2}}},
      ]);
      return document.querySelectorAll('#root > section').length;
    });
    assert.equal(sectionCount,3);
    const bodyText=await page.locator('#root').textContent();
    assert.doesNotMatch(bodyText,/overall|final result|pass\/fail/i);
  });
});
