import { fetchPdfBytes } from '../../services/pdf-service.js';
import { panelShow, panelHide } from '../../core/panels.js';

function _bookmarkKey(fileName) { return 'ss_page_' + (fileName || ''); }

function _savePageBookmark() {
  var name = window.activeFileName;
  var page = window.pdfPage;
  if (name && page && page > 1) {
    try { sessionStorage.setItem(_bookmarkKey(name), String(page)); } catch (e) {}
  }
}

function _restorePageBookmark(fileName) {
  try {
    var saved = sessionStorage.getItem(_bookmarkKey(fileName));
    return saved ? parseInt(saved, 10) : null;
  } catch (e) { return null; }
}

export function openFile(f, course) {
  // Save page position for the file being left before switching
  _savePageBookmark();

  var _mySeq = ++window._pdfOpenSeq;
  window.activeFileName = f.name;
  window.currentCourseShort = course.short;
  window.activeCourseRef = course;
  if (course.id) window.activeCourseId = course.id;

  if (typeof window._statsTrackFile === 'function')
    window._statsTrackFile(f.name, course.short || course.name || '');

  panelHide(document.getElementById('welcomeState'));
  panelHide(document.getElementById('courseOverview'));
  var pv = document.getElementById('pdfView');
  panelShow(pv, true);
  // Save after panel is visible so the guard in saveState passes
  if (typeof window.saveState === 'function') window.saveState();

  document.getElementById('pdfFileName').textContent = f.name;

  var crumb = document.getElementById('breadcrumb');
  if (crumb) {
    crumb.textContent = course.short + ' › ';
    var b = document.createElement('b');
    b.textContent = f.name;
    crumb.appendChild(b);
  }

  document.getElementById('aiFileLabel').textContent = f.name;
  if (typeof window._setAiChipsVisible === 'function') window._setAiChipsVisible(true);
  if (f._folder && window._openFolders) window._openFolders.add(f._folder);
  if (typeof window.renderCourses === 'function') window.renderCourses();

  if (f._uploaded) {
    document.getElementById('pdfBody').innerHTML =
      '<div class="pdf-loading"><div class="loading-dots"><span></span><span></span><span></span></div><p>Loading…</p></div>';
    var uid =
      f._uid || (window._currentUser && (window._currentUser.id || window._currentUser.sub));
    var isHtml = /\.html?$/i.test(f.name);
    var isImage = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i.test(f.name);

    window
      ._ufFetchBytes(uid, f._course || course, f._storageName || f.name, f._folder || null)
      .then(function (bytes) {
        if (_mySeq !== window._pdfOpenSeq) return;
        try {
          window.saveState();
          window._ssPushHistory(
            {
              view: 'file',
              courseId: (f._course || course).id || null,
              courseShort: (f._course || course).short || null,
              fileName: f.name || null,
              section: window.activeCourseSection || 'files'
            },
            '#file=' + encodeURIComponent(f.name || '')
          );
        } catch (h) {}

        if (isHtml) {
          var blob = new Blob([bytes], { type: 'text/html' });
          var url = URL.createObjectURL(blob);
          document.getElementById('pdfBody').innerHTML =
            '<iframe src="' +
            url +
            '" style="width:100%;height:100%;border:none;background:#fff" onload="URL.revokeObjectURL(this.src)"></iframe>';
          window.pdfDoc = null;
          window.pdfTotal = 0;
          window.pdfPage = 1;
          window.pdfFullText = '';
          if (typeof window.updatePageInfo === 'function') window.updatePageInfo();
          return;
        }

        if (isImage) {
          var ext = (f.name.match(/\.(\w+)$/) || [])[1] || 'png';
          var mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };
          var mime = mimeMap[ext.toLowerCase()] || 'image/' + ext.toLowerCase();
          var imgBlob = new Blob([bytes], { type: mime });
          var imgUrl = URL.createObjectURL(imgBlob);
          var imgWrapper = document.createElement('div');
          imgWrapper.id = 'ssImageViewerWrap';
          imgWrapper.style.cssText = 'width:100%;height:100%;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px;box-sizing:border-box';
          var imgEl = document.createElement('img');
          imgEl.id = 'ssImageViewerImg';
          imgEl.src = imgUrl;
          imgEl.style.cssText = 'max-width:100%;height:auto;border-radius:8px;transform-origin:top center;transition:transform .15s';
          imgEl.onload = function () { URL.revokeObjectURL(imgUrl); };
          imgWrapper.appendChild(imgEl);
          var pdfBody = document.getElementById('pdfBody');
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

          // Hook renderPages so zoom buttons scale the image via CSS transform
          if (!window._ssImageRenderPagesOrig) {
            window._ssImageRenderPagesOrig = window.renderPages;
          }
          window.renderPages = function () {
            if (!window._ssImageViewerActive) {
              if (typeof window._ssImageRenderPagesOrig === 'function')
                window._ssImageRenderPagesOrig.apply(this, arguments);
              return;
            }
            var el = document.getElementById('ssImageViewerImg');
            if (el) {
              var s = (window.pdfScale || 0.9) / 0.9;
              el.style.transform = 'scale(' + s + ')';
              el.style.transformOrigin = 'top center';
            }
            if (typeof window.updateZoomPct === 'function') window.updateZoomPct();
          };

          // Load annotation layer so the user can draw on the image
          if (typeof window._annotLoad === 'function') window._annotLoad(f.name);
          return;
        }

        return window._ssEnsurePdfJs().then(function () {
          return window.pdfjsLib
            .getDocument({
              data: bytes,
              cMapUrl: 'https://unpkg.com/pdfjs-dist@3.11.174/cmaps/',
              cMapPacked: true
            })
            .promise.then(function (pdf) {
              // Leaving image viewer — restore original renderPages
              if (window._ssImageViewerActive) {
                window._ssImageViewerActive = false;
                if (window._ssImageRenderPagesOrig) {
                  window.renderPages = window._ssImageRenderPagesOrig;
                  window._ssImageRenderPagesOrig = null;
                }
              }
              window.pdfDoc = pdf;
              window.pdfTotal = pdf.numPages;
              window.pdfPage = 1;
              window.pdfShowAll = true;
              window.pdfFullText = '';
              if (typeof window.updatePageInfo === 'function') window.updatePageInfo();
              if (typeof window.updateZoomPct === 'function') window.updateZoomPct();
              document.getElementById('pdfAll').textContent = 'Single page';
              if (typeof window._annotLoad === 'function') window._annotLoad(f.name);
              if (typeof window.renderPages === 'function') window.renderPages();
              // Restore bookmarked page position after render settles
              var _savedPage = _restorePageBookmark(f.name);
              if (_savedPage && _savedPage > 1 && _savedPage <= pdf.numPages) {
                setTimeout(function () {
                  if (window._pdfOpenSeq !== _mySeq) return;
                  var inp = document.getElementById('pdfPageInput');
                  if (inp) {
                    inp.value = _savedPage;
                    inp.dispatchEvent(new Event('blur'));
                  }
                }, 700);
              }
              setTimeout(function () {
                var tp = [];
                for (var pi = 1; pi <= pdf.numPages; pi++) {
                  tp.push(
                    pdf.getPage(pi).then(function (pg) {
                      return pg.getTextContent().then(function (tc) {
                        return tc.items
                          .map(function (i) {
                            return i.str;
                          })
                          .join(' ');
                      });
                    })
                  );
                }
                Promise.all(tp).then(function (pages) {
                  window.pdfFullText = pages.join('\n');
                });
              }, 400);
            });
        });
      })
      .catch(function (e) {
        var isTimeout =
          e && (e.name === 'AbortError' || (e.message && e.message.indexOf('abort') !== -1));
        // Only evict the cached entry when storage itself rejected the fetch (HTTP error),
        // not when the browser failed to render the file (e.g. password-protected PDF).
        var isStorageError = !isTimeout && e && e._storageError === true;
        if (isStorageError && typeof window._ufDropCachedUploadedFile === 'function')
          window._ufDropCachedUploadedFile(f._course || course, f);
        if (typeof window.showToast === 'function')
          window.showToast(
            isTimeout ? 'File load timed out' : 'Could not display file',
            isTimeout ? 'Network too slow. Try again.' : 'The file could not be rendered. Try re-uploading.'
          );
        window.activeCourseSection = 'files';
        try {
          window.saveState();
        } catch (se) {}
        try {
          window._ssReplaceHistory(
            { view: 'course', courseId: (f._course || course).id, section: 'files' },
            '#course=' + encodeURIComponent((f._course || course).id || '')
          );
        } catch (he) {}
        if (typeof window.renderCourses === 'function') window.renderCourses();
        document.getElementById('pdfBody').innerHTML =
          '<div style="color:#fff;padding:40px;text-align:center;line-height:1.5">' +
          '❌ Could not load this uploaded file.<br>' +
          '<span style="font-size:.85rem;opacity:.72">The cached file entry was removed because Supabase Storage rejected the object request.</span><br>' +
          '<button id="staleFileBackBtn" style="margin-top:18px;padding:10px 18px;border-radius:12px;border:1px solid rgba(96,165,250,.35);background:rgba(37,99,235,.18);color:#93c5fd;font-weight:900;cursor:pointer">Back to files</button>' +
          '</div>';
        var staleBack = document.getElementById('staleFileBackBtn');
        if (staleBack)
          staleBack.addEventListener('click', function () {
            if (typeof window.openCourse === 'function') window.openCourse(f._course || course);
          });
      });
    return;
  }

  var pdfPath = window.PDF_DATA && window.PDF_DATA[f.name];
  if (!pdfPath) {
    document.getElementById('pdfBody').innerHTML =
      '<div style="color:#fff;padding:40px;text-align:center;font-family:Fredoka One,cursive">📄 ' +
      f.name +
      '<br><span style="font-size:.85rem;opacity:.7">Not available in demo</span></div>';
    return;
  }

  document.getElementById('pdfBody').innerHTML =
    '<div class="pdf-loading"><div class="loading-dots"><span></span><span></span><span></span></div><p>Loading PDF…</p></div>';

  fetchPdfBytes(
    pdfPath,
    function (bytes) {
      if (_mySeq !== window._pdfOpenSeq) return;
      window
        ._ssEnsurePdfJs()
        .then(function () {
          return window.pdfjsLib.getDocument({ data: bytes }).promise.then(function (pdf) {
            if (_mySeq !== window._pdfOpenSeq) return;
            if (window._ssImageViewerActive) {
              window._ssImageViewerActive = false;
              if (window._ssImageRenderPagesOrig) {
                window.renderPages = window._ssImageRenderPagesOrig;
                window._ssImageRenderPagesOrig = null;
              }
            }
            window.pdfDoc = pdf;
            window.pdfTotal = pdf.numPages;
            window.pdfPage = 1;
            window.pdfShowAll = true;
            window.pdfFullText = '';
            if (typeof window.updatePageInfo === 'function') window.updatePageInfo();
            if (typeof window.updateZoomPct === 'function') window.updateZoomPct();
            document.getElementById('pdfAll').textContent = 'Single page';
            if (typeof window._annotLoad === 'function') window._annotLoad(f.name);
            if (typeof window.renderPages === 'function') window.renderPages();
            setTimeout(function () {
              var textPromises = [];
              for (var pi = 1; pi <= pdf.numPages; pi++) {
                textPromises.push(
                  pdf.getPage(pi).then(function (pg) {
                    return pg.getTextContent().then(function (tc) {
                      return tc.items
                        .map(function (it) {
                          return it.str;
                        })
                        .join(' ');
                    });
                  })
                );
              }
              Promise.all(textPromises).then(function (pages) {
                window.pdfFullText = pages.join('\n\n');
              });
            }, 800);
          });
        })
        .catch(function (e) {
          document.getElementById('pdfBody').innerHTML =
            '<div style="color:#fff;padding:40px">Error: ' + e.message + '</div>';
        });
    },
    function (e) {
      document.getElementById('pdfBody').innerHTML =
        '<div style="color:#fff;padding:40px">Error loading PDF: ' + e.message + '</div>';
    }
  );
}
