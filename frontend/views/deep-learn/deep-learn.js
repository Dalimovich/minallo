// Deep Learn course tool (Learning Agent Phase 5).
//
// Guided, single-topic deep-dive grounded in the user's own files:
// explanation -> worked example -> one reveal-able self-check question.
// The topic picker is populated from the course Topic Map; a free-text box
// covers anything not in the map. Generation + grounding are server-side
// (generateDeepLearn); sources are clickable (popup via window.openCitedSource).

(function () {
  'use strict';

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function _aiService() {
    return import('/js/services/ai-service.js');
  }

  var _HTML =
    '<div class="dl-root" data-deeplearn-root>' +
      '<div class="dl-head">' +
        '<h2>Deep Learn</h2>' +
        '<p>A guided, grounded deep-dive into one topic — explanation, a worked example, and a self-check, all from your uploaded files.</p>' +
      '</div>' +
      '<div class="dl-controls">' +
        '<select id="dlTopicSelect" class="dl-select"><option value="">Loading topics…</option></select>' +
        '<input type="text" id="dlTopicText" class="dl-topic" placeholder="…or type any topic">' +
        '<button class="dl-btn dl-btn-primary" id="dlGenerate" type="button">Teach me this</button>' +
      '</div>' +
      '<div class="dl-saved" id="dlSaved" hidden>' +
        '<div class="dl-saved-head">Saved lessons</div>' +
        '<div class="dl-saved-list" id="dlSavedList"></div>' +
      '</div>' +
      '<div class="dl-result" id="dlResult"></div>' +
    '</div>';

  // The real markdown+KaTeX renderer lives in the AI render bridge, which the
  // app loads lazily (only when the chatbot opens). Until then window.renderMarkdown
  // is a plain escapeHtml stub — so without this Deep Learn shows raw "##" and
  // "$$". Ensure the bridge AND KaTeX before rendering.
  function _ensureRenderers() {
    var ps = [];
    if (typeof window._ensureAiRenderBridge === 'function') ps.push(window._ensureAiRenderBridge());
    if (typeof window._ssEnsureKatex === 'function') ps.push(window._ssEnsureKatex());
    return Promise.all(ps);
  }

  function _renderMarkdown(el, md) {
    var doRender = function () {
      el.innerHTML = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(md) : _esc(md);
      if (typeof window._renderMath === 'function') window._renderMath(el);
      if (typeof window._renderCode === 'function') window._renderCode(el);
    };
    _ensureRenderers().then(doRender).catch(doRender);
  }

  // Flatten a live lesson into one markdown doc for the printable view.
  function _composeLesson(res) {
    if (res && res.structuredLesson) return _structuredToMarkdown(res.structuredLesson);
    var parts = [];
    if (res.lesson && res.lesson.trim()) parts.push(res.lesson.trim());
    if (res.workedExample && res.workedExample.trim()) parts.push('## Worked example\n\n' + res.workedExample.trim());
    if (res.check && res.check.question) {
      var b = '## Check yourself\n\n' + res.check.question;
      if (res.check.answer) b += '\n\n**Answer:** ' + res.check.answer;
      if (res.check.explanation) b += '\n\n*' + res.check.explanation + '*';
      parts.push(b);
    }
    return parts.join('\n\n');
  }

  function _asList(v) {
    return Array.isArray(v) ? v.filter(Boolean) : [];
  }

  function _parseStructuredNote(note) {
    try {
      var parsed = JSON.parse((note && note.content_markdown) || '');
      return parsed && parsed.structuredLesson && typeof parsed.structuredLesson === 'object'
        ? parsed.structuredLesson
        : null;
    } catch (e) {
      return null;
    }
  }

  function _structuredToMarkdown(lesson) {
    lesson = lesson || {};
    var parts = ['# ' + (lesson.title || 'Deep Learn')];
    if (lesson.learningGoal) parts.push('## Learning Goal\n\n' + lesson.learningGoal);
    if (lesson.intuition) parts.push('## Intuition\n\n' + lesson.intuition);
    if (lesson.coreExplanation) parts.push('## Core Explanation\n\n' + lesson.coreExplanation);
    if (_asList(lesson.keyFormulas).length) {
      parts.push('## Key Formulas\n\n' + _asList(lesson.keyFormulas).map(function (f) {
        return '**Formula:** ' + (f.formula || '') +
          '\n\n**Meaning:** ' + (f.meaning || '') +
          '\n\n**Variables:** ' + (f.variables || '') +
          '\n\n**Use when / conditions:** ' + (f.conditions || '') +
          (f.commonMistake ? '\n\n**Common mistake:** ' + f.commonMistake : '') +
          '\n\n**Source:** ' + (f.source || '');
      }).join('\n\n---\n\n'));
    }
    if (_asList(lesson.stepByStepMethod).length) {
      parts.push('## Step-by-Step Method\n\n' + _asList(lesson.stepByStepMethod).map(function (s, i) {
        return (i + 1) + '. ' + s;
      }).join('\n'));
    }
    var worked = lesson.workedExample || {};
    if (worked.problem || _asList(worked.solutionSteps).length) {
      parts.push('## ' + (worked.isMiniExample ? 'Mini-example based on formulas above' : 'Worked Example') + '\n\n' +
        (worked.problem ? '**Problem:** ' + worked.problem + '\n\n' : '') +
        _asList(worked.solutionSteps).map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n') +
        (worked.finalAnswer ? '\n\n**Final answer:** ' + worked.finalAnswer : '') +
        (worked.sourceOrBasis ? '\n\n**Source or basis:** ' + worked.sourceOrBasis : ''));
    }
    if (_asList(lesson.commonMistakes).length) parts.push('## Common Mistakes\n\n' + _asList(lesson.commonMistakes).map(function (s) { return '- ' + s; }).join('\n'));
    if (_asList(lesson.selfCheck).length) {
      parts.push('## Self-Check\n\n' + _asList(lesson.selfCheck).map(function (c) {
        return '**Question:** ' + (c.question || '') + '\n\n**Answer:** ' + (c.answer || '') + '\n\n**Explanation:** ' + (c.explanation || '');
      }).join('\n\n'));
    }
    if (_asList(lesson.nextTopics).length) parts.push('## Next Topics\n\n' + _asList(lesson.nextTopics).map(function (s) { return '- ' + s; }).join('\n'));
    if (_asList(lesson.groundedSources).length) parts.push('## Sources\n\n' + _asList(lesson.groundedSources).map(function (s) { return '- ' + s; }).join('\n'));
    return parts.filter(Boolean).join('\n\n');
  }

  function _previewFromLesson(lesson, fallback) {
    var raw = lesson
      ? [lesson.learningGoal, lesson.intuition, lesson.coreExplanation].filter(Boolean).join(' ')
      : fallback;
    raw = String(raw || '').replace(/[#$*_`>\-[\]{}"]/g, ' ').replace(/\s+/g, ' ').trim();
    return raw.length > 150 ? raw.slice(0, 150) + '…' : raw;
  }

  function _sourceSummary(note) {
    var sources = note && note.note_sources;
    if (!Array.isArray(sources) || !sources.length) return '';
    return sources.slice(0, 2).map(function (s) {
      var fn = s.fileName || s.file_name || 'Source';
      var pg = s.pageStart == null ? '' : ', p.' + s.pageStart;
      return fn + pg;
    }).join(' · ');
  }

  function _renderList(el, items, ordered) {
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = '<p class="dl-muted">No strong course evidence for this section.</p>';
      return;
    }
    var tag = ordered ? 'ol' : 'ul';
    el.innerHTML = '<' + tag + '>' + items.map(function (x) { return '<li>' + _esc(x) + '</li>'; }).join('') + '</' + tag + '>';
  }

  function _bindSourceClicks(host) {
    host.querySelectorAll('.src-cite').forEach(function (el) {
      el.addEventListener('click', function () {
        var fn = el.getAttribute('data-src-file');
        if (!fn || typeof window.openCitedSource !== 'function') return;
        window.openCitedSource({ fileName: fn, page: el.getAttribute('data-src-page') }, 'popup');
      });
    });
  }

  function _renderStructuredResult(els, res, lesson) {
    var formulas = _asList(lesson.keyFormulas);
    var worked = lesson.workedExample || {};
    var checks = _asList(lesson.selfCheck);
    var sources = res.groundedSources || [];
    var hasWorked = worked.problem || _asList(worked.solutionSteps).length || worked.finalAnswer;
    els._print = {
      course: els.courseName || '',
      title: lesson.title || res.title || res.topic || 'Lesson',
      markdown: _structuredToMarkdown(lesson),
    };
    els.result.innerHTML =
      '<article class="dl-lesson-card dl-structured">' +
        '<div class="dl-lesson-head"><div><p class="dl-kicker">Guided tutor lesson</p><h3>' + _esc(lesson.title || res.title || res.topic || 'Lesson') + '</h3></div>' +
        '<button type="button" class="dl-btn dl-download" data-dl-print>⤓ Download PDF</button></div>' +
        ((res.citationWarning || lesson.citationWarning) ? '<div class="dl-warning">' + _esc(res.citationWarning || lesson.citationWarning) + '</div>' : '') +
        '<section class="dl-study-section"><h4>Learning Goal</h4><div class="dl-learning-goal"></div></section>' +
        '<section class="dl-study-section"><h4>Intuition</h4><div class="dl-intuition"></div></section>' +
        '<section class="dl-study-section"><h4>Core Explanation</h4><div class="dl-core"></div></section>' +
        '<section class="dl-study-section"><h4>Formula Box</h4><div class="dl-formulas"></div></section>' +
        '<section class="dl-study-section"><h4>Step-by-Step Method</h4><div class="dl-method"></div></section>' +
        (hasWorked ? '<section class="dl-study-section"><h4>' + _esc(worked.isMiniExample ? 'Mini-example based on the formulas above' : 'Worked Example') + '</h4><div class="dl-worked"></div></section>' : '') +
        '<section class="dl-study-section"><h4>Common Mistakes</h4><div class="dl-mistakes"></div></section>' +
        '<section class="dl-study-section"><h4>Self-Check</h4><div class="dl-checks"></div></section>' +
        '<section class="dl-study-section"><h4>Sources</h4><div class="dl-source-list"></div></section>' +
      '</article>';

    _renderMarkdown(els.result.querySelector('.dl-learning-goal'), lesson.learningGoal || '');
    _renderMarkdown(els.result.querySelector('.dl-intuition'), lesson.intuition || '');
    _renderMarkdown(els.result.querySelector('.dl-core'), lesson.coreExplanation || '');
    _renderList(els.result.querySelector('.dl-method'), _asList(lesson.stepByStepMethod), true);
    _renderList(els.result.querySelector('.dl-mistakes'), _asList(lesson.commonMistakes), false);

    var formulaHost = els.result.querySelector('.dl-formulas');
    if (formulaHost) {
      formulaHost.innerHTML = formulas.length ? formulas.map(function (f, i) {
        return '<div class="dl-formula-box">' +
          '<div class="dl-formula-main" data-formula="' + i + '"></div>' +
          '<dl><dt>Meaning</dt><dd>' + _esc(f.meaning || '') + '</dd>' +
          '<dt>Variables</dt><dd>' + _esc(f.variables || '') + '</dd>' +
          '<dt>Use when / conditions</dt><dd>' + _esc(f.conditions || '') + '</dd>' +
          (f.commonMistake ? '<dt>Common mistake</dt><dd>' + _esc(f.commonMistake) + '</dd>' : '') +
          '<dt>Source</dt><dd>' + _esc(f.source || 'Missing source') + '</dd></dl></div>';
      }).join('') : '<p class="dl-muted">No formula was strongly supported by the retrieved course material.</p>';
      formulaHost.querySelectorAll('.dl-formula-main').forEach(function (el) {
        var f = formulas[Number(el.getAttribute('data-formula') || 0)] || {};
        _renderMarkdown(el, f.formula ? '$$' + f.formula + '$$' : '');
      });
    }

    var workedHost = els.result.querySelector('.dl-worked');
    if (workedHost) {
      workedHost.innerHTML =
        (worked.problem ? '<p><strong>Problem:</strong> ' + _esc(worked.problem) + '</p>' : '') +
        (_asList(worked.solutionSteps).length ? '<ol>' + _asList(worked.solutionSteps).map(function (s) { return '<li>' + _esc(s) + '</li>'; }).join('') + '</ol>' : '') +
        (worked.finalAnswer ? '<p><strong>Final answer:</strong> ' + _esc(worked.finalAnswer) + '</p>' : '') +
        (worked.sourceOrBasis ? '<p class="dl-source-basis"><strong>Source or basis:</strong> ' + _esc(worked.sourceOrBasis) + '</p>' : '');
    }

    var checkHost = els.result.querySelector('.dl-checks');
    if (checkHost) {
      checkHost.innerHTML = checks.length ? checks.map(function (c, i) {
        return '<div class="dl-check-card"><p class="dl-check-q">' + _esc(c.question || '') + '</p>' +
          '<button class="dl-btn dl-reveal" type="button" data-check="' + i + '">Show answer</button>' +
          '<div class="dl-check-a" hidden></div></div>';
      }).join('') : '<p class="dl-muted">No self-check was generated from the available evidence.</p>';
      checkHost.querySelectorAll('.dl-reveal').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var c = checks[Number(btn.getAttribute('data-check') || 0)] || {};
          var ans = btn.parentElement && btn.parentElement.querySelector('.dl-check-a');
          if (!ans) return;
          if (ans.hasAttribute('hidden')) {
            _renderMarkdown(ans, (c.answer || '') + (c.explanation ? '\n\n*' + c.explanation + '*' : ''));
            ans.removeAttribute('hidden');
            btn.textContent = 'Hide answer';
          } else {
            ans.setAttribute('hidden', '');
            btn.textContent = 'Show answer';
          }
        });
      });
    }

    var sourceHost = els.result.querySelector('.dl-source-list');
    if (sourceHost) {
      sourceHost.innerHTML = sources.length ? sources.map(function (s) {
        var pg = s.pageStart == null ? '' : s.pageStart;
        return '<button type="button" class="src-cite" data-src-file="' + _esc(s.fileName || '') +
          '" data-src-page="' + _esc(pg) + '">' + _esc(s.label || s.fileName || 'Source') + '</button>';
      }).join('') : _asList(lesson.groundedSources).map(function (s) {
        return '<span class="dl-source-chip">' + _esc(s) + '</span>';
      }).join('');
      if (!sourceHost.innerHTML) sourceHost.innerHTML = '<p class="dl-muted">No clickable sources were returned.</p>';
      _bindSourceClicks(sourceHost);
    }

    var dlBtn = els.result.querySelector('[data-dl-print]');
    if (dlBtn) dlBtn.addEventListener('click', function () { _openPrint(els._print); });
  }

  // ── printable white lesson view + download (PDF via the browser) ───────────

  var _printEl = null;
  var _printEsc = null;

  function _closePrint() {
    if (_printEsc) { document.removeEventListener('keydown', _printEsc); _printEsc = null; }
    if (_printEl) { _printEl.remove(); _printEl = null; }
  }

  function _openPrint(opts) {
    opts = opts || {};
    _closePrint();
    var ov = document.createElement('div');
    ov.className = 'dl-print-overlay ss-print-root';
    ov.innerHTML =
      '<div class="ss-print-bar">' +
        '<span class="ss-print-bar-title">' + _esc(opts.title || 'Lesson') + '</span>' +
        '<div class="ss-print-bar-actions">' +
          '<button type="button" class="ss-print-btn" data-act="print">⤓ Download PDF</button>' +
          '<button type="button" class="ss-print-btn" data-act="close">Close</button>' +
        '</div>' +
      '</div>' +
      '<div class="ss-print-scroll">' +
        '<article class="ss-print-doc">' +
          '<header class="ss-print-head">' +
            (opts.course ? '<div class="ss-print-course">' + _esc(opts.course) + '</div>' : '') +
            '<h1>' + _esc(opts.title || 'Lesson') + '</h1>' +
          '</header>' +
          '<div class="ss-print-body"></div>' +
        '</article>' +
      '</div>';
    document.body.appendChild(ov);
    _printEl = ov;
    var body = ov.querySelector('.ss-print-body');
    if (body) _renderMarkdown(body, opts.markdown || '');
    ov.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.getAttribute('data-act') === 'close') _closePrint();
      else window.print();
    });
    _printEsc = function (e) { if (e.key === 'Escape') _closePrint(); };
    document.addEventListener('keydown', _printEsc);
  }

  function _renderResult(els, res) {
    if (!res || res.error) {
      els.result.innerHTML = '<div class="dl-msg dl-error">' + _esc((res && res.error) || 'Deep Learn failed. Please try again.') + '</div>';
      return;
    }
    if ((!res.lesson || !res.lesson.trim()) && res.warning) {
      els.result.innerHTML = '<div class="dl-msg">' + _esc(res.warning) + '</div>';
      return;
    }
    if (res.structuredLesson && typeof res.structuredLesson === 'object') {
      _renderStructuredResult(els, res, res.structuredLesson);
      return;
    }
    var sources = res.groundedSources || [];
    var hasCheck = res.check && res.check.question;
    els._print = {
      course: els.courseName || '',
      title: res.title || res.topic || 'Lesson',
      markdown: _composeLesson(res),
    };
    els.result.innerHTML =
      '<div class="dl-lesson-card">' +
        '<div class="dl-lesson-head">' +
          '<h3>' + _esc(res.title || res.topic || 'Lesson') + '</h3>' +
          '<button type="button" class="dl-btn dl-download" data-dl-print>⤓ Download PDF</button>' +
        '</div>' +
        '<div class="dl-section dl-lesson-body"></div>' +
        (res.workedExample && res.workedExample.trim()
          ? '<h4>Worked example</h4><div class="dl-section dl-example-body"></div>'
          : '') +
        (hasCheck
          ? '<div class="dl-check">' +
              '<h4>Check yourself</h4>' +
              '<p class="dl-check-q"></p>' +
              '<button class="dl-btn dl-reveal" id="dlReveal" type="button">Show answer</button>' +
              '<div class="dl-check-a" hidden></div>' +
            '</div>'
          : '') +
        (sources.length
          ? '<div class="dl-sources">Sources: ' +
              sources.map(function (s) {
                var pg = s.pageStart == null ? '' : s.pageStart;
                return '<span class="src-cite" title="Open this source" data-src-file="' + _esc(s.fileName || '') +
                  '" data-src-page="' + _esc(pg) + '">' + _esc(s.fileName || 'Source') + (pg ? ', p.' + _esc(pg) : '') + '</span>';
              }).join(' · ') +
            '</div>'
          : '') +
      '</div>';

    var lessonBody = els.result.querySelector('.dl-lesson-body');
    if (lessonBody) _renderMarkdown(lessonBody, res.lesson || '');
    var exBody = els.result.querySelector('.dl-example-body');
    if (exBody) _renderMarkdown(exBody, res.workedExample || '');

    if (hasCheck) {
      var q = els.result.querySelector('.dl-check-q');
      if (q) q.textContent = res.check.question;
      var reveal = els.result.querySelector('#dlReveal');
      var ans = els.result.querySelector('.dl-check-a');
      if (reveal && ans) {
        reveal.addEventListener('click', function () {
          if (ans.hasAttribute('hidden')) {
            _renderMarkdown(ans, (res.check.answer || '') + (res.check.explanation ? '\n\n*' + res.check.explanation + '*' : ''));
            ans.removeAttribute('hidden');
            reveal.textContent = 'Hide answer';
          } else {
            ans.setAttribute('hidden', '');
            reveal.textContent = 'Show answer';
          }
        });
      }
    }

    var dlBtn = els.result.querySelector('[data-dl-print]');
    if (dlBtn) dlBtn.addEventListener('click', function () { _openPrint(els._print); });

    _bindSourceClicks(els.result);
  }

  function _fillTopicSelect(sel, topics) {
    if (!sel || !sel.isConnected) return;
    sel.innerHTML = '<option value="">Choose a topic…</option>' +
      topics.map(function (t) {
        var imp = t.importance ? ' (' + t.importance + ')' : '';
        return '<option value="' + _esc(t.name) + '">' + _esc(t.name) + imp + '</option>';
      }).join('');
  }

  // The Topic Map is auto-derived from the user's indexed files, but nothing
  // builds it until something asks. So when it's empty we trigger a build and
  // poll until the rolled-up topics appear — the user never has to know the
  // map exists. The free-text box stays available the whole time as a fallback.
  function _buildAndPollTopics(svc, sel, courseId) {
    if (!svc.generateCourseTopicMap) {
      if (sel) sel.innerHTML = '<option value="">No topic map yet — type a topic below</option>';
      return;
    }
    if (sel) sel.innerHTML = '<option value="">Building your topic map…</option>';
    var poll = function (tries) {
      svc.getCourseTopicMap(courseId).then(function (topics) {
        if (!sel || !sel.isConnected) return;
        if (topics && topics.length) { _fillTopicSelect(sel, topics); return; }
        if (tries < 4) { setTimeout(function () { poll(tries + 1); }, 2500); return; }
        sel.innerHTML = '<option value="">No topics found — type a topic below</option>';
      }).catch(function () {
        if (sel) sel.innerHTML = '<option value="">Type a topic below</option>';
      });
    };
    svc.generateCourseTopicMap(courseId)
      .then(function (topics) {
        if (!sel || !sel.isConnected) return;
        if (topics && topics.length) { _fillTopicSelect(sel, topics); return; }
        setTimeout(function () { poll(0); }, 2500);
      })
      .catch(function () {
        if (sel) sel.innerHTML = '<option value="">No topic map yet — type a topic below</option>';
      });
  }

  function _populateTopics(svc, sel) {
    var courseId = (sel && sel._courseId) || '';
    svc.getCourseTopicMap(courseId)
      .then(function (topics) {
        if (!sel || !sel.isConnected) return;
        if (topics && topics.length) { _fillTopicSelect(sel, topics); return; }
        // Empty map → build it from the user's files, then poll for the result.
        _buildAndPollTopics(svc, sel, courseId);
      })
      .catch(function () {
        if (sel) sel.innerHTML = '<option value="">Type a topic below</option>';
      });
  }

  // ── saved lessons (persisted as notes of type 'deep_learn') ────────────────

  function _fmtDate(s) {
    if (!s) return '';
    try {
      return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function _viewSaved(svc, els, id) {
    if (!id || !svc.getNoteById) return;
    els.result.innerHTML = '<div class="dl-msg dl-loading">Loading lesson…</div>';
    svc.getNoteById(id).then(function (note) {
      if (!note) { els.result.innerHTML = '<div class="dl-msg dl-error">Could not load this lesson.</div>'; return; }
      var structured = _parseStructuredNote(note);
      if (structured) {
        _renderStructuredResult(els, {
          title: note.title,
          topic: note.title,
          structuredLesson: structured,
          groundedSources: note.note_sources || [],
        }, structured);
        return;
      }
      els._print = { course: els.courseName || '', title: note.title || 'Lesson', markdown: note.content_markdown || '' };
      els.result.innerHTML =
        '<div class="dl-lesson-card"><div class="dl-lesson-head"><h3>' + _esc(note.title || 'Lesson') + '</h3>' +
        '<button type="button" class="dl-btn dl-download" data-dl-print>⤓ Download PDF</button></div>' +
        '<div class="dl-section dl-saved-body"></div></div>';
      var body = els.result.querySelector('.dl-saved-body');
      if (body) _renderMarkdown(body, note.content_markdown || '');
      var dlBtn = els.result.querySelector('[data-dl-print]');
      if (dlBtn) dlBtn.addEventListener('click', function () { _openPrint(els._print); });
    }).catch(function () {
      els.result.innerHTML = '<div class="dl-msg dl-error">Could not load this lesson.</div>';
    });
  }

  function _renderSavedList(svc, els, courseId, lessons) {
    if (!els.saved || !els.savedList) return;
    if (!lessons || !lessons.length) {
      els.saved.setAttribute('hidden', '');
      els.savedList.innerHTML = '';
      return;
    }
    els.saved.removeAttribute('hidden');
    els.savedList.innerHTML = lessons.map(function (n) {
      return '<div class="dl-saved-item">' +
        '<button type="button" class="dl-saved-open" data-id="' + _esc(n.id) + '">' +
          '<span class="dl-saved-title">' + _esc(n.title || 'Lesson') + '</span>' +
          '<span class="dl-saved-date">' + _esc(_fmtDate(n.created_at || n.updated_at)) + '</span>' +
        '</button>' +
        '<button type="button" class="dl-saved-del" data-id="' + _esc(n.id) + '" title="Delete lesson" aria-label="Delete lesson">×</button>' +
      '</div>';
    }).join('');
    els.savedList.querySelectorAll('.dl-saved-open').forEach(function (b) {
      b.addEventListener('click', function () { _viewSaved(svc, els, b.getAttribute('data-id')); });
    });
    els.savedList.querySelectorAll('.dl-saved-del').forEach(function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        svc.deleteNote(b.getAttribute('data-id')).then(function () { _loadSaved(svc, els, courseId); });
      });
    });
  }

  function _renderSavedListRich(svc, els, courseId, lessons) {
    if (!els.saved || !els.savedList) return;
    if (!lessons || !lessons.length) {
      els.saved.setAttribute('hidden', '');
      els.savedList.innerHTML = '';
      return;
    }
    els.saved.removeAttribute('hidden');
    els.savedList.innerHTML = lessons.map(function (n) {
      var structured = _parseStructuredNote(n);
      var preview = _previewFromLesson(structured, n.content_markdown || n.preview || '');
      var source = _sourceSummary(n);
      return '<div class="dl-saved-item">' +
        '<div class="dl-saved-main">' +
          '<div class="dl-saved-meta"><span class="dl-saved-title">' + _esc(n.title || 'Lesson') + '</span>' +
          '<span class="dl-saved-date">' + _esc(_fmtDate(n.created_at || n.updated_at)) + '</span></div>' +
          (source ? '<div class="dl-saved-source">' + _esc(source) + '</div>' : '') +
          (preview ? '<div class="dl-saved-preview">' + _esc(preview) + '</div>' : '') +
        '</div>' +
        '<div class="dl-saved-actions">' +
          '<button type="button" class="dl-saved-open" data-id="' + _esc(n.id) + '">Open</button>' +
          '<button type="button" class="dl-saved-regenerate" data-topic="' + _esc(n.title || '') + '">Regenerate</button>' +
          '<button type="button" class="dl-saved-del" data-id="' + _esc(n.id) + '" title="Delete lesson" aria-label="Delete lesson">×</button>' +
        '</div>' +
      '</div>';
    }).join('');
    els.savedList.querySelectorAll('.dl-saved-open').forEach(function (b) {
      b.addEventListener('click', function () { _viewSaved(svc, els, b.getAttribute('data-id')); });
    });
    els.savedList.querySelectorAll('.dl-saved-del').forEach(function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        svc.deleteNote(b.getAttribute('data-id')).then(function () { _loadSaved(svc, els, courseId); });
      });
    });
    els.savedList.querySelectorAll('.dl-saved-regenerate').forEach(function (b) {
      b.addEventListener('click', function () {
        if (els.text) els.text.value = (b.getAttribute('data-topic') || '').replace(/\s+—\s+Version\s+\d+$/i, '');
        if (els.select) els.select.value = '';
        if (els.gen) els.gen.click();
      });
    });
  }

  function _loadSaved(svc, els, courseId) {
    if (!svc.listCourseNotes || !courseId) return;
    svc.listCourseNotes(courseId).then(function (notes) {
      var lessons = (notes || []).filter(function (n) { return n.type === 'deep_learn'; });
      _renderSavedListRich(svc, els, courseId, lessons);
    }).catch(function () { /* non-fatal: saved list is additive */ });
  }

  window.mountDeepLearn = function (target, course) {
    if (!target) return;
    target.innerHTML = _HTML;
    var root = target.querySelector('[data-deeplearn-root]');
    if (!root) return;
    var courseId = (course && course.id) || window.activeCourseId || '';
    var els = {
      courseName: (course && (course.name || course.title)) || '',
      select: root.querySelector('#dlTopicSelect'),
      text: root.querySelector('#dlTopicText'),
      gen: root.querySelector('#dlGenerate'),
      result: root.querySelector('#dlResult'),
      saved: root.querySelector('#dlSaved'),
      savedList: root.querySelector('#dlSavedList'),
    };
    if (els.select) els.select._courseId = courseId;

    _aiService().then(function (svc) {
      _populateTopics(svc, els.select);
      _loadSaved(svc, els, courseId);
    });

    // Selecting a topic from the map clears the free-text box and vice-versa.
    if (els.select) els.select.addEventListener('change', function () {
      if (els.select.value && els.text) els.text.value = '';
    });
    if (els.text) els.text.addEventListener('input', function () {
      if (els.text.value && els.select) els.select.value = '';
    });

    if (els.gen) els.gen.addEventListener('click', function () {
      if (!courseId) return;
      var topic = ((els.text && els.text.value) || (els.select && els.select.value) || '').trim();
      if (!topic) {
        if (typeof window.showToast === 'function') window.showToast('Pick a topic', 'Choose a topic from the list or type one.');
        return;
      }
      els.gen.disabled = true;
      els.result.innerHTML = '<div class="dl-msg dl-loading">Building your lesson on “' + _esc(topic) + '”…</div>';
      _aiService()
        .then(function (svc) {
          return svc.generateDeepLearn(courseId, topic).then(function (res) {
            els.gen.disabled = false;
            _renderResult(els, res);
            // A new lesson was just saved — refresh the saved list.
            if (res && res.noteId) _loadSaved(svc, els, courseId);
          });
        })
        .catch(function (err) {
          els.gen.disabled = false;
          els.result.innerHTML = '<div class="dl-msg dl-error">' + _esc(err && err.message ? err.message : 'Deep Learn failed. Please try again.') + '</div>';
        });
    });
  };
})();
