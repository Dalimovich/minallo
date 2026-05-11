/* ── AI FLOATING BUBBLE ─────────────────────────────────────────────────────
   Draggable floating button that opens/closes the existing #aiPanel.
   No custom panel — the real panel with all its features (copy, regenerate,
   saved chats, chips, etc.) is used exactly as-is.
   ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var DRAG_THRESHOLD = 6;
  var SNAP_MARGIN    = 16;
  var STORAGE_KEY    = 'ss_ai_bubble_pos';

  var isDragging      = false;
  var startX          = 0;
  var startY          = 0;
  var bubbleStartLeft = 0;
  var bubbleStartTop  = 0;
  var totalMovement   = 0;
  var _initialized    = false;

  // ── Inject bubble button ───────────────────────────────────────────────────
  function injectBubble() {
    if (document.getElementById('aiBubble')) return;
    var el = document.createElement('div');
    el.id    = 'aiBubble';
    el.title = 'StudySphere AI';
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

  // ── Open / close the real AI panel ────────────────────────────────────────
  function isPanelOpen() {
    var panel = document.getElementById('aiPanel');
    return panel ? panel.classList.contains('visible') : false;
  }

  function openPanel() {
    // Use the bridge's openAI if available, else toggle class directly
    if (typeof window.openAI === 'function') {
      window.openAI();
    } else {
      var panel = document.getElementById('aiPanel');
      if (panel) panel.classList.add('visible');
    }
    var bubble = document.getElementById('aiBubble');
    if (bubble) bubble.classList.add('expanded');
  }

  function closePanel() {
    if (typeof window.forceCloseAI === 'function') {
      window.forceCloseAI();
    } else {
      var panel = document.getElementById('aiPanel');
      if (panel) panel.classList.remove('visible');
    }
    var bubble = document.getElementById('aiBubble');
    if (bubble) bubble.classList.remove('expanded');
  }

  function togglePanel() {
    if (isPanelOpen()) closePanel(); else openPanel();
  }

  // Keep bubble expanded class in sync with panel state ──────────────────────
  function syncExpandedClass() {
    var panel  = document.getElementById('aiPanel');
    var bubble = document.getElementById('aiBubble');
    if (!panel || !bubble) return;
    // Watch for class changes on panel and mirror to bubble
    var obs = new MutationObserver(function () {
      if (panel.classList.contains('visible')) {
        bubble.classList.add('expanded');
      } else {
        bubble.classList.remove('expanded');
      }
    });
    obs.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  // ── Snap logic ─────────────────────────────────────────────────────────────
  function snapBubble(x, y, bW, bH, vW, vH) {
    var distL = x, distR = vW - x - bW, distT = y, distB = vH - y - bH;
    var min = Math.min(distL, distR, distT, distB);
    if (min === distL) return { left: SNAP_MARGIN, top: Math.max(SNAP_MARGIN, Math.min(y, vH - bH - SNAP_MARGIN)) };
    if (min === distR) return { left: vW - bW - SNAP_MARGIN, top: Math.max(SNAP_MARGIN, Math.min(y, vH - bH - SNAP_MARGIN)) };
    if (min === distT) return { left: Math.max(SNAP_MARGIN, Math.min(x, vW - bW - SNAP_MARGIN)), top: SNAP_MARGIN + 56 };
    return { left: Math.max(SNAP_MARGIN, Math.min(x, vW - bW - SNAP_MARGIN)), top: vH - bH - SNAP_MARGIN };
  }

  // ── Drag ───────────────────────────────────────────────────────────────────
  function attachDrag(bubble) {
    bubble.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      isDragging    = false;
      totalMovement = 0;
      startX = e.clientX;
      startY = e.clientY;
      var rect = bubble.getBoundingClientRect();
      bubbleStartLeft = rect.left;
      bubbleStartTop  = rect.top;
      bubble.setPointerCapture(e.pointerId);
      bubble.classList.add('dragging');
    });

    bubble.addEventListener('pointermove', function (e) {
      if (!bubble.hasPointerCapture(e.pointerId)) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      totalMovement = Math.sqrt(dx * dx + dy * dy);
      if (totalMovement > DRAG_THRESHOLD) {
        isDragging = true;
        e.preventDefault();
        var vW = window.innerWidth, vH = window.innerHeight;
        var newLeft = Math.max(0, Math.min(bubbleStartLeft + dx, vW - bubble.offsetWidth));
        var newTop  = Math.max(0, Math.min(bubbleStartTop  + dy, vH - bubble.offsetHeight));
        bubble.style.left = newLeft + 'px';
        bubble.style.top  = newTop  + 'px';
      }
    });

    bubble.addEventListener('pointerup', function (e) {
      if (!bubble.hasPointerCapture(e.pointerId)) return;
      bubble.releasePointerCapture(e.pointerId);
      bubble.classList.remove('dragging');

      if (!isDragging) {
        togglePanel();
      } else {
        var rect = bubble.getBoundingClientRect();
        var vW = window.innerWidth, vH = window.innerHeight;
        var snapped = snapBubble(rect.left, rect.top, bubble.offsetWidth, bubble.offsetHeight, vW, vH);
        bubble.classList.add('snapping');
        bubble.style.left = snapped.left + 'px';
        bubble.style.top  = snapped.top  + 'px';
        bubble.addEventListener('transitionend', function onSnap() {
          bubble.classList.remove('snapping');
          bubble.removeEventListener('transitionend', onSnap);
        });
        savePosition(snapped.left, snapped.top);
      }
      isDragging = false;
    });
  }

  // ── Position persistence ───────────────────────────────────────────────────
  function savePosition(left, top) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: left, top: top })); } catch (e) {}
  }

  function restorePosition(bubble) {
    var vW = window.innerWidth,  vH = window.innerHeight;
    var bW = bubble.offsetWidth  || 60;
    var bH = bubble.offsetHeight || 60;
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && saved.left >= 0 && saved.left <= vW - bW && saved.top >= 0 && saved.top <= vH - bH) {
        bubble.style.left = saved.left + 'px';
        bubble.style.top  = saved.top  + 'px';
        return;
      }
    } catch (e) {}
    bubble.style.left = (vW - bW - SNAP_MARGIN) + 'px';
    bubble.style.top  = (vH - bH - SNAP_MARGIN - 20) + 'px';
  }

  // ── Viewport resize: keep bubble in bounds ─────────────────────────────────
  function wireResize() {
    window.addEventListener('resize', function () {
      var bubble = document.getElementById('aiBubble');
      if (!bubble) return;
      var vW = window.innerWidth, vH = window.innerHeight;
      var left = parseFloat(bubble.style.left) || 0;
      var top  = parseFloat(bubble.style.top)  || 0;
      var cL   = Math.max(0, Math.min(left, vW - bubble.offsetWidth));
      var cT   = Math.max(0, Math.min(top,  vH - bubble.offsetHeight));
      if (cL !== left || cT !== top) { bubble.style.left = cL + 'px'; bubble.style.top = cT + 'px'; }
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
    if (!bubble) return;

    restorePosition(bubble);
    attachDrag(bubble);
    syncExpandedClass();
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
