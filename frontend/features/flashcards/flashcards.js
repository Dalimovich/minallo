// Flashcards feature module.
//
// Phase 2: Generate now actually calls /api/ai/generate (via the injected
// `generate` function from course-files.js) and turns the response into a
// real, browsable deck. Multiple decks per course are kept in-memory for now
// (full DB persistence in Phase 3).

(function () {
  var TEMPLATE_URL = 'features/flashcards/flashcards.html';
  var _templatePromise = null;

  // courseId -> { decks: [{id, name, cards, createdAt, lastStudied, progress, flipped, _dbId}], activeId, _loaded }
  var _state = {};

  // ── DB helpers ───────────────────────────────────────────────────────────────
  function _supaHeaders() {
    var token = window._sbToken || '';
    var key = window._SAKEY || '';
    return { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': 'Bearer ' + token };
  }
  function _supaUrl() { return (window._SUPA || '').replace(/\/$/, ''); }
  function _userId() {
    try {
      var p = (window._sbToken || '').split('.')[1];
      return JSON.parse(atob(p.replace(/-/g,'+').replace(/_/g,'/'))).sub || null;
    } catch(e) { return null; }
  }

  function _dbLoadDecks(courseId) {
    var url = _supaUrl() + '/rest/v1/flashcard_decks?course_id=eq.' + encodeURIComponent(courseId) + '&order=created_at.desc&limit=50';
    return fetch(url, { headers: _supaHeaders() })
      .then(function(r) { return r.ok ? r.json() : []; })
      .catch(function() { return []; });
  }

  function _dbSaveDeck(courseId, deck) {
    var uid = _userId();
    if (!uid) return Promise.resolve(null);
    var payload = { user_id: uid, course_id: courseId, name: deck.name, cards: deck.cards };
    return fetch(_supaUrl() + '/rest/v1/flashcard_decks', {
      method: 'POST',
      headers: Object.assign({}, _supaHeaders(), { 'Prefer': 'return=representation' }),
      body: JSON.stringify(payload)
    }).then(function(r) { return r.ok ? r.json() : null; })
      .then(function(rows) { return rows && rows[0] ? rows[0].id : null; })
      .catch(function() { return null; });
  }

  function _dbUpdateDeck(dbId, patch) {
    if (!dbId) return;
    fetch(_supaUrl() + '/rest/v1/flashcard_decks?id=eq.' + dbId, {
      method: 'PATCH',
      headers: Object.assign({}, _supaHeaders(), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(patch)
    }).catch(function() {});
  }

  function _loadTemplate() {
    if (_templatePromise) return _templatePromise;
    _templatePromise = fetch(TEMPLATE_URL)
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var root = tmp.querySelector('[data-flashcards-root]');
        return root ? root.outerHTML : html;
      })
      .catch(function (err) {
        console.error('flashcards template load error:', err);
        return '<div class="fc-empty">Failed to load flashcards UI.</div>';
      });
    return _templatePromise;
  }

  window.mountFlashcards = function (target, course, options) {
    if (!target) return Promise.resolve();
    options = options || {};
    return _loadTemplate().then(function (html) {
      target.innerHTML = html;
      var root = target.querySelector('[data-flashcards-root]');
      if (!root) return;
      _initShell(root, course, options);
    });
  };

  function _getStateFor(courseId) {
    if (!_state[courseId]) _state[courseId] = { decks: [], activeId: null };
    return _state[courseId];
  }

  function _toast(title, body) {
    if (typeof window.showToast === 'function') window.showToast(title, body);
  }

  function _formatRelative(iso) {
    if (!iso) return 'Not started';
    var diffMs = Date.now() - new Date(iso).getTime();
    var day = 24 * 60 * 60 * 1000;
    if (diffMs < day) return 'Last studied today';
    if (diffMs < 2 * day) return 'Last studied yesterday';
    var days = Math.floor(diffMs / day);
    return 'Last studied ' + days + ' days ago';
  }

  function _statusClass(iso) {
    if (!iso) return 'never';
    var diffMs = Date.now() - new Date(iso).getTime();
    var day = 24 * 60 * 60 * 1000;
    if (diffMs < 2 * day) return 'recent';
    return 'stale';
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _initShell(root, course, options) {
    var courseId = (course && course.id) || 'unknown';
    if (course && course.id) root.dataset.courseId = course.id;
    var state = _getStateFor(courseId);

    var els = {
      grid: root.querySelector('#fcDeckGrid'),
      generate: root.querySelector('#fcGenerateBtn'),
      newDeck: root.querySelector('#fcNewDeckBtn'),
      search: root.querySelector('#fcSearchInput'),
      sort: root.querySelector('#fcSortSelect'),
      studyName: root.querySelector('#fcStudyName'),
      studyCount: root.querySelector('#fcStudyCount'),
      cardStage: root.querySelector('#fcCardStage'),
      progressBar: root.querySelector('#fcStudyProgressBar'),
      progressLabel: root.querySelector('#fcStudyProgressLabel'),
      prev: root.querySelector('#fcPrevBtn'),
      flip: root.querySelector('#fcFlipBtn'),
      next: root.querySelector('#fcNextBtn'),
      viewBtns: root.querySelectorAll('.fc-view-btn')
    };

    function renderDeckGrid() {
      if (!els.grid) return;
      var query = (els.search && els.search.value || '').trim().toLowerCase();
      var sortBy = (els.sort && els.sort.value) || 'recent';
      var decks = state.decks.slice();
      if (query) {
        decks = decks.filter(function (d) {
          return (d.name || '').toLowerCase().indexOf(query) !== -1;
        });
      }
      decks.sort(function (a, b) {
        if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
        if (sortBy === 'size') return (b.cards.length) - (a.cards.length);
        if (sortBy === 'created') return (b.createdAt || 0) - (a.createdAt || 0);
        // recent (default)
        var aT = a.lastStudied ? new Date(a.lastStudied).getTime() : 0;
        var bT = b.lastStudied ? new Date(b.lastStudied).getTime() : 0;
        return bT - aT;
      });

      if (!decks.length) {
        els.grid.innerHTML =
          '<div class="fc-empty">' +
          (state.decks.length
            ? 'No decks match your search.'
            : 'No decks yet. Click <strong>Generate cards</strong> to make a deck from this course\'s indexed PDFs.') +
          '</div>';
        return;
      }

      els.grid.innerHTML = decks.map(function (d) {
        var isActive = d.id === state.activeId;
        return (
          '<div class="fc-deck-card' + (isActive ? ' active' : '') + '" data-deck-id="' + _esc(d.id) + '">' +
            '<button class="fc-deck-menu-btn" data-deck-menu="' + _esc(d.id) + '" title="Delete deck">&#x22EE;</button>' +
            '<div class="fc-deck-icon">&#x1F4DA;</div>' +
            '<div>' +
              '<div class="fc-deck-name">' + _esc(d.name) + '</div>' +
              '<div class="fc-deck-count">' + d.cards.length + ' cards</div>' +
            '</div>' +
            '<div class="fc-deck-status">' +
              '<span class="fc-deck-status-dot ' + _statusClass(d.lastStudied) + '"></span>' +
              _esc(_formatRelative(d.lastStudied)) +
            '</div>' +
            '<div class="fc-deck-actions">' +
              '<button class="fc-deck-btn primary" data-deck-open="' + _esc(d.id) + '">&#x1F4D6; Open</button>' +
              '<button class="fc-deck-btn" data-deck-edit="' + _esc(d.id) + '">&#x270F; Rename</button>' +
            '</div>' +
          '</div>'
        );
      }).join('');

      // Wire deck card buttons
      els.grid.querySelectorAll('[data-deck-open]').forEach(function (b) {
        b.addEventListener('click', function (e) { e.stopPropagation(); selectDeck(b.getAttribute('data-deck-open')); });
      });
      els.grid.querySelectorAll('[data-deck-edit]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = b.getAttribute('data-deck-edit');
          var d = state.decks.find(function (x) { return x.id === id; });
          if (!d) return;
          var name = window.prompt('Rename deck', d.name);
          if (name && name.trim()) { d.name = name.trim(); renderAll(); }
        });
      });
      els.grid.querySelectorAll('[data-deck-menu]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = b.getAttribute('data-deck-menu');
          var d = state.decks.find(function (x) { return x.id === id; });
          if (!d) return;
          if (!window.confirm('Delete deck "' + d.name + '"?')) return;
          state.decks = state.decks.filter(function (x) { return x.id !== id; });
          if (state.activeId === id) state.activeId = state.decks.length ? state.decks[0].id : null;
          renderAll();
        });
      });
      els.grid.querySelectorAll('.fc-deck-card').forEach(function (card) {
        card.addEventListener('click', function () { selectDeck(card.getAttribute('data-deck-id')); });
      });
    }

    function selectDeck(id) {
      state.activeId = id;
      var d = state.decks.find(function (x) { return x.id === id; });
      if (d) {
        d.flipped = false;
        if (typeof d.progress !== 'number') d.progress = 0;
      }
      renderAll();
    }

    function renderStudy() {
      var d = state.decks.find(function (x) { return x.id === state.activeId; });
      if (!d || !d.cards.length) {
        if (els.studyName) els.studyName.textContent = d ? d.name : 'Select a deck';
        if (els.studyCount) els.studyCount.textContent = d ? '0 cards' : '';
        if (els.cardStage) {
          els.cardStage.classList.remove('has-card');
          els.cardStage.innerHTML = '<div class="fc-card-empty">' +
            (d ? 'This deck has no cards yet.' : 'Pick a deck to start studying.') +
            '</div>';
        }
        if (els.progressBar) els.progressBar.style.width = '0%';
        if (els.progressLabel) els.progressLabel.textContent = '0 / 0';
        [els.prev, els.flip, els.next].forEach(function (b) { if (b) b.disabled = true; });
        return;
      }
      if (els.studyName) els.studyName.textContent = d.name;
      if (els.studyCount) els.studyCount.textContent = d.cards.length + ' cards';

      var idx = Math.max(0, Math.min(d.progress || 0, d.cards.length - 1));
      var card = d.cards[idx];
      var face = d.flipped ? 'back' : 'front';
      var content = card[face] || '';
      var source = card.source || ((course && course.name) || 'Course');

      if (els.cardStage) {
        els.cardStage.classList.add('has-card');
        els.cardStage.innerHTML =
          '<div class="fc-card-progress-pill">Card ' + (idx + 1) + ' / ' + d.cards.length + '</div>' +
          '<div class="fc-card-source">' + _esc(source) + '</div>' +
          '<div class="fc-card-content">' + _esc(content) + '</div>';
      }
      var pct = ((idx + 1) / d.cards.length) * 100;
      if (els.progressBar) els.progressBar.style.width = pct + '%';
      if (els.progressLabel) els.progressLabel.textContent = (idx + 1) + ' / ' + d.cards.length;
      if (els.prev) els.prev.disabled = idx === 0;
      if (els.next) els.next.disabled = idx >= d.cards.length - 1;
      if (els.flip) els.flip.disabled = false;
    }

    function renderAll() { renderDeckGrid(); renderStudy(); }

    // ── Generation settings ──
    var _settingsKey = 'ss_fc_settings_' + courseId;
    var _historyKey  = 'ss_fc_history_reset_' + courseId;

    function _loadSettings() {
      try { return JSON.parse(localStorage.getItem(_settingsKey) || '{}'); } catch(e) { return {}; }
    }
    function _saveSettings(s) {
      try { localStorage.setItem(_settingsKey, JSON.stringify(s)); } catch(e) {}
    }
    function _getHistoryResetAt() {
      return parseInt(localStorage.getItem(_historyKey) || '0', 10);
    }
    function _resetHistory() {
      try { localStorage.setItem(_historyKey, String(Date.now())); } catch(e) {}
    }

    function _seenCards() {
      var resetAt = _getHistoryResetAt();
      var seen = [];
      state.decks.forEach(function(d) {
        if (resetAt && d.createdAt && d.createdAt < resetAt) return;
        d.cards.forEach(function(c) { if (c.front) seen.push(c.front); });
      });
      return seen.slice(0, 60);
    }

    function _showSettingsModal(onConfirm) {
      var existing = document.getElementById('fcSettingsOverlay');
      if (existing) existing.remove();
      var s = _loadSettings();
      var count = s.count || 12;
      var diff  = s.difficulty || 'medium';

      var overlay = document.createElement('div');
      overlay.id = 'fcSettingsOverlay';
      overlay.className = 'qzsp-overlay';
      overlay.innerHTML =
        '<div class="qzsp-modal qzsp-settings">' +
          '<div class="qzsp-head">' +
            '<span class="qzsp-title">&#x2699;&#xFE0F; Flashcard settings</span>' +
            '<button class="qzsp-close" type="button">&#x2715;</button>' +
          '</div>' +
          '<div class="qzsp-settings-body">' +
            '<label class="qzsp-label">Number of cards</label>' +
            '<div class="qzsp-count-row">' +
              '<input type="range" id="fcCountSlider" min="3" max="15" value="' + count + '" class="qzsp-slider">' +
              '<span id="fcCountVal" class="qzsp-count-val">' + count + '</span>' +
            '</div>' +
            '<label class="qzsp-label">Difficulty</label>' +
            '<div class="qzsp-diff-row">' +
              ['easy','medium','hard'].map(function(d) {
                return '<label class="qzsp-diff-opt' + (diff === d ? ' active' : '') + '">' +
                  '<input type="radio" name="fcDiff" value="' + d + '"' + (diff === d ? ' checked' : '') + '>' +
                  d.charAt(0).toUpperCase() + d.slice(1) +
                '</label>';
              }).join('') +
            '</div>' +
            '<button class="qzsp-btn-ghost qzsp-reset-btn" id="fcResetHistory" type="button">&#x1F504; Reset card history</button>' +
            '<p class="qzsp-reset-hint">Allows the AI to regenerate cards you\'ve already seen.</p>' +
          '</div>' +
          '<div class="qzsp-actions">' +
            '<button class="qzsp-btn-primary" id="fcSettingsConfirm" type="button">&#x2728; Generate cards</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      var slider = overlay.querySelector('#fcCountSlider');
      var countVal = overlay.querySelector('#fcCountVal');
      slider.addEventListener('input', function() { countVal.textContent = slider.value; });

      overlay.querySelectorAll('.qzsp-diff-opt').forEach(function(lbl) {
        lbl.addEventListener('click', function() {
          overlay.querySelectorAll('.qzsp-diff-opt').forEach(function(l) { l.classList.remove('active'); });
          lbl.classList.add('active');
        });
      });

      overlay.querySelector('#fcResetHistory').addEventListener('click', function() {
        _resetHistory();
        _toast('History reset', 'The AI will generate fresh cards next time.');
      });

      overlay.querySelector('.qzsp-close').onclick = function() { overlay.remove(); };
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

      overlay.querySelector('#fcSettingsConfirm').onclick = function() {
        var selDiff = overlay.querySelector('input[name="fcDiff"]:checked');
        var settings = {
          count: parseInt(slider.value, 10),
          difficulty: selDiff ? selDiff.value : 'medium'
        };
        _saveSettings(settings);
        overlay.remove();
        onConfirm(settings);
      };
    }

    // ── Generate ──
    function defaultDeckName() {
      var n = state.decks.length + 1;
      return (course && course.name ? course.name : 'Deck') + ' — Set ' + n;
    }

    function _pickSourcesThenGenerate(settings) {
      if (!options.generate) { _toast('Generation unavailable', 'Generator function not injected.'); return; }
      var BACKEND_URL = window.BACKEND_URL || '';
      var token = window._sbToken || '';
      fetch(BACKEND_URL + '/api/documents/list?courseId=' + encodeURIComponent(course.id), {
        headers: { Authorization: 'Bearer ' + token }
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
        .then(function (data) {
          var docs = (data.documents || []).filter(function (d) { return d.processing_status === 'ready'; });
          if (!docs.length) { _toast('No indexed files', 'Upload and index PDFs first.'); return; }
          _showSourcePicker(docs, function (selectedIds) { doGenerate(selectedIds, settings); });
        })
        .catch(function () { doGenerate(null, settings); });
    }

    function _showSourcePicker(docs, onConfirm) {
      var existing = document.getElementById('qzSourcePickerOverlay');
      if (existing) existing.remove();

      var listHtml = docs.map(function (d) {
        return '<label class="qzsp-item">' +
          '<input type="checkbox" class="qzsp-cb" value="' + _esc(d.id) + '" checked>' +
          '<span class="qzsp-name">' + _esc(d.file_name || d.fileName || 'Untitled') + '</span>' +
        '</label>';
      }).join('');

      var overlay = document.createElement('div');
      overlay.id = 'qzSourcePickerOverlay';
      overlay.className = 'qzsp-overlay';
      overlay.innerHTML =
        '<div class="qzsp-modal">' +
          '<div class="qzsp-head"><span class="qzsp-title">&#x1F4C2; Choose source files</span>' +
            '<button class="qzsp-close" type="button">&#x2715;</button></div>' +
          '<p class="qzsp-sub">Select which indexed files to use for flashcard generation.</p>' +
          '<div class="qzsp-list">' + listHtml + '</div>' +
          '<div class="qzsp-actions">' +
            '<button class="qzsp-btn-ghost" id="qzspSelectAll" type="button">Select all</button>' +
            '<button class="qzsp-btn-ghost" id="qzspClearAll" type="button">Clear</button>' +
            '<button class="qzsp-btn-primary" id="qzspConfirm" type="button">&#x2728; Generate from selected</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      overlay.querySelector('.qzsp-close').onclick = function () { overlay.remove(); };
      overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });

      overlay.querySelector('#qzspSelectAll').onclick = function () {
        overlay.querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = true; });
      };
      overlay.querySelector('#qzspClearAll').onclick = function () {
        overlay.querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = false; });
      };
      overlay.querySelector('#qzspConfirm').onclick = function () {
        var ids = [];
        overlay.querySelectorAll('.qzsp-cb:checked').forEach(function (cb) { ids.push(cb.value); });
        overlay.remove();
        if (!ids.length) { _toast('No files selected', 'Select at least one file.'); return; }
        onConfirm(ids);
      };
    }

    function _showGeneratingOverlay() {
      var el = document.createElement('div');
      el.id = 'fcGenOverlay';
      el.className = 'gen-overlay';
      el.innerHTML =
        '<div class="gen-overlay-box">' +
          '<div class="gen-overlay-spinner"></div>' +
          '<div class="gen-overlay-title">Generating flashcards…</div>' +
          '<div class="gen-overlay-sub">Reading your course files and building cards</div>' +
        '</div>';
      document.body.appendChild(el);
    }
    function _hideGeneratingOverlay() {
      var el = document.getElementById('fcGenOverlay');
      if (el) el.remove();
    }

    function doGenerate(documentIds, settings) {
      if (!options.generate) {
        _toast('Generation unavailable', 'Generator function not injected.');
        return;
      }
      settings = settings || _loadSettings();
      els.generate.disabled = true;
      var origLabel = els.generate.innerHTML;
      els.generate.innerHTML = '<span class="fc-btn-icon">&#x23F3;</span> Generating…';
      _showGeneratingOverlay();
      var genOpts = {
        count: settings.count || 12,
        difficulty: settings.difficulty || 'medium',
        topic: null,
        seenItems: _seenCards()
      };
      if (documentIds && documentIds.length) genOpts.documentIds = documentIds;
      options.generate(course.id, 'flashcards', genOpts).then(function (result) {
        if (!result || !result.items || !result.items.length) {
          var allExisting = [];
          state.decks.forEach(function(d) { allExisting = allExisting.concat(d.cards); });
          if (allExisting.length) {
            var shuffled = allExisting.slice().sort(function() { return Math.random() - 0.5; });
            result = { items: shuffled.slice(0, genOpts.count).map(function(c) {
              return { front: c.front, back: c.back, source: c.source || '' };
            }) };
            _toast('Shuffled existing cards', 'No new material found — showing a mix of your previous cards.');
          } else {
            _toast('Nothing generated', (result && result.error) || 'No content yet — try indexing a PDF first.');
            return;
          }
        }
        var deck = {
          id: 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          name: defaultDeckName(),
          cards: result.items.map(function (c) {
            return { front: c.front, back: c.back, source: c.source || '' };
          }),
          createdAt: Date.now(),
          lastStudied: null,
          progress: 0,
          flipped: false
        };
        state.decks.unshift(deck);
        state.activeId = deck.id;
        _toast('Deck generated', deck.cards.length + ' cards from indexed material.');
        renderAll();
        _dbSaveDeck(course.id, deck).then(function(dbId) {
          if (dbId) { deck.id = dbId; deck._dbId = dbId; state.activeId = dbId; }
        });
      }).catch(function (err) {
        console.error('flashcard generate error:', err);
        _toast('Generation failed', 'Try again, or reindex your PDFs first.');
      }).finally(function () {
        _hideGeneratingOverlay();
        els.generate.disabled = false;
        els.generate.innerHTML = origLabel;
      });
    }

    // ── Study controls ──
    function bumpStudied(d) {
      d.lastStudied = new Date().toISOString();
      _dbUpdateDeck(d._dbId, { last_studied_at: d.lastStudied, study_progress: d.progress || 0, updated_at: d.lastStudied });
    }
    if (els.flip) els.flip.addEventListener('click', function () {
      var d = state.decks.find(function (x) { return x.id === state.activeId; });
      if (!d) return;
      d.flipped = !d.flipped;
      bumpStudied(d);
      renderStudy();
    });
    if (els.cardStage) els.cardStage.addEventListener('click', function () {
      if (els.flip && !els.flip.disabled) els.flip.click();
    });
    if (els.prev) els.prev.addEventListener('click', function () {
      var d = state.decks.find(function (x) { return x.id === state.activeId; });
      if (!d) return;
      d.progress = Math.max(0, (d.progress || 0) - 1);
      d.flipped = false;
      bumpStudied(d);
      renderAll();
    });
    if (els.next) els.next.addEventListener('click', function () {
      var d = state.decks.find(function (x) { return x.id === state.activeId; });
      if (!d) return;
      d.progress = Math.min(d.cards.length - 1, (d.progress || 0) + 1);
      d.flipped = false;
      bumpStudied(d);
      renderAll();
    });

    if (els.generate) els.generate.addEventListener('click', function() {
      _showSettingsModal(function(settings) { _pickSourcesThenGenerate(settings); });
    });
    if (els.newDeck) els.newDeck.addEventListener('click', function () {
      var name = window.prompt('Name for new (empty) deck', defaultDeckName());
      if (!name) return;
      var deck = {
        id: 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: name.trim(),
        cards: [],
        createdAt: Date.now(),
        lastStudied: null,
        progress: 0,
        flipped: false
      };
      state.decks.unshift(deck);
      state.activeId = deck.id;
      renderAll();
    });
    if (els.search) els.search.addEventListener('input', renderDeckGrid);
    if (els.sort) els.sort.addEventListener('change', renderDeckGrid);
    els.viewBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        els.viewBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
    });

    // Load from DB then render
    if (!state._loaded) {
      if (els.grid) els.grid.innerHTML = '<div class="fc-empty">Loading decks…</div>';
      _dbLoadDecks(course.id).then(function(rows) {
        state._loaded = true;
        state.decks = rows.map(function(r) {
          return {
            id: r.id,
            _dbId: r.id,
            name: r.name,
            cards: r.cards || [],
            createdAt: new Date(r.created_at).getTime(),
            lastStudied: r.last_studied_at || null,
            progress: r.study_progress || 0,
            flipped: false
          };
        });
        state.activeId = null;
        renderAll();
      });
    } else {
      renderAll();
    }
  }
})();
