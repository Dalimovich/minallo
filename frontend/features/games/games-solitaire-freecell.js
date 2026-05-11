// â”€â”€ FREECELL SOLITAIRE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function () {
  var SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var tableau = [],
    freecells = [null, null, null, null],
    foundations = [[], [], [], []];
  var selected = null,
    selectedFrom = null,
    moves = 0,
    solTimer = null,
    solSecs = 0,
    history = [];
  function isRed(s) {
    return s === '\u2665' || s === '\u2666';
  }
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
        d.push({ suit: s, rank: r, value: i + 1, faceUp: true });
      });
    });
    shuf(d);
    tableau = [[], [], [], [], [], [], [], []];
    freecells = [null, null, null, null];
    foundations = [[], [], [], []];
    for (var i = 0; i < d.length; i++) tableau[i % 8].push(d[i]);
    selected = null;
    selectedFrom = null;
    moves = 0;
    solSecs = 0;
    history = [];
    var nb = document.getElementById('solNoMovesBanner');
    if (nb) nb.style.display = 'none';
  }
  function canTab(card, pile) {
    if (!pile.length) return true;
    var top = pile[pile.length - 1];
    return card.value === top.value - 1 && isRed(card.suit) !== isRed(top.suit);
  }
  function canFound(card, fi) {
    var p = foundations[fi];
    if (card.suit !== SUITS[fi]) return false;
    return p.length === 0 ? card.value === 1 : card.value === p[p.length - 1].value + 1;
  }
  function canFoundAny(card) {
    for (var f = 0; f < 4; f++) if (canFound(card, f)) return f;
    return -1;
  }
  // Supermove: max cards moveable = (freeCells+1)*2^emptyColumns
  function maxMove(dstIsEmpty) {
    var fc = freecells.filter(function (x) {
      return x === null;
    }).length;
    var ec = tableau.filter(function (p) {
      return !p.length;
    }).length;
    if (dstIsEmpty) ec = Math.max(0, ec - 1);
    return (fc + 1) * Math.pow(2, ec);
  }
  // Get the valid moveable sequence from bottom of pile
  function getMoveSeq(col) {
    var p = tableau[col];
    if (!p.length) return [];
    var seq = [p[p.length - 1]];
    for (var i = p.length - 2; i >= 0; i--) {
      var top = seq[seq.length - 1],
        cur = p[i];
      if (cur.value === top.value + 1 && isRed(cur.suit) !== isRed(top.suit)) seq.push(cur);
      else break;
    }
    return seq.reverse();
  }
  function clone(c) {
    return c ? { suit: c.suit, rank: c.rank, value: c.value, faceUp: c.faceUp } : null;
  }
  function save() {
    history.push({
      tab: tableau.map(function (p) {
        return p.map(clone);
      }),
      fc: freecells.map(clone),
      fnd: foundations.map(function (p) {
        return p.map(clone);
      }),
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
    tableau = h.tab;
    freecells = h.fc;
    foundations = h.fnd;
    moves = h.mv;
    solSecs = h.sc;
    selected = null;
    selectedFrom = null;
    document.getElementById('solMoves').textContent = moves;
    updUndo();
    render();
  }
  function afterMove() {
    document.getElementById('solMoves').textContent = moves;
    render();
    checkWin();
  }
  function checkWin() {
    if (
      foundations.every(function (f) {
        return f.length === 13;
      })
    ) {
      clearInterval(solTimer);
      history = [];
      updUndo();
      setTimeout(function () {
        _solWinOverlay(moves, 'window._freecellNewGame');
      }, 300);
    }
  }
  function _fcSnap(sel) {
    var e = document.querySelector(sel);
    return e ? { r: e.getBoundingClientRect(), h: e.innerHTML, c: e.className } : null;
  }
  function tryPlace(dstType, dstIdx) {
    if (!selected) return false;
    var card = selected;
    var srcSel =
      selectedFrom.type === 'freecell'
        ? '#solTable [data-type="freecell"][data-idx="' + selectedFrom.idx + '"]'
        : '#solTable [data-type="tableau"][data-idx="' +
          selectedFrom.idx +
          '"] [data-ci="' +
          (tableau[selectedFrom.idx].length - 1) +
          '"]';
    var dstSel =
      dstType === 'foundation'
        ? '#solTable [data-type="foundation"][data-idx="' + dstIdx + '"]'
        : dstType === 'freecell'
          ? '#solTable [data-type="freecell"][data-idx="' + dstIdx + '"]'
          : '#solTable [data-type="tableau"][data-idx="' + dstIdx + '"]';
    var ss = _fcSnap(srcSel);
    if (dstType === 'foundation') {
      if (canFound(card, dstIdx)) {
        save();
        if (selectedFrom.type === 'tableau') tableau[selectedFrom.idx].pop();
        else freecells[selectedFrom.idx] = null;
        foundations[dstIdx].push(card);
        moves++;
        selected = null;
        selectedFrom = null;
        afterMove();
        if (ss) _solFly(ss.r, ss.h, ss.c, dstSel, 200);
        return true;
      }
    } else if (dstType === 'freecell') {
      if (freecells[dstIdx] === null && selectedFrom.type === 'tableau') {
        if (tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1] === card) {
          save();
          tableau[selectedFrom.idx].pop();
          freecells[dstIdx] = card;
          moves++;
          selected = null;
          selectedFrom = null;
          afterMove();
          if (ss) _solFly(ss.r, ss.h, ss.c, dstSel, 200);
          return true;
        }
      }
    } else if (dstType === 'tableau') {
      var pile = tableau[dstIdx];
      if (selectedFrom.type === 'freecell') {
        if (canTab(card, pile)) {
          save();
          freecells[selectedFrom.idx] = null;
          pile.push(card);
          moves++;
          selected = null;
          selectedFrom = null;
          afterMove();
          if (ss) _solFly(ss.r, ss.h, ss.c, dstSel, 200);
          return true;
        }
      } else if (selectedFrom.type === 'tableau') {
        var seq = getMoveSeq(selectedFrom.idx);
        var moveCard = seq.length ? seq[0] : card;
        if (canTab(moveCard, pile)) {
          var limit = maxMove(!pile.length);
          var seqToMove = seq.length <= limit ? seq : [card];
          var srcStart = tableau[selectedFrom.idx].length - seqToMove.length;
          save();
          tableau[selectedFrom.idx].splice(srcStart);
          seqToMove.forEach(function (c) {
            pile.push(c);
          });
          moves++;
          selected = null;
          selectedFrom = null;
          afterMove();
          if (ss) _solFly(ss.r, ss.h, ss.c, dstSel, 200);
          return true;
        }
      }
    }
    return false;
  }
  function handleClick(type, idx, ci) {
    if (selected) {
      // Try to place
      if (tryPlace(type, idx)) return;
      // Re-select if clicking new card
      if (type === 'tableau' && ci !== undefined) {
        var p = tableau[idx];
        if (p.length && p[p.length - 1].faceUp) {
          selected = p[p.length - 1];
          selectedFrom = { type: 'tableau', idx: idx };
          render();
          return;
        }
      }
      if (type === 'freecell' && freecells[idx]) {
        selected = freecells[idx];
        selectedFrom = { type: 'freecell', idx: idx };
        render();
        return;
      }
      selected = null;
      selectedFrom = null;
      render();
      return;
    }
    if (type === 'tableau') {
      var p2 = tableau[idx];
      if (!p2.length) return;
      selected = p2[p2.length - 1];
      selectedFrom = { type: 'tableau', idx: idx };
      render();
    } else if (type === 'freecell') {
      if (!freecells[idx]) return;
      selected = freecells[idx];
      selectedFrom = { type: 'freecell', idx: idx };
      render();
    } else if (type === 'foundation') {
      return;
    }
  }
  function handleDbl(type, idx) {
    var card = null;
    if (type === 'tableau' && tableau[idx].length) card = tableau[idx][tableau[idx].length - 1];
    else if (type === 'freecell' && freecells[idx]) card = freecells[idx];
    if (!card) return;
    var fi = canFoundAny(card);
    if (fi < 0) return;
    save();
    if (type === 'tableau') tableau[idx].pop();
    else freecells[idx] = null;
    foundations[fi].push(card);
    moves++;
    selected = null;
    selectedFrom = null;
    afterMove();
  }
  function makeCard(card, sel) {
    var el = document.createElement('div');
    el.className = 'sol-card ' + (isRed(card.suit) ? 'red' : 'black') + (sel ? ' selected' : '');
    el.draggable = true;
    el.innerHTML =
      '<div class="sol-card-rank">' +
      card.rank +
      '</div><div class="sol-card-suit">' +
      card.suit +
      '</div><div class="sol-card-center">' +
      card.suit +
      '</div>';
    return el;
  }
  function makeEmpty(cls) {
    var el = document.createElement('div');
    el.className = 'sol-pile-empty' + (cls ? ' ' + cls : '');
    return el;
  }
  function render() {
    var table = document.getElementById('solTable');
    if (!table) return;
    table.innerHTML = '';
    table.className = 'sol-table';
    var topRow = document.createElement('div');
    topRow.className = 'sol-top-row';
    // 4 freecells
    for (var f = 0; f < 4; f++)
      (function (fi) {
        var fe = makeEmpty('sol-fc-cell');
        fe.dataset.type = 'freecell';
        fe.dataset.idx = fi;
        if (freecells[fi]) {
          var isSel =
            selected && selectedFrom && selectedFrom.type === 'freecell' && selectedFrom.idx === fi;
          var c = makeCard(freecells[fi], isSel);
          c.dataset.type = 'freecell';
          c.dataset.idx = fi;
          fe.appendChild(c);
        } else {
          fe.innerHTML =
            '<div style="font-size:.7rem;color:rgba(192,132,252,.25);text-align:center;line-height:88px">Free</div>';
        }
        topRow.appendChild(fe);
      })(f);
    var sp = document.createElement('div');
    sp.style.flex = '1';
    topRow.appendChild(sp);
    // 4 foundations
    for (var ff = 0; ff < 4; ff++)
      (function (fi) {
        var fe = makeEmpty('sol-pile-foundation');
        fe.dataset.type = 'foundation';
        fe.dataset.idx = fi;
        if (foundations[fi].length) {
          var top = foundations[fi][foundations[fi].length - 1];
          var c = makeCard(top, false);
          c.dataset.type = 'foundation';
          c.dataset.idx = fi;
          fe.appendChild(c);
        } else {
          fe.innerHTML =
            '<div style="font-size:1.6rem;color:rgba(192,132,252,.2);line-height:88px;text-align:center">' +
            SUITS[fi] +
            '</div>';
        }
        topRow.appendChild(fe);
      })(ff);
    table.appendChild(topRow);
    var tabRow = document.createElement('div');
    tabRow.className = 'sol-tableau';
    for (var t = 0; t < 8; t++)
      (function (ti) {
        var pe = document.createElement('div');
        pe.className = 'sol-tab-pile sol-pile';
        pe.dataset.type = 'tableau';
        pe.dataset.idx = ti;
        pe.dataset.ci = 'empty';
        var fcTop = 0;
        tableau[ti].forEach(function (card, ci) {
          var isSel =
            selected &&
            selectedFrom &&
            selectedFrom.type === 'tableau' &&
            selectedFrom.idx === ti &&
            ci === tableau[ti].length - 1;
          var cel = makeCard(card, isSel);
          cel.dataset.type = 'tableau';
          cel.dataset.idx = ti;
          cel.dataset.ci = ci;
          cel.style.cssText = 'position:absolute;top:' + fcTop + 'px;z-index:' + (ci + 1);
          pe.appendChild(cel);
          fcTop += card.faceUp ? 28 : 14;
        });
        pe.style.height = Math.max(88, fcTop + 62) + 'px';
        tabRow.appendChild(pe);
      })(t);
    table.appendChild(tabRow);
  }
  // â”€â”€ FreeCell Drag & Drop â”€â”€
  function fcDragStart(e) {
    var el = e.target.closest('[data-type]');
    if (!el) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0,
      ci = el.dataset.ci;
    if (type === 'freecell') {
      if (!freecells[idx]) {
        e.preventDefault();
        return;
      }
      selected = freecells[idx];
      selectedFrom = { type: 'freecell', idx: idx };
    } else if (type === 'tableau') {
      if (!ci || ci === 'empty') {
        e.preventDefault();
        return;
      }
      ci = parseInt(ci);
      var p = tableau[idx];
      if (!p[ci] || !p[ci].faceUp) {
        e.preventDefault();
        return;
      }
      selected = p[p.length - 1];
      selectedFrom = { type: 'tableau', idx: idx };
    } else {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'sol');
    setTimeout(function () {
      render();
    }, 0);
  }
  function fcDragOver(e) {
    e.preventDefault();
    if (!selected) return;
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    var el = e.target.closest('[data-type]');
    if (!el) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0;
    var ok =
      (type === 'tableau' && canTab(selected, tableau[idx])) ||
      (type === 'freecell' && freecells[idx] === null && selectedFrom.type === 'tableau') ||
      (type === 'foundation' && canFound(selected, idx));
    if (ok) {
      el.classList.add('sol-drop-hover');
      e.dataTransfer.dropEffect = 'move';
    } else e.dataTransfer.dropEffect = 'none';
  }
  function fcDragLeave(e) {
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget))
      document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
        x.classList.remove('sol-drop-hover');
      });
  }
  function fcDrop(e) {
    e.preventDefault();
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    var el = e.target.closest('[data-type]');
    if (!el || !selected) return;
    tryPlace(el.dataset.type, parseInt(el.dataset.idx) || 0);
    selected = null;
    selectedFrom = null;
  }
  function fcDragEnd(e) {
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    selected = null;
    selectedFrom = null;
    render();
  }
  function fcTableClick(e) {
    var el = e.target.closest('[data-type]');
    if (!el) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0,
      ci = el.dataset.ci;
    var cardIdx = ci === undefined || ci === 'empty' ? undefined : parseInt(ci);
    handleClick(type, idx, isNaN(cardIdx) ? undefined : cardIdx);
  }
  function fcTableDbl(e) {
    var el = e.target.closest('[data-type]');
    if (!el) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0;
    handleDbl(type, idx);
  }
  window._freecellCleanup = function () {
    var t = document.getElementById('solTable');
    if (!t) return;
    t.removeEventListener('dragstart', fcDragStart);
    t.removeEventListener('dragover', fcDragOver);
    t.removeEventListener('dragleave', fcDragLeave);
    t.removeEventListener('drop', fcDrop);
    t.removeEventListener('dragend', fcDragEnd);
    t.removeEventListener('click', fcTableClick);
    t.removeEventListener('dblclick', fcTableDbl);
  };
  window._freecellHC = function () {}; // handled by fcTableClick direct listener
  window._freecellDC = function () {}; // handled by fcTableDbl direct listener
  window._freecellStart = function () {
    var table = document.getElementById('solTable');
    if (!table) return;
    window._freecellCleanup();
    table.addEventListener('dragstart', fcDragStart);
    table.addEventListener('dragover', fcDragOver);
    table.addEventListener('dragleave', fcDragLeave);
    table.addEventListener('drop', fcDrop);
    table.addEventListener('dragend', fcDragEnd);
    table.addEventListener('click', fcTableClick);
    table.addEventListener('dblclick', fcTableDbl);
    document.getElementById('solGameTitle').textContent = 'FreeCell';
    var hb = document.getElementById('solitaireHint');
    if (hb) hb.style.display = 'none';
    deal();
    var tbl = document.getElementById('solTable');
    if (tbl)
      tbl.innerHTML =
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
  window._freecellStop = function () {
    clearInterval(solTimer);
  };
  window._freecellUndo = undo;
  window._freecellNewGame = function () {
    window._freecellStart();
  };
})();

