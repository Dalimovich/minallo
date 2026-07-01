import { fetchPdfBytes } from '../../services/pdf-service.js';
import { panelShow, panelHide, selectTopLevelView } from '../../core/panels.js';
import { setNavActive } from '../../core/navigation.js';
import { escapeHtml } from '../../utils/escape-html.js';
import { notePdfTabOpen } from './pdf-tabs.js';
import { setActivePane, snapshotWindowInto, type PaneId, isPaneOpen } from './pdf-panes.js';
import { clearCompareDoc } from './pdf-compare.js';
import type { LegacyCourse } from '../../../globals.js';

interface FileLite {
  name: string;
  _uploaded?: boolean;
  _storageName?: string;
  _folder?: string | null;
  _uid?: string;
  _course?: LegacyCourse;
}

interface StorageError extends Error {
  _storageError?: boolean;
}

export function pageKey(
  courseId: string | number | null | undefined,
  storageOrName: string | null | undefined
): string {
  const cid = courseId != null && courseId !== '' ? String(courseId) : 'demo';
  return 'ss_page_' + cid + '::' + (storageOrName || '');
}

function _activePageKey(): string | null {
  const id = window.activeStorageName || window.activeFileName;
  if (!id) return null;
  return pageKey(window.activeCourseId, id);
}

function _savePageBookmark(): void {
  const key = _activePageKey();
  const page = window.pdfPage;
  if (key && page && page > 1) {
    try { sessionStorage.setItem(key, String(page)); } catch { /* ignore */ }
  }
}

function _restorePageBookmark(
  courseId: string | number | null | undefined,
  storageOrName: string
): number | null {
  try {
    const saved = sessionStorage.getItem(pageKey(courseId, storageOrName));
    return saved ? parseInt(saved, 10) : null;
  } catch { return null; }
}

function _withFileOpenTimeout<T>(promise: Promise<T>, timeoutMs = 45000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('file open timeout');
      err.name = 'AbortError';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function openFile(f: FileLite, course: LegacyCourse, pane: PaneId = 'left'): void {
  _savePageBookmark();
  notePdfTabOpen(f, course);
  setActivePane(pane);

  const mySeq = ++(window._pdfOpenSeq as number);
  window.activeFileName = f.name;
  window.activeStorageName = f._storageName || null;
  window.currentCourseShort = course.short;
  window.activeCourseRef = course;
  if (course.id) window.activeCourseId = course.id;

  // Resolve this PDF's indexed document UUID so the AI panel can scope
  // retrieval directly via documentIds (no fragile filename-match fallback
  // at every question). Reset first so a stale value from the previous file
  // never leaks into the new one if the lookup fails or runs slowly.
  (window as unknown as { activeRagDocumentId?: string | null }).activeRagDocumentId = null;
  if (course.id) {
    void import('../../services/ai-service.js').then((mod) => {
      // Bail if the user opened a different file before the lookup resolved.
      if ((window._pdfOpenSeq as number) !== mySeq) return;
      return mod.listCourseDocuments(course.id!).then((docs) => {
        if ((window._pdfOpenSeq as number) !== mySeq) return;
        const target = (f.name || '').toLowerCase();
        const match = docs.find(
          (d) => d.processing_status === 'ready' && (d.file_name || '').toLowerCase() === target
        );
        if (match?.id) {
          (window as unknown as { activeRagDocumentId?: string | null }).activeRagDocumentId = match.id;
        }
      });
    }).catch(() => { /* best effort */ });
  }

  if (typeof window._statsTrackFile === 'function') {
    window._statsTrackFile(f.name, course.short || course.name || '');
  }

  // Top-level switch first — guarantees portal sections and studip view are
  // hidden so no ghost page lingers under the PDF.
  selectTopLevelView('file', { stRunning: !!(window as unknown as { _stRunning?: boolean })._stRunning });
  // The PDF viewer lives under the Courses route — reflect that in the sidebar so
  // whichever section the user opened the file from (e.g. Dashboard) doesn't stay
  // highlighted.
  setNavActive('pcStudip');
  panelHide(document.getElementById('welcomeState'));
  panelHide(document.getElementById('courseOverview'));
  const pv = document.getElementById('pdfView');
  panelShow(pv, true);
  (window as unknown as {
    __minalloDocRail?: { setRouteVisibility: (route: 'pdf' | 'courses' | 'other') => void };
  }).__minalloDocRail?.setRouteVisibility('pdf');
  if (typeof window.saveState === 'function') window.saveState();

  const pdfFileName = document.getElementById('pdfFileName');
  if (pdfFileName) pdfFileName.textContent = f.name;

  // Subtitle under the bold filename: "PDF viewer · <course name>"
  const pdfHeaderTitle = document.getElementById('pdfHeaderTitle');
  if (pdfHeaderTitle) {
    const courseLabel = course.name || course.short || '';
    pdfHeaderTitle.textContent = courseLabel
      ? 'PDF viewer · ' + courseLabel
      : 'PDF viewer';
  }

  const crumb = document.getElementById('breadcrumb');
  if (crumb) {
    crumb.textContent = (course.short || '') + ' › ';
    const b = document.createElement('b');
    b.textContent = f.name;
    crumb.appendChild(b);
  }

  const aiFileLabel = document.getElementById('aiFileLabel');
  if (aiFileLabel) aiFileLabel.textContent = f.name;
  if (typeof window._setAiChipsVisible === 'function') window._setAiChipsVisible(true);
  if (f._folder && window._openFolders) window._openFolders.add(f._folder);
  if (typeof window.renderCourses === 'function') window.renderCourses();

  if (f._uploaded) {
    const pdfBody = document.getElementById('pdfBody')!;
    pdfBody.innerHTML =
      '<div class="pdf-loading"><div class="loading-dots"><span></span><span></span><span></span></div><p>Loading…</p></div>';
    const uid =
      f._uid || (window._currentUser && (window._currentUser.id || window._currentUser.sub));
    const isHtml = /\.html?$/i.test(f.name);
    const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test(f.name);

    const fetchBytesPromise = window._ufFetchBytes?.(
      uid,
      f._course || course,
      f._storageName || f.name,
      f._folder || null
    );
    const fileBytesPromise = fetchBytesPromise
      ? _withFileOpenTimeout(fetchBytesPromise)
      : Promise.reject(new Error('Storage fetch helper is not available'));
    fileBytesPromise
      .then((bytes: Uint8Array) => {
        if (mySeq !== window._pdfOpenSeq) return;
        try {
          window.saveState?.();
          window._ssPushHistory?.(
            {
              view: 'file',
              courseId: (f._course || course).id || null,
              courseShort: (f._course || course).short || null,
              fileName: f.name || null,
              section: window.activeCourseSection || 'files',
            },
            '#file=' + encodeURIComponent(f.name || '')
          );
        } catch { /* ignore */ }

        // Split mode is a PDF-vs-PDF concept. If the user opens a non-PDF
        // (image, HTML) in the left pane while a split is active, close the
        // right pane — otherwise the split chrome stays visible, the AI
        // compare path runs against a left side with no extractable text,
        // and `bothPanesText()` returns only the right doc.
        if ((isHtml || isImage) && isPaneOpen('right')) clearCompareDoc();

        if (isHtml) {
          const blob = new Blob([bytes as BlobPart], { type: 'text/html' });
          const url = URL.createObjectURL(blob);
          pdfBody.innerHTML =
            '<iframe src="' + url +
            '" style="width:100%;height:100%;border:none;background:#fff" onload="URL.revokeObjectURL(this.src)"></iframe>';
          window.pdfDoc = null;
          window.pdfTotal = 0;
          window.pdfPage = 1;
          window.pdfFullText = '';
          if (typeof window.updatePageInfo === 'function') window.updatePageInfo();
          snapshotWindowInto(pane);
          return;
        }

        if (isImage) {
          const ext = (f.name.match(/\.(\w+)$/) || [])[1] || 'png';
          const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
            bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
          };
          const mime = mimeMap[ext.toLowerCase()] || 'image/' + ext.toLowerCase();
          const imgBlob = new Blob([bytes as BlobPart], { type: mime });
          const imgUrl = URL.createObjectURL(imgBlob);
          const imgWrapper = document.createElement('div');
          imgWrapper.id = 'ssImageViewerWrap';
          imgWrapper.style.cssText =
            'width:100%;height:100%;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px;box-sizing:border-box';
          const imgEl = document.createElement('img');
          imgEl.id = 'ssImageViewerImg';
          imgEl.src = imgUrl;
          imgEl.style.cssText =
            'max-width:100%;height:auto;border-radius:8px;transform-origin:top center;transition:transform .15s';
          imgEl.onload = () => URL.revokeObjectURL(imgUrl);
          imgWrapper.appendChild(imgEl);
          pdfBody.innerHTML = '';
          pdfBody.appendChild(imgWrapper);

          window.pdfDoc = null;
          window.pdfTotal = 0;
          window.pdfPage = 1;
          window.pdfFullText = '';
          window._ssImageViewerActive = true;
          if (typeof window.pdfScale === 'undefined') window.pdfScale = 0.9;
          if (typeof window.updatePageInfo === 'function') window.updatePageInfo();
          if (typeof window.updateZoomPct === 'function') window.updateZoomPct();

          if (!window._ssImageRenderPagesOrig) {
            window._ssImageRenderPagesOrig = window.renderPages;
          }
          window.renderPages = function (): void {
            if (!window._ssImageViewerActive) {
              if (typeof window._ssImageRenderPagesOrig === 'function') {
                window._ssImageRenderPagesOrig();
              }
              return;
            }
            const el = document.getElementById('ssImageViewerImg') as HTMLElement | null;
            if (el) {
              const s = (window.pdfScale || 0.9) / 0.9;
              el.style.transform = 'scale(' + s + ')';
              el.style.transformOrigin = 'top center';
            }
            if (typeof window.updateZoomPct === 'function') window.updateZoomPct();
          };

          if (typeof window._annotLoad === 'function') window._annotLoad(f.name);
          snapshotWindowInto(pane);
          return;
        }

        return window._ssEnsurePdfJs?.().then(() => {
          return window.pdfjsLib!
            .getDocument({
              data: bytes,
              cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
              cMapPacked: true,
            })
            .promise.then((pdf) => {
              if (window._ssImageViewerActive) {
                window._ssImageViewerActive = false;
                if (window._ssImageRenderPagesOrig) {
                  window.renderPages = window._ssImageRenderPagesOrig;
                  window._ssImageRenderPagesOrig = null;
                }
              }
              const pdfDoc = pdf as { numPages: number; getPage: (n: number) => Promise<unknown> };
              window.pdfDoc = pdfDoc;
              window.pdfTotal = pdfDoc.numPages;
              window.pdfPage = 1;
              // Default to single-page mode for large PDFs — rendering all
              // pages of a 200-page Skript freezes mid-range laptops. The
              // toolbar button below stays in sync.
              const _largePdf = pdfDoc.numPages > 20;
              window.pdfShowAll = !_largePdf;
              window.pdfFullText = '';
              if (typeof window.updatePageInfo === 'function') window.updatePageInfo();
              if (typeof window.updateZoomPct === 'function') window.updateZoomPct();
              const pdfAll = document.getElementById('pdfAll');
              if (pdfAll) pdfAll.textContent = _largePdf ? 'All pages' : 'Single page';
              if (typeof window._annotLoad === 'function') window._annotLoad(f.name);
              if (typeof window.renderPages === 'function') window.renderPages();
              snapshotWindowInto(pane);
              const savedPage = _restorePageBookmark(
                (f._course || course).id,
                f._storageName || f.name
              );
              if (savedPage && savedPage > 1 && savedPage <= pdfDoc.numPages) {
                setTimeout(() => {
                  if (window._pdfOpenSeq !== mySeq) return;
                  const inp = document.getElementById('pdfPageInput') as HTMLInputElement | null;
                  if (inp) {
                    inp.value = String(savedPage);
                    inp.dispatchEvent(new Event('blur'));
                  }
                }, 700);
              }
              // Skip eager text extraction when the backend has already
              // indexed this PDF — RAG retrieval covers AI answers, and
              // ai-ask.ts falls back to on-demand extraction for chips.
              const _ragIndexed = !!(window as unknown as { activeRagDocumentId?: string | null }).activeRagDocumentId;
              if (!_ragIndexed) {
                setTimeout(() => {
                  const maxPages = Math.min(pdfDoc.numPages, 30);
                  const tp: Promise<string>[] = [];
                  for (let pi = 1; pi <= maxPages; pi++) {
                    tp.push(
                      (pdfDoc.getPage(pi) as Promise<{ getTextContent: () => Promise<{ items: Array<{ str: string }> }> }>).then((pg) =>
                        pg.getTextContent().then((tc) => tc.items.map((it) => it.str).join(' '))
                      )
                    );
                  }
                  Promise.all(tp).then((pages) => {
                    if (window._pdfOpenSeq !== mySeq) return;
                    window.pdfFullText = pages.join('\n');
                    snapshotWindowInto(pane);
                  });
                }, 400);
              }
            });
        });
      })
      .catch((e: unknown) => {
        const err = e as StorageError;
        const isTimeout =
          err && (err.name === 'AbortError' || (err.message && err.message.indexOf('abort') !== -1));
        const isStorageError = !isTimeout && err && err._storageError === true;
        if (isStorageError && typeof window._ufDropCachedUploadedFile === 'function') {
          window._ufDropCachedUploadedFile(f._course || course, f);
        }
        if (typeof window.showToast === 'function') {
          window.showToast(
            isTimeout ? 'File load timed out' : 'Could not display file',
            isTimeout
              ? 'Network too slow. Try again.'
              : 'The file could not be rendered. Try re-uploading.'
          );
        }
        window.activeCourseSection = 'files';
        try { window.saveState?.(); } catch { /* ignore */ }
        try {
          window._ssReplaceHistory?.(
            { view: 'course', courseId: (f._course || course).id, section: 'files' },
            '#course=' + encodeURIComponent((f._course || course).id || '')
          );
        } catch { /* ignore */ }
        if (typeof window.renderCourses === 'function') window.renderCourses();
        pdfBody.innerHTML =
          '<div style="color:#fff;padding:40px;text-align:center;line-height:1.5">' +
          '❌ Could not load this uploaded file.<br>' +
          '<span style="font-size:.85rem;opacity:.72">The cached file entry was removed because Supabase Storage rejected the object request.</span><br>' +
          '<button id="staleFileBackBtn" style="margin-top:18px;padding:10px 18px;border-radius:12px;border:1px solid rgba(96,165,250,.35);background:rgba(37,99,235,.18);color:#93c5fd;font-weight:900;cursor:pointer">Back to files</button>' +
          '</div>';
        document.getElementById('staleFileBackBtn')?.addEventListener('click', () => {
          if (typeof window.openCourse === 'function') window.openCourse(f._course || course);
        });
      });
    return;
  }

  const pdfPath = window.PDF_DATA && window.PDF_DATA[f.name];
  const pdfBody = document.getElementById('pdfBody')!;
  if (!pdfPath) {
    pdfBody.innerHTML =
      '<div style="color:#fff;padding:40px;text-align:center;font-family:Fredoka One,cursive">📄 ' +
      f.name + '<br><span style="font-size:.85rem;opacity:.7">Not available in demo</span></div>';
    return;
  }

  pdfBody.innerHTML =
    '<div class="pdf-loading"><div class="loading-dots"><span></span><span></span><span></span></div><p>Loading PDF…</p></div>';

  fetchPdfBytes(
    pdfPath,
    (bytes) => {
      if (mySeq !== window._pdfOpenSeq) return;
      window
        ._ssEnsurePdfJs?.()
        .then(() => {
          return window.pdfjsLib!
            .getDocument({ data: bytes })
            .promise.then((pdf) => {
              if (mySeq !== window._pdfOpenSeq) return;
              if (window._ssImageViewerActive) {
                window._ssImageViewerActive = false;
                if (window._ssImageRenderPagesOrig) {
                  window.renderPages = window._ssImageRenderPagesOrig;
                  window._ssImageRenderPagesOrig = null;
                }
              }
              const pdfDoc = pdf as { numPages: number; getPage: (n: number) => Promise<unknown> };
              window.pdfDoc = pdfDoc;
              window.pdfTotal = pdfDoc.numPages;
              window.pdfPage = 1;
              const _largePdf = pdfDoc.numPages > 20;
              window.pdfShowAll = !_largePdf;
              window.pdfFullText = '';
              if (typeof window.updatePageInfo === 'function') window.updatePageInfo();
              if (typeof window.updateZoomPct === 'function') window.updateZoomPct();
              const pdfAll = document.getElementById('pdfAll');
              if (pdfAll) pdfAll.textContent = _largePdf ? 'All pages' : 'Single page';
              if (typeof window._annotLoad === 'function') window._annotLoad(f.name);
              if (typeof window.renderPages === 'function') window.renderPages();
              snapshotWindowInto(pane);
              setTimeout(() => {
                const maxPages = Math.min(pdfDoc.numPages, 30);
                const textPromises: Promise<string>[] = [];
                for (let pi = 1; pi <= maxPages; pi++) {
                  textPromises.push(
                    (pdfDoc.getPage(pi) as Promise<{ getTextContent: () => Promise<{ items: Array<{ str: string }> }> }>).then((pg) =>
                      pg.getTextContent().then((tc) => tc.items.map((it) => it.str).join(' '))
                    )
                  );
                }
                Promise.all(textPromises).then((pages) => {
                  if (window._pdfOpenSeq !== mySeq) return;
                  window.pdfFullText = pages.join('\n\n');
                  snapshotWindowInto(pane);
                });
              }, 800);
            });
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          pdfBody.innerHTML = '<div style="color:#fff;padding:40px">Error: ' + escapeHtml(msg) + '</div>';
        });
    },
    (e) => {
      pdfBody.innerHTML = '<div style="color:#fff;padding:40px">Error loading PDF: ' + escapeHtml(e.message) + '</div>';
    }
  );
}
