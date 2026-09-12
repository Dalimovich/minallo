import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const root=path.resolve('dist');

const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(`<link rel="stylesheet" href="/css/typography.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/views/chatbot/chatbot.css"><body class="night"><div id="psec-aipage"></div><script type="module">document.getElementById('psec-aipage').innerHTML=await(await fetch('/views/chatbot/chatbot.html')).text();const {initNewChatbotShell}=await import('/js/features/chatbot-new/shell.js');initNewChatbotShell();window.harnessReady=true;</script>`);return;}
 if(pathname.startsWith('/mock')||pathname.startsWith('/api')){
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({messages:[],items:[],sources:[],savedReplies:[]}));return;
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
 if(!localStorage.getItem('ss_ncb_chats_v1:audit-user')){localStorage.setItem('ss_ncb_chats_v1:audit-user',JSON.stringify([mk('Chat A','auto'),mk('Chat B','auto')]));localStorage.setItem('ss_ncb_active_v1:audit-user','Chat A');}
},{base});
const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>console.log('PAGEERROR',e.message));

try {
 await page.goto(base); await page.waitForFunction(() => window.harnessReady);
 const composer = page.locator('.ncb-input');
 const before = await composer.boundingBox();
 await page.locator('.ncb-add-files-trigger').click();
 await page.getByRole('menuitem', { name: 'Source: Auto', exact: true }).waitFor();
 await fs.mkdir('audit/repros/source-menu', {recursive:true});
 await page.screenshot({path:'audit/repros/source-menu/main.png'});
 await page.getByRole('menuitem', {name:'Source: Auto',exact:true}).click();
 assert.equal(await page.getByRole('menuitemradio').count(),5);
 await page.getByRole('menuitemradio',{name:'Course + general knowledge',exact:true}).click();
 await page.getByRole('menuitemradio',{name:'All files',exact:true}).waitFor();
 assert.equal((await composer.boundingBox()).height,before.height);
 await page.screenshot({path:'audit/repros/source-menu/modes.png'});
 await page.getByRole('menuitemradio',{name:'Selected file(s)',exact:true}).click();
 await page.locator('#ncbImportModal').waitFor({state:'visible'});
 await page.waitForFunction(() => JSON.parse(localStorage.getItem('ss_ncb_chats_v1:audit-user') || '[]').some(c => c.sourceMode === 'course_plus_general' && c.courseFileScope === 'specific_files'));
 await page.reload(); await page.waitForFunction(() => window.harnessReady);
 await page.locator('.ncb-add-files-trigger').click();
 await page.getByRole('menuitem',{name:'Source: Course + general knowledge',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.locator('.ncb-context-close-btn').click();
 await page.setViewportSize({width:390,height:844});
 await page.locator('.ncb-add-files-trigger').click();
 await page.getByRole('menuitem',{name:'Source: Course + general knowledge',exact:true}).click();
 const popup=await page.locator('.ncb-add-files-popup').boundingBox();
 assert.ok(popup.x>=0 && popup.y>=0 && popup.x+popup.width<=390 && popup.y+popup.height<=844);
 await page.screenshot({path:'audit/repros/source-menu/mobile.png'});
 console.log('PASS: real production markup and compiled shell; all five modes, both course scopes, import modal, persistence, fixed composer height, mobile containment.');
} finally { await browser.close(); server.closeAllConnections(); server.close(); }
