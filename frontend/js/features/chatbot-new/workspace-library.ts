import { getNoteById, listCourseNotes, type SavedNote } from '../../services/ai-service.js';
import { renderMarkdown } from '../ai-chat/ai-markdown.js';
import { escapeHtml } from '../../utils/escape-html.js';
import type { LegacyCourse } from '../../../globals.js';

type CourseFile = { name: string; _storageName?: string; _folder?: string | null; size?: string };
type CourseFolder = { name: string; files?: CourseFile[] };
type LibraryCourse = LegacyCourse & { files?: CourseFile[]; userFolders?: CourseFolder[] };
type SavedKind = 'notes' | 'summaries' | 'flashcards' | 'cheatsheets' | 'exams';
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
  exams: 'Practice exams'
};

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
    flashcards: 'FC', cheatsheets: 'CS', exams: 'EX'
  };
  return `<span class="ncb-library-icon ncb-library-icon--${kind}">${glyph[kind]}</span>`;
}

function hydrate(course: LibraryCourse): Promise<void> {
  return typeof window._ufMerge === 'function'
    ? Promise.resolve(window._ufMerge(course))
    : Promise.resolve();
}

export function initWorkspaceLibrary(root: HTMLElement): void {
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

  bindAccountMenu(root);
  renderCourses(coursePanel);
}

function renderCourses(panel: HTMLElement): void {
  const all = courses();
  if (!all.length) {
    panel.innerHTML = '<div class="ncb-library-empty"><strong>No courses yet</strong><span>Create a course from the Courses page to see it here.</span></div>';
    return;
  }
  panel.innerHTML =
    '<div class="ncb-library-section-head"><div><strong>Courses</strong><span>Select a course to browse its material.</span></div></div>' +
    '<div class="ncb-course-list">' +
    all.map((course) => `
      <button type="button" class="ncb-course-row" data-course-id="${escapeHtml(course.id)}">
        ${icon('course')}
        <span><strong>${escapeHtml(course.name || 'Untitled course')}</strong><small>${fileCount(course)} files</small></span>
        <b aria-hidden="true">›</b>
      </button>`).join('') +
    '</div><div class="ncb-course-detail"></div>';

  panel.querySelectorAll<HTMLButtonElement>('.ncb-course-row').forEach((row) => {
    row.addEventListener('click', () => {
      const course = all.find((item) => item.id === row.dataset.courseId);
      if (!course) return;
      panel.querySelectorAll('.ncb-course-row').forEach((item) => item.classList.remove('ncb-course-row--active'));
      row.classList.add('ncb-course-row--active');
      void renderCourseDetail(panel, course);
    });
  });
}

async function renderCourseDetail(panel: HTMLElement, course: LibraryCourse): Promise<void> {
  const detail = panel.querySelector<HTMLElement>('.ncb-course-detail');
  if (!detail) return;
  detail.innerHTML = '<div class="ncb-library-status">Loading files and folders&hellip;</div>';
  try {
    await hydrate(course);
  } catch {
    detail.innerHTML = '<div class="ncb-library-error">Could not load this course. Please try again.</div>';
    return;
  }
  const folders = (course.userFolders || []) as CourseFolder[];
  const files = (course.files || []) as CourseFile[];
  detail.innerHTML = `
    <div class="ncb-course-detail-head">
      <div><strong>${escapeHtml(course.name || 'Course')}</strong><span>${fileCount(course)} files</span></div>
      <button type="button" class="ncb-course-manage">Manage</button>
    </div>
    ${folders.length ? `<div class="ncb-library-group"><h3>Folders</h3>${folders.map((folder) => `
      <details class="ncb-folder">
        <summary>${icon('folder')}<span><strong>${escapeHtml(folder.name)}</strong><small>${(folder.files || []).length} files</small></span></summary>
        <div>${(folder.files || []).map((file) => fileButton(file, course, folder.name)).join('') || '<p class="ncb-library-muted">Empty folder</p>'}</div>
      </details>`).join('')}</div>` : ''}
    <div class="ncb-library-group"><h3>Files</h3>${files.map((file) => fileButton(file, course, null)).join('') || '<p class="ncb-library-muted">No files in the course root.</p>'}</div>`;

  detail.querySelector<HTMLButtonElement>('.ncb-course-manage')?.addEventListener('click', () => {
    window.openCourse?.(course);
  });
  detail.querySelectorAll<HTMLButtonElement>('[data-library-file]').forEach((button) => {
    button.addEventListener('click', () => {
      const folder = button.dataset.folder || null;
      const collection = folder
        ? (course.userFolders || []).find((item) => item.name === folder)?.files || []
        : course.files || [];
      const file = collection.find((item) => item.name === button.dataset.libraryFile);
      if (file) window.openFile?.(file, course);
    });
  });
}

function fileButton(file: CourseFile, course: LibraryCourse, folder: string | null): string {
  return `<button type="button" class="ncb-file-row" data-library-file="${escapeHtml(file.name)}" data-folder="${escapeHtml(folder || '')}">
    ${icon('file')}<span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.size || course.name || 'Course file')}</small></span><b>Open</b>
  </button>`;
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
    const items = groups.flat();
    panel.dataset.loaded = '1';
    panel.innerHTML = savedHtml(items, allCourses);
    bindSaved(panel, root, items);
  } catch {
    panel.innerHTML = '<div class="ncb-library-error">Saved resources could not be loaded. Check your connection and try again.</div>';
  }
}

function savedHtml(items: SavedItem[], allCourses: LibraryCourse[]): string {
  if (!items.length) return '<div class="ncb-library-empty"><strong>Nothing saved yet</strong><span>Your notes, summaries, flashcards, cheatsheets and exams will appear here.</span></div>';
  return (Object.keys(kindLabels) as SavedKind[]).map((kind) => {
    const ofKind = items.filter((item) => item.kind === kind);
    if (!ofKind.length) return '';
    return `<section class="ncb-saved-function"><h3>${kindLabels[kind]} <span>${ofKind.length}</span></h3>${
      allCourses.map((course) => {
        const grouped = ofKind.filter((item) => item.course.id === course.id);
        if (!grouped.length) return '';
        return `<div class="ncb-saved-course"><h4>${escapeHtml(course.name || 'Course')}</h4>${grouped.map((item) => `
          <button type="button" class="ncb-saved-row" data-saved-kind="${item.kind}" data-saved-id="${escapeHtml(item.id)}">
            ${icon(item.kind)}<span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></span><b>Open</b>
          </button>`).join('')}</div>`;
      }).join('')
    }</section>`;
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
  if (item.note) {
    const note = await getNoteById(item.note.id);
    overlay.innerHTML = note
      ? `<article class="ncb-resource-document">${renderMarkdown(note.content_markdown || '')}</article>`
      : '<div class="ncb-library-error">This saved resource is no longer available.</div>';
    return;
  }
  if (item.kind === 'flashcards') {
    const deck = item.payload as { cards?: Array<{ front?: string; back?: string; question?: string; answer?: string }> };
    overlay.innerHTML = `<div class="ncb-popup-flashcards">${(deck.cards || []).map((card, index) => `
      <article><span>Card ${index + 1}</span><h3>${escapeHtml(card.front || card.question || '')}</h3><p>${escapeHtml(card.back || card.answer || '')}</p></article>`).join('')}</div>`;
    return;
  }
  mountCourseFeature(overlay, item.course, 'examforge');
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
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  const avatar = trigger.querySelector<HTMLElement>('.ncb-account-avatar');
  const label = trigger.querySelector<HTMLElement>('.ncb-account-name');
  if (avatar) avatar.textContent = initial;
  if (label) label.textContent = name;

  trigger.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  });
  menu.querySelectorAll<HTMLButtonElement>('[data-account-view]').forEach((button) => {
    button.addEventListener('click', () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      void openPortalView(root, button.dataset.accountView || '');
    });
  });
}

async function openPortalView(root: HTMLElement, view: string): Promise<void> {
  const titles: Record<string, string> = { profile: 'Profile', subscription: 'Subscription', lounge: 'Study Lounge', settings: 'Settings' };
  const body = openOverlay(root, titles[view] || 'Minallo');
  if (!body) return;
  body.innerHTML = '<div class="ncb-library-status">Opening&hellip;</div>';
  if (view !== 'lounge') {
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
  section.style.display = 'block';
  body.innerHTML = '';
  body.appendChild(section);
  body.closest<HTMLElement>('[data-workspace-overlay]')!.dataset.movedSection = view;
  (body.closest<HTMLElement>('[data-workspace-overlay]') as HTMLElement & { _origin?: Comment })._origin = placeholder;
}

function openOverlay(root: HTMLElement, title: string): HTMLElement | null {
  const overlay = root.querySelector<HTMLElement>('[data-workspace-overlay]');
  const body = overlay?.querySelector<HTMLElement>('.ncb-workspace-body');
  const heading = overlay?.querySelector<HTMLElement>('#ncbWorkspaceTitle');
  if (!overlay || !body || !heading) return null;
  heading.textContent = title;
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
    moved.style.display = moved.dataset.ncbPreviousDisplay || 'none';
    delete moved.dataset.ncbPreviousDisplay;
    stateful._origin.parentNode.insertBefore(moved, stateful._origin);
    stateful._origin.remove();
  }
  if (body) body.innerHTML = '';
  delete stateful._origin;
  delete overlay.dataset.movedSection;
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
