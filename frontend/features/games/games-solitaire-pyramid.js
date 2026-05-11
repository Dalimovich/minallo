// â”€â”€ PYRAMID SOLITAIRE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function () {
  var SUITS = ['\u2660', '\u2665', '\u2666', '\u2663'];
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  // pyramid[i] = card or null; 28 slots, row r has indices sum(0..r-1) to sum(0..r)-1
  var pyramid = [],
    stock = [],
    waste = [],
    removed = [];
  var sel1 = null,
    moves = 0,
    solTimer = null,
    solSecs = 0,
    history = [];
  // Row r starts at index r*(r+1)/2... wait, row r has r+1 cards, starts at r*(r+1)/2 - no
  // Row 0: 1 card (index 0), row 1: 2 cards (1-2), row 2: 3 (3-5), ..., row 6: 7 (21-27)
  // Index in row r, col c: r*(r+1)/2 + c... wait r*(r+1)/2 for row r starting index
  // Row 0 start = 0, row 1 start = 1, row 2 start = 3, row 3 start = 6, row 4 = 10, row 5 = 15, row 6 = 21
  function rowStart(r) {
    return (r * (r + 1)) / 2;
  }
  // Card at (r,c) is covered by (r+1,c) and (r+1,c+1)
  function isCovered(idx) {
    // Find row and col
    var r = 0;
    while (rowStart(r + 1) <= idx) r++;
    var c = idx - rowStart(r);
    if (r === 6) return false; // bottom row, never covered
    var i1 = rowStart(r + 1) + c,
      i2 = rowStart(r + 1) + c + 1;
    return pyramid[i1] !== null || pyramid[i2] !== null;
  }
  function isUncovered(idx) {
    return pyramid[idx] !== null && !isCovered(idx);
  }
  function cardValue(card) {
    return card.value;
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

  // Greedy solver: returns number of moves to clear pyramid, or Infinity if stuck within limit
  function solverCanWin(pyr, stk) {
    var p = pyr.slice(),
      s = stk.slice().reverse(),
      w = [],
      m = 0,
      limit = 69;
    function rowStart2(r) {
      return (r * (r + 1)) / 2;
    }
    function isCov(idx, arr) {
      var r = 0;
      while (rowStart2(r + 1) <= idx) r++;
      var c = idx - rowStart2(r);
      if (r === 6) return false;
      var i1 = rowStart2(r + 1) + c,
        i2 = rowStart2(r + 1) + c + 1;
      return arr[i1] !== null || arr[i2] !== null;
    }
    function isUncov(idx, arr) {
      return arr[idx] !== null && !isCov(idx, arr);
    }
    function getUncov(arr) {
      var u = [];
      for (var i = 0; i < 28; i++) {
        if (isUncov(i, arr)) u.push(i);
      }
      return u;
    }
    function allGone(arr) {
      return arr.every(function (c) {
        return c === null;
      });
    }
    // Up to limit steps
    var cycleCheck = 0;
    while (m <= limit) {
      if (allGone(p)) return m;
      var u = getUncov(p);
      var moved = false;
      // Remove kings
      for (var i = 0; i < u.length; i++) {
        if (p[u[i]].value === 13) {
          p[u[i]] = null;
          m++;
          moved = true;
          break;
        }
      }
      if (moved) continue;
      // Remove waste king
      if (w.length && w[w.length - 1].value === 13) {
        w.pop();
        m++;
        continue;
      }
      // Find uncovered pair
      var uvals = {};
      for (var i = 0; i < u.length; i++) {
        var v = p[u[i]].value;
        if (uvals[13 - v] !== undefined) {
          p[u[i]] = null;
          p[uvals[13 - v]] = null;
          m++;
          moved = true;
          break;
        }
        uvals[v] = u[i];
      }
      if (moved) continue;
      // Waste + uncovered pair
      if (w.length) {
        var wv = w[w.length - 1].value;
        for (var i = 0; i < u.length; i++) {
          if (p[u[i]].value + wv === 13) {
            p[u[i]] = null;
            w.pop();
            m++;
            moved = true;
            break;
          }
        }
      }
      if (moved) continue;
      // Deal from stock
      if (s.length) {
        var c = s.pop();
        c.faceUp = true;
        w.push(c);
        m++;
      } else if (w.length) {
        // recycle once
        if (cycleCheck > 0) break;
        cycleCheck++;
        s = w.slice().reverse();
        w = [];
      } else break;
    }
    return allGone(p) ? m : Infinity;
  }

  function deal() {
    var d = [];
    SUITS.forEach(function (s) {
      RANKS.forEach(function (r, i) {
        d.push({ suit: s, rank: r, value: i + 1, faceUp: true });
      });
    });
    var attempts = 0;
    do {
      shuf(d);
      attempts++;
    } while (solverCanWin(d.slice(0, 28), d.slice(28)) > MAX_MOVES - 1 && attempts < 200);
    pyramid = d.slice(0, 28);
    stock = d.slice(28).reverse();
    waste = [];
    removed = [];
    sel1 = null;
    moves = 0;
    solSecs = 0;
    history = [];
    var nb = document.getElementById('solNoMovesBanner');
    if (nb) nb.style.display = 'none';
  }
  function isRed(s) {
    return s === '\u2665' || s === '\u2666';
  }
  function cloneCard(c) {
    return c ? { suit: c.suit, rank: c.rank, value: c.value, faceUp: c.faceUp } : null;
  }
  function save() {
    history.push({
      pyr: pyramid.map(cloneCard),
      stk: stock.map(cloneCard),
      wst: waste.map(cloneCard),
      rem: removed.slice(),
      mv: moves,
      sc: solSecs,
      s1: sel1
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
    pyramid = h.pyr;
    stock = h.stk;
    waste = h.wst;
    removed = h.rem;
    moves = h.mv;
    solSecs = h.sc;
    sel1 = h.s1;
    document.getElementById('solMoves').textContent = moves;
    updUndo();
    render();
  }
  var MAX_MOVES = 70;
  function hasAnyMove() {
    if (stock.length || waste.length) return true;
    var uncov = [];
    for (var i = 0; i < 28; i++) {
      if (pyramid[i] && isUncovered(i)) uncov.push(pyramid[i].value);
    }
    var wv = waste.length ? waste[waste.length - 1].value : null;
    for (var i = 0; i < uncov.length; i++) {
      if (uncov[i] === 13) return true;
    }
    if (wv === 13) return true;
    var seen = {};
    for (var i = 0; i < uncov.length; i++) {
      if (seen[13 - uncov[i]]) return true;
      seen[uncov[i]] = true;
    }
    if (wv !== null) {
      for (var i = 0; i < uncov.length; i++) {
        if (uncov[i] + wv === 13) return true;
      }
    }
    return false;
  }
  function afterMove() {
    document.getElementById('solMoves').textContent = moves;
    render();
    if (checkWin()) return;
    if (moves >= MAX_MOVES) {
      showGameOver('70-move limit reached');
      return;
    }
    if (!hasAnyMove()) {
      showGameOver('No moves remaining');
    }
  }
  function showGameOver(reason) {
    clearInterval(solTimer);
    var table = document.getElementById('solTable');
    if (!table) return;
    if (table.querySelector('.sol-gameover-overlay')) return;
    table.style.position = 'relative';
    var ov = document.createElement('div');
    ov.className = 'sol-gameover-overlay';
    ov.innerHTML =
      '<div class="sol-gameover-title">Game Over</div><div class="sol-gameover-sub">' +
      (reason || '') +
      '</div>';
    var newGameBtn = document.createElement('button');
    newGameBtn.className = 'sol-gameover-btn';
    newGameBtn.textContent = 'New Game';
    newGameBtn.addEventListener('click', function () {
      if (typeof window._pyramidNewGame === 'function') {
        window._pyramidNewGame();
      }
    });
    ov.appendChild(newGameBtn);
    table.appendChild(ov);
  }
  function checkWin() {
    if (
      pyramid.every(function (c) {
        return c === null;
      })
    ) {
      clearInterval(solTimer);
      history = [];
      updUndo();
      setTimeout(function () {
        _solWinOverlay(moves, 'window._pyramidNewGame');
      }, 300);
      return true;
    }
    return false;
  }
  function _pyrSnap(sel) {
    var e = document.querySelector(sel);
    return e ? { r: e.getBoundingClientRect(), h: e.innerHTML, c: e.className } : null;
  }
  function tryRemovePair(i1, i2) {
    var c1 = pyramid[i1],
      c2 = pyramid[i2];
    if (!c1 || !c2) return false;
    if (c1.value + c2.value !== 13) return false;
    if (i1 === i2) return false;
    // i1 (first selected) must have been uncovered; i2 may be covered by i1 only
    if (!isUncovered(i1)) return false;
    var s1 = _pyrSnap('#solTable [data-type="pyramid"][data-idx="' + i1 + '"]');
    var s2 = _pyrSnap('#solTable [data-type="pyramid"][data-idx="' + i2 + '"]');
    save();
    pyramid[i1] = null;
    pyramid[i2] = null;
    moves++;
    sel1 = null;
    afterMove();
    if (s1) _solFly(s1.r, s1.h, s1.c, null, 220);
    if (s2) _solFly(s2.r, s2.h, s2.c, null, 220);
    return true;
  }
  function tryRemoveKing(idx) {
    var c = pyramid[idx];
    if (!c || c.value !== 13 || !isUncovered(idx)) return false;
    var s = _pyrSnap('#solTable [data-type="pyramid"][data-idx="' + idx + '"]');
    save();
    pyramid[idx] = null;
    moves++;
    sel1 = null;
    afterMove();
    if (s) _solFly(s.r, s.h, s.c, null, 220);
    return true;
  }
  function tryRemoveWithWaste(pyrIdx) {
    var pc = pyramid[pyrIdx],
      wc = waste.length ? waste[waste.length - 1] : null;
    if (!pc || !wc) return false;
    if (pc.value + wc.value !== 13) return false;
    if (!isUncovered(pyrIdx)) return false;
    var sp = _pyrSnap('#solTable [data-type="pyramid"][data-idx="' + pyrIdx + '"]');
    var sw = _pyrSnap('#solTable [data-type="waste"]');
    save();
    pyramid[pyrIdx] = null;
    waste.pop();
    moves++;
    sel1 = null;
    afterMove();
    if (sp) _solFly(sp.r, sp.h, sp.c, null, 220);
    if (sw) _solFly(sw.r, sw.h, sw.c, null, 220);
    return true;
  }
  function tryRemoveWasteKing() {
    var wc = waste.length ? waste[waste.length - 1] : null;
    if (!wc || wc.value !== 13) return false;
    var sw = _pyrSnap('#solTable [data-type="waste"]');
    save();
    waste.pop();
    moves++;
    sel1 = null;
    afterMove();
    if (sw) _solFly(sw.r, sw.h, sw.c, null, 220);
    return true;
  }
  function handleClick(type, idx) {
    if (type === 'stock') {
      if (stock.length) {
        var ss = _pyrSnap('#solTable [data-type="stock"]');
        save();
        var c = stock.pop();
        c.faceUp = true;
        waste.push(c);
        sel1 = null;
        moves++;
        document.getElementById('solMoves').textContent = moves;
        render();
        if (moves >= MAX_MOVES) {
          showGameOver('70-move limit reached');
          return;
        }
        if (!hasAnyMove()) {
          showGameOver('No moves remaining');
          return;
        }
        if (ss) _solFly(ss.r, '', 'sol-card face-down', '#solTable [data-type="waste"]', 200);
        // Flip animation on the newly dealt waste card
        setTimeout(function () {
          var we2 = document.querySelector('#solTable [data-type="waste"] .sol-card');
          if (we2) {
            we2.classList.add('sol-flip-anim');
            setTimeout(function () {
              we2.classList.remove('sol-flip-anim');
            }, 400);
          }
        }, 50);
      } else if (waste.length) {
        save();
        while (waste.length) {
          var wc2 = waste.pop();
          wc2.faceUp = false;
          stock.push(wc2);
        }
        sel1 = null;
        document.getElementById('solMoves').textContent = moves;
        render();
      }
      return;
    }
    if (type === 'waste') {
      var wc = waste.length ? waste[waste.length - 1] : null;
      if (!wc) return;
      if (wc.value === 13) {
        tryRemoveWasteKing();
        return;
      }
      if (sel1 !== null && sel1.type === 'pyramid') {
        var pc = pyramid[sel1.idx];
        if (pc && pc.value + wc.value === 13 && isUncovered(sel1.idx)) {
          var sp2 = _pyrSnap('#solTable [data-type="pyramid"][data-idx="' + sel1.idx + '"]');
          var sw2 = _pyrSnap('#solTable [data-type="waste"]');
          save();
          pyramid[sel1.idx] = null;
          waste.pop();
          moves++;
          sel1 = null;
          afterMove();
          if (sp2) _solFly(sp2.r, sp2.h, sp2.c, null, 220);
          if (sw2) _solFly(sw2.r, sw2.h, sw2.c, null, 220);
          return;
        }
      }
      sel1 = { type: 'waste' };
      render();
      return;
    }
    if (type === 'pyramid') {
      var pc2 = pyramid[idx];
      if (!pc2) return;
      var uncovIdx = isUncovered(idx);
      // First selection: must be uncovered; Kings remove immediately
      if (sel1 === null) {
        if (!uncovIdx) return;
        if (pc2.value === 13) {
          tryRemoveKing(idx);
          return;
        }
        sel1 = { type: 'pyramid', idx: idx };
        render();
        return;
      }
      if (sel1.type === 'pyramid') {
        if (sel1.idx === idx) {
          sel1 = null;
          render();
          return;
        }
        // Try to pair â€” second card may be covered (relaxed rule for end-game)
        if (tryRemovePair(sel1.idx, idx)) return;
        // Not a valid pair â€” if uncovered, select it instead
        if (uncovIdx) {
          sel1 = { type: 'pyramid', idx: idx };
          render();
        }
        return;
      }
      if (sel1.type === 'waste') {
        var wc3 = waste.length ? waste[waste.length - 1] : null;
        if (wc3 && pc2.value + wc3.value === 13) {
          var sp3 = _pyrSnap('#solTable [data-type="pyramid"][data-idx="' + idx + '"]');
          var sw3 = _pyrSnap('#solTable [data-type="waste"]');
          save();
          pyramid[idx] = null;
          waste.pop();
          moves++;
          sel1 = null;
          afterMove();
          if (sp3) _solFly(sp3.r, sp3.h, sp3.c, null, 220);
          if (sw3) _solFly(sw3.r, sw3.h, sw3.c, null, 220);
          return;
        }
        if (uncovIdx) {
          sel1 = { type: 'pyramid', idx: idx };
          render();
        }
        return;
      }
    }
  }
  function isRed2(s) {
    return s === '\u2665' || s === '\u2666';
  }
  function makeCardEl(card, extraCls) {
    var el = document.createElement('div');
    el.className =
      'sol-card ' + (isRed2(card.suit) ? 'red' : 'black') + (extraCls ? ' ' + extraCls : '');
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
  function render() {
    var table = document.getElementById('solTable');
    if (!table) return;
    table.innerHTML = '';
    table.className = 'sol-table sol-pyramid-table';

    // â”€â”€ Outer layout: left panel + pyramid area â”€â”€
    var layout = document.createElement('div');
    layout.style.cssText = 'display:flex;gap:16px;align-items:flex-start;justify-content:center';

    // â”€â”€ Left panel: selected-card holder + removed count â”€â”€
    var leftPanel = document.createElement('div');
    leftPanel.style.cssText =
      'display:flex;flex-direction:column;align-items:center;gap:8px;min-width:70px;padding-top:4px';
    var holderLabel = document.createElement('div');
    holderLabel.style.cssText =
      'font-size:.65rem;color:rgba(192,132,252,.5);text-align:center;letter-spacing:.04em';
    holderLabel.textContent = 'HELD';
    var holder = document.createElement('div');
    holder.className = 'sol-pile-empty';
    holder.style.cssText = 'width:62px;height:88px;position:relative;';
    if (sel1 && sel1.type === 'pyramid' && pyramid[sel1.idx]) {
      var hc = makeCardEl(pyramid[sel1.idx], 'selected');
      hc.style.cssText = 'width:100%;cursor:pointer;';
      hc.onclick = function () {
        sel1 = null;
        render();
      };
      holder.appendChild(hc);
    } else if (sel1 && sel1.type === 'waste' && waste.length) {
      var hc2 = makeCardEl(waste[waste.length - 1], 'selected');
      hc2.style.cssText = 'width:100%;cursor:pointer;';
      hc2.onclick = function () {
        sel1 = null;
        render();
      };
      holder.appendChild(hc2);
    } else {
      holder.innerHTML =
        '<div style="font-size:1.4rem;line-height:88px;text-align:center;color:rgba(192,132,252,.15)">?</div>';
    }
    var removedCount = document.createElement('div');
    removedCount.style.cssText = 'font-size:.65rem;color:rgba(192,132,252,.4);text-align:center';
    var gone =
      28 -
      pyramid.filter(function (c) {
        return c !== null;
      }).length;
    removedCount.textContent = gone + ' removed';
    leftPanel.appendChild(holderLabel);
    leftPanel.appendChild(holder);
    leftPanel.appendChild(removedCount);
    layout.appendChild(leftPanel);

    // â”€â”€ Right: pyramid + bottom row â”€â”€
    var rightCol = document.createElement('div');
    rightCol.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px';

    var wrap = document.createElement('div');
    wrap.className = 'sol-pyramid-wrap';
    var CARD_W = 58,
      CARD_H = 82,
      COL_W = 62,
      ROW_H = 50;
    var totalW = 7 * COL_W;
    for (var r = 0; r < 7; r++) {
      var rowCards = r + 1;
      var rowLeft = Math.floor((totalW - rowCards * COL_W) / 2);
      for (var c = 0; c < rowCards; c++) {
        var idx2 = rowStart(r) + c;
        var card = pyramid[idx2];
        var el = document.createElement('div');
        el.style.cssText =
          'position:absolute;left:' +
          (rowLeft + c * COL_W) +
          'px;top:' +
          r * ROW_H +
          'px;width:' +
          CARD_W +
          'px';
        if (card) {
          var uncov = isUncovered(idx2);
          el.className = 'sol-card ' + (isRed2(card.suit) ? 'red' : 'black');
          var isSelected = sel1 && sel1.type === 'pyramid' && sel1.idx === idx2;
          var selCard = sel1 && sel1.type === 'pyramid' ? pyramid[sel1.idx] : null;
          var isPairWithSel = selCard && selCard.value + card.value === 13 && sel1.idx !== idx2;
          var wasteCard =
            sel1 && sel1.type === 'waste' && waste.length ? waste[waste.length - 1] : null;
          var isPairWithWaste = wasteCard && wasteCard.value + card.value === 13;
          if (isSelected) {
            el.classList.add('selected');
            el.style.transform = 'translateY(-6px)';
          } else if (isPairWithSel || isPairWithWaste) {
            el.classList.add('selected');
            el.style.opacity = '1';
          } else if (!uncov) {
            el.style.opacity = '.45';
            el.style.cursor = 'default';
          }
          // Clickable: always uncovered, OR covered but pairs with current selection
          if (uncov || (sel1 && (isPairWithSel || isPairWithWaste))) {
            (function (i2) {
              el.onclick = function () {
                handleClick('pyramid', i2);
              };
            })(idx2);
          }
          el.innerHTML =
            '<div class="sol-card-rank">' +
            card.rank +
            '</div><div class="sol-card-suit">' +
            card.suit +
            '</div><div class="sol-card-center">' +
            card.suit +
            '</div>';
          el.dataset.type = 'pyramid';
          el.dataset.idx = idx2;
        } else {
          el.className = 'sol-pyramid-empty';
        }
        wrap.appendChild(el);
      }
    }
    wrap.style.cssText =
      'position:relative;width:' + totalW + 'px;height:' + (7 * ROW_H + CARD_H) + 'px';
    rightCol.appendChild(wrap);

    // Stock + waste row
    var botRow = document.createElement('div');
    botRow.style.cssText = 'display:flex;gap:10px;align-items:flex-start';
    var se = document.createElement('div');
    se.className = 'sol-pile-empty';
    se.style.cursor = 'pointer';
    se.dataset.type = 'stock';
    se.dataset.idx = '0';
    se.onclick = function () {
      handleClick('stock', 0);
    };
    if (stock.length) {
      var fd = document.createElement('div');
      fd.className = 'sol-card face-down';
      se.appendChild(fd);
      var slbl = document.createElement('div');
      slbl.style.cssText =
        'text-align:center;font-size:.62rem;color:rgba(192,132,252,.45);margin-top:2px';
      slbl.textContent = stock.length + ' left';
      se.appendChild(slbl);
    } else {
      se.innerHTML =
        '<div style="font-size:1rem;color:rgba(192,132,252,.3);line-height:88px;text-align:center">\u21BA</div>';
    }
    botRow.appendChild(se);
    var we = document.createElement('div');
    we.className = 'sol-pile-empty';
    we.dataset.type = 'waste';
    we.dataset.idx = '0';
    we.onclick = function () {
      handleClick('waste', 0);
    };
    if (waste.length) {
      var wc4 = waste[waste.length - 1];
      var wcel = makeCardEl(wc4, sel1 && sel1.type === 'waste' ? 'selected' : '');
      if (sel1 && sel1.type === 'waste') wcel.style.transform = 'translateY(-6px)';
      wcel.dataset.type = 'waste';
      wcel.dataset.idx = '0';
      we.appendChild(wcel);
    } else {
      we.innerHTML =
        '<div style="font-size:.8rem;color:rgba(192,132,252,.2);line-height:88px;text-align:center">Waste</div>';
    }
    botRow.appendChild(we);
    rightCol.appendChild(botRow);
    layout.appendChild(rightCol);
    table.appendChild(layout);
  }
  window._pyramidCleanup = function () {};
  window._pyramidHC = function () {};
  window._pyramidStart = function () {
    var table = document.getElementById('solTable');
    if (!table) return;
    document.getElementById('solGameTitle').textContent = 'Pyramid';
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
  window._pyramidStop = function () {
    clearInterval(solTimer);
  };
  window._pyramidUndo = undo;
  window._pyramidNewGame = function () {
    window._pyramidStart();
  };
})();

