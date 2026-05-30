/* ── AI FLOATING BUBBLE ─────────────────────────────────────────────────────
   Draggable bubble that opens/closes the existing #aiPanel.
   The panel is detached from the DOM flow (position:fixed) and is
   independently draggable via its header. The bubble always renders
   on top of the panel.
   ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Task-01 (document rail) guard ────────────────────────────────────────
  // The legacy floating bubble is being replaced by the right-side document
  // rail + drawer. We keep the openPanel/closePanel/auto-focus logic intact
  // (Task-02 will reuse it from the new AI drawer), but the bubble element
  // itself must never appear. Other code paths reference `#aiBubble` as a
  // DOM query target; injectBubble() still creates a hidden stub so those
  // queries don't crash. CSS (`#aiBubble { display:none !important }` in
  // document-rail.css) provides the visual hide.
  var HIDE_BUBBLE = true;

  var DRAG_THRESHOLD  = 6;
  var SNAP_MARGIN     = 16;
  var BUBBLE_KEY      = 'ss_ai_bubble_pos';
  var PANEL_KEY       = 'ss_ai_panel_pos';
  var PANEL_SIZE_KEY  = 'ss_ai_panel_size';
  var PANEL_DEF_W     = 360;
  var PANEL_MIN_W     = 280;

  var bubbleDragging      = false;
  var bStartX = 0, bStartY = 0;
  var bOriginLeft = 0, bOriginTop = 0;
  var bTotalMoved = 0;
  var _initialized = false;

  // ── Inject bubble ──────────────────────────────────────────────────────────
  function injectBubble() {
    if (document.getElementById('aiBubble')) return document.getElementById('aiBubble');
    var el = document.createElement('div');
    el.id    = 'aiBubble';
    el.title = 'Minallo AI';
    el.style.zIndex = '10001'; // always above panel (10000) and #portal (200)
    // Task-01: never render the floating bubble — keep a hidden stub so any
    // existing code that queries `#aiBubble` doesn't crash.
    if (HIDE_BUBBLE) {
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
    }
    el.innerHTML =
      '<svg class="ai-bubble-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<rect x="3" y="8" width="18" height="11" rx="3" fill="currentColor" opacity="0.9"/>' +
        '<circle cx="9" cy="13.5" r="1.5" fill="rgba(15,23,42,0.8)"/>' +
        '<circle cx="15" cy="13.5" r="1.5" fill="rgba(15,23,42,0.8)"/>' +
        '<rect x="8" y="16.5" width="8" height="1.2" rx="0.6" fill="rgba(15,23,42,0.6)"/>' +
        '<rect x="10" y="5" width="4" height="4" rx="1" fill="currentColor" opacity="0.7"/>' +
        '<circle cx="12" cy="4" r="1.5" fill="currentColor" opacity="0.8"/>' +
        '<rect x="1" y="10" width="2" height="5" rx="1" fill="currentColor" opacity="0.6"/>' +
        '<rect x="21" y="10" width="2" height="5" rx="1" fill="currentColor" opacity="0.6"/>' +
      '</svg>' +
      '<span id="aiBubbleStatus"></span>';
    document.body.appendChild(el);
    return el;
  }

  // ── Detach #aiPanel from its DOM parent into fixed positioning ────────────
  function detachPanel() {
    var panel = document.getElementById('aiPanel');
    if (!panel || panel._ssDetached) return;
    panel._ssDetached = true;

    // Move to body so it isn't clipped by pdfViewerWrap's overflow:hidden
    document.body.appendChild(panel);

    // Override positioning to fixed floating
    panel.style.position   = 'fixed';
    panel.style.zIndex     = '10000';
    panel.style.top        = '';
    panel.style.right      = '';
    panel.style.bottom     = '';
    panel.style.left       = '';
    panel.style.height     = '';
    panel.style.transition = 'opacity 0.22s ease, transform 0.22s ease';
    panel.style.opacity    = '0';
    panel.style.transform  = 'scale(0.92)';
    panel.style.borderRadius = '20px';
    panel.style.overflow   = 'hidden';

    // Width + height: restore saved or default. (Height is optional — set by
    // the resize handles in ai.js; if unsaved the panel falls back to its
    // content height.)
    var savedSize = getSavedPanelSize();
    panel.style.width = savedSize.w + 'px';
    if (savedSize.h) panel.style.height = savedSize.h + 'px';
  }

  // ── Panel open/close ───────────────────────────────────────────────────────
  function isPanelOpen() {
    var panel = document.getElementById('aiPanel');
    return panel ? panel.classList.contains('visible') : false;
  }

  function positionPanelNearBubble(panel) {
    var bubble = document.getElementById('aiBubble');
    var vW = window.innerWidth;
    var vH = window.innerHeight;
    var savedPos = getSavedPanelPos();

    if (savedPos) {
      // Clamp saved position to viewport
      var pW = panel.offsetWidth  || parseInt(panel.style.width)  || PANEL_DEF_W;
      var pH = panel.offsetHeight || 500;
      var l = Math.max(8, Math.min(savedPos.left, vW - pW - 8));
      var t = Math.max(8, Math.min(savedPos.top,  vH - pH - 8));
      panel.style.left = l + 'px';
      panel.style.top  = t + 'px';
      return;
    }

    // First open: place next to bubble
    if (bubble) {
      var bRect = bubble.getBoundingClientRect();
      var pW2 = parseInt(panel.style.width) || PANEL_DEF_W;
      var spaceRight = vW - bRect.right - 12;
      var spaceLeft  = bRect.left - 12;
      var left;
      if (spaceRight >= pW2) {
        left = bRect.right + 12;
      } else if (spaceLeft >= pW2) {
        left = bRect.left - pW2 - 12;
      } else {
        left = Math.max(8, vW - pW2 - 8);
      }
      var top = Math.max(8, Math.min(bRect.top, vH - 520));
      panel.style.left = left + 'px';
      panel.style.top  = top  + 'px';
    } else {
      panel.style.right  = (SNAP_MARGIN + 70) + 'px';
      panel.style.bottom = SNAP_MARGIN + 'px';
    }
  }

  function openPanel() {
    // Legacy floating presentation retired. This used to detach #aiPanel into
    // position:fixed and reveal it as a free-floating box; that box is no longer
    // wanted — #aiPanel is now only shown docked inside the document-rail drawer
    // (see document-rail.ts mountAiPanel). Opening here is therefore a no-op.
    // closePanel() is intentionally left intact so the navigation / forceCloseAI
    // close paths still animate the panel away if it was ever shown.
    return;
  }

  function closePanel() {
    var panel = document.getElementById('aiPanel');
    if (!panel) return;

    panel.style.opacity   = '0';
    panel.style.transform = 'scale(0.92)';
    setTimeout(function () {
      panel.classList.remove('visible');
    }, 200);

    var bubble = document.getElementById('aiBubble');
    if (bubble) bubble.classList.remove('expanded');
  }

  function togglePanel() {
    if (isPanelOpen()) closePanel(); else openPanel();
  }

  // Wire #aiClose directly so clicking X always animates the panel closed
  function wireCloseBtn(panel) {
    function tryWire() {
      var btn = panel.querySelector('#aiClose, .ai-close');
      if (!btn) { setTimeout(tryWire, 200); return; }
      if (btn._ssBubbleCloseBound) return;
      btn._ssBubbleCloseBound = true;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        closePanel();
      });
    }
    tryWire();
  }

  // Intercept the bridge's forceCloseAI so it animates nicely too
  function hookBridge() {
    window.addEventListener('ss-ready', function () {
      var origClose = window.forceCloseAI;
      window.forceCloseAI = function () {
        closePanel();
        if (typeof origClose === 'function') origClose();
      };
    });
  }

  // ── Panel header drag ──────────────────────────────────────────────────────
  function attachPanelDrag(panel) {
    // Wait for the header to exist (panel HTML is fetched asynchronously)
    function tryWire() {
      var hdr = panel.querySelector('.ai-hdr');
      if (!hdr) { setTimeout(tryWire, 200); return; }
      if (hdr._ssPanelDragBound) return;
      hdr._ssPanelDragBound = true;

      var pdX, pdY, pdL, pdT, pdActive = false;

      hdr.style.cursor = 'move';

      hdr.addEventListener('pointerdown', function (e) {
        if (e.target.closest('button, .ai-icon-btn, .ai-close, label, input')) return;
        pdActive = true;
        pdX = e.clientX;
        pdY = e.clientY;
        var rect = panel.getBoundingClientRect();
        pdL = rect.left;
        pdT = rect.top;
        hdr.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      hdr.addEventListener('pointermove', function (e) {
        if (!pdActive) return;
        var vW = window.innerWidth, vH = window.innerHeight;
        var pW = panel.offsetWidth, pH = panel.offsetHeight;
        var newL = Math.max(0, Math.min(pdL + e.clientX - pdX, vW - pW));
        var newT = Math.max(0, Math.min(pdT + e.clientY - pdY, vH - pH));
        panel.style.left = newL + 'px';
        panel.style.top  = newT + 'px';
      });

      hdr.addEventListener('pointerup', function () {
        pdActive = false;
        savePanelPos(parseFloat(panel.style.left), parseFloat(panel.style.top));
      });
    }
    tryWire();
  }

  // ── Sync bubble expanded class ─────────────────────────────────────────────
  function syncExpandedClass(bubble) {
    var panel = document.getElementById('aiPanel');
    if (!panel || !bubble) return;
    var obs = new MutationObserver(function () {
      if (panel.classList.contains('visible')) {
        bubble.classList.add('expanded');
      } else {
        bubble.classList.remove('expanded');
      }
    });
    obs.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  // ── Bubble snap ────────────────────────────────────────────────────────────
  function snapBubble(x, y, bW, bH, vW, vH) {
    var dL = x, dR = vW-x-bW, dT = y, dB = vH-y-bH;
    var min = Math.min(dL, dR, dT, dB);
    if (min === dL) return { left: SNAP_MARGIN, top: Math.max(SNAP_MARGIN, Math.min(y, vH-bH-SNAP_MARGIN)) };
    if (min === dR) return { left: vW-bW-SNAP_MARGIN, top: Math.max(SNAP_MARGIN, Math.min(y, vH-bH-SNAP_MARGIN)) };
    if (min === dT) return { left: Math.max(SNAP_MARGIN, Math.min(x, vW-bW-SNAP_MARGIN)), top: SNAP_MARGIN+56 };
    return { left: Math.max(SNAP_MARGIN, Math.min(x, vW-bW-SNAP_MARGIN)), top: vH-bH-SNAP_MARGIN };
  }

  // ── Bubble drag ────────────────────────────────────────────────────────────
  function attachBubbleDrag(bubble) {
    bubble.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      bubbleDragging = false;
      bTotalMoved    = 0;
      bStartX = e.clientX; bStartY = e.clientY;
      var r = bubble.getBoundingClientRect();
      bOriginLeft = r.left; bOriginTop = r.top;
      bubble.setPointerCapture(e.pointerId);
      bubble.classList.add('dragging');
    });

    bubble.addEventListener('pointermove', function (e) {
      if (!bubble.hasPointerCapture(e.pointerId)) return;
      var dx = e.clientX - bStartX, dy = e.clientY - bStartY;
      bTotalMoved = Math.sqrt(dx*dx + dy*dy);
      if (bTotalMoved > DRAG_THRESHOLD) {
        bubbleDragging = true;
        e.preventDefault();
        var vW = window.innerWidth, vH = window.innerHeight;
        bubble.style.left = Math.max(0, Math.min(bOriginLeft+dx, vW-bubble.offsetWidth))  + 'px';
        bubble.style.top  = Math.max(0, Math.min(bOriginTop +dy, vH-bubble.offsetHeight)) + 'px';
      }
    });

    bubble.addEventListener('pointerup', function (e) {
      if (!bubble.hasPointerCapture(e.pointerId)) return;
      bubble.releasePointerCapture(e.pointerId);
      bubble.classList.remove('dragging');

      if (!bubbleDragging) {
        togglePanel();
      } else {
        var r = bubble.getBoundingClientRect();
        var vW = window.innerWidth, vH = window.innerHeight;
        var snapped = snapBubble(r.left, r.top, bubble.offsetWidth, bubble.offsetHeight, vW, vH);
        bubble.classList.add('snapping');
        bubble.style.left = snapped.left + 'px';
        bubble.style.top  = snapped.top  + 'px';
        bubble.addEventListener('transitionend', function done() {
          bubble.classList.remove('snapping');
          bubble.removeEventListener('transitionend', done);
          // Reposition panel next to bubble's new snapped position
          if (isPanelOpen()) {
            var panel = document.getElementById('aiPanel');
            if (panel) positionPanelNearBubble(panel);
          }
        });
        saveBubblePos(snapped.left, snapped.top);
      }
      bubbleDragging = false;
    });
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  function saveBubblePos(l, t)  { try { localStorage.setItem(BUBBLE_KEY,     JSON.stringify({left:l,top:t}));  } catch(e){} }
  function savePanelPos(l, t)   { try { localStorage.setItem(PANEL_KEY,      JSON.stringify({left:l,top:t}));  } catch(e){} }

  function getSavedPanelPos() {
    try {
      var s = JSON.parse(localStorage.getItem(PANEL_KEY) || 'null');
      if (s && typeof s.left === 'number') return s;
    } catch(e) {}
    return null;
  }

  function getSavedPanelSize() {
    try {
      var s = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || 'null');
      if (s && s.w) return s;
    } catch(e) {}
    return { w: PANEL_DEF_W };
  }

  function restoreBubblePos(bubble) {
    var vW = window.innerWidth, vH = window.innerHeight;
    var bW = bubble.offsetWidth || 60, bH = bubble.offsetHeight || 60;
    try {
      var s = JSON.parse(localStorage.getItem(BUBBLE_KEY) || 'null');
      if (s && s.left >= 0 && s.left <= vW-bW && s.top >= 0 && s.top <= vH-bH) {
        bubble.style.left = s.left + 'px';
        bubble.style.top  = s.top  + 'px';
        return;
      }
    } catch(e) {}
    bubble.style.left = (vW - bW - SNAP_MARGIN) + 'px';
    bubble.style.top  = (vH - bH - SNAP_MARGIN - 20) + 'px';
  }

  // ── Viewport resize ────────────────────────────────────────────────────────
  function wireResize() {
    window.addEventListener('resize', function () {
      var bubble = document.getElementById('aiBubble');
      var panel  = document.getElementById('aiPanel');
      var vW = window.innerWidth, vH = window.innerHeight;

      if (bubble) {
        var l = parseFloat(bubble.style.left)||0, t = parseFloat(bubble.style.top)||0;
        var cL = Math.max(0, Math.min(l, vW-bubble.offsetWidth));
        var cT = Math.max(0, Math.min(t, vH-bubble.offsetHeight));
        if (cL!==l||cT!==t) { bubble.style.left=cL+'px'; bubble.style.top=cT+'px'; }
      }

      if (panel && isPanelOpen()) {
        var pL = parseFloat(panel.style.left)||0, pT = parseFloat(panel.style.top)||0;
        var pW = panel.offsetWidth, pH = panel.offsetHeight;
        panel.style.left = Math.max(0, Math.min(pL, vW-pW)) + 'px';
        panel.style.top  = Math.max(0, Math.min(pT, vH-pH)) + 'px';
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function exposeAPI() {
    window._aiBubbleOpen   = openPanel;
    window._aiBubbleClose  = closePanel;
    window._aiBubbleToggle = togglePanel;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    var bubble = injectBubble();
    restoreBubblePos(bubble);
    attachBubbleDrag(bubble);

    // Panel may not exist yet (injected by portal HTML fetch) — poll briefly
    function wirePanel() {
      var panel = document.getElementById('aiPanel');
      if (!panel) { setTimeout(wirePanel, 150); return; }
      detachPanel();
      attachPanelDrag(panel);
      wireCloseBtn(panel);
      syncExpandedClass(bubble);
    }
    wirePanel();

    hookBridge();
    wireResize();
    exposeAPI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  window.addEventListener('ss-ready', init);
})();
