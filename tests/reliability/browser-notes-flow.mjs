// Run after npm run build. NOTES_LIVE_ASSETS=1 executes scripts fetched from
// minallo.de; only auth, course fixtures, and API responses are controlled.
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const filename = 'Zusammenfassung_ME_1_WNV.pdf';
const courseId = 'course-mechanics';
const root = path.resolve('dist');
const live = process.env.NOTES_LIVE_ASSETS === '1';
const assets = new Map();
const reports = [];
let requests = [];
let notes = [];
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<link rel="stylesheet" href="/css/typography.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/views/chatbot/chatbot.css"><body class="night"><div id="psec-aipage"></div><script type="module">document.getElementById('psec-aipage').innerHTML=await(await fetch('/views/chatbot/chatbot.html')).text();const {initNewChatbotShell}=await import('/js/features/chatbot-new/shell.js');initNewChatbotShell();window.harnessReady=true;</script>`
      );
      return;
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/mock/')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: pathname, method: req.method, body });
      res.setHeader('Content-Type', 'application/json');
      if (pathname === '/api/documents/list') {
        res.end(
          JSON.stringify({
            documents: [filename, 'Lecture_2.pdf'].map((name, i) => ({
              id: `doc-${i}`,
              course_id: courseId,
              file_name: name,
              processing_status: 'ready',
              page_count: 70,
              chunk_count: 90
            }))
          })
        );
        return;
      }
      if (pathname === '/api/notes/generate') {
        const note = {
          id: 'persisted-note-1',
          title: 'Notes from ' + filename,
          type: 'notes',
          course_id: courseId,
          content_markdown: '# Mechanics notes\n\nVerified Notes artifact.',
          created_at: new Date().toISOString()
        };
        notes.push(note);
        res.end(JSON.stringify({ note }));
        return;
      }
      if (pathname === '/api/notes') {
        res.end(JSON.stringify({ notes }));
        return;
      }
      if (pathname.endsWith('/conversations/ensure')) {
        res.end(JSON.stringify({ conversationId: '00000000-0000-4000-8000-000000000001' }));
        return;
      }
      if (pathname.endsWith('/ask-stream')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(
          'data: {"t":"Generic RAG summary: this is NOT a Notes artifact."}\n\ndata: {"done":true}\n\n'
        );
        return;
      }
      if (pathname === '/api/ai') {
        res.end(JSON.stringify({ content: [{ text: 'Generic chat response' }] }));
        return;
      }
      res.end(
        JSON.stringify({
          messages: [],
          items: [],
          sources: [],
          savedReplies: [],
          decks: [],
          exams: []
        })
      );
      return;
    }
    let bytes;
    if (live) {
      if (!assets.has(pathname))
        assets.set(
          pathname,
          fetch('https://minallo.de' + pathname).then(async (r) => {
            if (!r.ok) throw new Error(`${pathname}: ${r.status}`);
            return Buffer.from(await r.arrayBuffer());
          })
        );
      bytes = await assets.get(pathname);
    } else {
      const target = path.resolve(root, '.' + pathname);
      if (!target.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      bytes = await fs.readFile(target);
    }
    res.setHeader(
      'Content-Type',
      pathname.endsWith('.js')
        ? 'text/javascript'
        : pathname.endsWith('.css')
          ? 'text/css'
          : pathname.endsWith('.html')
            ? 'text/html'
            : 'application/octet-stream'
    );
    res.end(bytes);
  } catch (error) {
    res.writeHead(404);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const fixture of (
    process.env.NOTES_FIXTURES ||
    'root,folder,other-semester,active-stub,indexed-only,moved-between-turns,reload,missing-file'
  ).split(',')) {
    for (const selection of ['reload', 'missing-file'].includes(fixture)
      ? ['typed']
      : ['click', 'typed']) {
      requests = [];
      notes = [];
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(
        ({ base, courseId, filename, fixture }) => {
          window._sbToken = 'x.' + btoa(JSON.stringify({ exp: 9999999999 })) + '.x';
          window._currentUser = { id: 'notes-test' };
          window._sb = { auth: { refreshSession: async () => null } };
          window.AI_SERVICE_URL = base + '/mock';
          window.BACKEND_URL = '';
          window._SAKEY = 'fixture';
          localStorage.setItem('ss_lang', 'en');
          localStorage.setItem('ss_last_uid', 'notes-test');
          const files = [{ name: filename }, { name: 'Lecture_2.pdf' }];
          const course = {
            id: courseId,
            name: 'Mechanics',
            files: ['folder', 'indexed-only'].includes(fixture) ? [] : files,
            userFolders: fixture === 'folder' ? [{ name: 'Lectures', files }] : []
          };
          window.SEMS = { 'semester-a': { courses: [course] }, 'semester-b': { courses: [] } };
          window.sdActiveSemId = fixture === 'other-semester' ? 'semester-b' : 'semester-a';
          if (fixture === 'active-stub') window.activeCourseRef = { id: courseId, files: [] };
          const chat = {
            id: 'notes-chat',
            title: 'Notes test',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
            sourceMode: 'auto',
            courseFileScope: 'all_course_files',
            courseId,
            selectedSourceIds: [],
            savedReplies: []
          };
          if (!localStorage.getItem('ss_ncb_chats_v1:notes-test'))
            localStorage.setItem('ss_ncb_chats_v1:notes-test', JSON.stringify([chat]));
          localStorage.setItem('ss_ncb_active_v1:notes-test', chat.id);
          window.notesEvents = [];
          document.addEventListener('minallo:notes-created', (e) =>
            window.notesEvents.push(e.detail)
          );
        },
        { base, courseId, filename, fixture }
      );
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const diagnostics = [];
      page.on('console', async (message) => {
        if (message.text().startsWith('notes_route_debug'))
          diagnostics.push(await Promise.all(message.args().map((a) => a.jsonValue())));
      });
      const report = { fixture, selection, live, diagnostics };
      try {
        await page.goto(base);
        await page.waitForFunction(() => window.harnessReady);
        const send = async (text) => {
          await page.locator('.ncb-input-textarea').fill(text);
          await page.locator('.ncb-send-btn').click();
        };
        await send('create a note');
        await page.waitForFunction(
          () =>
            document.querySelector('.ncb-send-btn')?.getAttribute('aria-label') !== 'Stop response'
        );
        await page.waitForFunction(
          () =>
            JSON.parse(localStorage.getItem('ss_ncb_chats_v1:notes-test') || '[]')[0]
              ?.pendingNotesAction
        );
        report.pendingAfterTurn1 = await page.evaluate(
          () => JSON.parse(localStorage.getItem('ss_ncb_chats_v1:notes-test'))[0].pendingNotesAction
        );
        report.chooserCount = await page.locator('.ncb-notes-file-pick').count();
        report.turn1Requests = structuredClone(requests);
        assert.equal(
          requests.filter(
            (r) =>
              r.path === '/api/notes/generate' ||
              /ask-stream|chat-stream|\/chat$/.test(r.path) ||
              r.path === '/api/ai/ask' ||
              r.path === '/api/ai'
          ).length,
          0
        );
        if (fixture === 'moved-between-turns')
          await page.evaluate(() => {
            window.sdActiveSemId = 'semester-b';
            window.activeCourseRef = null;
          });
        if (fixture === 'reload') {
          await page.reload();
          await page.waitForFunction(() => window.harnessReady);
        }

        requests = [];
        if (selection === 'click')
          await page.getByRole('button', { name: filename, exact: true }).click();
        else await send(fixture === 'missing-file' ? 'Missing.pdf' : filename);
        await page
          .locator('.ncb-bubble-body')
          .filter({
            hasText:
              /saved to your Notes tab|Generic RAG summary|could not generate|could not find that PDF/
          })
          .last()
          .waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector('.ncb-send-btn')?.getAttribute('aria-label') !== 'Stop response'
        );
        report.notesGenerateCalls = requests.filter((r) => r.path === '/api/notes/generate').length;
        report.ragAskCalls = requests.filter((r) => r.path === '/api/ai/ask').length;
        report.chatStreamCalls = requests.filter((r) =>
          /ask-stream|chat-stream|\/chat$/.test(r.path)
        ).length;
        report.genericChatCalls = requests.filter((r) => r.path === '/api/ai').length;
        if (fixture === 'missing-file') {
          assert.equal(
            report.notesGenerateCalls +
              report.ragAskCalls +
              report.chatStreamCalls +
              report.genericChatCalls,
            0
          );
          assert.equal(
            await page
              .locator('.ncb-notes-file-chooser')
              .last()
              .locator('.ncb-notes-file-pick')
              .count(),
            2
          );
          report.pass = true;
          continue;
        }
        assert.equal(report.notesGenerateCalls, 1);
        assert.equal(report.ragAskCalls + report.chatStreamCalls + report.genericChatCalls, 0);
        await page.waitForFunction(() =>
          JSON.parse(localStorage.getItem('ss_ncb_chats_v1:notes-test'))[0].messages.some(
            (m) => m.generatedDoc?.kind === 'notes'
          )
        );
        report.chat = await page.evaluate(
          () => JSON.parse(localStorage.getItem('ss_ncb_chats_v1:notes-test'))[0]
        );
        assert.equal(report.chat.pendingNotesAction, null);
        assert.equal(report.chat.messages.at(-1).generatedDoc.noteId, 'persisted-note-1');
        report.events = await page.evaluate(() => window.notesEvents);
        assert.equal(report.events.length, 1);
        await page.locator('[data-library-tab="saved"]').click();
        await page.locator('[data-saved-kind="notes"]').click();
        await page.locator('[data-saved-id="persisted-note-1"]').waitFor();
        assert.match(
          await page.locator('[data-saved-id="persisted-note-1"]').innerText(),
          /Zusammenfassung_ME_1_WNV/
        );
        await fs.mkdir('audit/repros/notes-flow', { recursive: true });
        if (fixture === 'folder')
          await page.screenshot({
            path: `audit/repros/notes-flow/${live ? 'live' : 'local'}-${selection}-saved.png`
          });
        report.savedVisible = true;
        report.pass = true;
      } catch (error) {
        report.error = String(error);
        process.exitCode = 1;
      } finally {
        report.requests = structuredClone(requests);
        reports.push(report);
        console.log(
          JSON.stringify({
            fixture,
            selection,
            pass: !!report.pass,
            error: report.error,
            notesGenerateCalls: report.notesGenerateCalls,
            chatStreamCalls: report.chatStreamCalls,
            diagnostics
          })
        );
        await context.close();
      }
    }
  }
} finally {
  await fs.mkdir('audit/repros/notes-flow', { recursive: true });
  const hashes = {};
  for (const [name, promise] of assets)
    hashes[name] = createHash('sha256')
      .update(await promise.catch(() => ''))
      .digest('hex');
  await fs.writeFile(
    `audit/repros/notes-flow/${live ? 'live' : 'local'}.json`,
    JSON.stringify({ reports, hashes }, null, 2)
  );
  await browser.close();
  server.closeAllConnections();
  server.close();
}
