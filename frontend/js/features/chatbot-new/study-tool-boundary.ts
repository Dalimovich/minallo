import { escapeHtml } from '../../utils/escape-html.js';

export interface StudyToolErrorContext {
  tool: string;
  stage: string;
  actionId?: string;
  artifactId?: string;
}

export function reportStudyToolError(context: StudyToolErrorContext, error: unknown): void {
  const detail = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
  console.error('[study-tool-error]', { ...context, ...detail });
  window.dispatchEvent(new CustomEvent('minallo:study-tool-error', { detail: { ...context, message: detail.message } }));
}

export function recoverableToolError(message: string): HTMLElement {
  const node = document.createElement('div');
  node.className = 'ncb-study-tool-error';
  node.setAttribute('role', 'alert');
  node.innerHTML = `<strong>${escapeHtml(message)}</strong><p>Your work remains saved. Retry this action or close the tool.</p>`;
  return node;
}

export function safelyReplaceStudyTool(
  host: HTMLElement,
  context: StudyToolErrorContext,
  build: (staging: HTMLElement) => void,
): boolean {
  const staging = document.createElement('div');
  try {
    build(staging);
    if (!staging.firstElementChild) throw new Error('study_tool_render_returned_empty');
    host.replaceChildren(...Array.from(staging.childNodes));
    return true;
  } catch (error) {
    reportStudyToolError(context, error);
    if (!host.firstElementChild) host.replaceChildren(recoverableToolError('This study tool could not be displayed.'));
    return false;
  }
}

export function runStudyToolAction(context: StudyToolErrorContext, action: () => void): void {
  try { action(); } catch (error) { reportStudyToolError(context, error); }
}

function recoverChatbotShell(): void {
  if (!location.hash.includes('portal=aipage')) return;
  const root = document.getElementById('ncbRoot');
  if (!root) return;
  root.hidden = false;
  const visibleSurface = root.querySelector('.ncb-main, .ncb-workspace-dialog, .ncb-study-artifact, .ncb-tool-config');
  if (!visibleSurface) root.append(recoverableToolError('Minallo recovered from a study-tool display error.'));
}

const boundaryWindow = window as Window & { __minalloStudyBoundaryInstalled?: boolean };
if (!boundaryWindow.__minalloStudyBoundaryInstalled) {
  boundaryWindow.__minalloStudyBoundaryInstalled = true;
  window.addEventListener('minallo:study-tool-error', recoverChatbotShell);
  window.addEventListener('error', event => {
    if (!String(event.filename || '').includes('chatbot') && !String(event.filename || '').includes('examforge')) return;
    console.error('[study-tool-window-error]', { message: event.message, file: event.filename, line: event.lineno, column: event.colno });
    recoverChatbotShell();
  });
  window.addEventListener('unhandledrejection', event => {
    const message = event.reason instanceof Error ? event.reason.message : String(event.reason || 'unknown');
    if (!/study|examforge|flashcard|deep.learn/i.test(message)) return;
    console.error('[study-tool-unhandled-rejection]', { message });
    recoverChatbotShell();
  });
}
