import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {chromium} from '@playwright/test';
const fixtures=JSON.parse(readFileSync(new URL('../e2e/fixtures/media-tasks.json',import.meta.url),'utf8'));
const source=readFileSync(new URL('../../frontend/js/features/german-exam/media-task.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
for(const fixture of fixtures)test(fixture.part.taskType+': mocked media lifecycle, answers, submission, teardown',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({content:'var exports={};\n'+code});
    await page.evaluate(f=>{
      Object.defineProperty(HTMLMediaElement.prototype,'src',{set(v){this.dataset.mockSrc=v;},get(){return this.dataset.mockSrc;}});
      HTMLMediaElement.prototype.play=function(){this.dispatchEvent(new Event('play'));return Promise.resolve();};
      HTMLMediaElement.prototype.pause=function(){this.dispatchEvent(new Event('pause'));};
      HTMLMediaElement.prototype.load=function(){};
      f.content.media={mediaType:f.part.constraints.mediaType,mediaId:'fixture',duration:20,transcriptAvailability:'after_submission',
        [f.part.constraints.mediaType==='video'?'videoUrl':'audioUrl']:'/fixture/media'};
      f.content.questions[0].prompt+='<script>window.pwned=true</script>';
      // Word selection validates one token per displayed word.
      if(f.part.taskType==='sound_script_comparison')f.content.questions[0].prompt='falsch';
      window.fixture=f;window.dispose=exports.mountMediaTask(document.querySelector('#root'),f.part,f.content);
    },structuredClone(fixture));
    assert.equal(await page.locator(fixture.part.constraints.mediaType).count(),1);
    assert.equal(await page.locator('script').count(),1); // test bootstrap only
    await page.evaluate(()=>document.querySelector('audio,video').play());
    assert.equal(await page.locator('[role=status]').textContent(),'Playing');
    await page.evaluate(()=>document.querySelector('audio,video').pause());
    assert.equal(await page.locator('[role=status]').textContent(),'Paused');
    if(fixture.part.constraints.revealQuestionsAfterMedia)assert.equal(await page.locator('fieldset').isVisible(),false);
    await page.evaluate(()=>document.querySelector('audio,video').dispatchEvent(new Event('ended')));
    const kind=await page.evaluate(()=>exports.MEDIA_TASKS[window.fixture.part.taskType]);
    if(kind==='short_answer') {await page.locator('input').first().fill('wrong');await page.locator('input').first().fill('18 Uhr');}
    else if(kind==='choice') {await page.locator('select').first().selectOption('a1');await page.locator('select').first().selectOption('a0');}
    else {await page.locator('input').first().check();await page.locator('input').first().uncheck();await page.locator('input').first().check();}
    await page.getByRole('button',{name:'Submit'}).click();
    assert.equal(await page.locator('[role=status]').textContent(),`1 / ${fixture.part.constraints.itemCount} correct (practice)`);
    assert.equal(await page.locator('details').isVisible(),true);
    await page.evaluate(()=>window.dispose());assert.equal(await page.locator('audio,video,input,select').count(),0);
    await page.evaluate(()=>{const f=window.fixture;window.dispose=exports.mountMediaTask(document.querySelector('#root'),f.part,f.content);document.querySelector('audio,video').dispatchEvent(new Event('error'));});
    assert.match(await page.locator('[role=status]').textContent(),/unavailable/);
    assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),true);
    await page.evaluate(()=>{window.dispose();window.fixture.content.questions[0].id='';});
    assert.equal(await page.evaluate(()=>{try{exports.mountMediaTask(document.querySelector('#root'),window.fixture.part,window.fixture.content);return false;}catch{return true;}}),true);
  }finally{await browser.close();}
});

// ── Audio synthesis path: no pre-attached content.media, fetchClips injected ──
// (the no-storage TTS-batch delivery this phase built; media-task-audio.ts's real
// implementation is exercised separately in media-task-audio.test.mjs with a mocked fetch)

const audioFixture=fixtures.find(f=>f.part.constraints.mediaType==='audio');
const videoFixture=fixtures.find(f=>f.part.constraints.mediaType==='video');

async function mountBootstrap(page){
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({content:'var exports={};\n'+code});
  await page.evaluate(()=>{
    Object.defineProperty(HTMLMediaElement.prototype,'src',{set(v){this.dataset.mockSrc=v;},get(){return this.dataset.mockSrc;}});
    HTMLMediaElement.prototype.play=function(){this.dispatchEvent(new Event('play'));return Promise.resolve();};
    HTMLMediaElement.prototype.pause=function(){this.dispatchEvent(new Event('pause'));};
    HTMLMediaElement.prototype.load=function(){};
  });
}

test('audio part with no pre-attached media calls fetchClips and plays the real clip on success',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await mountBootstrap(page);
    await page.evaluate(f=>{
      window.__calls=[];
      window.fixture=f;
      window.dispose=exports.mountMediaTask(document.querySelector('#root'),f.part,f.content,{
        fetchClips:async(segments,signal)=>{window.__calls.push({segments,aborted:signal.aborted});
          return Object.fromEntries(segments.map(s=>[s.id,{url:'/clip/'+s.id,durationMs:1000}]));},
      });
    },structuredClone(audioFixture));
    await page.waitForFunction(()=>{const m=document.querySelector('audio,video');return m && m.src;});
    assert.equal((await page.evaluate(()=>window.__calls.length)),1);
    assert.deepEqual(await page.evaluate(()=>window.__calls[0].segments),audioFixture.content.source.segments.map(s=>({id:s.id,text:s.text})));
    await page.evaluate(()=>document.querySelector('audio,video').play());
    assert.equal(await page.locator('[role=status]').textContent(),'Playing');
    await page.evaluate(()=>document.querySelector('audio,video').dispatchEvent(new Event('ended')));
    assert.equal(await page.locator('[role=status]').textContent(),'Playback complete');
    assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),false);
    await page.evaluate(()=>window.dispose());
  }finally{await browser.close();}
});

test('audio part falls back to "media unavailable" when fetchClips reports a degraded/failed batch',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await mountBootstrap(page);
    await page.evaluate(f=>{
      window.fixture=f;
      window.dispose=exports.mountMediaTask(document.querySelector('#root'),f.part,f.content,{fetchClips:async()=>null});
    },structuredClone(audioFixture));
    await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.match(/unavailable/));
    assert.match(await page.locator('[role=status]').textContent(),/unavailable/);
    assert.equal(await page.getByRole('button',{name:'Submit'}).isDisabled(),true);
    await page.evaluate(()=>window.dispose());
  }finally{await browser.close();}
});

test('video part never calls fetchClips — no synthesis path exists for video',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await mountBootstrap(page);
    await page.evaluate(f=>{
      window.__called=false;
      window.fixture=f;
      window.dispose=exports.mountMediaTask(document.querySelector('#root'),f.part,f.content,{
        fetchClips:async()=>{window.__called=true;return null;},
      });
    },structuredClone(videoFixture));
    assert.match(await page.locator('[role=status]').textContent(),/unavailable/);
    assert.equal(await page.evaluate(()=>window.__called),false);
    await page.evaluate(()=>window.dispose());
  }finally{await browser.close();}
});

test('audio part sequentially plays one clip per segment, auto-advancing on ended',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await mountBootstrap(page);
    // Minimal valid 2-segment listening_multiple_choice content — hand-built (every real
    // fixture has exactly one segment) specifically to prove multi-clip sequencing.
    const part={id:'hoeren_6',taskType:'listening_multiple_choice',
      constraints:{itemCount:1,mediaType:'audio',optionCount:2}};
    const content={schemaVersion:'media-task-v1',
      source:{segments:[{id:'s1',speakerId:'sp1',text:'Erster Satz.'},{id:'s2',speakerId:'sp2',text:'Zweiter Satz.'}]},
      questions:[{id:'q1',prompt:'Frage?',evidenceIds:['s1','s2'],skillTags:['detail_fact'],
        options:[{id:'a',text:'Antwort A'},{id:'b',text:'Antwort B'}],answerId:'a'}]};
    await page.evaluate(([p,c])=>{
      window.dispose=exports.mountMediaTask(document.querySelector('#root'),p,c,{
        fetchClips:async segments=>Object.fromEntries(segments.map(s=>[s.id,{url:'/clip/'+s.id,durationMs:500}])),
      });
    },[part,content]);
    await page.waitForFunction(()=>{const m=document.querySelector('audio,video');return m && m.src && m.src.includes('s1');});
    await page.evaluate(()=>document.querySelector('audio,video').dispatchEvent(new Event('ended')));
    await page.waitForFunction(()=>{const m=document.querySelector('audio,video');return m && m.src && m.src.includes('s2');});
    assert.equal(await page.locator('[role=status]').textContent()!=='Playback complete',true);
    await page.evaluate(()=>document.querySelector('audio,video').dispatchEvent(new Event('ended')));
    assert.equal(await page.locator('[role=status]').textContent(),'Playback complete');
    await page.evaluate(()=>window.dispose());
  }finally{await browser.close();}
});
