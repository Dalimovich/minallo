// â”€â”€ SCORPION SOLITAIRE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function () {
  var SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var tableau = [],
    stock = [],
    foundations = [];
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
  function mk(s, r, i) {
    return { suit: s, rank: r, value: i + 1, faceUp: false };
  }
  function deal() {
    var d = [];
    SUITS.forEach(function (s) {
      RANKS.forEach(function (r, i) {
        d.push(mk(s, r, i));
      });
    });
    shuf(d);
    tableau = [];
    var idx = 0;
    // 7 columns: cols 0-3 have 7 cards (first 3 face-down), cols 4-6 have 7 cards (all face-up)
    for (var c = 0; c < 7; c++) {
      tableau.push([]);
      for (var i = 0; i < 7; i++) {
        var card = d[idx++];
        card.faceUp = c >= 4 || i >= 3;
        tableau[c].push(card);
      }
    }
    // remaining 3 cards go to stock
    stock = [];
    while (idx < d.length) stock.push(d[idx++]);
    foundations = [];
    selected = null;
    selectedFrom = null;
    moves = 0;
    solSecs = 0;
    history = [];
  }
  // In Scorpion, you can move a face-up card (and all cards on top of it)
  // onto a card of the same suit that is one rank higher
  function canPlace(card, pile) {
    if (!pile.length) return card.value === 13; // King to empty
    var top = pile[pile.length - 1];
    return top.faceUp && card.suit === top.suit && card.value === top.value - 1;
  }
  function checkRuns() {
    for (var t = 0; t < 7; t++) {
      var p = tableau[t];
      if (p.length < 13) continue;
      var base = p.length - 13;
      if (p[base].value !== 13) continue;
      var suit = p[base].suit,
        ok = true;
      for (var i = 0; i < 13; i++) {
        if (!p[base + i].faceUp || p[base + i].suit !== suit || p[base + i].value !== 13 - i) {
          ok = false;
          break;
        }
      }
      if (ok) {
        foundations.push(suit);
        tableau[t] = p.slice(0, base);
        if (tableau[t].length && !tableau[t][tableau[t].length - 1].faceUp)
          tableau[t][tableau[t].length - 1].faceUp = true;
        t--;
      }
    }
  }
  function clone(c) {
    return { suit: c.suit, rank: c.rank, value: c.value, faceUp: c.faceUp };
  }
  function save() {
    history.push({
      tab: tableau.map(function (p) {
        return p.map(clone);
      }),
      stk: stock.map(clone),
      fnd: foundations.slice(),
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
    stock = h.stk;
    foundations = h.fnd;
    moves = h.mv;
    solSecs = h.sc;
    selected = null;
    selectedFrom = null;
    document.getElementById('solMoves').textContent = moves;
    updUndo();
    render();
  }
  function dealStock() {
    if (!stock.length) return;
    save();
    for (var t = 0; t < 3 && stock.length; t++) {
      var c = stock.pop();
      c.faceUp = true;
      tableau[t].push(c);
    }
    checkRuns();
    moves++;
    document.getElementById('solMoves').textContent = moves;
    render();
    checkWin();
  }
  function checkWin() {
    if (foundations.length === 4) {
      clearInterval(solTimer);
      history = [];
      updUndo();
      setTimeout(function () {
        _solWinOverlay(moves, 'window._scorpionNewGame');
      }, 300);
    }
  }
  function tryPlace(di) {
    if (!selected || !selected.length) return false;
    if (!canPlace(selected[0], tableau[di])) return false;
    save();
    tableau[selectedFrom.idx].splice(selectedFrom.ci);
    var sp = tableau[selectedFrom.idx];
    if (sp.length && !sp[sp.length - 1].faceUp) sp[sp.length - 1].faceUp = true;
    selected.forEach(function (c) {
      tableau[di].push(c);
    });
    checkRuns();
    moves++;
    selected = null;
    selectedFrom = null;
    document.getElementById('solMoves').textContent = moves;
    render();
    checkWin();
    return true;
  }
  function handleClick(type, idx, ci) {
    if (type === 'stock') {
      dealStock();
      return;
    }
    if (type !== 'tableau') return;
    if (ci === undefined) {
      if (selected) {
        tryPlace(idx);
        return;
      }
      selected = null;
      selectedFrom = null;
      render();
      return;
    }
    ci = parseInt(ci);
    var pile = tableau[idx];
    if (!pile[ci] || !pile[ci].faceUp) {
      selected = null;
      selectedFrom = null;
      render();
      return;
    }
    if (selected) {
      if (selectedFrom.idx === idx && selectedFrom.ci === ci) {
        render();
        return;
      }
      if (tryPlace(idx)) return;
      // pick new sequence
      selected = pile.slice(ci);
      selectedFrom = { idx: idx, ci: ci };
      render();
      return;
    }
    selected = pile.slice(ci);
    selectedFrom = { idx: idx, ci: ci };
    render();
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
  function render() {
    var table = document.getElementById('solTable');
    if (!table) return;
    table.innerHTML = '';
    table.className = 'sol-table';
    var topRow = document.createElement('div');
    topRow.className = 'sol-top-row';
    var se = document.createElement('div');
    se.className = 'sol-pile-empty';
    se.style.cursor = stock.length ? 'pointer' : 'default';
    se.style.position = 'relative';
    se.dataset.type = 'stock';
    se.dataset.idx = '0';
    if (stock.length) {
      var fd = makeFD();
      fd.dataset.type = 'stock';
      fd.dataset.idx = '0';
      se.appendChild(fd);
      var lb = document.createElement('div');
      lb.style.cssText =
        'position:absolute;bottom:3px;right:5px;font-size:.6rem;color:rgba(192,132,252,.7);font-weight:700';
      lb.textContent = stock.length;
      se.appendChild(lb);
    } else {
      se.innerHTML =
        '<div style="font-size:1rem;color:rgba(192,132,252,.3);line-height:88px;text-align:center">\u2713</div>';
    }
    topRow.appendChild(se);
    var sp2 = document.createElement('div');
    sp2.style.flex = '1';
    topRow.appendChild(sp2);
    for (var f = 0; f < 4; f++) {
      var fe = document.createElement('div');
      fe.className = 'sol-pile-empty sol-pile-foundation';
      if (foundations[f] !== undefined) {
        var kc = document.createElement('div');
        kc.className = 'sol-card ' + (isRed(foundations[f]) ? 'red' : 'black');
        kc.innerHTML =
          '<div class="sol-card-rank">K</div><div class="sol-card-suit">' +
          foundations[f] +
          '</div><div class="sol-card-center">' +
          foundations[f] +
          '</div>';
        fe.appendChild(kc);
      } else {
        fe.innerHTML =
          '<div style="font-size:.9rem;color:rgba(192,132,252,.15);line-height:88px;text-align:center">\u2606</div>';
      }
      topRow.appendChild(fe);
    }
    table.appendChild(topRow);
    var tabRow = document.createElement('div');
    tabRow.className = 'sol-tableau';
    tabRow.style.gap = '6px';
    for (var t = 0; t < 7; t++)
      (function (ti) {
        var pe = document.createElement('div');
        pe.className = 'sol-tab-pile sol-pile';
        pe.style.width = '58px';
        pe.dataset.type = 'tableau';
        pe.dataset.idx = ti;
        pe.dataset.ci = 'empty';
        var scoTop = 0;
        tableau[ti].forEach(function (card, ci2) {
          var cel = card.faceUp ? makeCard(card) : makeFD();
          cel.dataset.type = 'tableau';
          cel.dataset.idx = ti;
          cel.dataset.ci = ci2;
          cel.style.cssText =
            'position:absolute;top:' + scoTop + 'px;z-index:' + (ci2 + 1) + ';width:58px';
          if (selected && selectedFrom && selectedFrom.idx === ti && ci2 >= selectedFrom.ci)
            cel.classList.add('selected');
          pe.appendChild(cel);
          scoTop += card.faceUp ? 28 : 14;
        });
        pe.style.height = Math.max(88, scoTop + 62) + 'px';
        tabRow.appendChild(pe);
      })(t);
    table.appendChild(tabRow);
  }
  // Drag & Drop
  function scoDragStart(e) {
    var el = e.target.closest('[data-type]');
    if (!el || el.dataset.type !== 'tableau') return;
    var idx = parseInt(el.dataset.idx) || 0,
      ci = el.dataset.ci;
    if (!ci || ci === 'empty') {
      e.preventDefault();
      return;
    }
    ci = parseInt(ci);
    if (!tableau[idx][ci] || !tableau[idx][ci].faceUp) {
      e.preventDefault();
      return;
    }
    selected = tableau[idx].slice(ci);
    selectedFrom = { idx: idx, ci: ci };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'sol');
    setTimeout(function () {
      render();
    }, 0);
  }
  function scoDragOver(e) {
    e.preventDefault();
    if (!selected) return;
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    var el = e.target.closest('[data-type="tableau"]');
    if (el) {
      var di = parseInt(el.dataset.idx) || 0;
      if (canPlace(selected[0], tableau[di])) {
        el.classList.add('sol-drop-hover');
        e.dataTransfer.dropEffect = 'move';
      } else e.dataTransfer.dropEffect = 'none';
    }
  }
  function scoDragLeave(e) {
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget))
      document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
        x.classList.remove('sol-drop-hover');
      });
  }
  function scoDrop(e) {
    e.preventDefault();
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    var el = e.target.closest('[data-type="tableau"]');
    if (!el || !selected) return;
    tryPlace(parseInt(el.dataset.idx) || 0);
  }
  function scoDragEnd(e) {
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    selected = null;
    selectedFrom = null;
    render();
  }
  // â”€â”€ Scorpion Hint System â”€â”€
  var scoHintTimer = null,
    scoHintIdx = 0;
  function scoClearHints() {
    clearTimeout(scoHintTimer);
    var t = document.getElementById('solTable');
    if (t)
      t.querySelectorAll('.sol-hint-src,.sol-hint-dst').forEach(function (x) {
        x.classList.remove('sol-hint-src', 'sol-hint-dst');
      });
  }
  function scoApplyHint(h) {
    var t = document.getElementById('solTable');
    if (!t) return;
    var srcEl = t.querySelector(
      '[data-type="tableau"][data-idx="' + h.si + '"][data-ci="' + h.sci + '"]'
    );
    var dstPile = tableau[h.di];
    var dstEl = dstPile.length
      ? t.querySelector(
          '[data-type="tableau"][data-idx="' + h.di + '"][data-ci="' + (dstPile.length - 1) + '"]'
        )
      : t.querySelector('.sol-tab-pile[data-idx="' + h.di + '"]');
    if (srcEl) srcEl.classList.add('sol-hint-src');
    if (dstEl) dstEl.classList.add('sol-hint-dst');
    scoHintTimer = setTimeout(scoClearHints, 2500);
  }
  function scoGetMoves() {
    var result = [];
    for (var si = 0; si < 7; si++) {
      var sp = tableau[si];
      for (var sci = 0; sci < sp.length; sci++) {
        if (!sp[sci].faceUp) continue;
        var seq = sp.slice(sci);
        for (var di = 0; di < 7; di++) {
          if (di === si) continue;
          if (!canPlace(seq[0], tableau[di])) continue;
          var score = 0;
          // Reveals face-down card
          if (sci > 0 && !sp[sci - 1].faceUp) score += 80;
          else if (sci === 0 && sp.length > 0) score += 40;
          // Entire sequence is same suit
          var sameSuit = seq.every(function (c) {
            return c.suit === seq[0].suit;
          });
          if (sameSuit) score += 30;
          // Destination is same suit (extending a run)
          if (tableau[di].length && tableau[di][tableau[di].length - 1].suit === seq[0].suit)
            score += 25;
          // Complete a Kâ†’A run?
          var destAfter = tableau[di].concat(seq);
          if (destAfter.length >= 13) {
            var base = destAfter.length - 13;
            if (destAfter[base].value === 13) {
              var rs = destAfter[base].suit,
                rok = true;
              for (var r = 0; r < 13; r++) {
                if (destAfter[base + r].suit !== rs || destAfter[base + r].value !== 13 - r) {
                  rok = false;
                  break;
                }
              }
              if (rok) score += 200;
            }
          }
          // Empty column: only worth it for kings
          if (!tableau[di].length) {
            if (seq[0].value === 13) score += 15;
            else score -= 20;
          }
          // Penalise breaking a same-suit run
          if (
            sci > 0 &&
            sp[sci - 1].faceUp &&
            sp[sci - 1].suit === sp[sci].suit &&
            sp[sci - 1].value === sp[sci].value + 1
          )
            score -= 25;
          score += seq.length * 2;
          result.push({ si: si, sci: sci, di: di, score: score });
        }
      }
    }
    result.sort(function (a, b) {
      return b.score - a.score;
    });
    return result;
  }
  function scoShowHint() {
    scoClearHints();
    var hints = scoGetMoves();
    if (hints.length) {
      scoApplyHint(hints[scoHintIdx % hints.length]);
      scoHintIdx++;
      return;
    }
    if (stock.length) {
      showToast('Deal from stock', 'No tableau moves \u2014 click the stock pile');
      var se = document.querySelector('#solTable [data-type="stock"]');
      if (se) {
        se.classList.add('sol-hint-src');
        scoHintTimer = setTimeout(scoClearHints, 2500);
      }
    } else {
      showToast('No moves', 'Stock empty and no moves \u2014 try New Game');
    }
  }
  window._scorpionCleanup = function () {
    var t = document.getElementById('solTable');
    if (!t) return;
    t.removeEventListener('dragstart', scoDragStart);
    t.removeEventListener('dragover', scoDragOver);
    t.removeEventListener('dragleave', scoDragLeave);
    t.removeEventListener('drop', scoDrop);
    t.removeEventListener('dragend', scoDragEnd);
    scoClearHints();
  };
  window._scorpionHC = function (type, idx, ci) {
    handleClick(type, idx, ci);
  };
  window._scorpionStart = function () {
    var table = document.getElementById('solTable');
    if (!table) return;
    document.getElementById('solGameTitle').textContent = 'Scorpion';
    var hb = document.getElementById('solitaireHint');
    if (hb) hb.style.display = '';
    scoHintIdx = 0;
    window._scorpionCleanup();
    table.addEventListener('dragstart', scoDragStart);
    table.addEventListener('dragover', scoDragOver);
    table.addEventListener('dragleave', scoDragLeave);
    table.addEventListener('drop', scoDrop);
    table.addEventListener('dragend', scoDragEnd);
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
  window._scorpionStop = function () {
    clearInterval(solTimer);
    scoClearHints();
  };
  window._scorpionUndo = undo;
  window._scorpionHint = scoShowHint;
  window._scorpionNewGame = function () {
    scoHintIdx = 0;
    window._scorpionStart();
  };
})();

