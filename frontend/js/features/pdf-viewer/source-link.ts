// Clickable AI source citations.
//
// Three surfaces cite course material: the AI side rail (a PDF is open in the
// viewer), the chatbot, and ExamForge (no viewer). This module turns a cited
// source (file name + page) into the right action:
//   • side rail, same file open  → jump the open viewer to that page
//   • side rail, different file   → open that file in a new PDF tab at the page
//   • chatbot / ExamForge         → open a scrollable PDF popup at the page
//
// Resolution is by file name within the active course (the client file list is
// keyed by name, not document id); documentId is accepted for future use but
// name match is the working path. Best-effort throughout: an unresolvable file
// shows a toast rather than throwing.

import type { LegacyCourse } from '../../../globals.js';

export interface CitedSource {
  fileName?: string | null;
  documentId?: string | null;
  page?: number | null;
}

interface CourseFileRec {
  name?: string;
  id?: string;
  _storageName?: string;
  _folder?: string | null;
  _uid?: string;
  [k: string]: unknown;
}
interface CourseLike {
  id?: string;
  name?: string;
  files?: CourseFileRec[];
  userFolders?: Array<{ name: string; files: CourseFileRec[] }>;
  [k: string]: unknown;
}

// File names that are not standalone PDFs (the visible-page / problem-solver
// pseudo-source [Source 0]). Clicking these only makes sense as an in-place
// page jump, never a file open.
function _isPseudoSource(name: string): boolean {
  const n = name.trim().toLowerCase();
  return !n || n === 'source 0' || n.includes('problem solver') || n.includes('visible');
}

function _resolveFile(course: CourseLike | null, fileName: string): CourseFileRec | null {
  if (!course || !fileName) return null;
  const want = fileName.trim().toLowerCase();
  const match = (arr?: CourseFileRec[]): CourseFileRec | undefined =>
    (arr || []).find(
      (f) => String(f.name || f._storageName || '').trim().toLowerCase() === want
    );
  const direct = match(course.files);
  if (direct) return direct;
  for (const fd of course.userFolders || []) {
    const inFolder = match(fd.files);
    if (inFolder) return inFolder;
  }
  return null;
}

// All courses the client knows about: the active one first, then every course
// across all semesters. Lets a cited file be located even when the surface
// (e.g. the standalone chatbot) isn't scoped to the file's course.
function _allCourses(): CourseLike[] {
  const out: CourseLike[] = [];
  const active = window.activeCourseRef as unknown as CourseLike | null;
  if (active) out.push(active);
  const sems = (window.SEMS || window._SEMS) as
    | Record<string, { courses?: CourseLike[] }>
    | undefined;
  if (sems) {
    Object.values(sems).forEach((sem) =>
      (sem.courses || []).forEach((c) => {
        if (c && !out.includes(c)) out.push(c);
      })
    );
  }
  return out;
}

function _resolveAnywhere(fileName: string): { file: CourseFileRec; course: CourseLike } | null {
  if (!fileName) return null;
  for (const course of _allCourses()) {
    const file = _resolveFile(course, fileName);
    if (file) return { file, course };
  }
  return null;
}

// Resolve by document id. More robust than name matching when the stored file
// name is mangled (e.g. an upload that dropped non-ASCII chars: "Übung" →
// "bung"), since the id is exact. Course file records carry the same document
// UUID the backend cites as `documentId`.
function _resolveByIdAnywhere(documentId: string): { file: CourseFileRec; course: CourseLike } | null {
  const want = (documentId || '').trim();
  if (!want) return null;
  const match = (arr?: CourseFileRec[]): CourseFileRec | undefined =>
    (arr || []).find((f) => String(f.id || '') === want);
  for (const course of _allCourses()) {
    const direct = match(course.files);
    if (direct) return { file: direct, course };
    for (const fd of course.userFolders || []) {
      const inFolder = match(fd.files);
      if (inFolder) return { file: inFolder, course };
    }
  }
  return null;
}

function _jumpOpenPdf(page: number): void {
  if (!page || page < 1) return;
  window.pdfShowAll = false;
  window.pdfPage = page;
  window.updatePageInfo?.();
  window.renderPages?.();
}

// openFile loads the document asynchronously; poll until the page count is
// available, then jump. Bounded so a failed load can't loop forever.
function _jumpAfterLoad(page: number, tries = 0): void {
  if (!page) return;
  if (tries > 40) return; // ~6s ceiling
  if ((window.pdfTotal || 0) >= page) {
    _jumpOpenPdf(page);
    return;
  }
  setTimeout(() => _jumpAfterLoad(page, tries + 1), 150);
}

// ── popup PDF viewer ──────────────────────────────────────────────────────────

interface PdfPageLike {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
}
interface PdfDocLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
}

let _activePopup: HTMLElement | null = null;
let _popupEsc: ((e: KeyboardEvent) => void) | null = null;

export function closeSourcePopup(): void {
  if (_popupEsc) {
    document.removeEventListener('keydown', _popupEsc);
    _popupEsc = null;
  }
  if (_activePopup) {
    _activePopup.remove();
    _activePopup = null;
  }
}

export async function openSourcePopup(
  file: CourseFileRec,
  course: CourseLike,
  page: number
): Promise<void> {
  closeSourcePopup();
  const overlay = document.createElement('div');
  overlay.className = 'src-pdf-overlay';
  overlay.innerHTML =
    '<div class="src-pdf-modal" role="dialog" aria-modal="true">' +
    '<div class="src-pdf-head"><span class="src-pdf-title"></span>' +
    '<button class="src-pdf-close" aria-label="Close">×</button></div>' +
    '<div class="src-pdf-body"><div class="src-pdf-loading">Loading PDF…</div></div>' +
    '</div>';
  document.body.appendChild(overlay);
  _activePopup = overlay;

  const titleEl = overlay.querySelector('.src-pdf-title') as HTMLElement;
  titleEl.textContent = String(file.name || 'Source') + (page ? ' — p.' + page : '');
  overlay.querySelector('.src-pdf-close')?.addEventListener('click', () => closeSourcePopup());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSourcePopup();
  });
  _popupEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeSourcePopup();
  };
  document.addEventListener('keydown', _popupEsc);

  const body = overlay.querySelector('.src-pdf-body') as HTMLElement;
  try {
    await _renderPdfInto(body, file, course, page);
  } catch {
    body.innerHTML = '<div class="src-pdf-error">Could not open this PDF.</div>';
  }
}

async function _renderPdfInto(
  body: HTMLElement,
  file: CourseFileRec,
  course: CourseLike,
  targetPage: number
): Promise<void> {
  const w = window;
  await w._ssEnsurePdfJs?.();
  const pdfjs = w.pdfjsLib;
  if (!pdfjs || !w._ufFetchBytes) throw new Error('pdf unavailable');
  const uid = w._currentUser?.id || w._currentUser?.sub;
  const storageName = String(file._storageName || file.name || '');
  const bytes = await w._ufFetchBytes(uid, course as unknown as LegacyCourse, storageName, file._folder ?? null);
  if (!bytes) throw new Error('no bytes');

  const pdf = (await (
    pdfjs.getDocument({
      data: bytes,
      cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
      cMapPacked: true,
    }) as { promise: Promise<unknown> }
  ).promise) as PdfDocLike;

  // The popup may have been closed while bytes/doc loaded — bail quietly.
  if (!_activePopup || !body.isConnected) return;

  const total = pdf.numPages;
  const tp = targetPage >= 1 && targetPage <= total ? targetPage : 1;

  // Base (unscaled) size from page 1 — most PDFs are uniform, so this sizes the
  // lazy-render placeholders so the scrollbar is right before pages paint.
  const firstPage = await pdf.getPage(1);
  const baseVp = firstPage.getViewport({ scale: 1 });

  body.innerHTML = '';

  // Zoom toolbar: 100% = fit-to-width; the user zooms from there. Sticky so it
  // stays put while the pages scroll under it.
  const bar = document.createElement('div');
  bar.className = 'src-pdf-toolbar';
  bar.innerHTML =
    '<button class="src-pdf-zoom" data-z="out" aria-label="Zoom out">−</button>' +
    '<span class="src-pdf-zoom-val">100%</span>' +
    '<button class="src-pdf-zoom" data-z="in" aria-label="Zoom in">+</button>';
  body.appendChild(bar);

  const col = document.createElement('div');
  col.className = 'src-pdf-pages';
  body.appendChild(col);

  // Fit-to-width baseline, then a user zoom factor on top of it.
  const fitScale = Math.max(0.2, (body.clientWidth - 40) / baseVp.width);
  let zoom = 1;
  const zoomVal = bar.querySelector('.src-pdf-zoom-val') as HTMLElement;

  const wraps: HTMLElement[] = [];
  const rendered = new Set<number>();
  let io: IntersectionObserver | null = null;

  const renderPage = async (p: number): Promise<void> => {
    if (rendered.has(p) || !_activePopup) return;
    rendered.add(p);
    const wrap = wraps[p - 1];
    if (!wrap) return;
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: fitScale * zoom });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    if (!_activePopup || !wrap.isConnected) return;
    wrap.style.minHeight = '';
    wrap.replaceChildren(canvas);
    if (ctx) await page.render({ canvasContext: ctx, viewport: vp }).promise;
  };

  const build = (): void => {
    io?.disconnect();
    rendered.clear();
    wraps.length = 0;
    col.replaceChildren();
    const phW = baseVp.width * fitScale * zoom;
    const phH = baseVp.height * fitScale * zoom;
    for (let p = 1; p <= total; p++) {
      const wrap = document.createElement('div');
      wrap.className = 'src-pdf-page';
      wrap.dataset.pageNum = String(p);
      wrap.style.width = phW + 'px';
      wrap.style.minHeight = phH + 'px';
      col.appendChild(wrap);
      wraps.push(wrap);
    }
    // Render pages a screenful ahead/behind as they approach the viewport.
    io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) void renderPage(Number((e.target as HTMLElement).dataset.pageNum));
        });
      },
      { root: body, rootMargin: '800px 0px' }
    );
    wraps.forEach((wr) => io?.observe(wr));
  };

  // Scroll position of a page within the scroll container, offset for the
  // sticky toolbar so the page top isn't hidden under it.
  const pageScrollTop = (wrap: HTMLElement): number => {
    const barH = bar.offsetHeight || 46;
    const top = wrap.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    return Math.max(0, top - barH - 8);
  };

  const goToTarget = async (animate: boolean): Promise<void> => {
    await renderPage(tp); // paint the cited page first so it's there to land on
    const wrap = wraps[tp - 1];
    if (!wrap || !_activePopup) return;
    if (!animate) {
      body.scrollTop = pageScrollTop(wrap);
      return;
    }
    // Start at the top, briefly, then smoothly scroll down to the cited page so
    // the user sees where in the document it came from.
    body.scrollTop = 0;
    setTimeout(() => {
      if (!_activePopup || !wrap.isConnected) return;
      body.scrollTo({ top: pageScrollTop(wrap), behavior: 'smooth' });
    }, 250);
  };

  build();
  await goToTarget(tp > 1); // animate only when there's somewhere to scroll to

  bar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.src-pdf-zoom') as HTMLElement | null;
    if (!btn) return;
    const next = btn.dataset.z === 'in' ? zoom + 0.25 : zoom - 0.25;
    zoom = Math.min(3, Math.max(0.5, Math.round(next * 100) / 100));
    zoomVal.textContent = Math.round(zoom * 100) + '%';
    build();
    void goToTarget(false); // keep the cited page in view, no animation on zoom
  });
}

// ── public entry point ────────────────────────────────────────────────────────

export function handleSourceClick(src: CitedSource, surface: 'sidebar' | 'popup'): void {
  const fileName = String(src.fileName || '').trim();
  const documentId = String(src.documentId || '').trim();
  const page = firstPage(src.page); // tolerant of number | "12" | "12-14"

  if (_isPseudoSource(fileName)) {
    // The visible-page / problem-solver pseudo-source: only meaningful as an
    // in-place jump in the side rail.
    if (surface === 'sidebar' && page) _jumpOpenPdf(page);
    return;
  }

  // Prefer the document id (exact) over the file name, which may be mangled by
  // a lossy upload; fall back to name match when no id resolves.
  const resolved = _resolveByIdAnywhere(documentId) || _resolveAnywhere(fileName);

  if (surface === 'sidebar') {
    const open = String(window.activeFileName || '').trim().toLowerCase();
    if (open && open === fileName.toLowerCase()) {
      if (page) _jumpOpenPdf(page);
      return;
    }
    if (resolved && typeof window.openFile === 'function') {
      // Cross-document: open the cited file in a new PDF tab, then jump.
      window.openFile(resolved.file as unknown as object, resolved.course as unknown as LegacyCourse);
      _jumpAfterLoad(page);
      return;
    }
  }

  // Popup surface (chatbot / ExamForge), or side rail that couldn't open a tab.
  if (resolved) {
    void openSourcePopup(resolved.file, resolved.course, page);
  } else {
    window.showToast?.('Source unavailable', 'Could not locate "' + fileName + '" in your courses.');
  }
}

// Parse a page value that may be a number, "12", or a range "12-14" → first page.
export function firstPage(pages: unknown): number {
  if (typeof pages === 'number') return pages;
  const m = String(pages || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

// Expose globally so non-module views (e.g. the ExamForge view, a plain-JS
// IIFE that can't `import`) can open a cited source the same way.
window.openCitedSource = handleSourceClick;
