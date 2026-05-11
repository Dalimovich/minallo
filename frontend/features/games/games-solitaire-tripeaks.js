// â”€â”€ TRI-PEAKS SOLITAIRE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function () {
  var SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  // 28 peak cards + 24 stock
  // Indices 0-27, layout:
  // Row0: 0,1,2  (peak tops)
  // Row1: 3,4,5,6,7,8  (2 per peak)
  // Row2: 9,10,11,12,13,14,15,16,17  (3 per peak)
  // Row3 (base): 18,19,20,21,22,23,24,25,26,27  (10)
  // Coverage: card at idx is covered by cards below it (higher row indices)
  var COVERS = {
    0: [3, 4],
    1: [5, 6],
    2: [7, 8],
    3: [9, 10],
    4: [10, 11],
    5: [12, 13],
    6: [13, 14],
    7: [15, 16],
    8: [16, 17],
    9: [18, 19],
    10: [19, 20],
    11: [20, 21],
    12: [21, 22],
    13: [22, 23],
    14: [23, 24],
    15: [24, 25],
    16: [25, 26],
    17: [26, 27]
  };
  // Position (col-offset) for rendering â€” each unit = card width (60px) + gap
  // Row3 has 10 cards spanning full width; peaks are centered above
  var COLS = 10; // base width in card units
  var POS = [
    // Row 0: peak tops â€” peak1 at col1.5, peak2 at col4.5, peak3 at col7.5 (0-indexed center)
    { r: 0, c: 1.5 },
    { r: 0, c: 4.5 },
    { r: 0, c: 7.5 },
    // Row 1
    { r: 1, c: 1 },
    { r: 1, c: 2 },
    { r: 1, c: 4 },
    { r: 1, c: 5 },
    { r: 1, c: 7 },
    { r: 1, c: 8 },
    // Row 2
    { r: 2, c: 0.5 },
    { r: 2, c: 1.5 },
    { r: 2, c: 2.5 },
    { r: 2, c: 3.5 },
    { r: 2, c: 4.5 },
    { r: 2, c: 5.5 },
    { r: 2, c: 6.5 },
    { r: 2, c: 7.5 },
    { r: 2, c: 8.5 },
    // Row 3 (base)
    { r: 3, c: 0 },
    { r: 3, c: 1 },
    { r: 3, c: 2 },
    { r: 3, c: 3 },
    { r: 3, c: 4 },
    { r: 3, c: 5 },
    { r: 3, c: 6 },
    { r: 3, c: 7 },
    { r: 3, c: 8 },
    { r: 3, c: 9 }
  ];
  var peaks = [],
    stock = [],
    waste = [];
  var moves = 0,
    solTimer = null,
    solSecs = 0,
    history = [];
  function shuf(d) {
    for (var i = d.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = d[i];
      d[i] = d[j];
      d[j] = t;
    }
    return d;
  }
  function deal() {
    var d = [];
    SUITS.forEach(function (s) {
      RANKS.forEach(function (r, i) {
        d.push({ suit: s, rank: r, value: i + 1 });
      });
    });
    shuf(d);
    peaks = d.slice(0, 28).map(function (c, i) {
      return { suit: c.suit, rank: c.rank, value: c.value, removed: false, faceUp: true };
    });
    stock = d.slice(28).map(function (c) {
      return { suit: c.suit, rank: c.rank, value: c.value, removed: false, faceUp: false };
    });
    waste = [];
    moves = 0;
    solSecs = 0;
    history = [];
    var nb = document.getElementById('solNoMovesBanner');
    if (nb) nb.style.display = 'none';
  }
  function isRed(s) {
    return s === '\u2665' || s === '\u2666';
  }
  function isCov(idx) {
    var coverers = COVERS[idx];
    if (!coverers) return false;
    return coverers.some(function (ci) {
      return !peaks[ci].removed;
    });
  }
  function isUncov(idx) {
    return !peaks[idx].removed && !isCov(idx);
  }
  function seq(v1, v2) {
    var diff = Math.abs(v1 - v2);
    return diff === 1 || diff === 12;
  } // A-K wrapping
  function wasteTop() {
    return waste.length ? waste[waste.length - 1] : null;
  }
  function clone2(c) {
    return { suit: c.suit, rank: c.rank, value: c.value, removed: c.removed, faceUp: c.faceUp };
  }
  function save() {
    history.push({
      pk: peaks.map(clone2),
      stk: stock.map(clone2),
      wst: waste.map(clone2),
      mv: moves,
      sc: solSecs
    });
    if (history.length > 80) history.shift();
    updUndo();
  }
  function updUndo() {
    var b = document.getElementById('solitaireUndo');
    if (b) {
      b.disabled = !history.length;
      b.style.opacity = history.length ? '1' : '.4';
    }
  }
  function undo() {
    if (!history.length) return;
    var h = history.pop();
    peaks = h.pk;
    stock = h.stk;
    waste = h.wst;
    moves = h.mv;
    solSecs = h.sc;
    document.getElementById('solMoves').textContent = moves;
    updUndo();
    render();
  }
  function afterMove() {
    // Reveal newly uncovered cards
    for (var i = 0; i < 28; i++) {
      if (!peaks[i].removed && !isCov(i)) peaks[i].faceUp = true;
    }
    document.getElementById('solMoves').textContent = moves;
    render();
    checkWin();
  }
  function checkWin() {
    if (
      peaks.every(function (c) {
        return c.removed;
      })
    ) {
      clearInterval(solTimer);
      history = [];
      updUndo();
      setTimeout(function () {
        _solWinOverlay(moves, 'window._tripeaksNewGame');
      }, 300);
    }
  }
  function _triSnap(sel) {
    var e = document.querySelector(sel);
    return e ? { r: e.getBoundingClientRect(), h: e.innerHTML, c: e.className } : null;
  }
  function handleClick(type, idx) {
    if (type === 'stock') {
      if (stock.length) {
        var ss = _triSnap('#solTable [data-type="stock"]');
        save();
        var c = stock.pop();
        c.faceUp = true;
        waste.push(c);
        document.getElementById('solMoves').textContent = moves;
        render();
        if (ss)
          _solFly(ss.r, '', 'sol-card face-down', '#solTable [data-type="waste-display"]', 180);
      }
      return;
    }
    if (type === 'peak') {
      if (peaks[idx].removed || !isUncov(idx)) return;
      var sp = _triSnap('#solTable [data-type="peak"][data-idx="' + idx + '"]');
      var wt = wasteTop();
      if (!wt) {
        save();
        waste.push(peaks[idx]);
        peaks[idx].removed = true;
        moves++;
        afterMove();
        if (sp) _solFly(sp.r, sp.h, sp.c, '#solTable [data-type="waste-display"]', 180);
        return;
      }
      if (seq(peaks[idx].value, wt.value)) {
        save();
        waste.push(peaks[idx]);
        peaks[idx].removed = true;
        moves++;
        afterMove();
        if (sp) _solFly(sp.r, sp.h, sp.c, '#solTable [data-type="waste-display"]', 180);
      }
    }
  }
  function render() {
    var table = document.getElementById('solTable');
    if (!table) return;
    table.innerHTML = '';
    table.className = 'sol-table';
    var CW = 58,
      CH = 82,
      GAP = 4,
      ROW_H = 56;
    var totalW = COLS * (CW + GAP) - GAP;
    var wrap = document.createElement('div');
    wrap.style.cssText =
      'position:relative;width:' + totalW + 'px;height:' + (4 * ROW_H + CH) + 'px;margin:0 auto';
    for (var i = 0; i < 28; i++) {
      if (peaks[i].removed) continue;
      var pos = POS[i];
      var left = pos.c * (CW + GAP),
        top = pos.r * ROW_H;
      var el = document.createElement('div');
      el.style.cssText =
        'position:absolute;left:' +
        left +
        'px;top:' +
        top +
        'px;width:' +
        CW +
        'px;height:' +
        CH +
        'px';
      var uncov = isUncov(i);
      el.className = 'sol-card ' + (isRed(peaks[i].suit) ? 'red' : 'black');
      if (!uncov) {
        el.style.opacity = '.55';
        el.style.cursor = 'default';
      } else {
        var wt2 = wasteTop();
        el.dataset.type = 'peak';
        el.dataset.idx = i;
        (function (pi) {
          el.onclick = function () {
            handleClick('peak', pi);
          };
        })(i);
      }
      el.innerHTML =
        '<div class="sol-card-rank">' +
        peaks[i].rank +
        '</div><div class="sol-card-suit">' +
        peaks[i].suit +
        '</div><div class="sol-card-center">' +
        peaks[i].suit +
        '</div>';
      wrap.appendChild(el);
    }
    table.appendChild(wrap);
    var botRow = document.createElement('div');
    botRow.style.cssText = 'display:flex;gap:10px;margin-top:12px;align-items:flex-start';
    var se = document.createElement('div');
    se.className = 'sol-pile-empty';
    se.dataset.type = 'stock';
    se.dataset.idx = '0';
    se.style.cursor = 'pointer';
    se.onclick = function () {
      handleClick('stock', 0);
    };
    if (stock.length) {
      var fd = document.createElement('div');
      fd.className = 'sol-card face-down';
      fd.dataset.type = 'stock';
      fd.dataset.idx = '0';
      se.appendChild(fd);
      var lb = document.createElement('div');
      lb.style.cssText =
        'text-align:center;font-size:.65rem;color:rgba(192,132,252,.5);margin-top:2px';
      lb.textContent = stock.length + ' left';
      se.appendChild(lb);
    } else {
      se.innerHTML =
        '<div style="font-size:1rem;color:rgba(192,132,252,.3);line-height:88px;text-align:center">\u2205</div>';
    }
    botRow.appendChild(se);
    var we = document.createElement('div');
    we.className = 'sol-pile-empty';
    we.dataset.type = 'waste-display';
    var wt3 = wasteTop();
    if (wt3) {
      var wcel = document.createElement('div');
      wcel.className = 'sol-card ' + (isRed(wt3.suit) ? 'red' : 'black');
      wcel.innerHTML =
        '<div class="sol-card-rank">' +
        wt3.rank +
        '</div><div class="sol-card-suit">' +
        wt3.suit +
        '</div><div class="sol-card-center">' +
        wt3.suit +
        '</div>';
      we.appendChild(wcel);
    } else {
      we.innerHTML =
        '<div style="font-size:.8rem;color:rgba(192,132,252,.2);line-height:88px;text-align:center">Waste</div>';
    }
    botRow.appendChild(we);
    var rem = document.createElement('span');
    rem.style.cssText =
      'color:rgba(192,132,252,.5);font-size:.8rem;align-self:center;margin-left:8px';
    rem.textContent =
      peaks.filter(function (c) {
        return !c.removed;
      }).length + ' peak cards left';
    botRow.appendChild(rem);
    table.appendChild(botRow);
  }
  window._tripeaksCleanup = function () {};
  window._tripeaksHC = function () {};
  window._tripeaksStart = function () {
    var table = document.getElementById('solTable');
    if (!table) return;
    document.getElementById('solGameTitle').textContent = 'Tri-Peaks';
    var hb = document.getElementById('solitaireHint');
    if (hb) hb.style.display = 'none';
    deal();
    table.innerHTML =
      '<div class="sol-shuffle-anim"><div class="sol-shuffle-deck"></div><div class="sol-shuffle-label">Shuffling\u2026</div></div>';
    document.getElementById('solMoves').textContent = '0';
    var et = document.getElementById('solTime');
    if (et) et.textContent = '0:00';
    clearInterval(solTimer);
    solTimer = setInterval(function () {
      solSecs++;
      var m = Math.floor(solSecs / 60),
        s = solSecs % 60;
      var el = document.getElementById('solTime');
      if (el) el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }, 1000);
    setTimeout(function () {
      render();
    }, 700);
  };
  window._tripeaksStop = function () {
    clearInterval(solTimer);
  };
  window._tripeaksUndo = undo;
  window._tripeaksNewGame = function () {
    window._tripeaksStart();
  };
})();

