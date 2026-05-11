// â”€â”€ SPIDER SOLITAIRE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function () {
  var ALL_SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];
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
  var touchGhost = null,
    touchInfo = null,
    touchDragging = false,
    touchStartX = 0,
    touchStartY = 0,
    touchHandled = false;
  var suitMode = 1; // 1, 2, or 4 suits
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
  function buildDeck() {
    var suits =
      suitMode === 1
        ? ['\u2660', '\u2660', '\u2660', '\u2660']
        : suitMode === 2
          ? ['\u2660', '\u2665', '\u2660', '\u2665']
          : ALL_SUITS;
    var d = [];
    for (var k = 0; k < 2; k++)
      suits.forEach(function (s) {
        RANKS.forEach(function (r, i) {
          d.push(mk(s, r, i));
        });
      });
    return shuf(d);
  }
  function deal() {
    var d = buildDeck();
    tableau = [[], [], [], [], [], [], [], [], [], []];
    stock = [];
    foundations = [];
    var idx = 0;
    for (var c = 0; c < 10; c++) {
      var n = c < 4 ? 6 : 5;
      for (var i = 0; i < n; i++) {
        var card = d[idx++];
        card.faceUp = i === n - 1;
        tableau[c].push(card);
      }
    }
    while (idx < d.length) stock.push(d[idx++]);
    selected = null;
    selectedFrom = null;
    moves = 0;
    solSecs = 0;
    history = [];
    var nb = document.getElementById('solNoMovesBanner');
    if (nb) nb.style.display = 'none';
  }
  function isMoveSeq(col, ci) {
    var p = tableau[col];
    if (ci >= p.length || !p[ci].faceUp) return false;
    for (var i = ci; i < p.length - 1; i++) {
      if (p[i].suit !== p[i + 1].suit || p[i].value !== p[i + 1].value + 1) return false;
    }
    return true;
  }
  function canPlace(card, pile) {
    return (
      !pile.length ||
      (pile[pile.length - 1].faceUp && card.value === pile[pile.length - 1].value - 1)
    );
  }
  function checkRuns() {
    for (var t = 0; t < 10; t++) {
      var p = tableau[t];
      if (p.length < 13) continue;
      var top = p.length - 1,
        s = p[top - 12];
      if (s.value !== 13) continue;
      var suit = s.suit,
        ok = true;
      for (var i = 0; i < 13; i++) {
        if (
          !p[top - 12 + i].faceUp ||
          p[top - 12 + i].suit !== suit ||
          p[top - 12 + i].value !== 13 - i
        ) {
          ok = false;
          break;
        }
      }
      if (ok) {
        foundations.push(suit);
        tableau[t] = p.slice(0, top - 12);
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
    for (var t = 0; t < 10; t++) {
      if (!stock.length) break;
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
    if (foundations.length === 8) {
      clearInterval(solTimer);
      history = [];
      updUndo();
      setTimeout(function () {
        _solWinOverlay(moves, 'window._spiderNewGame');
      }, 300);
    }
  }
  function tryPlace(di) {
    if (!selected || !selected.length) return false;
    if (!canPlace(selected[0], tableau[di])) return false;
    save();
    tableau[selectedFrom.idx].splice(selectedFrom.ci);
    var sp2 = tableau[selectedFrom.idx];
    if (sp2.length && !sp2[sp2.length - 1].faceUp) sp2[sp2.length - 1].faceUp = true;
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
      } // same card: keep selected
      if (tryPlace(idx)) return;
      if (isMoveSeq(idx, ci)) {
        selected = pile.slice(ci);
        selectedFrom = { idx: idx, ci: ci };
        render();
        return;
      }
      selected = null;
      selectedFrom = null;
      render();
      return;
    }
    if (isMoveSeq(idx, ci)) {
      selected = pile.slice(ci);
      selectedFrom = { idx: idx, ci: ci };
      render();
    }
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
      lb.textContent = Math.ceil(stock.length / 10) + 'x';
      se.appendChild(lb);
    } else {
      se.innerHTML =
        '<div style="font-size:1rem;color:rgba(192,132,252,.3);line-height:88px;text-align:center">\u2713</div>';
    }
    topRow.appendChild(se);
    var sp = document.createElement('div');
    sp.style.flex = '1';
    topRow.appendChild(sp);
    for (var f = 0; f < 8; f++) {
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
    for (var t = 0; t < 10; t++)
      (function (ti) {
        var pe = document.createElement('div');
        pe.className = 'sol-tab-pile sol-pile';
        pe.style.width = '58px';
        pe.dataset.type = 'tableau';
        pe.dataset.idx = ti;
        pe.dataset.ci = 'empty';
        var spTop = 0;
        tableau[ti].forEach(function (card, ci2) {
          var cel = card.faceUp ? makeCard(card) : makeFD();
          cel.dataset.type = 'tableau';
          cel.dataset.idx = ti;
          cel.dataset.ci = ci2;
          cel.style.cssText =
            'position:absolute;top:' + spTop + 'px;z-index:' + (ci2 + 1) + ';width:58px';
          if (selected && selectedFrom && selectedFrom.idx === ti && ci2 >= selectedFrom.ci)
            cel.classList.add('selected');
          pe.appendChild(cel);
          spTop += card.faceUp ? 28 : 14;
        });
        pe.style.height = Math.max(88, spTop + 62) + 'px';
        tabRow.appendChild(pe);
      })(t);
    table.appendChild(tabRow);
  }
  // â”€â”€ Drag & Drop â”€â”€
  function onDragStart(e) {
    var el = e.target.closest('[data-type]');
    if (!el || el.dataset.type !== 'tableau') return;
    var idx = parseInt(el.dataset.idx) || 0,
      ci = el.dataset.ci;
    if (!ci || ci === 'empty') {
      e.preventDefault();
      return;
    }
    ci = parseInt(ci);
    if (!isMoveSeq(idx, ci)) {
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
  function onDragOver(e) {
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
  function onDragLeave(e) {
    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget))
      document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
        x.classList.remove('sol-drop-hover');
      });
  }
  function onDrop(e) {
    e.preventDefault();
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    var el = e.target.closest('[data-type="tableau"]');
    if (!el || !selected) return;
    tryPlace(parseInt(el.dataset.idx) || 0);
  }
  function onDragEnd(e) {
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    selected = null;
    selectedFrom = null;
    render();
  }
  // â”€â”€ Touch Drag â”€â”€
  function removeTG() {
    if (touchGhost) {
      touchGhost.remove();
      touchGhost = null;
    }
  }
  function onTS(e) {
    var el = e.target.closest('[data-type]');
    if (!el || el.dataset.type === 'stock') return;
    touchInfo = {
      type: el.dataset.type,
      idx: parseInt(el.dataset.idx) || 0,
      ci: el.dataset.ci === 'empty' ? undefined : el.dataset.ci
    };
    touchDragging = false;
    var t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }
  function onTM(e) {
    if (!touchInfo) return;
    var t = e.touches[0];
    if (
      !touchDragging &&
      Math.sqrt(Math.pow(t.clientX - touchStartX, 2) + Math.pow(t.clientY - touchStartY, 2)) < 10
    )
      return;
    if (!touchDragging) {
      touchDragging = true;
      var ti = touchInfo;
      if (ti.type === 'tableau' && ti.ci !== undefined) {
        var ci = parseInt(ti.ci);
        if (!isMoveSeq(ti.idx, ci)) {
          touchInfo = null;
          touchDragging = false;
          return;
        }
        selected = tableau[ti.idx].slice(ci);
        selectedFrom = { idx: ti.idx, ci: ci };
      } else {
        touchInfo = null;
        touchDragging = false;
        return;
      }
      var orig = e.target.closest('.sol-card');
      if (orig) {
        touchGhost = orig.cloneNode(true);
        touchGhost.style.cssText =
          'position:fixed;z-index:9999;pointer-events:none;opacity:.82;transform:rotate(4deg) scale(1.08);transition:none;width:58px;height:88px;border-radius:8px;';
        document.body.appendChild(touchGhost);
      }
      render();
    }
    e.preventDefault();
    if (touchGhost) {
      touchGhost.style.left = t.clientX - 29 + 'px';
      touchGhost.style.top = t.clientY - 50 + 'px';
    }
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    if (touchGhost) touchGhost.style.display = 'none';
    var under = document.elementFromPoint(t.clientX, t.clientY);
    if (touchGhost) touchGhost.style.display = '';
    if (under && selected) {
      var tEl = under.closest('[data-type="tableau"]');
      if (tEl && canPlace(selected[0], tableau[parseInt(tEl.dataset.idx) || 0]))
        tEl.classList.add('sol-drop-hover');
    }
  }
  function onTE(e) {
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    if (touchDragging) {
      var t = e.changedTouches[0];
      removeTG();
      var under = document.elementFromPoint(t.clientX, t.clientY);
      var placed = false;
      if (under && selected) {
        var tEl = under.closest('[data-type="tableau"]');
        if (tEl) placed = tryPlace(parseInt(tEl.dataset.idx) || 0);
      }
      if (!placed) {
        selected = null;
        selectedFrom = null;
        render();
      }
    } else if (touchInfo && !touchDragging) {
      touchHandled = true;
      setTimeout(function () {
        touchHandled = false;
      }, 400);
      handleClick(touchInfo.type, touchInfo.idx, touchInfo.ci);
    }
    touchInfo = null;
    touchDragging = false;
  }
  function spiderTC() {
    removeTG();
    selected = null;
    selectedFrom = null;
    touchInfo = null;
    touchDragging = false;
    render();
  }

  // â”€â”€ Hint System â”€â”€
  var spHintTimer = null,
    spHintIdx = 0;
  function spClearHints() {
    clearTimeout(spHintTimer);
    var t = document.getElementById('solTable');
    if (t)
      t.querySelectorAll('.sol-hint-src,.sol-hint-dst').forEach(function (x) {
        x.classList.remove('sol-hint-src', 'sol-hint-dst');
      });
  }
  function spApplyHint(h) {
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
    spHintTimer = setTimeout(spClearHints, 2500);
  }
  function spGetMoves() {
    var result = [];
    for (var si = 0; si < 10; si++) {
      var sp = tableau[si];
      // Find the highest face-up card that starts a valid moveable sequence
      for (var sci = 0; sci < sp.length; sci++) {
        if (!sp[sci].faceUp) continue;
        // Verify sequence from sci to end is a valid run (consecutive same suit or just consecutive)
        var seq = sp.slice(sci);
        var seqOk = true;
        for (var k = 1; k < seq.length; k++) {
          if (seq[k].value !== seq[k - 1].value - 1) {
            seqOk = false;
            break;
          }
        }
        if (!seqOk) continue;
        // Check each destination
        for (var di = 0; di < 10; di++) {
          if (di === si) continue;
          if (!canPlace(seq[0], tableau[di])) continue;
          // --- Score this move ---
          var score = 0;
          // 1. Does this complete a Kâ†’A same-suit run?
          var destAfter = tableau[di].concat(seq);
          if (destAfter.length >= 13) {
            var base = destAfter.length - 13;
            if (destAfter[base].value === 13) {
              var runSuit = destAfter[base].suit,
                runOk = true;
              for (var r = 0; r < 13; r++) {
                if (destAfter[base + r].suit !== runSuit || destAfter[base + r].value !== 13 - r) {
                  runOk = false;
                  break;
                }
              }
              if (runOk) score += 200;
            }
          }
          // 2. Reveals a face-down card?
          if (sci > 0 && !sp[sci - 1].faceUp) score += 80;
          else if (sci === 0 && sp.length > 0) score += 40; // clears whole column
          // 3. Entire moved sequence is same suit (keeps suits pure)
          var seqSameSuit = seq.every(function (c) {
            return c.suit === seq[0].suit;
          });
          if (seqSameSuit) score += 30;
          // 4. Destination top is same suit as seq bottom (extends same-suit run)
          if (
            tableau[di].length &&
            tableau[di][tableau[di].length - 1].suit === seq[seq.length - 1].suit
          )
            score += 20;
          // 5. Moving to empty column â€” only worth it for long sequences or kings
          if (!tableau[di].length) {
            if (seq[0].value === 13) score += 15;
            else score -= 20; // wasting empty column
          }
          // 6. Penalise breaking an existing same-suit run at source
          if (
            sci > 0 &&
            sp[sci - 1].faceUp &&
            sp[sci - 1].suit === sp[sci].suit &&
            sp[sci - 1].value === sp[sci].value + 1
          )
            score -= 25;
          // 7. Longer sequences are more valuable to place
          score += seq.length * 2;
          result.push({ si: si, sci: sci, di: di, score: score, seq: seq });
        }
      }
    }
    result.sort(function (a, b) {
      return b.score - a.score;
    });
    return result;
  }
  function spShowHint() {
    spClearHints();
    var hints = spGetMoves();
    if (hints.length) {
      spApplyHint(hints[spHintIdx % hints.length]);
      spHintIdx++;
      return;
    }
    // No tableau moves â€” suggest dealing from stock
    if (stock.length) {
      showToast('Deal from stock', 'No tableau moves \u2014 click the stock pile');
      var se = document.querySelector('#solTable [data-type="stock"]');
      if (se) {
        se.classList.add('sol-hint-src');
        spHintTimer = setTimeout(spClearHints, 2500);
      }
    } else {
      showToast('No moves', 'Stock is empty and no moves found \u2014 try New Game');
    }
  }
  window._spiderCleanup = function () {
    var t = document.getElementById('solTable');
    if (!t) return;
    t.removeEventListener('dragstart', onDragStart);
    t.removeEventListener('dragover', onDragOver);
    t.removeEventListener('dragleave', onDragLeave);
    t.removeEventListener('drop', onDrop);
    t.removeEventListener('dragend', onDragEnd);
    t.removeEventListener('touchstart', onTS);
    t.removeEventListener('touchmove', onTM);
    t.removeEventListener('touchend', onTE);
    t.removeEventListener('touchcancel', spiderTC);
  };
  window._spiderHC = function (type, idx, ci) {
    if (!touchHandled) handleClick(type, idx, ci);
  };
  window._spiderSetMode = function (n) {
    suitMode = n;
  };
  window._spiderStart = function () {
    var table = document.getElementById('solTable');
    if (!table) return;
    var titles = { 1: 'Spider â€” One Suit', 2: 'Spider â€” Two Suits', 4: 'Spider â€” Four Suits' };
    document.getElementById('solGameTitle').textContent = titles[suitMode] || 'Spider';
    var hb = document.getElementById('solitaireHint');
    if (hb) hb.style.display = '';
    spHintIdx = 0;
    window._spiderCleanup();
    table.addEventListener('dragstart', onDragStart);
    table.addEventListener('dragover', onDragOver);
    table.addEventListener('dragleave', onDragLeave);
    table.addEventListener('drop', onDrop);
    table.addEventListener('dragend', onDragEnd);
    table.addEventListener('touchstart', onTS, { passive: true });
    table.addEventListener('touchmove', onTM, { passive: false });
    table.addEventListener('touchend', onTE, { passive: true });
    table.addEventListener('touchcancel', spiderTC, { passive: true });
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
  window._spiderStop = function () {
    clearInterval(solTimer);
    removeTG();
    spClearHints();
  };
  window._spiderUndo = undo;
  window._spiderHint = spShowHint;
  window._spiderNewGame = function () {
    spHintIdx = 0;
    window._spiderStart();
  };
})();
