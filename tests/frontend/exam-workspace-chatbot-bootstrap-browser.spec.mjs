// Regression coverage for the chatbot-DSH-panel bootstrap fix:
//   1. applyDom() must apply chat-panel link state even when #glExamGroup (Practice-only DOM)
//      is absent -- the early return for missing Practice DOM must not skip the chatbot panel.
//   2. initExamWorkspace() must be singleton-safe: a second call (e.g. Practice initializing
//      after the chatbot already bootstrapped the workspace) must reuse the SAME controller,
//      register no second MutationObserver, and still have its hooks take effect (upgrade).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { chromium } from '@playwright/test';

const source = readFileSync(new URL('../../frontend/js/features/german-exam/exam-workspace.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.includes('/api/ai/german-exam/manifest')) {
        route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            profileId: 'telc_c1_hochschule',
            manifest: {
              profileId: 'telc_c1_hochschule', profileVersion: 1, displayName: 'telc C1', cefrLevel: 'C1',
              modules: [{
                id: 'reading', label: 'Lesen', durationSeconds: null, preparationSeconds: null, note: null,
                parts: [{ id: 'reading_1', title: 'Lesen 1', taskType: 't', implemented: false }],
              }],
            },
          }),
        });
      } else if (url === 'http://localhost/') {
        route.fulfill({ status: 200, contentType: 'text/html', body: '<main id="root"></main>' });
      } else {
        route.abort();
      }
    });
    await page.goto('http://localhost/');
    await page.addScriptTag({
      content:
        'var exports={};\n' +
        'var require=function(name){\n' +
        '  if(name.indexOf("authenticated-fetch")!==-1) return {authenticatedFetch:(url,opts)=>fetch(url,opts)};\n' +
        '  if(name.indexOf("task-workspace")!==-1) return {mountTaskWorkspace:()=>(()=>{})};\n' +
        '  if(name.indexOf("exam-structure-preview")!==-1) return {ensureExamStructureStyles:()=>{}};\n' +
        '  throw new Error("unexpected import "+name);\n' +
        '};\n' +
        code +
        '\nwindow.__ws=exports;\n',
    });
    await run(page);
  } finally {
    await browser.close();
  }
}

test('applyDom applies chat-panel link state even with no #glExamGroup (chatbot-only page)', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<main id="root">' +
      '<button class="ncb-german-panel-link" data-testid="german-panel-listening" data-workspace-skill="listening" hidden></button>' +
      '</main>',
    );
    // No #glExamGroup / #glExamOverview anywhere in the document -- simulates the chatbot
    // German panel being open without the dedicated Practice section ever having been mounted.
    const hiddenAfterReady = await page.evaluate(() => {
      const readyState = {
        profileId: 'telc_c1_hochschule', status: 'ready',
        manifest: {
          profileId: 'telc_c1_hochschule', profileVersion: 1, displayName: 'telc C1', cefrLevel: 'C1',
          modules: [{
            id: 'listening', label: 'Hören', durationSeconds: null, preparationSeconds: null, note: null,
            parts: [{ id: 'listening_1', title: 'Hören 1', taskType: 't', implemented: true }],
          }],
        },
      };
      window.__ws.applyExamStateToDom(readyState);
      const link = document.querySelector('[data-testid="german-panel-listening"]');
      return { hidden: link.hidden, display: link.style.display };
    });
    assert.equal(hiddenAfterReady.hidden, false, 'the DSH/exam-specific link must become visible once the module is ready, even with no Practice DOM present');
    assert.equal(hiddenAfterReady.display, '');
  });
});

test('applyDom hides the generic link for a skill the ready exam does not have', async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<main id="root">' +
      '<button class="ncb-german-panel-link" data-testid="german-panel-sprachbausteine" data-workspace-skill="sprachbausteine"></button>' +
      '</main>',
    );
    const result = await page.evaluate(() => {
      const readyState = {
        profileId: 'goethe_c1', status: 'ready',
        manifest: {
          profileId: 'goethe_c1', profileVersion: 1, displayName: 'Goethe C1', cefrLevel: 'C1',
          modules: [{ id: 'reading', label: 'Lesen', durationSeconds: null, preparationSeconds: null, note: null, parts: [] }],
        },
      };
      window.__ws.applyExamStateToDom(readyState);
      const link = document.querySelector('[data-testid="german-panel-sprachbausteine"]');
      return { hidden: link.hidden, display: link.style.display };
    });
    assert.equal(result.hidden, true, 'Goethe has no Sprachbausteine module: the link must be hidden, not left visible by default');
    assert.equal(result.display, 'none');
  });
});

test('initExamWorkspace is singleton-safe: second call reuses the same controller, registers no second MutationObserver, and its hooks take effect', async () => {
  await withPage(async (page) => {
    const result = await page.evaluate(async () => {
      let observerConstructions = 0;
      const RealMutationObserver = window.MutationObserver;
      window.MutationObserver = class {
        constructor(cb) { observerConstructions++; this._cb = cb; }
        observe() {}
        disconnect() {}
      };

      const blockedCalls = [];
      const ctlA = window.__ws.initExamWorkspace({
        base: '', resolveProfileId: () => null, profileReady: () => true,
        savedProfileKey: () => 'telc_c1_hochschule|C1',
        onProfileChange: () => {}, activeSkill: () => '',
        onActiveSkillBlocked: (skill, reason) => blockedCalls.push(['A', skill, reason]),
      });
      await ctlA.whenSettled();

      const ctlB = window.__ws.initExamWorkspace({
        base: '', resolveProfileId: () => null, profileReady: () => true,
        savedProfileKey: () => 'telc_c1_hochschule|C1',
        onProfileChange: () => {}, activeSkill: () => 'reading', // reading has no implemented parts -> blocked
        onActiveSkillBlocked: (skill, reason) => blockedCalls.push(['B', skill, reason]),
      });
      await ctlB.whenSettled();

      window.MutationObserver = RealMutationObserver;
      return { sameController: ctlA === ctlB, observerConstructions, blockedCalls };
    });
    assert.equal(result.sameController, true, 'a second initExamWorkspace() call must return the SAME controller, not create a second one');
    assert.equal(result.observerConstructions, 1, 'exactly one MutationObserver must ever be constructed, regardless of how many times initExamWorkspace() is called');
    assert.deepEqual(result.blockedCalls.map((c) => c[0]), ['B'], 'onActiveSkillBlocked must fire using the SECOND call\'s hooks (the upgrade took effect), never the first call\'s stale hooks');
    assert.equal(result.blockedCalls[0][1], 'reading');
  });
});
