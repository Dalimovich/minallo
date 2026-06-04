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
      '<div class="dl-result" id="dlResult"></div>' +
    '</div>';

  function _renderMarkdown(el, md) {
    var ensure = typeof window._ssEnsureKatex === 'function' ? window._ssEnsureKatex() : Promise.resolve();
    var doRender = function () {
      el.innerHTML = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(md) : _esc(md);
      if (typeof window._renderMath === 'function') window._renderMath(el);
      if (typeof window._renderCode === 'function') window._renderCode(el);
    };
    ensure.then(doRender).catch(doRender);
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
    var sources = res.groundedSources || [];
    var hasCheck = res.check && res.check.question;
    els.result.innerHTML =
      '<div class="dl-lesson-card">' +
        '<h3>' + _esc(res.title || res.topic || 'Lesson') + '</h3>' +
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

    els.result.querySelectorAll('.dl-sources .src-cite').forEach(function (el) {
      el.addEventListener('click', function () {
        var fn = el.getAttribute('data-src-file');
        if (!fn || typeof window.openCitedSource !== 'function') return;
        window.openCitedSource({ fileName: fn, page: el.getAttribute('data-src-page') }, 'popup');
      });
    });
  }

  function _populateTopics(svc, sel) {
    svc.getCourseTopicMap(((sel && sel._courseId) || ''))
      .then(function (topics) {
        if (!sel || !sel.isConnected) return;
        if (!topics || !topics.length) {
          sel.innerHTML = '<option value="">No topic map yet — type a topic</option>';
          return;
        }
        sel.innerHTML = '<option value="">Choose a topic…</option>' +
          topics.map(function (t) {
            var imp = t.importance ? ' (' + t.importance + ')' : '';
            return '<option value="' + _esc(t.name) + '">' + _esc(t.name) + imp + '</option>';
          }).join('');
      })
      .catch(function () {
        if (sel) sel.innerHTML = '<option value="">Type a topic</option>';
      });
  }

  window.mountDeepLearn = function (target, course) {
    if (!target) return;
    target.innerHTML = _HTML;
    var root = target.querySelector('[data-deeplearn-root]');
    if (!root) return;
    var courseId = (course && course.id) || window.activeCourseId || '';
    var els = {
      select: root.querySelector('#dlTopicSelect'),
      text: root.querySelector('#dlTopicText'),
      gen: root.querySelector('#dlGenerate'),
      result: root.querySelector('#dlResult'),
    };
    if (els.select) els.select._courseId = courseId;

    _aiService().then(function (svc) {
      _populateTopics(svc, els.select);
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
        .then(function (svc) { return svc.generateDeepLearn(courseId, topic); })
        .then(function (res) { els.gen.disabled = false; _renderResult(els, res); })
        .catch(function (err) {
          els.gen.disabled = false;
          els.result.innerHTML = '<div class="dl-msg dl-error">' + _esc(err && err.message ? err.message : 'Deep Learn failed. Please try again.') + '</div>';
        });
    });
  };
})();
