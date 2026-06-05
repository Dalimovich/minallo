// Cheatsheet course tool (Learning Agent Phase 4).
//
// A dense, exam-ready summary of the course — key formulas, definitions and
// rules, ranked by the course Topic Map's importance and grounded in the
// user's own files. Course-wide by default; an optional topic focuses it.
// Generation + grounding happen server-side (generateCheatsheet); the result
// is markdown saved as a note (type 'cheatsheet') and rendered here with
// clickable sources.

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
    '<div class="cs-root" data-cheatsheet-root>' +
      '<div class="cs-head">' +
        '<h2>Cheatsheet</h2>' +
        '<p>A dense, exam-ready summary of this course — the key formulas, definitions and rules, ranked by importance and grounded in your uploaded files.</p>' +
      '</div>' +
      '<div class="cs-settings" id="csSettings">' +
        '<div class="cs-preset-row" role="group" aria-label="Cheatsheet preset">' +
          '<button type="button" class="cs-preset" data-preset="exam_night">Exam Night</button>' +
          '<button type="button" class="cs-preset" data-preset="open_book_exam">Open-book Exam</button>' +
          '<button type="button" class="cs-preset" data-preset="formula_reference">Formula Reference</button>' +
          '<button type="button" class="cs-preset is-active" data-preset="balanced">Balanced Study</button>' +
          '<button type="button" class="cs-preset" data-preset="deep_revision">Deep Revision</button>' +
          '<button type="button" class="cs-preset" data-preset="topic_mastery">Topic Mastery</button>' +
        '</div>' +
        '<div class="cs-opt-row">' +
          '<label class="cs-opt">Pages' +
            '<select id="csPages"><option value="">Auto</option><option>1</option><option>2</option><option>3</option><option>4</option></select>' +
          '</label>' +
          '<label class="cs-opt">Columns' +
            '<select id="csColumns"><option value="">Auto</option><option>2</option><option selected>3</option><option>4</option></select>' +
          '</label>' +
          '<label class="cs-opt">Style' +
            '<select id="csStyle"><option value="academic">Academic</option><option value="modern">Modern</option><option value="compact">Compact</option><option value="classic">Classic</option></select>' +
          '</label>' +
          '<label class="cs-opt">Text' +
            '<select id="csFontSize"><option value="auto">Auto</option><option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option></select>' +
          '</label>' +
          '<label class="cs-opt">Detail' +
            '<select id="csDetail"><option value="general">General</option><option value="balanced" selected>Balanced</option><option value="specific">Specific</option><option value="very_thorough">Very Thorough</option></select>' +
          '</label>' +
          '<label class="cs-opt">Language' +
            '<select id="csLang"><option value="source">Same as material</option><option value="en">English</option><option value="de">Deutsch</option><option value="de_terms_en_explanations">German terms + English</option></select>' +
          '</label>' +
          '<label class="cs-opt">Output' +
            '<select id="csOutput"><option value="both">Both</option><option value="web">Web view</option><option value="pdf">PDF</option></select>' +
          '</label>' +
          '<span class="cs-conflict" id="csConflict" hidden></span>' +
        '</div>' +
      '</div>' +
      '<div class="cs-controls">' +
        '<input type="text" id="csTopic" class="cs-topic" placeholder="Focus on one topic (optional) — leave blank for the whole course">' +
        '<button class="cs-btn cs-btn-primary" id="csGenerate" type="button">Generate cheatsheet</button>' +
      '</div>' +
      '<div class="cs-saved-wrap" id="csSaved" hidden>' +
        '<div class="cs-saved-head">Saved cheatsheets</div>' +
        '<div class="cs-saved-list" id="csSavedList"></div>' +
      '</div>' +
      '<div class="cs-result" id="csResult"></div>' +
    '</div>';

  // The real markdown+KaTeX renderer lives in the AI render bridge, which the
  // app loads lazily (only when the chatbot opens). Until then window.renderMarkdown
  // is a plain escapeHtml stub — so without this the cheatsheet shows raw "##" and
  // "$$". Ensure the bridge AND KaTeX before rendering.
  function _ensureRenderers() {
    var ps = [];
    if (typeof window._ensureAiRenderBridge === 'function') ps.push(window._ensureAiRenderBridge());
    if (typeof window._ssEnsureKatex === 'function') ps.push(window._ssEnsureKatex());
    return Promise.all(ps);
  }

  var _LABEL_WARN = /^(\s*)(Important:|Critical:|Warning:|Trap:)/;
  var _LABEL_NOTE = /^(\s*)(Note:)/;

  // Apply the cheatsheet emphasis markers the generator emits, on the rendered
  // DOM (after KaTeX, so formulas — which can contain == or {{ }} — are already
  // .katex spans and are skipped):
  //   ==fact==     → yellow highlight   {{term}} → blue key term
  //   Note:/Important:/Critical: lines → orange / red
  function _decorate(root) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var targets = [];
    var n;
    while ((n = walker.nextNode())) {
      var p = n.parentNode;
      if (!p || p.closest('.katex, code, pre')) continue;
      var t = n.nodeValue || '';
      if (t.indexOf('==') === -1 && t.indexOf('{{') === -1 && !_LABEL_WARN.test(t) && !_LABEL_NOTE.test(t)) continue;
      targets.push(n);
    }
    targets.forEach(function (node) {
      var t = node.nodeValue || '';
      var html = _esc(t)
        .replace(/==([^=]+)==/g, '<mark class="cs-hl">$1</mark>')
        .replace(/\{\{([^}]+)\}\}/g, '<span class="cs-key">$1</span>');
      if (_LABEL_WARN.test(t)) html = '<span class="cs-warn">' + html + '</span>';
      else if (_LABEL_NOTE.test(t)) html = '<span class="cs-note">' + html + '</span>';
      var span = document.createElement('span');
      span.innerHTML = html;
      node.parentNode.replaceChild(span, node);
    });
  }

  // Group each `##` section (h2 + following siblings) into a .cs-block so a
  // section never splits across columns in the multi-column paper.
  function _wrapBlocks(body) {
    if (!body) return;
    var kids = Array.prototype.slice.call(body.childNodes);
    var blocks = [];
    var cur = null;
    kids.forEach(function (node) {
      if (node.nodeType === 1 && node.tagName === 'H2') {
        cur = document.createElement('div');
        cur.className = 'cs-block';
        blocks.push(cur);
      } else if (!cur) {
        cur = document.createElement('div');
        cur.className = 'cs-block';
        blocks.push(cur);
      }
      cur.appendChild(node);
    });
    body.innerHTML = '';
    blocks.forEach(function (b) {
      // A section containing a table spans all columns (full page width) so a
      // wide comparison/classification grid can never overflow into and overlap
      // the neighbouring column. Tagged here (not via CSS :has) for engine
      // reliability — html2canvas captures the real browser layout.
      if (b.querySelector('table')) b.classList.add('cs-block--wide');
      body.appendChild(b);
    });
  }

  function _renderMarkdown(el, md, paper) {
    var doRender = function () {
      el.innerHTML = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(md) : _esc(md);
      if (typeof window._renderMath === 'function') window._renderMath(el);
      if (typeof window._renderCode === 'function') window._renderCode(el);
      _decorate(el);
      if (paper) _wrapBlocks(el);
    };
    _ensureRenderers().then(doRender).catch(doRender);
  }

  // ── white "paper" view (Hyperknow-style) + print/PDF ───────────────────────

  var _csRun = 0;

  function _sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function _startBuildSteps(els, topic) {
    var runId = ++_csRun;
    var steps = [
      'Finding the strongest course evidence',
      'Grouping formulas, definitions, and rules',
      'Drafting exam-ready sections',
      'Checking source coverage',
      'Preparing the cheatsheet view',
    ];
    var idx = 0;
    els.result.innerHTML =
      '<div class="cs-build" data-run="' + runId + '">' +
        '<div class="cs-build-title">Writing ' + _esc(topic || 'the course cheatsheet') + '</div>' +
        '<div class="cs-build-steps">' + steps.map(function (s, i) {
          return '<div class="cs-build-step' + (i === 0 ? ' is-active' : '') + '" data-step="' + i + '">' +
            '<span class="cs-step-dot"></span><span>' + _esc(s) + '</span></div>';
        }).join('') + '</div>' +
      '</div>';
    var timer = setInterval(function () {
      if (runId !== _csRun || !els.result.querySelector('.cs-build')) {
        clearInterval(timer);
        return;
      }
      idx = Math.min(idx + 1, steps.length - 1);
      els.result.querySelectorAll('.cs-build-step').forEach(function (el, i) {
        el.classList.toggle('is-done', i < idx);
        el.classList.toggle('is-active', i === idx);
      });
    }, 1100);
    return {
      id: runId,
      stop: function () { clearInterval(timer); },
    };
  }

  function _splitSections(md) {
    var text = String(md || '').trim();
    if (!text) return [];
    var chunks = text.split(/\n(?=##\s+)/g).filter(function (x) { return x && x.trim(); });
    return chunks.map(function (chunk, i) {
      var m = chunk.match(/^##\s+(.+?)(?:\n|$)/);
      return {
        title: m ? m[1].trim() : (i === 0 ? 'Overview' : 'Section ' + (i + 1)),
        markdown: chunk,
      };
    });
  }

  function _sectionToolsHtml() {
    return '<div class="cs-section-tools">' +
      '<button type="button" data-sec-act="condense">Condense</button>' +
      '<button type="button" data-sec-act="expand">Expand</button>' +
      '<button type="button" data-sec-act="remove">Remove</button>' +
      '<button type="button" data-sec-act="up">Up</button>' +
      '<button type="button" data-sec-act="down">Down</button>' +
      '<button type="button" data-sec-act="lock">Lock</button>' +
      '<button type="button" data-sec-act="regen">Regenerate</button>' +
    '</div>';
  }

  function _sectionTitle(block) {
    var h = block && block.querySelector('h2, h3');
    return h ? (h.textContent || '').trim() : '';
  }

  function _condenseSection(block) {
    if (!block || block.classList.contains('is-locked')) return;
    var content = block.querySelector('.cs-section-content') || block;
    if (!content.dataset.fullHtml) content.dataset.fullHtml = content.innerHTML;
    content.querySelectorAll('p, li').forEach(function (el) {
      var txt = el.textContent || '';
      var keep = el.querySelector('.katex, code, pre') ||
        /important:|critical:|trap:|source:|p\.\d+|=|\\frac|\\int|\\sum|const|valid/i.test(txt);
      if (!keep) el.classList.add('cs-pruned-line');
    });
    block.classList.add('is-condensed');
  }

  function _expandSection(block) {
    if (!block) return;
    var content = block.querySelector('.cs-section-content') || block;
    if (content.dataset.fullHtml) content.innerHTML = content.dataset.fullHtml;
    block.classList.remove('is-condensed');
  }

  function _wireSectionTools(scope, els) {
    if (!scope) return;
    scope.querySelectorAll('.cs-progress-section, .cs-edit-section').forEach(function (block) {
      if (block.dataset.toolsWired) return;
      block.dataset.toolsWired = '1';
      if (!block.querySelector('.cs-section-tools')) block.insertAdjacentHTML('afterbegin', _sectionToolsHtml());
    });
    scope.querySelectorAll('.cs-section-tools button').forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-sec-act');
        var block = btn.closest('.cs-progress-section, .cs-edit-section');
        if (!block) return;
        if (act !== 'lock' && block.classList.contains('is-locked')) return;
        if (act === 'condense') _condenseSection(block);
        else if (act === 'expand') _expandSection(block);
        else if (act === 'remove') block.remove();
        else if (act === 'up' && block.previousElementSibling) block.parentNode.insertBefore(block, block.previousElementSibling);
        else if (act === 'down' && block.nextElementSibling) block.parentNode.insertBefore(block.nextElementSibling, block);
        else if (act === 'lock') {
          block.classList.toggle('is-locked');
          btn.textContent = block.classList.contains('is-locked') ? 'Unlock' : 'Lock';
        } else if (act === 'regen' && els && typeof els._regenerateSection === 'function') {
          els._regenerateSection(_sectionTitle(block));
        }
      });
    });
  }

  function _renderResultProgressive(els, res, runId) {
    if (runId !== _csRun) return;
    if (!res || res.error || !res.text || !res.text.trim()) {
      _renderResult(els, res);
      return;
    }
    var topics = (res.topicsCovered || []).filter(Boolean);
    var sources = res.groundedSources || [];
    var nFiles = sources.reduce(function (set, s) { if (s.fileName) set[s.fileName] = 1; return set; }, {});
    var fileCount = Object.keys(nFiles).length;
    var sections = _splitSections(res.text);
    if (!sections.length) sections = [{ title: res.title || 'Cheatsheet', markdown: res.text }];
    els._paper = {
      course: els.courseName || 'Cheatsheet',
      title: res.title || 'Cheatsheet',
      scope: res.title || 'Course cheatsheet',
      meta: (fileCount ? 'Based on ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + ' · ' : '') + 'generated cheatsheet',
      markdown: res.text,
      settings: res.settings,
    };
    els.result.innerHTML =
      '<div class="cs-sheet">' +
        '<div class="cs-sheet-head">' +
          '<h3>' + _esc(res.title || 'Cheatsheet') + '</h3>' +
          (res.noteId ? '<span class="cs-saved">Saved to your notes</span>' : '') +
          '<button type="button" class="cs-btn cs-view-print" data-cs-view disabled>View / Print</button>' +
        '</div>' +
        '<div class="cs-writing-line">Writing section 1 of ' + sections.length + '</div>' +
        '<div class="cs-sheet-body"></div>' +
        '<div class="cs-after" hidden>' +
          (res.citationWarning ? '<div class="cs-cite-warn">' + _esc(res.citationWarning) + '</div>' : '') +
          (topics.length ? '<div class="cs-topics">Topics: ' + topics.map(_esc).join(' · ') + '</div>' : '') +
          _sourcesHtml(sources, res.grounding) +
        '</div>' +
      '</div>';
    var body = els.result.querySelector('.cs-sheet-body');
    var line = els.result.querySelector('.cs-writing-line');
    var viewBtn = els.result.querySelector('[data-cs-view]');
    var after = els.result.querySelector('.cs-after');
    if (viewBtn) viewBtn.addEventListener('click', function () { _openPaper(els._paper); });
    (async function () {
      for (var i = 0; i < sections.length; i += 1) {
        if (runId !== _csRun || !body || !body.isConnected) return;
        if (line) line.textContent = 'Writing section ' + (i + 1) + ' of ' + sections.length + ': ' + sections[i].title;
        var block = document.createElement('div');
        block.className = 'cs-progress-section';
        block.innerHTML = '<div class="cs-section-writing">Writing...</div><div class="cs-section-content"></div>';
        body.appendChild(block);
        await _sleep(i === 0 ? 120 : 420);
        if (runId !== _csRun || !block.isConnected) return;
        _renderMarkdown(block.querySelector('.cs-section-content'), sections[i].markdown);
        var writing = block.querySelector('.cs-section-writing');
        if (writing) writing.remove();
        block.classList.add('is-written');
        _wireSectionTools(body, els);
        await _sleep(360);
      }
      if (runId !== _csRun) return;
      if (line) line.textContent = _completionLabel(res);
      if (after) after.removeAttribute('hidden');
      if (viewBtn) viewBtn.disabled = false;
      _bindSourceClicks(els.result);
    })();
  }

  var _paperEl = null;
  var _paperEsc = null;

  function _closePaper() {
    if (_paperEsc) { document.removeEventListener('keydown', _paperEsc); _paperEsc = null; }
    if (_paperEl) { _paperEl.remove(); _paperEl = null; }
  }

  // Lazy-load html2pdf (jsPDF + html2canvas) once, so "Download PDF" produces a
  // file directly — no browser print dialog.
  function _ensureHtml2Pdf() {
    if (window.html2pdf) return Promise.resolve(window.html2pdf);
    if (window._ssHtml2PdfP) return window._ssHtml2PdfP;
    window._ssHtml2PdfP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js';
      s.onload = function () { resolve(window.html2pdf); };
      s.onerror = function () { reject(new Error('pdf lib failed to load')); };
      document.head.appendChild(s);
    });
    return window._ssHtml2PdfP;
  }

  function _safeName(s) {
    return String(s || 'document').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'document';
  }

  function _downloadPdf(el, filename) {
    return _ensureHtml2Pdf().then(function (h2p) {
      return h2p().set({
        margin: [10, 10, 10, 10],
        filename: filename,
        image: { type: 'jpeg', quality: 0.96 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['.cs-block', '.katex-display', '.md-table'] },
      }).from(el).save();
    });
  }

  function _hasQualityWarnings(res) {
    var q = (res && res.quality) || {};
    return !!(
      (res && res.citationWarning) ||
      q.droppedMalformedFormulas ||
      q.droppedUnsupportedFormulas ||
      q.droppedGenericNotes ||
      (q.evidenceNormalization && q.evidenceNormalization.dropped_formula_lines)
    );
  }

  function _completionLabel(res) {
    return _hasQualityWarnings(res) ? 'Cheatsheet generated with quality warnings' : 'Cheatsheet complete';
  }

  function _wireDownload(btn, getEl, filename) {
    if (!btn) return;
    btn.addEventListener('click', function () {
      var el = getEl();
      if (!el) return;
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Generating…';
      _downloadPdf(el, filename).then(function () {
        btn.disabled = false;
        btn.textContent = label;
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = label;
        if (window.showToast) window.showToast('Download failed', 'Could not generate the PDF. Please try again.');
      });
    });
  }

  function _openPaper(opts) {
    opts = opts || {};
    _closePaper();
    var ov = document.createElement('div');
    ov.className = 'cs-paper-overlay ss-print-root';
    ov.innerHTML =
      '<div class="cs-paper-bar">' +
        '<span class="cs-paper-bar-title">' + _esc(opts.title || 'Cheatsheet') + '</span>' +
        '<div class="cs-paper-bar-actions">' +
          '<select class="cs-paper-select" data-act="columns" title="Change columns"><option value="2">2 cols</option><option value="3">3 cols</option><option value="4">4 cols</option></select>' +
          '<select class="cs-paper-select" data-act="font" title="Change font size"><option value="0.72rem">Small</option><option value="0.78rem">Medium</option><option value="0.86rem">Large</option></select>' +
          '<button type="button" class="cs-paper-btn" data-act="download">⤓ Download PDF</button>' +
          '<button type="button" class="cs-paper-btn cs-paper-close" data-act="close">Close</button>' +
        '</div>' +
      '</div>' +
      '<div class="cs-paper-scroll">' +
        '<article class="cs-paper">' +
          '<header class="cs-paper-head">' +
            '<h1>' + _esc(opts.course || 'Cheatsheet') + '</h1>' +
            (opts.scope ? '<div class="cs-paper-scope">' + _esc(opts.scope) + '</div>' : '') +
            (opts.meta ? '<div class="cs-paper-meta">' + _esc(opts.meta) + '</div>' : '') +
          '</header>' +
          '<div class="cs-paper-body"></div>' +
        '</article>' +
      '</div>';
    document.body.appendChild(ov);
    _paperEl = ov;
    // Settings drive the existing dense paper layout via CSS custom properties.
    var paper = ov.querySelector('.cs-paper');
    var st = opts.settings || {};
    if (paper) {
      if (st.columns) paper.style.setProperty('--cs-columns', String(st.columns));
      var fontEm = { xs: '0.72rem', sm: '0.78rem', md: '0.86rem' }[st.font || 'sm'];
      if (fontEm) paper.style.setProperty('--cs-font', fontEm);
      if (st.style) paper.setAttribute('data-style', st.style);
    }
    var colSel = ov.querySelector('[data-act="columns"]');
    var fontSel = ov.querySelector('[data-act="font"]');
    if (colSel && st.columns) colSel.value = String(st.columns);
    if (fontSel) fontSel.value = ({ xs: '0.72rem', sm: '0.78rem', md: '0.86rem' }[st.font || 'sm']) || '0.78rem';
    if (colSel) colSel.addEventListener('change', function () {
      if (paper) paper.style.setProperty('--cs-columns', colSel.value);
    });
    if (fontSel) fontSel.addEventListener('change', function () {
      if (paper) paper.style.setProperty('--cs-font', fontSel.value);
    });
    var body = ov.querySelector('.cs-paper-body');
    if (body) _renderMarkdown(body, opts.markdown || '', true);
    ov.querySelector('[data-act="close"]').addEventListener('click', _closePaper);
    _wireDownload(
      ov.querySelector('[data-act="download"]'),
      function () { return ov.querySelector('.cs-paper'); },
      _safeName((opts.course || 'cheatsheet') + ' cheatsheet') + '.pdf'
    );
    _paperEsc = function (e) { if (e.key === 'Escape') _closePaper(); };
    document.addEventListener('keydown', _paperEsc);
  }

  // Honest sources block. The chips are the files/pages where these TOPICS
  // appear in the user's materials — not a per-formula verification. When the
  // mechanical grounding check passed for most formulas we say so, modestly.
  function _sourcesHtml(sources, grounding) {
    if (!sources || !sources.length) return '';
    var chips = sources.map(function (s) {
      var pg = s.pageStart == null ? '' : s.pageStart;
      return '<span class="src-cite" title="Open this source" data-src-file="' + _esc(s.fileName || '') +
        '" data-src-page="' + _esc(pg) + '">' + _esc(s.fileName || 'Source') +
        (pg ? ', p.' + _esc(pg) : '') + '</span>';
    }).join(' · ');
    var note = '';
    if (grounding && grounding.ratio != null && grounding.total >= 3) {
      note = grounding.ratio >= 0.8
        ? '<div class="cs-ground cs-ground-ok">✓ ' + grounding.grounded + '/' + grounding.total + ' formulas matched to your source text</div>'
        : '<div class="cs-ground cs-ground-weak">' + grounding.grounded + '/' + grounding.total + ' formulas matched to your source text — verify the rest</div>';
    }
    return '<div class="cs-sources"><span class="cs-sources-label">From your files (where these topics appear):</span> ' +
      chips + '</div>' + note;
  }

  function _bindSourceClicks(scope) {
    scope.querySelectorAll('.cs-sources .src-cite').forEach(function (el) {
      el.addEventListener('click', function () {
        var fn = el.getAttribute('data-src-file');
        if (!fn || typeof window.openCitedSource !== 'function') return;
        window.openCitedSource({ fileName: fn, page: el.getAttribute('data-src-page') }, 'popup');
      });
    });
  }

  function _renderResult(els, res) {
    if (!res || res.error) {
      els.result.innerHTML =
        '<div class="cs-msg cs-error">' + _esc((res && res.error) || 'Cheatsheet failed. Please try again.') + '</div>';
      return;
    }
    if (!res.text || !res.text.trim()) {
      els.result.innerHTML =
        '<div class="cs-msg">' + _esc(res.warning || 'No cheatsheet could be generated from your course materials yet.') + '</div>';
      return;
    }
    var topics = (res.topicsCovered || []).filter(Boolean);
    var sources = res.groundedSources || [];
    var nFiles = sources.reduce(function (set, s) { if (s.fileName) set[s.fileName] = 1; return set; }, {});
    var fileCount = Object.keys(nFiles).length;
    els._paper = {
      course: els.courseName || 'Cheatsheet',
      title: res.title || 'Cheatsheet',
      scope: res.title || 'Course cheatsheet',
      meta: (fileCount ? 'Based on ' + fileCount + ' file' + (fileCount === 1 ? '' : 's') + ' · ' : '') + 'generated cheatsheet',
      markdown: res.text,
      settings: res.settings,
    };
    els.result.innerHTML =
      '<div class="cs-sheet">' +
        '<div class="cs-sheet-head">' +
          '<h3>' + _esc(res.title || 'Cheatsheet') + '</h3>' +
          (res.noteId ? '<span class="cs-saved">Saved to your notes</span>' : '') +
          '<button type="button" class="cs-btn cs-view-print" data-cs-view>View / Print</button>' +
        '</div>' +
        '<div class="cs-sheet-body"></div>' +
        (res.citationWarning ? '<div class="cs-cite-warn">' + _esc(res.citationWarning) + '</div>' : '') +
        (topics.length ? '<div class="cs-topics">Topics: ' + topics.map(_esc).join(' · ') + '</div>' : '') +
        _sourcesHtml(sources, res.grounding) +
      '</div>';
    var body = els.result.querySelector('.cs-sheet-body');
    if (body) _renderMarkdown(body, res.text);
    var viewBtn = els.result.querySelector('[data-cs-view]');
    if (viewBtn) viewBtn.addEventListener('click', function () { _openPaper(els._paper); });
    _bindSourceClicks(els.result);
  }

  // ── saved cheatsheets (persisted as notes of type 'cheatsheet') ────────────

  function _fmtDate(s) {
    if (!s) return '';
    try {
      return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function _viewSaved(svc, els, id) {
    if (!id || !svc.getNoteById) return;
    els.result.innerHTML = '<div class="cs-msg cs-loading">Loading cheatsheet…</div>';
    svc.getNoteById(id).then(function (note) {
      if (!note) { els.result.innerHTML = '<div class="cs-msg cs-error">Could not load this cheatsheet.</div>'; return; }
      els._paper = {
        course: els.courseName || 'Cheatsheet',
        title: note.title || 'Cheatsheet',
        scope: note.title || 'Saved cheatsheet',
        meta: 'Saved cheatsheet',
        markdown: note.content_markdown || '',
      };
      els.result.innerHTML =
        '<div class="cs-sheet"><div class="cs-sheet-head"><h3>' + _esc(note.title || 'Cheatsheet') + '</h3>' +
        '<button type="button" class="cs-btn cs-view-print" data-cs-view>View / Print</button></div>' +
        '<div class="cs-sheet-body"></div></div>';
      var body = els.result.querySelector('.cs-sheet-body');
      if (body) _renderMarkdown(body, note.content_markdown || '');
      var viewBtn = els.result.querySelector('[data-cs-view]');
      if (viewBtn) viewBtn.addEventListener('click', function () { _openPaper(els._paper); });
    }).catch(function () {
      els.result.innerHTML = '<div class="cs-msg cs-error">Could not load this cheatsheet.</div>';
    });
  }

  function _renderSavedList(svc, els, courseId, sheets) {
    if (!els.saved || !els.savedList) return;
    if (!sheets || !sheets.length) {
      els.saved.setAttribute('hidden', '');
      els.savedList.innerHTML = '';
      return;
    }
    els.saved.removeAttribute('hidden');
    els.savedList.innerHTML = sheets.map(function (n) {
      return '<div class="cs-saved-item">' +
        '<button type="button" class="cs-saved-open" data-id="' + _esc(n.id) + '">' +
          '<span class="cs-saved-title">' + _esc(n.title || 'Cheatsheet') + '</span>' +
          '<span class="cs-saved-date">' + _esc(_fmtDate(n.created_at || n.updated_at)) + '</span>' +
        '</button>' +
        '<button type="button" class="cs-saved-del" data-id="' + _esc(n.id) + '" title="Delete cheatsheet" aria-label="Delete cheatsheet">×</button>' +
      '</div>';
    }).join('');
    els.savedList.querySelectorAll('.cs-saved-open').forEach(function (b) {
      b.addEventListener('click', function () { _viewSaved(svc, els, b.getAttribute('data-id')); });
    });
    els.savedList.querySelectorAll('.cs-saved-del').forEach(function (b) {
      b.addEventListener('click', function () {
        b.disabled = true;
        svc.deleteNote(b.getAttribute('data-id')).then(function () { _loadSaved(svc, els, courseId); });
      });
    });
  }

  function _loadSaved(svc, els, courseId) {
    if (!svc.listCourseNotes || !courseId) return;
    svc.listCourseNotes(courseId).then(function (notes) {
      var sheets = (notes || []).filter(function (n) { return n.type === 'cheatsheet'; });
      _renderSavedList(svc, els, courseId, sheets);
    }).catch(function () { /* non-fatal: saved list is additive */ });
  }

  // Source picker — pick which indexed PDFs to build the cheatsheet from.
  // All files start checked (one click = whole course); selecting a small
  // subset triggers the backend's per-PDF sectioned + deduped mode.
  function _courseFileFolderIndex(course) {
    var fileToFolder = {};
    var live = {};
    (course && course.files || []).forEach(function (f) {
      if (f && f.name) live[f.name] = true;
    });
    (course && course.userFolders || []).forEach(function (fd) {
      (fd.files || []).forEach(function (f) {
        if (!f || !f.name) return;
        live[f.name] = true;
        fileToFolder[f.name] = fd.name || 'Folder';
      });
    });
    return { fileToFolder: fileToFolder, live: live };
  }

  function _groupDocsByFolder(docs, course) {
    var idx = _courseFileFolderIndex(course);
    var liveNames = Object.keys(idx.live);
    if (liveNames.length) {
      docs = (docs || []).filter(function (d) {
        return !!idx.live[d.file_name || d.fileName || ''];
      });
    }
    var map = {};
    var order = [];
    var other = [];
    (docs || []).forEach(function (d) {
      var name = d.file_name || d.fileName || '';
      var folder = idx.fileToFolder[name];
      if (folder) {
        if (!map[folder]) { map[folder] = []; order.push(folder); }
        map[folder].push(d);
      } else {
        other.push(d);
      }
    });
    return { map: map, order: order, other: other };
  }

  function _showSourcePicker(docs, course, onConfirm) {
    var existing = document.getElementById('csSourcePickerOverlay');
    if (existing) existing.remove();
    var grouped = _groupDocsByFolder(docs, course);
    function itemHtml(d) {
      return '<label class="cs-sp-item">' +
        '<input type="checkbox" class="cs-sp-cb" value="' + _esc(d.id) + '" checked>' +
        '<span class="cs-sp-name">' + _esc(d.file_name || d.fileName || 'Untitled') + '</span>' +
      '</label>';
    }
    function folderHtml(name, docsInFolder, idx) {
      return '<div class="cs-sp-folder" data-folder-idx="' + _esc(idx) + '">' +
        '<div class="cs-sp-folder-head">' +
          '<button class="cs-sp-folder-toggle" type="button" aria-label="Toggle folder">&#9662;</button>' +
          '<span class="cs-sp-folder-name">' + _esc(name) + '</span>' +
          '<span class="cs-sp-folder-count">' + docsInFolder.length + ' file' + (docsInFolder.length === 1 ? '' : 's') + '</span>' +
          '<button class="cs-sp-folder-action" data-folder-act="all" type="button">Select all</button>' +
          '<button class="cs-sp-folder-action" data-folder-act="none" type="button">Clear</button>' +
        '</div>' +
        '<div class="cs-sp-folder-files">' + docsInFolder.map(itemHtml).join('') + '</div>' +
      '</div>';
    }
    var sections = grouped.order.map(function (name, i) {
      return folderHtml(name, grouped.map[name], i);
    }).join('');
    if (grouped.other.length) sections += folderHtml('Other files', grouped.other, 'other');
    var visibleCount = grouped.order.reduce(function (n, name) {
      return n + grouped.map[name].length;
    }, grouped.other.length);
    var ov = document.createElement('div');
    ov.id = 'csSourcePickerOverlay';
    ov.className = 'cs-sp-overlay';
    ov.innerHTML =
      '<div class="cs-sp-modal">' +
        '<div class="cs-sp-head"><span class="cs-sp-title">Choose source PDFs</span>' +
          '<button class="cs-sp-close" type="button" aria-label="Close">&times;</button></div>' +
        '<p class="cs-sp-sub">All files are selected by default. Pick a few PDFs to scope the sheet — each gets its own section and repeats are removed.</p>' +
        '<div class="cs-sp-list cs-sp-folder-list">' + sections + '</div>' +
        '<div class="cs-sp-actions">' +
          '<button class="cs-sp-ghost" id="csSpAll" type="button">Select all</button>' +
          '<button class="cs-sp-ghost" id="csSpClear" type="button">Clear</button>' +
          '<button class="cs-sp-primary" id="csSpConfirm" type="button">Generate from selected</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    ov.querySelector('.cs-sp-close').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelectorAll('.cs-sp-folder-head').forEach(function (head) {
      head.addEventListener('click', function (e) {
        if (e.target.closest('.cs-sp-folder-action')) return;
        var folder = head.closest('.cs-sp-folder');
        var files = folder && folder.querySelector('.cs-sp-folder-files');
        var collapsed = folder && folder.classList.toggle('is-collapsed');
        if (files) files.style.display = collapsed ? 'none' : 'flex';
        var toggle = head.querySelector('.cs-sp-folder-toggle');
        if (toggle) toggle.innerHTML = collapsed ? '&#9656;' : '&#9662;';
      });
    });
    ov.querySelectorAll('.cs-sp-folder-action').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var folder = btn.closest('.cs-sp-folder');
        var checked = btn.getAttribute('data-folder-act') === 'all';
        if (folder) folder.querySelectorAll('.cs-sp-cb').forEach(function (cb) { cb.checked = checked; });
      });
    });
    ov.querySelector('#csSpAll').onclick = function () {
      ov.querySelectorAll('.cs-sp-cb').forEach(function (cb) { cb.checked = true; });
    };
    ov.querySelector('#csSpClear').onclick = function () {
      ov.querySelectorAll('.cs-sp-cb').forEach(function (cb) { cb.checked = false; });
    };
    ov.querySelector('#csSpConfirm').onclick = function () {
      var ids = [];
      ov.querySelectorAll('.cs-sp-cb:checked').forEach(function (cb) { ids.push(cb.value); });
      if (!ids.length) {
        if (window.showToast) window.showToast('No files selected', 'Select at least one PDF.');
        return;
      }
      close();
      // Small selection (incl. a small all-checked course) → pass ids so the
      // backend runs per-PDF mode (≤5 docs). A large all-checked selection →
      // null = whole-course topic sheet (also avoids the proxy's 25-doc cap).
      var allChecked = ids.length === visibleCount;
      onConfirm(allChecked && ids.length > 5 ? null : ids);
    };
  }

  window.mountCheatsheet = function (target, course) {
    if (!target) return;
    target.innerHTML = _HTML;
    var root = target.querySelector('[data-cheatsheet-root]');
    if (!root) return;
    var courseId = (course && course.id) || window.activeCourseId || '';
    var els = {
      courseName: (course && (course.name || course.title)) || 'Cheatsheet',
      topic: root.querySelector('#csTopic'),
      gen: root.querySelector('#csGenerate'),
      result: root.querySelector('#csResult'),
      saved: root.querySelector('#csSaved'),
      savedList: root.querySelector('#csSavedList'),
      pages: root.querySelector('#csPages'),
      columns: root.querySelector('#csColumns'),
      style: root.querySelector('#csStyle'),
      fontSize: root.querySelector('#csFontSize'),
      detail: root.querySelector('#csDetail'),
      lang: root.querySelector('#csLang'),
      output: root.querySelector('#csOutput'),
      conflict: root.querySelector('#csConflict'),
    };
    if (!els.gen) return;

    var state = { preset: 'balanced' };

    // Recommended layout per mode — applied to the controls when a preset is
    // picked so each mode also *looks* distinct (the user can still override).
    var _PRESET_DEFAULTS = {
      exam_night:        { pages: '1', columns: '3', style: 'compact',  fontSize: 'small',  detail: 'general' },
      open_book_exam:    { pages: '2', columns: '3', style: 'academic', fontSize: 'auto',   detail: 'balanced' },
      formula_reference: { pages: '2', columns: '3', style: 'compact',  fontSize: 'small',  detail: 'specific' },
      balanced:          { pages: '2', columns: '3', style: 'academic', fontSize: 'auto',   detail: 'balanced' },
      deep_revision:     { pages: '4', columns: '2', style: 'academic', fontSize: 'medium', detail: 'very_thorough' },
      topic_mastery:     { pages: '2', columns: '2', style: 'modern',   fontSize: 'medium', detail: 'specific' },
    };
    function _applyPresetDefaults(name) {
      var d = _PRESET_DEFAULTS[name];
      if (!d) return;
      if (els.pages) els.pages.value = d.pages;
      if (els.columns) els.columns.value = d.columns;
      if (els.style) els.style.value = d.style;
      if (els.fontSize) els.fontSize.value = d.fontSize;
      if (els.detail) els.detail.value = d.detail;
    }

    // ── settings panel ──
    function _readSettings() {
      var s = { preset: state.preset };
      var p = els.pages && els.pages.value;
      if (p) s.pages = parseInt(p, 10);
      var c = els.columns && els.columns.value;
      if (c) s.columns = parseInt(c, 10);
      if (els.style && els.style.value) s.style = els.style.value;
      if (els.fontSize && els.fontSize.value) s.fontSize = els.fontSize.value;
      if (els.detail && els.detail.value) s.detailLevel = els.detail.value;
      var l = els.lang && els.lang.value;
      if (l && l !== 'source') s.language = l;
      if (els.output && els.output.value) s.output = els.output.value;
      return s;
    }
    function _checkConflicts() {
      if (!els.conflict) return;
      var topic = ((els.topic && els.topic.value) || '').trim();
      var pages = els.pages && els.pages.value ? parseInt(els.pages.value, 10) : null;
      var columns = els.columns && els.columns.value ? parseInt(els.columns.value, 10) : null;
      var fontSize = els.fontSize && els.fontSize.value;
      var detail = els.detail && els.detail.value;
      var msg = '';
      if (pages === 1 && columns === 4 && fontSize === 'large') {
        msg = '4 columns + Large text + 1 page may not fit. Use Small text or 2 pages.';
      } else if (pages === 1 && detail === 'very_thorough') {
        msg = 'Very Thorough + 1 page will keep only highest-priority details.';
      } else if (state.preset === 'topic_mastery' && !topic) {
        msg = 'Topic Mastery works best with a topic in the focus box.';
      } else if (state.preset === 'deep_revision' && pages === 1) {
        msg = 'Deep Revision on 1 page will be very cramped — consider 2+ pages.';
      } else if (state.preset === 'exam_night' && pages && pages >= 3) {
        msg = 'Exam Night is tuned for 1 dense page; more pages dilute it.';
      }
      els.conflict.textContent = msg;
      els.conflict.hidden = !msg;
    }
    root.querySelectorAll('.cs-preset').forEach(function (b) {
      b.addEventListener('click', function () {
        state.preset = b.getAttribute('data-preset') || 'balanced';
        root.querySelectorAll('.cs-preset').forEach(function (x) { x.classList.toggle('is-active', x === b); });
        _applyPresetDefaults(state.preset);
        _checkConflicts();
      });
    });
    if (els.pages) els.pages.addEventListener('change', _checkConflicts);
    if (els.columns) els.columns.addEventListener('change', _checkConflicts);
    if (els.fontSize) els.fontSize.addEventListener('change', _checkConflicts);
    if (els.detail) els.detail.addEventListener('change', _checkConflicts);
    if (els.topic) els.topic.addEventListener('input', _checkConflicts);

    _aiService().then(function (svc) { _loadSaved(svc, els, courseId); });

    function doGenerate(documentIds) {
      var topic = ((els.topic && els.topic.value) || '').trim();
      var settings = _readSettings();
      settings.focusMode = documentIds && documentIds.length
        ? 'selected_files'
        : (topic ? 'specific_topic' : 'whole_course');
      els.gen.disabled = true;
      els.result.innerHTML = '<div class="cs-msg cs-loading">Generating cheatsheet… this can take a moment.</div>';
      var progress = _startBuildSteps(els, topic);
      _aiService()
        .then(function (svc) {
          var opts = { settings: settings };
          if (topic) opts.topic = topic;
          if (documentIds && documentIds.length) opts.documentIds = documentIds;
          return svc.generateCheatsheet(courseId, opts).then(function (res) {
            els.gen.disabled = false;
            progress.stop();
            _renderResultProgressive(els, res, progress.id);
            // A new cheatsheet was just saved — refresh the saved list.
            if (res && res.noteId) _loadSaved(svc, els, courseId);
            return res;
          });
        })
        .catch(function (err) {
          els.gen.disabled = false;
          progress.stop();
          els.result.innerHTML =
            '<div class="cs-msg cs-error">' + _esc(err && err.message ? err.message : 'Cheatsheet failed. Please try again.') + '</div>';
        });
    }

    els._regenerateSection = function (title) {
      if (title && els.topic) els.topic.value = title.replace(/^Method Picker$/i, '').trim();
      doGenerate(null);
    };

    els.gen.addEventListener('click', function () {
      if (!courseId) return;
      els.gen.disabled = true;
      _aiService()
        .then(function (svc) { return svc.listCourseDocuments(courseId); })
        .then(function (docs) {
          els.gen.disabled = false;
          var ready = (docs || []).filter(function (d) { return d.processing_status === 'ready'; });
          if (!ready.length) {
            els.result.innerHTML = '<div class="cs-msg">No indexed files yet — upload and index a PDF first.</div>';
            return;
          }
          _showSourcePicker(ready, course, function (documentIds) { doGenerate(documentIds); });
        })
        .catch(function () {
          els.gen.disabled = false;
          els.result.innerHTML = '<div class="cs-msg cs-error">Could not load your files. Please try again.</div>';
        });
    });
  };
})();
