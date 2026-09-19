import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

// Real production shell and Practice engine; no credentials or backend mutations.
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<link rel="stylesheet" href="/views/chatbot/chatbot.css"><link rel="stylesheet" href="/views/practice/practice.css"><div id="psec-aipage"></div><script type="module">
    window._userType='learner'; window._germanLevel='B1';
    localStorage.setItem('ss_ncb_chats_v1', JSON.stringify([{id:'known-chat',title:'German Grammar Help',messages:[{role:'user',text:'My saved German question'}],createdAt:Date.now(),updatedAt:Date.now()}]));
    document.querySelector('#psec-aipage').innerHTML=await(await fetch('/views/chatbot/chatbot.html')).text();
    window._ssLoadPortalFeature=()=>window.practiceLoad ||= new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/views/practice/practice.js';s.onload=resolve;s.onerror=reject;document.body.append(s)});
    window._ensureWritingCoach=async()=>{const m=await import('/js/features/writing-coach/writing-coach.js');m.initWritingCoach?.();};
    const shell=await import('/js/features/chatbot-new/shell.js');shell.initNewChatbotShell();
    window.workspace=await import('/js/features/chatbot-new/experience-mode.js');
    window.ready=true;
    </script>`);
    return;
  }
  try {
    const file=path.resolve('dist', '.'+pathname);
    if (!file.startsWith(path.resolve('dist')+path.sep)) throw Error('path');
    res.setHeader('Content-Type', pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html');
    res.end(await fs.readFile(file));
  } catch { res.statusCode=404;res.end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.setDefaultTimeout(10000);
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>window.ready);
 await page.evaluate(()=>{
   window.shellIdentity=document.querySelector('#ncbRoot');window.phases=[];
   new MutationObserver(records=>records.forEach(r=>window.phases.push(r.oldValue))).observe(window.shellIdentity,{attributes:true,attributeFilter:['class'],attributeOldValue:true});
 });
 const root=page.locator('#ncbRoot');
 async function sidebar() {
   for(const selector of ['.ncb-widget-launcher','.ncb-sidebar > .ncb-new-chat-btn','.ncb-search','.ncb-chat-list','.ncb-clear-all','[data-testid="chatbot-account-menu"]']) await expect(page.locator(selector)).toBeVisible();
 }
 for(const skill of ['vocab','grammar','reading']) {
   await page.getByTestId('german-panel-'+skill).click();
   await expect(root).toHaveAttribute('data-workspace-view','practice');
   await expect(page.locator('#ncbRoot #glSkillView')).toHaveAttribute('data-active-skill',skill);
   await expect(page.locator('#glStudyToolBody')).not.toBeEmpty();
   await expect(page.locator('#glGenerateQuiz')).toBeVisible();
   await page.locator('#glQuizTab').click();
   await page.locator('.gl-quiz-option').first().click();
   await expect(page.locator('#glStudyToolBody')).toContainText(/explanation|correct|answer/i);
   await page.locator('#glCardsTab').click();
   await expect(page.locator('#glCardsTab')).toHaveAttribute('aria-selected','true');
   await expect(page.locator('#glStudyToolBody')).not.toBeEmpty();
   await sidebar();
   await expect(page.locator('.ncb-context')).toBeVisible();
   await page.locator('[data-chat-id="known-chat"] .ncb-chat-title').click();
   await expect(root).toHaveAttribute('data-workspace-view','chat');
   await expect(page.locator('.ncb-msgs')).toContainText('My saved German question');
 }
 await page.getByTestId('chatbot-nav-writing-coach').click();
 await expect(page.getByTestId('writing-coach-workspace')).toBeVisible();
 await sidebar();
 await page.locator('.ncb-widgets-btn').click();
 await expect(page.locator('.ncb-widget-menu')).toBeVisible();
 await expect(root).toHaveAttribute('data-workspace-view','writing-coach');
 await page.locator('.ncb-widgets-btn').click();
 await page.locator('.ncb-search-input').fill('German Grammar');
 await page.locator('[data-chat-id="known-chat"] .ncb-chat-title').click();
 await expect(root).toHaveAttribute('data-workspace-view','chat');
 await expect(page.locator('.ncb-msgs')).toContainText('My saved German question');
 await page.locator('.ncb-search-input').fill('');
 await page.getByTestId('chatbot-nav-writing-coach').click();
 await expect(root).toHaveAttribute('data-workspace-view','writing-coach');
 await page.locator('.ncb-sidebar > .ncb-new-chat-btn').click();
 await expect(root).toHaveAttribute('data-workspace-view','chat');
 await expect(page.locator('.ncb-chat-item--active')).not.toHaveAttribute('data-chat-id','known-chat');
 await expect(root).not.toHaveClass(/ncb-workspace-(leaving|entering)/);
 expect(await page.evaluate(()=>window.shellIdentity===document.querySelector('#ncbRoot'))).toBe(true);
 expect(await page.evaluate(()=>window.phases.some(c=>c?.includes('ncb-workspace-leaving')) && window.phases.some(c=>c?.includes('ncb-workspace-entering')))).toBe(true);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(async()=>{window.phases=[];await window.workspace.transitionLearnerWorkspace('practice',{skill:'vocab'});await window.workspace.transitionLearnerWorkspace('writing-coach');await window.workspace.transitionLearnerWorkspace('chat');});
 expect(await page.evaluate(()=>window.phases.some(c=>/ncb-workspace-(leaving|entering)/.test(c)))).toBe(false);
 await page.evaluate(()=>{window._userType='enrolled';window.workspace.applyChatbotExperienceMode()});
 await expect(page.locator('.ncb-safe-card')).toHaveCount(0);
 await expect(page.locator('.ncb-center')).toBeVisible();
 await expect(page.locator('.ncb-practice-panel')).toBeHidden();
 console.log('PASS: skill tools, persistent sidebar, selected/search chat, New chat, transitions, reduced motion, student mode');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
