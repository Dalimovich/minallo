// V11 / audit/findings/chat-state.md STATE-01: in Chat A, select course-file-only
// PDF A and ask a question. While PDF snapshot/durable preparation is still
// pending, switch to Chat B (configured Internet/all course files). A's in-flight
// request must keep its OWN sourceMode/courseFileScope/documentIds — not read
// whatever B's live chat settings became by the time the awaited work resolves.
// Executes the real production streamFromAskStream via vm + TS AST extraction
// (same technique as audit/repros/stream-network.mjs, which first caught this).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import { SseParser } from '../../frontend/js/services/sse-parser.ts';

function buildContext() {
  const source = fs.readFileSync(new URL('../../frontend/js/features/chatbot-new/shell.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('shell.ts', source, ts.ScriptTarget.Latest, true);
  const selected = ast.statements
    .filter((n) => n.name && ['streamFromAskStream', 'AskStreamError'].includes(n.name.text))
    .map((n) => n.getText(ast))
    .join('\n');
  const code = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

  let tokenSent = false;
  const context = {
    console, TextDecoder, TextEncoder, DOMException, AbortController, SseParser,
    crypto: globalThis.crypto, structuredClone: globalThis.structuredClone,
    window: { AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout },
    STREAM_IDLE_WARNING_MS: 100000, STREAM_IDLE_FAILURE_MS: 200000,
    currentMessageUsesSelectedRegion: () => false,
    getCurrentTutorMode: () => 'default',
    buildWorkspaceContext: () => ({}), buildPageContext: () => ({}),
    sanitizeChatbotDiagrams: (x) => x, stripSourceMarkers: (x) => x,
    createSoftStreamReveal: () => ({ push() {}, finish: async () => {} }),
    // Added after the original audit (V12, 2026-10-13) — neutral stubs so this
    // probe still isolates the STATE-01 race, not V12's learner-scrubbing path.
    isLearnerAccount: () => false, isLearnerFileScope: () => false,
    resolveTutorModeForTurn: () => 'default',
    isPdfViewerVisible: () => true,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

test("a chat switch during async PDF-snapshot capture does not leak the OTHER chat's source mode/scope into the in-flight request", async () => {
  const context = buildContext();
  let capturedPayload;
  context.authenticatedFetch = async (_url, init) => {
    capturedPayload = JSON.parse(init.body);
    throw new Error('captured');
  };
  context.captureStablePdfSnapshot = async () => {
    // Simulate: the user switches to Chat B (Internet / all course files)
    // while Chat A's snapshot capture is still in flight.
    context.sourceModeForActiveChat = () => 'internet';
    context.courseFileScopeForActiveChat = () => 'all_course_files';
    return {
      status: 'captured',
      snapshot: {
        activeDocument: { documentId: 'doc-a', courseId: 'course-a', fileName: 'a.pdf', visiblePage: 7, pageCount: 10, pageText: 'page' },
        images: [],
      },
    };
  };
  context.sourceModeForActiveChat = () => 'course_files';
  context.courseFileScopeForActiveChat = () => 'specific_files';

  try {
    await context.streamFromAskStream(
      'Use only selected PDF', 'course-a', null, new AbortController(), [], null,
      ['doc-a'], ['a.pdf'], { retrievalScope: { type: 'documents', documentIds: ['doc-a'] } },
      null, true, { documentId: 'doc-a', courseId: 'course-a', visiblePage: 7 }, 'conversation-a',
      [], true, 'request-a',
      { id: 'assistant-a', requestSnapshot: { sourceMode: 'course_files', courseFileScope: 'specific_files' } },
    );
    assert.fail('expected the stubbed authenticatedFetch to throw');
  } catch (e) {
    assert.equal(e.message, 'captured');
  }

  assert.equal(capturedPayload.courseId, 'course-a');
  assert.equal(capturedPayload.sourceMode, 'course_files');
  assert.equal(capturedPayload.courseFileScope, 'specific_files');
  assert.deepEqual(capturedPayload.documentIds, ['doc-a']);
});
