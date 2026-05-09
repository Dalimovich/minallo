// Quiz feature — mirrors flashcards UI with AI generation.

(function () {
  var TEMPLATE_URL = 'features/quiz/quiz.html';
  var _templatePromise = null;

  // courseId -> { quizzes: [{id,name,items,answers,submitted,createdAt,lastTaken,progress,bestScore,_dbId}], activeId, _loaded }
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

  function _dbLoadQuizzes(courseId) {
    var url = _supaUrl() + '/rest/v1/quiz_runs?course_id=eq.' + encodeURIComponent(courseId) + '&order=created_at.desc&limit=50';
    return fetch(url, { headers: _supaHeaders() })
      .then(function(r) { return r.ok ? r.json() : []; })
      .catch(function() { return []; });
  }

  function _dbSaveQuiz(courseId, quiz) {
    var uid = _userId();
    if (!uid) return Promise.resolve(null);
    var payload = { user_id: uid, course_id: courseId, name: quiz.name, items: quiz.items };
    return fetch(_supaUrl() + '/rest/v1/quiz_runs', {
      method: 'POST',
      headers: Object.assign({}, _supaHeaders(), { 'Prefer': 'return=representation' }),
      body: JSON.stringify(payload)
    }).then(function(r) { return r.ok ? r.json() : null; })
      .then(function(rows) { return rows && rows[0] ? rows[0].id : null; })
      .catch(function() { return null; });
  }

  function _dbUpdateQuiz(dbId, patch) {
    if (!dbId) return;
    fetch(_supaUrl() + '/rest/v1/quiz_runs?id=eq.' + dbId, {
      method: 'PATCH',
      headers: Object.assign({}, _supaHeaders(), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(patch)
    }).catch(function() {});
  }

  function _fetchTemplate(attemptsLeft) {
    return fetch(TEMPLATE_URL + '?v=' + Date.now())
      .then(function (r) {
        if (!r.ok) throw new Error('Template fetch failed: ' + r.status);
        return r.text();
      })
      .then(function (html) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var root = tmp.querySelector('[data-quiz-root]');
        if (!root) throw new Error('No quiz root in template');
        return root.outerHTML;
      })
      .catch(function (err) {
        if (attemptsLeft > 0) {
          return new Promise(function (res) { setTimeout(res, 1500); })
            .then(function () { return _fetchTemplate(attemptsLeft - 1); });
        }
        throw err;
      });
  }

  function _loadTemplate() {
    if (_templatePromise) return _templatePromise;
    _templatePromise = _fetchTemplate(3)
      .catch(function () { _templatePromise = null; return '<div class="qz-empty">Failed to load quiz UI — click the Quiz tab to retry.</div>'; });
    return _templatePromise;
  }

  window.mountQuiz = function (target, course, options) {
    if (!target) return Promise.resolve();
    options = options || {};
    return _loadTemplate().then(function (html) {
      target.innerHTML = html;
      var root = target.querySelector('[data-quiz-root]');
      if (!root) {
        // Template failed — clear mount flag so next tab click retries
        delete target.dataset.qzMounted;
        return;
      }
      _initShell(root, course, options);
    });
  };

  window.resetQuizToGrid = function (target) {
    if (!target) return;
    var root = target.querySelector('[data-quiz-root]');
    if (root && root._resetToGrid) root._resetToGrid();
  };

  function _getStateFor(courseId) {
    if (!_state[courseId]) _state[courseId] = { quizzes: [], activeId: null };
    return _state[courseId];
  }

  function _toast(title, body) {
    if (typeof window.showToast === 'function') window.showToast(title, body);
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _statusLabel(quiz) {
    if (!quiz.lastTaken) return { cls: 'never', text: 'Not started' };
    var diff = Date.now() - new Date(quiz.lastTaken).getTime();
    if (diff < 86400000) return { cls: 'recent', text: 'Last taken today' };
    if (diff < 172800000) return { cls: 'stale', text: 'Last taken yesterday' };
    var days = Math.floor(diff / 86400000);
    return { cls: 'stale', text: 'Last taken ' + days + ' days ago' };
  }

  function _showScorePopup(root, q, correct, onRetry) {
    var existing = root.querySelector('.qz-score-popup');
    if (existing) existing.remove();
    var total = q.items.length;
    var pct = Math.round((correct / total) * 100);
    var grade = pct >= 90 ? '&#x1F3C6; Excellent!' : pct >= 70 ? '&#x1F44D; Good job!' : pct >= 50 ? '&#x1F4DA; Keep studying' : '&#x1F4AA; Try again';
    var popup = document.createElement('div');
    popup.className = 'qz-score-popup';
    popup.innerHTML =
      '<div class="qz-score-inner">' +
        '<button class="qz-score-close" type="button">&#x2715;</button>' +
        '<div class="qz-score-emoji">' + (pct >= 70 ? '&#x1F389;' : '&#x1F4D6;') + '</div>' +
        '<div class="qz-score-title">Quiz complete!</div>' +
        '<div class="qz-score-num">' + correct + ' / ' + total + '</div>' +
        '<div class="qz-score-pct">' + pct + '%</div>' +
        '<div class="qz-score-grade">' + grade + '</div>' +
        '<button class="qz-score-retry qz-btn qz-btn-primary" type="button">&#x1F501; Retry quiz</button>' +
      '</div>';
    var pane = root.querySelector('#qzStudyPane');
    if (pane) pane.appendChild(popup);
    popup.querySelector('.qz-score-close').onclick = function() { popup.remove(); };
    popup.querySelector('.qz-score-retry').onclick = function() {
      popup.remove();
      if (onRetry) onRetry();
    };
  }

  function _initShell(root, course, options) {
    var courseId = (course && course.id) || 'unknown';
    if (course && course.id) root.dataset.courseId = course.id;
    var state = _getStateFor(courseId);
    var _viewMode = 'grid'; // 'grid' | 'list'

    var els = {
      grid:         root.querySelector('#qzDeckGrid'),
      viewAll:      root.querySelector('#qzViewAllRow'),
      generate:     root.querySelector('#qzGenerateBtn'),
      newQuiz:      root.querySelector('#qzNewQuizBtn'),
      search:       root.querySelector('#qzSearchInput'),
      sort:         root.querySelector('#qzSortSelect'),
      studyName:    root.querySelector('#qzStudyName'),
      studyCount:   root.querySelector('#qzStudyCount'),
      settingsBtn:  root.querySelector('#qzStudySettingsBtn'),
      cardStage:    root.querySelector('#qzCardStage'),
      options:      root.querySelector('#qzOptions'),
      progressBar:  root.querySelector('#qzProgressBar'),
      progressLabel:root.querySelector('#qzProgressLabel'),
      prev:         root.querySelector('#qzPrevBtn'),
      submit:       root.querySelector('#qzSubmitBtn'),
      next:         root.querySelector('#qzNextBtn')
    };

    // ── View toggle ──
    root.querySelectorAll('.qz-view-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _viewMode = btn.getAttribute('data-view');
        root.querySelectorAll('.qz-view-btn').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-view') === _viewMode);
        });
        if (els.grid) els.grid.classList.toggle('list-view', _viewMode === 'list');
        renderGrid();
      });
    });

    // ── Grid pane ──
    function renderGrid() {
      if (!els.grid) return;
      var query = (els.search && els.search.value || '').trim().toLowerCase();
      var sortBy = (els.sort && els.sort.value) || 'recent';
      var quizzes = state.quizzes.slice();

      if (query) quizzes = quizzes.filter(function (q) {
        return (q.name || '').toLowerCase().indexOf(query) !== -1;
      });

      quizzes.sort(function (a, b) {
        if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
        if (sortBy === 'score') {
          var aS = a.bestScore != null ? a.bestScore / (a.items.length || 1) : -1;
          var bS = b.bestScore != null ? b.bestScore / (b.items.length || 1) : -1;
          return bS - aS;
        }
        if (sortBy === 'created') return (b.createdAt || 0) - (a.createdAt || 0);
        var aT = a.lastTaken ? new Date(a.lastTaken).getTime() : 0;
        var bT = b.lastTaken ? new Date(b.lastTaken).getTime() : 0;
        return bT - aT;
      });

      if (!quizzes.length) {
        els.grid.innerHTML =
          '<div class="qz-empty">' +
          (state.quizzes.length
            ? 'No quizzes match your search.'
            : 'No quizzes yet. Click <strong>Generate quiz</strong> to make one from this course\'s material.') +
          '</div>';
        return;
      }

      els.grid.innerHTML = quizzes.map(function (q) {
        var isActive = q.id === state.activeId;
        var st = _statusLabel(q);
        var scoreHtml = q.bestScore != null
          ? '<div class="qz-deck-score' + ((q.bestScore / (q.items.length || 1)) < 0.5 ? ' low' : '') + '">' +
              'Best: ' + q.bestScore + ' / ' + q.items.length +
            '</div>'
          : '';
        return (
          '<div class="qz-deck-card' + (isActive ? ' active' : '') + '" data-quiz-id="' + _esc(q.id) + '">' +
            '<button class="qz-deck-menu-btn" data-quiz-delete="' + _esc(q.id) + '" title="Delete quiz">&#x22EE;</button>' +
            '<span class="qz-deck-icon">&#x1F4CB;</span>' +
            '<div class="qz-deck-name">' + _esc(q.name) + '</div>' +
            '<div class="qz-deck-count">' + q.items.length + ' questions</div>' +
            '<div class="qz-deck-status">' +
              '<span class="qz-deck-status-dot ' + st.cls + '"></span>' + _esc(st.text) +
            '</div>' +
            scoreHtml +
            '<div class="qz-deck-actions">' +
              '<button class="qz-deck-btn primary" data-quiz-open="' + _esc(q.id) + '">&#x1F4D6; Open</button>' +
              '<button class="qz-deck-btn" data-quiz-rename="' + _esc(q.id) + '">&#x270F; Edit</button>' +
            '</div>' +
          '</div>'
        );
      }).join('');

      els.grid.querySelectorAll('[data-quiz-id]').forEach(function (card) {
        card.addEventListener('click', function (e) {
          if (e.target.closest('button')) return;
          selectQuiz(card.getAttribute('data-quiz-id'));
        });
      });
      els.grid.querySelectorAll('[data-quiz-open]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          selectQuiz(btn.getAttribute('data-quiz-open'));
        });
      });
      els.grid.querySelectorAll('[data-quiz-rename]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = btn.getAttribute('data-quiz-rename');
          var q = state.quizzes.find(function (x) { return x.id === id; });
          if (!q) return;
          var name = window.prompt('Rename quiz', q.name);
          if (name && name.trim()) { q.name = name.trim(); renderAll(); }
        });
      });
      els.grid.querySelectorAll('[data-quiz-delete]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = btn.getAttribute('data-quiz-delete');
          var q = state.quizzes.find(function (x) { return x.id === id; });
          if (!q || !window.confirm('Delete quiz "' + q.name + '"?')) return;
          state.quizzes = state.quizzes.filter(function (x) { return x.id !== id; });
          if (state.activeId === id) state.activeId = state.quizzes.length ? state.quizzes[0].id : null;
          renderAll();
        });
      });
    }

    function selectQuiz(id) {
      state.activeId = id;
      var q = state.quizzes.find(function (x) { return x.id === id; });
      if (q) { q.progress = 0; q.answers = {}; q.submitted = {}; }
      renderAll();
    }

    // ── Study pane ──
    function renderStudy() {
      var q = state.quizzes.find(function (x) { return x.id === state.activeId; });

      if (!q || !q.items.length) {
        if (els.studyName) els.studyName.textContent = q ? q.name : 'Select a quiz';
        if (els.studyCount) els.studyCount.textContent = '';
        if (els.cardStage) {
          els.cardStage.className = 'qz-card-stage empty';
          els.cardStage.innerHTML = '<div class="qz-card-empty">' + (q ? 'This quiz has no questions.' : 'Pick a quiz to start.') + '</div>';
        }
        if (els.options) els.options.innerHTML = '';
        if (els.progressBar) els.progressBar.style.width = '0%';
        if (els.progressLabel) els.progressLabel.textContent = '0 / 0';
        [els.prev, els.submit, els.next].forEach(function (b) { if (b) b.disabled = true; });
        return;
      }

      if (els.studyName) els.studyName.textContent = q.name;
      if (els.studyCount) els.studyCount.textContent = q.items.length + ' questions';

      var idx = Math.max(0, Math.min(q.progress || 0, q.items.length - 1));
      var item = q.items[idx];
      var answered = q.answers[idx];
      var isSubmitted = !!q.submitted[idx];

      // Question card
      if (els.cardStage) {
        els.cardStage.className = 'qz-card-stage';
        var courseLabel = (course && course.name) ? course.name.toUpperCase() : 'COURSE';
        els.cardStage.innerHTML =
          '<div class="qz-card-pill">Question ' + (idx + 1) + ' / ' + q.items.length + '</div>' +
          '<div class="qz-card-source">' + _esc(courseLabel) + '</div>' +
          '<div class="qz-card-question">' + _esc(item.question) + '</div>';
      }

      // Options
      if (els.options) {
        var letters = ['A', 'B', 'C', 'D'];
        els.options.innerHTML = (item.options || []).map(function (opt, i) {
          var cls = 'qz-option';
          if (isSubmitted) {
            if (i === item.answer) cls += ' correct';
            else if (i === answered) cls += ' incorrect';
          } else if (i === answered) {
            cls += ' selected';
          }
          return (
            '<button class="' + cls + '" data-opt-idx="' + i + '"' + (isSubmitted ? ' disabled' : '') + '>' +
              '<span class="qz-option-letter">' + _esc(letters[i] || String(i + 1)) + '</span>' +
              '<span>' + _esc(opt) + '</span>' +
            '</button>'
          );
        }).join('');

        // Explanation after submit
        if (isSubmitted && item.explanation) {
          els.options.innerHTML +=
            '<div class="qz-explanation">&#x1F4A1; ' + _esc(item.explanation) + '</div>';
        }

        // Render math in question + options (ensure KaTeX loaded first)
        var _mathEls = [els.cardStage, els.options].filter(Boolean);
        var _doMath = function() {
          if (!window.renderMathInElement) return;
          var _katexOpts = { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }], throwOnError: false };
          _mathEls.forEach(function(el) { try { renderMathInElement(el, _katexOpts); } catch(e) {} });
        };
        if (window.renderMathInElement) { _doMath(); }
        else if (window._ssEnsureKatex) { window._ssEnsureKatex().then(_doMath).catch(function(){}); }

        if (!isSubmitted) {
          els.options.querySelectorAll('[data-opt-idx]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              q.answers[idx] = parseInt(btn.getAttribute('data-opt-idx'), 10);
              renderStudy();
            });
          });
        }
      }

      // Progress
      var pct = ((idx + 1) / q.items.length) * 100;
      if (els.progressBar) els.progressBar.style.width = pct + '%';
      if (els.progressLabel) els.progressLabel.textContent = (idx + 1) + ' / ' + q.items.length;
      if (els.prev) els.prev.disabled = idx === 0;
      if (els.next) els.next.disabled = idx >= q.items.length - 1;
      if (els.submit) {
        els.submit.disabled = answered == null;
        if (isSubmitted) {
          els.submit.textContent = '✓ Submitted';
          els.submit.className = 'qz-btn qz-btn-submit submitted';
          els.submit.disabled = true;
        } else {
          els.submit.textContent = 'Submit';
          els.submit.className = 'qz-btn qz-btn-submit';
          els.submit.disabled = answered == null;
        }
      }
    }

    function renderAll() { renderGrid(); renderStudy(); }

    // ── Controls ──
    if (els.prev) els.prev.addEventListener('click', function () {
      var q = state.quizzes.find(function (x) { return x.id === state.activeId; });
      if (!q) return;
      q.progress = Math.max(0, (q.progress || 0) - 1);
      renderAll();
    });
    if (els.next) els.next.addEventListener('click', function () {
      var q = state.quizzes.find(function (x) { return x.id === state.activeId; });
      if (!q) return;
      q.progress = Math.min(q.items.length - 1, (q.progress || 0) + 1);
      renderAll();
    });
    if (els.submit) els.submit.addEventListener('click', function () {
      var q = state.quizzes.find(function (x) { return x.id === state.activeId; });
      if (!q) return;
      var idx = q.progress || 0;
      if (q.answers[idx] == null || q.submitted[idx]) return;
      q.submitted[idx] = true;
      q.lastTaken = new Date().toISOString();
      var correct = 0;
      q.items.forEach(function (_, k) {
        if (q.submitted[k] && q.answers[k] === q.items[k].answer) correct++;
      });
      if (q.bestScore == null || correct > q.bestScore) q.bestScore = correct;
      renderAll();

      // Check if all questions submitted — save to DB and show score popup
      var allDone = q.items.every(function(_, k) { return !!q.submitted[k]; });
      if (allDone) {
        var score = correct / q.items.length;
        _dbUpdateQuiz(q._dbId, {
          answers: q.answers,
          score: score,
          completed_at: q.lastTaken,
          updated_at: new Date().toISOString()
        });
        _showScorePopup(root, q, correct, function() {
          q.progress = 0; q.answers = {}; q.submitted = {};
          renderAll();
        });
      } else {
        // Save partial progress
        _dbUpdateQuiz(q._dbId, { answers: q.answers, updated_at: new Date().toISOString() });
      }
    });

    // ── Generation settings (persisted to localStorage per course) ──
    var _settingsKey = 'ss_quiz_settings_' + courseId;
    var _historyKey  = 'ss_quiz_history_reset_' + courseId;

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

    function _seenQuestions() {
      var resetAt = _getHistoryResetAt();
      var seen = [];
      state.quizzes.forEach(function(q) {
        if (resetAt && q.createdAt && q.createdAt < resetAt) return;
        q.items.forEach(function(item) { if (item.question) seen.push(item.question); });
      });
      return seen.slice(0, 60);
    }

    function _showSettingsModal(onConfirm) {
      var existing = document.getElementById('qzSettingsOverlay');
      if (existing) existing.remove();
      var s = _loadSettings();
      var count = s.count || 10;
      var diff  = s.difficulty || 'medium';

      var overlay = document.createElement('div');
      overlay.id = 'qzSettingsOverlay';
      overlay.className = 'qzsp-overlay';
      overlay.innerHTML =
        '<div class="qzsp-modal qzsp-settings">' +
          '<div class="qzsp-head">' +
            '<span class="qzsp-title">&#x2699;&#xFE0F; Quiz settings</span>' +
            '<button class="qzsp-close" type="button">&#x2715;</button>' +
          '</div>' +
          '<div class="qzsp-settings-body">' +
            '<label class="qzsp-label">Number of questions</label>' +
            '<div class="qzsp-count-row">' +
              '<input type="range" id="qzCountSlider" min="3" max="15" value="' + count + '" class="qzsp-slider">' +
              '<span id="qzCountVal" class="qzsp-count-val">' + count + '</span>' +
            '</div>' +
            '<label class="qzsp-label">Difficulty</label>' +
            '<div class="qzsp-diff-row">' +
              ['easy','medium','hard'].map(function(d) {
                return '<label class="qzsp-diff-opt' + (diff === d ? ' active' : '') + '">' +
                  '<input type="radio" name="qzDiff" value="' + d + '"' + (diff === d ? ' checked' : '') + '>' +
                  d.charAt(0).toUpperCase() + d.slice(1) +
                '</label>';
              }).join('') +
            '</div>' +
            '<button class="qzsp-btn-ghost qzsp-reset-btn" id="qzResetHistory" type="button">&#x1F504; Reset question history</button>' +
            '<p class="qzsp-reset-hint">Allows the AI to regenerate questions you\'ve already seen.</p>' +
          '</div>' +
          '<div class="qzsp-actions">' +
            '<button class="qzsp-btn-primary" id="qzSettingsConfirm" type="button">&#x2728; Generate quiz</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      var slider = overlay.querySelector('#qzCountSlider');
      var countVal = overlay.querySelector('#qzCountVal');
      slider.addEventListener('input', function() { countVal.textContent = slider.value; });

      overlay.querySelectorAll('.qzsp-diff-opt').forEach(function(lbl) {
        lbl.addEventListener('click', function() {
          overlay.querySelectorAll('.qzsp-diff-opt').forEach(function(l) { l.classList.remove('active'); });
          lbl.classList.add('active');
        });
      });

      overlay.querySelector('#qzResetHistory').addEventListener('click', function() {
        _resetHistory();
        _toast('History reset', 'The AI will generate fresh questions next time.');
      });

      overlay.querySelector('.qzsp-close').onclick = function() { overlay.remove(); };
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

      overlay.querySelector('#qzSettingsConfirm').onclick = function() {
        var selDiff = overlay.querySelector('input[name="qzDiff"]:checked');
        var settings = {
          count: parseInt(slider.value, 10),
          difficulty: selDiff ? selDiff.value : 'medium'
        };
        _saveSettings(settings);
        overlay.remove();
        onConfirm(settings);
      };
    }

    if (els.settingsBtn) els.settingsBtn.addEventListener('click', function () {
      _showSettingsModal(function(settings) {
        _pickSourcesThenGenerate(settings);
      });
    });

    if (els.viewAll) els.viewAll.addEventListener('click', function () {
      // No-op — all quizzes already shown; could expand in future
    });

    // ── Generate ──
    function defaultName() {
      return (course && course.name ? course.name : 'Quiz') + ' — Set ' + (state.quizzes.length + 1);
    }

    function _pickSourcesThenGenerate(settings) {
      if (!options.generate) { _toast('Generation unavailable', 'Generator function not injected.'); return; }
      var BACKEND_URL = window.BACKEND_URL || '';
      var token = window._sbToken || '';
      fetch(BACKEND_URL + '/api/documents/list?courseId=' + encodeURIComponent(courseId), {
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

      // Group docs by folder using course.userFolders
      var fileToFolder = {};
      (course.userFolders || []).forEach(function (fd) {
        (fd.files || []).forEach(function (f) { fileToFolder[f.name] = fd.name; });
      });

      var folderMap = {}; // folderName -> [doc]
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
            '<button class="qzsp-folder-selall" type="button">Select all</button>' +
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
          '<div class="qzsp-head"><span class="qzsp-title">&#x1F4C2; Choose source files</span>' +
            '<button class="qzsp-close" type="button">&#x2715;</button></div>' +
          '<p class="qzsp-sub">Select which indexed files to use for quiz generation.</p>' +
          '<div class="qzsp-list qzsp-folder-list">' + sectionsHtml + '</div>' +
          '<div class="qzsp-actions">' +
            '<button class="qzsp-btn-ghost" id="qzspSelectAll" type="button">Select all</button>' +
            '<button class="qzsp-btn-ghost" id="qzspClearAll" type="button">Clear</button>' +
            '<button class="qzsp-btn-primary" id="qzspConfirm" type="button">&#x2728; Generate from selected</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(overlay);

      // Toggle expand/collapse
      overlay.querySelectorAll('.qzsp-folder-header').forEach(function (header) {
        header.addEventListener('click', function (e) {
          if (e.target.classList.contains('qzsp-folder-selall')) return;
          var files = header.nextElementSibling;
          var open = files.style.display !== 'none';
          files.style.display = open ? 'none' : 'block';
          header.querySelector('.qzsp-folder-toggle').innerHTML = open ? '&#x25B8;' : '&#x25BE;';
          header.classList.toggle('open', !open);
        });
      });

      // Per-folder select all
      overlay.querySelectorAll('.qzsp-folder-selall').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          btn.closest('.qzsp-folder').querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = true; });
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
      el.id = 'qzGenOverlay';
      el.className = 'gen-overlay';
      el.innerHTML =
        '<div class="gen-overlay-box">' +
          '<div class="gen-overlay-spinner"></div>' +
          '<div class="gen-overlay-title">Generating quiz…</div>' +
          '<div class="gen-overlay-sub">Reading your course files and building questions</div>' +
        '</div>';
      document.body.appendChild(el);
    }
    function _hideGeneratingOverlay() {
      var el = document.getElementById('qzGenOverlay');
      if (el) el.remove();
    }

    function doGenerate(documentIds, settings) {
      if (!options.generate) {
        _toast('Generation unavailable', 'Generator function not injected.');
        return;
      }
      settings = settings || _loadSettings();
      if (els.generate) {
        els.generate.disabled = true;
        els.generate._origLabel = els.generate.innerHTML;
        els.generate.innerHTML = '<span class="qz-btn-icon">&#x23F3;</span> Generating…';
      }
      _showGeneratingOverlay();
      var genOpts = {
        count: settings.count || 10,
        difficulty: settings.difficulty || 'medium',
        topic: null,
        seenItems: _seenQuestions()
      };
      if (documentIds && documentIds.length) genOpts.documentIds = documentIds;
      options.generate(courseId, 'quiz', genOpts)
        .then(function (result) {
          // If nothing new, shuffle existing questions into a fresh quiz
          if (!result || !result.items || !result.items.length) {
            var allExisting = [];
            state.quizzes.forEach(function(q) { allExisting = allExisting.concat(q.items); });
            if (allExisting.length) {
              var shuffled = allExisting.slice().sort(function() { return Math.random() - 0.5; });
              result = { items: shuffled.slice(0, genOpts.count) };
              _toast('Shuffled existing questions', 'No new material found — showing a mix of your previous questions.');
            } else {
              _toast('Nothing generated', (result && result.error) || 'No indexed content yet — upload and index a PDF first.');
              return;
            }
          }
          var letters = ['A', 'B', 'C', 'D'];
          var quiz = {
            id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            name: defaultName(),
            items: result.items.map(function (item) {
              // Normalize options: backend returns {A,B,C,D} object; convert to array
              var opts;
              if (Array.isArray(item.options)) {
                opts = item.options;
              } else {
                opts = letters.map(function (l) { return (item.options && item.options[l]) || ''; });
              }
              // Normalize answer: backend returns letter string "A"-"D"; convert to index
              var ansIdx = 0;
              if (typeof item.answer === 'number') {
                ansIdx = item.answer;
              } else if (typeof item.answer === 'string') {
                var li = letters.indexOf(item.answer.toUpperCase());
                ansIdx = li >= 0 ? li : 0;
              }
              return {
                question: item.question || '',
                options: opts,
                answer: ansIdx,
                explanation: item.explanation || '',
                source: item.source || ''
              };
            }),
            createdAt: Date.now(),
            lastTaken: null,
            progress: 0,
            answers: {},
            submitted: {},
            bestScore: null
          };
          state.quizzes.unshift(quiz);
          state.activeId = quiz.id;
          _toast('Quiz generated ✨', quiz.items.length + ' questions ready.');
          renderAll();
          // Save to DB and update local ID with UUID
          _dbSaveQuiz(courseId, quiz).then(function(dbId) {
            if (dbId) { quiz.id = dbId; quiz._dbId = dbId; state.activeId = dbId; }
          });
        })
        .catch(function (err) {
          console.error('quiz generate error:', err);
          _toast('Generation failed', 'Try again, or reindex your PDFs first.');
        })
        .finally(function () {
          _hideGeneratingOverlay();
          if (els.generate) {
            els.generate.disabled = false;
            els.generate.innerHTML = els.generate._origLabel ||
              '<span class="qz-btn-icon">&#x2728;</span> Generate quiz';
          }
        });
    }

    if (els.generate) els.generate.addEventListener('click', function() {
      _showSettingsModal(function(settings) { _pickSourcesThenGenerate(settings); });
    });

    if (els.newQuiz) els.newQuiz.addEventListener('click', function () {
      var name = window.prompt('Name for new quiz', defaultName());
      if (!name) return;
      var quiz = {
        id: 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        name: name.trim(),
        items: [],
        createdAt: Date.now(),
        lastTaken: null,
        progress: 0,
        answers: {},
        submitted: {},
        bestScore: null
      };
      state.quizzes.unshift(quiz);
      state.activeId = quiz.id;
      renderAll();
    });

    if (els.search) els.search.addEventListener('input', renderGrid);
    if (els.sort)   els.sort.addEventListener('change', renderGrid);

    root._resetToGrid = function () { state.activeId = null; renderAll(); };

    // Load from DB then render
    if (!state._loaded) {
      if (els.grid) els.grid.innerHTML = '<div class="qz-empty">Loading quizzes…</div>';
      _dbLoadQuizzes(courseId).then(function(rows) {
        state._loaded = true;
        state.quizzes = rows.map(function(r) {
          var answered = r.answers || {};
          var submitted = {};
          Object.keys(answered).forEach(function(k) { submitted[k] = true; });
          return {
            id: r.id,
            _dbId: r.id,
            name: r.name,
            items: r.items || [],
            answers: answered,
            submitted: submitted,
            progress: 0,
            createdAt: new Date(r.created_at).getTime(),
            lastTaken: r.completed_at || null,
            bestScore: r.score != null ? Math.round(r.score * (r.items || []).length) : null
          };
        });
        state.activeId = null;
        renderAll();
      });
    } else {
      state.activeId = null;
      renderAll();
    }
  }
})();
