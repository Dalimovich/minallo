function updatePageInfo() {
  var inp = document.getElementById('pdfPageInput');
  var tot = document.getElementById('pdfPageTotal');
  if (inp && document.activeElement !== inp) inp.value = pdfShowAll ? _pdfVisiblePage() : pdfPage;
  if (tot) tot.textContent = pdfTotal;
  // Persist page position in sessionStorage so it survives refresh
  if (activeFileName && pdfPage && pdfPage > 1) {
    try { sessionStorage.setItem('ss_page_' + activeFileName, String(pdfPage)); } catch (e) {}
  }
}
function _pdfVisiblePage() {
  var body = document.getElementById('pdfBody');
  if (!body) return pdfPage;
  var wraps = body.querySelectorAll('.pdf-page-wrap');
  var bodyTop = body.getBoundingClientRect().top;
  var best = 1;
  wraps.forEach(function (w) {
    var r = w.getBoundingClientRect();
    if (r.top - bodyTop <= 40) best = parseInt(w.dataset.pageNum) || best;
  });
  return best;
}
window._pdfVisiblePage = _pdfVisiblePage;

function renderPages() {
  if (!pdfDoc) return;
  var body = document.getElementById('pdfBody');
  body.innerHTML = '';
  var navStyle = pdfShowAll ? 'none' : 'inline-flex';
  document.getElementById('pdfPrev').style.display = navStyle;
  document.getElementById('pdfNext').style.display = navStyle;
  document.getElementById('pdfPageInfo').style.display = 'inline-flex';
  var toRender = pdfShowAll
    ? Array.from({ length: pdfTotal }, function (_, i) {
        return i + 1;
      })
    : [pdfPage];
  toRender.forEach(function (num) {
    pdfDoc.getPage(num).then(function (page) {
      var cW = body.clientWidth - 32;
      var vp0 = page.getViewport({ scale: 1 });
      var scale = pdfScale * (cW / vp0.width);
      var vp = page.getViewport({ scale: scale });
      var wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.dataset.pageNum = num;
      wrap.style.width = vp.width + 'px';
      wrap.style.height = vp.height + 'px';
      var canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      wrap.appendChild(canvas);
      var textDiv = document.createElement('div');
      textDiv.className = 'pdf-text-layer';
      textDiv.style.width = vp.width + 'px';
      textDiv.style.height = vp.height + 'px';
      wrap.appendChild(textDiv);
      body.appendChild(wrap);
      page
        .render({ canvasContext: canvas.getContext('2d'), viewport: vp })
        .promise.then(function () {
          return page.getTextContent();
        })
        .then(function (tc) {
          textDiv.style.setProperty('--scale-factor', String(vp.scale));
          var rl = pdfjsLib.renderTextLayer({
            textContentSource: tc,
            container: textDiv,
            viewport: vp,
            textDivs: []
          });
          if (rl && rl.promise) rl.promise.catch(function () {});
          // Store per-page text for AI Notes page-range targeting
          if (!window.pdfPageTexts) window.pdfPageTexts = {};
          window.pdfPageTexts[num] = tc.items.map(function (it) { return it.str; }).join(' ');
        });
      textDiv.addEventListener('mouseup', function () {
        setTimeout(function () {
          var sel = window.getSelection();
          if (sel && sel.toString().trim().length > 3) showSelectionBanner(sel.toString().trim());
        }, 30);
      });
    });
  });
}

// ── ANNOTATION ENGINE ────────────────────────────────────────────────────────
// Two-canvas architecture per page:
//   .annot-committed  — all finished strokes, pointer-events:none, z-index:5
//   .annot-live       — receives pointer events, shows current stroke preview, z-index:6

var _annotMode = 'pen';
var _annotColor = '#000000';
var _annotThickness = 3;
var _annotBold = false;
var _annotItalic = false;
var _annotFontSize = 16;
var _annotActive = false;
var _annotStrokes = {}; // pageNum -> [{type,color,thickness,points}]
var _annotUndoStack = {}; // pageNum -> [snapshot]
var _annotCurrentFile = ''; // filename key for localStorage persistence

var ANNOT_PREFIX = 'ss_annot_';

function _annotSave() {
  if (!_annotCurrentFile) return;
  try {
    localStorage.setItem(
      ANNOT_PREFIX + _annotCurrentFile,
      JSON.stringify({
        strokes: _annotStrokes,
        undo: _annotUndoStack
      })
    );
  } catch (e) {}
}

function _annotLoad(fileName) {
  _annotCurrentFile = fileName;
  _annotStrokes = {};
  _annotUndoStack = {};
  try {
    var raw = localStorage.getItem(ANNOT_PREFIX + fileName);
    if (!raw) return;
    var d = JSON.parse(raw);
    if (d.strokes) _annotStrokes = d.strokes;
    if (d.undo) _annotUndoStack = d.undo;
  } catch (e) {}
}

// Draw a smooth stroke (bezier through midpoints) on any ctx
function _annotDrawStroke(ctx, s) {
  if (s.type === 'text') {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = s.color;
    ctx.font =
      (s.italic ? 'italic ' : '') + (s.bold ? 'bold ' : '') + s.fontSize + 'px Nunito,sans-serif';
    (s.text || '').split('\n').forEach(function (line, li) {
      ctx.fillText(line, s.x, s.y + s.fontSize * (li + 1));
    });
    ctx.restore();
    return;
  }
  if (!s.points || s.points.length < 2) return;
  ctx.save();
  if (s.type === 'highlight') {
    ctx.globalAlpha = 0.35;
    ctx.globalCompositeOperation = 'multiply';
  } else if (s.type === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
  } else {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.strokeStyle = s.type === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
  ctx.lineWidth = s.type === 'highlight' ? s.thickness * 4 : s.thickness;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (var i = 1; i < s.points.length - 1; i++) {
    var mx = (s.points[i].x + s.points[i + 1].x) / 2;
    var my = (s.points[i].y + s.points[i + 1].y) / 2;
    ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, mx, my);
  }
  ctx.lineTo(s.points[s.points.length - 1].x, s.points[s.points.length - 1].y);
  ctx.stroke();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function _annotRestorePage(committedCanvas, pageNum) {
  var ctx = committedCanvas.getContext('2d');
  ctx.clearRect(0, 0, committedCanvas.width, committedCanvas.height);
  var strokes = _annotStrokes[pageNum] || [];
  strokes.forEach(function (s) {
    _annotDrawStroke(ctx, s);
  });
}

function _annotToggle() {
  _annotActive = !_annotActive;
  var toolbar = document.getElementById('annotToolbar');
  var toggleBtn = document.getElementById('pdfAnnotateToggle');
  var body = document.getElementById('pdfBody');
  if (_annotActive) {
    toolbar.style.display = 'flex';
    toggleBtn.style.background = 'rgba(37,99,235,.35)';
    body.classList.add('annot-active');
    _annotAttachCanvases();
  } else {
    toolbar.style.display = 'none';
    toggleBtn.style.background = '';
    body.classList.remove('annot-active');
    _annotDetachCanvases();
  }
}

function _annotAttachCanvases() {
  document.querySelectorAll('.pdf-page-wrap').forEach(function (wrap, i) {
    if (wrap.querySelector('.annot-committed')) return;
    var pn = parseInt(wrap.dataset.pageNum || i + 1);
    var w = wrap.offsetWidth,
      h = wrap.offsetHeight;

    // Layer 1: committed strokes — no pointer events
    var committed = document.createElement('canvas');
    committed.className = 'annot-committed';
    committed.width = w;
    committed.height = h;
    committed.dataset.pageNum = pn;
    committed.style.cssText = 'position:absolute;inset:0;z-index:5;pointer-events:none;';
    wrap.appendChild(committed);
    _annotRestorePage(committed, pn);

    // Layer 2: live drawing — receives pointer events
    var live = document.createElement('canvas');
    live.className = 'annot-live annot-mode-' + _annotMode;
    live.width = w;
    live.height = h;
    live.dataset.pageNum = pn;
    live.style.cssText =
      'position:absolute;inset:0;z-index:6;touch-action:none;pointer-events:all;';
    wrap.appendChild(live);

    _annotBindCanvas(live, committed);
  });
}

function _annotDetachCanvases() {
  document.querySelectorAll('.annot-committed, .annot-live').forEach(function (c) {
    c.remove();
  });
}

function _annotUpdateCursor() {
  document.querySelectorAll('.annot-live').forEach(function (c) {
    c.className = 'annot-live annot-mode-' + _annotMode;
  });
}

// committed canvas for a page-wrap (used by text editor and undo/clear)
function _annotGetCommitted(wrap) {
  return wrap.querySelector('.annot-committed');
}

function _annotBindCanvas(live, committed) {
  var lctx = live.getContext('2d');
  var cctx = committed.getContext('2d');
  var drawing = false,
    strokeMode = 'pen';
  var points = [];
  var rafId = null;

  function pn() {
    return parseInt(live.dataset.pageNum);
  }

  function _pushUndo(pageNum) {
    if (!_annotUndoStack[pageNum]) _annotUndoStack[pageNum] = [];
    _annotUndoStack[pageNum].push(JSON.stringify(_annotStrokes[pageNum] || []));
    if (_annotUndoStack[pageNum].length > 40) _annotUndoStack[pageNum].shift();
  }

  function getPos(e) {
    var rect = live.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (live.width / rect.width),
      y: (e.clientY - rect.top) * (live.height / rect.height),
      p: e.pressure > 0 ? e.pressure : 1
    };
  }

  // Draw current in-progress path on the live canvas only (non-destructive preview)
  function renderLive() {
    rafId = null;
    lctx.clearRect(0, 0, live.width, live.height);
    if (points.length < 2) return;
    var baseW = strokeMode === 'highlight' ? _annotThickness * 4 : _annotThickness;
    // Eraser shows as semi-transparent circle cursor, no live preview needed
    if (strokeMode === 'eraser') return;
    lctx.save();
    if (strokeMode === 'highlight') {
      lctx.globalAlpha = 0.35;
      lctx.globalCompositeOperation = 'multiply';
    } else {
      lctx.globalAlpha = 1;
      lctx.globalCompositeOperation = 'source-over';
    }
    lctx.strokeStyle = _annotColor;
    lctx.lineCap = 'round';
    lctx.lineJoin = 'round';
    lctx.beginPath();
    lctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length - 1; i++) {
      var mx = (points[i].x + points[i + 1].x) / 2;
      var my = (points[i].y + points[i + 1].y) / 2;
      lctx.lineWidth = baseW * (0.4 + points[i].p * 0.6);
      lctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    lctx.lineWidth = baseW * (0.4 + points[points.length - 1].p * 0.6);
    lctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    lctx.stroke();
    lctx.restore();
  }

  function onStart(e) {
    if (e.pointerType === 'touch') {
      return;
    } // let finger events pass through for scrolling
    e.preventDefault(); // prevent stylus from also scrolling the page
    if (_annotMode === 'text') {
      try {
        live.releasePointerCapture(e.pointerId);
      } catch (_) {}
      var wrapRect = live.parentElement.getBoundingClientRect();
      var xDom = e.clientX - wrapRect.left,
        yDom = e.clientY - wrapRect.top;
      var scaleX = live.width / wrapRect.width,
        scaleY = live.height / wrapRect.height;
      var xC = xDom * scaleX,
        yC = yDom * scaleY;
      var pageNum = pn();
      var strokes = _annotStrokes[pageNum] || [];
      var hitCtx = document.createElement('canvas').getContext('2d');
      var hitIdx = -1;
      for (var si = strokes.length - 1; si >= 0; si--) {
        var s = strokes[si];
        if (s.type !== 'text') continue;
        hitCtx.font =
          (s.italic ? 'italic ' : '') +
          (s.bold ? 'bold ' : '') +
          s.fontSize +
          'px Nunito,sans-serif';
        var lines = (s.text || '').split('\n'),
          maxW = 0;
        lines.forEach(function (l) {
          var w = hitCtx.measureText(l).width;
          if (w > maxW) maxW = w;
        });
        if (
          xC >= s.x - 4 &&
          xC <= s.x + maxW + 4 &&
          yC >= s.y - 4 &&
          yC <= s.y + s.fontSize * lines.length + 4
        ) {
          hitIdx = si;
          break;
        }
      }
      if (hitIdx >= 0) _annotEditText(committed, strokes[hitIdx], hitIdx, pageNum);
      else _annotPlaceText(committed, live, e);
      return;
    }
    drawing = true;
    strokeMode = _annotMode;
    points = [getPos(e)];
    _pushUndo(pn());
  }

  function onMove(e) {
    if (e.pointerType === 'touch') return;
    if (!drawing) return;
    e.preventDefault();
    // Collect coalesced events for smoother stylus tracking
    var evts = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
    for (var i = 0; i < evts.length; i++) points.push(getPos(evts[i]));
    if (!rafId) rafId = requestAnimationFrame(renderLive);
  }

  function onEnd() {
    if (!drawing) return;
    drawing = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lctx.clearRect(0, 0, live.width, live.height);
    if (points.length >= 2) {
      var stroke = {
        type: strokeMode,
        color: _annotColor,
        thickness: _annotThickness,
        points: points.map(function (p) {
          return { x: p.x, y: p.y };
        })
      };
      _annotDrawStroke(cctx, stroke);
      var pageNum = pn();
      if (!_annotStrokes[pageNum]) _annotStrokes[pageNum] = [];
      _annotStrokes[pageNum].push(stroke);
      _annotSave();
    }
    points = [];
  }

  // Finger touch: manually forward scroll to .pdf-body since touch-action:none blocks browser pan
  var _touchScrollY = 0,
    _touchScrollX = 0;
  live.addEventListener(
    'pointerdown',
    function (e) {
      if (e.pointerType !== 'touch') return;
      _touchScrollY = e.clientY;
      _touchScrollX = e.clientX;
    },
    { passive: true }
  );
  live.addEventListener(
    'pointermove',
    function (e) {
      if (e.pointerType !== 'touch') return;
      var body = live.closest('.pdf-body') || document.querySelector('.pdf-body');
      if (!body) return;
      body.scrollTop -= e.clientY - _touchScrollY;
      body.scrollLeft -= e.clientX - _touchScrollX;
      _touchScrollY = e.clientY;
      _touchScrollX = e.clientX;
    },
    { passive: true }
  );

  live.addEventListener('pointerdown', onStart, { passive: false });
  live.addEventListener('pointermove', onMove, { passive: false });
  live.addEventListener('pointerup', onEnd);
  live.addEventListener('pointercancel', onEnd);
  live.addEventListener('pointerleave', onEnd);
}

function _annotUndo() {
  var wrap = document.querySelector('.pdf-page-wrap');
  if (!wrap) return;
  var pn = parseInt(wrap.dataset.pageNum || 1);
  if (!_annotUndoStack[pn] || !_annotUndoStack[pn].length) return;
  _annotStrokes[pn] = JSON.parse(_annotUndoStack[pn].pop());
  var committed = _annotGetCommitted(wrap);
  if (committed) _annotRestorePage(committed, pn);
  _annotSave();
}

function _annotClearPage() {
  document.querySelectorAll('.pdf-page-wrap').forEach(function (wrap) {
    var committed = _annotGetCommitted(wrap);
    if (!committed) return;
    var pn = parseInt(committed.dataset.pageNum);
    if (!_annotUndoStack[pn]) _annotUndoStack[pn] = [];
    _annotUndoStack[pn].push(JSON.stringify(_annotStrokes[pn] || []));
    _annotStrokes[pn] = [];
    committed.getContext('2d').clearRect(0, 0, committed.width, committed.height);
  });
  _annotSave();
}

// Shared text editor: draggable panel with textarea.
// existingStroke (optional) — pre-fills text and positions at stroke location for editing.
// Coordinate contract: stroke.x/y are canvas-pixel coords of the TOP-LEFT of the text block.
// Drawing: first line baseline = stroke.y + stroke.fontSize.
// committed = the committed canvas; live = the live canvas (optional, used for pointer-events toggle)
function _annotOpenTextEditor(committed, live, e, existingStroke, existingIdx, existingPn) {
  var ac = committed; // draw target
  var wrap = committed.parentElement;
  var wrapRect = wrap.getBoundingClientRect();
  var scaleX = committed.width / wrapRect.width;
  var scaleY = committed.height / wrapRect.height;
  var pn = existingPn !== undefined ? existingPn : parseInt(committed.dataset.pageNum);

  // Starting DOM position
  var xDom, yDom;
  if (existingStroke) {
    xDom = existingStroke.x / scaleX;
    yDom = existingStroke.y / scaleY;
    // Remove old stroke and clear canvas
    _annotStrokes[pn].splice(existingIdx, 1);
    _annotRestorePage(ac, pn);
  } else {
    var src = e.touches ? e.touches[0] : e;
    xDom = src.clientX - wrapRect.left;
    yDom = src.clientY - wrapRect.top;
  }

  var color = existingStroke ? existingStroke.color : _annotColor;
  var fsize = existingStroke ? existingStroke.fontSize / scaleY : _annotFontSize;
  var bold = existingStroke ? existingStroke.bold : _annotBold;
  var italic = existingStroke ? existingStroke.italic : _annotItalic;

  var liveCanvas = live || wrap.querySelector('.annot-live');
  if (liveCanvas) liveCanvas.style.pointerEvents = 'none';

  // Build draggable panel: [handle bar] + [textarea]
  var panel = document.createElement('div');
  panel.style.cssText =
    'position:absolute;z-index:20;display:flex;flex-direction:column;min-width:120px;' +
    'border:1.5px dashed rgba(37,99,235,.8);border-radius:6px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.3);';
  panel.style.left = xDom + 'px';
  panel.style.top = yDom + 'px';

  var handle = document.createElement('div');
  handle.style.cssText =
    'background:rgba(37,99,235,.85);cursor:grab;padding:3px 8px;font-size:.68rem;' +
    'color:#fff;font-family:Nunito,sans-serif;font-weight:700;user-select:none;display:flex;justify-content:space-between;align-items:center;';
  handle.innerHTML =
    '<span>⠿ drag</span><span id="_atDone" style="cursor:pointer;opacity:.85">✓ Done</span>';

  var ta = document.createElement('textarea');
  ta.style.cssText =
    'background:rgba(255,255,255,.92);border:none;outline:none;resize:both;' +
    'min-width:100px;min-height:32px;padding:4px 6px;font-family:Nunito,sans-serif;line-height:1.35;' +
    'color:' +
    color +
    ';font-size:' +
    fsize +
    'px;font-weight:' +
    (bold ? 'bold' : 'normal') +
    ';' +
    'font-style:' +
    (italic ? 'italic' : 'normal') +
    ';';
  if (existingStroke) ta.value = existingStroke.text;

  panel.appendChild(handle);
  panel.appendChild(ta);
  wrap.appendChild(panel);
  setTimeout(function () {
    ta.focus();
    if (existingStroke) ta.select();
  }, 0);

  // Drag logic on the handle
  var dragStartX,
    dragStartY,
    panelStartX,
    panelStartY,
    dragging = false;
  handle.addEventListener('pointerdown', function (ev) {
    if (ev.target.id === '_atDone') return;
    dragging = true;
    handle.style.cursor = 'grabbing';
    dragStartX = ev.clientX;
    dragStartY = ev.clientY;
    panelStartX = parseFloat(panel.style.left);
    panelStartY = parseFloat(panel.style.top);
    handle.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  handle.addEventListener('pointermove', function (ev) {
    if (!dragging) return;
    panel.style.left = panelStartX + ev.clientX - dragStartX + 'px';
    panel.style.top = panelStartY + ev.clientY - dragStartY + 'px';
  });
  handle.addEventListener('pointerup', function () {
    dragging = false;
    handle.style.cursor = 'grab';
  });

  var done = false;
  function commit() {
    if (done) return;
    done = true;
    if (liveCanvas) liveCanvas.style.pointerEvents = '';
    var text = ta.value.trim();
    panel.remove();
    if (!text) {
      _annotRestorePage(ac, pn);
      return;
    }

    // Final panel position in canvas pixels (top-left of text block)
    var finalWrapRect = wrap.getBoundingClientRect();
    var fscaleX = ac.width / finalWrapRect.width;
    var fscaleY = ac.height / finalWrapRect.height;
    var finalXDom = parseFloat(panel.style.left); // already removed, use last known
    var finalYDom = parseFloat(panel.style.top);
    // panel was removed — read from stored vars before remove
    var xC = _atFinalX * fscaleX;
    var yC = _atFinalY * fscaleY;
    var lineH = fsize * fscaleY;

    var ctx = ac.getContext('2d');
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
    ctx.font = (italic ? 'italic ' : '') + (bold ? 'bold ' : '') + lineH + 'px Nunito,sans-serif';
    text.split('\n').forEach(function (line, li) {
      ctx.fillText(line, xC, yC + lineH * (li + 1));
    });
    ctx.restore();

    if (!_annotStrokes[pn]) _annotStrokes[pn] = [];
    _annotStrokes[pn].push({
      type: 'text',
      color: color,
      text: text,
      x: xC,
      y: yC,
      fontSize: lineH,
      bold: bold,
      italic: italic,
      points: []
    });
    _annotSave();
  }

  // Track panel position just before removal (panel.style.left/top are readable until remove())
  var _atFinalX = xDom,
    _atFinalY = yDom;
  // Update tracked position on drag
  var _trackObs = new MutationObserver(function () {
    _atFinalX = parseFloat(panel.style.left);
    _atFinalY = parseFloat(panel.style.top);
  });
  _trackObs.observe(panel, { attributes: true, attributeFilter: ['style'] });

  // Done button
  panel.querySelector('#_atDone').addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    _atFinalX = parseFloat(panel.style.left);
    _atFinalY = parseFloat(panel.style.top);
    _trackObs.disconnect();
    commit();
  });

  ta.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      done = true;
      _trackObs.disconnect();
      if (liveCanvas) liveCanvas.style.pointerEvents = '';
      panel.remove();
      _annotRestorePage(ac, pn);
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      _atFinalX = parseFloat(panel.style.left);
      _atFinalY = parseFloat(panel.style.top);
      _trackObs.disconnect();
      commit();
    }
  });
}

function _annotPlaceText(committed, live, e) {
  _annotOpenTextEditor(committed, live, e, null, undefined, undefined);
}

function _annotEditText(committed, stroke, strokeIdx, pn) {
  _annotOpenTextEditor(committed, null, null, stroke, strokeIdx, pn);
}

// Wire annotation toolbar controls
(function () {
  function $id(id) {
    return document.getElementById(id);
  }

  $id('pdfAnnotateToggle').addEventListener('click', _annotToggle);

  ['annotToolPen', 'annotToolHighlight', 'annotToolText', 'annotToolEraser'].forEach(function (id) {
    var btn = $id(id);
    // pointerdown: stop event reaching the PDF canvas below (tablet ghost-tap prevention)
    btn.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      document.querySelectorAll('.annot-tool-btn').forEach(function (b) {
        b.classList.remove('active');
        b.style.background = '';
      });
      this.classList.add('active');
      this.style.background = 'rgba(37,99,235,.35)';
      _annotMode = id.replace('annotTool', '').toLowerCase();
      _annotUpdateCursor();
      var txtCtrl = $id('annotTextControls');
      txtCtrl.style.display = _annotMode === 'text' ? 'flex' : 'none';
    });
  });

  document.querySelectorAll('.annot-color-swatch').forEach(function (sw) {
    sw.addEventListener('click', function () {
      document.querySelectorAll('.annot-color-swatch').forEach(function (s) {
        s.classList.remove('active');
      });
      sw.classList.add('active');
      _annotColor = sw.dataset.color;
      $id('annotColorPicker').value = _annotColor;
    });
  });

  $id('annotColorPicker').addEventListener('input', function () {
    _annotColor = this.value;
    document.querySelectorAll('.annot-color-swatch').forEach(function (s) {
      s.classList.remove('active');
    });
  });

  function _updateThicknessFill() {
    var r = $id('annotThickness');
    if (!r) return;
    var pct = ((parseInt(r.value) - parseInt(r.min)) / (parseInt(r.max) - parseInt(r.min))) * 100;
    r.style.background =
      'linear-gradient(to right, #60a5fa 0%, #60a5fa ' + pct + '%, rgba(255,255,255,0.12) ' +
      pct + '%, rgba(255,255,255,0.12) 100%)';
  }
  $id('annotThickness').addEventListener('input', function () {
    _annotThickness = parseInt(this.value);
    _updateThicknessFill();
  });
  _updateThicknessFill();
  var _strokeMinus = $id('annotStrokeMinus');
  var _strokePlus = $id('annotStrokePlus');
  if (_strokeMinus) _strokeMinus.addEventListener('click', function () {
    var r = $id('annotThickness');
    r.value = Math.max(parseInt(r.min), parseInt(r.value) - 1);
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (_strokePlus) _strokePlus.addEventListener('click', function () {
    var r = $id('annotThickness');
    r.value = Math.min(parseInt(r.max), parseInt(r.value) + 1);
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });

  $id('annotFontSize').addEventListener('change', function () {
    _annotFontSize = parseInt(this.value);
  });

  $id('annotBold').addEventListener('click', function () {
    _annotBold = !_annotBold;
    this.classList.toggle('active', _annotBold);
  });

  $id('annotItalic').addEventListener('click', function () {
    _annotItalic = !_annotItalic;
    this.classList.toggle('active', _annotItalic);
  });

  $id('annotUndo').addEventListener('click', _annotUndo);
  $id('annotClear').addEventListener('click', _annotClearPage);
})();

// Re-attach canvases whenever renderPages rebuilds the DOM
var _origRenderPages = renderPages;
renderPages = function () {
  _origRenderPages.apply(this, arguments);
  if (_annotActive) {
    setTimeout(function () {
      var wraps = document.querySelectorAll('.pdf-page-wrap');
      wraps.forEach(function (wrap, i) {
        wrap.dataset.pageNum = pdfShowAll ? i + 1 : pdfPage;
      });
      _annotAttachCanvases();
    }, 200);
  }
};

// ── ANNOTATED PDF EXPORT ──────────────────────────────────────────────────────

// Render ALL pages of the current PDF with annotations merged into one jsPDF doc.
// Returns a Promise<Blob> (PDF blob).
async function _annotBuildPdfBlob() {
  if (!pdfDoc) throw new Error('No PDF loaded');
  await _ssEnsureJsPdf();
  var jspdf = window.jspdf && window.jspdf.jsPDF;
  if (!jspdf) throw new Error('jsPDF not loaded');

  var totalPages = pdfDoc.numPages;
  var doc = null;

  for (var i = 1; i <= totalPages; i++) {
    var page = await pdfDoc.getPage(i);
    var vp0 = page.getViewport({ scale: 1 });
    // Render at 150dpi scale for good quality
    var exportScale = 150 / 72;
    var vp = page.getViewport({ scale: exportScale });

    // PDF canvas
    var pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = vp.width;
    pdfCanvas.height = vp.height;
    await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;

    // Composite canvas = pdf + annotations
    var composite = document.createElement('canvas');
    composite.width = vp.width;
    composite.height = vp.height;
    var cctx = composite.getContext('2d');
    cctx.drawImage(pdfCanvas, 0, 0);

    // Scale and draw annotation strokes for this page
    var strokes = _annotStrokes[i];
    if (strokes && strokes.length) {
      var scaleX = vp.width;
      var scaleY = vp.height;
      // Annotation canvas was sized to the DOM wrap; we need to find that ratio.
      // We stored strokes in annotation-canvas coordinates. To map to export canvas:
      // find the DOM annotation canvas for this page if visible, else use stored width/height.
      var acEl = document.querySelector('.annot-committed[data-page-num="' + i + '"]');
      var acW = acEl ? acEl.width : vp.width / exportScale;
      var acH = acEl ? acEl.height : vp.height / exportScale;
      var rx = vp.width / acW;
      var ry = vp.height / acH;

      strokes.forEach(function (s) {
        if (s.type === 'text') {
          cctx.save();
          cctx.globalAlpha = 1;
          cctx.fillStyle = s.color;
          cctx.font =
            (s.italic ? 'italic ' : '') +
            (s.bold ? 'bold ' : '') +
            s.fontSize * rx +
            'px Nunito,sans-serif';
          (s.text || '').split('\n').forEach(function (line, li) {
            cctx.fillText(line, s.x * rx, s.y * ry + s.fontSize * rx * (li + 1));
          });
          cctx.restore();
          return;
        }
        if (!s.points || s.points.length < 1) return;
        cctx.save();
        if (s.type === 'highlight') {
          cctx.globalAlpha = 0.35;
          cctx.globalCompositeOperation = 'multiply';
        } else if (s.type === 'eraser') {
          cctx.globalCompositeOperation = 'destination-out';
          cctx.globalAlpha = 1;
        } else {
          cctx.globalAlpha = 1;
          cctx.globalCompositeOperation = 'source-over';
        }
        cctx.strokeStyle = s.type === 'eraser' ? 'rgba(0,0,0,1)' : s.color;
        cctx.lineWidth = (s.type === 'highlight' ? s.thickness * 4 : s.thickness) * rx;
        cctx.lineCap = 'round';
        cctx.lineJoin = 'round';
        cctx.beginPath();
        cctx.moveTo(s.points[0].x * rx, s.points[0].y * ry);
        s.points.forEach(function (pt) {
          cctx.lineTo(pt.x * rx, pt.y * ry);
        });
        cctx.stroke();
        cctx.restore();
      });
    }

    // Page orientation
    var orientation = vp.width > vp.height ? 'l' : 'p';
    var imgData = composite.toDataURL('image/jpeg', 0.92);
    var pxToMm = 25.4 / 150;
    var wMm = vp.width * pxToMm;
    var hMm = vp.height * pxToMm;

    if (!doc) {
      doc = new jspdf({ orientation: orientation, unit: 'mm', format: [wMm, hMm] });
    } else {
      doc.addPage([wMm, hMm], orientation);
    }
    doc.addImage(imgData, 'JPEG', 0, 0, wMm, hMm);
  }

  return doc.output('blob');
}

// Download annotated PDF
document.getElementById('annotDownload').addEventListener('click', async function () {
  this.textContent = '⏳ Building…';
  this.disabled = true;
  try {
    var blob = await _annotBuildPdfBlob();
    var fname = (activeFileName || 'annotated').replace(/\.pdf$/i, '') + '_annotated.pdf';
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 5000);
    showToast('Downloaded', fname);
  } catch (e) {
    showToast('Error', e.message);
  }
  this.textContent = '⬇ Save PDF';
  this.disabled = false;
});

// Transfer to course — show modal with enrolled courses
document.getElementById('annotTransfer').addEventListener('click', function () {
  var modal = document.getElementById('annotTransferModal');
  var list = document.getElementById('annotTransferCourseList');
  var status = document.getElementById('annotTransferStatus');
  status.textContent = '';
  list.innerHTML = '';

  // Gather all courses across semesters
  var allCourses = [];
  Object.values(SEMS).forEach(function (sem) {
    (sem.courses || []).forEach(function (c) {
      allCourses.push(c);
    });
  });

  if (!allCourses.length) {
    list.innerHTML =
      '<p style="color:var(--on-glass-muted);font-size:.85rem">No courses enrolled.</p>';
  } else {
    allCourses.forEach(function (course) {
      var btn = document.createElement('button');
      btn.style.cssText =
        'display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:10px 14px;cursor:pointer;color:var(--on-glass);font-family:Nunito,sans-serif;font-size:.85rem;font-weight:700;text-align:left;transition:background .13s;width:100%';
      btn.innerHTML =
        '<span style="font-size:1.1rem">📚</span><span style="flex:1">' +
        (course.name || course.short) +
        '</span>';
      btn.addEventListener('mouseenter', function () {
        this.style.background = 'rgba(37,99,235,.2)';
      });
      btn.addEventListener('mouseleave', function () {
        this.style.background = 'rgba(255,255,255,.06)';
      });
      btn.addEventListener('click', async function () {
        var uid = _currentUser && (_currentUser.id || _currentUser.sub);
        if (!uid) {
          status.textContent = 'Not logged in.';
          return;
        }
        status.textContent = '⏳ Building PDF…';
        btn.disabled = true;
        try {
          var blob = await _annotBuildPdfBlob();
          var fname = (activeFileName || 'annotated').replace(/\.pdf$/i, '') + '_annotated.pdf';
          var file = new File([blob], fname, { type: 'application/pdf' });
          status.textContent = '⏳ Uploading to ' + (course.name || course.short) + '…';
          await _ufUpload(uid, course, file, function (pct) {
            status.textContent = '⏳ Uploading… ' + pct + '%';
          });
          await _ufMerge(course);
          status.textContent = '';
          modal.style.display = 'none';
          showToast('✅ Transferred!', fname + ' added to ' + (course.name || course.short));
        } catch (e) {
          status.textContent = '❌ ' + e.message;
          btn.disabled = false;
        }
      });
      list.appendChild(btn);
    });
  }

  modal.style.display = 'flex';
});

document.getElementById('annotTransferClose').addEventListener('click', function () {
  document.getElementById('annotTransferModal').style.display = 'none';
});
