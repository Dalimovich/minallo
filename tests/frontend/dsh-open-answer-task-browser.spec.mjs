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

test('HV: renders the lecture text as a transcript with an explicit transcript-only-practice-mode notice',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'hv');},hvContent());
    assert.match(await page.locator('[role=status]').first().textContent(),/Transkript-basierter Übungsmodus.*Audio ist derzeit nicht verfügbar/);
    assert.equal(await page.locator('textarea').count(),2);
    await page.evaluate(()=>window.dispose());
    assert.equal(await page.locator('textarea').count(),0);
  });
});

test('LV: renders the reading text with the reading notice, not the HV transcript notice',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'lv');},lvContent());
    const notice=await page.locator('[role=status]').first().textContent();
    assert.match(notice,/Lesen Sie den folgenden Text/);
    assert.doesNotMatch(notice,/Transkript-basierter Übungsmodus/);
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

test('with a grade callback: shows a loading state, then the raw-content result with the required disclaimer and no official-score wording',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{
      window.__resolveGrade=null;
      window.__gradeCalls=0;
      const grade=()=>{
        window.__gradeCalls++;
        return new Promise(resolve=>{ window.__resolveGrade=()=>resolve({
          part:'lv',generationId:'g1',rawPoints:1,rawMaxPoints:2,percent:50,items:[],officialDshScore:null,officialScoreAvailable:false,
        }); });
      };
      window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'lv',grade);
    },lvContent());
    await page.locator('textarea').first().fill('Es geht um Forschung.');
    await page.getByRole('button',{name:'Antworten einreichen'}).click();
    assert.match(await page.locator('[role=status]').nth(1).textContent(),/Bewertung wird erstellt/);
    assert.equal(await page.getByRole('button',{name:'Antworten einreichen'}).isDisabled(),true);
    await page.evaluate(()=>window.__resolveGrade());
    await page.waitForFunction(()=>document.body.textContent.includes('inhaltliche Punkte'));
    const text=await page.locator('#root').textContent();
    assert.match(text,/1 \/ 2 inhaltliche Punkte/);
    assert.match(text,/50% der erzeugten Inhaltspunkte/);
    assert.match(text,/kein offizielles Prüfungsergebnis/);
    for (const forbidden of ['200 Punkte','DSH-1','DSH-2','DSH-3','DSH-Punkte','bestanden']) {
      assert.doesNotMatch(text,new RegExp(forbidden));
    }
    assert.equal(await page.evaluate(()=>window.__gradeCalls),1);
  });
});

test('does not allow a duplicate submission while one is in progress',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{
      window.__gradeCalls=0;
      const grade=()=>{ window.__gradeCalls++; return new Promise(()=>{}); }; // never resolves
      window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'lv',grade);
    },lvContent());
    const button=page.getByRole('button',{name:'Antworten einreichen'});
    await button.click();
    await button.click({force:true});
    await button.click({force:true});
    assert.equal(await page.evaluate(()=>window.__gradeCalls),1);
  });
});

test('backend/semantic-model failure shows the not-scored message, never a fabricated score, and re-enables the form to retry',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{
      window.__gradeCalls=0;
      const grade=()=>{ window.__gradeCalls++; return Promise.reject(new Error('simulated failure')); };
      window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'lv',grade);
    },lvContent());
    await page.getByRole('button',{name:'Antworten einreichen'}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('nicht bewertet'));
    const text=await page.locator('#root').textContent();
    assert.match(text,/Inhaltliche Bewertung derzeit nicht verfügbar/);
    assert.match(text,/Ihre Antwort wurde nicht bewertet/);
    assert.doesNotMatch(text,/\d+\s*\/\s*\d+\s*inhaltliche Punkte/);
    assert.equal(await page.getByRole('button',{name:'Antworten einreichen'}).isDisabled(),false);
    assert.equal(await page.locator('textarea').first().isDisabled(),false);
    // retry: resolves this time
    await page.evaluate(()=>{
      window.__resolveRetry=null;
      // re-click goes through the same injected grade, which always rejects in this test —
      // just confirm a second attempt is actually allowed (call count increments again).
    });
    await page.getByRole('button',{name:'Antworten einreichen'}).click();
    assert.equal(await page.evaluate(()=>window.__gradeCalls),2);
  });
});

test('empty answers still submit for grading rather than being blocked client-side',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{
      window.__receivedAnswers=null;
      const grade=(answers)=>{ window.__receivedAnswers=answers; return Promise.resolve({
        part:'lv',generationId:'g1',rawPoints:0,rawMaxPoints:1,percent:0,items:[],officialDshScore:null,officialScoreAvailable:false,
      }); };
      window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'lv',grade);
    },lvContent());
    await page.getByRole('button',{name:'Antworten einreichen'}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('inhaltliche Punkte'));
    assert.deepEqual(await page.evaluate(()=>window.__receivedAnswers),{});
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
