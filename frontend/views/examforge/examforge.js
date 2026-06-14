// ExamForge course tool.

(function () {
  var _state = {};

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _toast(title, body) {
    if (typeof window.showToast === 'function') window.showToast(title, body);
  }

  function _service() {
    return import('/js/services/ai-service.js');
  }

  function _supaHeaders() { return window._ssDb && window._ssDb.supaHeaders ? window._ssDb.supaHeaders() : {}; }
  function _supaUrl() { return window._ssDb && window._ssDb.supaUrl ? window._ssDb.supaUrl() : ''; }

  function _deleteExamSession(sessionId, courseId) {
    if (!sessionId || String(sessionId).indexOf('local-') === 0 || !_supaUrl()) {
      return Promise.reject(new Error('This exam is not saved in the database.'));
    }
    var url = _supaUrl() + '/rest/v1/exam_sessions?id=eq.' + encodeURIComponent(sessionId) +
      '&course_id=eq.' + encodeURIComponent(courseId) + '&select=id';
    return fetch(url, {
      method: 'DELETE',
      headers: Object.assign({}, _supaHeaders(), { 'Prefer': 'return=representation' })
    }).then(function (r) {
      if (!r.ok) throw new Error('The exam could not be deleted.');
      return r.json();
    }).then(function (rows) {
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error('No matching saved exam was deleted.');
      }
    });
  }

  function _getState(courseId) {
    if (!_state[courseId]) {
      _state[courseId] = {
        sessions: [],
        activeId: null,
        answers: {},
        grades: {},
        submitted: false,
        marked: {},
        mode: 'exam',
        docs: [],
        loaded: false,
        collapsedFolders: {},
        topicSearch: '',
      };
    }
    return _state[courseId];
  }

  function _docSummary(docs) {
    var out = { ready: [], pending: 0, failed: 0, total: docs.length };
    docs.forEach(function (d) {
      if (d.processing_status === 'ready') out.ready.push(d);
      else if (d.processing_status === 'failed') out.failed++;
      else out.pending++;
    });
    return out;
  }

  function normalizeOptions(type, options) {
    if (type === 'true_false') return ['True', 'False'];
    if (Array.isArray(options)) return options;
    if (options && typeof options === 'object') {
      return ['A', 'B', 'C', 'D'].map(function (letter) { return options[letter] || ''; }).filter(Boolean);
    }
    return [];
  }

  function _normaliseSession(raw) {
    var qs = raw.questions || raw.exam_questions || [];
    return {
      id: raw.sessionId || raw.id || ('local-' + Date.now()),
      title: raw.title || 'ExamForge',
      createdAt: raw.created_at || raw.createdAt || new Date().toISOString(),
      difficulty: raw.difficulty || 'medium',
      questions: (qs || []).map(function (q, idx) {
        if (q.question_text) {
          return {
            id: q.id,
            type: q.question_type || 'mcq',
            question: q.question_text,
            options: normalizeOptions(q.question_type || 'mcq', q.options),
            answer: q.correct_answer || 'A',
            explanation: q.explanation || '',
            difficulty: q.difficulty || 'medium',
            topic: q.topic || null,
            points: q.points || 1,
            sources: (q.source_document_names || []).map(function (name, i) {
              return { fileName: name, pages: (q.source_pages || [])[i] || null };
            }),
          };
        }
        return {
          id: q.id || null,
          type: q.type || 'mcq',
          question: q.question || '',
          options: normalizeOptions(q.type || 'mcq', q.options),
          answer: q.answer || 'A',
          explanation: q.explanation || '',
          difficulty: q.difficulty || 'medium',
          topic: q.topic || null,
          points: q.points || 1,
          sources: q.sources || [],
        };
      }).filter(function (q) { return q.question; }),
      groundedSources: raw.groundedSources || [],
      warning: raw.warning || raw.error || null,
    };
  }

  var _HTML =
    '<div class="ef-root" data-examforge-root>' +
      '<div class="ef-toolbar">' +
        '<button class="ef-btn ef-btn-primary" id="efGenerateBtn" type="button">Generate exam</button>' +
        '<div class="ef-field"><label>Questions</label><select id="efCount"><option>6</option><option>8</option><option>10</option><option>12</option></select></div>' +
        '<div class="ef-field"><label>Difficulty</label><select id="efDifficulty"><option value="medium">Medium</option><option value="mixed">Mixed</option><option value="easy">Easy</option><option value="hard">Hard</option></select></div>' +
        '<div class="ef-field"><label>Language</label><select id="efLanguage"><option value="auto">Same as course</option><option value="de">Deutsch</option><option value="en">English</option></select></div>' +
      '</div>' +
      '<div class="ef-type-row" aria-label="Question types">' +
        '<label><input type="checkbox" name="efType" value="mcq" checked> MCQ</label>' +
        '<label><input type="checkbox" name="efType" value="true_false" checked> True/False</label>' +
        '<label><input type="checkbox" name="efType" value="short_answer" checked> Written</label>' +
        '<div class="ef-mode-toggle">' +
          '<button type="button" class="ef-mode-btn is-active" data-mode="exam">Exam mode</button>' +
          '<button type="button" class="ef-mode-btn" data-mode="practice">Practice mode</button>' +
        '</div>' +
      '</div>' +
      '<div class="ef-search"><input id="efTopic" type="text" placeholder="Optional topic focus" autocomplete="off"></div>' +
      '<div class="ef-layout">' +
        '<aside class="ef-side">' +
          '<div class="ef-side-head">' +
            '<div><h3>Sources</h3><p id="efDocStatus">Loading course files...</p></div>' +
            '<div class="ef-source-actions">' +
              '<button class="ef-link" id="efSelectAll" type="button">Select ready</button>' +
              '<button class="ef-link ef-link-muted" id="efClearSelection" type="button">Clear</button>' +
            '</div>' +
          '</div>' +
          '<div class="ef-docs" id="efDocs"></div>' +
          '<div class="ef-side-head ef-topics-head">' +
            '<div><h3>Topics</h3><p id="efTopicStatus">Loading topic map...</p></div>' +
            '<button class="ef-link" id="efBuildTopics" type="button">Rebuild</button>' +
          '</div>' +
          '<div class="ef-topic-search"><input id="efTopicSearch" type="text" placeholder="Search topics..." autocomplete="off"></div>' +
          '<div class="ef-topics" id="efTopicMap"></div>' +
          '<div class="ef-side-head ef-history-head">' +
            '<div><h3>Exam runs</h3><p>Latest generated practice exams</p></div>' +
          '</div>' +
          '<div class="ef-sessions" id="efSessions"></div>' +
        '</aside>' +
        '<main class="ef-main">' +
          '<div class="ef-empty" id="efEmpty">' +
            '<div class="ef-empty-icon">EF</div>' +
            '<h3>Forge an exam from this course.</h3>' +
            '<p>Select indexed files, choose the size, then generate source-grounded questions.</p>' +
          '</div>' +
          '<div class="ef-exam" id="efExam" hidden></div>' +
        '</main>' +
      '</div>' +
    '</div>';

  window.mountExamForge = function (target, course) {
    if (!target) return;
    target.innerHTML = _HTML;
    var root = target.querySelector('[data-examforge-root]');
    if (root) _init(root, course || {});
  };

  function _init(root, course) {
    var courseId = course.id || 'unknown';
    var st = _getState(courseId);
    var els = {
      gen: root.querySelector('#efGenerateBtn'),
      count: root.querySelector('#efCount'),
      difficulty: root.querySelector('#efDifficulty'),
      language: root.querySelector('#efLanguage'),
      topic: root.querySelector('#efTopic'),
      docs: root.querySelector('#efDocs'),
      docStatus: root.querySelector('#efDocStatus'),
      selectAll: root.querySelector('#efSelectAll'),
      clearSelection: root.querySelector('#efClearSelection'),
      sessions: root.querySelector('#efSessions'),
      empty: root.querySelector('#efEmpty'),
      exam: root.querySelector('#efExam'),
      topicMap: root.querySelector('#efTopicMap'),
      topicStatus: root.querySelector('#efTopicStatus'),
      topicSearch: root.querySelector('#efTopicSearch'),
      buildTopics: root.querySelector('#efBuildTopics'),
    };

    // ── Mode toggle (Exam / Practice) ──────────────────────────────────────
    root.querySelectorAll('.ef-mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        st.mode = btn.getAttribute('data-mode') || 'exam';
        root.querySelectorAll('.ef-mode-btn').forEach(function (b) {
          b.classList.toggle('is-active', b.getAttribute('data-mode') === st.mode);
        });
        renderExam();
      });
    });

    // ── Course Topic Map (Learning Agent Core) ──────────────────────────────
    var _allTopics = [];

    function groupTopics(topics) {
      var groups = {};
      var order = [];
      topics.forEach(function (t) {
        var category = t.category || 'Other';
        if (!groups[category]) {
          groups[category] = [];
          order.push(category);
        }
        groups[category].push(t);
      });
      return { groups: groups, order: order };
    }

    function renderTopicMap(topics) {
      _allTopics = topics || [];
      if (!els.topicMap) return;
      if (!_allTopics.length) {
        els.topicMap.innerHTML =
          '<p class="ef-topics-empty">No topic map yet — click Rebuild to generate one from your indexed files.</p>';
        if (els.topicStatus) els.topicStatus.textContent = 'Not built';
        return;
      }
      if (els.topicStatus) els.topicStatus.textContent = _allTopics.length + ' topics';
      filterAndRenderTopics();
    }

    function filterAndRenderTopics() {
      if (!els.topicMap) return;
      var search = st.topicSearch.toLowerCase();
      var filtered = _allTopics.filter(function (t) {
        return !search || (t.name || '').toLowerCase().indexOf(search) !== -1;
      });
      var active = (els.topic && els.topic.value || '').trim().toLowerCase();
      var grouped = groupTopics(filtered);
      var html = '';
      grouped.order.forEach(function (category) {
        var chips = grouped.groups[category];
        html += '<div class="ef-topic-group">';
        if (grouped.order.length > 1) {
          html += '<div class="ef-topic-group-label">' + _esc(category) + '</div>';
        }
        html += '<div class="ef-topic-group-chips">';
        chips.forEach(function (t) {
          var imp = t.importance || 'medium';
          var pages = (t.source_pages && t.source_pages.length) ? (' · ' + t.source_pages.length + 'p') : '';
          var title = (t.chunk_count || 0) + ' chunks · ' + imp + pages;
          var cls = 'ef-topic-chip' + (String(t.name || '').toLowerCase() === active ? ' is-active' : '');
          html += '<button type="button" class="' + cls + '" data-imp="' + _esc(imp) +
            '" data-topic="' + _esc(t.name) + '" title="' + _esc(title) + '">' + _esc(t.name) + '</button>';
        });
        html += '</div></div>';
      });
      if (!html) {
        html = '<p class="ef-topics-empty">No topics match your search.</p>';
      }
      els.topicMap.innerHTML = html;
      els.topicMap.querySelectorAll('.ef-topic-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var current = (els.topic && els.topic.value || '').trim();
          var clicked = chip.getAttribute('data-topic') || '';
          if (current === clicked) {
            if (els.topic) els.topic.value = '';
          } else {
            if (els.topic) els.topic.value = clicked;
          }
          filterAndRenderTopics();
        });
      });
    }

    if (els.topicSearch) {
      els.topicSearch.addEventListener('input', function () {
        st.topicSearch = els.topicSearch.value || '';
        filterAndRenderTopics();
      });
    }

    var _autoBuiltTopics = false;

    function loadTopicMap() {
      _service().then(function (svc) {
        return svc.getCourseTopicMap ? svc.getCourseTopicMap(courseId) : [];
      }).then(function (topics) {
        if ((!topics || !topics.length) && !_autoBuiltTopics) {
          _autoBuiltTopics = true;
          autoBuildTopicMap();
          return;
        }
        renderTopicMap(topics);
      }).catch(function () { renderTopicMap([]); });
    }

    function autoBuildTopicMap() {
      if (els.topicMap) {
        els.topicMap.innerHTML =
          '<p class="ef-topics-empty">Building your topic map from your indexed files…</p>';
      }
      if (els.topicStatus) els.topicStatus.textContent = 'Building...';
      _service().then(function (svc) {
        return svc.generateCourseTopicMap ? svc.generateCourseTopicMap(courseId) : [];
      }).then(function (topics) {
        if (topics && topics.length) { renderTopicMap(topics); return; }
        pollTopicMap(0);
      }).catch(function () { renderTopicMap([]); });
    }

    function pollTopicMap(tries) {
      setTimeout(function () {
        _service().then(function (svc) {
          return svc.getCourseTopicMap ? svc.getCourseTopicMap(courseId) : [];
        }).then(function (topics) {
          if (topics && topics.length) { renderTopicMap(topics); return; }
          if (tries < 3) { pollTopicMap(tries + 1); return; }
          renderTopicMap([]);
        }).catch(function () { renderTopicMap([]); });
      }, 3000);
    }

    function courseFolderNameFor(fileName) {
      var name = String(fileName || '').trim();
      if (!name || !course || !course.userFolders) return null;
      for (var i = 0; i < course.userFolders.length; i++) {
        var fd = course.userFolders[i];
        var files = (fd && fd.files) || [];
        for (var j = 0; j < files.length; j++) {
          if (String(files[j].name || '') === name) return fd.name || null;
        }
      }
      return null;
    }

    function groupedDocs() {
      var groups = [];
      var byName = {};
      (course.userFolders || []).forEach(function (fd) {
        var group = { name: fd.name || 'Folder', docs: [] };
        groups.push(group);
        byName[group.name] = group;
      });
      var loose = { name: 'Separate files', docs: [] };
      st.docs.forEach(function (d) {
        var folder = courseFolderNameFor(d.file_name);
        if (folder && byName[folder]) byName[folder].docs.push(d);
        else loose.docs.push(d);
      });
      return groups.filter(function (g) { return g.docs.length; }).concat(loose.docs.length ? [loose] : []);
    }

    function renderDocs() {
      var summary = _docSummary(st.docs);
      if (els.docStatus) {
        els.docStatus.textContent = summary.ready.length + ' ready' +
          (summary.pending ? ' · ' + summary.pending + ' indexing' : '') +
          (summary.failed ? ' · ' + summary.failed + ' failed' : '');
      }
      if (!els.docs) return;
      if (!st.docs.length) {
        els.docs.innerHTML = '<div class="ef-muted">No course files found yet.</div>';
        return;
      }
      var groups = groupedDocs();
      if (!groups.length) {
        els.docs.innerHTML = '<div class="ef-muted">No organized indexed files found yet.</div>';
        return;
      }
      els.docs.innerHTML = groups.map(function (group) {
        var readyCount = group.docs.filter(function (d) { return d.processing_status === 'ready'; }).length;
        var collapsed = !!st.collapsedFolders[group.name];
        return (
          '<section class="ef-doc-group' + (collapsed ? ' collapsed' : '') + '">' +
            '<button class="ef-doc-group-head" type="button" data-folder="' + _esc(group.name) + '" aria-expanded="' + (collapsed ? 'false' : 'true') + '">' +
              '<span class="ef-folder-chevron" aria-hidden="true">▸</span>' +
              '<span class="ef-folder-icon">▣</span>' +
              '<span class="ef-folder-name">' + _esc(group.name) + '</span>' +
              '<span class="ef-folder-count">' + readyCount + '/' + group.docs.length + ' ready</span>' +
            '</button>' +
            '<div class="ef-doc-group-list">' +
              group.docs.map(function (d) {
                var ready = d.processing_status === 'ready';
                var checked = ready ? ' checked' : '';
                return (
                  '<label class="ef-doc ' + (ready ? 'is-ready' : 'is-muted') + '">' +
                    '<input type="checkbox" value="' + _esc(d.id) + '"' + checked + (ready ? '' : ' disabled') + '>' +
                    '<span class="ef-doc-name">' + _esc(d.file_name || 'Untitled') + '</span>' +
                    '<span class="ef-doc-state">' + _esc(ready ? 'Ready' : (d.processing_status || 'Waiting')) + '</span>' +
                  '</label>'
                );
              }).join('') +
            '</div>' +
          '</section>'
        );
      }).join('');
      els.docs.querySelectorAll('.ef-doc-group-head').forEach(function (head) {
        head.addEventListener('click', function () {
          var name = head.getAttribute('data-folder');
          var section = head.closest('.ef-doc-group');
          var collapse = !st.collapsedFolders[name];
          st.collapsedFolders[name] = collapse;
          if (section) section.classList.toggle('collapsed', collapse);
          head.setAttribute('aria-expanded', collapse ? 'false' : 'true');
        });
      });
    }

    function renderSessions() {
      if (!els.sessions) return;
      if (!st.sessions.length) {
        els.sessions.innerHTML = '<div class="ef-muted">No ExamForge runs yet.</div>';
        return;
      }
      els.sessions.innerHTML = st.sessions.map(function (s) {
        var active = s.id === st.activeId;
        return (
          '<div class="ef-session-row' + (active ? ' active' : '') + '" data-session-row="' + _esc(s.id) + '">' +
          '<button class="ef-session" type="button" data-session="' + _esc(s.id) + '">' +
            '<span class="ef-session-title">' + _esc(s.title || 'ExamForge') + '</span>' +
            '<span class="ef-session-meta">' + s.questions.length + ' questions · ' + _esc(s.difficulty || 'medium') + '</span>' +
          '</button>' +
          '<button class="ef-session-delete" type="button" data-delete-session="' + _esc(s.id) + '" title="Delete exam" aria-label="Delete exam">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>' +
          '</button>' +
          '</div>'
        );
      }).join('');
      els.sessions.querySelectorAll('[data-session]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          st.activeId = btn.getAttribute('data-session');
          st.submitted = false;
          st.answers = {};
          st.grades = {};
          st.marked = {};
          renderAll();
        });
      });
      els.sessions.querySelectorAll('[data-delete-session]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var sessionId = btn.getAttribute('data-delete-session');
          var session = st.sessions.find(function (s) { return s.id === sessionId; });
          if (!sessionId || !session) return;
          if (!window.confirm('Delete this ExamForge run?\n\nThis removes the exam, its questions, and saved answers from the database.')) return;
          btn.disabled = true;
          _deleteExamSession(sessionId, courseId).then(function () {
            st.sessions = st.sessions.filter(function (s) { return s.id !== sessionId; });
            if (st.activeId === sessionId) {
              st.activeId = st.sessions[0] ? st.sessions[0].id : null;
              st.answers = {};
              st.grades = {};
              st.submitted = false;
              st.marked = {};
            }
            renderAll();
            _toast('Exam deleted', 'The exam was removed.');
          }).catch(function (err) {
            btn.disabled = false;
            _toast('Delete failed', err && err.message ? err.message : 'Please try again.');
          });
        });
      });
    }

    function activeSession() {
      return st.sessions.find(function (s) { return s.id === st.activeId; }) || null;
    }

    function answerLetter(idx) {
      return ['A', 'B', 'C', 'D'][idx] || 'A';
    }

    function questionTypeLabel(type) {
      if (type === 'true_false') return 'True/False';
      if (type === 'short_answer') return 'Written';
      return 'MCQ';
    }

    function selectedQuestionTypes() {
      var types = Array.from(root.querySelectorAll('input[name="efType"]:checked')).map(function (x) {
        return x.value;
      });
      return types.length ? types : ['mcq'];
    }

    function answerIsComplete(q, idx) {
      var val = st.answers[idx];
      if (q.type === 'short_answer') return !!String(val || '').trim();
      return !!val;
    }

    function objectiveCorrect(q, idx) {
      var val = st.answers[idx];
      if (q.type === 'short_answer') return false;
      return String(val || '').toLowerCase() === String(q.answer || '').toLowerCase();
    }

    function questionStatus(q, idx) {
      if (st.marked[idx]) return 'marked';
      if (answerIsComplete(q, idx)) return 'answered';
      return 'unanswered';
    }

    function computeResults(s) {
      var correct = 0;
      var earned = 0;
      var totalPoints = 0;
      var answered = 0;
      var markedCount = 0;
      var byType = { mcq: { correct: 0, total: 0 }, true_false: { correct: 0, total: 0 }, short_answer: { correct: 0, total: 0 } };
      var byTopic = {};
      s.questions.forEach(function (q, idx) {
        totalPoints += Number(q.points || 1);
        byType[q.type] = byType[q.type] || { correct: 0, total: 0 };
        byType[q.type].total++;
        var topic = q.topic || 'General';
        byTopic[topic] = byTopic[topic] || { correct: 0, total: 0 };
        byTopic[topic].total++;
        if (answerIsComplete(q, idx)) answered++;
        if (st.marked[idx]) markedCount++;
        var isCorrectQ = false;
        if (q.type === 'short_answer' && st.grades[idx]) {
          earned += Number(st.grades[idx].score || 0);
          if (st.grades[idx].isCorrect) { correct++; isCorrectQ = true; }
        } else if (objectiveCorrect(q, idx)) {
          earned += Number(q.points || 1);
          correct++;
          isCorrectQ = true;
        }
        if (isCorrectQ) {
          byType[q.type].correct++;
          byTopic[topic].correct++;
        }
      });
      return {
        correct: correct,
        earned: earned,
        totalPoints: totalPoints,
        answered: answered,
        markedCount: markedCount,
        total: s.questions.length,
        score: totalPoints ? Math.round(earned / totalPoints * 100) : 0,
        byType: byType,
        byTopic: byTopic,
      };
    }

    function renderExam() {
      var s = activeSession();
      if (!els.empty || !els.exam) return;
      els.empty.hidden = !!s;
      els.exam.hidden = !s;
      if (!s) return;
      var r = computeResults(s);
      var isExamMode = st.mode === 'exam';

      // ── Progress bar ──────────────────────────────────────────────────────
      var progressHtml =
        '<div class="ef-progress">' +
          '<span class="ef-progress-item">Answered: <b>' + r.answered + ' / ' + r.total + '</b></span>' +
          '<span class="ef-progress-item">Unanswered: <b>' + (r.total - r.answered) + '</b></span>' +
          (r.markedCount ? '<span class="ef-progress-item ef-progress-marked">Marked: <b>' + r.markedCount + '</b></span>' : '') +
        '</div>';

      els.exam.innerHTML =
        '<div class="ef-exam-head">' +
          '<div><h2>' + _esc(s.title || 'ExamForge') + '</h2><p>' + s.questions.length + ' source-grounded questions</p></div>' +
          '<div class="ef-score">' + (st.submitted ? r.score + '%' : r.answered + ' / ' + r.total) + '</div>' +
        '</div>' +
        progressHtml +
        (s.warning ? '<div class="ef-warning">' + _esc(s.warning) + '</div>' : '') +
        '<div class="ef-question-list">' +
          s.questions.map(function (q, idx) {
            var chosen = st.answers[idx] || '';
            var status = questionStatus(q, idx);
            var statusCls = ' ef-q-' + status;
            return (
              '<article class="ef-question' + statusCls + '" id="efQ' + idx + '">' +
                '<div class="ef-question-top">' +
                  '<span class="ef-q-number">Q' + (idx + 1) + '</span>' +
                  '<span>' + _esc(questionTypeLabel(q.type)) + '</span>' +
                  '<span class="ef-q-diff ef-q-diff-' + _esc(q.difficulty || 'medium') + '">' + _esc(q.difficulty || 'medium') + '</span>' +
                  (q.topic ? '<span>' + _esc(q.topic) + '</span>' : '') +
                  '<span class="ef-q-status-badge ef-q-status-' + status + '">' +
                    (status === 'answered' ? '✓ Answered' : status === 'marked' ? '⚑ Review' : '○ Unanswered') +
                  '</span>' +
                  (!st.submitted ? '<button type="button" class="ef-mark-btn' + (st.marked[idx] ? ' is-marked' : '') + '" data-mark="' + idx + '" title="Mark for review">⚑</button>' : '') +
                '</div>' +
                '<h3>' + _esc(q.question) + '</h3>' +
                renderAnswerControl(q, idx, chosen) +
                (st.submitted
                  ? renderFeedback(q, idx)
                  : '') +
                renderSources(q, isExamMode) +
              '</article>'
            );
          }).join('') +
        '</div>' +
        (st.submitted ? renderResultSummary(s, r) : '') +
        '<div class="ef-submit-row">' +
          '<button class="ef-btn ef-btn-secondary" id="efResetAnswers" type="button">Reset answers</button>' +
          '<button class="ef-btn ef-btn-primary" id="efSubmitAnswers" type="button"' + (st.submitted ? ' disabled' : '') + '>Submit exam</button>' +
        '</div>';

      // ── Event listeners ───────────────────────────────────────────────────
      els.exam.querySelectorAll('.ef-option').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (st.submitted) return;
          st.answers[Number(btn.getAttribute('data-q'))] = btn.getAttribute('data-a') || '';
          renderExam();
        });
      });
      els.exam.querySelectorAll('.ef-written').forEach(function (input) {
        input.addEventListener('input', function () {
          st.answers[Number(input.getAttribute('data-q'))] = input.value || '';
        });
      });
      els.exam.querySelectorAll('.ef-mark-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-mark'));
          st.marked[idx] = !st.marked[idx];
          renderExam();
        });
      });
      els.exam.querySelectorAll('.ef-sources .src-cite').forEach(function (el) {
        el.addEventListener('click', function () {
          var fn = el.getAttribute('data-src-file');
          if (!fn || typeof window.openCitedSource !== 'function') return;
          window.openCitedSource({ fileName: fn, page: el.getAttribute('data-src-page') }, 'popup');
        });
      });
      var reset = els.exam.querySelector('#efResetAnswers');
      if (reset) reset.addEventListener('click', function () {
        st.answers = {};
        st.grades = {};
        st.submitted = false;
        st.marked = {};
        renderExam();
      });
      var submit = els.exam.querySelector('#efSubmitAnswers');
      if (submit) submit.addEventListener('click', function () {
        var missing = s.questions.some(function (q, idx) { return !answerIsComplete(q, idx); });
        if (missing) {
          _toast('Finish the exam', 'Answer every question before submitting.');
          return;
        }
        // Grading requires a persisted session + per-question ids. A locally
        // built / unsaved exam can never be graded, so block submission.
        if (!s.id || String(s.id).indexOf('local-') === 0 ||
            s.questions.some(function (q) { return !q.id; })) {
          _toast('This exam can\'t be graded', 'It was not saved properly. Generate it again to grade it.');
          return;
        }
        st.submitted = true;
        renderExam();
        _persistAnswers(s, st.answers);
      });
    }

    function renderAnswerControl(q, idx, chosen) {
      if (q.type === 'short_answer') {
        return '<textarea class="ef-written" data-q="' + idx + '" placeholder="Write your answer..."' + (st.submitted ? ' disabled' : '') + '>' + _esc(chosen || '') + '</textarea>';
      }
      return '<div class="ef-options">' +
        (q.options || []).map(function (opt, optIdx) {
          var value = q.type === 'true_false' ? String(opt).toLowerCase() : answerLetter(optIdx);
          var label = q.type === 'true_false' ? (optIdx === 0 ? 'T' : 'F') : answerLetter(optIdx);
          var chosenHit = String(chosen || '').toLowerCase() === String(value).toLowerCase();
          var answerHit = String(value).toLowerCase() === String(q.answer || '').toLowerCase();
          var cls = chosenHit ? ' selected' : '';
          if (st.submitted && answerHit) cls += ' correct';
          if (st.submitted && chosenHit && !answerHit) cls += ' wrong';
          var icon = '';
          if (st.submitted && answerHit) icon = '<span class="ef-icon-check">✓</span>';
          if (st.submitted && chosenHit && !answerHit) icon = '<span class="ef-icon-x">✗</span>';
          return '<button class="ef-option' + cls + '" type="button" data-q="' + idx + '" data-a="' + _esc(value) + '"' + (st.submitted ? ' disabled' : '') + '><b>' + _esc(label) + '</b><span>' + _esc(opt) + '</span>' + icon + '</button>';
        }).join('') +
      '</div>';
    }

    function renderFeedback(q, idx) {
      var chosen = st.answers[idx] || '';
      if (q.type === 'short_answer') {
        var grade = st.grades[idx];
        if (!grade) {
          return '<div class="ef-feedback"><strong>Grading...</strong><span>Your written answer is being checked against the rubric.</span></div>';
        }
        return '<div class="ef-feedback ' + (grade.isCorrect ? 'ok' : 'bad') + '">' +
          '<div class="ef-grade-header"><strong>' + (grade.isCorrect ? '✓ ' : '✗ ') + _esc(String(grade.score || 0)) + ' / ' + _esc(String(q.points || 1)) + ' pt</strong></div>' +
          '<div class="ef-grade-feedback">' + _esc(grade.feedback || '') + '</div>' +
          (q.explanation ? '<div class="ef-grade-rubric"><strong>Rubric:</strong> ' + _esc(q.explanation) + '</div>' : '') +
          (q.answer ? '<div class="ef-grade-model"><strong>Model answer:</strong> ' + _esc(q.answer) + '</div>' : '') +
        '</div>';
      }
      var isCorrect = String(chosen || '').toLowerCase() === String(q.answer || '').toLowerCase();
      var isWrong = chosen && !isCorrect;
      return '<div class="ef-feedback ' + (isCorrect ? 'ok' : isWrong ? 'bad' : '') + '">' +
        '<strong>' + (isCorrect ? '✓ Correct' : '✗ Answer: ' + _esc(String(q.answer || '').toUpperCase())) + '</strong>' +
        '<span>' + _esc(q.explanation || '') + '</span>' +
      '</div>';
    }

    function renderSources(q, isExamMode) {
      if (!(q.sources || []).length) return '';
      if (isExamMode && !st.submitted) {
        return '<div class="ef-sources ef-sources-hidden"><span class="ef-source-placeholder">Source available after submission</span></div>';
      }
      return '<div class="ef-sources">' + q.sources.map(function (src) {
        return '<span class="src-cite" title="Open this source" data-src-file="' + _esc(src.fileName || '') + '" data-src-page="' + _esc(src.pages == null ? '' : src.pages) + '">' + _esc(src.fileName || 'Source') + (src.pages ? ', p.' + _esc(src.pages) : '') + '</span>';
      }).join('') + '</div>';
    }

    function renderResultSummary(s, r) {
      var typeLabels = { mcq: 'MCQ', true_false: 'True/False', short_answer: 'Written' };
      var typeHtml = '';
      ['mcq', 'true_false', 'short_answer'].forEach(function (t) {
        if (r.byType[t] && r.byType[t].total) {
          typeHtml += '<div class="ef-result-type"><span>' + typeLabels[t] + '</span><b>' + r.byType[t].correct + ' / ' + r.byType[t].total + '</b></div>';
        }
      });
      var strongTopics = [];
      var weakTopics = [];
      Object.keys(r.byTopic).forEach(function (topic) {
        var t = r.byTopic[topic];
        var pct = t.total ? (t.correct / t.total) : 0;
        if (pct >= 0.7) strongTopics.push(topic);
        else weakTopics.push(topic);
      });
      return '<div class="ef-result-summary">' +
        '<h3>Results</h3>' +
        '<div class="ef-result-score"><span>Score</span><b>' + r.score + '%</b></div>' +
        '<div class="ef-result-score"><span>Correct</span><b>' + r.correct + ' / ' + r.total + '</b></div>' +
        (typeHtml ? '<div class="ef-result-types">' + typeHtml + '</div>' : '') +
        (strongTopics.length ? '<div class="ef-result-topics"><strong>Strong topics:</strong> ' + strongTopics.map(_esc).join(', ') + '</div>' : '') +
        (weakTopics.length ? '<div class="ef-result-topics ef-result-weak"><strong>Weak topics:</strong> ' + weakTopics.map(_esc).join(', ') + '</div>' : '') +
      '</div>';
    }

    function renderAll() {
      renderDocs();
      renderSessions();
      renderExam();
    }

    function selectedDocIds() {
      if (!els.docs) return [];
      return Array.from(els.docs.querySelectorAll('input[type="checkbox"]:checked')).map(function (x) {
        return x.value;
      });
    }

    if (els.buildTopics) {
      els.buildTopics.addEventListener('click', function () {
        if (els.topicStatus) els.topicStatus.textContent = 'Building...';
        els.buildTopics.disabled = true;
        _service().then(function (svc) {
          return svc.generateCourseTopicMap ? svc.generateCourseTopicMap(courseId) : [];
        }).then(function (topics) {
          renderTopicMap(topics);
          setTimeout(loadTopicMap, 4000);
        }).catch(function () { /* ignore */ }).then(function () {
          els.buildTopics.disabled = false;
        });
      });
    }

    function loadInitial() {
      loadTopicMap();
      _service().then(function (svc) {
        var list = typeof svc.prefetchCourseDocuments === 'function'
          ? svc.prefetchCourseDocuments(courseId)
          : svc.listCourseDocuments(courseId);
        return list.then(function (docs) {
          return typeof svc.filterDocsByCourseFiles === 'function'
            ? svc.filterDocsByCourseFiles(docs, courseId) : docs;
        });
      }).then(function (docs) {
        st.docs = docs || [];
        renderDocs();
      }).catch(function () {
        if (els.docStatus) els.docStatus.textContent = 'Could not load files.';
      });

      if (!_supaUrl()) return;
      fetch(_supaUrl() + '/rest/v1/exam_sessions?course_id=eq.' + encodeURIComponent(courseId) + '&select=*,exam_questions(*)&order=created_at.desc&limit=20', {
        headers: _supaHeaders()
      }).then(function (r) { return r.ok ? r.json() : []; })
        .then(function (rows) {
          st.sessions = (rows || []).map(_normaliseSession);
          if (!st.activeId && st.sessions[0]) st.activeId = st.sessions[0].id;
          st.loaded = true;
          renderAll();
        }).catch(function () {
          st.loaded = true;
          renderSessions();
        });
    }

    if (els.selectAll) {
      els.selectAll.addEventListener('click', function () {
        if (!els.docs) return;
        els.docs.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(function (box) {
          box.checked = true;
        });
      });
    }

    if (els.clearSelection) {
      els.clearSelection.addEventListener('click', function () {
        if (!els.docs) return;
        els.docs.querySelectorAll('input[type="checkbox"]').forEach(function (box) {
          box.checked = false;
        });
      });
    }

    if (els.gen) {
      els.gen.addEventListener('click', function () {
        var docs = selectedDocIds();
        var summary = _docSummary(st.docs);
        if (!docs.length) {
          if (!summary.ready.length) _toast('No ready files', 'Wait for indexing to finish, then generate the exam.');
          else _toast('Choose sources', 'Select at least one indexed file for ExamForge.');
          return;
        }
        els.gen.disabled = true;
        els.gen.textContent = 'Forging exam...';
        _service().then(function (svc) {
          return svc.generateExamForge(courseId, {
            documentIds: docs,
            count: Number(els.count && els.count.value || 6),
            difficulty: els.difficulty && els.difficulty.value || 'medium',
            questionTypes: selectedQuestionTypes(),
            topic: els.topic && els.topic.value || '',
            language: els.language && els.language.value || 'auto',
          });
        }).then(function (res) {
          res = res || {};
          // Persistence gate: an exam is only usable if the backend genuinely
          // saved it (a real sessionId + a DB id on every question). Without
          // that, grading/tracking is impossible, so we refuse to start it.
          if (res.error || !res.sessionId) {
            _toast('ExamForge could not save this exam',
              res.error || res.warning || 'The exam was not saved, so it can\'t be graded. Please try again.');
            return;
          }
          var session = _normaliseSession(res);
          if (!session.questions.length) {
            _toast('ExamForge could not create questions', res.error || res.warning || 'Try different files.');
            return;
          }
          if (session.questions.some(function (q) { return !q.id; })) {
            _toast('ExamForge could not save this exam',
              'Some questions were not saved, so this exam can\'t be graded. Please try again.');
            return;
          }
          st.sessions.unshift(session);
          st.activeId = session.id;
          st.answers = {};
          st.grades = {};
          st.submitted = false;
          st.marked = {};
          renderAll();
        }).catch(function (err) {
          _toast('ExamForge failed', err && err.message ? err.message : 'Please try again.');
        }).finally(function () {
          els.gen.disabled = false;
          els.gen.textContent = 'Generate exam';
        });
      });
    }

    function _persistAnswers(session, answers) {
      if (!session.id || String(session.id).indexOf('local-') === 0) return;
      _service().then(function (svc) {
        session.questions.forEach(function (q, idx) {
          if (!q.id || !answers[idx]) return;
          svc.gradeExamForgeAnswer(session.id, q.id, answers[idx]).then(function (grade) {
            if (q.type === 'short_answer' && grade && grade.ok) {
              st.grades[idx] = grade;
              renderExam();
            }
          }).catch(function () {});
        });
      }).catch(function () {});
    }

    renderAll();
    loadInitial();
  }
})();
