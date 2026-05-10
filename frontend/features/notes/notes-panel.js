// AI Notes Panel — splits the PDF viewer into a two-column workspace.
(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────
  var _panelOpen   = false;
  var _activeTab   = 'notes';   // notes | summary | saved
  var _dirty       = false;
  var _currentNote = null;
  var _notesByType = { notes: null, summary: null };
  var _savedNotes  = [];
  var _generating  = false;
  var _saveTimer   = null;
  var _scope       = 'section';         // page | section | range | document
  var _language    = 'same_as_source';
  var _detailLevel = 'balanced';        // brief | balanced | detailed | exam
  var _rangeFrom   = 1;
  var _rangeTo     = 1;

  var _ctx = { courseId: null, documentId: null, fileName: null };

  function $id(id) { return document.getElementById(id); }
  function _apiHeaders() {
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (window._sbToken || '') };
  }

  // ── Markdown + KaTeX renderer ─────────────────────────────────────────────
  function _renderMath(text) {
    if (!text || !window.katex) return text;
    text = text.replace(/\$\$([^$]+?)\$\$/g, function (_, m) {
      try { return window.katex.renderToString(m, { displayMode: true,  throwOnError: false }); }
      catch (e) { return '$$' + m + '$$'; }
    });
    text = text.replace(/\$([^$\n]+?)\$/g, function (_, m) {
      try { return window.katex.renderToString(m, { displayMode: false, throwOnError: false }); }
      catch (e) { return '$' + m + '$'; }
    });
    return text;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function _inlineMd(s) {
    var r = _renderMath(s);
    return r
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function _md2html(md) {
    if (!md) return '';
    var lines = md.split('\n');
    var out = [];
    var i = 0;
    var inCode = false;
    while (i < lines.length) {
      var line = lines[i];
      if (line.startsWith('```')) {
        if (!inCode) { inCode = true; out.push('<pre><code>'); }
        else          { inCode = false; out.push('</code></pre>'); }
        i++; continue;
      }
      if (inCode) { out.push(_esc(line) + '\n'); i++; continue; }
      var hm = line.match(/^(#{1,4})\s+(.*)/);
      if (hm) { out.push('<h' + hm[1].length + '>' + _inlineMd(hm[2]) + '</h' + hm[1].length + '>'); i++; continue; }
      if (/^---+$/.test(line.trim())) { out.push('<hr>'); i++; continue; }
      if (!line.trim()) { out.push('<br>'); i++; continue; }
      if (/^[-*]\s/.test(line)) {
        out.push('<ul>');
        while (i < lines.length && /^[-*]\s/.test(lines[i])) {
          out.push('<li>' + _inlineMd(lines[i].replace(/^[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('</ul>'); continue;
      }
      if (/^\d+\.\s/.test(line)) {
        out.push('<ol>');
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
          out.push('<li>' + _inlineMd(lines[i].replace(/^\d+\.\s+/, '')) + '</li>');
          i++;
        }
        out.push('</ol>'); continue;
      }
      if (line.includes('|') && lines[i + 1] && /^\|?[-: |]+\|?$/.test(lines[i + 1])) {
        out.push('<table><thead><tr>');
        line.split('|').filter(function (c) { return c.trim(); }).forEach(function (c) {
          out.push('<th>' + _inlineMd(c.trim()) + '</th>');
        });
        out.push('</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && lines[i].includes('|')) {
          out.push('<tr>');
          lines[i].split('|').filter(function (c) { return c.trim(); }).forEach(function (c) {
            out.push('<td>' + _inlineMd(c.trim()) + '</td>');
          });
          out.push('</tr>');
          i++;
        }
        out.push('</tbody></table>'); continue;
      }
      out.push('<p>' + _inlineMd(line) + '</p>');
      i++;
    }
    return out.join('\n');
  }

  // ── Panel HTML ────────────────────────────────────────────────────────────
  function _panelHTML() {
    return [
      '<div class="np-header">',
        '<div class="np-tabs">',
          '<button class="np-tab active" data-tab="notes">Notes</button>',
          '<button class="np-tab" data-tab="summary">Summary</button>',
          '<button class="np-tab" data-tab="saved">Saved</button>',
        '</div>',
        '<div class="np-header-actions">',
          '<button class="np-icon-btn" id="npExport" title="Export as PDF">&#x1F4E4;</button>',
          '<button class="np-icon-btn" id="npClose" title="Close">&#x2715;</button>',
        '</div>',
      '</div>',

      '<div class="np-options-row" id="npOptionsRow">',
        '<div class="np-option-group">',
          '<span class="np-option-label">Scope:</span>',
          '<button class="np-opt" data-scope="page">Page</button>',
          '<button class="np-opt active" data-scope="section">±1</button>',
          '<button class="np-opt" data-scope="range">Range</button>',
          '<button class="np-opt" data-scope="document">Whole PDF</button>',
        '</div>',
        '<div class="np-option-group">',
          '<span class="np-option-label">Lang:</span>',
          '<button class="np-opt active" data-lang="same_as_source">Auto</button>',
          '<button class="np-opt" data-lang="en">EN</button>',
          '<button class="np-opt" data-lang="de">DE</button>',
        '</div>',
      '</div>',

      '<div class="np-options-row" id="npDetailRow" style="display:none">',
        '<div class="np-option-group">',
          '<span class="np-option-label">Detail:</span>',
          '<button class="np-opt" data-detail="brief">Brief</button>',
          '<button class="np-opt active" data-detail="balanced">Balanced</button>',
          '<button class="np-opt" data-detail="detailed">Detailed</button>',
          '<button class="np-opt" data-detail="exam">Exam</button>',
        '</div>',
      '</div>',

      '<div class="np-range-row" id="npRangeRow" style="display:none">',
        '<span class="np-option-label">Pages:</span>',
        '<input class="np-range-input" id="npRangeFrom" type="number" min="1" value="1" title="From page">',
        '<span class="np-range-sep">–</span>',
        '<input class="np-range-input" id="npRangeTo" type="number" min="1" value="1" title="To page">',
      '</div>',

      '<div class="np-action-bar" id="npActionBar">',
        '<button class="np-btn-generate" id="npGenerate">&#x2728; Generate</button>',
        '<button class="np-btn-regen" id="npRegen" style="display:none">&#x21BB; Regen</button>',
        '<div class="np-spacer"></div>',
        '<button class="np-btn-save" id="npSave" style="display:none">&#x1F4BE; Save</button>',
        '<span class="np-status" id="npStatus"></span>',
      '</div>',

      '<div class="np-body" id="npBody">',
        '<div class="np-empty" id="npEmpty">',
          '<div class="np-empty-icon">&#x1F4DD;</div>',
          '<div class="np-empty-title">No notes yet</div>',
          '<div class="np-empty-sub">Click <strong>Generate</strong> to create AI notes from this PDF.</div>',
        '</div>',

        '<div class="np-editor-wrap" id="npEditorWrap" style="display:none">',
          '<div class="np-title-row">',
            '<input class="np-title-input" id="npTitle" type="text" placeholder="Note title">',
          '</div>',
          '<div class="np-view-tabs">',
            '<button class="np-view-tab active" data-view="preview">Preview</button>',
            '<button class="np-view-tab" data-view="edit">Edit</button>',
          '</div>',
          '<div class="np-preview" id="npPreview"></div>',
          '<textarea class="np-editor-ta" id="npEditor" style="display:none" spellcheck="false" placeholder="Markdown…"></textarea>',
        '</div>',

        '<div class="np-saved-list" id="npSavedList" style="display:none"></div>',
      '</div>',

      '<div class="np-gen-overlay" id="npGenOverlay" style="display:none">',
        '<div class="np-gen-box">',
          '<div class="np-gen-spinner"></div>',
          '<div class="np-gen-msg" id="npGenMsg">Generating notes…</div>',
        '</div>',
      '</div>'
    ].join('');
  }

  // ── Create DOM ────────────────────────────────────────────────────────────
  function _createPanel() {
    if ($id('pdfNotesPanel')) return;
    var panel = document.createElement('div');
    panel.id = 'pdfNotesPanel';
    panel.className = 'pdf-notes-panel';
    panel.style.display = 'none';
    panel.innerHTML = _panelHTML();
    var wrap = $id('pdfViewerWrap');
    if (wrap) wrap.appendChild(panel);
    _bindEvents(panel);
  }

  // ── Open / Close ──────────────────────────────────────────────────────────
  function _openPanel() {
    var panel = $id('pdfNotesPanel');
    var pdfView = $id('pdfView');
    if (!panel || !pdfView) return;
    _panelOpen = true;
    panel.style.display = 'flex';
    pdfView.classList.add('pdf-split');
    _renderCurrentTab();
    _loadNotes();
  }

  function _closePanel() {
    var panel = $id('pdfNotesPanel');
    var pdfView = $id('pdfView');
    if (!panel || !pdfView) return;
    _panelOpen = false;
    panel.style.display = 'none';
    pdfView.classList.remove('pdf-split');
    var toggleBtn = $id('pdfNotesToggle');
    if (toggleBtn) toggleBtn.classList.remove('active');
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  function _switchTab(tab) {
    _activeTab = tab;
    var panel = $id('pdfNotesPanel');
    if (!panel) return;
    panel.querySelectorAll('.np-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    var actionBar  = $id('npActionBar');
    var detailRow  = $id('npDetailRow');
    if (actionBar)  actionBar.style.display = (tab === 'saved') ? 'none' : '';
    if (detailRow)  detailRow.style.display  = (tab === 'summary') ? '' : 'none';
    if (tab === 'saved') {
      _renderSavedList();
    } else {
      _currentNote = _notesByType[tab] || null;
      _renderCurrentTab();
    }
  }

  // ── Render editor state ───────────────────────────────────────────────────
  function _renderCurrentTab() {
    var empty   = $id('npEmpty');
    var wrap    = $id('npEditorWrap');
    var saved   = $id('npSavedList');
    var regen   = $id('npRegen');
    var save    = $id('npSave');
    var preview = $id('npPreview');
    var editor  = $id('npEditor');
    var title   = $id('npTitle');
    if (!empty) return;

    if (saved) saved.style.display = 'none';

    if (!_currentNote) {
      empty.style.display = 'flex';
      if (wrap)  wrap.style.display = 'none';
      if (regen) regen.style.display = 'none';
      if (save)  save.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    if (wrap)  wrap.style.display = 'flex';
    if (regen) regen.style.display = '';
    if (save)  save.style.display = '';
    if (title)   title.value = _currentNote.title || '';
    if (editor)  editor.value = _currentNote.content_markdown || '';
    if (preview) preview.innerHTML = _md2html(_currentNote.content_markdown || '');
    _setStatus('');
  }

  // ── Render saved notes list ───────────────────────────────────────────────
  function _renderSavedList() {
    var empty = $id('npEmpty');
    var wrap  = $id('npEditorWrap');
    var list  = $id('npSavedList');
    if (!list) return;
    if (empty) empty.style.display = 'none';
    if (wrap)  wrap.style.display = 'none';

    if (!_savedNotes.length) {
      list.style.display = 'flex';
      list.innerHTML = '<div class="np-empty" style="height:100%">' +
        '<div class="np-empty-icon">&#x1F4DA;</div>' +
        '<div class="np-empty-title">No saved notes</div>' +
        '<div class="np-empty-sub">Generated notes are saved automatically.</div>' +
        '</div>';
      return;
    }

    list.style.display = 'flex';
    list.innerHTML = _savedNotes.map(function (n, idx) {
      var date = n.created_at ? new Date(n.created_at).toLocaleDateString() : '';
      var pages = (n.source_page_start != null)
        ? 'S. ' + n.source_page_start + (n.source_page_end && n.source_page_end !== n.source_page_start ? '–' + n.source_page_end : '')
        : 'Whole PDF';
      return '<div class="np-saved-item" data-idx="' + idx + '">' +
        '<div class="np-saved-item-title">' + _esc(n.title || 'Untitled') + '</div>' +
        '<div class="np-saved-item-meta">' +
          '<span class="np-saved-badge np-saved-badge-' + (n.type || 'notes') + '">' + (n.type === 'summary' ? 'Summary' : 'Notes') + '</span>' +
          '<span class="np-saved-pages">' + pages + '</span>' +
          '<span class="np-saved-date">' + date + '</span>' +
        '</div>' +
        '<button class="np-saved-delete" data-id="' + n.id + '" title="Delete">&#x1F5D1;</button>' +
      '</div>';
    }).join('');
  }

  function _setStatus(msg, cls) {
    var el = $id('npStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'np-status' + (cls ? ' ' + cls : '');
  }

  // ── Load notes from DB ────────────────────────────────────────────────────
  async function _loadNotes() {
    if (!_ctx.documentId || !_ctx.courseId) return;
    try {
      var r = await fetch(
        (window.BACKEND_URL || '') + '/api/notes?courseId=' + encodeURIComponent(_ctx.courseId) +
        '&documentId=' + encodeURIComponent(_ctx.documentId),
        { headers: _apiHeaders() }
      );
      var data = r.ok ? await r.json() : {};
      var notes = data.notes || [];
      _savedNotes = notes;

      // Pick most recent note per type for the editor tabs
      ['notes', 'summary'].forEach(function (t) {
        var match = notes.find(function (n) { return n.type === t; });
        if (match && !_notesByType[t]) {
          _notesByType[t] = { id: match.id, title: match.title, type: match.type, content_markdown: '',
            source_page_start: match.source_page_start, source_page_end: match.source_page_end,
            created_at: match.created_at };
        }
      });

      for (var t of ['notes', 'summary']) {
        if (_notesByType[t] && _notesByType[t].id && !_notesByType[t].content_markdown) {
          await _loadNoteContent(_notesByType[t]);
        }
      }
    } catch (e) { console.warn('[notes-panel] load error:', e); }
    _currentNote = _notesByType[_activeTab] || null;
    if (_panelOpen) _renderCurrentTab();
  }

  async function _loadNoteContent(note) {
    try {
      var r = await fetch(
        (window.BACKEND_URL || '') + '/api/notes?id=' + encodeURIComponent(note.id),
        { headers: _apiHeaders() }
      );
      var data = r.ok ? await r.json() : {};
      if (data.note) {
        note.title = data.note.title;
        note.content_markdown = data.note.content_markdown || '';
      }
    } catch (e) {}
  }

  // ── Page-range text helper ────────────────────────────────────────────────
  function _getPdfTextForRange(start, end) {
    var texts = window.pdfPageTexts;
    if (texts && start != null) {
      var parts = [];
      for (var p = start; p <= (end || start); p++) {
        if (texts[p]) parts.push('[S. ' + p + ']\n' + texts[p]);
      }
      if (parts.length) return parts.join('\n\n');
    }
    return '';
  }

  // ── API call helper ───────────────────────────────────────────────────────
  async function _notesApi(payload) {
    var resp = await fetch((window.BACKEND_URL || '') + '/api/notes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (window._sbToken || '') },
      body: JSON.stringify(payload)
    });
    return resp.json();
  }

  function _setGenMsg(msg) {
    var el = $id('npGenMsg');
    if (el) el.textContent = msg;
  }

  // ── Generation strategy ───────────────────────────────────────────────────
  function _groupSize(pageCount) {
    if (pageCount <= 3)  return pageCount;  // single call
    if (pageCount <= 10) return 3;
    return 5;
  }

  async function _generateSingle(rangeStart, rangeEnd, currentPage) {
    var pdfText = _getPdfTextForRange(rangeStart, rangeEnd);
    return _notesApi({
      courseId:    _ctx.courseId,
      documentId:  _ctx.documentId || null,
      tool:        _activeTab,
      fileName:    _ctx.fileName || null,
      pdfText:     pdfText,
      scope:       _scope,
      language:    _language,
      detailLevel: _activeTab === 'summary' ? _detailLevel : undefined,
      currentPage: currentPage,
      pageRange:   rangeStart != null ? { start: rangeStart, end: rangeEnd } : undefined
    });
  }

  async function _generateMultiSection(rangeStart, rangeEnd) {
    var pageCount = rangeEnd - rangeStart + 1;
    var isSummary = _activeTab === 'summary';

    // ── Step 1: for summary mode, ask backend to classify and group pages ──
    var groups = [];

    var effectivePages = null;

    if (isSummary && _ctx.documentId) {
      _setGenMsg('Analyzing document structure…');
      try {
        var analyzeData = await _notesApi({
          mode:       'analyze',
          courseId:   _ctx.courseId,
          documentId: _ctx.documentId,
          tool:       'summary',
          pageRange:  { start: rangeStart, end: rangeEnd }
        });
        if (analyzeData.groups && analyzeData.groups.length) {
          groups = analyzeData.groups.map(function (g) {
            return { title: g.title || null, start: g.pageStart, end: g.pageEnd };
          });
        }
        if (analyzeData.effectivePages != null) effectivePages = analyzeData.effectivePages;
      } catch (e) {
        console.warn('[notes-panel] analyze failed, falling back to fixed splits:', e.message);
      }
    }

    // ── Step 2: fallback to fixed page splits if analyze returned nothing ──
    if (!groups.length) {
      var gs = _groupSize(pageCount);
      for (var p = rangeStart; p <= rangeEnd; p += gs) {
        groups.push({ title: null, start: p, end: Math.min(p + gs - 1, rangeEnd) });
      }
    }

    // ── Step 3: generate section summary / notes for each group ───────────
    var sections = [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var label = isSummary ? 'Summarizing' : 'Generating';
      var groupLabel = g.title
        ? g.title
        : 'S. ' + g.start + (g.end !== g.start ? '–' + g.end : '');
      _setGenMsg(label + ' ' + (i + 1) + ' / ' + groups.length + ': ' + groupLabel + '…');

      var pdfText = _getPdfTextForRange(g.start, g.end);
      var data = await _notesApi({
        mode:        'section',
        courseId:    _ctx.courseId,
        documentId:  _ctx.documentId || null,
        tool:        _activeTab,
        fileName:    _ctx.fileName || null,
        pdfText:     pdfText,
        language:    _language,
        detailLevel: isSummary ? _detailLevel : undefined,
        topicTitle:  isSummary ? (g.title || null) : undefined,
        pageRange:   { start: g.start, end: g.end }
      });
      if (data.error) throw new Error(data.error);
      if (!data.empty && data.markdown) {
        sections.push({ markdown: data.markdown, pageStart: g.start, pageEnd: g.end, title: g.title });
      }
    }

    if (!sections.length) throw new Error('No content found in selected range.');

    // ── Step 4: merge sections ────────────────────────────────────────────
    _setGenMsg('Merging ' + sections.length + ' sections into final summary…');
    return _notesApi({
      mode:          'merge',
      courseId:      _ctx.courseId,
      documentId:    _ctx.documentId || null,
      tool:          _activeTab,
      fileName:      _ctx.fileName || null,
      language:      _language,
      detailLevel:   isSummary ? _detailLevel : undefined,
      effectivePages: isSummary ? effectivePages : undefined,
      sections:      sections
    });
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  async function _generate() {
    if (_generating) return;
    if (!_ctx.courseId) {
      if (typeof showToast === 'function') showToast('No course', 'Open a course PDF first.');
      return;
    }

    _generating = true;
    var overlay = $id('npGenOverlay');
    if (overlay) overlay.style.display = 'flex';

    try {
      var visiblePage = typeof window._pdfVisiblePage === 'function' ? window._pdfVisiblePage() : null;
      var currentPage = visiblePage || window.pdfPage || null;

      var rangeStart = null;
      var rangeEnd   = null;

      if (_scope === 'page' && currentPage) {
        rangeStart = currentPage; rangeEnd = currentPage;
      } else if (_scope === 'section' && currentPage) {
        rangeStart = Math.max(1, currentPage - 1); rangeEnd = currentPage + 1;
      } else if (_scope === 'range') {
        rangeStart = _rangeFrom; rangeEnd = _rangeTo;
      }

      var pageCount = (rangeStart != null && rangeEnd != null) ? (rangeEnd - rangeStart + 1) : 0;
      // Use multi-section pipeline for notes >3 pages or summary >6 pages
      var useMulti = pageCount > (_activeTab === 'summary' ? 6 : 3) && _ctx.documentId;

      if (useMulti) {
        var multiLabel = _activeTab === 'summary' ? 'summary' : 'notes';
        _setGenMsg('Preparing ' + pageCount + '-page ' + multiLabel + ' — analyzing section by section…');
      } else {
        _setGenMsg('Generating ' + (_activeTab === 'summary' ? 'summary' : 'notes') + '…');
      }

      var data = useMulti
        ? await _generateMultiSection(rangeStart, rangeEnd)
        : await _generateSingle(rangeStart, rangeEnd, currentPage);

      if (data.error) {
        if (typeof showToast === 'function') showToast('Generation failed', data.error);
        _setStatus(data.error, 'err');
      } else if (data.note) {
        _notesByType[_activeTab] = data.note;
        _currentNote = data.note;
        _savedNotes.unshift({
          id: data.note.id, title: data.note.title, type: data.note.type,
          source_page_start: data.note.source_page_start, source_page_end: data.note.source_page_end,
          created_at: new Date().toISOString()
        });
        _renderCurrentTab();
        _setStatus('Generated ✓', 'ok');
        if (typeof showToast === 'function') showToast('Notes ready', 'AI notes saved to your account.');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Generation failed', e.message || 'Network error');
      _setStatus('Failed', 'err');
    } finally {
      _generating = false;
      if (overlay) overlay.style.display = 'none';
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function _save(quiet) {
    if (!_currentNote || !_currentNote.id) return;
    var editor  = $id('npEditor');
    var titleEl = $id('npTitle');
    var md    = editor  ? editor.value  : _currentNote.content_markdown;
    var title = titleEl ? titleEl.value : _currentNote.title;
    if (md === _currentNote.content_markdown && title === _currentNote.title) {
      if (!quiet) _setStatus('No changes', '');
      return;
    }
    _setStatus('Saving…', '');
    try {
      var resp = await fetch(
        (window.BACKEND_URL || '') + '/api/notes?id=' + encodeURIComponent(_currentNote.id),
        { method: 'PATCH', headers: _apiHeaders(), body: JSON.stringify({ title: title, content_markdown: md }) }
      );
      if (resp.ok) {
        _currentNote.content_markdown = md;
        _currentNote.title = title;
        _notesByType[_activeTab] = _currentNote;
        _dirty = false;
        _setStatus('Saved ✓', 'ok');
        var preview = $id('npPreview');
        if (preview) preview.innerHTML = _md2html(md);
        // Update saved list entry
        var entry = _savedNotes.find(function (n) { return n.id === _currentNote.id; });
        if (entry) entry.title = title;
      } else {
        _setStatus('Save failed', 'err');
      }
    } catch (e) { _setStatus('Save failed', 'err'); }
  }

  async function _deleteNote(id) {
    try {
      await fetch((window.BACKEND_URL || '') + '/api/notes?id=' + encodeURIComponent(id),
        { method: 'DELETE', headers: _apiHeaders() });
      _savedNotes = _savedNotes.filter(function (n) { return n.id !== id; });
      ['notes', 'summary'].forEach(function (t) {
        if (_notesByType[t] && _notesByType[t].id === id) _notesByType[t] = null;
      });
      if (_currentNote && _currentNote.id === id) { _currentNote = null; }
      _renderSavedList();
    } catch (e) {}
  }

  // ── Export as PDF ─────────────────────────────────────────────────────────
  function _exportPdf() {
    if (!_currentNote || !_currentNote.content_markdown) {
      if (typeof showToast === 'function') showToast('Nothing to export', 'Generate notes first.');
      return;
    }
    var preview = $id('npPreview');
    var html  = preview ? preview.innerHTML : _md2html(_currentNote.content_markdown);
    var title = _currentNote.title || 'Notes';
    var win = window.open('', '_blank', 'width=900,height=700');
    if (!win) return;
    win.document.write('<!DOCTYPE html><html><head>' +
      '<meta charset="utf-8"><title>' + _esc(title) + '</title>' +
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css">' +
      '<style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;color:#111;line-height:1.7;padding:0 20px}' +
      'h1{font-size:1.8rem;border-bottom:2px solid #333;padding-bottom:8px}' +
      'h2{font-size:1.3rem;margin-top:1.6em}h3{font-size:1.1rem}' +
      'pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow-x:auto}' +
      'code{background:#f0f0f0;padding:1px 4px;border-radius:3px}' +
      'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px}' +
      '@media print{body{margin:20px}}</style>' +
      '</head><body><h1>' + _esc(title) + '</h1>' + html + '</body></html>');
    win.document.close();
    win.focus();
    setTimeout(function () { win.print(); }, 600);
  }

  // ── Auto-save ─────────────────────────────────────────────────────────────
  function _scheduleSave() {
    _dirty = true;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () { _save(true); }, 3000);
    _setStatus('Unsaved', '');
  }

  // ── Event binding ─────────────────────────────────────────────────────────
  function _bindEvents(panel) {
    panel.addEventListener('click', function (e) {
      if (e.target.id === 'npClose') _closePanel();
    });

    // Header tabs
    panel.querySelectorAll('.np-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { _switchTab(btn.dataset.tab); });
    });

    // Scope options
    panel.querySelectorAll('[data-scope]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _scope = btn.dataset.scope;
        panel.querySelectorAll('[data-scope]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.scope === _scope);
        });
        var rangeRow = $id('npRangeRow');
        if (rangeRow) rangeRow.style.display = (_scope === 'range') ? 'flex' : 'none';
        // Prefill range inputs with current visible page
        if (_scope === 'range') {
          var cp = (typeof window._pdfVisiblePage === 'function' ? window._pdfVisiblePage() : null) || window.pdfPage || 1;
          var fromEl = $id('npRangeFrom');
          var toEl   = $id('npRangeTo');
          if (fromEl && !fromEl._userEdited) fromEl.value = cp;
          if (toEl   && !toEl._userEdited)   toEl.value   = cp;
          _rangeFrom = cp;
          _rangeTo   = cp;
        }
      });
    });

    // Range inputs
    var fromEl = $id('npRangeFrom');
    var toEl   = $id('npRangeTo');
    if (fromEl) fromEl.addEventListener('input', function () {
      fromEl._userEdited = true;
      _rangeFrom = parseInt(fromEl.value, 10) || 1;
    });
    if (toEl) toEl.addEventListener('input', function () {
      toEl._userEdited = true;
      _rangeTo = parseInt(toEl.value, 10) || 1;
    });

    // Language options
    panel.querySelectorAll('[data-lang]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _language = btn.dataset.lang;
        panel.querySelectorAll('[data-lang]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.lang === _language);
        });
      });
    });

    // Detail level options (summary tab only)
    panel.querySelectorAll('[data-detail]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _detailLevel = btn.dataset.detail;
        panel.querySelectorAll('[data-detail]').forEach(function (b) {
          b.classList.toggle('active', b.dataset.detail === _detailLevel);
        });
      });
    });

    // View tabs (Preview / Edit)
    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('.np-view-tab');
      if (!btn) return;
      var view = btn.dataset.view;
      panel.querySelectorAll('.np-view-tab').forEach(function (b) {
        b.classList.toggle('active', b.dataset.view === view);
      });
      var preview = $id('npPreview');
      var editor  = $id('npEditor');
      if (view === 'edit') {
        if (preview) preview.style.display = 'none';
        if (editor)  editor.style.display = '';
      } else {
        if (editor && _currentNote) {
          _currentNote.content_markdown = editor.value;
          var titleEl = $id('npTitle');
          if (titleEl) _currentNote.title = titleEl.value;
        }
        if (preview) {
          preview.innerHTML = _md2html(_currentNote ? _currentNote.content_markdown : '');
          preview.style.display = '';
        }
        if (editor) editor.style.display = 'none';
      }
    });

    // Saved list clicks
    panel.addEventListener('click', function (e) {
      // Open note from saved list
      var item = e.target.closest('.np-saved-item');
      var del  = e.target.closest('.np-saved-delete');
      if (del) {
        e.stopPropagation();
        var id = del.getAttribute('data-id');
        if (id && confirm('Delete this note?')) _deleteNote(id);
        return;
      }
      if (item) {
        var idx = parseInt(item.getAttribute('data-idx'), 10);
        var note = _savedNotes[idx];
        if (!note) return;
        // Switch to appropriate tab and load note content
        var tab = (note.type === 'summary') ? 'summary' : 'notes';
        _notesByType[tab] = Object.assign({}, note, { content_markdown: note.content_markdown || '' });
        _currentNote = _notesByType[tab];
        _activeTab = tab;
        panel.querySelectorAll('.np-tab').forEach(function (b) {
          b.classList.toggle('active', b.dataset.tab === tab);
        });
        var actionBar = $id('npActionBar');
        if (actionBar) actionBar.style.display = '';
        var savedList = $id('npSavedList');
        if (savedList) savedList.style.display = 'none';
        if (!_currentNote.content_markdown) {
          _loadNoteContent(_currentNote).then(function () { _renderCurrentTab(); });
        } else {
          _renderCurrentTab();
        }
      }
    });

    // Generate / Regen / Save / Export
    var genBtn   = $id('npGenerate');
    var regenBtn = $id('npRegen');
    var saveBtn  = $id('npSave');
    var expBtn   = $id('npExport');
    if (genBtn)   genBtn.addEventListener('click', _generate);
    if (regenBtn) regenBtn.addEventListener('click', _generate);
    if (saveBtn)  saveBtn.addEventListener('click', function () { _save(false); });
    if (expBtn)   expBtn.addEventListener('click', _exportPdf);

    var editor     = $id('npEditor');
    var titleInput = $id('npTitle');
    if (editor)     editor.addEventListener('input', _scheduleSave);
    if (titleInput) titleInput.addEventListener('input', _scheduleSave);

    document.addEventListener('keydown', function (e) {
      if (_panelOpen && (e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        _save(false);
      }
    });
  }

  // ── Toolbar button ────────────────────────────────────────────────────────
  function _injectToolbarButton() {
    if ($id('pdfNotesToggle')) return;
    var toolbar = $id('pdfToolbar');
    if (!toolbar) return;
    var spacer = toolbar.querySelector('span[style*="flex: 1"], span[style*="flex:1"]');
    var btn = document.createElement('button');
    btn.id = 'pdfNotesToggle';
    btn.className = 'pdf-tb-btn pdf-notes-toggle-btn';
    btn.title = 'Toggle AI Notes panel';
    btn.innerHTML = '&#x1F4DD; Notes';
    btn.addEventListener('click', function () {
      if (_panelOpen) { _closePanel(); btn.classList.remove('active'); }
      else            { _openPanel();  btn.classList.add('active'); }
    });
    if (spacer) toolbar.insertBefore(btn, spacer);
    else        toolbar.appendChild(btn);
  }

  // ── File open hook ────────────────────────────────────────────────────────
  function _onFileOpen(fileName, course) {
    _notesByType = { notes: null, summary: null };
    _savedNotes  = [];
    _currentNote = null;
    _dirty = false;
    _generating = false;

    _ctx.courseId   = (course && course.id) || window.activeCourseId || null;
    _ctx.fileName   = fileName || null;
    _ctx.documentId = null;

    _resolveDocumentId(fileName, _ctx.courseId);
    _createPanel();
    _injectToolbarButton();

    if (_panelOpen) {
      _renderCurrentTab();
      _loadNotes();
    }
  }

  async function _resolveDocumentId(fileName, courseId) {
    if (!fileName || !courseId) return;
    try {
      var r = await fetch(
        (window.BACKEND_URL || '') + '/api/documents/list?courseId=' + encodeURIComponent(courseId),
        { headers: { Authorization: 'Bearer ' + (window._sbToken || '') } }
      );
      var data = r.ok ? await r.json() : {};
      var docs = data.documents || [];
      var match = docs.find(function (d) {
        return (d.file_name || d.fileName || '').toLowerCase() === fileName.toLowerCase();
      });
      if (match) {
        _ctx.documentId = match.id;
        _loadNotes();
      }
    } catch (e) {}
  }

  function _wrapOpenFile() {
    var orig = window.openFile;
    window.openFile = function (f, course) {
      if (typeof orig === 'function') orig(f, course);
      setTimeout(function () { _onFileOpen(f && f.name, course); }, 50);
    };

    setTimeout(function () {
      var toolbar = document.getElementById('pdfToolbar');
      var hasFile = window.activeFileName || window.pdfDoc;
      if (toolbar && hasFile && !document.getElementById('pdfNotesToggle')) {
        _ctx.courseId = window.activeCourseId || (window.activeCourseRef && window.activeCourseRef.id) || null;
        _ctx.fileName = window.activeFileName || null;
        _createPanel();
        _injectToolbarButton();
        if (_ctx.courseId && _ctx.fileName) _resolveDocumentId(_ctx.fileName, _ctx.courseId);
      }
    }, 500);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wrapOpenFile);
  } else {
    setTimeout(_wrapOpenFile, 0);
  }

  window._notesPanel = {
    open:  _openPanel,
    close: _closePanel,
    ctx:   function () { return _ctx; }
  };
})();
