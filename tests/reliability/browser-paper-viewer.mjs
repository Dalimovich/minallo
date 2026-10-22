// Real click-behavior regression tests for the shared chat/Saved "paper" PDF
// viewer (openCheatsheetPaper / openPaperArtifact), covering both bugs found
// in this session:
//   1. The overlay mounted with no CSS (ensureStyles() was never called
//      outside the Library Cheatsheet workspace tab) — invisible, no
//      exception, so source-level assertions could never have caught it.
//   2. Chatbot Summary was never persisted server-side (localStorage only,
//      no noteId) — it could never appear in Saved, and after a refresh
//      there was nothing to reopen.
// These are real Playwright click tests against the compiled app (dist/),
// not source-string assertions — see chatbot-pdf-layout-containment.test.mjs
// for this repo's convention on why that distinction matters.
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const courseId = 'course-mechanics';
const root = path.resolve('dist');

// In-memory notes store the mock server serves /api/notes from — mutated by
// the mocked /api/ai/generate (summary) and /api/ai/cheatsheet responses so
// a "generate -> appears in Saved -> reopen by id" journey is real, not
// hand-waved.
let notes = [];
let nextNoteId = 1;
let requests = [];

function startServer() {
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

        if (pathname === '/api/documents/list') { res.end(JSON.stringify({ documents: [] })); return; }

        if (pathname === '/api/ai/generate' && req.method === 'POST') {
          const tool = body?.tool || 'summary';
          const text = '# Mechanics summary\n\nKey formulas and definitions for the test.';
          const title = body?.title || 'Summary';
          const note = {
            id: 'note-' + nextNoteId++, course_id: courseId, type: tool,
            title, content_markdown: text, updated_at: new Date().toISOString(),
          };
          notes.push(note);
          res.end(JSON.stringify({ tool, items: [], text, title, noteId: note.id, sources: [] }));
          return;
        }
        if (pathname === '/api/ai/cheatsheet' && req.method === 'POST') {
          const text = '# Mechanics cheatsheet\n\nDense formula reference for the test.';
          const title = 'Cheatsheet';
          const note = {
            id: 'note-' + nextNoteId++, course_id: courseId, type: 'cheatsheet',
            title, content_markdown: text, updated_at: new Date().toISOString(),
          };
          notes.push(note);
          res.end(JSON.stringify({ noteId: note.id, title, text, topicsCovered: [], groundedSources: [], settings: {} }));
          return;
        }
        if (pathname === '/api/notes' && req.method === 'GET') {
          const id = url.searchParams.get('id');
          if (id) {
            const note = notes.find((n) => n.id === id) || null;
            res.end(JSON.stringify({ note }));
            return;
          }
          const cid = url.searchParams.get('courseId');
          res.end(JSON.stringify({ notes: notes.filter((n) => n.course_id === cid) }));
          return;
        }
        if (pathname.endsWith('/conversations/ensure')) {
          res.end(JSON.stringify({ conversationId: '00000000-0000-4000-8000-000000000001' }));
          return;
        }
        res.end(JSON.stringify({ messages: [], items: [], sources: [], savedReplies: [], decks: [], exams: [] }));
        return;
      }
      const target = path.resolve(root, '.' + pathname);
      if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      const bytes = await fs.readFile(target);
      res.setHeader('Content-Type',
        pathname.endsWith('.js') ? 'text/javascript' :
        pathname.endsWith('.css') ? 'text/css' :
        pathname.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(bytes);
    } catch (error) {
      res.writeHead(404);
      res.end(String(error));
    }
  });
  return server;
}

async function withPage(run) {
  notes = [];
  nextNoteId = 1;
  requests = [];
  const server = startServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(({ base, courseId }) => {
      window._sbToken = 'x.' + btoa(JSON.stringify({ exp: 9999999999 })) + '.x';
      window._currentUser = { id: 'paper-test' };
      window._sb = { auth: { refreshSession: async () => null } };
      window.AI_SERVICE_URL = base + '/mock';
      window.BACKEND_URL = '';
      window._SAKEY = 'fixture';
      localStorage.setItem('ss_lang', 'en');
      localStorage.setItem('ss_last_uid', 'paper-test');
      const course = { id: courseId, name: 'Mechanics', files: [{ name: 'Lecture_1.pdf' }], userFolders: [] };
      window.SEMS = { 'semester-a': { courses: [course] } };
      window.sdActiveSemId = 'semester-a';
      window.activeCourseRef = { id: courseId, name: 'Mechanics' };
      window.activeCourseId = courseId;
      const chat = {
        id: 'paper-chat', title: 'Paper test', createdAt: Date.now(), updatedAt: Date.now(),
        messages: [], sourceMode: 'auto', courseFileScope: 'all_course_files', courseId,
        selectedSourceIds: [], savedReplies: []
      };
      // addInitScript re-runs on every navigation, including a reload — this
      // guard means it only seeds the chat once, so a reload sees whatever
      // the app itself has since persisted (generatedDoc, noteId, etc.)
      // instead of this stale empty seed clobbering it every time.
      if (!localStorage.getItem('ss_ncb_chats_v1:paper-test')) {
        localStorage.setItem('ss_ncb_chats_v1:paper-test', JSON.stringify([chat]));
      }
      localStorage.setItem('ss_ncb_active_v1:paper-test', chat.id);
    }, { base, courseId });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(base);
    await page.waitForFunction(() => window.harnessReady);
    await run(page, context, base);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
}

async function generateViaChat(page, userText) {
  await page.locator('.ncb-input-textarea').fill(userText);
  await page.locator('.ncb-send-btn').click();
  await page.locator('.ncb-cs-generate').waitFor({ timeout: 15000 });
  await page.locator('.ncb-cs-generate').click();
  await page.locator('.ncb-cs-reopen-btn').waitFor({ timeout: 20000 });
  // The reopen button appears mid-turn (inside handleIntentRoute), before
  // its caller assigns generatedDoc onto the assistant message and calls
  // saveChatStore() — a reload immediately after the button appears races
  // that write, and can even persist a message that's still "processing"
  // (the send-button's own UI state is not a reliable proxy for this — it
  // can revert before the chat store write lands). Wait on the actual
  // persisted store instead, the same technique browser-notes-flow.mjs
  // uses for the same reason.
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('ss_ncb_chats_v1:paper-test') || '[]')[0]
      ?.messages?.some((m) => m.generatedDoc?.noteId),
    { timeout: 15_000 }
  );
}

async function overlayState(page) {
  // openCheatsheetPaper() renders its markdown body a frame + 30ms after
  // mounting (deliberately, to paint the overlay before the heavier KaTeX
  // work — see cheatsheet-workspace.ts) — wait for the loading veil to
  // clear so content assertions see the real body, not "Preparing your
  // sheet…".
  await page.waitForFunction(() => !document.querySelector('[data-cs-veil]'), { timeout: 10_000 }).catch(() => {});
  return page.evaluate(() => {
    const el = document.querySelector('.cs-paper-overlay');
    if (!el) return { mounted: false };
    const cs = getComputedStyle(el);
    return {
      mounted: true,
      position: cs.position,
      zIndex: cs.zIndex,
      visible: cs.display !== 'none' && cs.position === 'fixed',
      text: el.textContent || '',
    };
  });
}

test('Summary: generate -> click Open PDF viewer -> real paper overlay mounts, styled and visible', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await generateViaChat(page, 'create a summary');
    await page.locator('.ncb-cs-reopen-btn').click();
    await page.waitForFunction(() => !!document.querySelector('.cs-paper-overlay'));
    const state = await overlayState(page);
    assert.equal(state.mounted, true, 'overlay must mount');
    assert.equal(state.position, 'fixed', 'overlay must actually be styled (position:fixed), not just present in the DOM');
    assert.ok(Number(state.zIndex) > 0, 'overlay must have a real stacking z-index');
    assert.match(state.text, /Mechanics summary/, 'overlay must render the generated summary content');
  });
});

test('Cheatsheet: generate -> click Open PDF viewer -> real paper overlay mounts, styled and visible', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await generateViaChat(page, 'create a cheatsheet');
    await page.locator('.ncb-cs-reopen-btn').click();
    await page.waitForFunction(() => !!document.querySelector('.cs-paper-overlay'));
    const state = await overlayState(page);
    assert.equal(state.mounted, true);
    assert.equal(state.position, 'fixed');
    assert.match(state.text, /Mechanics cheatsheet/);
  });
});

test('Summary persistence: generate -> Saved > Summaries shows it immediately, no refresh needed', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await generateViaChat(page, 'create a summary');
    const postCall = requests.find((r) => r.path === '/api/ai/generate');
    assert.ok(postCall, '/api/ai/generate must have been called');
    assert.equal(postCall.body.tool, 'summary');

    // The persisted note must exist server-side before we even open Saved.
    assert.equal(notes.length, 1);
    assert.equal(notes[0].type, 'summary');
    const noteId = notes[0].id;

    await page.locator('[data-library-tab="saved"]').click();
    await page.locator('[data-saved-kind="summaries"]').click();
    await page.locator(`[data-saved-id="${noteId}"]`).waitFor({ timeout: 10_000 });
  });
});

test('Saved Summary: clicking the saved item opens the same paper viewer', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await generateViaChat(page, 'create a summary');
    const noteId = notes[0].id;

    await page.locator('[data-library-tab="saved"]').click();
    await page.locator('[data-saved-kind="summaries"]').click();
    await page.locator(`[data-saved-id="${noteId}"]`).click();

    await page.waitForFunction(() => !!document.querySelector('.cs-paper-overlay'));
    const state = await overlayState(page);
    assert.equal(state.mounted, true);
    assert.equal(state.position, 'fixed');
    assert.match(state.text, /Mechanics summary/);
  });
});

test('Saved Cheatsheet: clicking the saved item opens the same paper viewer', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await generateViaChat(page, 'create a cheatsheet');
    const noteId = notes[0].id;

    await page.locator('[data-library-tab="saved"]').click();
    await page.locator('[data-saved-kind="cheatsheets"]').click();
    await page.locator(`[data-saved-id="${noteId}"]`).click();

    await page.waitForFunction(() => !!document.querySelector('.cs-paper-overlay'));
    const state = await overlayState(page);
    assert.equal(state.mounted, true);
    assert.equal(state.position, 'fixed');
    assert.match(state.text, /Mechanics cheatsheet/);
  });
});

async function reopenAfterRefreshJourney(page, kind, generateText, expectedContent) {
  await generateViaChat(page, generateText);
  const noteId = notes[0].id;

  // The identity cache must only hold identity (noteId/title/settings),
  // never markdown — the durability contract requires the server, not
  // localStorage, to be the source of truth for the content itself.
  const lsPrefix = kind === 'summary' ? 'minallo_sum_last_' : 'minallo_cs_last_';
  const cached = await page.evaluate(
    ({ prefix, cid }) => JSON.parse(localStorage.getItem(prefix + cid) || 'null'),
    { prefix: lsPrefix, cid: courseId }
  );
  assert.ok(cached, 'a lightweight identity cache should exist');
  assert.equal(cached.noteId, noteId);
  assert.equal('markdown' in cached, false, 'localStorage must not cache the full markdown as canonical content');

  // Real end-to-end journey: reload the page, let the app restore the
  // actual chat history from its own persisted storage (not a test
  // shortcut), find the SAME historical message's "Open PDF viewer"
  // button, and click it — exercising the real
  // generatedDoc -> attachReopenButton -> async getNoteById() ->
  // openPaperArtifact() -> openCheatsheetPaper() chain, not a stand-in.
  await page.reload();
  await page.waitForFunction(() => window.harnessReady);

  const restoredButton = page.locator('.ncb-cs-reopen-btn');
  await restoredButton.waitFor({ timeout: 15_000 });
  requests.length = 0; // isolate to exactly what the click itself triggers
  await restoredButton.click();

  await page.waitForFunction(() => !!document.querySelector('.cs-paper-overlay'), { timeout: 15_000 });
  const state = await overlayState(page);
  assert.equal(state.mounted, true, 'overlay must mount from the restored history button');
  assert.equal(state.position, 'fixed', 'overlay must be styled, not just present');
  assert.match(state.text, expectedContent, 'overlay must show the persisted (not truncated inline) content');

  // The restore path must have gone through the network (getNoteById),
  // proving the async resolver was truly awaited rather than the click
  // handler reusing stale in-memory opts from before the reload.
  assert.ok(
    requests.some((r) => r.path === '/api/notes' && r.method === 'GET'),
    'reopening after reload must re-fetch the note, not rely on pre-reload state'
  );
}

test('Refresh: Summary\'s historical Open PDF viewer button still works after reload', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await reopenAfterRefreshJourney(page, 'summary', 'create a summary', /Mechanics summary/);
  });
});

test('Refresh: Cheatsheet\'s historical Open PDF viewer button still works after reload (async resolver race)', { timeout: 60_000 }, async () => {
  await withPage(async (page) => {
    await reopenAfterRefreshJourney(page, 'cheatsheet', 'create a cheatsheet', /Mechanics cheatsheet/);
  });
});
