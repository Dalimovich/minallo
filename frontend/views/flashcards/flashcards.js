// Flashcards feature module.
//
// Generates decks from /api/ai/generate and persists them in Supabase.

(function () {
  // courseId -> { decks: [{id, name, cards, createdAt, lastStudied, progress, flipped, _dbId}], activeId, _loaded }
  var _state = {};

  // ── DB helpers (shared via js/utils/db-helpers.js) ──────────────────────────
  function _supaHeaders() {
    if (window._ssDb && window._ssDb.supaHeaders) return window._ssDb.supaHeaders();
    return {
      'Content-Type': 'application/json',
      apikey: window._SAKEY || '',
      Authorization: 'Bearer ' + (window._sbToken || '')
    };
  }
  function _supaUrl() {
    if (window._ssDb && window._ssDb.supaUrl) return window._ssDb.supaUrl();
    return String(window._SUPA || '').replace(/\/$/, '');
  }
  function _userId() {
    if (window._ssDb && window._ssDb.userId) return window._ssDb.userId();
    try {
      var part = (window._sbToken || '').split('.')[1];
      if (!part) return null;
      return (JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).sub) || null;
    } catch (e) { return null; }
  }

  // Resolves to an array on success (possibly empty), or null on failure
  // (network blip, non-2xx). Callers MUST treat null as "unknown, retry later"
  // and NOT cache it as "this course has no decks" — otherwise a transient
  // error permanently blanks the deck list until a full page reload.
  function _dbLoadDecks(courseId) {
    if (!_supaUrl()) return Promise.resolve([]);
    var url = _supaUrl() + '/rest/v1/flashcard_decks?course_id=eq.' + encodeURIComponent(courseId) + '&order=created_at.desc&limit=50';
    return fetch(url, { headers: _supaHeaders() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .catch(function() { return null; });
  }

  function _dbSaveDeck(courseId, deck) {
    var uid = _userId();
    if (!uid || !_supaUrl()) return Promise.resolve(null);
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

  function _dbDeleteDeck(dbId) {
    if (!dbId) return;
    fetch(_supaUrl() + '/rest/v1/flashcard_decks?id=eq.' + dbId, {
      method: 'DELETE',
      headers: Object.assign({}, _supaHeaders(), { 'Prefer': 'return=minimal' })
    }).catch(function() {});
  }

  // ── Spaced-repetition review state (Stage 3) ────────────────────────────────
  // Review state lives in flashcard_review_state, keyed by (deck_id, card_index)
  // where card_index is the position within the deck's `cards` array. Cards with
  // NO row are treated as "new, due now" — they keep natural deck order rather
  // than all becoming simultaneously overdue. Persistence goes through the
  // server-side SM-2 endpoint so interval/ease growth is computed in one place.
  function _backendUrl() { return (window.BACKEND_URL || ''); }
  function _authHeaders() { return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (window._sbToken || '') }; }

  // Fetch the rated cards for a deck. Returns a map: cardIndex -> reviewRow.
  function _dbLoadReviews(dbDeckId) {
    if (!dbDeckId) return Promise.resolve({});
    return fetch(_backendUrl() + '/api/study/flashcard-review?deckId=' + encodeURIComponent(dbDeckId), {
      headers: _authHeaders()
    })
      .then(function(r) { return r.ok ? r.json() : { reviews: [] }; })
      .then(function(data) {
        var map = {};
        (data && data.reviews || []).forEach(function(row) {
          if (row && typeof row.card_index === 'number') map[row.card_index] = row;
        });
        return map;
      })
      .catch(function() { return {}; });
  }

  // Persist a single rating. Returns the updated review row (or null).
  function _dbSaveReview(dbDeckId, cardIndex, rating) {
    if (!dbDeckId) return Promise.resolve(null);
    return fetch(_backendUrl() + '/api/study/flashcard-review', {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify({ deckId: dbDeckId, cardIndex: cardIndex, rating: rating })
    })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { return data && data.review ? data.review : null; })
      .catch(function() { return null; });
  }

  // Build the study order for a deck from its review map.
  //   1. Due reviewed cards (have a row, due_at <= now), earliest due first.
  //   2. New cards (no row) in natural deck order.
  // Reviewed-but-not-yet-due cards are dropped from this session (nothing to do).
  // If nothing is due and nothing is new, fall back to the whole deck in order so
  // the learner can always study (e.g. re-review ahead of schedule).
  function _buildStudyOrder(deck) {
    var reviews = deck._reviews || {};
    var now = Date.now();
    var due = [];
    var fresh = [];
    var later = []; // reviewed but not yet due — studied LAST, never dropped
    for (var i = 0; i < deck.cards.length; i++) {
      var row = reviews[i];
      if (!row) { fresh.push(i); continue; }
      var dueAt = row.due_at ? new Date(row.due_at).getTime() : 0;
      if (dueAt <= now) due.push({ idx: i, due: dueAt });
      else later.push({ idx: i, due: dueAt });
    }
    due.sort(function(a, b) { return a.due - b.due; });
    later.sort(function(a, b) { return a.due - b.due; });
    // Due first (most overdue first), then new, then everything else. The
    // session always covers the WHOLE deck so the count matches the "N cards"
    // label — previously reviewed-not-yet-due cards were dropped, which made a
    // 10-card deck show only 7.
    return due.map(function(d) { return d.idx; })
      .concat(fresh)
      .concat(later.map(function(d) { return d.idx; }));
  }

  function _docStatusSummary(docs) {
    var summary = { ready: [], pending: 0, failed: 0, total: docs.length };
    docs.forEach(function (d) {
      if (d.processing_status === 'ready') summary.ready.push(d);
      else if (d.processing_status === 'failed') summary.failed++;
      else summary.pending++;
    });
    return summary;
  }

  function _showNoReadyDocs(summary) {
    if (!summary.total) {
      _toast('No files found', 'Upload PDFs to this course, then wait for indexing to finish.');
      return;
    }
    if (summary.pending) {
      _toast(
        'Indexing still running',
        summary.pending + ' file' + (summary.pending === 1 ? ' is' : 's are') + ' still preparing for AI.'
      );
      return;
    }
    if (summary.failed) {
      _toast('Indexing failed', 'Re-index the failed file' + (summary.failed === 1 ? '' : 's') + ' and try again.');
      return;
    }
    _toast('No ready files', 'Re-index your PDFs, then try again.');
  }

  var _TEMPLATE_HTML = '<div class="fc-root" data-flashcards-root>' +
    '<div class="fc-toolbar">' +
      '<button class="fc-btn fc-btn-primary" id="fcGenerateBtn" type="button"><span class="fc-btn-icon">&#x2728;</span> Generate cards</button>' +
      '<div class="fc-search"><span class="fc-search-icon">&#x1F50D;</span><input type="text" id="fcSearchInput" placeholder="Search flashcards…" /></div>' +
      '<select class="fc-sort" id="fcSortSelect" aria-label="Sort decks">' +
        '<option value="recent">Recently studied</option>' +
        '<option value="name">By name</option>' +
        '<option value="size">By card count</option>' +
        '<option value="created">Recently created</option>' +
      '</select>' +
      '<div class="fc-view-toggle" role="tablist" aria-label="View mode">' +
        '<button class="fc-view-btn active" data-view="grid" type="button" aria-label="Grid view">&#x25A6;</button>' +
        '<button class="fc-view-btn" data-view="list" type="button" aria-label="List view">&#x2630;</button>' +
      '</div>' +
    '</div>' +
    '<div class="fc-layout">' +
      '<div class="fc-deck-pane" id="fcDeckPane">' +
        '<div class="fc-deck-grid" id="fcDeckGrid"><div class="fc-empty">Loading decks…</div></div>' +
        '<div class="fc-view-all" id="fcViewAllRow"><span class="fc-view-all-icon">&#x1F4C1;</span> View all decks<span class="fc-view-all-chev">&#x203A;</span></div>' +
      '</div>' +
      '<div class="fc-study-pane" id="fcStudyPane">' +
        '<div class="fc-study-header">' +
          '<span class="fc-study-icon">&#x1F4DA;</span>' +
          '<div class="fc-study-meta"><div class="fc-study-deck-name" id="fcStudyName">Select a deck</div><div class="fc-study-deck-count" id="fcStudyCount">0 cards</div></div>' +
        '</div>' +
        '<div class="fc-card-stage" id="fcCardStage"><div class="fc-card-empty">Pick a deck to start studying.</div></div>' +
        '<div class="fc-study-progress">' +
          '<div class="fc-study-progress-track"><div class="fc-study-progress-bar" id="fcStudyProgressBar"></div></div>' +
          '<div class="fc-study-progress-label" id="fcStudyProgressLabel">0 / 0</div>' +
        '</div>' +
        '<div class="fc-study-controls">' +
          '<button class="fc-btn fc-btn-ghost" id="fcPrevBtn" type="button" disabled><span>&#x25C0;</span> Previous</button>' +
          '<button class="fc-btn fc-btn-flip" id="fcFlipBtn" type="button" disabled><span class="fc-btn-icon">&#x21BB;</span> Flip card</button>' +
          '<button class="fc-btn fc-btn-ghost" id="fcNextBtn" type="button" disabled>Next <span>&#x25B6;</span></button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';

  function _translateStatic(root) {
    if (!root || typeof _t !== 'function') return;
    var gen = root.querySelector('#fcGenerateBtn');
    if (gen) gen.textContent = _t('fc_generate');
    var search = root.querySelector('#fcSearchInput');
    if (search) search.placeholder = _t('fc_search_ph');
    var sort = root.querySelector('#fcSortSelect');
    if (sort) sort.setAttribute('aria-label', _t('fc_sort_aria'));
    [['recent', 'fc_sort_recent'], ['name', 'fc_sort_name'], ['size', 'fc_sort_size'], ['created', 'fc_sort_created']].forEach(function (pair) {
      var opt = root.querySelector('#fcSortSelect option[value="' + pair[0] + '"]');
      if (opt) opt.textContent = _t(pair[1]);
    });
    var view = root.querySelector('.fc-view-toggle');
    if (view) view.setAttribute('aria-label', _t('fc_view_mode_aria'));
    var grid = root.querySelector('.fc-view-btn[data-view="grid"]');
    if (grid) grid.setAttribute('aria-label', _t('fc_grid_view_aria'));
    var list = root.querySelector('.fc-view-btn[data-view="list"]');
    if (list) list.setAttribute('aria-label', _t('fc_list_view_aria'));
    var empty = root.querySelector('.fc-empty');
    if (empty) empty.textContent = _t('fc_loading');
    var all = root.querySelector('#fcViewAllRow');
    if (all) all.childNodes[1].textContent = ' ' + _t('fc_view_all');
    var name = root.querySelector('#fcStudyName');
    if (name) name.textContent = _t('fc_select_deck');
    var count = root.querySelector('#fcStudyCount');
    if (count) count.textContent = _t('fc_zero_cards');
    var pick = root.querySelector('.fc-card-empty');
    if (pick) pick.textContent = _t('fc_pick_deck');
    var prev = root.querySelector('#fcPrevBtn');
    if (prev) prev.textContent = _t('fc_previous');
    var flip = root.querySelector('#fcFlipBtn');
    if (flip) flip.textContent = _t('fc_flip');
    var next = root.querySelector('#fcNextBtn');
    if (next) next.textContent = _t('fc_next');
  }

  window.mountFlashcards = function (target, course, options) {
    if (!target) return;
    options = options || {};
    target.innerHTML = _TEMPLATE_HTML;
    var root = target.querySelector('[data-flashcards-root]');
    _translateStatic(root);
    if (root) _initShell(root, course, options);
  };

  window.resetFlashcardsToGrid = function (target) {
    if (!target) return;
    var root = target.querySelector('[data-flashcards-root]');
    if (root && root._resetToGrid) root._resetToGrid();
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

  // The generator sometimes drops raw Unicode math glyphs (φ, ∑, ‖, ≤ …) inside
  // math mode, where KaTeX hard-fails even with strict:false and dumps the raw
  // source in red. Map the common offenders to real LaTeX commands.
  var _FC_MATH_UNICODE = {
    'φ': '\\varphi', 'ϕ': '\\phi', 'Φ': '\\Phi',
    'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'Γ': '\\Gamma',
    'δ': '\\delta', 'Δ': '\\Delta', '∆': '\\Delta',
    'ε': '\\varepsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta',
    'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi',
    'π': '\\pi', 'Π': '\\Pi', 'ρ': '\\rho', 'σ': '\\sigma', 'Σ': '\\Sigma',
    'τ': '\\tau', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega', 'Ω': '\\Omega',
    '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '√': '\\sqrt', '∂': '\\partial',
    '∇': '\\nabla', '∞': '\\infty',
    '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '≈': '\\approx', '≡': '\\equiv',
    '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '·': '\\cdot',
    '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇔': '\\Leftrightarrow',
    '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq', '∪': '\\cup', '∩': '\\cap',
    '∀': '\\forall', '∃': '\\exists', '∅': '\\emptyset',
    '‖': '\\|', '∥': '\\parallel', '⊥': '\\perp', '∝': '\\propto', '°': '^{\\circ}'
  };
  var _FC_MATH_RE = new RegExp('[' + Object.keys(_FC_MATH_UNICODE).join('').replace(/\s/g, '') + ']', 'g');
  function _fcMapChar(ch) {
    var rep = _FC_MATH_UNICODE[ch];
    if (!rep) return ch;
    // A LaTeX control word needs a boundary after it, or "\le5" / "\sum2"
    // would be misparsed. A trailing space is harmless in math mode.
    return /[a-zA-Z]$/.test(rep) ? rep + ' ' : rep;
  }
  // Convert Unicode math glyphs to LaTeX, but NEVER inside a \text{…}/\mathrm{…}/
  // \operatorname{…} group: there the raw glyph (e.g. φ) renders fine in text
  // mode, whereas a math command like \varphi is invalid and prints literally.
  // The generator routinely wraps variables as \text{φ}, so this guard is what
  // actually makes those cards render.
  var _FC_TOKEN_RE = /\\(?:text|mathrm|operatorname|mathbf|mathit)\s*\{[^{}]*\}/g;
  function _fcConvertMath(seg) {
    var out = '';
    var last = 0;
    var m;
    _FC_TOKEN_RE.lastIndex = 0;
    while ((m = _FC_TOKEN_RE.exec(seg)) !== null) {
      out += seg.slice(last, m.index).replace(_FC_MATH_RE, _fcMapChar);
      out += m[0]; // leave the \text{…} group untouched
      last = m.index + m[0].length;
    }
    out += seg.slice(last).replace(_FC_MATH_RE, _fcMapChar);
    return out;
  }
  // Only normalize INSIDE math delimiters — a German sentence containing "Δ" or
  // "∑" as prose must stay as that glyph, not turn into "\Delta". The
  // alternation lists $$…$$ before $…$ so display math wins at each position.
  var _FC_SEG_RE = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g;
  function _fcNormalizeMath(s) {
    if (!s) return s;
    return String(s).replace(_FC_SEG_RE, _fcConvertMath);
  }

  // Some cards arrive with LaTeX but NO math delimiters at all (the generator
  // forgot the $…$). KaTeX only renders inside delimiters, so that math shows as
  // raw "\frac{…}" text. When a card has zero delimiters, wrap the recognized
  // LaTeX atoms (\frac{}{}, \text{…}, \sqrt{…}, bare \commands, and ^/_ groups
  // on a preceding token) in $…$ so they render. Conservative: only backslash
  // commands and super/subscripts are touched — prose is never wrapped. If the
  // card already uses delimiters, trust them and do nothing.
  var _FC_ATOM_RE = /\\(?:frac|dfrac|tfrac|binom)\s*\{[^{}]*\}\s*\{[^{}]*\}|\\(?:text|mathrm|operatorname|sqrt|vec|hat|bar|overline|boldsymbol|mathbf|mathit)\s*\{[^{}]*\}|\\[a-zA-Z]+|[A-Za-zΑ-Ωα-ω0-9)\]}]\s*[\^_]\s*(?:\{[^{}]*\}|[A-Za-z0-9])/g;
  function _fcAutoWrapMath(s) {
    if (!s || /[$]|\\\(|\\\[/.test(s)) return s;
    if (!/\\[a-zA-Z]|[\^_]\{|[\^_][A-Za-z0-9]/.test(s)) return s; // no LaTeX at all
    return s.replace(_FC_ATOM_RE, function (m) { return '$' + m + '$'; });
  }

  // Card text for display.
  // 1. NFKC-normalize: PDF extraction often yields Mathematical Alphanumeric
  //    glyphs (𝜑 U+1D711, not φ U+03C6) that show as tofu boxes and that KaTeX
  //    can't parse. NFKC folds them back to their canonical base (𝜑→φ, 𝑥→x).
  // 2. Convert the generator's line breaks to a sentinel FIRST, so a literal
  //    "\n" isn't mistaken for a LaTeX command by the steps below.
  // 3. Auto-wrap bare LaTeX (cards with no delimiters), then map leftover
  //    Unicode math glyphs to LaTeX inside math segments.
  // 4. Escape, then restore the line breaks as <br>.
  function _fcCardHtml(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFKC'); } catch (e) { /* very old engine */ }
    t = t.replace(/\\n(?![A-Za-z])|\r\n|\r|\n/g, '');
    t = _fcAutoWrapMath(t);
    t = _fcNormalizeMath(t);
    return _esc(t).replace(//g, '<br>');
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
          if (name && name.trim()) {
            d.name = name.trim();
            _dbUpdateDeck(d._dbId, { name: d.name, updated_at: new Date().toISOString() });
            renderAll();
          }
        });
      });
      els.grid.querySelectorAll('[data-deck-menu]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = b.getAttribute('data-deck-menu');
          var d = state.decks.find(function (x) { return x.id === id; });
          if (!d) return;
          if (!window.confirm('Delete deck "' + d.name + '"?')) return;
          _dbDeleteDeck(d._dbId);
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
        d.pos = 0;             // position within the spaced-repetition study order
        d.studyOrder = null;   // rebuilt once reviews load
        // Load review state, then build the due-first / new-after order.
        _dbLoadReviews(d._dbId).then(function(map) {
          d._reviews = map;
          d.studyOrder = _buildStudyOrder(d);
          d.pos = 0;
          if (state.activeId === id) renderStudy();
        });
      }
      renderAll();
    }

    // Original card index currently shown, derived from the study order.
    function _currentCardIndex(d) {
      var order = (d && d.studyOrder) || null;
      if (!order || !order.length) return Math.max(0, Math.min(d.progress || 0, d.cards.length - 1));
      var pos = Math.max(0, Math.min(d.pos || 0, order.length - 1));
      return order[pos];
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

      // Spaced-repetition order: due-first then new. Until reviews load, the
      // order is null and we fall back to natural deck order via progress.
      var order = d.studyOrder && d.studyOrder.length ? d.studyOrder : null;
      var sessionLen = order ? order.length : d.cards.length;
      var pos = order
        ? Math.max(0, Math.min(d.pos || 0, order.length - 1))
        : Math.max(0, Math.min(d.progress || 0, d.cards.length - 1));
      var idx = _currentCardIndex(d);
      var card = d.cards[idx];
      var face = d.flipped ? 'back' : 'front';
      var content = card[face] || '';
      var source = card.source || ((course && course.name) || 'Course');

      // Rating buttons only after the card is flipped (the learner has seen the
      // answer). Hidden on the front so they don't rate blindly.
      var ratingHtml = '';
      if (d.flipped) {
        ratingHtml =
          '<div class="fc-rating-row" id="fcRatingRow">' +
            '<button class="fc-rating-btn fc-rate-again" data-rate="again" type="button">Again</button>' +
            '<button class="fc-rating-btn fc-rate-hard" data-rate="hard" type="button">Hard</button>' +
            '<button class="fc-rating-btn fc-rate-good" data-rate="good" type="button">Good</button>' +
            '<button class="fc-rating-btn fc-rate-easy" data-rate="easy" type="button">Easy</button>' +
          '</div>';
      }

      if (els.cardStage) {
        els.cardStage.classList.add('has-card');
        els.cardStage.innerHTML =
          '<div class="fc-card-progress-pill">Card ' + (pos + 1) + ' / ' + sessionLen + '</div>' +
          '<div class="fc-card-source">' + _esc(source) + '</div>' +
          '<div class="fc-card-content">' + _fcCardHtml(content) + '</div>' +
          ratingHtml;
        // strict:false lets KaTeX RENDER stray Unicode (φ, ∑, …) that the
        // generator sometimes emits inside math mode instead of dumping the raw
        // source in red error text.
        // errorColor muted (not alarming red): if some content still won't parse
        // after normalization, it degrades to quiet inline text instead of a wall
        // of red.
        var _katexOpts = { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }], throwOnError: false, strict: false, errorColor: '#9aa4b2' };
        var _doMath = function() { if (window.renderMathInElement) try { renderMathInElement(els.cardStage, _katexOpts); } catch(e) {} };
        if (window.renderMathInElement) { _doMath(); }
        else if (window._ssEnsureKatex) { window._ssEnsureKatex().then(_doMath).catch(function(){}); }
        // Wire rating buttons (stopPropagation so they don't trigger the
        // card-stage flip handler).
        els.cardStage.querySelectorAll('[data-rate]').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            rateCard(d, btn.getAttribute('data-rate'));
          });
        });
      }
      var pct = ((pos + 1) / sessionLen) * 100;
      if (els.progressBar) els.progressBar.style.width = pct + '%';
      if (els.progressLabel) els.progressLabel.textContent = (pos + 1) + ' / ' + sessionLen;
      if (els.prev) els.prev.disabled = pos === 0;
      if (els.next) els.next.disabled = pos >= sessionLen - 1;
      if (els.flip) els.flip.disabled = false;
    }

    // Record a rating, schedule the card via the server SM-2 endpoint, and
    // advance to the next card in the session.
    function rateCard(d, rating) {
      if (!d || !d.cards.length) return;
      var cardIndex = _currentCardIndex(d);
      // Optimistically persist; update local review map so re-ordering on a
      // later visit reflects the new schedule.
      _dbSaveReview(d._dbId, cardIndex, rating).then(function(row) {
        if (row && d._reviews) d._reviews[cardIndex] = row;
      });
      bumpStudied(d);
      // Advance within the session order.
      var order = d.studyOrder && d.studyOrder.length ? d.studyOrder : null;
      var sessionLen = order ? order.length : d.cards.length;
      if (order) {
        d.pos = Math.min((d.pos || 0) + 1, sessionLen - 1);
        // If we just rated the last card, stay put; the bar shows complete.
      } else {
        d.progress = Math.min((d.progress || 0) + 1, sessionLen - 1);
      }
      d.flipped = false;
      renderStudy();
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
              '<input type="range" id="fcCountSlider" min="3" max="10" value="' + Math.min(count, 10) + '" class="qzsp-slider">' +
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
          var summary = _docStatusSummary(data.documents || []);
          if (!summary.ready.length) { _showNoReadyDocs(summary); return; }
          _showSourcePicker(summary.ready, function (selectedIds) { doGenerate(selectedIds, settings); });
        })
        .catch(function () {
          _toast('Could not check indexed files', 'Refresh the page, then try again.');
        });
    }

    function _showSourcePicker(docs, onConfirm) {
      var existing = document.getElementById('qzSourcePickerOverlay');
      if (existing) existing.remove();

      // Only show files the course CURRENTLY has. The documents table can keep
      // rows for files that were deleted/removed from the course (or carried
      // over from a migration); those otherwise surface here as "Other files",
      // including items the user no longer recognises. Cross-reference against
      // the course's live file list (loose files + folder files) so the picker
      // matches exactly what the course holds now.
      var _courseFileNames = {};
      (course.files || []).forEach(function (f) { if (f && f.name) _courseFileNames[f.name] = true; });
      (course.userFolders || []).forEach(function (fd) {
        (fd.files || []).forEach(function (f) { if (f && f.name) _courseFileNames[f.name] = true; });
      });
      if (Object.keys(_courseFileNames).length) {
        docs = (docs || []).filter(function (d) {
          return !!_courseFileNames[d.file_name || d.fileName || ''];
        });
      }

      // Group docs by folder using course.userFolders
      var fileToFolder = {};
      (course.userFolders || []).forEach(function (fd) {
        (fd.files || []).forEach(function (f) { fileToFolder[f.name] = fd.name; });
      });

      var folderMap = {};
      var folderOrder = [];
      var ungrouped = [];
      docs.forEach(function (d) {
        var fn = d.file_name || d.fileName || '';
        var folder = fileToFolder[fn];
        if (folder) {
          if (!folderMap[folder]) { folderMap[folder] = []; folderOrder.push(folder); }
          folderMap[folder].push(d);
        } else {
          ungrouped.push(d);
        }
      });

      function itemHtml(d) {
        return '<label class="qzsp-item">' +
          '<input type="checkbox" class="qzsp-cb" value="' + _esc(d.id) + '" checked>' +
          '<span class="qzsp-name">' + _esc(d.file_name || d.fileName || 'Untitled') + '</span>' +
        '</label>';
      }

      function folderSectionHtml(name, icon, fdDocs, idx) {
        return '<div class="qzsp-folder" data-fi="' + idx + '">' +
          '<div class="qzsp-folder-header">' +
            '<span class="qzsp-folder-toggle">&#x25B8;</span>' +
            '<span class="qzsp-folder-icon">' + icon + '</span>' +
            '<span class="qzsp-folder-name">' + _esc(name) + '</span>' +
            '<span class="qzsp-folder-count">' + fdDocs.length + ' file' + (fdDocs.length !== 1 ? 's' : '') + '</span>' +
            '<button class="qzsp-folder-selall" data-folder-act="all" type="button">Select all</button>' +
            '<button class="qzsp-folder-selall qzsp-folder-clear" data-folder-act="none" type="button">Clear</button>' +
          '</div>' +
          '<div class="qzsp-folder-files" style="display:none">' +
            fdDocs.map(itemHtml).join('') +
          '</div>' +
        '</div>';
      }

      var sectionsHtml = folderOrder.map(function (fn, i) {
        return folderSectionHtml(fn, '&#x1F4C1;', folderMap[fn], i);
      }).join('');
      if (ungrouped.length) {
        sectionsHtml += folderSectionHtml('Other files', '&#x1F4C4;', ungrouped, 'u');
      }

      var overlay = document.createElement('div');
      overlay.id = 'qzSourcePickerOverlay';
      overlay.className = 'qzsp-overlay';
      overlay.innerHTML =
        '<div class="qzsp-modal">' +
          '<div class="qzsp-head"><span class="qzsp-title">Choose source files</span>' +
            '<button class="qzsp-close" type="button">&#x2715;</button></div>' +
          '<p class="qzsp-sub">Select which indexed files to use for flashcard generation.</p>' +
          '<div class="qzsp-list qzsp-folder-list">' + sectionsHtml + '</div>' +
          '<div class="qzsp-actions">' +
            '<button class="qzsp-btn-ghost" id="qzspSelectAll" type="button">Select all</button>' +
            '<button class="qzsp-btn-ghost" id="qzspClearAll" type="button">Clear</button>' +
            '<button class="qzsp-btn-primary" id="qzspConfirm" type="button">Generate from selected</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      // Auto-expand all folders on open
      overlay.querySelectorAll('.qzsp-folder-header').forEach(function (header) {
        var files = header.nextElementSibling;
        if (files) { files.style.display = 'flex'; header.classList.add('open'); header.querySelector('.qzsp-folder-toggle').innerHTML = '&#x25BE;'; }
      });

      overlay.querySelectorAll('.qzsp-folder-header').forEach(function (header) {
        header.addEventListener('click', function (e) {
          if (e.target.closest('[data-folder-act]')) return;
          var files = header.nextElementSibling;
          var open = files.style.display !== 'none';
          files.style.display = open ? 'none' : 'flex';
          header.querySelector('.qzsp-folder-toggle').innerHTML = open ? '&#x25B8;' : '&#x25BE;';
          header.classList.toggle('open', !open);
        });
      });

      overlay.querySelectorAll('[data-folder-act]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var checked = btn.getAttribute('data-folder-act') === 'all';
          btn.closest('.qzsp-folder').querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = checked; });
        });
      });

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
        count: Math.min(settings.count || 10, 10),
        difficulty: settings.difficulty || 'medium',
        topic: null,
        seenItems: _seenCards()
      };
      if (documentIds && documentIds.length) genOpts.documentIds = documentIds;
      options.generate(course.id, 'flashcards', genOpts).then(function (result) {
        // Drop cards with missing/blank front or back before counting —
        // otherwise an item that slipped past backend validation lands in
        // the deck as a card that renders empty when flipped.
        if (result && Array.isArray(result.items)) {
          result.items = result.items.filter(function (c) {
            return c && (c.front || '').toString().trim() && (c.back || '').toString().trim();
          });
        }
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
    // Deck progress (last_studied_at / study_progress) is soft metadata, not
    // something that needs a DB write on every single flip/next/rate. Writing
    // per interaction turned rapid (or accidentally repeated) study actions into
    // a flashcard_decks PATCH storm that exhausted the connection pool. Update
    // local state immediately and debounce the persistence into one trailing
    // write per burst.
    var _bumpTimers = {};
    function bumpStudied(d) {
      if (!d) return;
      d.lastStudied = new Date().toISOString();
      if (!d._dbId) return;
      var key = d._dbId;
      if (_bumpTimers[key]) clearTimeout(_bumpTimers[key]);
      _bumpTimers[key] = setTimeout(function () {
        delete _bumpTimers[key];
        _dbUpdateDeck(d._dbId, { last_studied_at: d.lastStudied, study_progress: d.progress || 0, updated_at: d.lastStudied });
      }, 1200);
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
      if (d.studyOrder && d.studyOrder.length) d.pos = Math.max(0, (d.pos || 0) - 1);
      else d.progress = Math.max(0, (d.progress || 0) - 1);
      d.flipped = false;
      bumpStudied(d);
      renderStudy();
    });
    if (els.next) els.next.addEventListener('click', function () {
      var d = state.decks.find(function (x) { return x.id === state.activeId; });
      if (!d) return;
      if (d.studyOrder && d.studyOrder.length) d.pos = Math.min(d.studyOrder.length - 1, (d.pos || 0) + 1);
      else d.progress = Math.min(d.cards.length - 1, (d.progress || 0) + 1);
      d.flipped = false;
      bumpStudied(d);
      renderStudy();
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

    root._resetToGrid = function () { state.activeId = null; renderAll(); };
    els.viewBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        els.viewBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      });
    });

    // Load from DB then render. A failed load (rows === null) must NOT set
    // _loaded — otherwise the empty result is cached for the session and the
    // user's decks vanish until a full reload. Show a retry instead.
    function _loadDecks() {
      if (els.grid) els.grid.innerHTML = '<div class="fc-empty">Loading decks…</div>';
      _dbLoadDecks(course.id).then(function(rows) {
        if (rows === null) {
          if (els.grid) {
            els.grid.innerHTML =
              '<div class="fc-empty">Couldn\'t load your decks — check your connection. ' +
              '<button type="button" class="fc-retry-load">Retry</button></div>';
            var rb = els.grid.querySelector('.fc-retry-load');
            if (rb) rb.addEventListener('click', _loadDecks);
          }
          return;
        }
        state._loaded = true;
        // Defensive: legacy decks can contain cards with missing/blank
        // front or back (saved before backend validation rejected them).
        // Drop them so flipping doesn't reveal an empty card.
        var _validCard = function (c) {
          return c && (c.front || '').toString().trim() && (c.back || '').toString().trim();
        };
        state.decks = rows.map(function(r) {
          return {
            id: r.id,
            _dbId: r.id,
            name: r.name,
            cards: (r.cards || []).filter(_validCard),
            createdAt: new Date(r.created_at).getTime(),
            lastStudied: r.last_studied_at || null,
            progress: r.study_progress || 0,
            flipped: false
          };
        });
        state.activeId = null;
        renderAll();
      });
    }

    if (!state._loaded) {
      _loadDecks();
    } else {
      state.activeId = null;
      renderAll();
    }
  }
})();
