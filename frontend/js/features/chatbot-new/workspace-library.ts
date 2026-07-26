import { clearCourseDocumentCache, getNoteById, listCourseDocuments, listCourseNotes, type SavedNote } from '../../services/ai-service.js';
import { renderMarkdown } from '../ai-chat/ai-markdown.js';
import { escapeHtml } from '../../utils/escape-html.js';
import { checkAdminStatus } from '../../services/admin-service.js';
import { filterOversizedFiles, warnRejected } from '../courses/upload-validate.js';
import type { LegacyCourse } from '../../../globals.js';

type CourseFile = {
  name: string;
  _storageName?: string;
  _folder?: string | null;
  _uploaded?: boolean;
  _uid?: string;
  _course?: LibraryCourse;
  size?: string;
};
type CourseFolder = { name: string; files?: CourseFile[] };
type LibraryCourse = LegacyCourse & { files?: CourseFile[]; userFolders?: CourseFolder[] };
type SavedKind = 'notes' | 'summaries' | 'flashcards' | 'cheatsheets' | 'exams' | 'responses';
type SavedItem = {
  id: string;
  kind: SavedKind;
  title: string;
  course: LibraryCourse;
  meta: string;
  note?: SavedNote;
  payload?: unknown;
};

const kindLabels: Record<SavedKind, string> = {
  notes: 'Notes',
  summaries: 'Summaries',
  flashcards: 'Flashcards',
  cheatsheets: 'Cheatsheets',
  exams: 'Practice exams',
  responses: 'AI responses'
};

let pdfOrigin: Comment | null = null;
let pdfHost: HTMLElement | null = null;
let pdfContextInner: HTMLElement | null = null;
let pdfAiDisplay = '';
let pdfResizeCleanup: (() => void) | null = null;
let pdfOriginCourse: LibraryCourse | null = null;

const PDF_WIDTH_KEY = 'minallo:chatbot-pdf-width';
const PDF_SESSION_KEY = 'minallo:chatbot-open-pdf';
const RECENT_COURSE_KEY = 'minallo:chatbot-recent-course';
let activeWorkspaceRoot: HTMLElement | null = null;

type WorkspacePdfSession = {
  course: { id: string; name?: string; short?: string };
  file: {
    name: string;
    storageName?: string;
    folder?: string | null;
    uploaded?: boolean;
    uid?: string;
    size?: string;
  };
};

function saveWorkspacePdfSession(course: LibraryCourse, file: CourseFile): void {
  const state: WorkspacePdfSession = {
    course: { id: course.id, name: course.name, short: course.short },
    file: {
      name: file.name,
      storageName: file._storageName,
      folder: file._folder,
      uploaded: file._uploaded,
      uid: file._uid,
      size: file.size
    }
  };
  try {
    sessionStorage.setItem(PDF_SESSION_KEY, JSON.stringify(state));
    sessionStorage.setItem('ss_portal_tab', 'aipage');
  } catch { /* ignore */ }
  try {
    localStorage.setItem('ss_last_section', 'aipage');
    // A stale legacy Courses/PDF state otherwise overrides ss_portal_tab in
    // the auth bootstrap and prevents the chatbot shell from loading at all.
    localStorage.removeItem('ss_state');
  } catch { /* ignore */ }
}

function readWorkspacePdfSession(): WorkspacePdfSession | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PDF_SESSION_KEY) || 'null') as WorkspacePdfSession | null;
    return parsed?.course?.id && parsed.file?.name ? parsed : null;
  } catch { return null; }
}

function clearWorkspacePdfSession(): void {
  try { sessionStorage.removeItem(PDF_SESSION_KEY); } catch { /* ignore */ }
}

function recentCourseId(): string {
  try { return localStorage.getItem(RECENT_COURSE_KEY) || ''; } catch { return ''; }
}

function rememberCourse(course: LibraryCourse): void {
  try { localStorage.setItem(RECENT_COURSE_KEY, course.id); } catch { /* ignore */ }
}

function refitWorkspacePdf(): void {
  const viewer = window as typeof window & {
    _refitPdfWidth?: () => void;
    renderPages?: () => void;
  };
  if (typeof viewer._refitPdfWidth === 'function') viewer._refitPdfWidth();
  else viewer.renderPages?.();
}

function bindWorkspacePdfResize(context: HTMLElement, host: HTMLElement): void {
  pdfResizeCleanup?.();
  const handle = host.querySelector<HTMLElement>('.ncb-pdf-resize');
  if (!handle) return;

  let dragging = false;
  let startX = 0;
  let startWidth = 0;
  let pendingWidth = 0;
  let frame = 0;

  const widthBounds = (): { min: number; max: number } => {
    const card = context.closest<HTMLElement>('.ncb-card');
    const sidebar = card?.querySelector<HTMLElement>('.ncb-sidebar');
    const cardWidth = card?.clientWidth || window.innerWidth;
    const max = Math.max(360, Math.min(900, cardWidth - (sidebar?.offsetWidth || 0) - 420));
    return { min: Math.min(360, max), max };
  };

  const applyWidth = (width: number): void => {
    const bounds = widthBounds();
    const next = Math.round(Math.min(bounds.max, Math.max(bounds.min, width)));
    context.style.width = `${next}px`;
    context.style.flexBasis = `${next}px`;
    pendingWidth = next;
    refitWorkspacePdf();
  };

  const scheduleWidth = (width: number): void => {
    pendingWidth = width;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      applyWidth(pendingWidth);
    });
  };

  const onMove = (event: PointerEvent): void => {
    if (dragging) scheduleWidth(startWidth + startX - event.clientX);
  };

  const finish = (): void => {
    if (!dragging) return;
    dragging = false;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    applyWidth(pendingWidth);
    context.classList.remove('ncb-pdf-resizing');
    handle.classList.remove('is-active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    try { localStorage.setItem(PDF_WIDTH_KEY, String(pendingWidth)); } catch { /* ignore */ }
  };

  const start = (event: PointerEvent): void => {
    if (event.button !== 0 || window.matchMedia('(max-width: 1024px)').matches) return;
    dragging = true;
    startX = event.clientX;
    startWidth = context.getBoundingClientRect().width;
    pendingWidth = startWidth;
    context.classList.add('ncb-pdf-resizing');
    handle.classList.add('is-active');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    handle.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    event.preventDefault();
  };

  handle.addEventListener('pointerdown', start);
  const observer = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => scheduleWidth(context.getBoundingClientRect().width))
    : null;
  observer?.observe(context);

  try {
    const saved = Number.parseFloat(localStorage.getItem(PDF_WIDTH_KEY) || '');
    if (Number.isFinite(saved)) applyWidth(saved);
  } catch { /* ignore */ }

  pdfResizeCleanup = () => {
    handle.removeEventListener('pointerdown', start);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    observer?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
}

function courses(): LibraryCourse[] {
  const sems = window.SEMS || window._SEMS || {};
  const seen = new Set<string>();
  const out: LibraryCourse[] = [];
  Object.values(sems).forEach((sem) => {
    (sem.courses || []).forEach((course) => {
      if (!course.id || seen.has(course.id)) return;
      seen.add(course.id);
      out.push(course as LibraryCourse);
    });
  });
  return out;
}

function icon(kind: 'course' | 'folder' | 'file' | SavedKind): string {
  const glyph: Record<string, string> = {
    course: 'C', folder: 'F', file: 'PDF', notes: 'N', summaries: 'S',
    flashcards: 'FC', cheatsheets: 'CS', exams: 'EX', responses: 'AI'
  };
  return `<span class="ncb-library-icon ncb-library-icon--${kind}">${glyph[kind]}</span>`;
}

function hydrate(course: LibraryCourse): Promise<void> {
  return typeof window._ufMerge === 'function'
    ? Promise.resolve(window._ufMerge(course))
    : Promise.resolve();
}

export function initWorkspaceLibrary(root: HTMLElement): void {
  activeWorkspaceRoot = root;
  const context = root.querySelector<HTMLElement>('.ncb-context');
  if (!context || context.dataset.libraryBound === '1') return;
  context.dataset.libraryBound = '1';

  const coursePanel = context.querySelector<HTMLElement>('[data-library-panel="courses"]');
  const savedPanel = context.querySelector<HTMLElement>('[data-library-panel="saved"]');
  const tabs = Array.from(context.querySelectorAll<HTMLButtonElement>('[data-library-tab]'));
  if (!coursePanel || !savedPanel) return;

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    const selected = tab.dataset.libraryTab || 'courses';
    tabs.forEach((candidate) => {
      const active = candidate === tab;
      candidate.classList.toggle('ncb-library-tab--active', active);
      candidate.setAttribute('aria-selected', String(active));
    });
    coursePanel.hidden = selected !== 'courses';
    savedPanel.hidden = selected !== 'saved';
    if (selected === 'saved') void renderSaved(savedPanel, root);
  }));

  document.addEventListener('minallo:saved-replies-changed', () => {
    delete savedPanel.dataset.loaded;
    if (!savedPanel.hidden) void renderSaved(savedPanel, root);
  });

  bindAccountMenu(root);
  bindWidgetLauncher(root);
  renderCourses(coursePanel);
  restoreWorkspacePdf(root, coursePanel);
}

export type StudyWorkspaceKind = 'examforge' | 'flashcards' | 'deep_learn';

/** Open the canonical course tool inside the chatbot overlay. Typed commands,
 * quick actions and Saved artifacts all converge on these production mounts. */
export async function openStudyToolWorkspace(
  kind: StudyWorkspaceKind,
  courseId: string,
  parameters: Record<string, unknown> = {},
  documentIds: string[] = [],
  documentName = ''
): Promise<boolean> {
  const root = activeWorkspaceRoot;
  const course = courses().find((candidate) => candidate.id === courseId);
  if (!root || !course) return false;
  const body = openOverlay(root, kind === 'examforge' ? 'ExamForge Quiz' : kind === 'flashcards' ? 'Flashcards' : 'Deep Learn');
  if (!body) return false;
  body.innerHTML = '<div class="ncb-library-status">Opening study tool&hellip;</div>';
  const loaderKind = kind === 'deep_learn' ? 'deeplearn' : kind;
  try {
    await window._ssLoadFeatureSection?.(loaderKind);
    await hydrate(course);
    let resolvedDocumentIds = documentIds.slice();
    if (!resolvedDocumentIds.length && documentName) {
      const normalName = documentName.trim().toLowerCase();
      const docs = await listCourseDocuments(courseId);
      const matches = docs.filter((doc) => {
        const fileName = String(doc.file_name || doc.fileName || '').trim().toLowerCase();
        const baseName = fileName.replace(/\.[^.]+$/, '');
        return fileName === normalName || baseName === normalName;
      });
      if (matches.length === 1 && matches[0]?.id) resolvedDocumentIds = [matches[0].id];
      else throw new Error(matches.length > 1 ? 'More than one course document matches that name.' : 'The selected PDF could not be resolved to an indexed course document.');
    }
    const options = { initialParameters: parameters, initialDocumentIds: resolvedDocumentIds };
    const staging = document.createElement('div');
    if (kind === 'examforge' && typeof window.mountExamForge === 'function') (window.mountExamForge as unknown as (target: HTMLElement, course: LibraryCourse, options: Record<string, unknown>) => void)(staging, course, options);
    else if (kind === 'flashcards' && typeof window.mountFlashcards === 'function') window.mountFlashcards(staging, course, { ...options, generate: window._generateStudyTool });
    else if (kind === 'deep_learn' && typeof window.mountDeepLearn === 'function') (window.mountDeepLearn as unknown as (target: HTMLElement, course: LibraryCourse, options: Record<string, unknown>) => void)(staging, course, options);
    else throw new Error('This study tool viewer is unavailable.');
    if (!staging.firstElementChild) throw new Error('study_tool_mount_returned_empty');
    body.replaceChildren(...Array.from(staging.childNodes));
    return true;
  } catch (error) {
    console.error('[study-tool-error]', { tool: kind, stage: 'workspace_mount', message: error instanceof Error ? error.message : String(error) });
    body.innerHTML = '<div class="ncb-library-error" role="alert"><strong>This study tool could not be displayed.</strong><p>The chat is still available. Close this view and retry.</p></div>';
    return false;
  }
}

function bindWidgetLauncher(root: HTMLElement): void {
  const launcher = root.querySelector<HTMLElement>('.ncb-widget-launcher');
  const trigger = launcher?.querySelector<HTMLButtonElement>('.ncb-widgets-btn');
  const menu = launcher?.querySelector<HTMLElement>('.ncb-widget-menu');
  const floating = launcher?.querySelector<HTMLElement>('.ncb-widget-float');
  const floatingBody = launcher?.querySelector<HTMLElement>('.ncb-widget-float-body');
  const closeButton = launcher?.querySelector<HTMLButtonElement>('.ncb-widget-float-close');
  if (!launcher || !trigger || !menu || !floating || !floatingBody || !closeButton) return;

  let widgetOrigin: Comment | null = null;
  let mountedWidget: HTMLElement | null = null;

  const restoreWidget = (): void => {
    if (mountedWidget && widgetOrigin?.parentNode) widgetOrigin.parentNode.insertBefore(mountedWidget, widgetOrigin);
    widgetOrigin?.remove();
    widgetOrigin = null;
    mountedWidget = null;
    floatingBody.innerHTML = '';
    floating.hidden = true;
  };

  const closeAll = (): void => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    restoreWidget();
  };

  const mountWidget = (widget: HTMLElement): void => {
    restoreWidget();
    widgetOrigin = document.createComment('ncb-widget-origin');
    widget.parentNode?.insertBefore(widgetOrigin, widget);
    mountedWidget = widget;
    floatingBody.appendChild(widget);
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'true');
    floating.hidden = false;
  };

  const populate = (): boolean => {
    const widgets = Array.from(document.querySelectorAll<HTMLElement>('#dashCanvas .dash-widget'));
    if (!widgets.length) {
      menu.innerHTML = '<div class="ncb-widget-empty">No dashboard widgets selected yet.</div>';
      return false;
    }
    menu.innerHTML = widgets.map((widget, index) => {
      const icon = widget.querySelector<HTMLElement>('.dw-icon')?.textContent || 'W';
      const title = widget.querySelector<HTMLElement>('.dw-title')?.textContent || `Widget ${index + 1}`;
      return `<button type="button" role="menuitem" data-widget-index="${index}"><span>${escapeHtml(icon)}</span><strong>${escapeHtml(title)}</strong></button>`;
    }).join('');
    menu.querySelectorAll<HTMLButtonElement>('[data-widget-index]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const widget = widgets[Number(button.dataset.widgetIndex || '-1')];
        if (widget) mountWidget(widget);
      });
    });
    return true;
  };

  const openPicker = async (): Promise<void> => {
    restoreWidget();
    await Promise.all([
      window._ssLoadFeatureSection?.('dashboard'),
      window._ssLoadPortalFeature?.('dashboard')
    ]);
    window._dwLoadAndRender?.();
    let attempt = 0;
    const waitForWidgets = (): void => {
      const ready = populate();
      if (!ready && attempt++ < 20) {
        window.setTimeout(waitForWidgets, 100);
        return;
      }
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    };
    waitForWidgets();
  };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!menu.hidden || !floating.hidden) closeAll();
    else void openPicker();
  });
  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    closeAll();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!launcher.contains(event.target as Node)) closeAll();
  });
}

function restoreWorkspacePdf(root: HTMLElement, coursePanel: HTMLElement, attempt = 0): void {
  const saved = readWorkspacePdfSession();
  if (!saved) return;
  const viewerReady = !!document.getElementById('pdfViewerWrap') && typeof window.openFile === 'function';
  if (!viewerReady) {
    if (attempt < 80) window.setTimeout(() => restoreWorkspacePdf(root, coursePanel, attempt + 1), 100);
    return;
  }
  const course = courses().find((item) => item.id === saved.course.id) || {
    id: saved.course.id,
    name: saved.course.name || 'Course',
    short: saved.course.short || saved.course.name || 'Course',
    files: [],
    userFolders: []
  } as LibraryCourse;

  const folderFiles = saved.file.folder
    ? (course.userFolders || []).find((folder) => folder.name === saved.file.folder)?.files || []
    : course.files || [];
  const file = (folderFiles as CourseFile[]).find((item) =>
    (saved.file.storageName && item._storageName === saved.file.storageName) || item.name === saved.file.name
  ) || {
    name: saved.file.name,
    _storageName: saved.file.storageName,
    _folder: saved.file.folder,
    _uploaded: saved.file.uploaded,
    _uid: saved.file.uid,
    size: saved.file.size,
    _course: course
  };
  // Reopen from the saved file identity immediately. Course hydration can
  // involve a remote storage listing and must never block refresh restore.
  // renderCourseDetail updates the hidden origin panel in the background so
  // Back still returns to the fully refreshed course once it is ready.
  void renderCourseDetail(coursePanel, course);
  openWorkspacePdf(root, file, course);
}

function renderCourses(panel: HTMLElement): void {
  const all = courses();
  const recentId = recentCourseId();
  const recent = all.find((course) => course.id === recentId);
  const ordered = recent ? [recent, ...all.filter((course) => course.id !== recent.id)] : all;
  panel.innerHTML =
    '<div class="ncb-library-section-head"><div><strong>Courses</strong><span>Select a course to browse its material.</span></div></div>' +
    `<div class="ncb-subject-add">
      <button type="button" class="ncb-add-subject" aria-expanded="false" aria-controls="ncbSubjectPopover">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        <span>Add subject</span>
      </button>
      <div class="ncb-subject-popover" id="ncbSubjectPopover" hidden>
        <label for="ncbSubjectSearch">Find or create a subject</label>
        <div><input id="ncbSubjectSearch" type="search" placeholder="Search subjects..." autocomplete="off"><button type="button" class="ncb-subject-confirm">Add</button></div>
        <small>Type a subject name and press Enter.</small>
      </div>
    </div>` +
    (!ordered.length ? '<div class="ncb-library-empty"><strong>No courses yet</strong><span>Add your first subject above.</span></div>' : '') +
    '<div class="ncb-course-list">' +
    ordered.map((course) => `
      <div class="ncb-course-row${course.id === recent?.id ? ' ncb-course-row--recent' : ''}"><button type="button" class="ncb-course-row-main" data-course-id="${escapeHtml(course.id)}">
        ${icon('course')}
        <span>${course.id === recent?.id ? '<em>Last opened</em>' : ''}<strong>${escapeHtml(course.name || 'Untitled course')}</strong><small>${fileCount(course)} files</small></span>
        <b aria-hidden="true">›</b>
      </button><button type="button" class="ncb-library-delete" data-delete-course="${escapeHtml(course.id)}" aria-label="Delete course" title="Delete course">${trashIcon()}</button></div>`).join('') +
    '</div>';

  bindSubjectAdd(panel);

  panel.querySelectorAll<HTMLButtonElement>('.ncb-course-row-main').forEach((row) => {
    row.addEventListener('click', () => {
      const course = all.find((item) => item.id === row.dataset.courseId);
      if (!course) return;
      rememberCourse(course);
      void renderCourseDetail(panel, course);
    });
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-delete-course]').forEach((button) => {
    button.addEventListener('click', () => {
      const course = all.find((item) => item.id === button.dataset.deleteCourse);
      if (course) void deleteCourseCompletely(panel, course);
    });
  });
}

function bindSubjectAdd(panel: HTMLElement): void {
  const trigger = panel.querySelector<HTMLButtonElement>('.ncb-add-subject');
  const popover = panel.querySelector<HTMLElement>('.ncb-subject-popover');
  const input = panel.querySelector<HTMLInputElement>('#ncbSubjectSearch');
  const confirm = panel.querySelector<HTMLButtonElement>('.ncb-subject-confirm');
  if (!trigger || !popover || !input || !confirm) return;

  const close = (): void => {
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };
  const add = (): void => {
    const name = input.value.trim();
    if (!name) return input.focus();
    const canonicalInput = document.getElementById('courseSearchInput') as HTMLInputElement | null;
    const canonicalButton = document.getElementById('courseAddBtn') as HTMLButtonElement | null;
    if (!canonicalInput || !canonicalButton) {
      window.showToast?.('Courses unavailable', 'Please try again after the page finishes loading.');
      return;
    }
    canonicalInput.value = name;
    canonicalInput.dispatchEvent(new Event('input', { bubbles: true }));
    canonicalButton.click();
    close();
    window.setTimeout(() => renderCourses(panel), 0);
  };
  trigger.addEventListener('click', () => {
    const opening = popover.hidden;
    popover.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) input.focus();
  });
  confirm.addEventListener('click', add);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') add();
    if (event.key === 'Escape') close();
  });
}

async function renderCourseDetail(panel: HTMLElement, course: LibraryCourse): Promise<void> {
  panel.innerHTML = `
    <div class="ncb-library-drill-head">
      <button type="button" class="ncb-library-back" aria-label="Back to all courses">&lsaquo;</button>
      <div><strong>${escapeHtml(course.name || 'Course')}</strong><span>Loading files and folders&hellip;</span></div>
    </div>
    <div class="ncb-course-detail"><div class="ncb-library-status">Loading files and folders&hellip;</div></div>`;
  panel.querySelector<HTMLButtonElement>('.ncb-library-back')?.addEventListener('click', () => renderCourses(panel));
  const detail = panel.querySelector<HTMLElement>('.ncb-course-detail')!;
  try {
    await hydrate(course);
  } catch {
    detail.innerHTML = '<div class="ncb-library-error">Could not load this course. Please try again.</div>';
    return;
  }
  const folders = (course.userFolders || []) as CourseFolder[];
  const files = (course.files || []) as CourseFile[];
  const drillMeta = panel.querySelector<HTMLElement>('.ncb-library-drill-head span');
  if (drillMeta) drillMeta.textContent = `${fileCount(course)} files`;
  detail.innerHTML = `
    <div class="ncb-course-detail-actions">
      <input class="ncb-course-upload-input" type="file" accept=".pdf,.txt,.docx,.png,.jpg,.jpeg" multiple hidden>
      <button type="button" class="ncb-course-action ncb-course-new-folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6m-3-3h6"/></svg><span>New folder</span></button>
      <button type="button" class="ncb-course-action ncb-course-upload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg><span>Upload files</span></button>
    </div>
    <form class="ncb-folder-create" hidden><label for="ncbFolderName">Folder name</label><div><input id="ncbFolderName" maxlength="80" autocomplete="off" placeholder="e.g. Lecture notes"><button type="submit">Create</button></div></form>
    <div class="ncb-upload-status" role="status" aria-live="polite" hidden></div>
    ${folders.length ? `<div class="ncb-library-group"><h3>Folders</h3>${folders.map((folder) => `
      <details class="ncb-folder" data-drop-folder="${escapeHtml(folder.name)}">
        <summary>${icon('folder')}<span><strong>${escapeHtml(folder.name)}</strong><small>${(folder.files || []).length} files</small></span><b>Drop files here</b><button type="button" class="ncb-library-delete" data-delete-folder="${escapeHtml(folder.name)}" aria-label="Delete folder" title="Delete folder">${trashIcon()}</button></summary>
        <div>${(folder.files || []).map((file) => fileButton(file, course, folder.name)).join('') || '<p class="ncb-library-muted">Empty folder</p>'}</div>
      </details>`).join('')}</div>` : ''}
    <div class="ncb-library-group ncb-root-drop" data-drop-folder=""><h3>Files</h3><div class="ncb-drop-hint"><strong>Drop files here</strong><span>Upload to ${escapeHtml(course.name || 'this course')}</span></div>${files.map((file) => fileButton(file, course, null)).join('') || '<p class="ncb-library-muted">No files in the course root.</p>'}</div>`;

  bindCourseFileActions(panel, detail, course);
  detail.querySelectorAll<HTMLButtonElement>('[data-library-file]').forEach((button) => {
    button.addEventListener('click', () => {
      const folder = button.dataset.folder || null;
      const collection = (folder
        ? (course.userFolders || []).find((item) => item.name === folder)?.files || []
        : course.files || []) as CourseFile[];
      const file = collection.find((item) => item.name === button.dataset.libraryFile);
      if (file) openWorkspacePdf(rootFor(panel), file, course);
    });
  });
}

function currentUid(): string {
  return String(window._currentUser?.id || window._currentUser?.sub || '');
}

async function uploadIntoCourse(
  panel: HTMLElement,
  detail: HTMLElement,
  course: LibraryCourse,
  picked: File[],
  folder: string | null
): Promise<void> {
  const uid = currentUid();
  if (!uid) return window.showToast?.('Not signed in', 'Sign in to upload files.');
  if (!window._ufUpload) return window.showToast?.('Upload unavailable', 'Please try again after the page finishes loading.');
  const { valid, rejected } = filterOversizedFiles(picked);
  warnRejected(rejected, valid.length === 0);
  if (!valid.length) return;
  const status = detail.querySelector<HTMLElement>('.ncb-upload-status');
  if (status) {
    status.hidden = false;
    status.classList.remove('is-error');
    status.textContent = `Uploading ${valid.length} file${valid.length === 1 ? '' : 's'}${folder ? ` to ${folder}` : ''}...`;
  }
  const results = await Promise.allSettled(valid.map((file) => window._ufUpload!(uid, course, file, null, folder)));
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed === valid.length) {
    if (status) {
      status.classList.add('is-error');
      status.textContent = 'Upload failed. Please try again.';
    }
    return;
  }
  course.files = ((course.files || []) as CourseFile[]).filter((file) => !file._uploaded);
  if (folder) course.userFolders = [];
  await hydrate(course);
  if (status) status.textContent = 'Upload complete. Indexing files for AI search...';
  await Promise.allSettled(valid.map(async (file) => {
    const uploaded = findCourseFile(course, file.name, folder);
    if (!uploaded?._storageName || !authToken()) throw new Error('Uploaded file could not be indexed');
    const response = await fetch('/api/documents/index-existing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken()}` },
      body: JSON.stringify({ courseId: course.id, storageName: uploaded._storageName, fileName: uploaded.name, folder, sourceType: 'lecture' })
    });
    if (!response.ok) throw new Error(`Indexing failed (${response.status})`);
  }));
  clearCourseDocumentCache(course.id);
  window.showToast?.(failed ? 'Some files uploaded' : 'Files uploaded', `${valid.length - failed} file${valid.length - failed === 1 ? '' : 's'} added.`);
  await renderCourseDetail(panel, course);
}

function bindCourseFileActions(panel: HTMLElement, detail: HTMLElement, course: LibraryCourse): void {
  const input = detail.querySelector<HTMLInputElement>('.ncb-course-upload-input');
  const upload = detail.querySelector<HTMLButtonElement>('.ncb-course-upload');
  const folderButton = detail.querySelector<HTMLButtonElement>('.ncb-course-new-folder');
  const form = detail.querySelector<HTMLFormElement>('.ncb-folder-create');
  const folderInput = form?.querySelector<HTMLInputElement>('input');
  if (input && upload) {
    upload.addEventListener('click', () => openUploadPopup(panel, course));
    input.addEventListener('change', () => {
      void uploadIntoCourse(panel, detail, course, Array.from(input.files || []), null);
      input.value = '';
    });
  }
  folderButton?.addEventListener('click', () => {
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) folderInput?.focus();
  });
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = folderInput?.value.trim() || '';
    const uid = currentUid();
    if (!name || !uid) return;
    if (!window._ufCreateFolder?.(uid, course, name)) {
      window.showToast?.('Already exists', 'A folder with that name already exists.');
      return;
    }
    if (!course.userFolders) course.userFolders = [];
    course.userFolders.push({ name, files: [] });
    void renderCourseDetail(panel, course);
  });

  detail.querySelectorAll<HTMLButtonElement>('[data-delete-file]').forEach((button) => {
    button.addEventListener('click', () => void deleteFileCompletely(panel, course, button.dataset.deleteFile || '', button.dataset.folder || null));
  });
  detail.querySelectorAll<HTMLButtonElement>('[data-delete-folder]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void deleteFolderCompletely(panel, course, button.dataset.deleteFolder || '');
    });
  });

  detail.querySelectorAll<HTMLElement>('[data-drop-folder]').forEach((target) => {
    let depth = 0;
    const clear = (): void => {
      depth = 0;
      target.classList.remove('is-drag-target');
    };
    target.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      depth++;
      target.classList.add('is-drag-target');
    });
    target.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    target.addEventListener('dragleave', () => {
      depth--;
      if (depth <= 0) clear();
    });
    target.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      clear();
      const files = Array.from(event.dataTransfer?.files || []);
      const folder = target.dataset.dropFolder || null;
      void uploadIntoCourse(panel, detail, course, files, folder);
    });
  });
}

function findCourseFile(course: LibraryCourse, name: string, folder: string | null): CourseFile | undefined {
  const folders = (course.userFolders || []) as CourseFolder[];
  const files = (course.files || []) as CourseFile[];
  return folder
    ? folders.find((item) => item.name === folder)?.files?.find((file) => file.name === name)
    : files.find((file) => file.name === name);
}

function openUploadPopup(panel: HTMLElement, course: LibraryCourse): void {
  const body = openOverlay(rootFor(panel), 'Upload course files');
  if (!body) return;
  const folders = (course.userFolders || []).map((folder) => `<option value="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</option>`).join('');
  body.innerHTML = `<form class="ncb-upload-popup"><h2>Upload files</h2><p>PDF files are uploaded and indexed so Minallo AI can use them in chat.</p><label>Destination<select><option value="">Course files</option>${folders}</select></label><label class="ncb-upload-picker">Choose files<input type="file" accept="application/pdf,.pdf" multiple required></label><div class="ncb-upload-status" role="status" hidden></div><button type="submit">Upload and index</button></form>`;
  const form = body.querySelector<HTMLFormElement>('form')!;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = form.querySelector<HTMLInputElement>('input[type=file]')!;
    const folder = form.querySelector<HTMLSelectElement>('select')!.value || null;
    await uploadIntoCourse(panel, form, course, Array.from(input.files || []), folder);
    window.setTimeout(() => closeOverlay(body.closest<HTMLElement>('[data-workspace-overlay]')!), 500);
  });
}

async function deleteFileCompletely(panel: HTMLElement, course: LibraryCourse, name: string, folder: string | null): Promise<void> {
  if (!name || !confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
  const file = findCourseFile(course, name, folder);
  const docs = await listCourseDocuments(course.id, { force: true });
  const matches = docs.filter((doc) => String(doc.file_name || doc.fileName) === name);
  for (const doc of matches) {
    const response = await fetch('/api/documents/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken()}` }, body: JSON.stringify({ documentId: doc.id }) });
    if (!response.ok) throw new Error('Database deletion failed');
  }
  if (file?._uploaded) await window._ufDeleteRemote?.(currentUid(), course, name, folder);
  if (folder) {
    const target = ((course.userFolders || []) as CourseFolder[]).find((item) => item.name === folder);
    if (target) target.files = (target.files || []).filter((item) => item.name !== name);
  } else course.files = ((course.files || []) as CourseFile[]).filter((item) => item.name !== name);
  clearCourseDocumentCache(course.id);
  await renderCourseDetail(panel, course);
}

async function deleteFolderCompletely(panel: HTMLElement, course: LibraryCourse, name: string): Promise<void> {
  const folder = ((course.userFolders || []) as CourseFolder[]).find((item) => item.name === name);
  if (!folder || !confirm(`Permanently delete "${name}" and all ${folder.files?.length || 0} files?`)) return;
  for (const file of [...(folder.files || [])]) await deleteFileCompletelyWithoutConfirm(course, file, name);
  window._ufDeleteFolder?.(currentUid(), course, name);
  const folders = (course.userFolders || []) as CourseFolder[];
  const folderIndex = folders.findIndex((item) => item.name === name);
  if (folderIndex >= 0) folders.splice(folderIndex, 1);
  await renderCourseDetail(panel, course);
}

async function deleteFileCompletelyWithoutConfirm(course: LibraryCourse, file: CourseFile, folder: string | null): Promise<void> {
  const docs = await listCourseDocuments(course.id, { force: true });
  for (const doc of docs.filter((item) => String(item.file_name || item.fileName) === file.name)) {
    const response = await fetch('/api/documents/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken()}` }, body: JSON.stringify({ documentId: doc.id }) });
    if (!response.ok) throw new Error('Database deletion failed');
  }
  if (file._uploaded) await window._ufDeleteRemote?.(currentUid(), course, file.name, folder);
  clearCourseDocumentCache(course.id);
}

async function deleteCourseCompletely(panel: HTMLElement, course: LibraryCourse): Promise<void> {
  if (!confirm(`Permanently delete "${course.name || 'this course'}", all files, saved resources, and indexed data?`)) return;
  const response = await fetch('/api/course-delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken()}` }, body: JSON.stringify({ courseId: course.id }) });
  if (!response.ok) return window.showToast?.('Delete failed', 'Nothing was removed from the course list. Please try again.');
  Object.values(window.SEMS || window._SEMS || {}).forEach((semester) => { semester.courses = (semester.courses || []).filter((item) => item.id !== course.id); });
  window._saveUserCourses?.();
  try {
    const uid = currentUid();
    localStorage.removeItem(`ss_ufolders_${uid}_${course.id}`);
    localStorage.removeItem(`ss_uf_cache_${course.id}`);
    localStorage.removeItem(`ss_fc_${course.id}`);
  } catch { /* durable deletion already succeeded */ }
  clearCourseDocumentCache(course.id);
  renderCourses(panel);
}

function rootFor(node: HTMLElement): HTMLElement {
  return node.closest<HTMLElement>('.ncb-root') || document.getElementById('ncbRoot')!;
}

function closeWorkspacePdf(root: HTMLElement): void {
  pdfResizeCleanup?.();
  pdfResizeCleanup = null;
  const wrap = document.getElementById('pdfViewerWrap');
  if (wrap && pdfOrigin?.parentNode) pdfOrigin.parentNode.insertBefore(wrap, pdfOrigin);
  pdfOrigin?.remove();
  pdfOrigin = null;
  pdfHost?.remove();
  pdfHost = null;
  if (pdfContextInner) pdfContextInner.hidden = false;
  pdfContextInner = null;
  const context = root.querySelector<HTMLElement>('.ncb-context');
  context?.classList.remove('ncb-pdf-resizing');
  if (context) {
    context.style.removeProperty('width');
    context.style.removeProperty('flex-basis');
  }
  const aiPanel = document.getElementById('aiPanel');
  if (aiPanel) aiPanel.style.display = pdfAiDisplay;
  delete document.body.dataset.ncbPdfWorkspace;
  document.body.classList.remove('ncb-pdf-workspace-open');
  window._ncbPdfWorkspaceActive = false;
  root.querySelector<HTMLElement>('.ncb-card')?.setAttribute('data-context-open', 'true');
  clearWorkspacePdfSession();
  const coursePanel = root.querySelector<HTMLElement>('[data-library-panel="courses"]');
  const currentCourse = courses().find((course) => course.id === pdfOriginCourse?.id) || pdfOriginCourse;
  pdfOriginCourse = null;
  if (coursePanel && currentCourse) void renderCourseDetail(coursePanel, currentCourse);
}

function openWorkspacePdf(root: HTMLElement, file: CourseFile, course: LibraryCourse): void {
  const context = root.querySelector<HTMLElement>('.ncb-context');
  const inner = context?.querySelector<HTMLElement>('.ncb-context-inner');
  const wrap = document.getElementById('pdfViewerWrap');
  if (!context || !inner || !wrap || !window.openFile) return;
  rememberCourse(course);
  pdfOriginCourse = course;
  saveWorkspacePdfSession(course, file);

  if (!pdfOrigin) {
    pdfOrigin = document.createComment('ncb-pdf-origin');
    wrap.parentNode?.insertBefore(pdfOrigin, wrap);
  }
  if (!pdfHost) {
    pdfHost = document.createElement('div');
    pdfHost.className = 'ncb-pdf-host';
    pdfHost.innerHTML =
      '<div class="ncb-pdf-resize" role="separator" aria-orientation="vertical" aria-label="Resize PDF viewer"></div>' +
      '<button type="button" class="ncb-pdf-close" aria-label="Close PDF viewer">&lsaquo;</button>';
    pdfHost.querySelector<HTMLButtonElement>('.ncb-pdf-close')?.addEventListener('click', () => {
      closeWorkspacePdf(root);
    });
    context.appendChild(pdfHost);
  }

  pdfContextInner = inner;
  inner.hidden = true;
  pdfHost.appendChild(wrap);
  wrap.style.display = 'flex';
  const aiPanel = document.getElementById('aiPanel');
  if (aiPanel) {
    pdfAiDisplay = aiPanel.style.display;
    aiPanel.style.display = 'none';
  }
  const toolbar = document.getElementById('pdfToolbar');
  toolbar?.classList.add('is-collapsed');
  const collapse = document.getElementById('pdfToolbarCollapse');
  collapse?.setAttribute('aria-expanded', 'false');
  collapse?.setAttribute('aria-label', 'PDF controls are collapsed');

  document.body.dataset.ncbPdfWorkspace = 'true';
  document.body.classList.add('ncb-pdf-workspace-open');
  window._ncbPdfWorkspaceActive = true;
  root.querySelector<HTMLElement>('.ncb-card')?.setAttribute('data-context-open', 'true');
  bindWorkspacePdfResize(context, pdfHost);
  window.selectChatbotPdfSource?.(course, file);
  window.openFile(file, course);
}

function fileButton(file: CourseFile, course: LibraryCourse, folder: string | null): string {
  return `<div class="ncb-file-row"><button type="button" class="ncb-file-row-main" data-library-file="${escapeHtml(file.name)}" data-folder="${escapeHtml(folder || '')}">${icon('file')}<span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.size || course.name || 'Course file')}</small></span><b>Open</b></button><button type="button" class="ncb-library-delete" data-delete-file="${escapeHtml(file.name)}" data-folder="${escapeHtml(folder || '')}" aria-label="Delete file" title="Delete file">${trashIcon()}</button></div>`;
}

function trashIcon(): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 4v7m4-7v7"/></svg>';
}

function fileCount(course: LibraryCourse): number {
  return (course.files || []).length + ((course.userFolders || []) as CourseFolder[]).reduce((sum, folder) => sum + (folder.files || []).length, 0);
}

async function renderSaved(panel: HTMLElement, root: HTMLElement): Promise<void> {
  if (panel.dataset.loaded === '1') return;
  panel.innerHTML = '<div class="ncb-library-status">Loading saved resources&hellip;</div>';
  const allCourses = courses();
  try {
    const groups = await Promise.all(allCourses.map(async (course) => {
      const [notes, decks, exams] = await Promise.all([
        listCourseNotes(course.id),
        fetchRows('flashcard_decks', course.id),
        fetchRows('exam_sessions', course.id)
      ]);
      const items: SavedItem[] = notes.map((note) => ({
        id: note.id,
        kind: noteKind(note.type),
        title: note.title || 'Untitled note',
        course,
        meta: formatDate(note.updated_at || note.created_at),
        note
      }));
      decks.forEach((deck) => items.push({
        id: String(deck.id), kind: 'flashcards', title: String(deck.name || 'Flashcard deck'),
        course, meta: `${Array.isArray(deck.cards) ? deck.cards.length : 0} cards`, payload: deck
      }));
      exams.forEach((exam) => items.push({
        id: String(exam.id), kind: 'exams', title: String(exam.title || exam.topic || 'Practice exam'),
        course, meta: formatDate(String(exam.updated_at || exam.created_at || '')), payload: exam
      }));
      return items;
    }));
    const responseItems = await loadBookmarkedResponses();
    const items = [...groups.flat(), ...responseItems.items];
    const savedGroups = [...allCourses, ...responseItems.groups];
    panel.dataset.loaded = '1';
    renderSavedKinds(panel, root, items, savedGroups);
  } catch {
    panel.innerHTML = '<div class="ncb-library-error">Saved resources could not be loaded. Check your connection and try again.</div>';
  }
}

function renderSavedKinds(
  panel: HTMLElement,
  root: HTMLElement,
  items: SavedItem[],
  allCourses: LibraryCourse[]
): void {
  panel.innerHTML = `
    <div class="ncb-library-section-head"><div><strong>Saved</strong><span>Choose what you want to open.</span></div></div>
    <div class="ncb-saved-kind-list">${(Object.keys(kindLabels) as SavedKind[]).map((kind) => {
      const count = items.filter((item) => item.kind === kind).length;
      return `<button type="button" class="ncb-saved-kind-btn" data-saved-kind="${kind}">
        ${icon(kind)}
        <span><strong>${kindLabels[kind]}</strong><small>${count} saved</small></span>
        <b aria-hidden="true">&rsaquo;</b>
      </button>`;
    }).join('')}</div>`;
  panel.querySelectorAll<HTMLButtonElement>('.ncb-saved-kind-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.dataset.savedKind as SavedKind | undefined;
      if (kind) renderSavedKind(panel, root, items, allCourses, kind);
    });
  });
}

function renderSavedKind(
  panel: HTMLElement,
  root: HTMLElement,
  items: SavedItem[],
  allCourses: LibraryCourse[],
  kind: SavedKind
): void {
  const ofKind = items.filter((item) => item.kind === kind);
  panel.innerHTML = `
    <div class="ncb-library-drill-head">
      <button type="button" class="ncb-library-back" aria-label="Back to saved categories">&lsaquo;</button>
      <div><strong>${kindLabels[kind]}</strong><span>${ofKind.length} saved</span></div>
    </div>
    <div class="ncb-saved-kind-results">${
      ofKind.length
        ? savedKindHtml(ofKind, allCourses)
        : `<div class="ncb-library-empty"><strong>No ${kindLabels[kind].toLowerCase()} yet</strong><span>Saved ${kindLabels[kind].toLowerCase()} will appear here.</span></div>`
    }</div>`;
  panel.querySelector<HTMLButtonElement>('.ncb-library-back')?.addEventListener('click', () => {
    renderSavedKinds(panel, root, items, allCourses);
  });
  bindSaved(panel, root, ofKind);
}

function savedKindHtml(items: SavedItem[], allCourses: LibraryCourse[]): string {
  return allCourses.map((course) => {
    const grouped = items.filter((item) => item.course.id === course.id);
    if (!grouped.length) return '';
    return `<div class="ncb-saved-course"><h4>${escapeHtml(course.name || 'Course')}</h4>${grouped.map((item) => `
      <button type="button" class="ncb-saved-row" data-saved-kind="${item.kind}" data-saved-id="${escapeHtml(item.id)}">
        ${icon(item.kind)}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></span><b>Open</b>
      </button>`).join('')}</div>`;
  }).join('');
}

function bindSaved(panel: HTMLElement, root: HTMLElement, items: SavedItem[]): void {
  panel.querySelectorAll<HTMLButtonElement>('.ncb-saved-row').forEach((button) => {
    button.addEventListener('click', () => {
      const item = items.find((candidate) => candidate.id === button.dataset.savedId && candidate.kind === button.dataset.savedKind);
      if (item) void openSaved(root, item);
    });
  });
}

async function openSaved(root: HTMLElement, item: SavedItem): Promise<void> {
  const overlay = openOverlay(root, item.title);
  if (!overlay) return;
  overlay.innerHTML = '<div class="ncb-library-status">Opening resource&hellip;</div>';
  if (item.kind === 'responses') {
    const response = item.payload as { text?: string };
    overlay.innerHTML = `<article class="ncb-resource-document ncb-bookmarked-response">${renderMarkdown(response.text || '')}</article>`;
    return;
  }
  if (item.kind === 'cheatsheets' && item.note) {
    const note = await getNoteById(item.note.id);
    if (!note) {
      overlay.innerHTML = '<div class="ncb-library-error">This saved cheatsheet is no longer available.</div>';
      return;
    }
    overlay.remove();
    await ensureArtifactRenderer('cheatsheet');
    const openPaper = (window as unknown as { openCheatsheetPaper?: (options: Record<string, unknown>) => void }).openCheatsheetPaper;
    if (openPaper) {
      openPaper({
        kind: 'cheatsheet', course: item.course.id, noteId: note.id,
        title: note.title || item.title, scope: note.title || item.title,
        markdown: note.content_markdown || '', meta: item.meta,
        settings: readCheatsheetSettings(item.course.id, note.id)
      });
    }
    return;
  }
  if (item.note) {
    const note = await getNoteById(item.note.id);
    overlay.innerHTML = note
      ? `<article class="ncb-resource-document">${renderMarkdown(note.content_markdown || '')}</article>`
      : '<div class="ncb-library-error">This saved resource is no longer available.</div>';
    return;
  }
  if (item.kind === 'flashcards') {
    await ensureArtifactRenderer('flashcards');
    overlay.innerHTML = '<div class="ncb-flashcard-workspace"><div data-flashcard-player></div></div>';
    const mount = (window as unknown as { mountFlashcardDeckPlayer?: (target: HTMLElement, deck: unknown, options?: Record<string, unknown>) => void }).mountFlashcardDeckPlayer;
    const player = overlay.querySelector<HTMLElement>('[data-flashcard-player]');
    if (mount && player) mount(player, item.payload, { embedded: false, mode: 'study' });
    else overlay.innerHTML = '<div class="ncb-library-error">The Flashcards player could not be loaded.</div>';
    return;
  }
  mountCourseFeature(overlay, item.course, 'examforge');
}

const rendererLoads = new Map<string, Promise<void>>();
function ensureArtifactRenderer(kind: 'flashcards' | 'cheatsheet'): Promise<void> {
  const loaded = kind === 'flashcards'
    ? typeof (window as unknown as { mountFlashcardDeckPlayer?: unknown }).mountFlashcardDeckPlayer === 'function'
    : typeof (window as unknown as { openCheatsheetPaper?: unknown }).openCheatsheetPaper === 'function';
  if (loaded) return Promise.resolve();
  const existing = rendererLoads.get(kind);
  if (existing) return existing;
  const base = kind === 'flashcards' ? '/views/flashcards/flashcards' : '/views/cheatsheet/cheatsheet';
  const promise = new Promise<void>((resolve, reject) => {
    if (!document.querySelector(`link[data-artifact-renderer="${kind}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = `${base}.css`; link.dataset.artifactRenderer = kind;
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = `${base}.js`; script.dataset.artifactRenderer = kind;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error(`Could not load ${kind} renderer`)), { once: true });
    document.head.appendChild(script);
  });
  rendererLoads.set(kind, promise);
  return promise;
}

function readCheatsheetSettings(courseId: string, noteId: string): Record<string, unknown> {
  try {
    const stored = JSON.parse(localStorage.getItem(`minallo_cs_last_${courseId}`) || 'null') as { noteId?: string; settings?: Record<string, unknown> } | null;
    if (stored?.noteId === noteId && stored.settings) return stored.settings;
  } catch { /* legacy artifacts use deterministic renderer defaults */ }
  return { columns: 3, font: 'sm', pad: '10mm', style: 'academic', rendererVersion: 1 };
}

async function loadBookmarkedResponses(): Promise<{ items: SavedItem[]; groups: LibraryCourse[] }> {
  type ReplyRow = { id?: string; chat_id?: string; reply_text?: string; created_at?: string };
  const localRows = localBookmarkedResponses();
  let serverRows: ReplyRow[] = [];
  const token = authToken();
  if (token) {
    try {
      const response = await fetch('/api/chat-saved-replies', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const body = await response.json() as { replies?: ReplyRow[] };
        serverRows = Array.isArray(body.replies) ? body.replies : [];
        const serverIds = new Set(serverRows.map((row) => row.id));
        await Promise.allSettled(localRows.filter((row) => !serverIds.has(row.id)).map((row) =>
          fetch('/api/chat-saved-replies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ id: row.id, chatId: row.chat_id, text: row.reply_text, createdAt: Date.parse(row.created_at) })
          })
        ));
      }
    } catch { /* local cache still makes bookmarks available offline */ }
  }
  const rowMap = new Map<string, ReplyRow>();
  [...serverRows, ...localRows].forEach((row) => {
    if (row.id) rowMap.set(row.id, row);
  });
  const rows = Array.from(rowMap.values()).sort((a, b) =>
    Date.parse(b.created_at || '') - Date.parse(a.created_at || '')
  );
  const titles = savedChatTitles();
  const groupMap = new Map<string, LibraryCourse>();
  rows.forEach((row) => {
    const chatId = String(row.chat_id || 'saved-responses');
    if (!groupMap.has(chatId)) {
      groupMap.set(chatId, {
        id: `responses:${chatId}`,
        name: titles.get(chatId) || 'AI conversation',
        short: 'AI'
      } as LibraryCourse);
    }
  });
  return {
    groups: Array.from(groupMap.values()),
    items: rows.filter((row) => row.id && row.reply_text).map((row) => {
      const chatId = String(row.chat_id || 'saved-responses');
      const text = String(row.reply_text || '');
      return {
        id: String(row.id),
        kind: 'responses' as const,
        title: responseTitle(text),
        course: groupMap.get(chatId)!,
        meta: formatDate(row.created_at),
        payload: { text }
      };
    })
  };
}

function authToken(): string {
  try {
    return window._sbToken || localStorage.getItem('sb_sess_token') || sessionStorage.getItem('sb_sess_token') || '';
  } catch { return window._sbToken || ''; }
}

function localBookmarkedResponses(): Array<{ id: string; chat_id: string; reply_text: string; created_at: string }> {
  try {
    const uid = window._currentUser?.id || window._currentUser?.sub || localStorage.getItem('ss_last_uid') || '';
    const raw = localStorage.getItem(`ss_ncb_chats_v1:${uid}`) || localStorage.getItem('ss_ncb_chats_v1');
    const parsed = raw ? JSON.parse(raw) as {
      chats?: Array<{ id?: string; savedReplies?: Array<{ id?: string; text?: string; createdAt?: number }> }>;
    } : null;
    return (parsed?.chats || []).flatMap((chat) => (chat.savedReplies || [])
      .filter((reply) => reply.id && reply.text)
      .map((reply) => ({
        id: reply.id!,
        chat_id: chat.id || 'saved-responses',
        reply_text: reply.text!,
        created_at: new Date(reply.createdAt || Date.now()).toISOString()
      })));
  } catch { return []; }
}

function savedChatTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const uid = window._currentUser?.id || window._currentUser?.sub || localStorage.getItem('ss_last_uid') || '';
    const raw = localStorage.getItem(`ss_ncb_chats_v1:${uid}`) || localStorage.getItem('ss_ncb_chats_v1');
    const parsed = raw ? JSON.parse(raw) as { chats?: Array<{ id?: string; title?: string }> } : null;
    parsed?.chats?.forEach((chat) => {
      if (chat.id) titles.set(chat.id, chat.title || 'AI conversation');
    });
  } catch { /* corrupted local cache should not hide server bookmarks */ }
  return titles;
}

function responseTitle(text: string): string {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`\[\]()]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 72 ? `${plain.slice(0, 69)}\u2026` : plain || 'Saved AI response';
}

function noteKind(type: string): SavedKind {
  const value = String(type || '').toLowerCase();
  if (value === 'summary') return 'summaries';
  if (value === 'cheatsheet') return 'cheatsheets';
  return 'notes';
}

async function fetchRows(table: string, courseId: string): Promise<Record<string, unknown>[]> {
  const db = window._ssDb;
  if (!db) return [];
  const response = await fetch(`${db.supaUrl()}/rest/v1/${table}?course_id=eq.${encodeURIComponent(courseId)}&order=created_at.desc&limit=50`, {
    headers: db.supaHeaders()
  });
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function formatDate(value?: string): string {
  if (!value) return 'Saved';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Saved' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function bindAccountMenu(root: HTMLElement): void {
  const trigger = root.querySelector<HTMLButtonElement>('.ncb-account-trigger');
  const menu = root.querySelector<HTMLElement>('.ncb-account-menu');
  if (!trigger || !menu) return;
  const profile = (() => {
    try {
      const uid = window._currentUser?.id || window._currentUser?.sub || localStorage.getItem('ss_last_uid') || '';
      return JSON.parse(localStorage.getItem('profile_cache_' + uid) || 'null') as { full_name?: string } | null;
    } catch { return null; }
  })();
  const name = profile?.full_name || window._currentUser?.email || 'Account';
  const label = trigger.querySelector<HTMLElement>('.ncb-account-name');
  if (label) label.textContent = name;

  const adminButton = menu.querySelector<HTMLButtonElement>('[data-admin-page]');
  let resolveAdminAccess: (() => Promise<boolean>) | null = null;
  if (adminButton) {
    const revealAdminButton = (isAdmin: boolean): void => {
      adminButton.hidden = !isAdmin;
    };
    revealAdminButton(window._userIsAdmin === true);
    resolveAdminAccess = async (): Promise<boolean> => {
      if (window._userIsAdmin === true) {
        revealAdminButton(true);
        return true;
      }
      if (!window._sbToken) {
        window._sbToken = localStorage.getItem('sb_sess_token')
          || sessionStorage.getItem('sb_sess_token')
          || localStorage.getItem('sb_token')
          || undefined;
      }
      try {
        const status = await checkAdminStatus();
        const isAdmin = Boolean((status as { isAdmin?: boolean } | null)?.isAdmin);
        window._userIsAdmin = isAdmin;
        revealAdminButton(isAdmin);
        return isAdmin;
      } catch {
        revealAdminButton(false);
        return false;
      }
    };
    void resolveAdminAccess();
    adminButton.addEventListener('click', () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      window.location.assign('/admin.html');
    });
  }

  trigger.addEventListener('click', async () => {
    const open = menu.hidden;
    if (open) await resolveAdminAccess?.();
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!root.querySelector<HTMLElement>('.ncb-account')?.contains(event.target as Node)) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
  menu.querySelectorAll<HTMLButtonElement>('[data-account-view]').forEach((button) => {
    button.addEventListener('click', () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      void openPortalView(root, button.dataset.accountView || '');
    });
  });
  root.querySelector<HTMLButtonElement>('.ncb-notification-trigger')?.addEventListener('click', () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    void openPortalView(root, 'notifications');
  });
  const notificationNav = document.getElementById('psbNotifications');
  if (notificationNav && notificationNav.dataset.ncbPopupBound !== '1') {
    notificationNav.dataset.ncbPopupBound = '1';
    notificationNav.addEventListener('click', (event) => {
      if (root.hidden || !root.isConnected) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void openPortalView(root, 'notifications');
    }, true);
  }
}

async function openPortalView(root: HTMLElement, view: string): Promise<void> {
  const titles: Record<string, string> = {
    profile: 'Profile',
    subscription: 'Subscription',
    lounge: 'Study Lounge',
    settings: 'Settings',
    notifications: 'Notifications'
  };
  const body = openOverlay(root, titles[view] || 'Minallo');
  if (!body) return;
  const overlay = body.closest<HTMLElement>('[data-workspace-overlay]');
  if (overlay) overlay.dataset.workspaceView = view;
  body.innerHTML = '<div class="ncb-library-status">Opening&hellip;</div>';
  if (view !== 'lounge') {
    // Inject the real section markup before executing its feature script. Some
    // legacy feature initialisers bind immediately on evaluation; loading both
    // concurrently could let the script win the race and leave an empty popup.
    await window._ssLoadFeatureSection?.(view);
    await window._ssLoadPortalFeature?.(view);
  }
  const section = document.getElementById('psec-' + view);
  if (!section) {
    body.innerHTML = '<div class="ncb-library-error">This view is not available right now.</div>';
    return;
  }
  const placeholder = document.createComment('ncb-overlay-origin');
  section.parentNode?.insertBefore(placeholder, section);
  section.dataset.ncbPreviousDisplay = section.style.display;
  section.hidden = false;
  section.removeAttribute('inert');
  section.setAttribute('aria-hidden', 'false');
  section.style.setProperty('display', 'block', 'important');
  body.innerHTML = '';
  body.appendChild(section);
  body.closest<HTMLElement>('[data-workspace-overlay]')!.dataset.movedSection = view;
  (body.closest<HTMLElement>('[data-workspace-overlay]') as HTMLElement & { _origin?: Comment })._origin = placeholder;
  if (view === 'subscription') await window.refreshSubscriptionView?.();
  if (view === 'notifications') {
    window.renderNotifications?.();
  }
}

function openOverlay(root: HTMLElement, title: string): HTMLElement | null {
  const overlay = root.querySelector<HTMLElement>('[data-workspace-overlay]');
  const body = overlay?.querySelector<HTMLElement>('.ncb-workspace-body');
  const dialog = overlay?.querySelector<HTMLElement>('.ncb-workspace-dialog');
  if (!overlay || !body || !dialog) return null;
  if (!overlay.hidden && overlay.dataset.movedSection) closeOverlay(overlay);
  delete overlay.dataset.workspaceView;
  dialog.setAttribute('aria-label', title);
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('ncb-overlay-open');
  const close = (): void => closeOverlay(overlay);
  const closeButton = overlay.querySelector<HTMLButtonElement>('.ncb-workspace-close');
  if (closeButton && closeButton.dataset.bound !== '1') {
    closeButton.dataset.bound = '1';
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !overlay.hidden) close();
    });
  }
  return body;
}

function closeOverlay(overlay: HTMLElement): void {
  const body = overlay.querySelector<HTMLElement>('.ncb-workspace-body');
  const moved = body?.firstElementChild as HTMLElement | null;
  const stateful = overlay as HTMLElement & { _origin?: Comment };
  if (moved && stateful._origin?.parentNode) {
    moved.style.removeProperty('display');
    moved.style.display = moved.dataset.ncbPreviousDisplay || 'none';
    moved.setAttribute('aria-hidden', 'true');
    delete moved.dataset.ncbPreviousDisplay;
    stateful._origin.parentNode.insertBefore(moved, stateful._origin);
    stateful._origin.remove();
  }
  if (body) body.innerHTML = '';
  delete stateful._origin;
  delete overlay.dataset.movedSection;
  delete overlay.dataset.workspaceView;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('ncb-overlay-open');
}

function mountCourseFeature(target: HTMLElement, course: LibraryCourse, kind: 'examforge'): void {
  if (kind === 'examforge' && typeof window.mountExamForge === 'function') {
    window.mountExamForge(target, course, { generate: window._generateStudyTool });
  } else {
    target.innerHTML = '<div class="ncb-library-error">This resource viewer is not available.</div>';
  }
}
