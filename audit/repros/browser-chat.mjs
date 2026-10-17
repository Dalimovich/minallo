import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const root=path.resolve('frontend');
let scenario='complete'; const requests=[]; let releaseConversation;
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(`<link rel="stylesheet" href="/views/chatbot/chatbot.css"><div id="psec-aipage"></div><script type="module">document.getElementById('psec-aipage').innerHTML=await(await fetch('/views/chatbot/chatbot.html')).text();const {initNewChatbotShell}=await import('/js/features/chatbot-new/shell.js');initNewChatbotShell();window.harnessReady=true;</script>`);return;}
 if(pathname.startsWith('/mock')||pathname.startsWith('/api')){
 let text='';for await(const c of req)text+=c;const body=text?JSON.parse(text):{};requests.push({path:pathname,body});
 if(pathname.endsWith('/conversations/ensure')&&req.method==='POST'){
  if(scenario==='switch')await new Promise(r=>releaseConversation=r);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({conversationId:'00000000-0000-4000-8000-000000000001'}));return;
 }
 if(pathname.endsWith('/ask-stream')){
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.flushHeaders();
  const event=x=>res.write(`data: ${JSON.stringify(x)}\n\n`);
  if(scenario==='empty'){event({done:true});res.end();return;}
  if(scenario==='partial'){event({t:'Useful partial explanation survives connection failure.'});setTimeout(()=>res.destroy(),2200);return;}
  if(scenario==='stop'){event({t:'Partial before stop.'});return;}
  event({t:'Torque is force multiplied by perpendicular distance.'});event({done:true,answerMode:'general',sourceScope:'general_knowledge'});res.end();return;
 }
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(pathname==='/api/ai'?{content:[{text:'A concise title'}]}:{messages:[],items:[],sources:[],savedReplies:[]}));return;
 }
 const target=path.resolve(root,'.'+pathname);if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{const bytes=await fs.readFile(target);res.setHeader('Content-Type',pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':pathname.endsWith('.html')?'text/html':'application/octet-stream');res.end(bytes);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1100}});
await context.addInitScript(({base})=>{
 const token='x.'+btoa(JSON.stringify({exp:9999999999})) +'.x';window._sbToken=token;window._currentUser={id:'audit-user'};window.AI_SERVICE_URL=base+'/mock';window.BACKEND_URL='';window._SAKEY='fake';window._sb={auth:{refreshSession:async()=>null}};
 localStorage.setItem('ss_lang','en');localStorage.setItem('ss_last_uid','audit-user');
 const mk=(id,mode)=>({id,title:id,createdAt:Date.now(),updatedAt:Date.now(),messages:[],sourceMode:mode,courseFileScope:'all_course_files',courseId:null,selectedSourceIds:[],savedReplies:[]});
 if(!localStorage.getItem('ss_ncb_chats_v1:audit-user')){localStorage.setItem('ss_ncb_chats_v1:audit-user',JSON.stringify([mk('Chat A','internet'),mk('Chat B','auto')]));localStorage.setItem('ss_ncb_active_v1:audit-user','Chat A');}
},{base});
const page=await context.newPage();page.on('pageerror',e=>console.log('PAGEERROR',e.message));
const results=[];
try{
 await page.goto(base);await page.waitForFunction(()=>window.harnessReady);console.log('READY');
 await page.locator('.ncb-input-textarea').fill('Explain torque');await page.locator('.ncb-send-btn').click();
 await page.getByText('Torque is force multiplied by perpendicular distance.',{exact:true}).waitFor({timeout:15000});
 await page.waitForFunction(()=>document.querySelector('.ncb-send-btn')?.getAttribute('aria-label')!=='Stop response');
 results.push({journey:'send-complete',result:'pass',text:await page.locator('.ncb-msgs').innerText()});
const readStore=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user')||'[]'));
const waitTerminal=async()=>page.waitForFunction(()=>{const chats=JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user')||'[]');const a=chats.find(c=>c.id==='Chat A')?.messages.filter(m=>m.role==='assistant').at(-1);return a&&['complete','stopped','interrupted','failed_recoverable','failed_terminal'].includes(a.completionState);});
const send=async(text)=>{await page.locator('.ncb-input-textarea').fill(text);await page.locator('.ncb-send-btn').click();};
scenario='empty';await send('Explain angular momentum');await page.locator('.ncb-retry-btn').last().waitFor();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user')).find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1)?.errorCode==='empty_completed_response');
let store=await readStore();let last=store.find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1);assert.equal(last.errorCode,'empty_completed_response');results.push({journey:'empty-completed',result:'pass',message:last,dom:await page.locator('.ncb-msgs').innerText()});
scenario='complete';await page.locator('.ncb-retry-btn').last().click();await page.waitForFunction(()=>{const cs=JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user'));return cs.find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1).completionState==='complete';});results.push({journey:'error-retry',result:'pass'});
scenario='partial';await send('Explain rotational inertia');await page.getByText('Useful partial explanation survives connection failure.',{exact:true}).waitFor();await page.locator('.ncb-retry-btn').last().waitFor();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user')).find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1)?.completionState==='interrupted');store=await readStore();last=store.find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1);assert.match(last.text,/Useful partial explanation/);assert.equal(last.completionState,'interrupted');results.push({journey:'partial-disconnect',result:'pass',message:last,dom:await page.locator('.ncb-msgs').innerText()});
await page.reload();await page.waitForFunction(()=>window.harnessReady);await page.getByText('Useful partial explanation survives connection failure.',{exact:true}).waitFor();results.push({journey:'reload-interrupted',result:'pass',dom:await page.locator('.ncb-msgs').innerText()});
scenario='stop';await send('Explain angular acceleration');await page.getByText('Partial before stop.',{exact:true}).waitFor();await page.locator('.ncb-send-btn').click();await page.getByText('Response stopped.',{exact:true}).last().waitFor();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user')).find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1)?.completionState==='stopped');store=await readStore();last=store.find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1);assert.equal(last.completionState,'stopped');results.push({journey:'stop',result:'pass',message:last});
scenario='complete';await send('Explain net torque');await page.waitForFunction(()=>{const cs=JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user'));return cs.find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1).completionState==='complete';});results.push({journey:'stop-next',result:'pass'});
scenario='switch';await send('Explain conservation of angular momentum');while(!releaseConversation)await new Promise(r=>setTimeout(r,20));await page.locator('.ncb-chat-item').filter({hasText:'Chat B'}).click();await page.waitForFunction(()=>document.querySelector('.ncb-msgs')?.textContent?.trim()==='');releaseConversation();await page.waitForFunction(()=>{const cs=JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user'));return cs.find(c=>c.id==='Chat A').messages.filter(m=>m.role==='assistant').at(-1).completionState==='complete';});const ask=requests.filter(r=>r.path.endsWith('/ask-stream')).at(-1);assert.equal(ask.body.sourceMode,'internet');assert.equal((await readStore()).find(c=>c.id==='Chat B').messages.length,0);assert.doesNotMatch(await page.locator('.ncb-msgs').innerText(),/Torque is force/);results.push({journey:'switch-before-submission',result:'pass',sourceMode:ask.body.sourceMode,dom:await page.locator('.ncb-msgs').innerText()});

 console.log(JSON.stringify(results));
 await page.screenshot({path:'audit/repros/browser-chat.png',fullPage:true});
}catch(e){console.log('FAIL',e.stack);console.log('BODY',await page.locator('body').innerText());console.log('REQUESTS',JSON.stringify(requests));throw e;}
finally{await fs.writeFile('audit/repros/browser-results.json',JSON.stringify({results,requests},null,2));await browser.close();server.closeAllConnections();server.close();}



