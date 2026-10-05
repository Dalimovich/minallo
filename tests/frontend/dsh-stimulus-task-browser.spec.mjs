import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from '@playwright/test';

const source=readFileSync(new URL('../../frontend/js/features/german-exam/dsh-stimulus-task.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;

function tpContent(){
  return {inputs:[{id:'i1',kind:'quotation',text:'Wer nicht wagt, der nicht gewinnt.'},{id:'i2',kind:'statement',text:'Risiko wird unterschätzt.'}],
    languageActs:['describe','evaluate'],instructions:'Beschreiben Sie und nehmen Sie Stellung.',wordCountApprox:250,inputRefs:['i1','i2']};
}
function oralContent(){
  return {inputs:[{id:'i1',kind:'short_text',text:'Ein kurzer Text über wissenschaftliche Methoden.'}],
    languageActs:['describe','evaluate'],instructions:'Beschreiben Sie den Text.',inputRefs:['i1']};
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

function mockStorage(){
  return {_data:{},getItem(k){return this._data[k]??null;},setItem(k,v){this._data[k]=v;}};
}

test('TP: renders both inputs and instructions, accepts free text, draft persists to storage',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{
      window.__storage={_data:{},getItem(k){return this._data[k]??null;},setItem(k,v){this._data[k]=v;}};
      window.dispose=exports.mountDshWritingStimulus(document.querySelector('#root'),c,'test-identity',window.__storage);
    },tpContent());
    assert.equal(await page.locator('blockquote').count(),2);
    await page.locator('textarea').fill('Meine Antwort auf beide Eingaben.');
    assert.equal((await page.evaluate(()=>window.__storage._data['dsh-tp-draft:test-identity'])).includes('Meine Antwort'),true);
    await page.evaluate(()=>window.dispose());
  });
});

test('TP: submit shows an honest not-yet-scored message and disables the editor, never a fabricated score',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{window.dispose=exports.mountDshWritingStimulus(document.querySelector('#root'),c,'id2',{getItem:()=>null,setItem:()=>{}});},tpContent());
    await page.locator('textarea').fill('Eine kurze Antwort mit mehreren Wörtern.');
    await page.getByRole('button',{name:'Antwort einreichen'}).click();
    const status=await page.locator('[role=status]').textContent();
    assert.match(status,/Antwort erfasst/);
    assert.match(status,/noch nicht verfügbar/);
    assert.doesNotMatch(status,/\d+\s*%|Punkte|score/i);
    assert.equal(await page.evaluate(()=>document.querySelector('textarea').readOnly),true);
  });
});

test('Oral: with a preparation window, the confirm button starts disabled and enables after the countdown',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{
      window.__now=0;
      window.dispose=exports.mountDshOralStimulus(document.querySelector('#root'),c,2,()=>window.__now);
    },oralContent());
    assert.equal(await page.getByRole('button',{name:'Ich habe meinen Kurzvortrag gehalten'}).isDisabled(),true);
    assert.match(await page.locator('[role=status]').textContent(),/Vorbereitung: 2s/);
    await page.evaluate(()=>{window.__now=2100;});
    await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('Vorbereitung beendet'));
    assert.equal(await page.getByRole('button',{name:'Ich habe meinen Kurzvortrag gehalten'}).isDisabled(),false);
  });
});

test('Oral: with no preparation window, the confirm button is immediately enabled',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{window.dispose=exports.mountDshOralStimulus(document.querySelector('#root'),c,undefined);},oralContent());
    assert.equal(await page.getByRole('button',{name:'Ich habe meinen Kurzvortrag gehalten'}).isDisabled(),false);
  });
});

test('Oral: confirming shows a not-yet-gradeable message, never a fabricated score',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{window.dispose=exports.mountDshOralStimulus(document.querySelector('#root'),c,undefined);},oralContent());
    await page.getByRole('button',{name:'Ich habe meinen Kurzvortrag gehalten'}).click();
    const status=await page.locator('[role=status]').textContent();
    assert.match(status,/Als gehalten markiert/);
    assert.match(status,/noch nicht verfügbar/);
    assert.doesNotMatch(status,/\d+\s*%|Punkte|score/i);
  });
});

test('rejects malformed stimulus content: missing inputs, missing instructions, missing inputRefs, duplicate input ids',async()=>{
  await withPage(async page=>{
    const results=await page.evaluate(()=>{
      const out=[];
      const tryMount=c=>{try{exports.mountDshWritingStimulus(document.querySelector('#root'),c,'id',{getItem:()=>null,setItem:()=>{}});return false;}catch{return true;}};
      out.push(tryMount({inputs:[],languageActs:['describe'],instructions:'x',inputRefs:['i1']}));
      out.push(tryMount({inputs:[{id:'i1',kind:'quotation',text:'x'}],languageActs:['describe'],instructions:'',inputRefs:['i1']}));
      out.push(tryMount({inputs:[{id:'i1',kind:'quotation',text:'x'}],languageActs:['describe'],instructions:'x',inputRefs:[]}));
      out.push(tryMount({inputs:[{id:'i1',kind:'quotation',text:'x'},{id:'i1',kind:'statement',text:'y'}],languageActs:['describe'],instructions:'x',inputRefs:['i1']}));
      return out;
    });
    assert.deepEqual(results,[true,true,true,true]);
  });
});
