// Course Files study tool — chatbot-popup-native module (Learning Agent).
//
// A thin presentation wrapper mounted by openStudyToolWorkspace('files', ...),
// mirroring how deep-learn-workspace.ts and cheatsheet are mounted. It does
// NOT reimplement file management: it reuses renderCourseDetail() from
// workspace-library.ts — the exact same engine (hydration/caching, upload,
// folders, delete, reindex, readiness status, and opening a PDF via the
// existing chatbot-aware viewer with automatic source selection for
// grounding) already built for the chatbot's "Courses" library sidebar tab.
// This module only adds a second entry point into that engine so AI actions
// and quick-launch buttons can open a standalone course-files popup without
// requiring the student to click through the library sidebar first.
//
// IMPORTANT — scope: this is an ADDITION alongside the existing Course
// Overview "Files" tab (course-view.ts / course-files.ts / course-folders.ts),
// which remains the app's primary/full file-management surface and doubles
// as core PDF-viewer close/back navigation. Nothing here replaces, deletes,
// or modifies that tab; this module is entirely new and additive.

import { renderCourseDetail, type LibraryCourse } from './workspace-library.js';

let stylesInjected = false;

function ensureStyles(): void {
  if (stylesInjected || document.getElementById('cfw-styles')) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'cfw-styles';
  // The reused engine renders with workspace-library.ts's own CSS classes
  // (.ncb-course-detail, .ncb-file-row, .ncb-folder, …), which are already
  // loaded as part of the chatbot shell — no need to restyle those here.
  // This just makes sure the popup body scrolls its content properly instead
  // of stretching/clipping inside the workspace overlay's flex layout.
  style.textContent =
    '.cfw-root{display:flex;flex-direction:column;min-height:0;height:100%;overflow:auto;}';
  document.head.appendChild(style);
}

export interface CourseFilesMountOptions {
  initialDocumentIds?: string[];
  [key: string]: unknown;
}

function asDocumentIds(options: Record<string, unknown>): string[] {
  const raw = (options as CourseFilesMountOptions).initialDocumentIds;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

/** Mount the Course Files popup into `target`. Synchronous, matching the
 * established study-tool mount contract (see mountDeepLearnWorkspace) — the
 * actual file listing/hydration happens asynchronously inside
 * renderCourseDetail() once it has been kicked off below. */
export function mountCourseFilesWorkspace(
  target: HTMLElement,
  course: LibraryCourse,
  options: Record<string, unknown> = {}
): void {
  if (!target) return;
  ensureStyles();
  target.innerHTML =
    '<div class="cfw-root" data-course-files-root>' +
      '<div class="ncb-library-status">Loading files and folders&hellip;</div>' +
    '</div>';
  const root = target.querySelector<HTMLElement>('[data-course-files-root]');
  if (!root) return;

  const initialDocumentIds = asDocumentIds(options);
  void renderCourseDetail(root, course).then(() => {
    const targetId = initialDocumentIds[0];
    if (!targetId || !root.isConnected) return;
    // "Open course files" for a specific file (e.g. from an AI action that
    // resolved a fileName to a document id) opens straight into that file,
    // via the same Open button the file row already wires to the existing
    // chatbot-aware PDF viewer — no separate open path is built here.
    const openBtn = root.querySelector<HTMLButtonElement>(
      `[data-library-file][data-document-id="${CSS.escape(targetId)}"]`
    );
    openBtn?.click();
  });
}
