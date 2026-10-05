import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from '@playwright/test';

const source=readFileSync(new URL('../../frontend/js/features/german-exam/dsh-open-answer-task.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const graderSource=readFileSync(new URL('../../frontend/js/features/german-exam/dsh-lv-hv-grader.ts',import.meta.url),'utf8');
const graderCode=ts.transpileModule(graderSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;

// Shaped exactly like the real, already-stripped learner-safe response
// (german_exam_dsh_grading.strip_answer_key_for_learner's output: itemId/question only per item)
// — no answer-key fields in these fixtures, per instruction.
function hvContent(){
  return {lectureText:'Dies ist ein Vortrag über Forschung.\n\nEr hat zwei Absätze.',
    tasks:[{form:'questions',items:[
      {itemId:'q1',question:'Worum geht es?'},
      {itemId:'q2',question:'Wie viele Absätze?'},
    ]}]};
}
function lvContent(){
  return {source:{text:'Dies ist ein Lesetext über Forschung.'},
    tasks:[{form:'questions',items:[{itemId:'q1',question:'Worum geht es?'}]}]};
}
// Simulates content that was NOT stripped server-side (defense in depth: the renderer itself
// must never surface this, regardless of what the caller passes it) — distinctive secret marker
// strings so a false negative (e.g. a field silently serialised into an attribute) is obvious.
function unstrippedLvContentWithFullAnswerKey(){
  return {source:{text:'Dies ist ein Lesetext über Forschung.'},
    tasks:[{form:'questions',items:[{
      itemId:'q1',question:'Worum geht es?',
      requiredPoints:[{pointId:'p1',description:'SECRET_CONTENT_POINT_MARKER',points:1,alternatives:['SECRET_ALT_MARKER']}],
      optionalPoints:[{pointId:'p2',description:'SECRET_OPTIONAL_MARKER',points:1}],
      referenceAnswer:'SECRET_REFERENCE_ANSWER_MARKER',
      errorfulVariant:'SECRET_ERRORFUL_VARIANT_MARKER',
      gradingNotes:'SECRET_GRADING_NOTES_MARKER',
    }]}]};
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

// Exercises the REAL frontend contract end to end: dsh-lv-hv-grader.ts's createDshLvHvGrader
// (a real network call via a stubbed authenticatedFetch, intercepted by Playwright) wired into
// dsh-open-answer-task.ts's mountDshOpenAnswer — not a locally-defined fake grade() callback.
// Only the one grade request is allowed through (mocked); everything else is aborted.
async function withWiredPage(gradeResponse,run){
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    // A real (non-relative, non-about:blank) navigation is required: a relative fetch URL has no
    // base to resolve against from about:blank, and an absolute cross-origin fetch from a null
    // origin would need full CORS preflight handling this double doesn't provide. Fulfilling the
    // navigation itself keeps everything same-origin and avoids both problems.
    await page.route('**/*',route=>{
      const url=route.request().url();
      if(url.includes('/dsh/lv-hv/grade')) route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(gradeResponse)});
      else if(url==='http://localhost/') route.fulfill({status:200,contentType:'text/html',body:'<main id="root"></main>'});
      else route.abort();
    });
    await page.goto('http://localhost/');
    await page.addScriptTag({content:
      'var exports={};\n'+code+'\nwindow.__dshTask=exports;\n'+
      'var require=function(name){ if(name.indexOf("authenticated-fetch")!==-1) return {authenticatedFetch:(url,opts)=>fetch(url,opts)}; throw new Error("unexpected import "+name); };\n'+
      'var exports={};\n'+graderCode+'\nwindow.__dshGrader=exports;\n'
    });
    await run(page);
  } finally { await browser.close(); }
}

test('real contract end to end: generate -> learner-safe content -> render -> answer -> submit generationId+answers -> grade -> raw/content result',async()=>{
  const gradeResponse={part:'lv',generationId:'gen-real-1',rawPoints:1,rawMaxPoints:1,percent:100,items:[{itemId:'q1',points:1,maxPoints:1}],officialDshScore:null,officialScoreAvailable:false};
  await withWiredPage(gradeResponse,async page=>{
    const captured=await page.evaluate(c=>{
      // Simulates a prior generate() response: learner-safe content + an opaque generationId.
      // No gradingContent/referenceAnswer/requiredPoints anywhere in this fixture.
      const generated={part:'lv',generationId:'gen-real-1',content:c};
      const grade=window.__dshGrader.createDshLvHvGrader(generated.part,generated.generationId);
      window.dispose=window.__dshTask.mountDshOpenAnswer(document.querySelector('#root'),generated.content,'lv',grade);
      return generated;
    },lvContent());
    assert.equal(captured.generationId,'gen-real-1');
    assert.equal('gradingContent' in captured,false);
    // Explicit assertion that the (simulated) generate response carries none of the known
    // answer-key markers anywhere, not just that the top-level gradingContent key is absent.
    const generateResponseSerialized=JSON.stringify(captured);
    for(const marker of ['requiredPoints','optionalPoints','referenceAnswer','errorfulVariant','gradingNotes']){
      assert.doesNotMatch(generateResponseSerialized,new RegExp(marker));
    }

    await page.locator('textarea').first().fill('Antwort.');
    await page.getByRole('button',{name:'Antworten einreichen'}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('inhaltliche Punkte'));
    const text=await page.locator('#root').textContent();
    assert.match(text,/1 \/ 1 inhaltliche Punkte/);
    assert.match(text,/kein offizielles Prüfungsergebnis/);
  });
});

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

test('answer-key fields never enter the DOM, before or after a successful submission, even if the caller passes unstripped content',async()=>{
  await withPage(async page=>{
    await page.evaluate(c=>{
      const grade=()=>Promise.resolve({part:'lv',generationId:'g1',rawPoints:1,rawMaxPoints:1,percent:100,items:[],officialDshScore:null,officialScoreAvailable:false});
      window.dispose=exports.mountDshOpenAnswer(document.querySelector('#root'),c,'lv',grade);
    },unstrippedLvContentWithFullAnswerKey());
    const before=await page.locator('#root').innerHTML();
    for (const marker of ['SECRET_CONTENT_POINT_MARKER','SECRET_ALT_MARKER','SECRET_OPTIONAL_MARKER','SECRET_REFERENCE_ANSWER_MARKER','SECRET_ERRORFUL_VARIANT_MARKER','SECRET_GRADING_NOTES_MARKER']) {
      assert.doesNotMatch(before,new RegExp(marker));
    }
    await page.getByRole('button',{name:'Antworten einreichen'}).click();
    await page.waitForFunction(()=>document.body.textContent.includes('inhaltliche Punkte'));
    const after=await page.locator('#root').innerHTML();
    for (const marker of ['SECRET_CONTENT_POINT_MARKER','SECRET_ALT_MARKER','SECRET_OPTIONAL_MARKER','SECRET_REFERENCE_ANSWER_MARKER','SECRET_ERRORFUL_VARIANT_MARKER','SECRET_GRADING_NOTES_MARKER']) {
      assert.doesNotMatch(after,new RegExp(marker));
    }
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
