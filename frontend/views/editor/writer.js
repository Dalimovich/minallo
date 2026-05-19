(function () {
  function _init() {
    // ── DOCUMENT EDITOR ──────────────────────────────────────────────────────────

    var _editorInited = false;

    var _ed = {
      doc: null,
      pageIdx: 0,
      tool: 'text',
      annType: 'highlight',
      shapeType: 'rect',
      zoom: 100,
      undoStack: [],
      redoStack: [],
      clipboard: null,
      selObj: null,
      dirty: false,
      autoTimer: null
    };

    var _ED_SIZES = {
      a4: { w: 794, h: 1123 },
      letter: { w: 816, h: 1056 },
      a3: { w: 1123, h: 1587 }
    };

    // ── Storage (localStorage cache + Supabase cloud) ────────────────────────────
    // Supabase table required:
    //   CREATE TABLE editor_docs (
    //     id text PRIMARY KEY,
    //     user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    //     title text DEFAULT 'Untitled',
    //     data jsonb NOT NULL,
    //     updated_at timestamptz DEFAULT now()
    //   );
    //   ALTER TABLE editor_docs ENABLE ROW LEVEL SECURITY;
    //   CREATE POLICY "own docs" ON editor_docs FOR ALL USING (auth.uid()=user_id);

    // Strips script/event-handler content from stored page HTML before injecting into the DOM
    function _edSanitize(html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      tmp.querySelectorAll('script,style,iframe,object,embed,form').forEach(function (el) {
        el.remove();
      });
      tmp.querySelectorAll('*').forEach(function (el) {
        Array.from(el.attributes).forEach(function (attr) {
          if (
            /^on/i.test(attr.name) ||
            (attr.name === 'href' && /^javascript:/i.test(attr.value))
          ) {
            el.removeAttribute(attr.name);
          }
        });
      });
      return tmp.innerHTML;
    }

    function _edKey() {
      var uid = _currentUser && (_currentUser.id || _currentUser.sub);
      return 'ss_editor_docs_' + (uid || 'guest');
    }
    function _edLoadDocs() {
      try {
        return JSON.parse(localStorage.getItem(_edKey()) || '[]');
      } catch (e) {
        return [];
      }
    }
    function _edSaveDocs(docs) {
      try {
        localStorage.setItem(_edKey(), JSON.stringify(docs));
      } catch (e) {}
    }

    async function _edSaveToSupabase(doc) {
      if (!_currentUser || !doc) return;
      var uid = _currentUser.id || _currentUser.sub;
      try {
        await fetch(SUPA_URL + '/rest/v1/editor_docs', {
          method: 'POST',
          headers: Object.assign(_sbHeaders(), {
            Prefer: 'resolution=merge-duplicates,return=minimal'
          }),
          body: JSON.stringify({
            id: doc.id,
            user_id: uid,
            title: doc.title || 'Untitled',
            data: doc,
            updated_at: new Date().toISOString()
          })
        });
      } catch (e) {
        console.warn('_edSaveToSupabase:', e);
      }
    }

    async function _edLoadFromSupabase() {
      var uid = _currentUser && (_currentUser.id || _currentUser.sub);
      if (!uid) return [];
      try {
        var r = await fetch(
          SUPA_URL +
            '/rest/v1/editor_docs?select=*&user_id=eq.' +
            encodeURIComponent(uid) +
            '&order=updated_at.desc',
          { headers: _sbHeaders() }
        );
        if (!r.ok) return [];
        var rows = await r.json();
        if (!Array.isArray(rows)) return [];
        return rows.map(function (row) {
          var doc = typeof row.data === 'object' && row.data ? row.data : {};
          doc.id = row.id;
          doc.title = row.title || doc.title || 'Untitled';
          doc.updated = new Date(row.updated_at).getTime();
          return _edNormalizeDoc(doc);
        });
      } catch (e) {
        console.warn('_edLoadFromSupabase:', e);
        return [];
      }
    }

    async function _edDeleteFromSupabase(docId) {
      var uid = _currentUser && (_currentUser.id || _currentUser.sub);
      if (!uid || !docId) return;
      try {
        await fetch(
          SUPA_URL +
            '/rest/v1/editor_docs?id=eq.' +
            encodeURIComponent(docId) +
            '&user_id=eq.' +
            encodeURIComponent(uid),
          { method: 'DELETE', headers: _sbHeaders() }
        );
      } catch (e) {
        console.warn('_edDeleteFromSupabase:', e);
      }
    }
    function _edClone(o) {
      return JSON.parse(JSON.stringify(o));
    }
    function _edId() {
      return 'ed_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }
    function _edPageId() {
      return 'pg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    }
    function _edNewPage(content) {
      return { id: _edPageId(), content: content || '<p><br></p>', objects: [], annotations: [] };
    }
    function _edNewDocObj() {
      return {
        id: _edId(),
        title: 'Untitled',
        updated: Date.now(),
        settings: {
          size: 'a4',
          orientation: 'portrait',
          margins: { top: 20, bottom: 20, left: 20, right: 20 },
          bgColor: '#ffffff',
          showGrid: false,
          snapGrid: false
        },
        pages: [_edNewPage()]
      };
    }

    // ── Undo/Redo ─────────────────────────────────────────────────────────────────

    function _edPushUndo() {
      if (!_ed.doc) return;
      _ed.undoStack.push(_edClone(_ed.doc.pages));
      if (_ed.undoStack.length > 60) _ed.undoStack.shift();
      _ed.redoStack = [];
      _edUpdateUndoRedoBtns();
    }
    function _edUndo() {
      if (!_ed.undoStack.length || !_ed.doc) return;
      _ed.redoStack.push(_edClone(_ed.doc.pages));
      _ed.doc.pages = _ed.undoStack.pop();
      _edUpdateUndoRedoBtns();
      _edRenderAllPages();
      _edUpdateThumbs();
    }
    function _edRedo() {
      if (!_ed.redoStack.length || !_ed.doc) return;
      _ed.undoStack.push(_edClone(_ed.doc.pages));
      _ed.doc.pages = _ed.redoStack.pop();
      _edUpdateUndoRedoBtns();
      _edRenderAllPages();
      _edUpdateThumbs();
    }
    function _edUpdateUndoRedoBtns() {
      var u = document.getElementById('edUndoBtn');
      if (u) u.disabled = !_ed.undoStack.length;
      var r = document.getElementById('edRedoBtn');
      if (r) r.disabled = !_ed.redoStack.length;
    }

    // ── Doc active state ──────────────────────────────────────────────────────────

    function _edSetDocActive(has) {
      // Show/hide doc-specific topbar buttons
      ['editorSaveBtn', 'editorDeleteBtn', 'editorDuplicateBtn', 'edAddPageBtn', 'editorExportBtn'].forEach(
        function (id) {
          var el = document.getElementById(id);
          if (!el) return;
          el.style.display = has ? '' : 'none';
          el.disabled = !has;
        }
      );
      var exportWrap = document.getElementById('edExportWrap');
      if (exportWrap) exportWrap.style.display = has ? '' : 'none';
      var wc = document.getElementById('editorWordCount');
      if (wc) wc.style.visibility = has ? 'visible' : 'hidden';
      var ei = document.getElementById('editorTitleEditIcon');
      if (ei) ei.style.display = has ? '' : 'none';
      var bb = document.getElementById('editorBackBtn');
      if (bb) bb.style.display = has ? '' : 'none';
      var di = document.getElementById('editorDocIcon');
      if (di) di.style.display = has ? '' : 'none';
      // Show/hide toolbar and properties panel
      var tb = document.getElementById('editorToolbar');
      if (tb) tb.style.display = has ? '' : 'none';
      var pp = document.getElementById('editorPropsPanel');
      if (pp) pp.style.display = has ? '' : 'none';
      // Hide pages sidebar + bottom pagination on document home
      var pages = document.getElementById('editorPagesPanel');
      if (pages) pages.style.display = has ? '' : 'none';
      var bottom = document.querySelector('#psec-editor .editor-bottom-bar');
      if (bottom) bottom.style.display = has ? '' : 'none';
    }

    function _edGoHome() {
      if (_ed.dirty) _edSaveDoc();
      _ed.doc = null;
      _ed.pageIdx = 0;
      _ed.undoStack = [];
      _ed.redoStack = [];
      _edUpdateUndoRedoBtns();
      _edSetDocActive(false);
      _edDeselectObj();
      var cs = document.getElementById('editorCanvasScroll');
      if (cs) cs.style.display = 'none';
      var es = document.getElementById('editorEmptyState');
      if (es) es.style.display = '';
      var pl = document.getElementById('editorPagesList');
      if (pl) pl.innerHTML = '<div class="editor-pages-empty">No pages yet</div>';
      var pt = document.getElementById('edPageTotal');
      if (pt) pt.textContent = '0';
      var titleIn = document.getElementById('editorTitleInput');
      if (titleIn) {
        titleIn.value = '';
        titleIn.disabled = true;
      }
      _edRenderDocList();
    }

    function _edGoToHub() {
      _edGoHome();
      if (typeof window._edHubShow === 'function') window._edHubShow();
    }

    // ── Tool mode ─────────────────────────────────────────────────────────────────

    function _edSetTool(tool) {
      _ed.tool = tool;
      document.querySelectorAll('.ed-mode-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === tool);
      });
      var ctxMap = {
        select: null,
        text: 'edCtxText',
        highlight: 'edCtxAnnotate',
        comment: 'edCtxComment',
        shape: 'edCtxShape',
        image: 'edCtxImage'
      };
      ['edCtxText', 'edCtxAnnotate', 'edCtxComment', 'edCtxShape', 'edCtxImage'].forEach(
        function (id) {
          var el = document.getElementById(id);
          if (el) el.style.display = 'none';
        }
      );
      var show = ctxMap[tool];
      if (show) {
        var el = document.getElementById(show);
        if (el) el.style.display = '';
      }
      document.querySelectorAll('.ed-page').forEach(function (p) {
        p.setAttribute('data-tool', tool);
      });
      if (tool !== 'select') _edDeselectObj();
    }

    // ── Doc list (sidebar) ────────────────────────────────────────────────────────

    function _edRenderDocList() {
      // Render the home-screen document grid
      var grid = document.getElementById('edDocsGrid');
      var loading = document.getElementById('edDocsLoading');
      var empty = document.getElementById('edDocsEmpty');
      if (!grid) return;

      var docs = _edLoadDocs().sort(function (a, b) {
        return b.updated - a.updated;
      });

      if (loading) loading.style.display = 'none';

      if (!docs.length) {
        grid.style.display = 'none';
        if (empty) empty.style.display = '';
        return;
      }

      if (empty) empty.style.display = 'none';
      grid.style.display = '';

      grid.replaceChildren();
      docs.forEach(function (d) {
        var date = new Date(d.updated).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });
        var card = document.createElement('div');
        card.className = 'ed-doc-card';
        card.dataset.id = d.id;

        var preview = document.createElement('div');
        preview.className = 'ed-doc-card-preview';
        ['title', '', '', 'short', '', '', 'short'].forEach(function (variant) {
          var line = document.createElement('div');
          line.className = 'ed-doc-card-line' + (variant ? ' ' + variant : '');
          preview.appendChild(line);
        });

        var info = document.createElement('div');
        info.className = 'ed-doc-card-info';
        var name = document.createElement('div');
        name.className = 'ed-doc-card-name';
        name.textContent = d.title || 'Untitled';
        var dateEl = document.createElement('div');
        dateEl.className = 'ed-doc-card-date';
        dateEl.textContent = date;
        info.appendChild(name);
        info.appendChild(dateEl);

        var delBtn = document.createElement('button');
        delBtn.className = 'ed-doc-card-del';
        delBtn.dataset.id = d.id;
        delBtn.title = 'Delete';
        delBtn.setAttribute('aria-label', 'Delete document');
        delBtn.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

        card.appendChild(preview);
        card.appendChild(info);
        card.appendChild(delBtn);
        grid.appendChild(card);
      });

      grid.querySelectorAll('.ed-doc-card').forEach(function (card) {
        card.addEventListener('click', function (e) {
          if (e.target.closest('.ed-doc-card-del')) return;
          _edOpenDocById(card.getAttribute('data-id'));
        });
      });

      grid.querySelectorAll('.ed-doc-card-del').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = btn.getAttribute('data-id');
          if (!confirm('Delete this document?')) return;
          var docs = _edLoadDocs().filter(function (d) {
            return d.id !== id;
          });
          _edSaveDocs(docs);
          _edDeleteFromSupabase(id);
          _edRenderDocList();
        });
      });
    }

    // ── Page dimensions ───────────────────────────────────────────────────────────

    function _edGetPageDims() {
      if (!_ed.doc) return { w: 794, h: 1123 };
      var s = _ed.doc.settings || {};
      var base = _ED_SIZES[s.size] || _ED_SIZES.a4;
      return s.orientation === 'landscape' ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
    }

    function _edPxToMm(px) {
      return Math.round(((px * 25.4) / 96) * 100) / 100;
    }

    // ── Page rendering ─────────────────────────────────────────────────────────────

    function _edRenderAllPages() {
      var scroll = document.getElementById('editorCanvasScroll');
      if (!scroll || !_ed.doc) return;
      scroll.innerHTML = '';
      _ed.doc.pages.forEach(function (page, idx) {
        scroll.appendChild(_edBuildPageEl(page, idx));
      });
      _edGoToPage(_ed.pageIdx, true);
    }

    function _edBuildPageEl(page, idx) {
      var dims = _edGetPageDims(),
        s = _ed.doc.settings,
        m = s.margins;
      var pxT = Math.round(m.top * 3.78),
        pxB = Math.round(m.bottom * 3.78),
        pxL = Math.round(m.left * 3.78),
        pxR = Math.round(m.right * 3.78);

      var wrap = document.createElement('div');
      wrap.className = 'ed-page-wrap';
      wrap.setAttribute('data-page-idx', idx);

      var pageEl = document.createElement('div');
      pageEl.className = 'ed-page' + (idx === _ed.pageIdx ? ' active' : '');
      pageEl.setAttribute('data-page-idx', idx);
      pageEl.setAttribute('data-tool', _ed.tool);
      pageEl.style.width = dims.w + 'px';
      pageEl.style.minHeight = dims.h + 'px';
      pageEl.style.background = s.bgColor;
      if (s.showGrid) {
        pageEl.style.backgroundImage =
          'linear-gradient(rgba(0,0,0,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,.06) 1px,transparent 1px)';
        pageEl.style.backgroundSize = '20px 20px';
      }

      // Text layer
      var content = document.createElement('div');
      content.className = 'ed-page-content';
      content.contentEditable = 'true';
      content.spellcheck = true;
      content.innerHTML = _edSanitize(page.content || '<p><br></p>');
      content.style.padding = pxT + 'px ' + pxR + 'px ' + pxB + 'px ' + pxL + 'px';
      content.setAttribute('data-page-idx', idx);
      pageEl.appendChild(content);

      // Annotation SVG layer
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ed-page-ann');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      _edRenderAnnotationsSVG(svg, page.annotations || [], idx);
      pageEl.appendChild(svg);

      // Objects layer
      var objLayer = document.createElement('div');
      objLayer.className = 'ed-page-objs';
      (page.objects || []).forEach(function (obj) {
        objLayer.appendChild(_edBuildObjEl(obj, idx));
      });
      pageEl.appendChild(objLayer);

      // Page number
      var lbl = document.createElement('div');
      lbl.className = 'ed-page-num-lbl';
      lbl.textContent = idx + 1;
      wrap.appendChild(pageEl);
      wrap.appendChild(lbl);

      _edWirePageEvents(pageEl, content, svg, idx);
      return wrap;
    }

    var _edSavedRange = null;
    function _edSaveRange() {
      if (_ed.tool !== 'text') return;
      var sel = window.getSelection();
      _edSavedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    }
    function _edRestoreRange() {
      if (!_edSavedRange) return;
      // Cache locally — contentEl.focus() triggers the 'focus' event which
      // calls _edSaveRange() and overwrites _edSavedRange before addRange runs.
      var range = _edSavedRange;
      var contentEl = document.querySelector(
        '.ed-page-content[data-page-idx="' + _ed.pageIdx + '"]'
      );
      if (contentEl) contentEl.focus();
      var sel = window.getSelection();
      sel.removeAllRanges();
      try {
        sel.addRange(range);
      } catch (e) {}
    }

    function _edWirePageEvents(pageEl, content, svg, idx) {
      content.addEventListener('keyup', _edSaveRange);
      content.addEventListener('mouseup', _edSaveRange);
      content.addEventListener('focus', _edSaveRange);
      content.addEventListener('input', function () {
        if (_ed.doc && _ed.doc.pages[idx]) _ed.doc.pages[idx].content = content.innerHTML;
        _edUpdateWordCount();
        _edScheduleAutoSave();
      });
      svg.addEventListener('mousedown', function (e) {
        if (_ed.tool !== 'highlight') return;
        e.preventDefault();
        _edStartAnnotationDraw(svg, idx, e);
      });
      pageEl.addEventListener('click', function (e) {
        if (_ed.tool === 'comment') {
          var pageWrap = e.currentTarget;
          _edAddComment(idx, e, pageWrap);
        }
      });
      pageEl.addEventListener('mousedown', function (e) {
        if (_ed.tool === 'shape') {
          if (!e.target.closest('.ed-obj')) {
            e.preventDefault();
            _edStartShapeDraw(pageEl, idx, e);
          }
        }
        // Select page
        _ed.pageIdx = idx;
        _edUpdatePageNav();
      });
    }

    // ── Annotation drawing ────────────────────────────────────────────────────────

    function _edStartAnnotationDraw(svg, pageIdx, e) {
      var rect = svg.getBoundingClientRect();
      var x0 = e.clientX - rect.left,
        y0 = e.clientY - rect.top;
      var type = _ed.annType;
      var color = (document.getElementById('edAnnColor') || { value: '#fbbf24' }).value;
      var opacity =
        parseInt((document.getElementById('edAnnOpacity') || { value: 40 }).value) / 100;
      var strokeW = parseInt((document.getElementById('edPenWidth') || { value: 3 }).value);

      var el;
      if (type === 'pen') {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', color);
        el.setAttribute('stroke-width', strokeW);
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('opacity', opacity);
        el.setAttribute('points', x0 + ',' + y0);
      } else {
        el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        var h = type === 'highlight' ? 18 : type === 'strikethrough' ? 3 : 2;
        var yOff = type === 'strikethrough' ? y0 - 8 : y0;
        el.setAttribute('x', x0);
        el.setAttribute('y', yOff);
        el.setAttribute('width', 0);
        el.setAttribute('height', h);
        el.setAttribute('fill', color);
        el.setAttribute('opacity', opacity);
      }
      svg.appendChild(el);

      var drawing = {
        svg: svg,
        el: el,
        type: type,
        x0: x0,
        y0: y0,
        pageIdx: pageIdx,
        color: color,
        opacity: opacity,
        strokeW: strokeW,
        pts: [[x0, y0]]
      };

      function onMove(me) {
        var bx = me.clientX - rect.left,
          by = me.clientY - rect.top;
        if (type === 'pen') {
          drawing.pts.push([bx, by]);
          el.setAttribute(
            'points',
            drawing.pts
              .map(function (p) {
                return p[0] + ',' + p[1];
              })
              .join(' ')
          );
        } else {
          var x = Math.min(bx, x0),
            w = Math.abs(bx - x0);
          el.setAttribute('x', x);
          el.setAttribute('width', Math.max(w, 2));
        }
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        var page = _ed.doc.pages[pageIdx];
        var ann = { id: _edId(), type: type, color: color, opacity: opacity, pageIdx: pageIdx };
        if (type === 'pen') {
          ann.pts = drawing.pts;
          ann.strokeW = strokeW;
        } else {
          ann.x = parseFloat(el.getAttribute('x'));
          ann.y = parseFloat(el.getAttribute('y'));
          ann.w = parseFloat(el.getAttribute('width')) || 2;
          ann.h = parseFloat(el.getAttribute('height'));
        }
        _edPushUndo(); // save state BEFORE adding annotation so undo removes it
        page.annotations.push(ann);
        _edScheduleAutoSave();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    function _edRenderAnnotationsSVG(svg, annotations, pageIdx) {
      svg.innerHTML = '';
      (annotations || []).forEach(function (ann) {
        var el;
        if (ann.type === 'pen') {
          el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          el.setAttribute(
            'points',
            (ann.pts || [])
              .map(function (p) {
                return p[0] + ',' + p[1];
              })
              .join(' ')
          );
          el.setAttribute('fill', 'none');
          el.setAttribute('stroke', ann.color || '#fbbf24');
          el.setAttribute('stroke-width', ann.strokeW || 3);
          el.setAttribute('stroke-linecap', 'round');
          el.setAttribute('stroke-linejoin', 'round');
        } else {
          el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          el.setAttribute('x', ann.x || 0);
          el.setAttribute('y', ann.y || 0);
          el.setAttribute('width', ann.w || 2);
          el.setAttribute('height', ann.h || 18);
          el.setAttribute('fill', ann.color || '#fbbf24');
        }
        el.setAttribute('opacity', ann.opacity || 0.4);
        el.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          if (_ed.doc && _ed.doc.pages[pageIdx]) {
            _ed.doc.pages[pageIdx].annotations = _ed.doc.pages[pageIdx].annotations.filter(
              function (a) {
                return a.id !== ann.id;
              }
            );
            _edPushUndo();
            _edRenderAllPages();
          }
        });
        svg.appendChild(el);
      });
    }

    // ── Comments ──────────────────────────────────────────────────────────────────

    function _edAddComment(pageIdx, e, pageEl) {
      var tgt = e.target;
      if (tgt.closest('.ed-comment') || tgt.closest('.ed-obj')) return;
      var bRect = pageEl.getBoundingClientRect();
      var x = e.clientX - bRect.left,
        y = e.clientY - bRect.top;
      var text = prompt('Add comment:');
      if (!text) return;
      _edPushUndo();
      var ann = { id: _edId(), type: 'comment', x: x, y: y, text: text, color: '#fbbf24' };
      _ed.doc.pages[pageIdx].annotations.push(ann);
      _edScheduleAutoSave();
      _edRenderAllPages();
    }

    // ── Objects ───────────────────────────────────────────────────────────────────

    function _edBuildObjEl(obj, pageIdx) {
      var el = document.createElement('div');
      el.className = 'ed-obj';
      el.setAttribute('data-obj-id', obj.id);
      el.style.left = obj.x + 'px';
      el.style.top = obj.y + 'px';
      el.style.width = obj.w + 'px';
      el.style.height = obj.h + 'px';
      el.style.opacity = obj.opacity != null ? obj.opacity : 1;

      if (obj.type === 'image') {
        var img = document.createElement('img');
        img.src = obj.src;
        el.appendChild(img);
      } else {
        el.appendChild(_edBuildShapeSVG(obj));
      }

      el.addEventListener('mousedown', function (e) {
        if (_ed.tool !== 'select') return;
        e.stopPropagation();
        _edSelectObj(pageIdx, obj.id);
        _edStartObjDrag(el, obj, pageIdx, e);
      });
      return el;
    }

    function _edBuildShapeSVG(obj) {
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.overflow = 'visible';
      var fill = obj.fill || '#3b82f6',
        stroke = obj.stroke || '#1d4ed8',
        sw = obj.strokeW != null ? obj.strokeW : 2;

      if (obj.shapeType === 'rect') {
        var r = document.createElementNS(ns, 'rect');
        r.setAttribute('x', sw / 2);
        r.setAttribute('y', sw / 2);
        r.setAttribute('width', 'calc(100% - ' + sw + 'px)');
        r.setAttribute('height', 'calc(100% - ' + sw + 'px)');
        r.setAttribute('rx', 3);
        r.setAttribute('fill', fill);
        r.setAttribute('stroke', stroke);
        r.setAttribute('stroke-width', sw);
        svg.appendChild(r);
      } else if (obj.shapeType === 'circle') {
        var c = document.createElementNS(ns, 'ellipse');
        c.setAttribute('cx', '50%');
        c.setAttribute('cy', '50%');
        c.setAttribute('rx', '50%');
        c.setAttribute('ry', '50%');
        c.setAttribute('fill', fill);
        c.setAttribute('stroke', stroke);
        c.setAttribute('stroke-width', sw);
        svg.appendChild(c);
      } else if (obj.shapeType === 'line') {
        var l = document.createElementNS(ns, 'line');
        l.setAttribute('x1', 0);
        l.setAttribute('y1', obj.h / 2 || 0);
        l.setAttribute('x2', obj.w || 100);
        l.setAttribute('y2', obj.h / 2 || 0);
        l.setAttribute('stroke', stroke);
        l.setAttribute('stroke-width', Math.max(sw, 2));
        l.setAttribute('stroke-linecap', 'round');
        svg.appendChild(l);
      } else if (obj.shapeType === 'arrow') {
        var g = document.createElementNS(ns, 'g');
        var al = document.createElementNS(ns, 'line');
        al.setAttribute('x1', 0);
        al.setAttribute('y1', '50%');
        al.setAttribute('x2', '100%');
        al.setAttribute('y2', '50%');
        al.setAttribute('stroke', stroke);
        al.setAttribute('stroke-width', Math.max(sw, 2));
        g.appendChild(al);
        var poly = document.createElementNS(ns, 'polygon');
        var hw = obj.w || 100,
          hh = (obj.h || 20) / 2;
        poly.setAttribute(
          'points',
          hw - 12 + ',' + (hh - 7) + ' ' + hw + ',' + hh + ' ' + (hw - 12) + ',' + (hh + 7)
        );
        poly.setAttribute('fill', stroke);
        g.appendChild(poly);
        svg.appendChild(g);
      }
      return svg;
    }

    function _edSelectObj(pageIdx, objId) {
      document.querySelectorAll('.ed-obj.selected').forEach(function (el) {
        el.classList.remove('selected');
        _edRemoveHandles(el);
      });
      var pd = document.getElementById('edPropDoc');
      if (pd) pd.style.display = 'none';
      var po = document.getElementById('edPropObj');
      if (po) po.style.display = '';
      _ed.selObj = { pageIdx: pageIdx, id: objId };
      var obj = (_ed.doc.pages[pageIdx].objects || []).find(function (o) {
        return o.id === objId;
      });
      if (!obj) return;
      var el = document.querySelector('.ed-obj[data-obj-id="' + objId + '"]');
      if (el) {
        el.classList.add('selected');
        _edAddHandles(el, pageIdx, obj);
      }
      _edUpdateObjProps(obj);
    }

    function _edDeselectObj() {
      document.querySelectorAll('.ed-obj.selected').forEach(function (el) {
        el.classList.remove('selected');
        _edRemoveHandles(el);
      });
      _ed.selObj = null;
      var pd = document.getElementById('edPropDoc');
      if (pd) pd.style.display = '';
      var po = document.getElementById('edPropObj');
      if (po) po.style.display = 'none';
    }

    function _edAddHandles(el, pageIdx, obj) {
      ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (dir) {
        var h = document.createElement('div');
        h.className = 'ed-resize-handle ed-h-' + dir;
        h.setAttribute('data-dir', dir);
        el.appendChild(h);
        h.addEventListener('mousedown', function (e) {
          e.stopPropagation();
          e.preventDefault();
          _edStartResize(el, obj, pageIdx, dir, e);
        });
      });
    }
    function _edRemoveHandles(el) {
      el.querySelectorAll('.ed-resize-handle').forEach(function (h) {
        h.remove();
      });
    }

    function _edUpdateObjProps(obj) {
      var f = function (id, v) {
        var el = document.getElementById(id);
        if (el) el.value = Math.round(v);
      };
      f('edObjX', obj.x);
      f('edObjY', obj.y);
      f('edObjW', obj.w);
      f('edObjH', obj.h);
      var op = document.getElementById('edObjOpacity');
      if (op) op.value = Math.round((obj.opacity != null ? obj.opacity : 1) * 100);
      var ov = document.getElementById('edObjOpacityVal');
      if (ov) ov.textContent = Math.round((obj.opacity != null ? obj.opacity : 1) * 100) + '%';
      // Sync color pickers to selected object
      if (obj.type === 'shape') {
        var sf = document.getElementById('edShapeFill');
        if (sf && obj.fill) sf.value = obj.fill;
        var ss = document.getElementById('edShapeStroke');
        if (ss && obj.stroke) ss.value = obj.stroke;
      } else if (obj.type !== 'image') {
        var ac = document.getElementById('edAnnColor');
        if (ac && obj.color) ac.value = obj.color;
      }
    }

    // ── Drag objects ──────────────────────────────────────────────────────────────

    function _edStartObjDrag(el, obj, pageIdx, e) {
      var startX = e.clientX,
        startY = e.clientY,
        origX = obj.x,
        origY = obj.y;
      var snap = _ed.doc && _ed.doc.settings.snapGrid ? 20 : 1;
      _edPushUndo();
      function onMove(me) {
        var scale = _ed.zoom / 100;
        var nx = Math.round((origX + (me.clientX - startX) / scale) / snap) * snap;
        var ny = Math.round((origY + (me.clientY - startY) / scale) / snap) * snap;
        obj.x = nx;
        obj.y = ny;
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
        _edUpdateObjProps(obj);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _edScheduleAutoSave();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    function _edStartResize(el, obj, pageIdx, dir, e) {
      var startX = e.clientX,
        startY = e.clientY,
        ox = obj.x,
        oy = obj.y,
        ow = obj.w,
        oh = obj.h;
      _edPushUndo();
      function onMove(me) {
        var scale = _ed.zoom / 100;
        var dx = (me.clientX - startX) / scale,
          dy = (me.clientY - startY) / scale;
        var nx = ox,
          ny = oy,
          nw = ow,
          nh = oh;
        if (dir.includes('e')) nw = Math.max(20, ow + dx);
        if (dir.includes('s')) nh = Math.max(20, oh + dy);
        if (dir.includes('w')) {
          nx = ox + dx;
          nw = Math.max(20, ow - dx);
        }
        if (dir.includes('n')) {
          ny = oy + dy;
          nh = Math.max(20, oh - dy);
        }
        obj.x = nx;
        obj.y = ny;
        obj.w = nw;
        obj.h = nh;
        el.style.left = nx + 'px';
        el.style.top = ny + 'px';
        el.style.width = nw + 'px';
        el.style.height = nh + 'px';
        _edUpdateObjProps(obj);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _edScheduleAutoSave();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    // ── Shape drawing ─────────────────────────────────────────────────────────────

    function _edStartShapeDraw(pageEl, pageIdx, e) {
      var rect = pageEl.getBoundingClientRect();
      var x0 = e.clientX - rect.left,
        y0 = e.clientY - rect.top;
      var fill = (document.getElementById('edShapeFill') || { value: '#3b82f6' }).value;
      var stroke = (document.getElementById('edShapeStroke') || { value: '#1d4ed8' }).value;
      var strokeW = parseInt((document.getElementById('edShapeStrokeW') || { value: 2 }).value);
      var opacity =
        parseInt((document.getElementById('edShapeOpacity') || { value: 80 }).value) / 100;
      _edPushUndo();
      var obj = {
        id: _edId(),
        type: 'shape',
        shapeType: _ed.shapeType,
        x: x0,
        y: y0,
        w: 4,
        h: 4,
        fill: fill,
        stroke: stroke,
        strokeW: strokeW,
        opacity: opacity
      };
      _ed.doc.pages[pageIdx].objects.push(obj);
      _edRenderAllPages();
      var el = document.querySelector('.ed-obj[data-obj-id="' + obj.id + '"]');

      function onMove(me) {
        var nx = me.clientX - rect.left,
          ny = me.clientY - rect.top;
        var nw = Math.max(4, Math.abs(nx - x0)),
          nh = Math.max(4, Math.abs(ny - y0));
        var ox = nx < x0 ? nx : x0,
          oy = ny < y0 ? ny : y0;
        obj.x = ox;
        obj.y = oy;
        obj.w = nw;
        obj.h = nh;
        if (el) {
          el.style.left = ox + 'px';
          el.style.top = oy + 'px';
          el.style.width = nw + 'px';
          el.style.height = nh + 'px';
        }
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (obj.w < 10 && obj.h < 10) {
          obj.w = 120;
          obj.h = 80;
          if (el) {
            el.style.width = '120px';
            el.style.height = '80px';
          }
        }
        _edScheduleAutoSave();
        _edUpdateThumbs();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    // ── Image insertion ───────────────────────────────────────────────────────────

    function _edInsertImage(file, pageIdx) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        var img = new Image();
        img.onload = function () {
          var maxW = 400,
            maxH = 300,
            w = img.width,
            h = img.height;
          if (w > maxW) {
            h = (h * maxW) / w;
            w = maxW;
          }
          if (h > maxH) {
            w = (w * maxH) / h;
            h = maxH;
          }
          _edPushUndo();
          var obj = {
            id: _edId(),
            type: 'image',
            src: ev.target.result,
            x: 50,
            y: 50,
            w: Math.round(w),
            h: Math.round(h),
            opacity: 1
          };
          _ed.doc.pages[pageIdx].objects.push(obj);
          _edSetTool('select'); // switch before render so pages get data-tool="select" and objects layer is interactive
          _edScheduleAutoSave();
          _edRenderAllPages();
          _edUpdateThumbs();
          _edSelectObj(pageIdx, obj.id);
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    }

    // ── Page management ───────────────────────────────────────────────────────────

    function _edAddPageAfter(afterIdx) {
      if (!_ed.doc) return;
      _edPushUndo();
      _ed.doc.pages.splice(afterIdx + 1, 0, _edNewPage());
      _ed.pageIdx = afterIdx + 1;
      _edScheduleAutoSave();
      _edRenderAllPages();
      _edUpdateThumbs();
      _edUpdatePageNav();
    }

    function _edDeleteCurrentPage() {
      if (!_ed.doc || _ed.doc.pages.length <= 1) {
        showToast('Cannot delete', 'A document must have at least one page');
        return;
      }
      if (!confirm('Delete page ' + (_ed.pageIdx + 1) + '?')) return;
      _edPushUndo();
      _ed.doc.pages.splice(_ed.pageIdx, 1);
      _ed.pageIdx = Math.min(_ed.pageIdx, _ed.doc.pages.length - 1);
      _edScheduleAutoSave();
      _edRenderAllPages();
      _edUpdateThumbs();
      _edUpdatePageNav();
    }

    function _edDuplicatePage(idx) {
      if (!_ed.doc) return;
      _edPushUndo();
      var copy = _edClone(_ed.doc.pages[idx]);
      copy.id = _edPageId();
      copy.objects.forEach(function (o) {
        o.id = _edId();
      });
      copy.annotations.forEach(function (a) {
        a.id = _edId();
      });
      _ed.doc.pages.splice(idx + 1, 0, copy);
      _ed.pageIdx = idx + 1;
      _edScheduleAutoSave();
      _edRenderAllPages();
      _edUpdateThumbs();
      _edUpdatePageNav();
    }

    function _edGoToPage(idx, noScroll) {
      if (!_ed.doc) return;
      idx = Math.max(0, Math.min(idx, _ed.doc.pages.length - 1));
      _ed.pageIdx = idx;
      document.querySelectorAll('.ed-page').forEach(function (p, i) {
        p.classList.toggle('active', i === idx);
      });
      if (!noScroll) {
        var wraps = document.querySelectorAll('.ed-page-wrap');
        if (wraps[idx]) wraps[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      _edUpdatePageNav();
      _edUpdateThumbs();
    }

    function _edUpdateThumbs() {
      var list = document.getElementById('editorPagesList');
      if (!list || !_ed.doc) return;
      list.innerHTML = _ed.doc.pages
        .map(function (page, idx) {
          return (
            '<div class="editor-page-thumb' +
            (idx === _ed.pageIdx ? ' active' : '') +
            '" data-thumb-idx="' +
            idx +
            '">' +
            '<div class="editor-page-thumb-preview"><div class="editor-page-thumb-lines">' +
            '<div class="editor-page-thumb-line wide" style="background:#bbb;height:4px;margin-bottom:4px"></div>' +
            '<div class="editor-page-thumb-line wide"></div><div class="editor-page-thumb-line mid"></div>' +
            '<div class="editor-page-thumb-line wide"></div><div class="editor-page-thumb-line short"></div>' +
            '<div class="editor-page-thumb-line mid"></div></div></div>' +
            '<div class="editor-page-thumb-actions">' +
            '<button class="ed-thumb-btn" data-action="dup" data-idx="' +
            idx +
            '" title="Duplicate">&#x2398;</button>' +
            '<button class="ed-thumb-btn" data-action="del" data-idx="' +
            idx +
            '" title="Delete">&#x2715;</button>' +
            '</div>' +
            '<div class="editor-page-thumb-num">' +
            (idx + 1) +
            '</div></div>'
          );
        })
        .join('');
      list.querySelectorAll('.editor-page-thumb').forEach(function (el) {
        el.addEventListener('click', function (e) {
          if (e.target.closest('.ed-thumb-btn')) return;
          _edGoToPage(parseInt(el.getAttribute('data-thumb-idx')));
        });
      });
      list.querySelectorAll('.ed-thumb-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var idx = parseInt(btn.getAttribute('data-idx'));
          var action = btn.getAttribute('data-action');
          if (action === 'dup') _edDuplicatePage(idx);
          else if (action === 'del') {
            _ed.pageIdx = idx;
            _edDeleteCurrentPage();
          }
        });
      });
    }

    function _edUpdatePageNav() {
      var total = _ed.doc ? _ed.doc.pages.length : 0,
        cur = _ed.pageIdx + 1;
      var numEl = document.getElementById('edPageNum');
      if (numEl) {
        numEl.value = cur;
        numEl.max = total;
      }
      var totEl = document.getElementById('edPageTotal');
      if (totEl) totEl.textContent = total;
      ['edFirstPage', 'edPrevPage'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.disabled = cur <= 1;
      });
      ['edNextPage', 'edLastPage'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.disabled = cur >= total;
      });
    }

    // ── Word count ────────────────────────────────────────────────────────────────

    function _edUpdateWordCount() {
      if (!_ed.doc) return;
      var contentEl = document.querySelector(
        '.ed-page[data-page-idx="' + _ed.pageIdx + '"] .ed-page-content'
      );
      var text = contentEl
        ? contentEl.innerText || ''
        : ((_ed.doc.pages[_ed.pageIdx] && _ed.doc.pages[_ed.pageIdx].content) || '').replace(
            /<[^>]*>/g,
            ''
          );
      var words = text.trim() ? text.trim().split(/\s+/).length : 0;
      var wc = document.getElementById('editorWordCount');
      if (wc) wc.textContent = words + ' word' + (words !== 1 ? 's' : '') + ' · Ctrl+S to save';
    }

    // ── Zoom ──────────────────────────────────────────────────────────────────────

    function _edApplyZoom() {
      var z = (_ed.zoom / 100).toString();
      // Apply zoom to each page-wrap so the scroll container itself is never scaled
      // (scaling the scroll container clips overflow instead of adding scrollbars)
      document.querySelectorAll('.ed-page-wrap').forEach(function (w) {
        w.style.zoom = z;
      });
      var lbl = document.getElementById('edZoomLabel');
      if (lbl) lbl.textContent = _ed.zoom + '%';
    }

    // ── Toolbar state (B/I/U active) ──────────────────────────────────────────────

    function _edSelectionInEditor() {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return false;
      var node = sel.getRangeAt(0).startContainer;
      var el = node.nodeType === 3 ? node.parentElement : node;
      return !!(el && el.closest('.ed-page-content'));
    }

    function _edForceUpdateToolbarState() {
      if (_ed.tool !== 'text') return;
      var toolbar = document.getElementById('editorToolbar');
      if (!toolbar) return;
      [
        'bold',
        'italic',
        'underline',
        'strikeThrough',
        'insertUnorderedList',
        'insertOrderedList',
        'justifyLeft',
        'justifyCenter',
        'justifyRight'
      ].forEach(function (cmd) {
        var btn = toolbar.querySelector('[data-cmd="' + cmd + '"]');
        if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
      });
    }

    function _edUpdateTextToolbarState() {
      if (_ed.tool !== 'text') return;
      // Only update when the selection is actually inside the editor — this prevents
      // clicking on the canvas/scrollbar from resetting B/I/U active state
      if (!_edSelectionInEditor()) return;
      _edForceUpdateToolbarState();
    }

    // ── Open / Save / Auto-save ───────────────────────────────────────────────────

    function _edNormalizeDoc(doc) {
      if (!doc) return doc;
      if (!doc.settings) doc.settings = {};
      var s = doc.settings;
      if (!s.size) s.size = 'a4';
      if (!s.orientation) s.orientation = 'portrait';
      if (!s.margins) s.margins = { top: 20, bottom: 20, left: 20, right: 20 };
      if (s.bgColor == null) s.bgColor = '#ffffff';
      if (s.showGrid == null) s.showGrid = false;
      if (s.snapGrid == null) s.snapGrid = false;
      if (!Array.isArray(doc.pages)) doc.pages = [_edNewPage()];
      doc.pages.forEach(function (p) {
        if (!Array.isArray(p.objects)) p.objects = [];
        if (!Array.isArray(p.annotations)) p.annotations = [];
      });
      return doc;
    }

    function _edOpenDocById(id) {
      var docs = _edLoadDocs(),
        doc = docs.find(function (d) {
          return d.id === id;
        });
      if (!doc) return;
      _edNormalizeDoc(doc);
      _ed.doc = doc;
      _ed.pageIdx = 0;
      _ed.undoStack = [];
      _ed.redoStack = [];
      _ed.selObj = null;
      _edUpdateUndoRedoBtns();
      _edSetDocActive(true);
      _edApplySettingsToUI();
      var titleIn = document.getElementById('editorTitleInput');
      if (titleIn) {
        titleIn.value = doc.title || '';
        titleIn.disabled = true;
      }
      var cs = document.getElementById('editorCanvasScroll');
      if (cs) cs.style.display = '';
      var es = document.getElementById('editorEmptyState');
      if (es) es.style.display = 'none';
      _edRenderAllPages();
      _edUpdateThumbs();
      _edUpdatePageNav();
      _edUpdateWordCount();
      _edRenderDocList();
      // Show object props panel default state
      var pd = document.getElementById('edPropDoc');
      if (pd) pd.style.display = '';
      var po = document.getElementById('edPropObj');
      if (po) po.style.display = 'none';
    }

    function _edApplySettingsToUI() {
      if (!_ed.doc) return;
      var s = _ed.doc.settings;
      var ps = document.getElementById('edPageSize');
      if (ps) ps.value = s.size;
      var po = document.getElementById('edOrientPortrait');
      var lo = document.getElementById('edOrientLandscape');
      if (po) po.classList.toggle('active', s.orientation !== 'landscape');
      if (lo) lo.classList.toggle('active', s.orientation === 'landscape');
      var mt = document.getElementById('edMarginTop');
      if (mt) mt.value = s.margins.top;
      var mb = document.getElementById('edMarginBottom');
      if (mb) mb.value = s.margins.bottom;
      var ml = document.getElementById('edMarginLeft');
      if (ml) ml.value = s.margins.left;
      var mr = document.getElementById('edMarginRight');
      if (mr) mr.value = s.margins.right;
      var bg = document.getElementById('edBgColor');
      if (bg) bg.value = s.bgColor;
      var sg = document.getElementById('edShowGrid');
      if (sg) sg.checked = s.showGrid;
      var sng = document.getElementById('edSnapGrid');
      if (sng) sng.checked = s.snapGrid;
    }

    async function _edSaveDoc() {
      if (!_ed.doc) return;
      document.querySelectorAll('.ed-page-content').forEach(function (el) {
        var idx = parseInt(el.getAttribute('data-page-idx'));
        if (_ed.doc.pages[idx]) _ed.doc.pages[idx].content = el.innerHTML;
      });
      var titleIn = document.getElementById('editorTitleInput');
      _ed.doc.title = (titleIn && titleIn.value.trim()) || 'Untitled';
      _ed.doc.updated = Date.now();
      var docs = _edLoadDocs(),
        idx = docs.findIndex(function (d) {
          return d.id === _ed.doc.id;
        });
      if (idx !== -1) docs[idx] = _ed.doc;
      else docs.unshift(_ed.doc);
      _edSaveDocs(docs);
      _ed.dirty = false;
      var badge = document.getElementById('editorSaveBadge');
      if (badge) {
        badge.style.display = 'flex';
        clearTimeout(badge._t);
      }
      try {
        await _edSaveToSupabase(_ed.doc);
      } finally {
        if (badge) {
          badge._t = setTimeout(function () {
            badge.style.display = 'none';
          }, 3000);
        }
      }
    }

    function _edScheduleAutoSave() {
      _ed.dirty = true;
      clearTimeout(_ed.autoTimer);
      _ed.autoTimer = setTimeout(_edSaveDoc, 3000);
    }

    function _edCreateNewDoc() {
      if (_ed.doc && _ed.dirty) _edSaveDoc();
      var doc = _edNewDocObj(),
        docs = _edLoadDocs();
      docs.unshift(doc);
      _edSaveDocs(docs);
      _edOpenDocById(doc.id);
      var titleIn = document.getElementById('editorTitleInput');
      if (titleIn) {
        titleIn.disabled = false;
        titleIn.focus();
        titleIn.select();
      }
    }

    function _edDuplicateDoc() {
      if (!_ed.doc) return;
      _edSaveDoc();
      var copy = _edClone(_ed.doc);
      copy.id = _edId();
      copy.title = (_ed.doc.title || 'Untitled') + ' (Copy)';
      copy.updated = Date.now();
      copy.pages.forEach(function (p) {
        p.id = _edPageId();
        p.objects.forEach(function (o) {
          o.id = _edId();
        });
        p.annotations.forEach(function (a) {
          a.id = _edId();
        });
      });
      var docs = _edLoadDocs();
      docs.unshift(copy);
      _edSaveDocs(docs);
      _edOpenDocById(copy.id);
    }

    function _edDeleteDoc() {
      if (!_ed.doc) return;
      if (!confirm('Delete "' + (_ed.doc.title || 'Untitled') + '"?')) return;
      var deletedId = _ed.doc.id;
      var docs = _edLoadDocs().filter(function (d) {
        return d.id !== deletedId;
      });
      _edSaveDocs(docs);
      _edDeleteFromSupabase(deletedId); // cloud sync
      _ed.doc = null;
      _ed.pageIdx = 0;
      _ed.undoStack = [];
      _ed.redoStack = [];
      _edUpdateUndoRedoBtns();
      _edSetDocActive(false);
      _edDeselectObj();
      var cs = document.getElementById('editorCanvasScroll');
      if (cs) cs.style.display = 'none';
      var es = document.getElementById('editorEmptyState');
      if (es) es.style.display = '';
      var pl = document.getElementById('editorPagesList');
      if (pl) pl.innerHTML = '<div class="editor-pages-empty">No pages yet</div>';
      var pt = document.getElementById('edPageTotal');
      if (pt) pt.textContent = '0';
      var titleIn = document.getElementById('editorTitleInput');
      if (titleIn) {
        titleIn.value = '';
        titleIn.disabled = true;
      }
      _edRenderDocList();
    }

    // Shared PDF blob generator used by both Download and Export-to-Course.
    // The content element sits inside a 1×1 clipped wrapper so it renders
    // at full width for html2canvas but is invisible to the user.
    function _edGeneratePdfBlob() {
      return new Promise(function (resolve, reject) {
        if (!_ed.doc) {
          reject(new Error('No document'));
          return;
        }
        _edSaveDoc();

        function build() {
          var title = _ed.doc.title || 'Untitled';
          var safeTitle = title.replace(/[/\\?%*:|"<>]/g, '_');

          // Sync content from live DOM before rendering
          document.querySelectorAll('.ed-page-content').forEach(function (domEl) {
            var idx = parseInt(domEl.getAttribute('data-page-idx'));
            if (_ed.doc.pages[idx]) _ed.doc.pages[idx].content = domEl.innerHTML;
          });

          var dims = _edGetPageDims();
          var settings = (_ed.doc && _ed.doc.settings) || {};
          var margins = settings.margins || { top: 20, bottom: 20, left: 20, right: 20 };
          var orientation = settings.orientation === 'landscape' ? 'landscape' : 'portrait';
          var pageStyle =
            'box-sizing:border-box;width:' +
            dims.w +
            'px;min-height:' +
            dims.h +
            'px;padding:' +
            margins.top +
            'px ' +
            margins.right +
            'px ' +
            margins.bottom +
            'px ' +
            margins.left +
            'px;color:#111;font-family:Georgia,serif;font-size:13pt;line-height:1.8;page-break-after:always;background:#fff;';
          var inner = document.createElement('div');
          inner.style.cssText =
            'width:' +
            dims.w +
            'px;background:#fff;color:#111;font-family:Georgia,serif;font-size:13pt;line-height:1.8;';
          inner.innerHTML =
            '<div style="padding:' +
            margins.top +
            'px ' +
            margins.right +
            'px 24px ' +
            margins.left +
            'px;color:#111"><h1 style="font-size:24pt;font-weight:700;color:#111;margin:0">' +
            title +
            '</h1></div>' +
            _ed.doc.pages
              .map(function (p) {
                return '<div style="' + pageStyle + '">' + (p.content || '<p></p>') + '</div>';
              })
              .join('');

          // Clip wrapper: 1×1 px, so it's invisible but html2canvas can still
          // read the element's computed styles and render it at full width.
          var clip = document.createElement('div');
          clip.style.cssText =
            'position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden;z-index:0;';
          clip.appendChild(inner);
          document.body.appendChild(clip);

          html2pdf()
            .set({
              margin: 0,
              filename: safeTitle + '.pdf',
              image: { type: 'jpeg', quality: 0.97 },
              html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
              jsPDF: {
                unit: 'mm',
                format: [_edPxToMm(dims.w), _edPxToMm(dims.h)],
                orientation: orientation
              }
            })
            .from(inner)
            .output('blob')
            .then(function (blob) {
              document.body.removeChild(clip);
              resolve({ blob: blob, title: title, safeTitle: safeTitle });
            })
            .catch(function (err) {
              if (document.body.contains(clip)) document.body.removeChild(clip);
              reject(err);
            });
        }

        if (typeof html2pdf !== 'undefined') {
          build();
        } else {
          var s = document.createElement('script');
          s.src =
            'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
          s.integrity =
            'sha384-Yv5O+t3uE3hunW8uyrbpPW3iw6/5/Y7HitWJBLgqfMoA36NogMmy+8wWZMpn3HWc';
          s.crossOrigin = 'anonymous';
          s.onload = build;
          s.onerror = function () {
            reject(new Error('Could not load PDF library — check your connection'));
          };
          document.head.appendChild(s);
        }
      });
    }

    // Save a PDF blob to disk. Uses the File System Access API
    // (showSaveFilePicker) when available — that lets the user pick the
    // folder and filename themselves. Falls back to a hidden <a download>
    // for browsers without the API (Firefox, Safari, older Chromium).
    async function _edSavePdfBlobToDisk(blob, safeTitle) {
      var fileName = safeTitle + '.pdf';
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          var handle = await window.showSaveFilePicker({
            suggestedName: fileName,
            types: [{
              description: 'PDF document',
              accept: { 'application/pdf': ['.pdf'] }
            }]
          });
          var writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return true;
        } catch (e) {
          // User aborted the picker — treat as a cancel, not an error
          if (e && (e.name === 'AbortError' || /aborted|user/i.test(e.message || ''))) return false;
          // Any other failure (permissions, unsupported) falls through to <a download>
        }
      }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      return true;
    }

    function _edExportPdf() {
      if (!_ed.doc) return;
      var btn = document.getElementById('edExportPdfBtn');
      if (btn) {
        btn.textContent = 'Generating…';
        btn.disabled = true;
      }

      _edGeneratePdfBlob()
        .then(function (r) {
          return _edSavePdfBlobToDisk(r.blob, r.safeTitle).then(function (saved) {
            if (saved) showToast('Saved', r.safeTitle + '.pdf');
          });
        })
        .catch(function (err) {
          showToast('Export failed', err.message || 'Could not generate PDF');
        })
        .finally(function () {
          if (btn) {
            btn.innerHTML =
              '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Download as PDF';
            btn.disabled = false;
          }
        });
    }

    function _edOpenExportCourseModal() {
      if (!_ed.doc) return;
      var overlay = document.getElementById('edCourseModalOverlay');
      var courseSel = document.getElementById('edExportCourseSelect');
      var folderSel = document.getElementById('edExportFolderSelect');
      if (!overlay || !courseSel || !folderSel) return;

      // Populate courses from active semester
      var sem = SEMS && activeSemId && SEMS[activeSemId];
      var courses = (sem && sem.courses) || [];
      function setOptions(selectEl, options, emptyLabel) {
        if (!selectEl) return;
        selectEl.replaceChildren();
        if (!options.length) {
          var emptyOpt = document.createElement('option');
          emptyOpt.value = '';
          emptyOpt.textContent = emptyLabel;
          selectEl.appendChild(emptyOpt);
          return;
        }
        options.forEach(function (opt) {
          var optionEl = document.createElement('option');
          optionEl.value = opt.value;
          optionEl.textContent = opt.label;
          selectEl.appendChild(optionEl);
        });
      }

      setOptions(
        courseSel,
        courses.map(function (c) {
          return { value: c.id, label: c.name || c.id };
        }),
        'No courses available'
      );

      // Populate folders when course changes
      function populateFolders() {
        var uid = _currentUser && (_currentUser.id || _currentUser.sub);
        var courseId = courseSel.value;
        var course = courses.find(function (c) {
          return c.id === courseId;
        });
        var folders = course && uid ? _ufGetFolders(uid, course) : [];
        setOptions(
          folderSel,
          [{ value: '', label: 'Root (no folder)' }].concat(
            folders.map(function (f) {
              return { value: f, label: f };
            })
          ),
          'Root (no folder)'
        );
      }
      courseSel.addEventListener('change', populateFolders);
      populateFolders();

      overlay.style.display = 'flex';

      // Wire confirm/cancel
      var confirmBtn = document.getElementById('edCourseModalConfirm');
      var cancelBtn = document.getElementById('edCourseModalCancel');
      var closeBtn = document.getElementById('edCourseModalClose');

      function closeModal() {
        overlay.style.display = 'none';
      }

      cancelBtn && (cancelBtn.onclick = closeModal);
      closeBtn && (closeBtn.onclick = closeModal);
      overlay.onclick = function (e) {
        if (e.target === overlay) closeModal();
      };

      if (confirmBtn) {
        confirmBtn.onclick = function () {
          var courseId = courseSel.value;
          var folder = folderSel.value || null;
          var course = courses.find(function (c) {
            return c.id === courseId;
          });
          if (!course) {
            showToast('No course selected', 'Please pick a course first');
            return;
          }
          confirmBtn.disabled = true;
          confirmBtn.textContent = 'Exporting…';
          _edDoExportToCourse(course, folder)
            .then(function () {
              closeModal();
              showToast(
                'Exported',
                (_ed.doc.title || 'Document') +
                  ' saved to ' +
                  course.name +
                  (folder ? ' / ' + folder : '')
              );
            })
            .catch(function (err) {
              showToast('Export failed', err.message || 'Could not upload file');
            })
            .finally(function () {
              confirmBtn.disabled = false;
              confirmBtn.innerHTML =
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export';
            });
        };
      }
    }

    async function _edDoExportToCourse(course, folder) {
      var uid = _currentUser && (_currentUser.id || _currentUser.sub);
      if (!uid) throw new Error('Not signed in');

      var r = await _edGeneratePdfBlob();
      var filename = r.safeTitle + '.pdf';
      var fileObj = new File([r.blob], filename, { type: 'application/pdf' });

      await _ufUpload(uid, course, fileObj, null, folder || null);

      if (!course.files) course.files = [];
      var exists = course.files.findIndex(function (f) {
        return f.name === filename;
      });
      var entry = {
        name: filename,
        type: 'file',
        size: r.blob.size,
        _uploaded: true,
        _folder: folder || null
      };
      if (exists !== -1) course.files[exists] = entry;
      else course.files.unshift(entry);
    }

    function _edImportPdf(file) {
      var reader = new FileReader();
      reader.onload = function (ev) {
        (window._ssEnsurePdfJs ? window._ssEnsurePdfJs() : Promise.resolve())
          .then(function () {
            return pdfjsLib.getDocument({ data: ev.target.result }).promise.then(function (pdf) {
              var promises = [];
              for (var i = 1; i <= pdf.numPages; i++) {
                promises.push(
                  (function (pageNum) {
                    return pdf.getPage(pageNum).then(function (page) {
                      var vp = page.getViewport({ scale: 1.0 }),
                        canvas = document.createElement('canvas');
                      canvas.width = vp.width;
                      canvas.height = vp.height;
                      return page
                        .render({ canvasContext: canvas.getContext('2d'), viewport: vp })
                        .promise.then(function () {
                          return { src: canvas.toDataURL(), w: vp.width, h: vp.height };
                        });
                    });
                  })(i)
                );
              }
              return Promise.all(promises);
            });
          })
          .then(function (pages) {
            if (_ed.doc && _ed.dirty) _edSaveDoc();
            var doc = _edNewDocObj();
            doc.title = file.name.replace(/\.pdf$/i, '');
            doc.pages = pages.map(function (p) {
              var pg = _edNewPage('');
              var w = Math.min(p.w, 794);
              pg.objects = [
                {
                  id: _edId(),
                  type: 'image',
                  src: p.src,
                  x: 0,
                  y: 0,
                  w: w,
                  h: Math.round((w * p.h) / p.w),
                  opacity: 1
                }
              ];
              return pg;
            });
            var docs = _edLoadDocs();
            docs.unshift(doc);
            _edSaveDocs(docs);
            _edOpenDocById(doc.id);
            showToast('PDF imported', doc.title + ' (' + pages.length + ' pages)');
          })
          .catch(function (err) {
            showToast('Import failed', err.message || 'Could not read PDF');
          });
      };
      reader.readAsArrayBuffer(file);
    }

    // ── Keyboard shortcuts ────────────────────────────────────────────────────────

    function _edHandleKeyboard(e) {
      if (!_ed.doc) return;
      var tag = (e.target.tagName || '').toLowerCase();
      var inInput = tag === 'input' || tag === 'textarea' || e.target.contentEditable === 'true';
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        _edSaveDoc();
        return;
      }
      // When focus is inside text, let the browser handle undo/redo natively so typed text is reverted correctly.
      // The 'input' event syncs content back to the data model after each browser undo/redo.
      if (
        inInput &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'z' || e.key === 'y' || (e.shiftKey && e.key === 'Z'))
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        _edUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        _edRedo();
        return;
      }
      if (inInput) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && _ed.selObj) {
        var obj = (_ed.doc.pages[_ed.selObj.pageIdx].objects || []).find(function (o) {
          return o.id === _ed.selObj.id;
        });
        if (obj) _ed.clipboard = _edClone(obj);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && _ed.clipboard && _ed.doc) {
        _edPushUndo();
        var paste = _edClone(_ed.clipboard);
        paste.id = _edId();
        paste.x += 20;
        paste.y += 20;
        _ed.doc.pages[_ed.pageIdx].objects.push(paste);
        _edRenderAllPages();
        _edSelectObj(_ed.pageIdx, paste.id);
        _edScheduleAutoSave();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && _ed.selObj) {
        e.preventDefault();
        _edPushUndo();
        var pg = _ed.doc.pages[_ed.selObj.pageIdx];
        pg.objects = (pg.objects || []).filter(function (o) {
          return o.id !== _ed.selObj.id;
        });
        _edDeselectObj();
        _edRenderAllPages();
        _edScheduleAutoSave();
      }
      if (e.key === 'Escape') _edDeselectObj();
      // Keyboard shortcuts for tools
      if (!inInput) {
        if (e.key === 'v' || e.key === 'V') _edSetTool('select');
        if (e.key === 't' || e.key === 'T') _edSetTool('text');
        if (e.key === 'h' || e.key === 'H') _edSetTool('highlight');
        if (e.key === 'c' && !e.ctrlKey && !e.metaKey) _edSetTool('comment');
        if (e.key === 's' && !e.ctrlKey && !e.metaKey) _edSetTool('shape');
        if (e.key === 'i' && !e.ctrlKey && !e.metaKey) _edSetTool('image');
      }
    }

    // ── Init ──────────────────────────────────────────────────────────────────────

    function _writerInit() {
      // When nav opens editor, always land on hub unless user navigated directly to writer
      var hub = document.getElementById('editorHub');
      var writer = document.querySelector('#psec-editor .editor-card');
      if (hub && writer && !hub._edSkipHub) {
        hub.style.display = 'flex';
        writer.style.display = 'none';
        var pdfEd = document.getElementById('editorPdfEditorView');
        var pdfMg = document.getElementById('editorPdfMergerView');
        if (pdfEd) pdfEd.style.display = 'none';
        if (pdfMg) pdfMg.style.display = 'none';
      }
      if (hub) hub._edSkipHub = false;

      // Wire New buttons (safe to call multiple times)
      ['editorNewBtn', 'editorEmptyNewBtn'].forEach(function (id) {
        var btn = document.getElementById(id);
        if (btn && !btn._edWired) {
          btn._edWired = true;
          btn.addEventListener('click', _edCreateNewDoc);
        }
      });

      if (_editorInited) {
        _edRenderDocList();
        if (_ed.doc) {
          _edUpdateThumbs();
          _edUpdatePageNav();
        }
        // Refresh from cloud in background on revisit
        _edLoadFromSupabase().then(function (dbDocs) {
          if (!dbDocs.length) return;
          var local = _edLoadDocs();
          var merged = dbDocs.slice();
          local.forEach(function (d) {
            if (
              !merged.find(function (m) {
                return m.id === d.id;
              })
            )
              merged.push(d);
          });
          merged.sort(function (a, b) {
            return b.updated - a.updated;
          });
          _edSaveDocs(merged);
          _edRenderDocList();
        });
        return;
      }
      _editorInited = true;

      // Title
      var titleIn = document.getElementById('editorTitleInput');
      var editIcon = document.getElementById('editorTitleEditIcon');
      editIcon &&
        editIcon.addEventListener('click', function () {
          if (titleIn) {
            titleIn.disabled = false;
            titleIn.focus();
            titleIn.select();
          }
        });
      titleIn &&
        titleIn.addEventListener('blur', function () {
          titleIn.disabled = true;
          if (_ed.doc) {
            _ed.doc.title = titleIn.value || 'Untitled';
            _edScheduleAutoSave();
          }
        });
      titleIn &&
        titleIn.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') titleIn.blur();
        });

      // Top buttons
      var _wire = function (id, fn) {
        var el = document.getElementById(id);
        el && el.addEventListener('click', fn);
      };
      _wire('editorBackBtn', _edGoHome);
      // Back button: if a doc is open go to writer doc-list; if already on doc-list go to hub
      var _hubBackBtn = document.getElementById('editorHubBackBtn');
      if (_hubBackBtn) {
        _hubBackBtn.addEventListener('click', function () {
          var cs = document.getElementById('editorCanvasScroll');
          var docOpen = cs && cs.style.display !== 'none';
          if (docOpen) _edGoHome();
          else _edGoToHub();
        });
      }
      _wire('editorSaveBtn', _edSaveDoc);
      _wire('editorDuplicateBtn', _edDuplicateDoc);
      // Export dropdown
      var edExportBtn = document.getElementById('editorExportBtn');
      var edExportDD = document.getElementById('edExportDropdown');
      edExportBtn &&
        edExportBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var open = edExportDD.style.display !== 'none';
          edExportDD.style.display = open ? 'none' : '';
        });
      document.addEventListener('click', function (e) {
        if (edExportDD && !e.target.closest('#edExportWrap')) edExportDD.style.display = 'none';
      });
      _wire('edExportPdfBtn', function () {
        edExportDD.style.display = 'none';
        _edExportPdf();
      });
      _wire('edExportCourseBtn', function () {
        edExportDD.style.display = 'none';
        _edOpenExportCourseModal();
      });
      _wire('editorDeleteBtn', _edDeleteDoc);

      // Tool modes
      document.querySelectorAll('.ed-mode-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          _edSetTool(btn.getAttribute('data-mode'));
        });
      });

      // Annotation type
      document.querySelectorAll('.ed-ann-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          document.querySelectorAll('.ed-ann-btn').forEach(function (b) {
            b.classList.remove('active');
          });
          btn.classList.add('active');
          _ed.annType = btn.getAttribute('data-ann');
          var po = document.getElementById('edPenOpts');
          if (po) po.style.display = _ed.annType === 'pen' ? '' : 'none';
        });
      });
      var annColor = document.getElementById('edAnnColor');
      annColor &&
        annColor.addEventListener('input', function () {
          if (!_ed.selObj || !_ed.doc) return;
          var pg = _ed.doc.pages[_ed.selObj.pageIdx];
          var obj = (pg.objects || []).find(function (o) {
            return o.id === _ed.selObj.id;
          });
          if (obj && obj.type !== 'shape' && obj.type !== 'image') {
            obj.color = annColor.value;
            _edRenderAllPages();
            _edSelectObj(_ed.selObj.pageIdx, _ed.selObj.id);
            _edScheduleAutoSave();
          }
        });
      var annOp = document.getElementById('edAnnOpacity');
      annOp &&
        annOp.addEventListener('input', function () {
          var v = document.getElementById('edAnnOpacityVal');
          if (v) v.textContent = annOp.value + '%';
        });
      var penW = document.getElementById('edPenWidth');
      penW &&
        penW.addEventListener('input', function () {
          var v = document.getElementById('edPenWidthVal');
          if (v) v.textContent = penW.value;
        });

      // Shape type
      document.querySelectorAll('.ed-shape-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          document.querySelectorAll('.ed-shape-btn').forEach(function (b) {
            b.classList.remove('active');
          });
          btn.classList.add('active');
          _ed.shapeType = btn.getAttribute('data-shape');
        });
      });
      var shOp = document.getElementById('edShapeOpacity');
      shOp &&
        shOp.addEventListener('input', function () {
          var v = document.getElementById('edShapeOpacityVal');
          if (v) v.textContent = shOp.value + '%';
        });
      var shFill = document.getElementById('edShapeFill');
      shFill &&
        shFill.addEventListener('input', function () {
          if (!_ed.selObj || !_ed.doc) return;
          var pg = _ed.doc.pages[_ed.selObj.pageIdx];
          var obj = (pg.objects || []).find(function (o) {
            return o.id === _ed.selObj.id && o.type === 'shape';
          });
          if (obj) {
            obj.fill = shFill.value;
            _edRenderAllPages();
            _edSelectObj(_ed.selObj.pageIdx, _ed.selObj.id);
            _edScheduleAutoSave();
          }
        });
      var shStroke = document.getElementById('edShapeStroke');
      shStroke &&
        shStroke.addEventListener('input', function () {
          if (!_ed.selObj || !_ed.doc) return;
          var pg = _ed.doc.pages[_ed.selObj.pageIdx];
          var obj = (pg.objects || []).find(function (o) {
            return o.id === _ed.selObj.id && o.type === 'shape';
          });
          if (obj) {
            obj.stroke = shStroke.value;
            _edRenderAllPages();
            _edSelectObj(_ed.selObj.pageIdx, _ed.selObj.id);
            _edScheduleAutoSave();
          }
        });
      var shSW = document.getElementById('edShapeStrokeW');
      shSW &&
        shSW.addEventListener('input', function () {
          var v = document.getElementById('edShapeStrokeWVal');
          if (v) v.textContent = shSW.value;
        });

      // Zoom
      _wire('edZoomOut', function () {
        _ed.zoom = Math.max(30, _ed.zoom - 10);
        _edApplyZoom();
      });
      _wire('edZoomIn', function () {
        _ed.zoom = Math.min(500, _ed.zoom + 10);
        _edApplyZoom();
      });

      // Undo/Redo
      _wire('edUndoBtn', function () {
        // Try text undo first: focus the current page's contenteditable and call
        // execCommand('undo'). If the browser had text changes to revert, innerHTML
        // will differ — we sync back and stop. Otherwise fall through to structural undo.
        var ce = document.querySelector('.ed-page-content[data-page-idx="' + _ed.pageIdx + '"]');
        if (ce && _ed.doc) {
          var before = ce.innerHTML;
          ce.focus();
          document.execCommand('undo');
          if (ce.innerHTML !== before) {
            _ed.doc.pages[_ed.pageIdx].content = ce.innerHTML;
            return;
          }
        }
        _edUndo();
      });
      _wire('edRedoBtn', function () {
        var ce = document.querySelector('.ed-page-content[data-page-idx="' + _ed.pageIdx + '"]');
        if (ce && _ed.doc) {
          var before = ce.innerHTML;
          ce.focus();
          document.execCommand('redo');
          if (ce.innerHTML !== before) {
            _ed.doc.pages[_ed.pageIdx].content = ce.innerHTML;
            return;
          }
        }
        _edRedo();
      });

      // Text toolbar: mousedown preventDefault to keep selection
      var toolbar = document.getElementById('editorToolbar');
      if (toolbar && !toolbar._edWired) {
        toolbar._edWired = true;
        toolbar.addEventListener('mousedown', function (e) {
          // Prevent buttons from stealing focus/selection, but allow selects and
          // color inputs to receive their normal events so their dropdowns open.
          var tag = (e.target.tagName || '').toUpperCase();
          if (tag !== 'SELECT' && tag !== 'INPUT' && tag !== 'OPTION') e.preventDefault();
        });
        toolbar.addEventListener('click', function (e) {
          var btn = e.target.closest('.ed-tool-btn');
          if (!btn || !btn.getAttribute('data-cmd')) return;
          if (_ed.tool !== 'text') return;
          // mousedown.preventDefault() already preserved focus and selection —
          // do NOT call _edRestoreRange() here as it fires contentEl.focus() which
          // triggers selectionchange and corrupts the selection before execCommand runs.
          document.execCommand(
            btn.getAttribute('data-cmd'),
            false,
            btn.getAttribute('data-val') || null
          );
          _edSaveRange();
          // Force-update toolbar state immediately (don't rely on selectionchange timing)
          _edForceUpdateToolbarState();
        });
      }

      // Font family/size/color
      var ffSel = document.getElementById('edFontFamily');
      ffSel &&
        ffSel.addEventListener('change', function () {
          if (_ed.tool === 'text') {
            _edRestoreRange();
            if (ffSel.value) document.execCommand('fontName', false, ffSel.value);
            else document.execCommand('removeFormat', false, null);
            _edSaveRange();
          }
        });
      var fsSel = document.getElementById('edFontSize');
      fsSel &&
        fsSel.addEventListener('change', function () {
          if (_ed.tool === 'text') {
            _edRestoreRange();
            document.execCommand('fontSize', false, fsSel.value);
            _edSaveRange();
          }
        });
      var fcIn = document.getElementById('edFontColor');
      fcIn &&
        fcIn.addEventListener('input', function () {
          if (_ed.tool === 'text') {
            _edRestoreRange();
            document.execCommand('foreColor', false, fcIn.value);
            _edSaveRange();
          }
        });

      // Image file input
      var imgInput = document.getElementById('edImageFileInput');
      imgInput &&
        imgInput.addEventListener('change', function () {
          if (imgInput.files[0] && _ed.doc) {
            try {
              if (window._ssValidateImageFile) window._ssValidateImageFile(imgInput.files[0]);
              _edInsertImage(imgInput.files[0], _ed.pageIdx);
            } catch (e) {
              showToast('File blocked', e.message);
            }
          }
          imgInput.value = '';
        });

      // Import PDF
      var pdfInput = document.getElementById('edImportPdfInput');
      pdfInput &&
        pdfInput.addEventListener('change', function () {
          if (pdfInput.files[0]) {
            try {
              if (window._ssValidateUploadFile)
                window._ssValidateUploadFile(pdfInput.files[0], {
                  allowedExtensions: ['.pdf'],
                  allowedMimeTypes: ['application/pdf']
                });
              _edImportPdf(pdfInput.files[0]);
            } catch (e) {
              showToast('File blocked', e.message);
            }
          }
          pdfInput.value = '';
        });

      // Page navigation
      _wire('edFirstPage', function () {
        _edGoToPage(0);
      });
      _wire('edPrevPage', function () {
        _edGoToPage(_ed.pageIdx - 1);
      });
      _wire('edNextPage', function () {
        _edGoToPage(_ed.pageIdx + 1);
      });
      _wire('edLastPage', function () {
        _edGoToPage(_ed.doc ? _ed.doc.pages.length - 1 : 0);
      });
      var pageNumIn = document.getElementById('edPageNum');
      pageNumIn &&
        pageNumIn.addEventListener('change', function () {
          _edGoToPage(parseInt(pageNumIn.value) - 1);
        });

      // Add page
      _wire('edAddPageBtn', function () {
        _edAddPageAfter(_ed.pageIdx);
      });

      // Canvas: deselect & shape drawing on canvas click
      var canvasWrap = document.getElementById('editorMain');
      canvasWrap &&
        canvasWrap.addEventListener('mousedown', function (e) {
          if (
            e.target === canvasWrap ||
            e.target.classList.contains('editor-canvas-scroll') ||
            e.target.classList.contains('ed-page-wrap')
          ) {
            _edDeselectObj();
          }
        });

      // Cursor color fix: Chrome uses the app's dark color-scheme → white cursor.
      // Switching the root element to color-scheme:light while over the white page
      // forces Chrome to show a dark (black) cursor there.
      canvasWrap &&
        canvasWrap.addEventListener('mousemove', function (e) {
          var pageEl = e.target && e.target.closest && e.target.closest('.ed-page');
          document.documentElement.style.colorScheme = pageEl ? 'light' : '';
          if (_ed.tool === 'select' && pageEl) {
            pageEl.style.cursor = e.target.closest('.ed-obj') ? 'move' : 'default';
          }
        });
      canvasWrap &&
        canvasWrap.addEventListener('mouseleave', function () {
          document.documentElement.style.colorScheme = '';
          document.querySelectorAll('.ed-page').forEach(function (p) {
            p.style.cursor = '';
          });
        });

      // Props: doc settings
      var psSel = document.getElementById('edPageSize');
      psSel &&
        psSel.addEventListener('change', function () {
          if (_ed.doc) {
            _ed.doc.settings.size = psSel.value;
            _edRenderAllPages();
            _edScheduleAutoSave();
          }
        });
      _wire('edOrientPortrait', function () {
        if (!_ed.doc) return;
        _ed.doc.settings.orientation = 'portrait';
        document.getElementById('edOrientPortrait').classList.add('active');
        document.getElementById('edOrientLandscape').classList.remove('active');
        _edRenderAllPages();
        _edScheduleAutoSave();
      });
      _wire('edOrientLandscape', function () {
        if (!_ed.doc) return;
        _ed.doc.settings.orientation = 'landscape';
        document.getElementById('edOrientLandscape').classList.add('active');
        document.getElementById('edOrientPortrait').classList.remove('active');
        _edRenderAllPages();
        _edScheduleAutoSave();
      });
      var _marginTimer = null;
      function _applyMargins() {
        if (!_ed.doc) return;
        var m = _ed.doc.settings.margins;
        m.top = +document.getElementById('edMarginTop').value || 20;
        m.bottom = +document.getElementById('edMarginBottom').value || 20;
        m.left = +document.getElementById('edMarginLeft').value || 20;
        m.right = +document.getElementById('edMarginRight').value || 20;
        _edRenderAllPages();
        _edScheduleAutoSave();
      }
      ['edMarginTop', 'edMarginBottom', 'edMarginLeft', 'edMarginRight'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', _applyMargins);
        el.addEventListener('input', function () {
          clearTimeout(_marginTimer);
          _marginTimer = setTimeout(_applyMargins, 400);
        });
      });
      var bgIn = document.getElementById('edBgColor');
      bgIn &&
        bgIn.addEventListener('input', function () {
          if (_ed.doc) {
            _ed.doc.settings.bgColor = bgIn.value;
            _edRenderAllPages();
            _edScheduleAutoSave();
          }
        });
      var sgIn = document.getElementById('edShowGrid');
      sgIn &&
        sgIn.addEventListener('change', function () {
          if (_ed.doc) {
            _ed.doc.settings.showGrid = sgIn.checked;
            _edRenderAllPages();
            _edScheduleAutoSave();
          }
        });
      var sngIn = document.getElementById('edSnapGrid');
      sngIn &&
        sngIn.addEventListener('change', function () {
          if (_ed.doc) {
            _ed.doc.settings.snapGrid = sngIn.checked;
            _edScheduleAutoSave();
          }
        });

      // Props: object properties
      ['edObjX', 'edObjY', 'edObjW', 'edObjH'].forEach(function (id) {
        var el = document.getElementById(id);
        el &&
          el.addEventListener('change', function () {
            if (!_ed.selObj || !_ed.doc) return;
            var pg = _ed.doc.pages[_ed.selObj.pageIdx];
            var obj = (pg.objects || []).find(function (o) {
              return o.id === _ed.selObj.id;
            });
            if (!obj) return;
            obj.x = +document.getElementById('edObjX').value || 0;
            obj.y = +document.getElementById('edObjY').value || 0;
            obj.w = +document.getElementById('edObjW').value || 20;
            obj.h = +document.getElementById('edObjH').value || 20;
            _edRenderAllPages();
            _edSelectObj(_ed.selObj.pageIdx, _ed.selObj.id);
            _edScheduleAutoSave();
          });
      });
      var objOp = document.getElementById('edObjOpacity');
      objOp &&
        objOp.addEventListener('input', function () {
          var v = document.getElementById('edObjOpacityVal');
          if (v) v.textContent = objOp.value + '%';
          if (!_ed.selObj || !_ed.doc) return;
          var pg = _ed.doc.pages[_ed.selObj.pageIdx];
          var obj = (pg.objects || []).find(function (o) {
            return o.id === _ed.selObj.id;
          });
          if (obj) {
            obj.opacity = parseInt(objOp.value) / 100;
            var el = document.querySelector('.ed-obj[data-obj-id="' + obj.id + '"]');
            if (el) el.style.opacity = obj.opacity;
            _edScheduleAutoSave();
          }
        });
      _wire('edObjDelBtn', function () {
        if (!_ed.selObj || !_ed.doc) return;
        _edPushUndo();
        var pg = _ed.doc.pages[_ed.selObj.pageIdx];
        pg.objects = (pg.objects || []).filter(function (o) {
          return o.id !== _ed.selObj.id;
        });
        _edDeselectObj();
        _edRenderAllPages();
        _edScheduleAutoSave();
      });
      _wire('edObjDupBtn', function () {
        if (!_ed.selObj || !_ed.doc) return;
        _edPushUndo();
        var pg = _ed.doc.pages[_ed.selObj.pageIdx];
        var obj = (pg.objects || []).find(function (o) {
          return o.id === _ed.selObj.id;
        });
        if (!obj) return;
        var copy = _edClone(obj);
        copy.id = _edId();
        copy.x += 20;
        copy.y += 20;
        pg.objects.push(copy);
        _edRenderAllPages();
        _edSelectObj(_ed.selObj.pageIdx, copy.id);
        _edScheduleAutoSave();
      });
      _wire('edDeselectBtn', _edDeselectObj);

      // ── Right-click context menu ───────────────────────────────────────────
      // Copy / Paste / Duplicate / Delete that adapts to what the user
      // right-clicked on: an object, a text selection inside a page, or
      // empty page area (paste-only).
      var _edClipboard = null;       // object clipboard (Shape, image, etc.)
      var _edTextClipboard = '';     // text we copied via this menu
      var _edCtxMenu = null;
      var _edCtx = {                 // snapshot taken at right-click time
        hasObjSel: false,
        hasTextSel: false,
        textSel: '',
        textRange: null,
        contentEl: null,             // .ed-page-content the selection is in
        pageIdxAtClick: 0,
        clientX: 0, clientY: 0
      };

      function _edBuildCtxMenu() {
        if (_edCtxMenu) return _edCtxMenu;
        _edCtxMenu = document.createElement('div');
        _edCtxMenu.id = '_edRightClickMenu';
        _edCtxMenu.style.cssText =
          'position:fixed;z-index:9999;display:none;min-width:160px;padding:6px;' +
          'background:#1a1a2e;border:1px solid rgba(255,255,255,.12);' +
          'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45);' +
          'font-size:.78rem;font-weight:600;color:#e2d9f3;user-select:none';
        ['copy','paste','duplicate','delete'].forEach(function (action) {
          var item = document.createElement('div');
          item.dataset.action = action;
          item.textContent = action.charAt(0).toUpperCase() + action.slice(1);
          item.style.cssText =
            'padding:8px 12px;border-radius:6px;cursor:pointer;' +
            'display:flex;align-items:center;gap:8px';
          item.addEventListener('mouseenter', function () {
            if (item.style.pointerEvents !== 'none')
              item.style.background = 'rgba(167,139,250,.15)';
          });
          item.addEventListener('mouseleave', function () { item.style.background = ''; });
          // mousedown on the item must not deselect text — preventDefault keeps
          // the underlying Range alive until we read it inside the click.
          item.addEventListener('mousedown', function (e) { e.preventDefault(); });
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            _edHandleCtxAction(action);
            _edHideCtxMenu();
          });
          _edCtxMenu.appendChild(item);
        });
        document.body.appendChild(_edCtxMenu);
        return _edCtxMenu;
      }

      function _edSetItemEnabled(item, enabled) {
        item.style.opacity = enabled ? '1' : '0.35';
        item.style.pointerEvents = enabled ? 'auto' : 'none';
      }

      function _edShowCtxMenu() {
        var menu = _edBuildCtxMenu();
        // Optimistic enable state based on local snapshot. We refine `paste`
        // once navigator.clipboard.readText resolves (if the browser allows).
        var hasObj   = _edCtx.hasObjSel;
        var hasText  = _edCtx.hasTextSel;
        var hasAny   = hasObj || hasText;
        var hasLocalPaste = !!_edClipboard || !!_edTextClipboard;
        Array.prototype.forEach.call(menu.children, function (item) {
          var a = item.dataset.action;
          if (a === 'copy')      _edSetItemEnabled(item, hasAny);
          else if (a === 'duplicate') _edSetItemEnabled(item, hasObj); // text dup is weird; obj only
          else if (a === 'delete')    _edSetItemEnabled(item, hasAny);
          else if (a === 'paste')     _edSetItemEnabled(item, hasLocalPaste); // refined async below
        });
        menu.style.left = _edCtx.clientX + 'px';
        menu.style.top  = _edCtx.clientY + 'px';
        menu.style.display = 'block';
        var r = menu.getBoundingClientRect();
        if (r.right  > window.innerWidth)  menu.style.left = (_edCtx.clientX - r.width)  + 'px';
        if (r.bottom > window.innerHeight) menu.style.top  = (_edCtx.clientY - r.height) + 'px';

        // If the browser supports async clipboard reads, opportunistically
        // light up Paste when the system clipboard has text.
        if (!hasLocalPaste && navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (txt) {
            if (txt && menu.style.display === 'block') {
              var pasteItem = menu.querySelector('[data-action="paste"]');
              if (pasteItem) _edSetItemEnabled(pasteItem, true);
            }
          }).catch(function () {});
        }
      }

      function _edHideCtxMenu() {
        if (_edCtxMenu) _edCtxMenu.style.display = 'none';
      }

      // Re-apply the snapshot's range to the document so commands (paste,
      // delete) operate on the original text selection.
      function _edRestoreCtxRange() {
        if (!_edCtx.textRange) return false;
        try {
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(_edCtx.textRange);
          return true;
        } catch (e) { return false; }
      }

      function _edHandleCtxAction(action) {
        if (!_ed.doc) return;

        // ── COPY ────────────────────────────────────────────────────────────
        if (action === 'copy') {
          if (_edCtx.hasTextSel) {
            _edTextClipboard = _edCtx.textSel;
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(_edCtx.textSel).catch(function () {});
            }
            return;
          }
          if (_edCtx.hasObjSel && _ed.selObj) {
            var pg0 = _ed.doc.pages[_ed.selObj.pageIdx];
            var src = (pg0.objects || []).find(function (o) { return o.id === _ed.selObj.id; });
            if (src) _edClipboard = _edClone(src);
          }
          return;
        }

        // ── DELETE ──────────────────────────────────────────────────────────
        if (action === 'delete') {
          if (_edCtx.hasTextSel) {
            if (_edRestoreCtxRange()) {
              document.execCommand('delete', false, null);
              _edScheduleAutoSave();
            }
            return;
          }
          if (_edCtx.hasObjSel && _ed.selObj) {
            _edPushUndo();
            var pg3 = _ed.doc.pages[_ed.selObj.pageIdx];
            pg3.objects = (pg3.objects || []).filter(function (o) { return o.id !== _ed.selObj.id; });
            _edDeselectObj();
            _edRenderAllPages();
            _edScheduleAutoSave();
          }
          return;
        }

        // ── DUPLICATE (object-only) ────────────────────────────────────────
        if (action === 'duplicate') {
          if (!_edCtx.hasObjSel || !_ed.selObj) return;
          _edPushUndo();
          var pg2 = _ed.doc.pages[_ed.selObj.pageIdx];
          var src2 = (pg2.objects || []).find(function (o) { return o.id === _ed.selObj.id; });
          if (!src2) return;
          var dup = _edClone(src2);
          dup.id = _edId();
          dup.x = (dup.x || 0) + 20;
          dup.y = (dup.y || 0) + 20;
          pg2.objects.push(dup);
          _edRenderAllPages();
          _edSelectObj(_ed.selObj.pageIdx, dup.id);
          _edScheduleAutoSave();
          return;
        }

        // ── PASTE ───────────────────────────────────────────────────────────
        if (action === 'paste') {
          // Prefer pasting text when the right-click was inside a text page,
          // otherwise fall back to object paste.
          function doPasteText(text) {
            if (!text) return false;
            // If the user right-clicked while in a text content area, restore
            // their caret/selection and insert at that point.
            if (_edCtx.contentEl) {
              _edCtx.contentEl.focus();
              if (_edRestoreCtxRange()) {
                document.execCommand('insertText', false, text);
                _edScheduleAutoSave();
                return true;
              }
              // Range was lost — append at end of the clicked content area
              _edCtx.contentEl.focus();
              document.execCommand('insertText', false, text);
              _edScheduleAutoSave();
              return true;
            }
            return false;
          }
          function doPasteObject() {
            if (!_edClipboard) return false;
            _edPushUndo();
            var pg1 = _ed.doc.pages[_ed.pageIdx];
            if (!pg1.objects) pg1.objects = [];
            var paste = _edClone(_edClipboard);
            paste.id = _edId();
            paste.x = (paste.x || 0) + 20;
            paste.y = (paste.y || 0) + 20;
            pg1.objects.push(paste);
            _edRenderAllPages();
            _edSelectObj(_ed.pageIdx, paste.id);
            _edScheduleAutoSave();
            return true;
          }

          // 1. Try the system clipboard first (most recent, includes external copies)
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(function (txt) {
              if (txt && doPasteText(txt)) return;
              if (_edTextClipboard && doPasteText(_edTextClipboard)) return;
              doPasteObject();
            }).catch(function () {
              if (_edTextClipboard && doPasteText(_edTextClipboard)) return;
              doPasteObject();
            });
            return;
          }
          if (_edTextClipboard && doPasteText(_edTextClipboard)) return;
          doPasteObject();
        }
      }

      function _edSnapshotCtxAt(e, pageEl) {
        _edCtx.clientX = e.clientX;
        _edCtx.clientY = e.clientY;
        _edCtx.hasObjSel = false;
        _edCtx.hasTextSel = false;
        _edCtx.textSel = '';
        _edCtx.textRange = null;
        _edCtx.contentEl = null;
        _edCtx.pageIdxAtClick = parseInt(pageEl.getAttribute('data-page-idx')) || _ed.pageIdx;

        var objEl = e.target.closest && e.target.closest('.ed-obj');
        if (objEl) {
          var oid = objEl.getAttribute('data-obj-id');
          if (!isNaN(_edCtx.pageIdxAtClick) && oid) {
            _edSelectObj(_edCtx.pageIdxAtClick, oid);
            _edCtx.hasObjSel = true;
          }
        }

        // Text selection (only valid inside a .ed-page-content)
        var sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
          var range = sel.getRangeAt(0);
          var n = range.commonAncestorContainer;
          if (n && n.nodeType === 3) n = n.parentNode;
          var contentHost = n && n.closest && n.closest('.ed-page-content');
          if (contentHost) {
            var text = sel.toString();
            if (text && text.length) {
              _edCtx.hasTextSel = true;
              _edCtx.textSel = text;
              _edCtx.textRange = range.cloneRange();
              _edCtx.contentEl = contentHost;
            }
          }
        }
        // If no live text selection but the click landed in a content area,
        // remember the host so Paste knows where to drop external clipboard text.
        if (!_edCtx.contentEl) {
          var ce = e.target.closest && e.target.closest('.ed-page-content');
          if (ce) _edCtx.contentEl = ce;
        }
      }

      var canvasForCtx = document.getElementById('editorMain');
      if (canvasForCtx) {
        canvasForCtx.addEventListener('contextmenu', function (e) {
          if (!_ed.doc) return;
          var pageEl = e.target.closest && e.target.closest('.ed-page');
          if (!pageEl) return;
          e.preventDefault();
          _edSnapshotCtxAt(e, pageEl);
          _edShowCtxMenu();
        });
      }
      // Dismiss on outside click / scroll / Escape
      document.addEventListener('mousedown', function (e) {
        if (_edCtxMenu && _edCtxMenu.style.display === 'block' &&
            !_edCtxMenu.contains(e.target)) _edHideCtxMenu();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') _edHideCtxMenu();
      });
      window.addEventListener('scroll', _edHideCtxMenu, true);

      // Global keyboard
      document.addEventListener('keydown', _edHandleKeyboard);
      document.addEventListener('selectionchange', _edUpdateTextToolbarState);
      _edSetTool('text');
      _edSetDocActive(false);
      _edUpdatePageNav();

      // Show cached docs immediately, then refresh from Supabase in background
      _edRenderDocList();
      _edLoadFromSupabase().then(function (dbDocs) {
        if (!dbDocs.length) return;
        var local = _edLoadDocs();
        // Merge: Supabase wins on conflict (more recent cloud version)
        var merged = dbDocs.slice();
        local.forEach(function (d) {
          if (
            !merged.find(function (m) {
              return m.id === d.id;
            })
          )
            merged.push(d);
        });
        merged.sort(function (a, b) {
          return b.updated - a.updated;
        });
        _edSaveDocs(merged);
        _edRenderDocList();
      });
    }
    window._writerInit = _writerInit;
    window._editorInit = _writerInit;
  }
  window.addEventListener('ss-editor-ready', _init);
  if (document.getElementById('editorHub')) _init();
})();
