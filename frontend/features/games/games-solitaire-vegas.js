// â”€â”€ VEGAS SOLITAIRE (Draw-3 Klondike) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function () {
  var SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var tableau = [],
    stock = [],
    waste = [],
    foundations = [[], [], [], []];
  var selected = null,
    selectedFrom = null,
    moves = 0,
    solTimer = null,
    solSecs = 0,
    history = [];
  var redeals = 0,
    MAX_REDEALS = 2; // Vegas: 3 passes through deck total
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
        d.push({ suit: s, rank: r, value: i + 1, faceUp: false });
      });
    });
    shuf(d);
    tableau = [[], [], [], [], [], [], []];
    stock = [];
    waste = [];
    foundations = [[], [], [], []];
    var idx = 0;
    for (var c = 0; c < 7; c++) {
      for (var i = 0; i <= c; i++) {
        var card = d[idx++];
        card.faceUp = i === c;
        tableau[c].push(card);
      }
    }
    while (idx < d.length) stock.push(d[idx++]);
    selected = null;
    selectedFrom = null;
    moves = 0;
    solSecs = 0;
    history = [];
    redeals = 0;
    var nb = document.getElementById('solNoMovesBanner');
    if (nb) nb.style.display = 'none';
  }
  function canTab(card, pile) {
    if (!pile.length) return card.value === 13;
    var top = pile[pile.length - 1];
    return top.faceUp && card.value === top.value - 1 && isRed(card.suit) !== isRed(top.suit);
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
  function cloneCard(c) {
    return c ? { suit: c.suit, rank: c.rank, value: c.value, faceUp: c.faceUp } : null;
  }
  function save() {
    history.push({
      tab: tableau.map(function (p) {
        return p.map(cloneCard);
      }),
      stk: stock.map(cloneCard),
      wst: waste.map(cloneCard),
      fnd: foundations.map(function (p) {
        return p.map(cloneCard);
      }),
      mv: moves,
      sc: solSecs,
      sel: selected ? cloneCard(selected) : null,
      selF: selectedFrom ? JSON.parse(JSON.stringify(selectedFrom)) : null,
      rd: redeals
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
    stock = h.stk;
    waste = h.wst;
    foundations = h.fnd;
    moves = h.mv;
    solSecs = h.sc;
    selected = h.sel;
    selectedFrom = h.selF;
    redeals = h.rd;
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
        _solWinOverlay(moves, 'window._vegasNewGame');
      }, 300);
    }
  }
  function handleClick(type, idx, ci) {
    if (type === 'stock') {
      // Draw 3 from stock to waste
      if (stock.length) {
        save();
        var drawn = Math.min(3, stock.length);
        for (var i = 0; i < drawn; i++) {
          var c = stock.pop();
          c.faceUp = true;
          waste.push(c);
        }
        selected = null;
        selectedFrom = null;
        document.getElementById('solMoves').textContent = moves;
        render();
      } else if (redeals < MAX_REDEALS) {
        save();
        redeals++;
        while (waste.length) {
          var wc = waste.pop();
          wc.faceUp = false;
          stock.push(wc);
        }
        selected = null;
        document.getElementById('solMoves').textContent = moves;
        render();
      }
      return;
    }
    if (type === 'waste') {
      if (!waste.length) return;
      var wtop = waste[waste.length - 1];
      if (selected) {
        // try to place selected onto waste? No â€” waste is source only
        selected = null;
        selectedFrom = null;
        render();
        return;
      }
      selected = wtop;
      selectedFrom = { type: 'waste', idx: 0 };
      render();
      return;
    }
    if (type === 'foundation') {
      if (selected) {
        if (canFound(selected, idx)) {
          save();
          if (selectedFrom.type === 'waste') waste.pop();
          else if (selectedFrom.type === 'tableau') {
            tableau[selectedFrom.idx].pop();
            if (
              tableau[selectedFrom.idx].length &&
              !tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1].faceUp
            )
              tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1].faceUp = true;
          }
          foundations[idx].push(selected);
          moves++;
          selected = null;
          selectedFrom = null;
          afterMove();
        } else {
          selected = null;
          selectedFrom = null;
          render();
        }
      } else {
        if (foundations[idx].length) {
          selected = foundations[idx][foundations[idx].length - 1];
          selectedFrom = { type: 'foundation', idx: idx };
          render();
        }
      }
      return;
    }
    if (type === 'tableau') {
      var pile = tableau[idx];
      if (selected) {
        // Try to place
        var seq = selected._seq || [selected];
        // Same card clicked again â€” keep selected
        if (
          selectedFrom.type === 'tableau' &&
          selectedFrom.idx === idx &&
          selectedFrom.cardIdx === ci
        ) {
          render();
          return;
        }
        if (canTab(seq[0], pile)) {
          save();
          if (selectedFrom.type === 'waste') {
            waste.pop();
          } else if (selectedFrom.type === 'foundation') {
            foundations[selectedFrom.idx].pop();
          } else if (selectedFrom.type === 'tableau') {
            var src = tableau[selectedFrom.idx];
            var seqLen = seq.length;
            tableau[selectedFrom.idx] = src.slice(0, src.length - seqLen);
            if (
              tableau[selectedFrom.idx].length &&
              !tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1].faceUp
            )
              tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1].faceUp = true;
          }
          seq.forEach(function (card) {
            pile.push(card);
          });
          moves++;
          selected = null;
          selectedFrom = null;
          afterMove();
        } else {
          selected = null;
          selectedFrom = null;
          render();
        }
      } else {
        if (!pile.length || ci === undefined) return;
        var clickedCard = pile[ci];
        if (!clickedCard || !clickedCard.faceUp) return;
        // Build sequence from ci to end
        var seqCards = pile.slice(ci);
        var valid = true;
        for (var j = 1; j < seqCards.length; j++) {
          if (
            seqCards[j].value !== seqCards[j - 1].value - 1 ||
            isRed(seqCards[j].suit) === isRed(seqCards[j - 1].suit)
          ) {
            valid = false;
            break;
          }
        }
        if (!valid && ci !== pile.length - 1) {
          return;
        }
        selected = seqCards[0];
        selected._seq = seqCards;
        selectedFrom = { type: 'tableau', idx: idx, cardIdx: ci };
        render();
      }
      return;
    }
  }
  function handleDblClick(type, idx, ci) {
    var card = null;
    if (type === 'waste' && waste.length) card = waste[waste.length - 1];
    else if (type === 'tableau' && tableau[idx].length) {
      var p = tableau[idx];
      card = p[p.length - 1];
    }
    if (!card) return;
    var fi = canFoundAny(card);
    if (fi < 0) return;
    save();
    if (type === 'waste') waste.pop();
    else tableau[idx].pop();
    if (type === 'tableau' && tableau[idx].length && !tableau[idx][tableau[idx].length - 1].faceUp)
      tableau[idx][tableau[idx].length - 1].faceUp = true;
    foundations[fi].push(card);
    moves++;
    selected = null;
    selectedFrom = null;
    afterMove();
  }
  function makeCard(card) {
    var el = document.createElement('div');
    el.className = 'sol-card ' + (isRed(card.suit) ? 'red' : 'black');
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
  function makeFD() {
    var el = document.createElement('div');
    el.className = 'sol-card face-down';
    return el;
  }
  function makeEmpty() {
    var el = document.createElement('div');
    el.className = 'sol-pile-empty';
    return el;
  }
  function render() {
    var table = document.getElementById('solTable');
    if (!table) return;
    table.innerHTML = '';
    table.className = 'sol-table';
    var topRow = document.createElement('div');
    topRow.className = 'sol-top-row';
    // Stock
    var stockEl = makeEmpty();
    stockEl.style.cursor = 'pointer';
    stockEl.dataset.type = 'stock';
    stockEl.dataset.idx = '0';
    if (stock.length) {
      var sfd = makeFD();
      sfd.dataset.type = 'stock';
      sfd.dataset.idx = '0';
      stockEl.appendChild(sfd);
    } else if (redeals < MAX_REDEALS) {
      stockEl.innerHTML =
        '<div style="font-size:1.6rem;color:rgba(192,132,252,.35);line-height:88px;text-align:center">\u21BA</div>';
      stockEl.dataset.type = 'stock';
      stockEl.dataset.idx = '0';
    } else {
      stockEl.innerHTML =
        '<div style="font-size:.7rem;color:rgba(239,68,68,.5);line-height:88px;text-align:center">No<br>redeals</div>';
    }
    var rdLabel = document.createElement('div');
    rdLabel.style.cssText =
      'text-align:center;font-size:.6rem;color:rgba(192,132,252,.4);margin-top:2px';
    rdLabel.textContent = 'Redeals: ' + (MAX_REDEALS - redeals);
    stockEl.appendChild(rdLabel);
    topRow.appendChild(stockEl);
    // Waste â€” show top 3 fanned
    var wasteEl = makeEmpty();
    wasteEl.dataset.type = 'waste';
    wasteEl.dataset.idx = '0';
    wasteEl.style.position = 'relative';
    var showCount = Math.min(3, waste.length);
    for (var wi = waste.length - showCount; wi < waste.length; wi++) {
      (function (wii, offset) {
        var wel = makeCard(waste[wii]);
        wel.style.position = 'absolute';
        wel.style.left = offset * 14 + 'px';
        wel.style.top = '0';
        wel.style.zIndex = offset + 1;
        if (wii === waste.length - 1) {
          wel.dataset.type = 'waste';
          wel.dataset.idx = '0';
          wel.dataset.ci = wii;
          if (selected && selectedFrom && selectedFrom.type === 'waste')
            wel.classList.add('selected');
        } else {
          wel.style.pointerEvents = 'none';
        }
        wasteEl.appendChild(wel);
      })(wi, wi - (waste.length - showCount));
    }
    wasteEl.style.width = showCount > 1 ? 28 + 62 + 'px' : '62px';
    topRow.appendChild(wasteEl);
    var sp = document.createElement('div');
    sp.style.flex = '1';
    topRow.appendChild(sp);
    // Foundations
    for (var f = 0; f < 4; f++)
      (function (fi) {
        var fEl = makeEmpty();
        fEl.classList.add('sol-pile-foundation');
        fEl.dataset.type = 'foundation';
        fEl.dataset.idx = fi;
        if (foundations[fi].length) {
          var fc = makeCard(foundations[fi][foundations[fi].length - 1]);
          fc.dataset.type = 'foundation';
          fc.dataset.idx = fi;
          fEl.appendChild(fc);
        } else {
          var sl = document.createElement('div');
          sl.style.cssText =
            'font-size:1.8rem;color:rgba(192,132,252,.22);line-height:88px;text-align:center;width:100%';
          sl.textContent = SUITS[fi];
          fEl.appendChild(sl);
        }
        topRow.appendChild(fEl);
      })(f);
    table.appendChild(topRow);
    // Tableau
    var tabRow = document.createElement('div');
    tabRow.className = 'sol-tableau';
    for (var t = 0; t < 7; t++)
      (function (ti) {
        var pileEl = document.createElement('div');
        pileEl.className = 'sol-tab-pile sol-pile';
        pileEl.dataset.type = 'tableau';
        pileEl.dataset.idx = ti;
        pileEl.dataset.ci = 'empty';
        var vTop = 0;
        tableau[ti].forEach(function (card, ci) {
          var cel = card.faceUp ? makeCard(card) : makeFD();
          cel.dataset.type = 'tableau';
          cel.dataset.idx = ti;
          cel.dataset.ci = ci;
          cel.style.position = 'absolute';
          cel.style.top = vTop + 'px';
          cel.style.zIndex = ci + 1;
          if (
            card.faceUp &&
            selected &&
            selectedFrom &&
            selectedFrom.type === 'tableau' &&
            selectedFrom.idx === ti &&
            ci >= selectedFrom.cardIdx
          )
            cel.classList.add('selected');
          pileEl.appendChild(cel);
          vTop += card.faceUp ? 28 : 14;
        });
        pileEl.style.height = Math.max(88, vTop + 62) + 'px';
        tabRow.appendChild(pileEl);
      })(t);
    table.appendChild(tabRow);
  }
  // â”€â”€ Drag & Drop â”€â”€
  function vegDragStart(e) {
    var el = e.target.closest('[data-type]');
    if (!el) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0,
      ci = el.dataset.ci;
    if (type === 'waste') {
      if (!waste.length) {
        e.preventDefault();
        return;
      }
      var wtop = waste[waste.length - 1];
      selected = wtop;
      selected._seq = [wtop];
      selectedFrom = { type: 'waste', idx: 0 };
    } else if (type === 'tableau') {
      if (ci === undefined || ci === 'empty') {
        e.preventDefault();
        return;
      }
      ci = parseInt(ci);
      var pile = tableau[idx];
      if (!pile[ci] || !pile[ci].faceUp) {
        e.preventDefault();
        return;
      }
      var seqCards = pile.slice(ci);
      var valid = true;
      for (var j = 1; j < seqCards.length; j++) {
        if (
          seqCards[j].value !== seqCards[j - 1].value - 1 ||
          isRed(seqCards[j].suit) === isRed(seqCards[j - 1].suit)
        ) {
          valid = false;
          break;
        }
      }
      if (!valid && ci !== pile.length - 1) {
        e.preventDefault();
        return;
      }
      selected = seqCards[0];
      selected._seq = seqCards;
      selectedFrom = { type: 'tableau', idx: idx, cardIdx: ci };
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
  function vegDragOver(e) {
    e.preventDefault();
    if (!selected) return;
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    var el = e.target.closest('[data-type]');
    if (!el) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0;
    var seq = selected._seq || [selected];
    var valid =
      (type === 'tableau' && canTab(seq[0], tableau[idx])) ||
      (type === 'foundation' && seq.length === 1 && canFound(seq[0], idx));
    if (valid) {
      el.classList.add('sol-drop-hover');
      e.dataTransfer.dropEffect = 'move';
    } else e.dataTransfer.dropEffect = 'none';
  }
  function vegDragLeave(e) {
    var el = e.target.closest('[data-type]');
    if (el) el.classList.remove('sol-drop-hover');
  }
  function vegDrop(e) {
    e.preventDefault();
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    var el = e.target.closest('[data-type]');
    if (!el || !selected) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0;
    var seq = selected._seq || [selected];
    if (type === 'tableau' && canTab(seq[0], tableau[idx])) {
      save();
      if (selectedFrom.type === 'waste') waste.pop();
      else if (selectedFrom.type === 'tableau') {
        var src = tableau[selectedFrom.idx];
        tableau[selectedFrom.idx] = src.slice(0, src.length - seq.length);
        if (
          tableau[selectedFrom.idx].length &&
          !tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1].faceUp
        )
          tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1].faceUp = true;
      }
      seq.forEach(function (card) {
        tableau[idx].push(card);
      });
      moves++;
      selected = null;
      selectedFrom = null;
      afterMove();
    } else if (type === 'foundation' && seq.length === 1 && canFound(seq[0], idx)) {
      save();
      if (selectedFrom.type === 'waste') waste.pop();
      else if (selectedFrom.type === 'tableau') {
        var src2 = tableau[selectedFrom.idx];
        tableau[selectedFrom.idx] = src2.slice(0, src2.length - 1);
        if (
          tableau[selectedFrom.idx].length &&
          !tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1].faceUp
        )
          tableau[selectedFrom.idx][tableau[selectedFrom.idx].length - 1].faceUp = true;
      }
      foundations[idx].push(seq[0]);
      moves++;
      selected = null;
      selectedFrom = null;
      afterMove();
    } else {
      selected = null;
      selectedFrom = null;
      render();
    }
  }
  function vegDragEnd(e) {
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    selected = null;
    selectedFrom = null;
    render();
  }
  window._vegasCleanup = function () {
    var t = document.getElementById('solTable');
    if (!t) return;
    t.removeEventListener('dragstart', vegDragStart);
    t.removeEventListener('dragover', vegDragOver);
    t.removeEventListener('dragleave', vegDragLeave);
    t.removeEventListener('drop', vegDrop);
    t.removeEventListener('dragend', vegDragEnd);
  };
  window._vegasHC = function (type, idx, ci) {
    handleClick(type, idx, ci);
  };
  window._vegasDC = function (type, idx, ci) {
    handleDblClick(type, idx, ci);
  };
  window._vegasStart = function () {
    var table = document.getElementById('solTable');
    if (!table) return;
    document.getElementById('solGameTitle').textContent = 'Vegas';
    window._vegasCleanup();
    table.addEventListener('dragstart', vegDragStart);
    table.addEventListener('dragover', vegDragOver);
    table.addEventListener('dragleave', vegDragLeave);
    table.addEventListener('drop', vegDrop);
    table.addEventListener('dragend', vegDragEnd);
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
  window._vegasStop = function () {
    clearInterval(solTimer);
  };
  window._vegasUndo = undo;
  window._vegasNewGame = function () {
    window._vegasStart();
  };
})();

