(function () {
  function _init() {
    // ── PDF MERGER ───────────────────────────────────────────────────────────────

    var _edPdfMergerFiles = [];
    var _edPdfMergerInited = false;

    function _edPdfMergerInit() {
      var addBtn = document.getElementById('edPdfMergerAddBtn');
      var chooseBtn = document.getElementById('edPdfMergerChooseBtn');
      var input = document.getElementById('edPdfMergerInput');
      var drop = document.getElementById('edPdfMergerDrop');
      var list = document.getElementById('edPdfMergerList');
      var listWrap = document.getElementById('edPdfMergerListWrap');
      var runBtn = document.getElementById('edPdfMergerRunBtn');
      var totalFiles = document.getElementById('edMgTotalFiles');
      var totalPages = document.getElementById('edMgTotalPages');
      var badge = document.getElementById('edMgFilesBadge');
      var fnInput = document.getElementById('edPdfMergerFilename');

      if (!addBtn || _edPdfMergerInited) return;
      _edPdfMergerInited = true;

      function fmtSize(bytes) {
        return bytes > 1048576
          ? (bytes / 1048576).toFixed(1) + ' MB'
          : Math.round(bytes / 1024) + ' KB';
      }

      function updateStats() {
        var n = _edPdfMergerFiles.length;
        if (totalFiles) totalFiles.textContent = n;
        if (badge) badge.textContent = n + (n === 1 ? ' file' : ' files');
        var pages = _edPdfMergerFiles.reduce(function (s, f) {
          return s + (f._pages || 0);
        }, 0);
        if (totalPages) totalPages.textContent = pages;
        if (listWrap) listWrap.style.display = n ? 'flex' : 'none';
      }

      var _dragIdx = null;

      function renderList() {
        updateStats();
        if (!list) return;
        list.replaceChildren();
        _edPdfMergerFiles.forEach(function (f, i) {
          var sz = fmtSize(f.size);
          var pg = f._pages ? f._pages + (f._pages === 1 ? ' page' : ' pages') : '...';
          var row = document.createElement('div');
          var svgNs = 'http://www.w3.org/2000/svg';
          row.className = 'edMgRow';
          row.draggable = true;
          row.dataset.idx = i;
          row.style.cssText =
            'display:flex;align-items:center;gap:12px;padding:12px 16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;margin-bottom:8px;cursor:default;transition:border-color .15s,background .15s';

          var handle = document.createElementNS(svgNs, 'svg');
          handle.setAttribute('width', '16');
          handle.setAttribute('height', '16');
          handle.setAttribute('viewBox', '0 0 24 24');
          handle.setAttribute('fill', 'none');
          handle.setAttribute('stroke', 'rgba(255,255,255,.25)');
          handle.setAttribute('stroke-width', '1.8');
          handle.setAttribute('stroke-linecap', 'round');
          handle.setAttribute('class', 'edMgHandle');
          handle.style.cssText = 'cursor:grab;flex-shrink:0;touch-action:none';
          [
            ['9', '6'],
            ['9', '12'],
            ['9', '18'],
            ['15', '6'],
            ['15', '12'],
            ['15', '18']
          ].forEach(function (pair) {
            var circle = document.createElementNS(svgNs, 'circle');
            circle.setAttribute('cx', pair[0]);
            circle.setAttribute('cy', pair[1]);
            circle.setAttribute('r', '1');
            handle.appendChild(circle);
          });

          var pdfBadge = document.createElement('div');
          pdfBadge.style.cssText =
            'width:34px;height:38px;background:#ef4444;border-radius:5px;display:flex;align-items:center;justify-content:center;flex-shrink:0';
          var pdfText = document.createElement('span');
          pdfText.style.cssText =
            'font-size:.55rem;font-weight:900;color:#fff;letter-spacing:.03em';
          pdfText.textContent = 'PDF';
          pdfBadge.appendChild(pdfText);

          var info = document.createElement('div');
          info.style.cssText = 'flex:1;min-width:0';
          var nameEl = document.createElement('div');
          nameEl.style.cssText =
            'font-size:.84rem;font-weight:700;color:#e2d9f3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          nameEl.textContent = f.name;
          var metaEl = document.createElement('div');
          metaEl.style.cssText =
            'font-size:.7rem;color:rgba(255,255,255,.3);font-weight:700;margin-top:2px';
          metaEl.textContent = pg + ' - ' + sz;
          info.appendChild(nameEl);
          info.appendChild(metaEl);

          var pageBadge = document.createElement('span');
          pageBadge.style.cssText =
            'padding:3px 10px;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.25);border-radius:20px;font-size:.7rem;font-weight:800;color:#34d399;flex-shrink:0';
          pageBadge.textContent = pg;

          var sizeEl = document.createElement('span');
          sizeEl.style.cssText =
            'font-size:.72rem;color:rgba(255,255,255,.3);font-weight:700;flex-shrink:0';
          sizeEl.textContent = sz;

          var removeBtn = document.createElement('button');
          removeBtn.className = 'edMgRm';
          removeBtn.dataset.idx = i;
          removeBtn.style.cssText =
            'padding:5px 8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:rgba(255,255,255,.4);cursor:pointer;font-size:.8rem;line-height:1;flex-shrink:0';
          removeBtn.textContent = 'X';

          row.appendChild(handle);
          row.appendChild(pdfBadge);
          row.appendChild(info);
          row.appendChild(pageBadge);
          row.appendChild(sizeEl);
          row.appendChild(removeBtn);

          // Drag events
          row.addEventListener('dragstart', function (e) {
            _dragIdx = i;
            e.dataTransfer.effectAllowed = 'move';
            setTimeout(function () {
              row.style.opacity = '0.4';
            }, 0);
          });
          row.addEventListener('dragend', function () {
            row.style.opacity = '1';
            list.querySelectorAll('.edMgRow').forEach(function (r) {
              r.style.borderColor = 'rgba(255,255,255,.08)';
              r.style.background = 'rgba(255,255,255,.04)';
            });
          });
          row.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            list.querySelectorAll('.edMgRow').forEach(function (r) {
              r.style.borderColor = 'rgba(255,255,255,.08)';
              r.style.background = 'rgba(255,255,255,.04)';
            });
            if (_dragIdx !== i) {
              row.style.borderColor = 'rgba(52,211,153,.5)';
              row.style.background = 'rgba(52,211,153,.06)';
            }
          });
          row.addEventListener('drop', function (e) {
            e.preventDefault();
            if (_dragIdx === null || _dragIdx === i) return;
            var moved = _edPdfMergerFiles.splice(_dragIdx, 1)[0];
            _edPdfMergerFiles.splice(i, 0, moved);
            _dragIdx = null;
            renderList();
          });

          // Remove button
          removeBtn.addEventListener('click', function () {
            _edPdfMergerFiles.splice(i, 1);
            renderList();
          });
          removeBtn.addEventListener('mouseover', function () {
            this.style.color = '#ef4444';
            this.style.borderColor = 'rgba(239,68,68,.4)';
          });
          removeBtn.addEventListener('mouseout', function () {
            this.style.color = 'rgba(255,255,255,.4)';
            this.style.borderColor = 'rgba(255,255,255,.1)';
          });

          list.appendChild(row);
        });
      }

      function loadPageCount(file) {
        var reader = new FileReader();
        reader.onload = function (e) {
          (window._ssEnsurePdfJs ? window._ssEnsurePdfJs() : Promise.resolve())
            .then(function () {
              return pdfjsLib
                .getDocument({ data: e.target.result })
                .promise.then(function (doc) {
                  file._pages = doc.numPages;
                  renderList();
                })
                .catch(function () {});
            })
            .catch(function () {});
        };
        reader.readAsArrayBuffer(file);
      }

      function addFiles(files) {
        Array.from(files).forEach(function (f) {
          try {
            if (window._ssValidateUploadFile)
              window._ssValidateUploadFile(f, {
                allowedExtensions: ['.pdf'],
                allowedMimeTypes: ['application/pdf']
              });
          } catch (e) {
            showToast('File blocked', f.name + ': ' + e.message);
            return;
          }
          if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
            f._pages = 0;
            _edPdfMergerFiles.push(f);
            loadPageCount(f);
          }
        });
        renderList();
      }

      addBtn.addEventListener('click', function () {
        input.click();
      });
      if (chooseBtn)
        chooseBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          input.click();
        });
      drop.addEventListener('click', function () {
        input.click();
      });
      input.addEventListener('change', function () {
        addFiles(this.files);
        this.value = '';
      });
      window._edPdfMergerDrop = function (e) {
        e.preventDefault();
        drop.style.borderColor = 'rgba(52,211,153,.28)';
        drop.style.background = 'rgba(52,211,153,.025)';
        addFiles(e.dataTransfer.files);
      };

      runBtn.addEventListener('click', async function () {
        if (!_edPdfMergerFiles.length) {
          showToast('No files', 'Add at least one PDF first');
          return;
        }
        var origHTML = runBtn.innerHTML;
        runBtn.textContent = '⏳ Merging…';
        runBtn.disabled = true;
        try {
          if (!window.PDFLib) {
            await new Promise(function (res, rej) {
              var s = document.createElement('script');
              s.src = 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js';
              s.integrity =
                'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI';
              s.crossOrigin = 'anonymous';
              s.onload = res;
              s.onerror = rej;
              document.head.appendChild(s);
            });
          }
          var merged = await PDFLib.PDFDocument.create();
          for (var i = 0; i < _edPdfMergerFiles.length; i++) {
            var buf = await _edPdfMergerFiles[i].arrayBuffer();
            var doc = await PDFLib.PDFDocument.load(buf);
            var pgs = await merged.copyPages(doc, doc.getPageIndices());
            pgs.forEach(function (p) {
              merged.addPage(p);
            });
          }
          var bytes = await merged.save();
          var blob = new Blob([bytes], { type: 'application/pdf' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          var fname = (fnInput && fnInput.value.trim()) || 'Merged.pdf';
          if (!fname.toLowerCase().endsWith('.pdf')) fname += '.pdf';
          a.href = url;
          a.download = fname;
          a.click();
          setTimeout(function () {
            URL.revokeObjectURL(url);
          }, 5000);
          showToast('Merged!', _edPdfMergerFiles.length + ' PDFs combined successfully');
        } catch (e) {
          showToast('Merge failed', e.message || 'Something went wrong');
        }
        runBtn.innerHTML = origHTML;
        runBtn.disabled = false;
      });
    }
    window._edPdfMergerInit = _edPdfMergerInit;
  }
  window.addEventListener('ss-editor-ready', _init);
  if (document.getElementById('edPdfMergerAddBtn')) _init();
})();
