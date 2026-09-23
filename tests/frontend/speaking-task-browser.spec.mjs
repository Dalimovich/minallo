import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {chromium} from '@playwright/test';
const fixtures=JSON.parse(readFileSync(new URL('../e2e/fixtures/speaking-tasks.json',import.meta.url),'utf8'));
const productiveCode=ts.transpileModule(readFileSync(new URL('../../frontend/js/features/german-exam/productive-task.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const speakingCode=ts.transpileModule(readFileSync(new URL('../../frontend/js/features/german-exam/speaking-task.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
// speaking-task.ts imports productive-task.js; shim require() to hand back the already-evaluated productive exports.
const bootstrap='var exports={};\n'+productiveCode+'\nvar __productive=exports;\nexports={};\nfunction require(){return __productive;}\n'+speakingCode;

function mockDeps(){
  class FakeRecorder{constructor(stream){this.stream=stream;this.state='inactive';this.mimeType='audio/webm';}
    start(){this.state='recording';}
    stop(){this.state='inactive';const data=new Blob(['x'],{type:'audio/webm'});
      queueMicrotask(()=>{this.ondataavailable&&this.ondataavailable({data});this.onstop&&this.onstop();});}}
  window.__uploads=[];window.__grades=[];window.__failUpload=false;window.__failGrade=false;
  window.__deps={
    getMedia:async()=>({getTracks:()=>[{stop(){}}]}),
    recorder:s=>new FakeRecorder(s),
    upload:async(blob)=>{window.__uploads.push(blob.size);if(window.__failUpload)throw new Error('upload failed');return {recordingId:'rec-1'};},
    grader:async(sub)=>{window.__grades.push(sub);if(window.__failGrade)throw new Error('grading failed');
      return {kind:'practice_feedback',dimensions:window.__gradingDimensions.map(id=>({id,feedback:'Gut gemacht.',evidence:[]}))};},
    now:Date.now,
  };
}

for(const fixture of fixtures){
  const scriptBlocked=fixture.content.sources.some(s=>s.kind==='script'&&!s.media?.audioUrl);
  test(fixture.part.taskType+': recording lifecycle, timers, submission, teardown',async()=>{
    const browser=await chromium.launch({headless:true});
    try{
      const page=await browser.newPage();await page.route('**/*',route=>route.abort());
      await page.setContent('<main id="root"></main>');
      await page.clock.install();
      await page.addScriptTag({content:bootstrap});
      await page.evaluate(mockDeps);
      await page.evaluate(f=>{window.__gradingDimensions=f.part.gradingDimensions;window.__fixture=f;
        window.__mount=()=>{window.dispose=exports.mountSpeaking(document.querySelector('#root'),f.part,f.content,window.__deps);};
        window.__mount();
      },fixture);

      const start=page.getByRole('button',{name:'Prepare and record'});
      const status=page.locator('[role=status]');

      if(scriptBlocked){
        assert.equal(await start.isDisabled(),true);
        assert.match(await status.textContent(),/unavailable/);
        await page.evaluate(()=>window.dispose());
        return;
      }

      await start.click();
      await page.waitForFunction(()=>window.__deps!==undefined&&document.querySelector('[role=status]').textContent!=='Requesting microphone permission…');
      const prep=fixture.part.constraints.preparationSeconds||0;
      if(prep){
        assert.equal(await status.textContent(),'Preparation');
        await page.clock.fastForward((prep*1000)+200);
      }
      assert.equal(await status.textContent(),'Recording');
      if(fixture.part.constraints.hideSourceAfterPreparation){
        assert.equal(await page.locator('section').first().isHidden(),true);
      }
      const stopBtn=page.getByRole('button',{name:'Stop recording'});
      const seconds=fixture.part.constraints.speakingSeconds;
      const policy=fixture.part.constraints.recordingPolicy;
      assert.equal(await stopBtn.isDisabled(),!policy.manualStopAllowed);
      // Auto-stop at the speaking-time limit.
      await page.clock.fastForward((seconds*1000)+300);
      await page.waitForFunction(()=>document.querySelector('[role=status]').textContent==='Recording ready');
      assert.equal(await page.locator('audio').last().isHidden(),false);

      const retry=page.getByRole('button',{name:'Record again'});
      assert.equal(await retry.isDisabled(),!policy.retryAllowed);
      if(policy.retryAllowed){
        await retry.click();
        assert.equal(await status.textContent(),'Ready for a new recording');
        await start.click();
        await page.waitForFunction(()=>document.querySelector('[role=status]').textContent!=='Ready for a new recording');
        if(prep)await page.clock.fastForward((prep*1000)+200);
        await page.clock.fastForward((seconds*1000)+300);
        await page.waitForFunction(()=>document.querySelector('[role=status]').textContent==='Recording ready');
      }

      // Upload/grading failure keeps the recording available to retry.
      await page.evaluate(()=>{window.__failUpload=true;});
      await page.getByRole('button',{name:'Submit recording'}).click();
      await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('failed'));
      assert.equal(await page.getByRole('button',{name:'Submit recording'}).isDisabled(),false);

      await page.evaluate(()=>{window.__failUpload=false;});
      await page.getByRole('button',{name:'Submit recording'}).click();
      await page.waitForFunction(()=>document.querySelector('[role=status]').textContent==='Submitted');
      assert.equal(await page.locator('h4').textContent(),'Practice feedback');
      assert.equal((await page.evaluate(()=>window.__grades.length)),1);
      assert.equal((await page.evaluate(()=>window.__grades.at(-1).durationSeconds))<=seconds,true);

      await page.evaluate(()=>window.dispose());
      assert.equal(await page.locator('audio,button').count(),0);
    } finally { await browser.close(); }
  });
}

test('missing recording policy or speaking duration throws instead of rendering an unbounded recorder',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({content:bootstrap});
    const threw=await page.evaluate(f=>{
      try{exports.mountSpeaking(document.querySelector('#root'),{...f.part,constraints:{...f.part.constraints,recordingPolicy:undefined}},f.content,{});return false;}
      catch{return true;}
    },fixtures[0]);
    assert.equal(threw,true);
  } finally { await browser.close(); }
});
