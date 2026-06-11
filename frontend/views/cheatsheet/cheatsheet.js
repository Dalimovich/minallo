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
      // Highlight body may contain a single `=` (e.g. a Merken cue
      // "==Druckguss = Großserie=="); allow any char except the closing `==`,
      // so a lone `=` no longer breaks the match and leaks raw `==` to the PDF.
      var html = _esc(t)
        .replace(/==((?:[^=\n]|=(?!=))+)==/g, '<mark class="cs-hl">$1</mark>')
        .replace(/\{\{([^}]+)\}\}/g, '<span class="cs-key">$1</span>');
      if (_LABEL_WARN.test(t)) html = '<span class="cs-warn">' + html + '</span>';
      else if (_LABEL_NOTE.test(t)) html = '<span class="cs-note">' + html + '</span>';
      var span = document.createElement('span');
      span.innerHTML = html;
      node.parentNode.replaceChild(span, node);
    });
  }

  var _secSeq = 0;

  // Split a section block into ATOM blocks at safe boundaries so a long section can
  // continue in the next column/page instead of forcing a blank page. The heading +
  // everything up to the first labelled group stays together (never split a heading
  // from its first content); each subsequent **Bold label:** group (Use when /
  // Formulas / Conditions / Watch out …) becomes its own atom. A section with no
  // such labels, or a table (wide) section, is never split. Atoms of one section
  // share data-cs-sec; continuation atoms carry data-cs-cont and the section title
  // (the paginator adds a "· continued" label only when an atom actually starts a
  // new column). Returns an array of atom elements (the original element is reused
  // as the first atom).
  function _splitSectionAtoms(sectionEl, wide) {
    if (wide) return [sectionEl];
    var nodes = Array.prototype.slice.call(sectionEl.childNodes).filter(function (n) {
      return n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim());
    });
    var heading = sectionEl.querySelector('h2, h3');
    var title = heading ? heading.textContent.trim() : '';

    function startsNewAtom(node) {
      // A safe split point: a <p>/<div>/list that LEADS with a bold label. Never a
      // heading, a displayed formula, or a table (those must stay with their group).
      if (node.nodeType !== 1) return false;
      if (/^(H2|H3|TABLE)$/.test(node.tagName)) return false;
      if (node.classList && node.classList.contains('katex-display')) return false;
      var fe = node.firstElementChild;
      return !!(fe && /^(STRONG|B)$/.test(fe.tagName));
    }

    var groups = [];
    var cur = null;
    nodes.forEach(function (node) {
      if (cur === null || (cur.length && startsNewAtom(node))) {
        cur = [];
        groups.push(cur);
      }
      cur.push(node);
    });
    if (groups.length <= 1) return [sectionEl];

    var secId = 'sec' + (++_secSeq);
    var atoms = [];
    groups.forEach(function (grp, gi) {
      var atomEl;
      if (gi === 0) {
        atomEl = sectionEl; // group 0 keeps the heading + first labelled group
      } else {
        atomEl = document.createElement('div');
        atomEl.className = 'cs-block';
        grp.forEach(function (nd) { atomEl.appendChild(nd); }); // MOVES nodes out
        atomEl.setAttribute('data-cs-cont', '1');
      }
      atomEl.setAttribute('data-cs-sec', secId);
      if (title) atomEl.setAttribute('data-cs-title', title);
      atoms.push(atomEl);
    });
    return atoms;
  }

  // Group each `##` section (h2 + following siblings) into a detached .cs-block,
  // then split long sections into atom blocks (see _splitSectionAtoms). A section
  // containing a table is tagged wide (it becomes a full-width band, never split).
  // Returns [{el, wide, h, cont, title}] WITHOUT re-appending.
  function _collectBlocks(body) {
    var kids = Array.prototype.slice.call(body.childNodes);
    var groups = [];
    var cur = null;
    kids.forEach(function (node) {
      if ((node.nodeType === 1 && node.tagName === 'H2') || !cur) {
        cur = document.createElement('div');
        cur.className = 'cs-block';
        groups.push(cur);
      }
      cur.appendChild(node);
    });
    var out = [];
    groups.forEach(function (b) {
      var wide = !!b.querySelector('table');
      if (wide) b.classList.add('cs-block--wide');
      _splitSectionAtoms(b, wide).forEach(function (atomEl) {
        _addBlockTools(atomEl);
        out.push({
          el: atomEl,
          wide: wide,
          h: 0,
          cont: atomEl.getAttribute('data-cs-cont') === '1',
          title: atomEl.getAttribute('data-cs-title') || '',
        });
      });
    });
    return out;
  }

  // Per-section editor chrome: a drag handle + a "page break before" toggle.
  // position:absolute so it never affects the measured block height; stripped
  // from the exported PDF (onclone) and from print. Wired once; survives re-packs.
  function _addBlockTools(b) {
    var tools = document.createElement('div');
    tools.className = 'cs-block-tools';
    tools.contentEditable = 'false';
    tools.innerHTML =
      '<button type="button" class="cs-drag" title="Drag to reorder">⠿</button>' +
      '<button type="button" class="cs-brk" title="Start a new page before this section">⤓ break</button>';
    // Don't let a tool click bubble into selection/drag of the section text.
    tools.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    var brk = tools.querySelector('.cs-brk');
    brk.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      b.classList.toggle('cs-break-before');
      var paper = b.closest('.cs-paper');
      if (paper) _repaginate(paper);
    });
    b.insertBefore(tools, b.firstChild);
  }

  // Break-state lives on the element's class so it survives re-packs.
  function _hasBreak(el) { return el.classList.contains('cs-break-before'); }

  // Fallback (only if the paged engine throws): the old single multi-column flow.
  function _wrapBlocksFallback(body, blocks) {
    body.innerHTML = '';
    blocks.forEach(function (b) { body.appendChild(b.el); });
  }

  // SortableJS (CDN, like html2pdf) powers cross-column drag-to-reorder.
  function _ensureSortable() {
    if (window.Sortable) return Promise.resolve(window.Sortable);
    if (window._ssSortableP) return window._ssSortableP;
    window._ssSortableP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js';
      s.onload = function () { resolve(window.Sortable); };
      s.onerror = function () {
        // Evict cache + dead tag so the next open retries (a cached rejection
        // disabled drag-to-reorder for the whole session after one CDN blip).
        window._ssSortableP = null;
        s.remove();
        reject(new Error('sortable lib failed to load'));
      };
      document.head.appendChild(s);
    });
    return window._ssSortableP;
  }

  function _destroySortables(paper) {
    (paper._csSortables || []).forEach(function (s) { try { s.destroy(); } catch (e) {} });
    paper._csSortables = [];
  }

  // Make every column and full-width band a drop target in one shared group, so a
  // section can be dragged anywhere. On drop we read the new DOM order and re-pack
  // (engine refills) — so pages stay full and nothing is stranded.
  function _initSortables(paper) {
    if (!window.Sortable || !paper._csState) return;
    _destroySortables(paper);
    var containers = Array.prototype.slice.call(
      paper.querySelectorAll('.cs-col, .cs-band-wide')
    );
    paper._csSortables = containers.map(function (c) {
      return window.Sortable.create(c, {
        group: 'cs-sections',
        handle: '.cs-drag',
        draggable: '.cs-block',
        animation: 130,
        ghostClass: 'cs-sortable-ghost',
        chosenClass: 'cs-sortable-chosen',
        dragClass: 'cs-sortable-drag',
        onEnd: function () {
          // Defer so Sortable finishes before we read the DOM. We do NOT re-pack:
          // the section stays exactly where it was dropped (free placement). We
          // only sync st.blocks to the new visual order so export + later re-packs
          // (column/font change) respect it.
          setTimeout(function () { _syncOrderFromDom(paper); }, 0);
        },
      });
    });
  }

  // Sync st.blocks to the post-drag visual order (pages → bands → columns
  // left-to-right, blocks top-to-bottom = document order) WITHOUT re-packing, so
  // the dropped section keeps its new spot. The order is saved for export and for
  // any later re-pack (column/font/padding change), which legitimately rebuilds.
  function _syncOrderFromDom(paper) {
    var st = paper._csState;
    if (!st) return;
    var byEl = new Map();
    st.blocks.forEach(function (b) { byEl.set(b.el, b); });
    var ordered = [];
    Array.prototype.slice.call(paper.querySelectorAll('.cs-page .cs-block')).forEach(function (el) {
      var b = byEl.get(el);
      if (b) ordered.push(b);
    });
    if (ordered.length === st.blocks.length) st.blocks = ordered;
  }

  // ── Paged layout engine ────────────────────────────────────────────────────
  // Measures each section block and PACKS blocks into explicit A4-landscape pages:
  // a table section becomes a full-width band, runs of cards become multi-column
  // bands. Pages fill (top-down, column by column) before spilling to the next, so
  // there are no blank trailing pages, no section cut across a page, and no lonely
  // block stranded on an empty page. Re-runnable on column/font change.
  var _COL_GAP = 18, _BLOCK_GAP = 10, _BAND_GAP = 12, _SAFETY = 8;

  function _layoutPages(paper) {
    var st = paper && paper._csState;
    if (!st || !st.blocks.length) return;
    var nCols = parseInt(paper.style.getPropertyValue('--cs-columns'), 10) || 3;

    // Tear down drag instances before we rebuild the DOM they were bound to.
    _destroySortables(paper);

    // Detach header + all blocks from any previous layout, then clear old pages.
    if (st.header && st.header.parentNode) st.header.parentNode.removeChild(st.header);
    st.blocks.forEach(function (b) { if (b.el.parentNode) b.el.parentNode.removeChild(b.el); });
    Array.prototype.slice.call(paper.querySelectorAll('.cs-page'))
      .forEach(function (n) { n.remove(); });
    paper.classList.add('is-paged');

    // Geometry: measure a real (hidden) page's inner content box in px.
    var probe = document.createElement('div');
    probe.className = 'cs-page';
    probe.style.cssText = 'visibility:hidden;position:absolute;left:-99999px;top:0;margin:0;';
    var probeInner = document.createElement('div');
    probeInner.className = 'cs-page-inner';
    probe.appendChild(probeInner);
    paper.appendChild(probe);
    var innerW = probeInner.clientWidth;
    var innerH = probeInner.clientHeight;
    paper.removeChild(probe);
    if (!innerW || !innerH) throw new Error('cs: zero page geometry');

    var colW = Math.floor((innerW - (nCols - 1) * _COL_GAP) / nCols);
    var budget = innerH - _SAFETY;

    // Measure every block + pack into pages at a given font-fit SCALE, returning a
    // plan. Re-run per scale: a smaller font changes wrapping and block heights, so
    // heights must be re-measured to pack correctly. Measuring happens inside the
    // real paper (so fonts/styles apply); flow-root on .cs-block means offsetHeight
    // already contains child margins.
    function _measureAndPack(scale) {
      paper.style.setProperty('--cs-fit', String(scale));
      var mhost = document.createElement('div');
      // Match the rendered wrapping so measured heights equal rendered heights
      // (a long compound word that wraps at render must also wrap when measured).
      mhost.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;'
        + 'overflow-wrap:break-word;word-break:break-word;';
      paper.appendChild(mhost);
      var headerH = 0;
      if (st.header) {
        mhost.style.width = innerW + 'px';
        mhost.appendChild(st.header);
        headerH = st.header.offsetHeight;
        mhost.removeChild(st.header);
      }
      var headerGap = st.header ? 14 : 0;
      st.blocks.forEach(function (b) {
        mhost.style.width = (b.wide ? innerW : colW) + 'px';
        mhost.appendChild(b.el);
        b.h = b.el.offsetHeight;
        mhost.removeChild(b.el);
      });
      paper.removeChild(mhost);

      // ── Pack into pages: whole-section placement; split only when oversized ──
      // A SECTION is placed as ONE unit (all its atoms in a single column → no
      // "continued" label) using shortest-column balancing, so short/medium
      // sections never fragment. A section that doesn't fit a column is moved whole
      // to another column/page; a later short section is pulled forward to fill the
      // gap (backfill). ONLY a section taller than a FULL column is split at atom
      // boundaries across columns/pages, with a continuation label. Tables stay
      // full-width; manual page breaks anchor a new page.
      var pages = [];
      var page = null;
      var open = null;
      function newPage(first) {
        page = { first: first, used: first ? headerH + headerGap : 0, bands: [] };
        pages.push(page);
      }
      function remaining() { return budget - page.used; }
      function openBand() {
        open = { type: 'cols', maxH: remaining(), cur: 0, cols: [] };
        for (var i = 0; i < nCols; i++) open.cols.push({ items: [], h: 0 });
      }
      function bandItem(b) { return { el: b.el, h: b.h, cont: !!b.cont, title: b.title || '' }; }
      function finalizeOpen() {
        if (!open) return;
        var maxH = 0, any = false;
        open.cols.forEach(function (c) { if (c.items.length) any = true; if (c.h > maxH) maxH = c.h; });
        if (any) { page.bands.push(open); page.used += maxH + _BAND_GAP; }
        open = null;
      }
      function pageHasContent() {
        if (page.bands.length) return true;
        return !!(open && open.cols.some(function (c) { return c.items.length; }));
      }

      // Group atoms back into sections: consecutive blocks sharing data-cs-sec are
      // one section; a block with no sec id is its own section. Each section keeps
      // its atoms and total height (incl. inter-atom gaps).
      var sections = [];
      (function groupSections() {
        var cur = null, curSec = null;
        st.blocks.forEach(function (b) {
          if (b.wide) {
            sections.push({ wide: true, brk: _hasBreak(b.el), h: b.h, items: [bandItem(b)] });
            cur = null; curSec = null;
            return;
          }
          var sec = (b.el.getAttribute && b.el.getAttribute('data-cs-sec')) || null;
          if (cur && sec && sec === curSec) {
            cur.items.push(bandItem(b));
            cur.h += _BLOCK_GAP + b.h;
          } else {
            cur = { wide: false, brk: _hasBreak(b.el), h: b.h, items: [bandItem(b)] };
            curSec = sec;
            sections.push(cur);
          }
        });
      })();

      // Place a whole section into the shortest column that fits ALL of it.
      function placeUnit(S) {
        if (!open) openBand();
        var best = -1, bestH = Infinity;
        for (var i = 0; i < nCols; i++) {
          var c = open.cols[i];
          var add = (c.items.length ? _BLOCK_GAP : 0) + S.h;
          if (c.h + add <= open.maxH && c.h < bestH) { best = i; bestH = c.h; }
        }
        if (best < 0) return false;
        var col = open.cols[best];
        S.items.forEach(function (it) {
          if (col.items.length) col.h += _BLOCK_GAP;
          col.items.push(it);
          col.h += it.h;
        });
        return true;
      }

      // Split an OVERSIZED section sequentially across columns/pages (atoms in
      // order). A continuation atom that starts a new column gets a label (build).
      function placeSplit(S) {
        S.items.forEach(function (it) {
          if (!open) openBand();
          var placed = false;
          while (open.cur < nCols) {
            var c = open.cols[open.cur];
            var add = (c.items.length ? _BLOCK_GAP : 0) + it.h;
            if (!c.items.length || c.h + add <= open.maxH) {
              if (c.items.length) c.h += _BLOCK_GAP;
              c.items.push(it); c.h += it.h; placed = true; break;
            }
            open.cur++;
          }
          if (!placed) {
            finalizeOpen(); newPage(false); openBand();
            open.cols[0].items.push(it); open.cols[0].h += it.h;
          }
        });
      }

      newPage(true);
      var n = sections.length;
      var consumed = new Array(n).fill(false);
      var done = 0, i = 0, guard = 0;
      while (done < n && guard++ < n * 4 + 50) {
        while (i < n && consumed[i]) i++;
        if (i >= n) break;
        var S = sections[i];
        if (S.brk && pageHasContent()) { finalizeOpen(); newPage(false); }
        if (S.wide) {
          finalizeOpen();
          if (page.used > 0 && S.h + _BAND_GAP > remaining()) newPage(false);
          page.bands.push({ type: 'wide', el: S.items[0].el, h: S.h });
          page.used += S.h + _BAND_GAP;
          consumed[i] = true; done++; i++;
          continue;
        }
        // Oversized (taller than a full column) AND splittable → split it. Start on a
        // clean band so the split reads top-to-bottom across fresh columns.
        if (S.h > budget && S.items.length > 1) {
          if (pageHasContent()) { finalizeOpen(); newPage(false); }
          if (!open) openBand();
          placeSplit(S);
          consumed[i] = true; done++; i++;
          continue;
        }
        if (!open) openBand();
        if (placeUnit(S)) { consumed[i] = true; done++; i++; continue; }
        // S doesn't fit any column as a unit. Backfill the gap with the earliest
        // later short section that DOES fit, then retry S (likely on a new page).
        var filled = false;
        for (var j = i + 1; j < n; j++) {
          if (consumed[j]) continue;
          var T = sections[j];
          if (T.wide || T.brk || (T.h > budget && T.items.length > 1)) continue;
          if (placeUnit(T)) { consumed[j] = true; done++; filled = true; break; }
        }
        if (filled) continue;
        var bandEmpty = open.cols.every(function (c) { return !c.items.length; });
        finalizeOpen();
        if (bandEmpty) {
          // Unsplittable section taller than a full column → force-place so it is
          // never dropped (rare; e.g. one giant unlabelled block).
          if (page.used > 0) newPage(false);
          openBand();
          S.items.forEach(function (it) {
            if (open.cols[0].items.length) open.cols[0].h += _BLOCK_GAP;
            open.cols[0].items.push(it); open.cols[0].h += it.h;
          });
          consumed[i] = true; done++; i++;
        } else {
          newPage(false);
        }
      }
      finalizeOpen();

      // Last-page fill ratio → drives auto-fit.
      var last = pages[pages.length - 1];
      var lastUsed = 0;
      if (last) {
        lastUsed = last.first ? headerH + headerGap : 0;
        last.bands.forEach(function (band) {
          if (band.type === 'wide') { lastUsed += band.h + _BAND_GAP; return; }
          var m = 0;
          band.cols.forEach(function (c) { if (c.h > m) m = c.h; });
          lastUsed += m + _BAND_GAP;
        });
      }
      var lastFill = Math.min(1, lastUsed / budget);
      return { pages: pages, pageCount: pages.length, lastFill: lastFill };
    }

    // AUTO-FIT. Pack at full size first. If the LAST page is a sparse orphan (well
    // under FILL_MIN of the page), try progressively smaller font scales and keep
    // the first that actually REMOVES a page — so a lone block on a near-empty page
    // gets absorbed into the previous pages. Never shrink text unless it eliminates
    // a page; if no step helps, stay at full size (no worse than before).
    var FIT_STEPS = [1, 0.96, 0.92, 0.88, 0.84, 0.8];
    var FILL_MIN = 0.72;
    var basePlan = _measureAndPack(1);
    var chosen = basePlan, chosenScale = 1;
    if (basePlan.pageCount > 1 && basePlan.lastFill < FILL_MIN) {
      for (var si = 1; si < FIT_STEPS.length; si++) {
        var plan = _measureAndPack(FIT_STEPS[si]);
        if (plan.pageCount < basePlan.pageCount) { chosen = plan; chosenScale = FIT_STEPS[si]; break; }
      }
    }
    paper.style.setProperty('--cs-fit', String(chosenScale));
    var pages = chosen.pages;

    // Build the page DOM.
    pages.forEach(function (pg, idx) {
      var pageEl = document.createElement('div');
      pageEl.className = 'cs-page';
      var inner = document.createElement('div');
      inner.className = 'cs-page-inner';
      if (pg.first && st.header) inner.appendChild(st.header);
      pg.bands.forEach(function (band) {
        if (band.type === 'wide') {
          var w = document.createElement('div');
          w.className = 'cs-band-wide';
          w.appendChild(band.el);
          inner.appendChild(w);
        } else {
          var cc = document.createElement('div');
          cc.className = 'cs-cols';
          cc.style.gap = _COL_GAP + 'px';
          band.cols.forEach(function (col) {
            var colEl = document.createElement('div');
            colEl.className = 'cs-col';
            colEl.style.gap = _BLOCK_GAP + 'px';
            col.items.forEach(function (it, idx) {
              // A continuation atom that STARTS a column gets a subtle "· continued"
              // label; an atom that simply follows its sibling in the same column
              // flows seamlessly with no label.
              if (idx === 0 && it.cont && it.title) {
                var lab = document.createElement('div');
                lab.className = 'cs-cont';
                lab.setAttribute('aria-hidden', 'true');
                lab.textContent = it.title + ' · continued';
                colEl.appendChild(lab);
              }
              colEl.appendChild(it.el);
            });
            cc.appendChild(colEl);
          });
          inner.appendChild(cc);
        }
      });
      // If the page ends in a table band (or has no column band at all), it has no
      // .cs-col to drag a section into. Append an empty, full-height column band as
      // a visible drop zone (stripped on export).
      var lastBand = pg.bands[pg.bands.length - 1];
      if (!lastBand || lastBand.type !== 'cols') {
        var dz = document.createElement('div');
        dz.className = 'cs-cols cs-dropzone';
        dz.style.gap = _COL_GAP + 'px';
        for (var di = 0; di < nCols; di++) {
          var dcol = document.createElement('div');
          dcol.className = 'cs-col';
          dcol.style.gap = _BLOCK_GAP + 'px';
          dz.appendChild(dcol);
        }
        inner.appendChild(dz);
      }
      pageEl.appendChild(inner);
      paper.appendChild(pageEl);
    });

    // Re-enable drag-to-reorder on the freshly built columns/bands.
    _initSortables(paper);

    // A re-pack destroys and rebuilds the page DOM: put the user's images back on
    // their pages and restore the contentEditable state of the (reused) blocks.
    _attachPaperImages(paper);
    _applyEditable(paper);
  }

  // Re-pack on column/font/padding change or after a drag/break edit (geometry or
  // order changed). Keeps the last good layout if the engine throws.
  function _repaginate(paper) {
    if (!paper || !paper._csState) return;
    try { _layoutPages(paper); } catch (e) { /* keep last good layout */ }
  }

  function _paginatePaper(body) {
    var paper = body.closest('.cs-paper');
    if (!paper) return;
    var blocks = _collectBlocks(body);
    var header = paper.querySelector('.cs-paper-head');
    paper._csState = { blocks: blocks, header: header };
    try {
      _layoutPages(paper);
      if (body.parentNode) body.parentNode.removeChild(body); // old multicol container
      // Load the drag library (async); init once it's ready (and on later re-packs).
      _ensureSortable().then(function () { _initSortables(paper); }).catch(function () {});
    } catch (e) {
      // Engine failed → fall back to the original single multi-column flow.
      paper.classList.remove('is-paged');
      _wrapBlocksFallback(body, blocks);
    }
  }

  function _renderMarkdown(el, md, paper, onDone) {
    var doRender = function () {
      el.innerHTML = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(md) : _esc(md);
      if (typeof window._renderMath === 'function') window._renderMath(el);
      if (typeof window._renderCode === 'function') window._renderCode(el);
      _decorate(el);
      if (paper) _paginatePaper(el);
      if (typeof onDone === 'function') onDone();
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
          '<button type="button" class="cs-btn cs-sheet-edit" data-cs-edit disabled>✎ Edit</button>' +
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
    var editBtn = els.result.querySelector('[data-cs-edit]');
    var after = els.result.querySelector('.cs-after');
    if (viewBtn) viewBtn.addEventListener('click', function () { _openPaper(els._paper); });
    _wireInlineEdit(els, res.noteId || null);
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
      if (editBtn) editBtn.disabled = false;
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
      s.onerror = function () {
        // Evict cache + dead tag so the next download retries instead of
        // failing for the rest of the session.
        window._ssHtml2PdfP = null;
        s.remove();
        reject(new Error('pdf lib failed to load'));
      };
      document.head.appendChild(s);
    });
    return window._ssHtml2PdfP;
  }

  function _safeName(s) {
    return String(s || 'document').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 80) || 'document';
  }

  function _downloadPdf(el, filename) {
    // is-exporting hides the editor chrome via CSS; onclone also strips the tool
    // nodes from the rendered clone so they can never appear in the PDF.
    el.classList.add('is-exporting');
    return _ensureHtml2Pdf().then(function (h2p) {
      return h2p().set({
        // margin MUST be 0: the captured .cs-paper is already a full A4-landscape
        // page (297mm) with its own 10mm padding for margins. A non-zero html2pdf
        // margin offsets that page-width element to the right, pushing its right
        // edge past the page boundary so the last table column / right text column
        // is clipped on every page ("Druckkontrol…" truncated). 0 maps it 1:1.
        margin: 0,
        filename: filename,
        image: { type: 'jpeg', quality: 0.96 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          onclone: function (doc) {
            Array.prototype.slice.call(doc.querySelectorAll('.cs-block-tools, .cs-img-del, .cs-img-resize'))
              .forEach(function (n) { n.parentNode && n.parentNode.removeChild(n); });
          },
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
        // The paged engine lays out exact 210mm .cs-page tiles (margin 0); html2pdf
        // slices the canvas every 210mm so each tile = one PDF page. No explicit
        // page-breaks and no `avoid` — those caused drift/blank pages. Pure tiling.
        pagebreak: { mode: ['css', 'legacy'] },
      }).from(el).save();
    }).then(function (r) {
      el.classList.remove('is-exporting');
      return r;
    }, function (err) {
      el.classList.remove('is-exporting');
      throw err;
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

  // ── Canvas edit mode: in-place text editing + (cheatsheet only) images ─────
  // Edits live on the open canvas and flow into the downloaded PDF. Text edits
  // mutate the section blocks themselves, so they survive every re-pack; images
  // are kept in paper._csImages and re-attached after each layout rebuild.

  // Toggle contentEditable on the section blocks + header. KaTeX formulas are
  // pinned non-editable so a stray keystroke can't shred a rendered formula —
  // they move/delete as one unit instead.
  function _applyEditable(paper) {
    if (!paper) return;
    var on = !!paper._csEditing;
    Array.prototype.slice.call(paper.querySelectorAll('.cs-block, .cs-paper-head'))
      .forEach(function (el) {
        if (on) el.setAttribute('contenteditable', 'true');
        else el.removeAttribute('contenteditable');
      });
    Array.prototype.slice.call(paper.querySelectorAll('.katex'))
      .forEach(function (el) {
        if (on) el.setAttribute('contenteditable', 'false');
        else el.removeAttribute('contenteditable');
      });
  }

  function _setPaperEditing(ov, paper, on) {
    if (!paper) return;
    paper._csEditing = !!on;
    paper.classList.toggle('is-editing', !!on);
    _applyEditable(paper);
    var imgBtn = ov.querySelector('[data-act="img"]');
    if (imgBtn) imgBtn.hidden = !on;
    var editBtn = ov.querySelector('[data-act="edit"]');
    if (editBtn) {
      editBtn.textContent = on ? '✓ Done' : '✎ Edit';
      editBtn.classList.toggle('is-on', !!on);
    }
    var hint = ov.querySelector('.cs-paper-hint');
    if (hint) {
      hint.textContent = on
        ? 'Editing: click any text to change it' + (imgBtn ? ' · 🖼 Image adds a picture (drag to move, corner to resize)' : '')
        : 'Edit: drag ⠿ to move · ⤓ break = new page';
    }
    // Leaving edit mode: edited text changed block heights → re-measure + re-pack.
    if (!on) _repaginate(paper);
  }

  // Which page is in the middle of the viewport (new images land there).
  function _visiblePageIndex(ov, paper) {
    var scroll = ov.querySelector('.cs-paper-scroll');
    var pages = paper.querySelectorAll('.cs-page');
    if (!scroll || !pages.length) return 0;
    var rect = scroll.getBoundingClientRect();
    var mid = rect.top + rect.height / 2;
    for (var i = 0; i < pages.length; i++) {
      var r = pages[i].getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return i;
    }
    return 0;
  }

  function _wirePaperImage(paper, im, fig, page) {
    function apply() {
      var pw = page.clientWidth, ph = page.clientHeight;
      im.w = Math.max(36, Math.min(im.w, pw));
      fig.style.width = im.w + 'px';
      var fw = fig.offsetWidth, fh = fig.offsetHeight;
      im.x = Math.max(0, Math.min(im.x, pw - Math.min(fw, pw)));
      im.y = Math.max(0, Math.min(im.y, ph - Math.min(fh, ph)));
      fig.style.left = im.x + 'px';
      fig.style.top = im.y + 'px';
    }
    fig.addEventListener('pointerdown', function (e) {
      if (!paper._csEditing) return;
      if (e.target.closest('.cs-img-del')) return;
      var isResize = !!e.target.closest('.cs-img-resize');
      e.preventDefault();
      e.stopPropagation();
      var sx = e.clientX, sy = e.clientY;
      var ox = im.x, oy = im.y, ow = im.w;
      try { fig.setPointerCapture(e.pointerId); } catch (err) {}
      fig.classList.add('is-active');
      function move(ev) {
        if (isResize) {
          im.w = ow + (ev.clientX - sx);
        } else {
          im.x = ox + (ev.clientX - sx);
          im.y = oy + (ev.clientY - sy);
        }
        apply();
      }
      function up(ev) {
        fig.removeEventListener('pointermove', move);
        fig.removeEventListener('pointerup', up);
        fig.removeEventListener('pointercancel', up);
        fig.classList.remove('is-active');
        try { fig.releasePointerCapture(ev.pointerId); } catch (err) {}
      }
      fig.addEventListener('pointermove', move);
      fig.addEventListener('pointerup', up);
      fig.addEventListener('pointercancel', up);
    });
    var del = fig.querySelector('.cs-img-del');
    if (del) del.addEventListener('click', function (e) {
      e.stopPropagation();
      paper._csImages = (paper._csImages || []).filter(function (x) { return x !== im; });
      fig.remove();
    });
    apply();
  }

  // (Re)build the DOM for every stored image on its page. Safe to call after any
  // re-pack: old elements are dropped with the old pages and recreated here.
  function _attachPaperImages(paper) {
    var imgs = paper && paper._csImages;
    if (!imgs || !imgs.length) return;
    var pages = paper.querySelectorAll('.cs-page');
    if (!pages.length) return;
    imgs.forEach(function (im) {
      if (im.el && im.el.parentNode) im.el.parentNode.removeChild(im.el);
      im.page = Math.min(im.page || 0, pages.length - 1);
      var page = pages[im.page];
      var fig = document.createElement('div');
      fig.className = 'cs-img';
      fig.setAttribute('contenteditable', 'false');
      fig.style.left = im.x + 'px';
      fig.style.top = im.y + 'px';
      fig.style.width = im.w + 'px';
      fig.innerHTML =
        '<img src="' + im.src + '" alt="" draggable="false">' +
        '<button type="button" class="cs-img-del" title="Remove image">×</button>' +
        '<span class="cs-img-resize" title="Drag to resize"></span>';
      page.appendChild(fig);
      im.el = fig;
      _wirePaperImage(paper, im, fig, page);
    });
  }

  function _addPaperImage(ov, paper, file) {
    if (!file || !/^image\//.test(file.type || '')) return;
    var reader = new FileReader();
    reader.onload = function () {
      var src = String(reader.result || '');
      if (!src) return;
      var probe = new Image();
      probe.onload = function () {
        var pages = paper.querySelectorAll('.cs-page');
        if (!pages.length) {
          if (window.showToast) window.showToast('Images unavailable', 'The paged view is required to place images.');
          return;
        }
        paper._csImages = paper._csImages || [];
        // Stagger drop position slightly so stacked inserts stay visible.
        var n = paper._csImages.length;
        paper._csImages.push({
          src: src,
          page: _visiblePageIndex(ov, paper),
          x: 60 + (n % 5) * 24,
          y: 60 + (n % 5) * 24,
          w: Math.min(260, probe.naturalWidth || 260),
        });
        _attachPaperImages(paper);
      };
      probe.src = src;
    };
    reader.readAsDataURL(file);
  }

  function _openPaper(opts) {
    opts = opts || {};
    _closePaper();
    // Images are a cheatsheet-only canvas feature; a summary opened in the same
    // paper view still gets in-place text editing, but no image button.
    var kind = opts.kind || 'cheatsheet';
    var ov = document.createElement('div');
    ov.className = 'cs-paper-overlay ss-print-root';
    ov.innerHTML =
      '<div class="cs-paper-bar">' +
        '<span class="cs-paper-bar-title">' + _esc(opts.title || 'Cheatsheet') + '</span>' +
        '<span class="cs-paper-hint" title="Drag a section by its ⠿ handle to reorder; ⤓ break starts a new page before a section">Edit: drag ⠿ to move · ⤓ break = new page</span>' +
        '<div class="cs-paper-bar-actions">' +
          '<select class="cs-paper-select" data-act="columns" title="Change columns"><option value="2">2 cols</option><option value="3">3 cols</option><option value="4">4 cols</option></select>' +
          '<select class="cs-paper-select" data-act="pad" title="Change page padding"><option value="6mm">Tight</option><option value="10mm">Normal</option><option value="16mm">Wide</option></select>' +
          '<select class="cs-paper-select" data-act="font" title="Change font size"><option value="0.72rem">Small</option><option value="0.78rem">Medium</option><option value="0.86rem">Large</option></select>' +
          '<button type="button" class="cs-paper-btn" data-act="edit" title="Edit the text directly on the sheet">✎ Edit</button>' +
          (kind === 'cheatsheet'
            ? '<button type="button" class="cs-paper-btn" data-act="img" hidden title="Add a picture to the sheet">🖼 Image</button>' +
              '<input type="file" accept="image/*" data-cs-img-input hidden>'
            : '') +
          '<button type="button" class="cs-paper-btn" data-act="download">⤓ Download PDF</button>' +
          '<button type="button" class="cs-paper-btn cs-paper-close" data-act="close">Close</button>' +
        '</div>' +
      '</div>' +
      '<div class="cs-paper-scroll">' +
        '<div class="cs-paper-veil" data-cs-veil>' +
          '<div class="cs-paper-veil-spinner" aria-hidden="true"></div>' +
          '<div>Preparing your sheet…</div>' +
        '</div>' +
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
    var initialPad = st.pad || '10mm';
    if (paper) {
      if (st.columns) paper.style.setProperty('--cs-columns', String(st.columns));
      var fontEm = { xs: '0.72rem', sm: '0.78rem', md: '0.86rem' }[st.font || 'sm'];
      if (fontEm) paper.style.setProperty('--cs-font', fontEm);
      paper.style.setProperty('--cs-pad', initialPad);
      if (st.style) paper.setAttribute('data-style', st.style);
    }
    var colSel = ov.querySelector('[data-act="columns"]');
    var fontSel = ov.querySelector('[data-act="font"]');
    var padSel = ov.querySelector('[data-act="pad"]');
    if (colSel && st.columns) colSel.value = String(st.columns);
    if (fontSel) fontSel.value = ({ xs: '0.72rem', sm: '0.78rem', md: '0.86rem' }[st.font || 'sm']) || '0.78rem';
    if (padSel) padSel.value = initialPad;
    if (colSel) colSel.addEventListener('change', function () {
      if (!paper) return;
      paper.style.setProperty('--cs-columns', colSel.value);
      _repaginate(paper);  // geometry changed → re-pack the pages
    });
    if (fontSel) fontSel.addEventListener('change', function () {
      if (!paper) return;
      paper.style.setProperty('--cs-font', fontSel.value);
      _repaginate(paper);  // font size changed → re-measure + re-pack
    });
    if (padSel) padSel.addEventListener('change', function () {
      if (!paper) return;
      paper.style.setProperty('--cs-pad', padSel.value);
      _repaginate(paper);  // padding changed → inner height changed → re-pack
    });
    var body = ov.querySelector('.cs-paper-body');
    var veil = ov.querySelector('[data-cs-veil]');
    // Open INSTANTLY: paint the overlay (with a loading veil) first, then run the
    // heavy synchronous KaTeX + pagination work on a later frame. Rendering
    // inline here blocked the click handler, so the whole page froze before the
    // overlay ever appeared.
    if (body) {
      requestAnimationFrame(function () {
        setTimeout(function () {
          _renderMarkdown(body, opts.markdown || '', true, function () {
            if (veil) { veil.remove(); veil = null; }
          });
        }, 30);
      });
    } else if (veil) {
      veil.remove();
      veil = null;
    }
    ov.querySelector('[data-act="close"]').addEventListener('click', _closePaper);
    var editBtn = ov.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.addEventListener('click', function () {
      _setPaperEditing(ov, paper, !(paper && paper._csEditing));
    });
    var imgBtn = ov.querySelector('[data-act="img"]');
    var imgInput = ov.querySelector('[data-cs-img-input]');
    if (imgBtn && imgInput) {
      imgBtn.addEventListener('click', function () { imgInput.click(); });
      imgInput.addEventListener('change', function () {
        var f = imgInput.files && imgInput.files[0];
        if (f && paper) _addPaperImage(ov, paper, f);
        imgInput.value = '';
      });
    }
    _wireDownload(
      ov.querySelector('[data-act="download"]'),
      function () {
        var p = ov.querySelector('.cs-paper');
        // Mid-edit download: re-measure the edited text so nothing overflows a page.
        if (p && p._csEditing) _repaginate(p);
        return p;
      },
      _safeName((opts.course || 'cheatsheet') + ' ' + kind) + '.pdf'
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

  // ── Durable editing: edit the cheatsheet markdown and save it to the note ──
  // The canvas edit mode is visual (layout/images for the PDF); this editor
  // changes the stored content itself, so the edits persist and feed every
  // later render (inline sheet, canvas, PDF).
  function _wireInlineEdit(els, noteId) {
    var sheet = els.result.querySelector('.cs-sheet');
    var btn = sheet && sheet.querySelector('[data-cs-edit]');
    var body = sheet && sheet.querySelector('.cs-sheet-body');
    if (!btn || !body) return;
    btn.addEventListener('click', function () {
      if (sheet.querySelector('.cs-md-edit')) return;
      var md = (els._paper && els._paper.markdown) || '';
      var wrap = document.createElement('div');
      wrap.className = 'cs-md-edit';
      wrap.innerHTML =
        '<textarea class="cs-md-ta" spellcheck="false" placeholder="Cheatsheet markdown…"></textarea>' +
        '<div class="cs-md-actions">' +
          '<button type="button" class="cs-btn cs-btn-primary cs-md-save">Save changes</button>' +
          '<button type="button" class="cs-btn cs-md-cancel">Cancel</button>' +
          '<span class="cs-md-status"></span>' +
        '</div>';
      wrap.querySelector('.cs-md-ta').value = md;
      body.style.display = 'none';
      body.parentNode.insertBefore(wrap, body);
      btn.disabled = true;
      var status = wrap.querySelector('.cs-md-status');
      function closeEditor() {
        wrap.remove();
        body.style.display = '';
        btn.disabled = false;
      }
      wrap.querySelector('.cs-md-cancel').addEventListener('click', closeEditor);
      wrap.querySelector('.cs-md-save').addEventListener('click', function () {
        var newMd = wrap.querySelector('.cs-md-ta').value;
        status.textContent = 'Saving…';
        _aiService()
          .then(function (svc) {
            // No note id (unsaved result) → keep the edit locally; it still
            // drives the canvas + PDF for this session.
            return noteId && typeof svc.updateNote === 'function'
              ? svc.updateNote(noteId, { content_markdown: newMd })
              : true;
          })
          .then(function (ok) {
            if (noteId && !ok) { status.textContent = 'Save failed — please try again.'; return; }
            if (els._paper) els._paper.markdown = newMd;
            closeEditor();
            _renderMarkdown(body, newMd);
          })
          .catch(function () { status.textContent = 'Save failed — please try again.'; });
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
          '<button type="button" class="cs-btn cs-sheet-edit" data-cs-edit>✎ Edit</button>' +
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
    _wireInlineEdit(els, res.noteId || null);
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
        '<button type="button" class="cs-btn cs-view-print" data-cs-view>View / Print</button>' +
        '<button type="button" class="cs-btn cs-sheet-edit" data-cs-edit>✎ Edit</button></div>' +
        '<div class="cs-sheet-body"></div></div>';
      var body = els.result.querySelector('.cs-sheet-body');
      if (body) _renderMarkdown(body, note.content_markdown || '');
      var viewBtn = els.result.querySelector('[data-cs-view]');
      if (viewBtn) viewBtn.addEventListener('click', function () { _openPaper(els._paper); });
      _wireInlineEdit(els, note.id || id);
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
      return '<label class="qzsp-item">' +
        '<input type="checkbox" class="qzsp-cb" value="' + _esc(d.id) + '" checked>' +
        '<span class="qzsp-name">' + _esc(d.file_name || d.fileName || 'Untitled') + '</span>' +
      '</label>';
    }
    function folderHtml(name, docsInFolder, idx) {
      return '<div class="qzsp-folder" data-folder-idx="' + _esc(idx) + '">' +
        '<div class="qzsp-folder-header open">' +
          '<span class="qzsp-folder-toggle">&#x25BE;</span>' +
          '<span class="qzsp-folder-name">' + _esc(name) + '</span>' +
          '<span class="qzsp-folder-count">' + docsInFolder.length + ' file' + (docsInFolder.length === 1 ? '' : 's') + '</span>' +
          '<button class="qzsp-folder-selall" data-folder-act="all" type="button">Select all</button>' +
          '<button class="qzsp-folder-selall qzsp-folder-clear" data-folder-act="none" type="button">Clear</button>' +
        '</div>' +
        '<div class="qzsp-folder-files">' + docsInFolder.map(itemHtml).join('') + '</div>' +
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
    ov.className = 'qzsp-overlay';
    ov.innerHTML =
      '<div class="qzsp-modal">' +
        '<div class="qzsp-head"><span class="qzsp-title">Choose source PDFs</span>' +
          '<button class="qzsp-close" type="button" aria-label="Close">&times;</button></div>' +
        '<p class="qzsp-sub">All files are selected by default. Use each folder\'s controls to select or clear only the files inside that folder.</p>' +
        '<div class="qzsp-list qzsp-folder-list">' + sections + '</div>' +
        '<div class="qzsp-actions">' +
          '<button class="qzsp-btn-ghost" id="csSpAll" type="button">Select all</button>' +
          '<button class="qzsp-btn-ghost" id="csSpClear" type="button">Clear</button>' +
          '<button class="qzsp-btn-primary" id="csSpConfirm" type="button">Generate from selected</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    ov.querySelector('.qzsp-close').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelectorAll('.qzsp-folder-header').forEach(function (head) {
      head.addEventListener('click', function (e) {
        if (e.target.closest('[data-folder-act]')) return;
        var folder = head.closest('.qzsp-folder');
        var files = folder && folder.querySelector('.qzsp-folder-files');
        var open = files && files.style.display !== 'none';
        if (files) files.style.display = open ? 'none' : 'flex';
        var toggle = head.querySelector('.qzsp-folder-toggle');
        if (toggle) toggle.innerHTML = open ? '&#x25B8;' : '&#x25BE;';
        head.classList.toggle('open', !open);
      });
    });
    ov.querySelectorAll('[data-folder-act]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var folder = btn.closest('.qzsp-folder');
        var checked = btn.getAttribute('data-folder-act') === 'all';
        if (folder) folder.querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = checked; });
      });
    });
    ov.querySelector('#csSpAll').onclick = function () {
      ov.querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = true; });
    };
    ov.querySelector('#csSpClear').onclick = function () {
      ov.querySelectorAll('.qzsp-cb').forEach(function (cb) { cb.checked = false; });
    };
    ov.querySelector('#csSpConfirm').onclick = function () {
      var ids = [];
      ov.querySelectorAll('.qzsp-cb:checked').forEach(function (cb) { ids.push(cb.value); });
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

  window.openCheatsheetPaper = _openPaper;

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
        .then(function (svc) {
          return svc.listCourseDocuments(courseId).then(function (docs) {
            return typeof svc.filterDocsByCourseFiles === 'function'
              ? svc.filterDocsByCourseFiles(docs, courseId) : docs;
          });
        })
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
