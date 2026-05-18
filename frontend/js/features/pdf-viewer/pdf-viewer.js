import { fetchPdfBytes } from '../../services/pdf-service.js';
import { panelShow, panelHide, selectTopLevelView } from '../../core/panels.js';
import { escapeHtml } from '../../utils/escape-html.js';
function _bookmarkKey(fileName) {
    return 'ss_page_' + (fileName || '');
}
function _savePageBookmark() {
    const name = window.activeFileName;
    const page = window.pdfPage;
    if (name && page && page > 1) {
        try {
            sessionStorage.setItem(_bookmarkKey(name), String(page));
        }
        catch { /* ignore */ }
    }
}
function _restorePageBookmark(fileName) {
    try {
        const saved = sessionStorage.getItem(_bookmarkKey(fileName));
        return saved ? parseInt(saved, 10) : null;
    }
    catch {
        return null;
    }
}
export function openFile(f, course) {
    _savePageBookmark();
    const mySeq = ++window._pdfOpenSeq;
    window.activeFileName = f.name;
    window.currentCourseShort = course.short;
    window.activeCourseRef = course;
    if (course.id)
        window.activeCourseId = course.id;
    if (typeof window._statsTrackFile === 'function') {
        window._statsTrackFile(f.name, course.short || course.name || '');
    }
    // Top-level switch first — guarantees portal sections and studip view are
    // hidden so no ghost page lingers under the PDF.
    selectTopLevelView('file', { stRunning: !!window._stRunning });
    panelHide(document.getElementById('welcomeState'));
    panelHide(document.getElementById('courseOverview'));
    const pv = document.getElementById('pdfView');
    panelShow(pv, true);
    if (typeof window.saveState === 'function')
        window.saveState();
    const pdfFileName = document.getElementById('pdfFileName');
    if (pdfFileName)
        pdfFileName.textContent = f.name;
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
    if (aiFileLabel)
        aiFileLabel.textContent = f.name;
    if (typeof window._setAiChipsVisible === 'function')
        window._setAiChipsVisible(true);
    if (f._folder && window._openFolders)
        window._openFolders.add(f._folder);
    if (typeof window.renderCourses === 'function')
        window.renderCourses();
    if (f._uploaded) {
        const pdfBody = document.getElementById('pdfBody');
        pdfBody.innerHTML =
            '<div class="pdf-loading"><div class="loading-dots"><span></span><span></span><span></span></div><p>Loading…</p></div>';
        const uid = f._uid || (window._currentUser && (window._currentUser.id || window._currentUser.sub));
        const isHtml = /\.html?$/i.test(f.name);
        const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test(f.name);
        window
            ._ufFetchBytes?.(uid, f._course || course, f._storageName || f.name, f._folder || null)
            .then((bytes) => {
            if (mySeq !== window._pdfOpenSeq)
                return;
            try {
                window.saveState?.();
                window._ssPushHistory?.({
                    view: 'file',
                    courseId: (f._course || course).id || null,
                    courseShort: (f._course || course).short || null,
                    fileName: f.name || null,
                    section: window.activeCourseSection || 'files',
                }, '#file=' + encodeURIComponent(f.name || ''));
            }
            catch { /* ignore */ }
            if (isHtml) {
                const blob = new Blob([bytes], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                pdfBody.innerHTML =
                    '<iframe src="' + url +
                        '" style="width:100%;height:100%;border:none;background:#fff" onload="URL.revokeObjectURL(this.src)"></iframe>';
                window.pdfDoc = null;
                window.pdfTotal = 0;
                window.pdfPage = 1;
                window.pdfFullText = '';
                if (typeof window.updatePageInfo === 'function')
                    window.updatePageInfo();
                return;
            }
            if (isImage) {
                const ext = (f.name.match(/\.(\w+)$/) || [])[1] || 'png';
                const mimeMap = {
                    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
                    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
                    bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
                };
                const mime = mimeMap[ext.toLowerCase()] || 'image/' + ext.toLowerCase();
                const imgBlob = new Blob([bytes], { type: mime });
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
                if (typeof window.pdfScale === 'undefined')
                    window.pdfScale = 0.9;
                if (typeof window.updatePageInfo === 'function')
                    window.updatePageInfo();
                if (typeof window.updateZoomPct === 'function')
                    window.updateZoomPct();
                if (!window._ssImageRenderPagesOrig) {
                    window._ssImageRenderPagesOrig = window.renderPages;
                }
                window.renderPages = function () {
                    if (!window._ssImageViewerActive) {
                        if (typeof window._ssImageRenderPagesOrig === 'function') {
                            window._ssImageRenderPagesOrig();
                        }
                        return;
                    }
                    const el = document.getElementById('ssImageViewerImg');
                    if (el) {
                        const s = (window.pdfScale || 0.9) / 0.9;
                        el.style.transform = 'scale(' + s + ')';
                        el.style.transformOrigin = 'top center';
                    }
                    if (typeof window.updateZoomPct === 'function')
                        window.updateZoomPct();
                };
                if (typeof window._annotLoad === 'function')
                    window._annotLoad(f.name);
                return;
            }
            return window._ssEnsurePdfJs?.().then(() => {
                return window.pdfjsLib
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
                    const pdfDoc = pdf;
                    window.pdfDoc = pdfDoc;
                    window.pdfTotal = pdfDoc.numPages;
                    window.pdfPage = 1;
                    window.pdfShowAll = true;
                    window.pdfFullText = '';
                    if (typeof window.updatePageInfo === 'function')
                        window.updatePageInfo();
                    if (typeof window.updateZoomPct === 'function')
                        window.updateZoomPct();
                    const pdfAll = document.getElementById('pdfAll');
                    if (pdfAll)
                        pdfAll.textContent = 'Single page';
                    if (typeof window._annotLoad === 'function')
                        window._annotLoad(f.name);
                    if (typeof window.renderPages === 'function')
                        window.renderPages();
                    const savedPage = _restorePageBookmark(f.name);
                    if (savedPage && savedPage > 1 && savedPage <= pdfDoc.numPages) {
                        setTimeout(() => {
                            if (window._pdfOpenSeq !== mySeq)
                                return;
                            const inp = document.getElementById('pdfPageInput');
                            if (inp) {
                                inp.value = String(savedPage);
                                inp.dispatchEvent(new Event('blur'));
                            }
                        }, 700);
                    }
                    setTimeout(() => {
                        const tp = [];
                        for (let pi = 1; pi <= pdfDoc.numPages; pi++) {
                            tp.push(pdfDoc.getPage(pi).then((pg) => pg.getTextContent().then((tc) => tc.items.map((it) => it.str).join(' '))));
                        }
                        Promise.all(tp).then((pages) => {
                            window.pdfFullText = pages.join('\n');
                        });
                    }, 400);
                });
            });
        })
            .catch((e) => {
            const err = e;
            const isTimeout = err && (err.name === 'AbortError' || (err.message && err.message.indexOf('abort') !== -1));
            const isStorageError = !isTimeout && err && err._storageError === true;
            if (isStorageError && typeof window._ufDropCachedUploadedFile === 'function') {
                window._ufDropCachedUploadedFile(f._course || course, f);
            }
            if (typeof window.showToast === 'function') {
                window.showToast(isTimeout ? 'File load timed out' : 'Could not display file', isTimeout
                    ? 'Network too slow. Try again.'
                    : 'The file could not be rendered. Try re-uploading.');
            }
            window.activeCourseSection = 'files';
            try {
                window.saveState?.();
            }
            catch { /* ignore */ }
            try {
                window._ssReplaceHistory?.({ view: 'course', courseId: (f._course || course).id, section: 'files' }, '#course=' + encodeURIComponent((f._course || course).id || ''));
            }
            catch { /* ignore */ }
            if (typeof window.renderCourses === 'function')
                window.renderCourses();
            pdfBody.innerHTML =
                '<div style="color:#fff;padding:40px;text-align:center;line-height:1.5">' +
                    '❌ Could not load this uploaded file.<br>' +
                    '<span style="font-size:.85rem;opacity:.72">The cached file entry was removed because Supabase Storage rejected the object request.</span><br>' +
                    '<button id="staleFileBackBtn" style="margin-top:18px;padding:10px 18px;border-radius:12px;border:1px solid rgba(96,165,250,.35);background:rgba(37,99,235,.18);color:#93c5fd;font-weight:900;cursor:pointer">Back to files</button>' +
                    '</div>';
            document.getElementById('staleFileBackBtn')?.addEventListener('click', () => {
                if (typeof window.openCourse === 'function')
                    window.openCourse(f._course || course);
            });
        });
        return;
    }
    const pdfPath = window.PDF_DATA && window.PDF_DATA[f.name];
    const pdfBody = document.getElementById('pdfBody');
    if (!pdfPath) {
        pdfBody.innerHTML =
            '<div style="color:#fff;padding:40px;text-align:center;font-family:Fredoka One,cursive">📄 ' +
                f.name + '<br><span style="font-size:.85rem;opacity:.7">Not available in demo</span></div>';
        return;
    }
    pdfBody.innerHTML =
        '<div class="pdf-loading"><div class="loading-dots"><span></span><span></span><span></span></div><p>Loading PDF…</p></div>';
    fetchPdfBytes(pdfPath, (bytes) => {
        if (mySeq !== window._pdfOpenSeq)
            return;
        window
            ._ssEnsurePdfJs?.()
            .then(() => {
            return window.pdfjsLib
                .getDocument({ data: bytes })
                .promise.then((pdf) => {
                if (mySeq !== window._pdfOpenSeq)
                    return;
                if (window._ssImageViewerActive) {
                    window._ssImageViewerActive = false;
                    if (window._ssImageRenderPagesOrig) {
                        window.renderPages = window._ssImageRenderPagesOrig;
                        window._ssImageRenderPagesOrig = null;
                    }
                }
                const pdfDoc = pdf;
                window.pdfDoc = pdfDoc;
                window.pdfTotal = pdfDoc.numPages;
                window.pdfPage = 1;
                window.pdfShowAll = true;
                window.pdfFullText = '';
                if (typeof window.updatePageInfo === 'function')
                    window.updatePageInfo();
                if (typeof window.updateZoomPct === 'function')
                    window.updateZoomPct();
                const pdfAll = document.getElementById('pdfAll');
                if (pdfAll)
                    pdfAll.textContent = 'Single page';
                if (typeof window._annotLoad === 'function')
                    window._annotLoad(f.name);
                if (typeof window.renderPages === 'function')
                    window.renderPages();
                setTimeout(() => {
                    const textPromises = [];
                    for (let pi = 1; pi <= pdfDoc.numPages; pi++) {
                        textPromises.push(pdfDoc.getPage(pi).then((pg) => pg.getTextContent().then((tc) => tc.items.map((it) => it.str).join(' '))));
                    }
                    Promise.all(textPromises).then((pages) => {
                        window.pdfFullText = pages.join('\n\n');
                    });
                }, 800);
            });
        })
            .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            pdfBody.innerHTML = '<div style="color:#fff;padding:40px">Error: ' + escapeHtml(msg) + '</div>';
        });
    }, (e) => {
        pdfBody.innerHTML = '<div style="color:#fff;padding:40px">Error loading PDF: ' + escapeHtml(e.message) + '</div>';
    });
}
//# sourceMappingURL=pdf-viewer.js.map