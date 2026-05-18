(function () {
  var container = document.getElementById('psec-editor');
  if (!container) return;
  fetch('views/editor/editor.html')
    .then(function (r) {
      return r.text();
    })
    .then(function (html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var sec = tmp.querySelector('#psec-editor');
      if (sec) {
        container.className = sec.className;
        container.style.cssText = sec.getAttribute('style') || '';
        while (sec.firstChild) container.appendChild(sec.firstChild);
        var writer = container.querySelector('.editor-card');
        if (writer) writer.style.display = 'none';
      }
      window.dispatchEvent(new Event('ss-editor-ready'));
      _init();
    });
  function _init() {
    // ── EDITOR HUB ───────────────────────────────────────────────────────────────

    function _edHubShow() {
      var hub = document.getElementById('editorHub');
      var writer =
        document.getElementById('editor-card') ||
        document.querySelector('#psec-editor .editor-card');
      var pdfEd = document.getElementById('editorPdfEditorView');
      var pdfMg = document.getElementById('editorPdfMergerView');
      if (hub) {
        hub.style.display = 'flex';
        hub._edSkipHub = false;
      }
      if (writer) writer.style.display = 'none';
      if (pdfEd) pdfEd.style.display = 'none';
      if (pdfMg) pdfMg.style.display = 'none';
      try {
        localStorage.removeItem('ss_editor_sub');
        history.replaceState({ view: 'portal', section: 'editor' }, '', '#portal=editor');
      } catch (e) {}
    }
    window._edHubShow = _edHubShow;

    function _edHubShowWriter() {
      var hub = document.getElementById('editorHub');
      var writer = document.querySelector('#psec-editor .editor-card');
      if (hub) {
        hub.style.display = 'none';
        hub._edSkipHub = true;
      }
      if (writer) writer.style.display = 'flex';
      if (window._writerInit) window._writerInit();
      else if (window._editorInit) window._editorInit();
      try {
        history.replaceState(
          { view: 'portal', section: 'editor', sub: 'writer' },
          '',
          '#portal=editor:writer'
        );
        localStorage.setItem('ss_last_section', 'editor');
        localStorage.setItem('ss_editor_sub', 'writer');
      } catch (e) {}
    }

    function _edHubShowPdfEditor() {
      var hub = document.getElementById('editorHub');
      var pdfEd = document.getElementById('editorPdfEditorView');
      if (hub) hub.style.display = 'none';
      if (pdfEd) pdfEd.style.display = 'flex';
      _edPdfEditorInit();
      try {
        history.replaceState(
          { view: 'portal', section: 'editor', sub: 'pdf' },
          '',
          '#portal=editor:pdf'
        );
        localStorage.setItem('ss_last_section', 'editor');
        localStorage.setItem('ss_editor_sub', 'pdf');
      } catch (e) {}
    }

    function _edHubShowPdfMerger() {
      var hub = document.getElementById('editorHub');
      var pdfMg = document.getElementById('editorPdfMergerView');
      if (hub) hub.style.display = 'none';
      if (pdfMg) pdfMg.style.display = 'flex';
      if (window._edPdfMergerInit) window._edPdfMergerInit();
      try {
        history.replaceState(
          { view: 'portal', section: 'editor', sub: 'merger' },
          '',
          '#portal=editor:merger'
        );
        localStorage.setItem('ss_last_section', 'editor');
        localStorage.setItem('ss_editor_sub', 'merger');
      } catch (e) {}
    }

    (function () {
      function _wire() {
        var writerBtn = document.getElementById('edHubWriter');
        var pdfEdBtn = document.getElementById('edHubPdfEditor');
        var pdfMgBtn = document.getElementById('edHubPdfMerger');
        if (writerBtn && !writerBtn._edHubWired) {
          writerBtn._edHubWired = true;
          writerBtn.addEventListener('click', _edHubShowWriter);
        }
        if (pdfEdBtn && !pdfEdBtn._edHubWired) {
          pdfEdBtn._edHubWired = true;
          pdfEdBtn.addEventListener('click', _edHubShowPdfEditor);
        }
        if (pdfMgBtn && !pdfMgBtn._edHubWired) {
          pdfMgBtn._edHubWired = true;
          pdfMgBtn.addEventListener('click', _edHubShowPdfMerger);
        }
        var backEd = document.getElementById('edPdfEditorBack');
        var backMg = document.getElementById('edPdfMergerBack');
        if (backEd && !backEd._edWired) {
          backEd._edWired = true;
          backEd.addEventListener('click', _edHubShow);
        }
        if (backMg && !backMg._edWired) {
          backMg._edWired = true;
          backMg.addEventListener('click', _edHubShow);
        }
      }
      window.addEventListener('ss-ready', _wire);
      _wire();

      // Restore sub-view on refresh
      window.addEventListener('ss-ready', function () {
        var sub = localStorage.getItem('ss_editor_sub');
        if (!sub) return;
        // Only auto-restore if the editor section is actually active
        var sec = localStorage.getItem('ss_last_section');
        if (sec !== 'editor') return;
        setTimeout(function () {
          if (sub === 'writer') _edHubShowWriter();
          else if (sub === 'pdf') _edHubShowPdfEditor();
          else if (sub === 'merger') _edHubShowPdfMerger();
        }, 300);
      });
    })();

    // ── PDF MERGER ───────────────────────────────────────────────────────────────
    var _edPdfMergerInited = false;
    window._edPdfMergerInit = function () {
      if (_edPdfMergerInited) return;
      _edPdfMergerInited = true;

      var _mergerFiles = []; // [{name, arrayBuffer, pageCount}]
      var fileList = document.getElementById('edPdfMergerFileList');
      var totalFilesEl = document.getElementById('edMgTotalFiles');
      var totalPagesEl = document.getElementById('edMgTotalPages');
      var chooseBtn = document.getElementById('edPdfMergerChooseBtn');
      var runBtn = document.getElementById('edPdfMergerRunBtn');
      var filenameInput = document.getElementById('edPdfMergerFilename');
      var mergerInput = document.createElement('input');
      mergerInput.type = 'file';
      mergerInput.accept = '.pdf';
      mergerInput.multiple = true;
      mergerInput.style.display = 'none';
      document.body.appendChild(mergerInput);

      function _updateStats() {
        var totalPages = _mergerFiles.reduce(function (s, f) {
          return s + (f.pageCount || 0);
        }, 0);
        if (totalFilesEl) totalFilesEl.textContent = _mergerFiles.length;
        if (totalPagesEl) totalPagesEl.textContent = totalPages;
      }

      function _renderFileList() {
        if (!fileList) return;
        fileList.replaceChildren();
        if (!_mergerFiles.length) {
          fileList.innerHTML =
            '<div style="font-size:.75rem;color:rgba(255,255,255,.25);text-align:center;padding:16px 0;font-weight:700">No files added yet</div>';
          return;
        }
        _mergerFiles.forEach(function (f, i) {
          var row = document.createElement('div');
          row.style.cssText =
            'display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;cursor:grab';
          row.draggable = true;
          row.dataset.idx = i;
          row.innerHTML =
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(52,211,153,.7)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            '<div style="flex:1;min-width:0"><div style="font-size:.73rem;font-weight:800;color:#e2d9f3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
            f.name +
            '</div>' +
            '<div style="font-size:.62rem;color:rgba(255,255,255,.3);font-weight:700">' +
            (f.pageCount || '?') +
            ' pages</div></div>' +
            '<button data-del="' +
            i +
            '" style="background:none;border:none;cursor:pointer;color:rgba(255,100,100,.6);font-size:.8rem;padding:2px 6px">✕</button>';
          row.querySelector('[data-del]').addEventListener('click', function () {
            _mergerFiles.splice(parseInt(this.dataset.del), 1);
            _renderFileList();
            _updateStats();
          });
          // Drag reorder
          row.addEventListener('dragstart', function (e) {
            e.dataTransfer.setData('text/plain', i);
          });
          row.addEventListener('dragover', function (e) {
            e.preventDefault();
            row.style.borderColor = 'rgba(52,211,153,.5)';
          });
          row.addEventListener('dragleave', function () {
            row.style.borderColor = 'rgba(255,255,255,.08)';
          });
          row.addEventListener('drop', function (e) {
            e.preventDefault();
            row.style.borderColor = 'rgba(255,255,255,.08)';
            var from = parseInt(e.dataTransfer.getData('text/plain'));
            var to = i;
            if (from === to) return;
            var item = _mergerFiles.splice(from, 1)[0];
            _mergerFiles.splice(to, 0, item);
            _renderFileList();
            _updateStats();
          });
          fileList.appendChild(row);
        });
      }

      function _addFiles(files) {
        Array.from(files).forEach(function (file) {
          if (!file.name.match(/\.pdf$/i)) return;
          var reader = new FileReader();
          reader.onload = function (e) {
            var buf = e.target.result;
            // Count pages by counting occurrences of '/Type /Page' (rough but works without pdf-lib)
            var text = new Uint8Array(buf);
            var str = '';
            for (var ci = 0; ci < Math.min(text.length, 200000); ci++)
              str += String.fromCharCode(text[ci]);
            var pageCount = (str.match(/\/Type\s*\/Page[^s]/g) || []).length || 1;
            _mergerFiles.push({ name: file.name, arrayBuffer: buf, pageCount: pageCount });
            _renderFileList();
            _updateStats();
          };
          reader.readAsArrayBuffer(file);
        });
      }

      if (chooseBtn)
        chooseBtn.addEventListener('click', function () {
          mergerInput.click();
        });
      mergerInput.addEventListener('change', function () {
        _addFiles(this.files);
        this.value = '';
      });
      window._edPdfMergerDrop = function (e) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files.length) _addFiles(e.dataTransfer.files);
      };

      if (runBtn) {
        runBtn.addEventListener('click', function () {
          if (!_mergerFiles.length) {
            showToast('No files', 'Add at least one PDF.');
            return;
          }
          runBtn.textContent = 'Merging…';
          runBtn.disabled = true;

          // Load pdf-lib dynamically
          function doMerge() {
            if (typeof PDFLib === 'undefined') {
              var s = document.createElement('script');
              s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
              s.integrity =
                'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI';
              s.crossOrigin = 'anonymous';
              s.onload = doMerge;
              s.onerror = function () {
                showToast('Error', 'Could not load merge library.');
                runBtn.textContent = 'Merge PDFs';
                runBtn.disabled = false;
              };
              document.head.appendChild(s);
              return;
            }
            PDFLib.PDFDocument.create()
              .then(function (merged) {
                var chain = Promise.resolve();
                _mergerFiles.forEach(function (f) {
                  chain = chain.then(function () {
                    return PDFLib.PDFDocument.load(f.arrayBuffer).then(function (src) {
                      return merged.copyPages(src, src.getPageIndices()).then(function (pages) {
                        pages.forEach(function (p) {
                          merged.addPage(p);
                        });
                      });
                    });
                  });
                });
                return chain.then(function () {
                  return merged.save();
                });
              })
              .then(function (bytes) {
                var blob = new Blob([bytes], { type: 'application/pdf' });
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = (filenameInput && filenameInput.value.trim()) || 'Merged.pdf';
                a.click();
                setTimeout(function () {
                  URL.revokeObjectURL(url);
                }, 3000);
                showToast('Merged!', 'Your combined PDF is downloading.');
                runBtn.textContent = 'Merge PDFs';
                runBtn.disabled = false;
              })
              .catch(function (err) {
                showToast('Merge failed', err.message || 'Unknown error');
                runBtn.textContent = 'Merge PDFs';
                runBtn.disabled = false;
              });
          }
          doMerge();
        });
      }

      // Wire the merger file list container into the HTML (insert before stats grid)
      var statsGrid = document.getElementById('edMgTotalFiles');
      if (statsGrid && !document.getElementById('edPdfMergerFileList')) {
        var listWrap = document.createElement('div');
        listWrap.style.cssText =
          'display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto';
        listWrap.id = 'edPdfMergerFileList';
        statsGrid
          .closest('[style*="grid-template-columns"]')
          .insertAdjacentElement('beforebegin', listWrap);
        fileList = listWrap;
        _renderFileList();
      }
    };

    // Override _editorInit to show hub first, not the writer directly
    var _origEditorNavTo = window._navTo;

    // ── PDF EDITOR ───────────────────────────────────────────────────────────────

    var _edPdfEditorInited = false;
    var _edPdfActiveTool = 'highlight';
    var _edPdfActiveColor = '#facc15';
    var _edPdfOpacity = 0.35;
    var _shapeType = 'rect';
    var _edPdfLineWidth = 3;
    var _pageTextItems = [];

    // ── IndexedDB persistence ──
    var _edPdfIDB = null;
    function _edPdfOpenIDB(cb) {
      if (_edPdfIDB) {
        cb(_edPdfIDB);
        return;
      }
      var req = indexedDB.open('ss_pdf_editor', 1);
      req.onupgradeneeded = function (e) {
        e.target.result.createObjectStore('data');
      };
      req.onsuccess = function (e) {
        _edPdfIDB = e.target.result;
        cb(_edPdfIDB);
      };
      req.onerror = function () {
        cb(null);
      };
    }
    function _edPdfIDBPut(key, value) {
      _edPdfOpenIDB(function (db) {
        if (!db) return;
        db.transaction('data', 'readwrite').objectStore('data').put(value, key);
      });
    }
    function _edPdfIDBGet(key, cb) {
      _edPdfOpenIDB(function (db) {
        if (!db) {
          cb(null);
          return;
        }
        var req = db.transaction('data', 'readonly').objectStore('data').get(key);
        req.onsuccess = function (e) {
          cb(e.target.result || null);
        };
        req.onerror = function () {
          cb(null);
        };
      });
    }
    function _edPdfIDBDel(key) {
      _edPdfOpenIDB(function (db) {
        if (!db) return;
        db.transaction('data', 'readwrite').objectStore('data').delete(key);
      });
    }
    function _edPdfPersistState(filename, annotations, page, scale) {
      try {
        localStorage.setItem(
          'ss_pdfed_meta',
          JSON.stringify({ filename: filename, annotations: annotations, page: page, scale: scale })
        );
      } catch (e) {}
    }
    function _edPdfClearPersisted() {
      localStorage.removeItem('ss_pdfed_meta');
      _edPdfIDBDel('pdf_bytes');
    }

    // Tool selection — works even before a PDF is loaded
    window._edPdfSelectTool = function (tool) {
      _edPdfActiveTool = tool;
      document.querySelectorAll('.epdf-tool').forEach(function (el) {
        el.style.background = 'transparent';
        el.style.border = '1px solid transparent';
        var spans = el.querySelectorAll('span');
        if (spans[0]) spans[0].style.color = 'rgba(255,255,255,.6)'; // label
      });
      var active = document.getElementById('edPdfTool_' + tool);
      if (active) {
        active.style.background = 'rgba(167,139,250,.12)';
        active.style.border = '1px solid rgba(167,139,250,.25)';
        var spans = active.querySelectorAll('span');
        if (spans[0]) spans[0].style.color = '#e2d9f3';
      }
      var propTitle = document.getElementById('edPdfPropTitle');
      if (propTitle) {
        var names = {
          select: 'Select',
          highlight: 'Highlight',
          pen: 'Pen',
          text: 'Text',
          shapes: 'Shapes',
          eraser: 'Eraser',
          comments: 'Comments',
          sticky: 'Sticky Notes',
          stamp: 'Stamp',
          image: 'Image',
          signature: 'Signature'
        };
        propTitle.textContent = names[tool] || tool;
      }
      var shapeTypes = document.getElementById('edPdfShapeTypes');
      if (shapeTypes) shapeTypes.style.display = tool === 'shapes' ? 'flex' : 'none';
      if (window._edPdfOverlayCanvas) {
        var _textCursor =
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M8 3h2v1.5h4V3h2v1.5h-1.5v15H16V21h-2v-1.5H10V21H8v-1.5h1.5v-15H8V3z' fill='%23000'/%3E%3C/svg%3E\") 12 12, text";
        window._edPdfOverlayCanvas.style.cursor =
          tool === 'eraser'
            ? 'cell'
            : tool === 'text'
              ? _textCursor
              : tool === 'select'
                ? 'default'
                : 'crosshair';
      }
    };

    window._edPdfSetShape = function (type) {
      _shapeType = type;
      ['rect', 'ellipse', 'arrow'].forEach(function (t) {
        var btn = document.getElementById('edPdfShape' + t.charAt(0).toUpperCase() + t.slice(1));
        if (!btn) return;
        btn.style.background = t === type ? 'rgba(167,139,250,.18)' : 'rgba(255,255,255,.05)';
        btn.style.borderColor = t === type ? 'rgba(167,139,250,.5)' : 'rgba(255,255,255,.1)';
        btn.style.color = t === type ? '#60a5fa' : 'rgba(255,255,255,.5)';
      });
    };

    window._edPdfSetMode = function (mode) {
      ['edPdfModeHand', 'edPdfModeCursor'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        var isActive =
          (id === 'edPdfModeHand' && mode === 'hand') ||
          (id === 'edPdfModeCursor' && mode === 'cursor');
        el.style.background = isActive ? 'rgba(167,139,250,.2)' : 'rgba(255,255,255,.06)';
        el.style.borderColor = isActive ? 'rgba(167,139,250,.4)' : 'rgba(255,255,255,.1)';
        el.style.color = isActive ? '#60a5fa' : 'rgba(255,255,255,.5)';
      });
    };

    // ── PDF recent-files list ─────────────────────────────────────────────────────
    function _edPdfGetRecents() {
      try {
        return JSON.parse(localStorage.getItem('ss_pdfed_recents') || '[]');
      } catch (e) {
        return [];
      }
    }
    function _edPdfSaveRecents(list) {
      try {
        localStorage.setItem('ss_pdfed_recents', JSON.stringify(list));
      } catch (e) {}
    }
    function _edPdfAddRecent(filename) {
      var list = _edPdfGetRecents().filter(function (r) {
        return r.filename !== filename;
      });
      list.unshift({ filename: filename, updated: Date.now() });
      if (list.length > 12) list = list.slice(0, 12);
      _edPdfSaveRecents(list);
    }
    function _edPdfRenderDashboard() {
      var dashboard = document.getElementById('edPdfDashboard');
      var grid = document.getElementById('edPdfRecentGrid');
      var empty = document.getElementById('edPdfRecentEmpty');
      if (!dashboard || !grid || !empty) return;
      var recents = _edPdfGetRecents();
      if (!recents.length) {
        grid.style.display = 'none';
        empty.style.display = '';
      } else {
        empty.style.display = 'none';
        grid.style.display = '';
        grid.replaceChildren();
        recents.forEach(function (r) {
          var date = new Date(r.updated).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          });
          var card = document.createElement('div');
          card.className = 'ed-doc-card';
          var preview = document.createElement('div');
          preview.className = 'ed-doc-card-preview';
          preview.style.background =
            'linear-gradient(135deg,rgba(167,139,250,.18),rgba(124,58,237,.12))';
          preview.innerHTML =
            '<svg width="28" height="34" viewBox="0 0 28 34" fill="none" style="margin:auto;display:block;margin-top:18px"><rect width="28" height="34" rx="3" fill="rgba(167,139,250,.25)"/><rect x="0" y="0" width="14" height="9" rx="2" fill="rgba(167,139,250,.6)"/><text x="7" y="7.5" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="5" fill="white">PDF</text></svg>';
          var info = document.createElement('div');
          info.className = 'ed-doc-card-info';
          var name = document.createElement('div');
          name.className = 'ed-doc-card-name';
          name.textContent = r.filename;
          var dateEl = document.createElement('div');
          dateEl.className = 'ed-doc-card-date';
          dateEl.textContent = date;
          info.appendChild(name);
          info.appendChild(dateEl);
          var delBtn = document.createElement('button');
          delBtn.className = 'ed-doc-card-del';
          delBtn.title = 'Remove from recents';
          delBtn.innerHTML =
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
          delBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var list = _edPdfGetRecents().filter(function (x) {
              return x.filename !== r.filename;
            });
            _edPdfSaveRecents(list);
            _edPdfRenderDashboard();
          });
          card.appendChild(preview);
          card.appendChild(info);
          card.appendChild(delBtn);
          card.addEventListener('click', function (e) {
            if (e.target.closest('.ed-doc-card-del')) return;
            _edPdfIDBGet('pdf_bytes', function (buf) {
              var meta = null;
              try {
                meta = JSON.parse(localStorage.getItem('ss_pdfed_meta') || 'null');
              } catch (ex) {}
              if (buf && meta && meta.filename === r.filename) {
                var bytes = new Uint8Array(buf);
                if (window._edPdfSetAnnotations)
                  window._edPdfSetAnnotations((meta && meta.annotations) || {});
                if (window._edPdfClearUndo) window._edPdfClearUndo();
                if (window._edPdfSetScale) window._edPdfSetScale((meta && meta.scale) || 1.25);
                if (window._edPdfLoadBytes)
                  window._edPdfLoadBytes(
                    bytes,
                    meta.filename,
                    meta.page || 1,
                    meta.annotations || {}
                  );
              } else {
                showToast('PDF not cached', 'Please open the file again from your computer.');
              }
            });
          });
          grid.appendChild(card);
        });
      }
    }

    function _edPdfEditorInit() {
      var openBtn = document.getElementById('edPdfEditorOpenBtn');
      var input = document.getElementById('edPdfEditorInput');
      var drop = document.getElementById('edPdfEditorDrop');
      var main = document.getElementById('edPdfEditorMain');
      var canvas = document.getElementById('edPdfEditorCanvas');
      var thumbs = document.getElementById('edPdfThumbs');
      var pageInfo = document.getElementById('edPdfPageInfo');
      var prevBtn = document.getElementById('edPdfPrevPage');
      var nextBtn = document.getElementById('edPdfNextPage');
      var zoomIn = document.getElementById('edPdfZoomIn');
      var zoomOut = document.getElementById('edPdfZoomOut');
      var zoomLbl = document.getElementById('edPdfZoomLabel');
      var fname = document.getElementById('edPdfFileName');

      // The old "Open PDF" button in the top toolbar was removed; use the
      // file input as the existence anchor instead.
      if (!input || _edPdfEditorInited) return;
      _edPdfEditorInited = true;

      var _pdf = null,
        _currentPage = 1,
        _scale = 1.25;
      var _annotations = {}; // keyed by page number
      var _undoStack = []; // each entry is a deep-clone snapshot of _annotations
      var _hiddenLayers = {}; // type -> true means hidden
      var _edPdfBlendMode = 'normal';
      var _drawing = false,
        _startX = 0,
        _startY = 0,
        _penPoints = [];

      // Clipboard for the right-click Copy/Paste menu. Lives for the lifetime
      // of the PDF editor sub-tab.
      var _edPdfClipboard = null;
      var _edPdfCtxMenu = null;

      function _edPdfBuildCtxMenu() {
        if (_edPdfCtxMenu) return _edPdfCtxMenu;
        _edPdfCtxMenu = document.createElement('div');
        _edPdfCtxMenu.id = '_edPdfRightClickMenu';
        _edPdfCtxMenu.style.cssText =
          'position:fixed;z-index:99999;display:none;min-width:160px;padding:6px;' +
          'background:#1a1a2e;border:1px solid rgba(255,255,255,.12);' +
          'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45);' +
          'font-size:.78rem;font-weight:600;color:#e2d9f3;user-select:none';
        ['copy','paste','duplicate','delete'].forEach(function (action) {
          var item = document.createElement('div');
          item.dataset.action = action;
          item.textContent = action.charAt(0).toUpperCase() + action.slice(1);
          item.style.cssText =
            'padding:8px 12px;border-radius:6px;cursor:pointer';
          item.addEventListener('mouseenter', function () {
            if (item.style.pointerEvents !== 'none')
              item.style.background = 'rgba(167,139,250,.15)';
          });
          item.addEventListener('mouseleave', function () { item.style.background = ''; });
          item.addEventListener('mousedown', function (e) { e.stopPropagation(); });
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            _edPdfHandleCtx(action);
            _edPdfHideCtx();
          });
          _edPdfCtxMenu.appendChild(item);
        });
        document.body.appendChild(_edPdfCtxMenu);
        return _edPdfCtxMenu;
      }

      function _edPdfShowCtx(x, y) {
        var menu = _edPdfBuildCtxMenu();
        var hasSel  = _selAnnotIdx >= 0;
        var hasClip = !!_edPdfClipboard;
        Array.prototype.forEach.call(menu.children, function (item) {
          var a = item.dataset.action;
          var ok = (a === 'paste') ? hasClip : hasSel;
          item.style.opacity = ok ? '1' : '0.35';
          item.style.pointerEvents = ok ? 'auto' : 'none';
        });
        menu.style.left = x + 'px';
        menu.style.top  = y + 'px';
        menu.style.display = 'block';
        var r = menu.getBoundingClientRect();
        if (r.right  > window.innerWidth)  menu.style.left = (x - r.width)  + 'px';
        if (r.bottom > window.innerHeight) menu.style.top  = (y - r.height) + 'px';
      }
      function _edPdfHideCtx() { if (_edPdfCtxMenu) _edPdfCtxMenu.style.display = 'none'; }

      function _edPdfHandleCtx(action) {
        var annots = getPageAnnotations(_currentPage);
        var ov = window._edPdfOverlayCanvas;
        var ovCtx = ov && ov.getContext ? ov.getContext('2d') : null;
        function redraw() {
          if (!ov || !ovCtx) return;
          ovCtx.clearRect(0, 0, ov.width, ov.height);
          replayAnnotations(ovCtx, getPageAnnotations(_currentPage));
        }
        if (action === 'copy') {
          if (_selAnnotIdx < 0) return;
          _edPdfClipboard = JSON.parse(JSON.stringify(annots[_selAnnotIdx]));
          return;
        }
        if (action === 'paste') {
          if (!_edPdfClipboard) return;
          if (typeof _edPdfPushUndo === 'function') _edPdfPushUndo();
          var clone = JSON.parse(JSON.stringify(_edPdfClipboard));
          if (typeof clone.x === 'number') clone.x += 20;
          if (typeof clone.y === 'number') clone.y += 20;
          annots.push(clone);
          _selAnnotIdx = annots.length - 1;
          redraw();
          if (typeof _savePdfState === 'function') _savePdfState();
          return;
        }
        if (action === 'duplicate') {
          if (_selAnnotIdx < 0) return;
          if (typeof _edPdfPushUndo === 'function') _edPdfPushUndo();
          var dup = JSON.parse(JSON.stringify(annots[_selAnnotIdx]));
          if (typeof dup.x === 'number') dup.x += 20;
          if (typeof dup.y === 'number') dup.y += 20;
          annots.push(dup);
          _selAnnotIdx = annots.length - 1;
          redraw();
          if (typeof _savePdfState === 'function') _savePdfState();
          return;
        }
        if (action === 'delete') {
          if (_selAnnotIdx < 0) return;
          if (typeof _edPdfPushUndo === 'function') _edPdfPushUndo();
          annots.splice(_selAnnotIdx, 1);
          _selAnnotIdx = -1;
          redraw();
          if (typeof _savePdfState === 'function') _savePdfState();
        }
      }

      // Dismiss on outside click / Escape / scroll
      document.addEventListener('mousedown', function (e) {
        if (_edPdfCtxMenu && _edPdfCtxMenu.style.display === 'block' &&
            !_edPdfCtxMenu.contains(e.target)) _edPdfHideCtx();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') _edPdfHideCtx();
      });
      window.addEventListener('scroll', _edPdfHideCtx, true);

      function updateZoomLabel() {
        if (zoomLbl) zoomLbl.textContent = Math.round(_scale * 100) + '%';
      }

      function getPageAnnotations(page) {
        if (!_annotations[page]) _annotations[page] = [];
        return _annotations[page];
      }

      function _edPdfPushUndo() {
        _undoStack.push(JSON.parse(JSON.stringify(_annotations)));
        if (_undoStack.length > 60) _undoStack.shift();
      }

      // Wraps an annotation object with current blend mode before pushing
      function _mkAnnot(obj) {
        obj.blendMode = _edPdfBlendMode || 'normal';
        obj.scale = _scale; // capture scale at creation time for coordinate remapping
        return obj;
      }

      // Image cache: keyed by src string so each data URL is only decoded once
      var _imgCache = {};
      function _getImg(src, onReady) {
        if (_imgCache[src]) {
          onReady(_imgCache[src]);
          return;
        }
        var img = new Image();
        img.onload = function () {
          _imgCache[src] = img;
          onReady(img);
        };
        img.src = src;
        // Data URLs are often synchronously complete
        if (img.complete && img.naturalWidth > 0) {
          _imgCache[src] = img;
          onReady(img);
        }
      }

      function replayAnnotations(ctx, annots) {
        annots.forEach(function (a) {
          if (_hiddenLayers[a.type]) return;
          // If annotation was drawn at a different scale, remap its coordinates
          var sr = a.scale ? _scale / a.scale : 1;
          ctx.save();
          if (sr !== 1) ctx.scale(sr, sr);
          ctx.globalCompositeOperation = a.blendMode || _edPdfBlendMode || 'normal';
          ctx.globalAlpha = a.opacity;
          if (a.type === 'highlight') {
            ctx.fillStyle = a.color;
            ctx.fillRect(a.x, a.y, a.w, a.h);
          } else if (a.type === 'pen' && a.points && a.points.length > 1) {
            ctx.strokeStyle = a.color;
            ctx.lineWidth = a.lineWidth || 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(a.points[0].x, a.points[0].y);
            for (var i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
            ctx.stroke();
          } else if (a.type === 'rect') {
            ctx.strokeStyle = a.color;
            ctx.lineWidth = a.lineWidth || 2.5;
            ctx.strokeRect(a.x, a.y, a.w, a.h);
          } else if (a.type === 'ellipse') {
            ctx.strokeStyle = a.color;
            ctx.lineWidth = a.lineWidth || 2.5;
            ctx.beginPath();
            ctx.ellipse(
              a.x + a.w / 2,
              a.y + a.h / 2,
              Math.abs(a.w / 2),
              Math.abs(a.h / 2),
              0,
              0,
              2 * Math.PI
            );
            ctx.stroke();
          } else if (a.type === 'arrow') {
            ctx.strokeStyle = a.color;
            ctx.lineWidth = a.lineWidth || 2.5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(a.x2, a.y2);
            ctx.stroke();
            var angle = Math.atan2(a.y2 - a.y, a.x2 - a.x);
            var hs = 14;
            ctx.beginPath();
            ctx.moveTo(a.x2, a.y2);
            ctx.lineTo(
              a.x2 - hs * Math.cos(angle - Math.PI / 6),
              a.y2 - hs * Math.sin(angle - Math.PI / 6)
            );
            ctx.moveTo(a.x2, a.y2);
            ctx.lineTo(
              a.x2 - hs * Math.cos(angle + Math.PI / 6),
              a.y2 - hs * Math.sin(angle + Math.PI / 6)
            );
            ctx.stroke();
          } else if (a.type === 'text') {
            ctx.fillStyle = a.color;
            ctx.font = (a.fontSize || 18) + 'px Nunito, sans-serif';
            ctx.fillText(a.text, a.x, a.y);
          } else if (a.type === 'comment') {
            // Orange speech bubble icon
            ctx.fillStyle = '#f97316';
            ctx.beginPath();
            ctx.arc(a.x + 13, a.y + 12, 13, 0, 2 * Math.PI);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.moveTo(a.x + 6, a.y + 20);
            ctx.lineTo(a.x + 2, a.y + 28);
            ctx.lineTo(a.x + 14, a.y + 22);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('✦', a.x + 13, a.y + 17);
            ctx.textAlign = 'left';
            // Text callout box
            if (a.text) {
              ctx.font = '13px Nunito, sans-serif';
              var lines = a.text.split('\n').slice(0, 3);
              var bw = 180,
                bh = lines.length * 17 + 14;
              ctx.fillStyle = '#fff7ed';
              ctx.strokeStyle = '#f97316';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.rect(a.x + 30, a.y, bw, bh);
              ctx.fill();
              ctx.stroke();
              ctx.fillStyle = '#7c2d12';
              lines.forEach(function (l, i) {
                ctx.fillText(l.substring(0, 24), a.x + 38, a.y + 15 + i * 17);
              });
            }
          } else if (a.type === 'sticky') {
            var sw = 170,
              sh = Math.max(80, (a.text ? a.text.split('\n').length : 1) * 18 + 30);
            // Shadow
            ctx.fillStyle = 'rgba(0,0,0,.18)';
            ctx.fillRect(a.x + 4, a.y + 4, sw, sh);
            // Body
            ctx.fillStyle = '#fef08a';
            ctx.strokeStyle = '#ca8a04';
            ctx.lineWidth = 1;
            ctx.fillRect(a.x, a.y, sw, sh);
            ctx.strokeRect(a.x, a.y, sw, sh);
            // Folded corner
            ctx.fillStyle = '#fde047';
            ctx.beginPath();
            ctx.moveTo(a.x + sw - 22, a.y);
            ctx.lineTo(a.x + sw, a.y + 22);
            ctx.lineTo(a.x + sw, a.y);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = '#ca8a04';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(a.x + sw - 22, a.y);
            ctx.lineTo(a.x + sw, a.y + 22);
            ctx.stroke();
            // Text
            ctx.fillStyle = '#3b1500';
            ctx.font = '14px Nunito, sans-serif';
            ctx.textAlign = 'left';
            (a.text || '').split('\n').forEach(function (l, i) {
              ctx.fillText(l.substring(0, 21), a.x + 10, a.y + 22 + i * 18);
            });
          } else if (a.type === 'stamp') {
            var stampColors = {
              'Important!': '#ef4444',
              Approved: '#16a34a',
              Review: '#f97316',
              'Key Concept': '#2563eb',
              Note: '#2563eb',
              Rejected: '#dc2626'
            };
            var sc = stampColors[a.text] || '#6b7280';
            ctx.font = 'bold 20px Nunito, sans-serif';
            ctx.textAlign = 'left';
            var tw = ctx.measureText(a.text).width;
            // Filled bg
            ctx.fillStyle = sc;
            ctx.globalAlpha = a.opacity * 0.12;
            ctx.fillRect(a.x - 8, a.y - 22, tw + 16, 30);
            ctx.globalAlpha = a.opacity;
            // Border
            ctx.strokeStyle = sc;
            ctx.lineWidth = 2.5;
            ctx.strokeRect(a.x - 8, a.y - 22, tw + 16, 30);
            // Text
            ctx.fillStyle = sc;
            ctx.fillText(a.text, a.x, a.y);
          } else if (a.type === 'text-replace') {
            // White out original text area
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(a.x - 2, a.y - a.origH - 4, a.origW + 6, a.origH + 8);
            // Draw replacement (empty = deleted)
            if (a.newText) {
              ctx.globalAlpha = a.opacity || 1;
              ctx.fillStyle = a.color || '#000';
              ctx.font =
                (a.fontStyle || 'normal') +
                ' ' +
                (a.fontWeight || 'normal') +
                ' ' +
                a.fontSize +
                'px ' +
                (a.fontFamily || 'sans-serif');
              ctx.textAlign = 'left';
              ctx.textBaseline = 'alphabetic';
              ctx.fillText(a.newText, a.x, a.y);
            }
          } else if (a.type === 'image' && a.src) {
            (function (ann, savedCtx) {
              _getImg(ann.src, function (img) {
                savedCtx.save();
                savedCtx.globalAlpha = ann.opacity != null ? ann.opacity : 1;
                savedCtx.drawImage(img, ann.x, ann.y, ann.w || 200, ann.h || 150);
                savedCtx.restore();
              });
            })(a, ctx);
          }
          ctx.restore();
        });
      }

      function _annotHit(a, p) {
        // Convert mouse point from current-scale space to annotation's creation-scale space
        var sr = a.scale ? _scale / a.scale : 1;
        if (sr !== 1) p = { x: p.x / sr, y: p.y / sr };
        var R = 8;
        if (a.type === 'highlight' || a.type === 'rect' || a.type === 'ellipse') {
          var ax = Math.min(a.x, a.x + a.w) - R,
            ay = Math.min(a.y, a.y + a.h) - R;
          var aw = Math.abs(a.w) + R * 2,
            ah = Math.abs(a.h) + R * 2;
          return p.x >= ax && p.x <= ax + aw && p.y >= ay && p.y <= ay + ah;
        } else if (a.type === 'pen' && a.points) {
          for (var pi = 0; pi < a.points.length - 1; pi++) {
            var dx = a.points[pi + 1].x - a.points[pi].x,
              dy = a.points[pi + 1].y - a.points[pi].y;
            var t = Math.max(
              0,
              Math.min(
                1,
                ((p.x - a.points[pi].x) * dx + (p.y - a.points[pi].y) * dy) /
                  (dx * dx + dy * dy + 0.001)
              )
            );
            var cx = a.points[pi].x + t * dx - p.x,
              cy = a.points[pi].y + t * dy - p.y;
            if (cx * cx + cy * cy < R * R * 4) return true;
          }
          return false;
        } else if (a.type === 'arrow') {
          return (
            Math.sqrt(Math.pow(p.x - (a.x + a.x2) / 2, 2) + Math.pow(p.y - (a.y + a.y2) / 2, 2)) <
            24
          );
        } else if (a.type === 'text') {
          return Math.abs(p.x - a.x) < 100 && p.y >= a.y - 20 && p.y <= a.y + 6;
        } else if (a.type === 'comment') {
          return p.x >= a.x && p.x <= a.x + 30 && p.y >= a.y && p.y <= a.y + 32;
        } else if (a.type === 'sticky') {
          return p.x >= a.x && p.x <= a.x + 170 && p.y >= a.y && p.y <= a.y + 120;
        } else if (a.type === 'stamp') {
          return p.x >= a.x - 10 && p.x <= a.x + 120 && p.y >= a.y - 26 && p.y <= a.y + 8;
        } else if (a.type === 'image') {
          return (
            p.x >= a.x - R &&
            p.x <= a.x + (a.w || 200) + R &&
            p.y >= a.y - R &&
            p.y <= a.y + (a.h || 150) + R
          );
        }
        return false;
      }

      function _annotHitTest(annots, p) {
        for (var i = annots.length - 1; i >= 0; i--) {
          if (_annotHit(annots[i], p)) return i;
        }
        return -1;
      }

      var _selAnnotIdx = -1;
      function _drawImageSelection(ctx2, a) {
        if (!a || a.type !== 'image') return;
        var x = a.x,
          y = a.y,
          w = a.w || 200,
          h = a.h || 150;
        ctx2.save();
        ctx2.strokeStyle = '#6366f1';
        ctx2.lineWidth = 2;
        ctx2.setLineDash([5, 3]);
        ctx2.strokeRect(x, y, w, h);
        ctx2.setLineDash([]);
        // Resize handle (bottom-right)
        ctx2.fillStyle = '#6366f1';
        ctx2.fillRect(x + w - 6, y + h - 6, 12, 12);
        ctx2.restore();
      }
      function _isOnResizeHandle(a, p) {
        var x = a.x,
          y = a.y,
          w = a.w || 200,
          h = a.h || 150;
        return p.x >= x + w - 12 && p.x <= x + w + 6 && p.y >= y + h - 12 && p.y <= y + h + 6;
      }

      function _openAnnotEdit(a, clientX, clientY, onDone) {
        if (a.type === 'stamp') {
          var existing = document.getElementById('_edStampPicker');
          if (existing) existing.remove();
          var picker = document.createElement('div');
          picker.id = '_edStampPicker';
          var stamps = ['Important!', 'Key Concept', 'Approved', 'Review', 'Note', 'Rejected'];
          var stampColors = {
            'Important!': '#ef4444',
            Approved: '#16a34a',
            Review: '#f97316',
            'Key Concept': '#2563eb',
            Note: '#2563eb',
            Rejected: '#dc2626'
          };
          picker.style.cssText =
            'position:fixed;left:' +
            clientX +
            'px;top:' +
            clientY +
            'px;background:#1a1625;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:8px;display:flex;flex-direction:column;gap:5px;z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,.5);min-width:140px';
          stamps.forEach(function (s) {
            var btn = document.createElement('button');
            btn.textContent = s;
            btn.style.cssText =
              'padding:7px 14px;background:rgba(255,255,255,.05);border:1.5px solid ' +
              stampColors[s] +
              ';border-radius:8px;color:' +
              stampColors[s] +
              ';font-size:.78rem;font-weight:800;cursor:pointer;font-family:Nunito,sans-serif;text-align:left';
            btn.addEventListener('click', function () {
              picker.remove();
              a.text = s;
              a.color = stampColors[s];
              onDone();
            });
            picker.appendChild(btn);
          });
          document.body.appendChild(picker);
          setTimeout(function () {
            document.addEventListener('mousedown', function removePicker(ev) {
              if (!picker.contains(ev.target)) {
                picker.remove();
                document.removeEventListener('mousedown', removePicker);
              }
            });
          }, 0);
          return;
        }
        // Text-based: text, comment, sticky
        var bgColors = { text: '#fff', comment: '#fff7ed', sticky: '#fef08a' };
        var borderColors = { text: a.color || '#333', comment: '#f97316', sticky: '#ca8a04' };
        var textColors = { text: '#111', comment: '#7c2d12', sticky: '#3b1500' };
        var fontSize = a.type === 'text' ? a.fontSize || 18 : 14;
        var inp = document.createElement('textarea');
        inp.value = a.text || '';
        inp.rows = a.type === 'sticky' ? 4 : a.type === 'comment' ? 3 : 2;
        inp.style.cssText =
          'position:fixed;left:' +
          clientX +
          'px;top:' +
          clientY +
          'px;' +
          'min-width:160px;min-height:40px;background:' +
          (bgColors[a.type] || '#fff') +
          ';' +
          'border:2px solid ' +
          (borderColors[a.type] || '#555') +
          ';border-radius:6px;' +
          'padding:6px 10px;font-size:' +
          fontSize +
          'px;font-family:Nunito,sans-serif;color:' +
          (textColors[a.type] || '#111') +
          ';' +
          'outline:none;resize:both;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.35)';
        document.body.appendChild(inp);
        setTimeout(function () {
          inp.focus();
          inp.select();
        }, 0);
        var _done = false;
        function commit() {
          if (_done) return;
          _done = true;
          var txt = inp.value.trim();
          if (document.body.contains(inp)) document.body.removeChild(inp);
          // Empty = delete the annotation
          if (!txt) {
            var annots = getPageAnnotations(_currentPage);
            var i = annots.indexOf(a);
            if (i >= 0) annots.splice(i, 1);
          } else {
            a.text = txt;
          }
          onDone();
        }
        inp.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') {
            _done = true;
            if (document.body.contains(inp)) document.body.removeChild(inp);
          }
          if (ev.key === 'Enter' && !ev.shiftKey && a.type === 'text') {
            ev.preventDefault();
            commit();
          }
        });
        inp.addEventListener('blur', commit);
      }

      // HTML for the friendly "Rendering page N…" placeholder shown while
      // pdf.js fetches and rasterises the requested page.
      function _epdfRenderingPlaceholder(pageNum) {
        return (
          '<div class="epdf-empty-state">' +
            '<div class="epdf-empty-icon">' +
              '<div class="epdf-spinner"></div>' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="#a8b8ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
            '</div>' +
            '<div>' +
              '<div class="epdf-empty-title">Rendering page ' + pageNum + '…</div>' +
              '<div class="epdf-empty-sub">This may take a few seconds.</div>' +
            '</div>' +
            '<div class="epdf-empty-chips">' +
              '<div class="epdf-chip">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="#a8b8ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>' +
                '<span class="epdf-chip-label">High quality</span>' +
              '</div>' +
              '<div class="epdf-chip">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="#a8b8ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' +
                '<span class="epdf-chip-label">Accurate annotations</span>' +
              '</div>' +
              '<div class="epdf-chip">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="#a8b8ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
                '<span class="epdf-chip-label">Secure &amp; private</span>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }

      // Tracks the last fully-rendered page so we can tell a real navigation
      // (first open, page change) apart from an in-place re-render (undo,
      // redo, blend mode, annotation tweak). Only the former should flash
      // the friendly placeholder — otherwise every undo blanks the editor.
      var _lastRenderedPage = null;
      function renderCurrentPage() {
        if (!_pdf) return;
        var isNavigation = (_lastRenderedPage !== _currentPage);
        var _placeholderShownAt = 0;
        var _MIN_PLACEHOLDER_MS = 450;
        if (isNavigation) {
          canvas.innerHTML = _epdfRenderingPlaceholder(_currentPage);
          _placeholderShownAt = Date.now();
        }
        window._edPdfOverlayCanvas = null;
        _pdf.getPage(_currentPage).then(function (page) {
          if (!isNavigation) return page;
          var elapsed = Date.now() - _placeholderShownAt;
          var wait = Math.max(0, _MIN_PLACEHOLDER_MS - elapsed);
          if (wait) {
            return new Promise(function (r) { setTimeout(function () { r(page); }, wait); });
          }
          return page;
        }).then(function (page) {
          _lastRenderedPage = _currentPage;
          // Clear the placeholder now that we're about to insert the real page
          canvas.innerHTML = '';
          var vp = page.getViewport({ scale: _scale });
          var wrap = document.createElement('div');
          wrap.style.cssText =
            'position:relative;display:inline-block;border-radius:8px;box-shadow:0 4px 32px rgba(0,0,0,.6);flex-shrink:0';

          var pdfC = document.createElement('canvas');
          pdfC.width = vp.width;
          pdfC.height = vp.height;
          pdfC.style.cssText = 'display:block;border-radius:8px;background:#fff';
          wrap.appendChild(pdfC);
          page.render({ canvasContext: pdfC.getContext('2d'), viewport: vp });

          // Extract text positions for inline editing
          _pageTextItems = [];
          page.getTextContent({ includeMarkedContent: false }).then(function (tc) {
            var t = vp.transform;
            _pageTextItems = tc.items
              .filter(function (it) {
                return it.str && it.str.trim();
              })
              .map(function (it) {
                var m = it.transform;
                var cx = t[0] * m[4] + t[2] * m[5] + t[4];
                var cy = t[1] * m[4] + t[3] * m[5] + t[5];
                var fontSizePdf = Math.hypot(m[0], m[1]) || Math.abs(m[3]);
                var scale = Math.abs(t[0]);
                var fontSizeCvs = fontSizePdf * scale;
                var itemW = it.width * scale;

                // PDF.js tc.styles maps fontName → { fontFamily, ascent, descent }
                var style = tc.styles && tc.styles[it.fontName];
                // fontFamily from styles is the best source (e.g. "sans-serif", "serif", "Arial")
                var fontFamily = style && style.fontFamily ? style.fontFamily : 'sans-serif';

                // Bold/italic: parse after the "+" subset prefix (e.g. "ABCDEF+Helvetica-BoldOblique")
                var rawName = it.fontName || '';
                var cleanName = (
                  rawName.indexOf('+') !== -1 ? rawName.split('+')[1] : rawName
                ).toLowerCase();
                var fontWeight =
                  cleanName.indexOf('bold') !== -1 || cleanName.indexOf('heavy') !== -1
                    ? 'bold'
                    : 'normal';
                var fontStyle =
                  cleanName.indexOf('italic') !== -1 || cleanName.indexOf('oblique') !== -1
                    ? 'italic'
                    : 'normal';

                // Color: PDF.js provides it.color as [r,g,b] in range 0-255 in newer builds
                var color = '#000000';
                if (it.color) {
                  var r = Math.round(it.color[0]),
                    g = Math.round(it.color[1]),
                    b = Math.round(it.color[2]);
                  if (r !== 0 || g !== 0 || b !== 0) color = 'rgb(' + r + ',' + g + ',' + b + ')';
                }

                return {
                  str: it.str,
                  x: cx,
                  y: cy,
                  w: itemW,
                  h: fontSizeCvs,
                  fontSize: fontSizeCvs,
                  fontFamily: fontFamily,
                  fontWeight: fontWeight,
                  fontStyle: fontStyle,
                  color: color
                };
              });
          });

          // Annotation overlay
          var ov = document.createElement('canvas');
          ov.width = vp.width;
          ov.height = vp.height;
          ov.style.cssText =
            "position:absolute;inset:0;border-radius:8px;cursor:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Cline x1='10' y1='2' x2='10' y2='18' stroke='black' stroke-width='1.5'/%3E%3Cline x1='2' y1='10' x2='18' y2='10' stroke='black' stroke-width='1.5'/%3E%3C/svg%3E\") 10 10,crosshair";
          // Apply current tool cursor immediately (in case tool was already selected)
          if (_edPdfActiveTool === 'text') {
            ov.style.cursor =
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M8 3h2v1.5h4V3h2v1.5h-1.5v15H16V21h-2v-1.5H10V21H8v-1.5h1.5v-15H8V3z' fill='%23000'/%3E%3C/svg%3E\") 12 12, text";
          } else if (_edPdfActiveTool === 'eraser') {
            ov.style.cursor = 'cell';
          }
          wrap.appendChild(ov);
          window._edPdfOverlayCanvas = ov;
          canvas.appendChild(wrap);

          var ovCtx = ov.getContext('2d');
          replayAnnotations(ovCtx, getPageAnnotations(_currentPage));

          // Mouse drawing
          function getPos(e) {
            var r = ov.getBoundingClientRect();
            var scaleX = ov.width / r.width;
            var scaleY = ov.height / r.height;
            var src = e.touches ? e.touches[0] : e;
            return { x: (src.clientX - r.left) * scaleX, y: (src.clientY - r.top) * scaleY };
          }

          ov.addEventListener('dblclick', function (e) {
            var p = getPos(e);
            var annots = getPageAnnotations(_currentPage);
            var idx = _annotHitTest(annots, p);
            if (idx < 0) return;
            var a = annots[idx];
            if (['text', 'comment', 'sticky', 'stamp'].indexOf(a.type) < 0) return;
            e.preventDefault();
            _openAnnotEdit(a, e.clientX, e.clientY, function () {
              ovCtx.clearRect(0, 0, ov.width, ov.height);
              replayAnnotations(ovCtx, annots);
              _savePdfState();
            });
          });

          // Right-click → Copy / Paste / Duplicate / Delete menu. Selects the
          // annotation under the cursor (if any) before showing the menu so
          // the actions apply to what the user actually right-clicked on.
          ov.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            var p = getPos(e);
            var annots2 = getPageAnnotations(_currentPage);
            var idx2 = _annotHitTest(annots2, p);
            if (idx2 >= 0) {
              _selAnnotIdx = idx2;
              ovCtx.clearRect(0, 0, ov.width, ov.height);
              replayAnnotations(ovCtx, annots2);
            }
            _edPdfShowCtx(e.clientX, e.clientY);
          });

          ov.addEventListener('mousedown', function (e) {
            var tool = _edPdfActiveTool;

            // Select tool: click to edit text types, drag to move all types
            if (tool === 'select') {
              var p = getPos(e);
              var annots = getPageAnnotations(_currentPage);
              var idx = _annotHitTest(annots, p);

              // No annotation hit — check if click lands on existing PDF text
              if (idx < 0) {
                var hitText = null;
                for (var ti = 0; ti < _pageTextItems.length; ti++) {
                  var it = _pageTextItems[ti];
                  // Bounding box: x to x+w, (y - h) to y  (y is baseline in canvas coords)
                  if (
                    p.x >= it.x - 4 &&
                    p.x <= it.x + it.w + 4 &&
                    p.y >= it.y - it.h - 4 &&
                    p.y <= it.y + 6
                  ) {
                    hitText = it;
                    break;
                  }
                }
                if (hitText) {
                  e.preventDefault();
                  var r = ov.getBoundingClientRect();
                  var sx = r.width / ov.width,
                    sy = r.height / ov.height;
                  // Check if already replaced
                  var existing = null;
                  for (var ai = 0; ai < annots.length; ai++) {
                    var ca = annots[ai];
                    if (
                      ca.type === 'text-replace' &&
                      Math.abs(ca.x - hitText.x) < 8 &&
                      Math.abs(ca.y - hitText.y) < 8
                    ) {
                      existing = ca;
                      break;
                    }
                  }
                  var screenX = r.left + hitText.x * sx;
                  var screenY = r.top + (hitText.y - hitText.h) * sy;
                  var screenW = Math.max(hitText.w * sx, 60);
                  var screenH = hitText.h * sy + 4;
                  var inp = document.createElement('input');
                  inp.type = 'text';
                  inp.value = existing ? existing.newText : hitText.str;
                  inp.style.cssText =
                    'position:fixed;left:' +
                    screenX +
                    'px;top:' +
                    screenY +
                    'px;' +
                    'width:' +
                    screenW +
                    'px;height:' +
                    screenH +
                    'px;' +
                    'font-size:' +
                    hitText.fontSize * sy +
                    'px;font-weight:' +
                    (hitText.fontWeight || 'normal') +
                    ';font-style:' +
                    (hitText.fontStyle || 'normal') +
                    ';font-family:' +
                    (hitText.fontFamily || 'sans-serif') +
                    ';color:' +
                    (hitText.color || '#000') +
                    ';' +
                    'background:rgba(255,255,220,.98);border:1.5px solid #2563eb;border-radius:2px;' +
                    'padding:0 2px;margin:0;box-sizing:border-box;outline:none;z-index:99999';
                  document.body.appendChild(inp);
                  setTimeout(function () {
                    inp.focus();
                    inp.select();
                  }, 0);
                  var _trDone = false;
                  function commitReplace() {
                    if (_trDone) return;
                    _trDone = true;
                    var newText = inp.value;
                    if (document.body.contains(inp)) document.body.removeChild(inp);
                    // Remove old replace annotation for this item
                    for (var ri = annots.length - 1; ri >= 0; ri--) {
                      if (
                        annots[ri].type === 'text-replace' &&
                        Math.abs(annots[ri].x - hitText.x) < 8 &&
                        Math.abs(annots[ri].y - hitText.y) < 8
                      ) {
                        annots.splice(ri, 1);
                        break;
                      }
                    }
                    // Add new (empty = white-out / delete)
                    annots.push(
                      _mkAnnot({
                        type: 'text-replace',
                        x: hitText.x,
                        y: hitText.y,
                        origW: hitText.w,
                        origH: hitText.h,
                        fontSize: hitText.fontSize,
                        fontFamily: hitText.fontFamily || 'sans-serif',
                        fontWeight: hitText.fontWeight || 'normal',
                        fontStyle: hitText.fontStyle || 'normal',
                        newText: newText,
                        opacity: 1,
                        color: hitText.color || '#000'
                      })
                    );
                    ovCtx.clearRect(0, 0, ov.width, ov.height);
                    replayAnnotations(ovCtx, annots);
                    _savePdfState();
                  }
                  inp.addEventListener('keydown', function (ev) {
                    if (ev.key === 'Enter') {
                      ev.preventDefault();
                      commitReplace();
                    }
                    if (ev.key === 'Escape') {
                      _trDone = true;
                      if (document.body.contains(inp)) document.body.removeChild(inp);
                    }
                  });
                  inp.addEventListener('blur', commitReplace);
                }
                return;
              }

              var a = annots[idx];
              e.preventDefault();
              _selAnnotIdx = idx;
              var isResizing = a.type === 'image' && _isOnResizeHandle(a, p);
              var startP = p,
                lastP = p,
                moved = false;
              ov.style.cursor = isResizing ? 'nwse-resize' : 'grabbing';
              function onSelectMove(me) {
                var mp = getPos(me);
                var dx = mp.x - lastP.x,
                  dy = mp.y - lastP.y;
                var totalD = Math.sqrt(Math.pow(mp.x - startP.x, 2) + Math.pow(mp.y - startP.y, 2));
                if (totalD > 4) moved = true;
                if (!moved) {
                  lastP = mp;
                  return;
                }
                lastP = mp;
                // dx/dy are in current-scale pixels; annotation coords are in creation-scale pixels
                var _sr = a.scale ? _scale / a.scale : 1;
                var adx = dx / _sr,
                  ady = dy / _sr;
                if (isResizing && a.type === 'image') {
                  a.w = Math.max(20, (a.w || 200) + adx);
                  a.h = Math.max(20, (a.h || 150) + ady);
                } else {
                  a.x = (a.x || 0) + adx;
                  a.y = (a.y || 0) + ady;
                  if (a.type === 'arrow') {
                    a.x2 = (a.x2 || 0) + adx;
                    a.y2 = (a.y2 || 0) + ady;
                  }
                  if (a.type === 'pen' && a.points) {
                    a.points.forEach(function (pt) {
                      pt.x += adx;
                      pt.y += ady;
                    });
                  }
                }
                ovCtx.clearRect(0, 0, ov.width, ov.height);
                replayAnnotations(ovCtx, annots);
                if (a.type === 'image') _drawImageSelection(ovCtx, a);
              }
              function onSelectUp(ue) {
                ov.style.cursor = 'default';
                document.removeEventListener('mousemove', onSelectMove);
                document.removeEventListener('mouseup', onSelectUp);
                if (!moved && ['text', 'comment', 'sticky', 'stamp'].indexOf(a.type) >= 0) {
                  // Single click on editable annotation → open edit
                  _openAnnotEdit(a, ue.clientX, ue.clientY, function () {
                    ovCtx.clearRect(0, 0, ov.width, ov.height);
                    replayAnnotations(ovCtx, annots);
                    _savePdfState();
                  });
                } else if (moved) {
                  _savePdfState();
                }
                // Keep selection visible after release
                if (a.type === 'image') {
                  ovCtx.clearRect(0, 0, ov.width, ov.height);
                  replayAnnotations(ovCtx, annots);
                  _drawImageSelection(ovCtx, a);
                }
              }
              document.addEventListener('mousemove', onSelectMove);
              document.addEventListener('mouseup', onSelectUp);
              // Show selection immediately on mousedown
              if (a.type === 'image') {
                ovCtx.clearRect(0, 0, ov.width, ov.height);
                replayAnnotations(ovCtx, annots);
                _drawImageSelection(ovCtx, a);
              }
              return;
            }

            // Text tool: fixed textarea — prevent canvas stealing focus back on mouseup
            if (tool === 'text') {
              e.preventDefault();
              var p = getPos(e);
              var inp = document.createElement('textarea');
              inp.rows = 2;
              inp.style.cssText =
                'position:fixed;left:' +
                e.clientX +
                'px;top:' +
                e.clientY +
                'px;' +
                'min-width:160px;min-height:40px;background:#fff;' +
                'border:2px solid ' +
                _edPdfActiveColor +
                ';border-radius:6px;' +
                'padding:6px 10px;font-size:15px;font-family:Nunito,sans-serif;color:#111;' +
                'outline:none;resize:both;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.35)';
              document.body.appendChild(inp);
              // Defer focus so the mousedown/mouseup cycle finishes first
              setTimeout(function () {
                inp.focus();
              }, 0);
              var _committed = false;
              function commitText() {
                if (_committed) return;
                _committed = true;
                var txt = inp.value.trim();
                if (document.body.contains(inp)) document.body.removeChild(inp);
                if (!txt) return;
                _edPdfPushUndo();
                var annots = getPageAnnotations(_currentPage);
                annots.push(
                  _mkAnnot({
                    type: 'text',
                    text: txt,
                    color: _edPdfActiveColor,
                    opacity: 1,
                    x: p.x,
                    y: p.y + 4,
                    fontSize: 18
                  })
                );
                ovCtx.clearRect(0, 0, ov.width, ov.height);
                replayAnnotations(ovCtx, annots);
                _savePdfState();
              }
              inp.addEventListener('keydown', function (ev) {
                if (ev.key === 'Escape') {
                  _committed = true;
                  if (document.body.contains(inp)) document.body.removeChild(inp);
                }
                if (ev.key === 'Enter' && !ev.shiftKey) {
                  ev.preventDefault();
                  commitText();
                }
              });
              inp.addEventListener('blur', commitText);
              return;
            }

            // Comment tool
            if (tool === 'comments') {
              e.preventDefault();
              var p = getPos(e);
              var inp = document.createElement('textarea');
              inp.rows = 3;
              inp.placeholder = 'Add a comment…';
              inp.style.cssText =
                'position:fixed;left:' +
                e.clientX +
                'px;top:' +
                e.clientY +
                'px;' +
                'width:200px;min-height:70px;background:#fff7ed;border:2px solid #f97316;border-radius:8px;' +
                'padding:8px 10px;font-size:13px;font-family:Nunito,sans-serif;color:#7c2d12;' +
                'outline:none;resize:both;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.3)';
              document.body.appendChild(inp);
              setTimeout(function () {
                inp.focus();
              }, 0);
              var _com = false;
              function commitComment() {
                if (_com) return;
                _com = true;
                var txt = inp.value.trim();
                if (document.body.contains(inp)) document.body.removeChild(inp);
                if (!txt) return;
                _edPdfPushUndo();
                var annots = getPageAnnotations(_currentPage);
                annots.push(
                  _mkAnnot({
                    type: 'comment',
                    text: txt,
                    color: '#f97316',
                    opacity: 1,
                    x: p.x,
                    y: p.y
                  })
                );
                ovCtx.clearRect(0, 0, ov.width, ov.height);
                replayAnnotations(ovCtx, annots);
                _savePdfState();
              }
              inp.addEventListener('keydown', function (ev) {
                if (ev.key === 'Escape') {
                  _com = true;
                  if (document.body.contains(inp)) document.body.removeChild(inp);
                }
                if (ev.key === 'Enter' && !ev.shiftKey) {
                  ev.preventDefault();
                  commitComment();
                }
              });
              inp.addEventListener('blur', commitComment);
              return;
            }

            // Sticky note tool
            if (tool === 'sticky') {
              e.preventDefault();
              var p = getPos(e);
              var inp = document.createElement('textarea');
              inp.rows = 4;
              inp.placeholder = 'Type your note…';
              inp.style.cssText =
                'position:fixed;left:' +
                e.clientX +
                'px;top:' +
                e.clientY +
                'px;' +
                'width:170px;min-height:90px;background:#fef08a;border:2px solid #ca8a04;border-radius:6px;' +
                'padding:8px 10px;font-size:13px;font-family:Nunito,sans-serif;color:#3b1500;' +
                'outline:none;resize:both;z-index:99999;box-shadow:0 4px 20px rgba(0,0,0,.3)';
              document.body.appendChild(inp);
              setTimeout(function () {
                inp.focus();
              }, 0);
              var _st = false;
              function commitSticky() {
                if (_st) return;
                _st = true;
                var txt = inp.value.trim();
                if (document.body.contains(inp)) document.body.removeChild(inp);
                if (!txt) return;
                _edPdfPushUndo();
                var annots = getPageAnnotations(_currentPage);
                annots.push(
                  _mkAnnot({
                    type: 'sticky',
                    text: txt,
                    color: '#fef08a',
                    opacity: 1,
                    x: p.x,
                    y: p.y
                  })
                );
                ovCtx.clearRect(0, 0, ov.width, ov.height);
                replayAnnotations(ovCtx, annots);
                _savePdfState();
              }
              inp.addEventListener('keydown', function (ev) {
                if (ev.key === 'Escape') {
                  _st = true;
                  if (document.body.contains(inp)) document.body.removeChild(inp);
                }
                if (ev.key === 'Enter' && ev.shiftKey === false && ev.ctrlKey) {
                  ev.preventDefault();
                  commitSticky();
                }
              });
              inp.addEventListener('blur', commitSticky);
              return;
            }

            // Stamp tool: show stamp picker
            if (tool === 'stamp') {
              e.preventDefault();
              var p = getPos(e);
              var existing = document.getElementById('_edStampPicker');
              if (existing) existing.remove();
              var picker = document.createElement('div');
              picker.id = '_edStampPicker';
              var stamps = ['Important!', 'Key Concept', 'Approved', 'Review', 'Note', 'Rejected'];
              var stampColors = {
                'Important!': '#ef4444',
                Approved: '#16a34a',
                Review: '#f97316',
                'Key Concept': '#2563eb',
                Note: '#2563eb',
                Rejected: '#dc2626'
              };
              picker.style.cssText =
                'position:fixed;left:' +
                e.clientX +
                'px;top:' +
                e.clientY +
                'px;' +
                'background:#1a1625;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:8px;' +
                'display:flex;flex-direction:column;gap:5px;z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,.5);min-width:140px';
              stamps.forEach(function (s) {
                var btn = document.createElement('button');
                btn.textContent = s;
                btn.style.cssText =
                  'padding:7px 14px;background:rgba(255,255,255,.05);border:1.5px solid ' +
                  stampColors[s] +
                  ';' +
                  'border-radius:8px;color:' +
                  stampColors[s] +
                  ';font-size:.78rem;font-weight:800;cursor:pointer;font-family:Nunito,sans-serif;text-align:left';
                btn.addEventListener('click', function () {
                  picker.remove();
                  _edPdfPushUndo();
                  var annots = getPageAnnotations(_currentPage);
                  annots.push(
                    _mkAnnot({
                      type: 'stamp',
                      text: s,
                      color: stampColors[s],
                      opacity: 1,
                      x: p.x,
                      y: p.y
                    })
                  );
                  ovCtx.clearRect(0, 0, ov.width, ov.height);
                  replayAnnotations(ovCtx, annots);
                  _savePdfState();
                });
                picker.appendChild(btn);
              });
              document.body.appendChild(picker);
              setTimeout(function () {
                document.addEventListener('mousedown', function removePicker(ev) {
                  if (!picker.contains(ev.target)) {
                    picker.remove();
                    document.removeEventListener('mousedown', removePicker);
                  }
                });
              }, 0);
              return;
            }

            // Image tool: open file picker at click position
            if (tool === 'image') {
              e.preventDefault();
              var p = getPos(e);
              if (window._edPdfInsertImageAt) window._edPdfInsertImageAt(p);
              return;
            }

            // Signature tool: open signature modal at click position
            if (tool === 'signature') {
              e.preventDefault();
              var p = getPos(e);
              if (window._edPdfInsertSignatureAt) window._edPdfInsertSignatureAt(p);
              return;
            }

            // Eraser: start tracking for hit-testing on mousemove
            if (tool === 'eraser') {
              _drawing = true;
              var p = getPos(e);
              _startX = p.x;
              _startY = p.y;
              return;
            }

            _drawing = true;
            var p = getPos(e);
            _startX = p.x;
            _startY = p.y;
            _penPoints = [p];
          });

          ov.addEventListener('mousemove', function (e) {
            // Hover cursor hint for select tool over images
            if (!_drawing && _edPdfActiveTool === 'select') {
              var hp = getPos(e);
              var hAnnots = getPageAnnotations(_currentPage);
              var hIdx = _annotHitTest(hAnnots, hp);
              if (hIdx >= 0 && hAnnots[hIdx].type === 'image') {
                ov.style.cursor = _isOnResizeHandle(hAnnots[hIdx], hp) ? 'nwse-resize' : 'grab';
              } else {
                ov.style.cursor = 'default';
              }
              return;
            }
            if (!_drawing) return;
            var p = getPos(e);

            // Eraser: remove any annotation the cursor touches
            if (_edPdfActiveTool === 'eraser') {
              var R = 18; // eraser radius in canvas px
              var annots = getPageAnnotations(_currentPage);
              var before = annots.length;
              for (var ei = annots.length - 1; ei >= 0; ei--) {
                var a = annots[ei];
                var hit = false;
                if (a.type === 'highlight' || a.type === 'rect' || a.type === 'ellipse') {
                  var ax = Math.min(a.x, a.x + a.w),
                    ay = Math.min(a.y, a.y + a.h);
                  var aw = Math.abs(a.w),
                    ah = Math.abs(a.h);
                  hit = p.x >= ax - R && p.x <= ax + aw + R && p.y >= ay - R && p.y <= ay + ah + R;
                } else if (a.type === 'pen' && a.points) {
                  for (var pi = 0; pi < a.points.length - 1 && !hit; pi++) {
                    var dx = a.points[pi + 1].x - a.points[pi].x,
                      dy = a.points[pi + 1].y - a.points[pi].y;
                    var t = Math.max(
                      0,
                      Math.min(
                        1,
                        ((p.x - a.points[pi].x) * dx + (p.y - a.points[pi].y) * dy) /
                          (dx * dx + dy * dy + 0.001)
                      )
                    );
                    var cx = a.points[pi].x + t * dx - p.x,
                      cy = a.points[pi].y + t * dy - p.y;
                    hit = cx * cx + cy * cy < R * R;
                  }
                } else if (a.type === 'arrow') {
                  var dist = Math.sqrt(
                    Math.pow(p.x - (a.x + a.x2) / 2, 2) + Math.pow(p.y - (a.y + a.y2) / 2, 2)
                  );
                  hit = dist < R * 2;
                } else if (a.type === 'text') {
                  hit = Math.abs(p.x - a.x) < 60 && Math.abs(p.y - a.y) < 20;
                } else if (a.type === 'comment') {
                  hit = Math.abs(p.x - a.x) < 30 && Math.abs(p.y - a.y) < 30;
                } else if (a.type === 'sticky') {
                  hit =
                    p.x >= a.x - R &&
                    p.x <= a.x + 170 + R &&
                    p.y >= a.y - R &&
                    p.y <= a.y + 100 + R;
                } else if (a.type === 'stamp') {
                  hit = Math.abs(p.x - a.x) < 80 && Math.abs(p.y - a.y) < 20;
                }
                if (hit) {
                  _edPdfPushUndo();
                  annots.splice(ei, 1);
                }
              }
              if (annots.length !== before) {
                ovCtx.clearRect(0, 0, ov.width, ov.height);
                replayAnnotations(ovCtx, annots);
                _savePdfState();
              }
              // Draw eraser cursor ring
              ovCtx.save();
              ovCtx.globalAlpha = 0.6;
              ovCtx.strokeStyle = '#fff';
              ovCtx.lineWidth = 1.5;
              ovCtx.beginPath();
              ovCtx.arc(p.x, p.y, R, 0, 2 * Math.PI);
              ovCtx.stroke();
              ovCtx.restore();
              return;
            }

            var w = p.x - _startX,
              h = p.y - _startY;
            ovCtx.clearRect(0, 0, ov.width, ov.height);
            replayAnnotations(ovCtx, getPageAnnotations(_currentPage));
            ovCtx.save();
            ovCtx.globalAlpha = _edPdfOpacity;
            if (_edPdfActiveTool === 'highlight') {
              ovCtx.fillStyle = _edPdfActiveColor;
              ovCtx.fillRect(_startX, _startY, w, h);
            } else if (_edPdfActiveTool === 'pen') {
              _penPoints.push(p);
              ovCtx.strokeStyle = _edPdfActiveColor;
              ovCtx.lineWidth = _edPdfLineWidth;
              ovCtx.lineCap = 'round';
              ovCtx.lineJoin = 'round';
              ovCtx.beginPath();
              ovCtx.moveTo(_penPoints[0].x, _penPoints[0].y);
              for (var i = 1; i < _penPoints.length; i++)
                ovCtx.lineTo(_penPoints[i].x, _penPoints[i].y);
              ovCtx.stroke();
            } else if (_edPdfActiveTool === 'shapes') {
              ovCtx.strokeStyle = _edPdfActiveColor;
              ovCtx.lineWidth = _edPdfLineWidth;
              if (_shapeType === 'rect') {
                ovCtx.strokeRect(_startX, _startY, w, h);
              } else if (_shapeType === 'ellipse') {
                ovCtx.beginPath();
                ovCtx.ellipse(
                  _startX + w / 2,
                  _startY + h / 2,
                  Math.abs(w / 2),
                  Math.abs(h / 2),
                  0,
                  0,
                  2 * Math.PI
                );
                ovCtx.stroke();
              } else if (_shapeType === 'arrow') {
                ovCtx.lineCap = 'round';
                ovCtx.beginPath();
                ovCtx.moveTo(_startX, _startY);
                ovCtx.lineTo(p.x, p.y);
                ovCtx.stroke();
                var angle = Math.atan2(p.y - _startY, p.x - _startX),
                  hs = 14;
                ovCtx.beginPath();
                ovCtx.moveTo(p.x, p.y);
                ovCtx.lineTo(
                  p.x - hs * Math.cos(angle - Math.PI / 6),
                  p.y - hs * Math.sin(angle - Math.PI / 6)
                );
                ovCtx.moveTo(p.x, p.y);
                ovCtx.lineTo(
                  p.x - hs * Math.cos(angle + Math.PI / 6),
                  p.y - hs * Math.sin(angle + Math.PI / 6)
                );
                ovCtx.stroke();
              }
            }
            ovCtx.restore();
          });

          ov.addEventListener('mouseup', function (e) {
            if (!_drawing) return;
            _drawing = false;
            if (_edPdfActiveTool === 'eraser') {
              ovCtx.clearRect(0, 0, ov.width, ov.height);
              replayAnnotations(ovCtx, getPageAnnotations(_currentPage));
              return;
            }
            var p = getPos(e);
            var w = p.x - _startX,
              h = p.y - _startY;
            _edPdfPushUndo();
            var annots = getPageAnnotations(_currentPage);
            if (_edPdfActiveTool === 'highlight') {
              if (Math.abs(w) > 4 && Math.abs(h) > 4) {
                annots.push(
                  _mkAnnot({
                    type: 'highlight',
                    color: _edPdfActiveColor,
                    opacity: _edPdfOpacity,
                    x: _startX,
                    y: _startY,
                    w: w,
                    h: h
                  })
                );
              }
            } else if (_edPdfActiveTool === 'pen' && _penPoints.length > 2) {
              annots.push(
                _mkAnnot({
                  type: 'pen',
                  color: _edPdfActiveColor,
                  opacity: _edPdfOpacity,
                  points: _penPoints.slice(),
                  lineWidth: _edPdfLineWidth
                })
              );
              _penPoints = [];
            } else if (_edPdfActiveTool === 'shapes' && (Math.abs(w) > 4 || Math.abs(h) > 4)) {
              if (_shapeType === 'rect') {
                annots.push(
                  _mkAnnot({
                    type: 'rect',
                    color: _edPdfActiveColor,
                    opacity: _edPdfOpacity,
                    x: _startX,
                    y: _startY,
                    w: w,
                    h: h,
                    lineWidth: _edPdfLineWidth
                  })
                );
              } else if (_shapeType === 'ellipse') {
                annots.push(
                  _mkAnnot({
                    type: 'ellipse',
                    color: _edPdfActiveColor,
                    opacity: _edPdfOpacity,
                    x: _startX,
                    y: _startY,
                    w: w,
                    h: h,
                    lineWidth: _edPdfLineWidth
                  })
                );
              } else if (_shapeType === 'arrow') {
                annots.push(
                  _mkAnnot({
                    type: 'arrow',
                    color: _edPdfActiveColor,
                    opacity: _edPdfOpacity,
                    x: _startX,
                    y: _startY,
                    x2: p.x,
                    y2: p.y,
                    lineWidth: _edPdfLineWidth
                  })
                );
              }
            }
            ovCtx.clearRect(0, 0, ov.width, ov.height);
            replayAnnotations(ovCtx, annots);
            _savePdfState();
          });

          ov.addEventListener('mouseleave', function () {
            if (_drawing) {
              _drawing = false;
            }
          });
        });

        if (pageInfo) pageInfo.textContent = _currentPage + ' / ' + _pdf.numPages;
        if (thumbs) {
          thumbs.querySelectorAll('.epdf-thumb').forEach(function (t, i) {
            t.style.borderColor = i + 1 === _currentPage ? '#60a5fa' : 'rgba(255,255,255,.08)';
            t.style.background =
              i + 1 === _currentPage ? 'rgba(167,139,250,.15)' : 'rgba(255,255,255,.03)';
          });
        }
      }

      function buildThumbs() {
        if (!thumbs || !_pdf) return;
        thumbs.innerHTML = '';
        for (var i = 1; i <= _pdf.numPages; i++) {
          (function (num) {
            var wrap = document.createElement('div');
            wrap.className = 'epdf-thumb';
            wrap.dataset.page = num;
            wrap.style.cssText =
              'border:1.5px solid rgba(255,255,255,.08);border-radius:6px;overflow:hidden;cursor:pointer;background:rgba(255,255,255,.03);padding:0;transition:border-color .15s';
            var c = document.createElement('canvas');
            c.style.cssText = 'display:block;width:100%;height:auto';
            wrap.appendChild(c);
            var numLabel = document.createElement('div');
            numLabel.textContent = num;
            numLabel.style.cssText =
              'text-align:center;font-size:.62rem;font-weight:800;color:rgba(255,255,255,.3);padding:3px 0';
            wrap.appendChild(numLabel);
            thumbs.appendChild(wrap);
            wrap.addEventListener('click', function () {
              _currentPage = num;
              renderCurrentPage();
            });
            _pdf.getPage(num).then(function (page) {
              var vp = page.getViewport({ scale: 0.2 });
              c.width = vp.width;
              c.height = vp.height;
              page.render({ canvasContext: c.getContext('2d'), viewport: vp });
            });
          })(i);
        }
      }

      function _savePdfState() {
        _edPdfPersistState(_pdfFilename, _annotations, _currentPage, _scale);
        _edPdfRenderLayerPanel();
      }

      var _pdfFilename = '';

      // Expose internals so _edPdfRenderDashboard (outer scope) can call them
      window._edPdfLoadBytes = function (bytes, filename, page, annots) {
        _loadPdfBytes(bytes, filename, page, annots);
      };
      window._edPdfGetScale = function () {
        return _scale;
      };
      window._edPdfSetScale = function (v) {
        _scale = v;
        updateZoomLabel();
      };
      window._edPdfGetAnnotations = function () {
        return _annotations;
      };
      window._edPdfSetAnnotations = function (v) {
        _annotations = v;
      };
      window._edPdfClearUndo = function () {
        _undoStack = [];
      };

      function _loadPdfBytes(bytes, filename, restorePage, restoreAnnotations) {
        (window._ssEnsurePdfJs ? window._ssEnsurePdfJs() : Promise.resolve())
          .then(function () {
            return pdfjsLib.getDocument({ data: bytes }).promise.then(function (pdf) {
              _pdf = pdf;
              _pdfFilename = filename;
              _currentPage = restorePage || 1;
              if (restoreAnnotations) _annotations = restoreAnnotations;
              if (fname) fname.textContent = filename;
              var dashboard = document.getElementById('edPdfDashboard');
              if (dashboard) dashboard.style.display = 'none';
              if (drop) drop.style.display = 'none';
              main.style.display = 'flex';
              _edPdfAddRecent(filename);
              buildThumbs();
              renderCurrentPage();
            });
          })
          .catch(function () {
            showToast('Error', 'Could not read this PDF.');
          });
      }

      function loadPdf(file) {
        try {
          if (window._ssValidateUploadFile)
            window._ssValidateUploadFile(file, {
              allowedExtensions: ['.pdf'],
              allowedMimeTypes: ['application/pdf']
            });
          else if (!file || file.type !== 'application/pdf')
            throw new Error('Please select a PDF.');
        } catch (e) {
          showToast('Invalid file', e.message);
          return;
        }
        _annotations = {};
        _undoStack = [];
        var reader = new FileReader();
        reader.onload = function (e) {
          var bytes = new Uint8Array(e.target.result);
          // Save raw bytes to IndexedDB for refresh restore
          _edPdfIDBPut('pdf_bytes', e.target.result);
          _loadPdfBytes(bytes, file.name, 1, {});
          showToast('PDF loaded', file.name);
        };
        reader.readAsArrayBuffer(file);
      }

      if (prevBtn)
        prevBtn.addEventListener('click', function () {
          if (_pdf && _currentPage > 1) {
            _currentPage--;
            renderCurrentPage();
            _savePdfState();
          }
        });
      if (nextBtn)
        nextBtn.addEventListener('click', function () {
          if (_pdf && _currentPage < _pdf.numPages) {
            _currentPage++;
            renderCurrentPage();
            _savePdfState();
          }
        });
      if (zoomIn)
        zoomIn.addEventListener('click', function () {
          _scale = Math.min(_scale + 0.25, 4);
          updateZoomLabel();
          renderCurrentPage();
          _savePdfState();
        });
      if (zoomOut)
        zoomOut.addEventListener('click', function () {
          _scale = Math.max(_scale - 0.25, 0.5);
          updateZoomLabel();
          renderCurrentPage();
          _savePdfState();
        });

      // Undo — restores full annotation snapshot. Pushes the *current*
      // state onto the redo stack first so Redo can return to it.
      var _redoStack = [];
      document.querySelectorAll('.epdf-undo-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!_undoStack.length) return;
          _redoStack.push(JSON.parse(JSON.stringify(_annotations)));
          if (_redoStack.length > 60) _redoStack.shift();
          _annotations = _undoStack.pop();
          renderCurrentPage();
          _edPdfRenderLayerPanel();
          _savePdfState();
        });
      });
      // Redo — inverse of Undo. Restores the most recently undone state
      // and pushes the current state back onto the undo stack.
      document.querySelectorAll('.epdf-redo-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!_redoStack.length) return;
          _undoStack.push(JSON.parse(JSON.stringify(_annotations)));
          if (_undoStack.length > 60) _undoStack.shift();
          _annotations = _redoStack.pop();
          renderCurrentPage();
          _edPdfRenderLayerPanel();
          _savePdfState();
        });
      });
      // A fresh user edit invalidates the redo branch — clear it whenever
      // a new undo snapshot is pushed.
      var _origPushUndo = _edPdfPushUndo;
      _edPdfPushUndo = function () {
        _redoStack.length = 0;
        return _origPushUndo();
      };

      // Color swatches
      document.querySelectorAll('.epdf-color').forEach(function (sw) {
        sw.addEventListener('click', function () {
          _edPdfActiveColor = this.style.background;
          document.querySelectorAll('.epdf-color').forEach(function (s) {
            s.style.border = '2px solid transparent';
          });
          this.style.border = '2px solid rgba(255,255,255,.7)';
        });
      });

      // Custom color picker
      var customColorInput = document.getElementById('epdfCustomColorInput');
      var customColorBtn = document.getElementById('epdfCustomColorBtn');
      if (customColorInput) {
        customColorInput.addEventListener('input', function () {
          _edPdfActiveColor = customColorInput.value;
          document.querySelectorAll('.epdf-color').forEach(function (s) {
            s.style.border = '2px solid transparent';
          });
          if (customColorBtn) {
            customColorBtn.style.background = customColorInput.value;
            customColorBtn.style.border = '2px solid rgba(255,255,255,.7)';
          }
        });
      }

      // Opacity slider
      var opSlider = document.getElementById('edPdfOpacity');
      var opLabel = document.getElementById('edPdfOpacityLabel');
      if (opSlider) {
        opSlider.addEventListener('input', function () {
          _edPdfOpacity = this.value / 100;
          if (opLabel) opLabel.textContent = this.value + '%';
        });
      }

      // Blend mode — apply both to the default for new annotations *and*
      // retroactively to every existing annotation, then re-render so the
      // change is immediately visible.
      var blendSel = document.getElementById('edPdfBlendMode');
      if (blendSel) {
        blendSel.addEventListener('change', function () {
          _edPdfBlendMode = this.value;
          if (typeof _edPdfPushUndo === 'function') _edPdfPushUndo();
          Object.keys(_annotations).forEach(function (pg) {
            (_annotations[pg] || []).forEach(function (a) {
              a.blendMode = _edPdfBlendMode;
            });
          });
          renderCurrentPage();
          _savePdfState();
        });
      }

      // Layer panel renderer
      function _edPdfRenderLayerPanel() {
        var list = document.getElementById('edPdfLayerList');
        if (!list) return;
        var typeLabels = {
          highlight: { label: 'Highlight', color: '#facc15' },
          pen: { label: 'Pen', color: '#0ea5e9' },
          text: { label: 'Text Box', color: '#60a5fa' },
          'text-replace': { label: 'Text Edit', color: '#818cf8' },
          comment: { label: 'Comment', color: '#34d399' },
          sticky: { label: 'Sticky Note', color: '#fbbf24' },
          stamp: { label: 'Stamp', color: '#60a5fa' },
          arrow: { label: 'Arrow', color: '#fb923c' },
          shapes: { label: 'Shape', color: '#38bdf8' },
          ellipse: { label: 'Ellipse', color: '#38bdf8' },
          rect: { label: 'Rect', color: '#38bdf8' },
          image: { label: 'Image', color: '#4ade80' },
          eraser: { label: 'Eraser', color: '#94a3b8' }
        };
        // Collect all annotations across all pages
        var entries = [];
        Object.keys(_annotations).forEach(function (pg) {
          (_annotations[pg] || []).forEach(function (a, idx) {
            entries.push({ a: a, page: parseInt(pg, 10), idx: idx });
          });
        });
        list.replaceChildren();
        if (!entries.length) {
          var empty = document.createElement('div');
          empty.style.cssText =
            'font-size:.72rem;color:rgba(255,255,255,.25);font-weight:700;text-align:center;padding:12px 0';
          empty.textContent = 'No annotations yet';
          list.appendChild(empty);
          return;
        }
        entries
          .slice()
          .reverse()
          .forEach(function (entry) {
            var a = entry.a;
            var info = typeLabels[a.type] || { label: a.type, color: '#94a3b8' };
            var row = document.createElement('div');
            row.style.cssText =
              'display:flex;align-items:center;gap:8px;padding:6px 8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:8px';
            var dot = document.createElement('div');
            dot.style.cssText =
              'width:8px;height:8px;border-radius:50%;flex-shrink:0;background:' +
              (a.color || info.color);
            var lbl = document.createElement('div');
            lbl.style.cssText = 'flex:1;min-width:0';
            var name = document.createElement('div');
            name.style.cssText =
              'font-size:.72rem;font-weight:800;color:#e2d9f3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
            name.textContent = info.label;
            var pg = document.createElement('div');
            pg.style.cssText = 'font-size:.62rem;color:rgba(255,255,255,.3);font-weight:700';
            pg.textContent = 'Page ' + entry.page;
            lbl.appendChild(name);
            lbl.appendChild(pg);
            var eyeBtn = document.createElement('button');
            var hidden = !!_hiddenLayers[a.type];
            eyeBtn.style.cssText =
              'background:none;border:none;cursor:pointer;padding:2px;opacity:' +
              (hidden ? '0.3' : '1');
            eyeBtn.title = hidden ? 'Show layer' : 'Hide layer';
            eyeBtn.innerHTML =
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
            eyeBtn.addEventListener('click', function () {
              _hiddenLayers[a.type] = !_hiddenLayers[a.type];
              renderCurrentPage();
              _edPdfRenderLayerPanel();
            });
            row.appendChild(dot);
            row.appendChild(lbl);
            row.appendChild(eyeBtn);
            list.appendChild(row);
          });
      }

      // Refresh layer panel whenever page is rendered
      var _origRenderCurrentPage = renderCurrentPage;
      renderCurrentPage = function () {
        _origRenderCurrentPage();
        _edPdfRenderLayerPanel();
      };

      // ── Save button ──────────────────────────────────────────────────────────────
      var saveBtn = document.getElementById('edPdfSaveBtn');
      var savedBadge = document.getElementById('edPdfSavedBadge');
      function _showSavedBadge() {
        if (!savedBadge) return;
        savedBadge.style.display = 'flex';
        clearTimeout(savedBadge._hideTimer);
        savedBadge._hideTimer = setTimeout(function () {
          savedBadge.style.display = 'none';
        }, 2500);
      }
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          if (!_pdf) {
            showToast('No PDF loaded', 'Open a PDF first.');
            return;
          }
          _savePdfState();
          _showSavedBadge();
          showToast('Saved', 'Annotations saved locally.');
        });
      }

      // ── Pages scope dropdown ──────────────────────────────────────────────────────
      // "All Pages" vs "Current Page" controls which pages opacity/blend apply to
      // (informational — the actual rendering already uses per-annotation values)
      var pagesScopeSel = document.getElementById('edPdfPagesScope');
      // No special wiring needed — it's purely informational for now

      // ── Export: render all pages to canvas and pack into a PDF via jsPDF ─────────
      var exportBtn = document.getElementById('edPdfExportBtn');
      if (exportBtn) {
        exportBtn.addEventListener('click', function () {
          if (!_pdf) {
            showToast('No PDF', 'Open a PDF first.');
            return;
          }
          exportBtn.textContent = 'Exporting…';
          exportBtn.disabled = true;
          var totalPages = _pdf.numPages;
          var pageDataUrls = [];
          var exportScale = 2; // render at 2× for crisp export

          function renderPageForExport(pageNum, cb) {
            _pdf.getPage(pageNum).then(function (page) {
              var vp = page.getViewport({ scale: exportScale });
              var c = document.createElement('canvas');
              c.width = vp.width;
              c.height = vp.height;
              var ctx2 = c.getContext('2d');
              page.render({ canvasContext: ctx2, viewport: vp }).promise.then(function () {
                // Draw annotations for this page scaled up
                var annots = _annotations[pageNum] || [];
                ctx2.save();
                ctx2.scale(exportScale / _scale, exportScale / _scale);
                // Re-use replayAnnotations but we need to temporarily adjust scale
                // Simpler: replay with the full-res ctx at the export scale ratio
                ctx2.restore();
                // Replay annotations at export scale
                // Annotations are stored in _scale-coordinate space; convert to exportScale space
                var ratio = exportScale / _scale;
                annots.forEach(function (a) {
                  if (_hiddenLayers[a.type]) return;
                  ctx2.save();
                  ctx2.globalAlpha = a.opacity;
                  ctx2.globalCompositeOperation = a.blendMode || 'normal';
                  if (a.type === 'highlight') {
                    ctx2.fillStyle = a.color;
                    ctx2.fillRect(a.x * ratio, a.y * ratio, a.w * ratio, a.h * ratio);
                  } else if (a.type === 'pen' && a.points && a.points.length > 1) {
                    ctx2.strokeStyle = a.color;
                    ctx2.lineWidth = (a.lineWidth || 3) * ratio;
                    ctx2.lineCap = 'round';
                    ctx2.lineJoin = 'round';
                    ctx2.beginPath();
                    ctx2.moveTo(a.points[0].x * ratio, a.points[0].y * ratio);
                    for (var pi = 1; pi < a.points.length; pi++)
                      ctx2.lineTo(a.points[pi].x * ratio, a.points[pi].y * ratio);
                    ctx2.stroke();
                  } else if (a.type === 'rect') {
                    ctx2.strokeStyle = a.color;
                    ctx2.lineWidth = (a.lineWidth || 2) * ratio;
                    ctx2.strokeRect(a.x * ratio, a.y * ratio, a.w * ratio, a.h * ratio);
                  } else if (a.type === 'ellipse') {
                    ctx2.strokeStyle = a.color;
                    ctx2.lineWidth = (a.lineWidth || 2) * ratio;
                    ctx2.beginPath();
                    ctx2.ellipse(
                      (a.x + a.w / 2) * ratio,
                      (a.y + a.h / 2) * ratio,
                      Math.abs(a.w / 2) * ratio,
                      Math.abs(a.h / 2) * ratio,
                      0,
                      0,
                      2 * Math.PI
                    );
                    ctx2.stroke();
                  } else if (a.type === 'text') {
                    ctx2.fillStyle = a.color || '#000';
                    ctx2.font = (a.fontSize || 18) * ratio + 'px Nunito,sans-serif';
                    ctx2.fillText(a.text || '', a.x * ratio, a.y * ratio);
                  } else if (a.type === 'text-replace') {
                    ctx2.globalAlpha = 1;
                    ctx2.fillStyle = '#ffffff';
                    ctx2.fillRect(
                      (a.x - 2) * ratio,
                      (a.y - a.origH - 4) * ratio,
                      (a.origW + 6) * ratio,
                      (a.origH + 8) * ratio
                    );
                    if (a.newText) {
                      ctx2.globalAlpha = a.opacity || 1;
                      ctx2.fillStyle = a.color || '#000';
                      ctx2.font =
                        (a.fontStyle || 'normal') +
                        ' ' +
                        (a.fontWeight || 'normal') +
                        ' ' +
                        a.fontSize * ratio +
                        'px ' +
                        (a.fontFamily || 'sans-serif');
                      ctx2.textAlign = 'left';
                      ctx2.textBaseline = 'alphabetic';
                      ctx2.fillText(a.newText, a.x * ratio, a.y * ratio);
                    }
                  } else if (a.type === 'image' && a.src) {
                    var img = _imgCache[a.src];
                    if (img)
                      ctx2.drawImage(
                        img,
                        a.x * ratio,
                        a.y * ratio,
                        (a.w || 200) * ratio,
                        (a.h || 150) * ratio
                      );
                  }
                  ctx2.restore();
                });
                pageDataUrls.push({
                  url: c.toDataURL('image/jpeg', 0.92),
                  w: vp.width,
                  h: vp.height
                });
                if (pageNum < totalPages) renderPageForExport(pageNum + 1, cb);
                else cb();
              });
            });
          }

          function buildPdf() {
            // Load jsPDF dynamically if not present
            if (typeof window.jspdf === 'undefined' && typeof window.jsPDF === 'undefined') {
              var s = document.createElement('script');
              s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
              s.integrity =
                'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk';
              s.crossOrigin = 'anonymous';
              s.onload = buildPdf;
              s.onerror = function () {
                showToast('Export failed', 'Could not load PDF library.');
                exportBtn.textContent = 'Export';
                exportBtn.disabled = false;
              };
              document.head.appendChild(s);
              return;
            }
            var JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
            var first = pageDataUrls[0];
            var mmW = (first.w * 25.4) / 96;
            var mmH = (first.h * 25.4) / 96;
            var doc = new JsPDF({
              unit: 'mm',
              format: [mmW, mmH],
              orientation: mmW > mmH ? 'landscape' : 'portrait'
            });
            pageDataUrls.forEach(function (p, i) {
              if (i > 0) doc.addPage([mmW, mmH], mmW > mmH ? 'landscape' : 'portrait');
              doc.addImage(p.url, 'JPEG', 0, 0, mmW, mmH);
            });
            var fname = (_pdfFilename || 'export').replace(/\.pdf$/i, '') + '_annotated.pdf';
            doc.save(fname);
            exportBtn.textContent = 'Export';
            exportBtn.disabled = false;
            showToast('Exported', fname);
          }

          renderPageForExport(1, buildPdf);
        });
      }

      // Thickness buttons
      var thickValues = [1, 2, 4, 6, 8];
      document.querySelectorAll('.epdf-thick').forEach(function (btn, i) {
        btn.addEventListener('click', function () {
          _edPdfLineWidth = thickValues[i] || 3;
          document.querySelectorAll('.epdf-thick').forEach(function (b) {
            b.style.background = 'rgba(255,255,255,.2)';
            b.style.outline = '';
          });
          btn.style.background = '#60a5fa';
          btn.style.outline = '2px solid rgba(167,139,250,.6)';
        });
      });

      // Image tool: file input + canvas click handler
      var _imgToolInput = document.createElement('input');
      _imgToolInput.type = 'file';
      _imgToolInput.accept = 'image/*';
      _imgToolInput.style.display = 'none';
      document.body.appendChild(_imgToolInput);
      var _imgPendingPos = null;
      window._edPdfInsertImageAt = function (pos) {
        _imgPendingPos = pos;
        _imgToolInput.click();
      };
      _imgToolInput.addEventListener('change', function () {
        var file = _imgToolInput.files[0];
        _imgToolInput.value = '';
        if (!file || !_imgPendingPos) return;
        var reader = new FileReader();
        reader.onload = function (ev) {
          var src = ev.target.result;
          var pos = _imgPendingPos;
          _imgPendingPos = null;
          _getImg(src, function () {
            _edPdfPushUndo();
            var annots = getPageAnnotations(_currentPage);
            annots.push(
              _mkAnnot({ type: 'image', src: src, opacity: 1, x: pos.x, y: pos.y, w: 200, h: 150 })
            );
            var _ov = window._edPdfOverlayCanvas;
            if (_ov) {
              var _ovCtx = _ov.getContext('2d');
              _ovCtx.clearRect(0, 0, _ov.width, _ov.height);
              replayAnnotations(_ovCtx, annots);
            }
            _savePdfState();
          });
        };
        reader.readAsDataURL(file);
      });

      // Signature tool: modal with canvas
      window._edPdfInsertSignatureAt = function (pos) {
        var modal = document.createElement('div');
        modal.style.cssText =
          'position:fixed;inset:0;z-index:99999;background:rgba(10,8,18,.88);display:flex;align-items:center;justify-content:center';
        var box = document.createElement('div');
        box.style.cssText =
          'background:#1a1625;border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px;width:440px;max-width:calc(100vw - 32px)';
        var title = document.createElement('div');
        title.textContent = 'Draw your signature';
        title.style.cssText = 'font-family:Fredoka One,cursive;font-size:1.1rem;color:#e2d9f3';
        var sigCanvas = document.createElement('canvas');
        sigCanvas.width = 400;
        sigCanvas.height = 160;
        sigCanvas.style.cssText =
          "background:#fff;border-radius:8px;cursor:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Cline x1='10' y1='2' x2='10' y2='18' stroke='black' stroke-width='1.5'/%3E%3Cline x1='2' y1='10' x2='18' y2='10' stroke='black' stroke-width='1.5'/%3E%3C/svg%3E\") 10 10,crosshair;touch-action:none;width:100%;display:block";
        var sCtx = sigCanvas.getContext('2d');
        sCtx.strokeStyle = '#111';
        sCtx.lineWidth = 2;
        sCtx.lineCap = 'round';
        var _sigDrawing = false;
        sigCanvas.addEventListener('mousedown', function (e) {
          _sigDrawing = true;
          var r = sigCanvas.getBoundingClientRect();
          var scaleX = sigCanvas.width / r.width;
          var scaleY = sigCanvas.height / r.height;
          sCtx.beginPath();
          sCtx.moveTo((e.clientX - r.left) * scaleX, (e.clientY - r.top) * scaleY);
        });
        sigCanvas.addEventListener('mousemove', function (e) {
          if (!_sigDrawing) return;
          var r = sigCanvas.getBoundingClientRect();
          var scaleX = sigCanvas.width / r.width;
          var scaleY = sigCanvas.height / r.height;
          sCtx.lineTo((e.clientX - r.left) * scaleX, (e.clientY - r.top) * scaleY);
          sCtx.stroke();
        });
        sigCanvas.addEventListener('mouseup', function () {
          _sigDrawing = false;
        });
        sigCanvas.addEventListener('mouseleave', function () {
          _sigDrawing = false;
        });
        var btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
        var clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText =
          'padding:8px 18px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);border-radius:20px;color:rgba(255,255,255,.7);font-family:Nunito,sans-serif;font-weight:800;font-size:.85rem;cursor:pointer';
        clearBtn.addEventListener('click', function () {
          sCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
        });
        var insertBtn = document.createElement('button');
        insertBtn.textContent = 'Insert';
        insertBtn.style.cssText =
          'padding:8px 18px;background:rgba(167,139,250,.25);border:1px solid rgba(167,139,250,.4);border-radius:20px;color:#60a5fa;font-family:Nunito,sans-serif;font-weight:800;font-size:.85rem;cursor:pointer';
        insertBtn.addEventListener('click', function () {
          var dataUrl = sigCanvas.toDataURL();
          document.body.removeChild(modal);
          _getImg(dataUrl, function () {
            _edPdfPushUndo();
            var annots = getPageAnnotations(_currentPage);
            annots.push(
              _mkAnnot({
                type: 'image',
                src: dataUrl,
                opacity: 1,
                x: pos.x,
                y: pos.y,
                w: 200,
                h: 80
              })
            );
            var _ov = window._edPdfOverlayCanvas;
            if (_ov) {
              var _ovCtx = _ov.getContext('2d');
              _ovCtx.clearRect(0, 0, _ov.width, _ov.height);
              replayAnnotations(_ovCtx, annots);
            }
            _savePdfState();
          });
        });
        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText =
          'padding:8px 18px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);border-radius:20px;color:rgba(255,255,255,.7);font-family:Nunito,sans-serif;font-weight:800;font-size:.85rem;cursor:pointer';
        cancelBtn.addEventListener('click', function () {
          document.body.removeChild(modal);
        });
        btns.appendChild(clearBtn);
        btns.appendChild(cancelBtn);
        btns.appendChild(insertBtn);
        box.appendChild(title);
        box.appendChild(sigCanvas);
        box.appendChild(btns);
        modal.appendChild(box);
        document.body.appendChild(modal);
      };

      if (openBtn) {
        openBtn.addEventListener('click', function () {
          input.click();
        });
      }
      input.addEventListener('change', function () {
        if (this.files[0]) loadPdf(this.files[0]);
        this.value = '';
      });
      drop.addEventListener('click', function () {
        input.click();
      });

      window._edPdfEditorDrop = function (e) {
        e.preventDefault();
        drop.style.borderColor = 'rgba(167,139,250,.28)';
        drop.style.background = 'rgba(167,139,250,.025)';
        var f = e.dataTransfer.files[0];
        if (f) loadPdf(f);
      };

      // Tool sidebar — event delegation
      var toolSidebar =
        drop.closest('#editorPdfEditorView') &&
        document.querySelector('#editorPdfEditorView .epdf-tool')
          ? document.querySelector('#editorPdfEditorView .epdf-tool').parentElement
          : null;
      document.querySelectorAll('.epdf-tool[data-tool]').forEach(function (el) {
        el.addEventListener('click', function () {
          window._edPdfSelectTool && window._edPdfSelectTool(el.dataset.tool);
        });
      });

      // Mode buttons
      document.querySelectorAll('.epdf-mode-btn[data-mode]').forEach(function (el) {
        el.addEventListener('click', function () {
          window._edPdfSetMode && window._edPdfSetMode(el.dataset.mode);
        });
      });

      // Shape buttons
      document.querySelectorAll('[data-shape]').forEach(function (el) {
        el.addEventListener('click', function () {
          window._edPdfSetShape && window._edPdfSetShape(el.dataset.shape);
        });
      });

      // Drop zone drag events (drop zone is now inside the dashboard empty state)
      if (drop) {
        drop.addEventListener('dragover', function (e) {
          e.preventDefault();
          drop.style.borderColor = 'rgba(167,139,250,.65)';
          drop.style.background = 'rgba(167,139,250,.06)';
        });
        drop.addEventListener('dragleave', function () {
          drop.style.borderColor = 'rgba(167,139,250,.28)';
          drop.style.background = 'rgba(167,139,250,.025)';
        });
        drop.addEventListener('drop', function (e) {
          window._edPdfEditorDrop && window._edPdfEditorDrop(e);
        });
      }

      // Dashboard drag-over (whole dashboard accepts drops)
      var dashboard = document.getElementById('edPdfDashboard');
      if (dashboard) {
        dashboard.addEventListener('dragover', function (e) {
          e.preventDefault();
        });
        dashboard.addEventListener('drop', function (e) {
          window._edPdfEditorDrop && window._edPdfEditorDrop(e);
        });
      }

      // Choose / Open PDF button
      var chooseBtn = document.getElementById('edPdfChooseBtn');
      if (chooseBtn) {
        chooseBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          input.click();
        });
      }

      // Render recent PDFs dashboard
      _edPdfRenderDashboard();

      // Back button: when a PDF is open go to dashboard; otherwise go to hub
      var backBtn = document.getElementById('edPdfEditorBack');
      if (backBtn && !backBtn._dashWired) {
        backBtn._dashWired = true;
        backBtn.addEventListener(
          'click',
          function (e) {
            if (_pdf) {
              e.stopImmediatePropagation();
              _savePdfState();
              _pdf = null;
              _pdfFilename = '';
              _annotations = {};
              _undoStack = [];
              main.style.display = 'none';
              var db2 = document.getElementById('edPdfDashboard');
              if (db2) {
                db2.style.display = '';
                _edPdfRenderDashboard();
              }
            }
            // no PDF open → let existing hub-back handler fire normally
          },
          true
        );
      }

      // Pro tip close button
      var proTipClose = document.getElementById('edPdfProTipClose');
      if (proTipClose) {
        proTipClose.addEventListener('click', function () {
          var tip = document.getElementById('edPdfProTip');
          if (tip) tip.style.display = 'none';
        });
      }

      // Merger drop zone
      var mergerDrop = document.getElementById('edPdfMergerDrop');
      if (mergerDrop) {
        mergerDrop.addEventListener('dragover', function (e) {
          e.preventDefault();
          mergerDrop.style.borderColor = 'rgba(52,211,153,.65)';
          mergerDrop.style.background = 'rgba(52,211,153,.06)';
        });
        mergerDrop.addEventListener('dragleave', function () {
          mergerDrop.style.borderColor = 'rgba(52,211,153,.28)';
          mergerDrop.style.background = 'rgba(52,211,153,.025)';
        });
        mergerDrop.addEventListener('drop', function (e) {
          window._edPdfMergerDrop && window._edPdfMergerDrop(e);
        });
      }

      updateZoomLabel();

      // Auto-restore: if a cached PDF exists, reopen it; otherwise show dashboard
      _edPdfRenderDashboard();
      _edPdfIDBGet('pdf_bytes', function (buf) {
        var meta = null;
        try {
          meta = JSON.parse(localStorage.getItem('ss_pdfed_meta') || 'null');
        } catch (ex) {}
        if (buf && meta && meta.filename) {
          var bytes = new Uint8Array(buf);
          if (window._edPdfSetAnnotations)
            window._edPdfSetAnnotations((meta && meta.annotations) || {});
          if (window._edPdfClearUndo) window._edPdfClearUndo();
          if (window._edPdfSetScale) window._edPdfSetScale((meta && meta.scale) || 1.25);
          if (window._edPdfLoadBytes)
            window._edPdfLoadBytes(bytes, meta.filename, meta.page || 1, meta.annotations || {});
        }
      });
    }
  }
})();
