// Executes the production transport function, with explicit HTTP/render seams.
// This is integration execution, not browser E2E or a source-pattern assertion.
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { SseParser } from '../../frontend/js/services/sse-parser.ts';

const source = fs.readFileSync(new URL('../../frontend/js/features/chatbot-new/shell.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('shell.ts', source, ts.ScriptTarget.Latest, true);
export function shellRuntime(overrides = {}, extraNames = []) {
  const names = ['streamFromAskStream', 'AskStreamError', ...extraNames];
  const selected = ast.statements.filter(n => n.name && names.includes(n.name.text)).map(n => n.getText(ast)).join('\n');
  const code = ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
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
