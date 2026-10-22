// Executes the production transport function, with explicit HTTP/render seams.
// This is integration execution, not browser E2E or a source-pattern assertion.
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { SseParser } from '../../frontend/js/services/sse-parser.ts';

const source = fs.readFileSync(new URL('../../frontend/js/features/chatbot-new/shell.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('shell.ts', source, ts.ScriptTarget.Latest, true);
export function shellRuntime(overrides = {}, extraNames = [], extraCode = '') {
  const names = [
    'streamFromAskStream', 'AskStreamError', 'resolveTutorModeForTurn', 'isLearnerAccount',
    'activePdfContextForCurrentRole', ...extraNames,
  ];
  // Matches function/class declarations (n.name directly) as well as
  // top-level `const`/`let` statements (the name lives on each declarator,
  // not the statement) — needed to pull module-level state like `liveState`
  // and `chatStore` out alongside the functions that mutate them.
  const declares = (n) => {
    if (n.name && names.includes(n.name.text)) return true;
    if (ts.isVariableStatement(n)) {
      return n.declarationList.declarations.some(d => d.name && names.includes(d.name.text));
    }
    return false;
  };
  const selected = ast.statements.filter(declares).map(n => n.getText(ast)).join('\n');
  // extraCode: test-only accessor functions appended after the extracted
  // statements, in the SAME vm context — the only way to read a top-level
  // `const`/`let` value back out, since module-level bindings never become
  // properties of the sandbox object the way `function` declarations do.
  const code = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    + '\n' + extraCode;
  const context = {
    console, TextDecoder, TextEncoder, DOMException, AbortController, SseParser,
    crypto: globalThis.crypto, structuredClone,
    window: { AI_SERVICE_URL: 'https://example.invalid', setTimeout, clearTimeout },
    STREAM_IDLE_WARNING_MS: 100000, STREAM_IDLE_FAILURE_MS: 200000,
    courseFileScopeForActiveChat: () => 'all_course_files', sourceModeForActiveChat: () => 'auto',
    currentMessageUsesSelectedRegion: () => false, getCurrentTutorMode: () => 'default',
    buildWorkspaceContext: () => ({}), buildPageContext: () => ({}),
    sanitizeChatbotDiagrams: x => x, stripSourceMarkers: x => x,
    normaliseSourceMode: x => x || 'auto', normaliseCourseFileScope: x => x || 'all_course_files',
    createSoftStreamReveal: () => ({ push: () => {}, finish: async () => {} }),
    isPdfViewerVisible: () => true,
    // ragEligibility()'s image-continuation check (see shell.ts) — imported
    // from visual-context.ts (isVisualFollowUpQuestion, not AST-extractable
    // from shell.ts the way a same-file helper is) or opt-in via extraNames
    // (findRecentImageTurn, a real shell.ts function). Defaulting both to
    // "no continuation detected" preserves every existing test's behavior;
    // a test that actually exercises image continuation overrides these.
    isVisualFollowUpQuestion: () => false,
    findRecentImageTurn: () => undefined,
    // activePdfContextForCurrentRole()'s own learner-file-scope check (V12) —
    // imported from learner-files.ts, not AST-extractable from shell.ts.
    // Defaulting to "not a learner file" preserves every existing test's
    // behavior (a stale/foreign open PDF stays suppressed in learner mode);
    // a test exercising a learner's own open file overrides this.
    isLearnerFileScope: () => false,
    getActivePdfContext: () => null,
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

export const encodeEvents = events => new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
export function streamResponse(events) {
  let sent = false;
  return { ok: true, body: { getReader: () => ({
    read: async () => sent ? { done: true } : (sent = true, { done: false, value: encodeEvents(events) }),
    cancel: async () => {},
  }) } };
}
export function ask(runtime, { question = 'Explain torque', message = { id: 'assistant', requestSnapshot: {} }, pdf = null, grounding, ids = [], durable = false } = {}) {
  return runtime.streamFromAskStream(question, 'course-a', null, new AbortController(), [], null,
    ids, [], grounding, null, true, pdf, 'conversation-a', [], durable, 'request-a', message);
}
