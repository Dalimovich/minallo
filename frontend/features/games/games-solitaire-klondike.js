// â”€â”€ SOLITAIRE (Klondike) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function () {
  var SUITS = ['\u2660', '\u2665', '\u2666', '\u2663']; // â™ â™¥â™¦â™£
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  var stock = [],
    waste = [],
    foundations = [[], [], [], []],
    tableau = [[], [], [], [], [], [], []];
  var selected = null,
    selectedFrom = null,
    moves = 0,
    solTimer = null,
    solSecs = 0;
  var touchGhost = null,
    touchInfo = null,
    touchDragging = false,
    touchStartX = 0,
    touchStartY = 0,
    touchHandled = false;
  var hintTimer = null,
    hintSeq = [],
    hintSeqIdx = 0;
  var history = []; // undo stack

  function isRed(s) {
    return s === '\u2665' || s === '\u2666';
  }

  // â”€â”€ Sound â”€â”€
  function playCardSound(type) {
    try {
      var ac = new (window.AudioContext || window.webkitAudioContext)();
      if (type === 'shuffle') {
        for (var b = 0; b < 8; b++)
          (function (bi) {
            setTimeout(function () {
              var buf = ac.createBuffer(1, ac.sampleRate * 0.06, ac.sampleRate),
                d = buf.getChannelData(0);
              for (var i = 0; i < d.length; i++)
                d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2) * 0.4;
              var src = ac.createBufferSource();
              src.buffer = buf;
              var f = ac.createBiquadFilter();
              f.type = 'bandpass';
              f.frequency.value = 3000 + Math.random() * 2000;
              f.Q.value = 0.5;
              var g = ac.createGain();
              g.gain.value = 0.35;
              src.connect(f);
              f.connect(g);
              g.connect(ac.destination);
              src.start();
            }, bi * 80);
          })(b);
      } else if (type === 'place') {
        var buf = ac.createBuffer(1, ac.sampleRate * 0.04, ac.sampleRate),
          d = buf.getChannelData(0);
        for (var i = 0; i < d.length; i++)
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3) * 0.5;
        var src = ac.createBufferSource();
        src.buffer = buf;
        var f = ac.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 1800;
        var g = ac.createGain();
        g.gain.value = 0.4;
        src.connect(f);
        f.connect(g);
        g.connect(ac.destination);
        src.start();
      } else if (type === 'flip') {
        var buf = ac.createBuffer(1, ac.sampleRate * 0.03, ac.sampleRate),
          d = buf.getChannelData(0);
        for (var i = 0; i < d.length; i++)
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2) * 0.3;
        var src = ac.createBufferSource();
        src.buffer = buf;
        var g = ac.createGain();
        g.gain.value = 0.3;
        src.connect(g);
        g.connect(ac.destination);
        src.start();
      } else if (type === 'win') {
        // Rising chime: 4 ascending tones
        var notes = [523, 659, 784, 1047];
        notes.forEach(function (freq, ni) {
          setTimeout(function () {
            var osc = ac.createOscillator(),
              g = ac.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            g.gain.setValueAtTime(0, ac.currentTime);
            g.gain.linearRampToValueAtTime(0.35, ac.currentTime + 0.04);
            g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.45);
            osc.connect(g);
            g.connect(ac.destination);
            osc.start();
            osc.stop(ac.currentTime + 0.5);
          }, ni * 130);
        });
      }
    } catch (e) {}
  }

  // â”€â”€ Deck / Deal â”€â”€
  function shuffle(d) {
    for (var i = d.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = d[i];
      d[i] = d[j];
      d[j] = t;
    }
    return d;
  }

  function buildDeck() {
    var d = [];
    SUITS.forEach(function (s) {
      RANKS.forEach(function (r, i) {
        d.push({ suit: s, rank: r, value: i + 1, faceUp: false });
      });
    });
    return shuffle(d);
  }

  // â”€â”€ Omniscient solver: checks if a deal is winnable with full card knowledge â”€â”€
  function quickSolvable(tab0, stk0) {
    try {
      // Encode cards as integers 0-51 (suit*13 + value-1)
      function sv(e) {
        return Math.floor(e / 13);
      }
      function vv(e) {
        return (e % 13) + 1;
      }
      function rv(e) {
        var s = sv(e);
        return s === 1 || s === 2;
      } // red: â™¥=1,â™¦=2

      var tab = tab0.map(function (p) {
        return p.map(function (c) {
          return SUITS.indexOf(c.suit) * 13 + (c.value - 1);
        });
      });
      var stk = stk0.map(function (c) {
        return SUITS.indexOf(c.suit) * 13 + (c.value - 1);
      });
      var wst = [];
      var fnd = [0, 0, 0, 0];

      var visited = new Set();
      var nodes = 0;
      var LIMIT = 60000; // per-attempt cap â€” fast enough, still catches most solvable deals
      var MAXDEPTH = 160; // prevent call-stack overflow

      function key() {
        // Lightweight key: foundation counts + tableau sizes/tops + stock length + waste top
        var k = fnd[0] + '' + fnd[1] + '' + fnd[2] + '' + fnd[3];
        for (var i = 0; i < 7; i++) {
          var p = tab[i];
          k += '|' + (p.length ? p[p.length - 1] : '-');
          // include buried cards' count so different hidden layouts aren't conflated
          k += ':' + p.length;
        }
        k += '|s' + stk.length + 'w' + (wst.length ? wst[wst.length - 1] : '-');
        return k;
      }

      function dfs(depth) {
        if (nodes++ > LIMIT || depth > MAXDEPTH) return false;
        if (fnd[0] + fnd[1] + fnd[2] + fnd[3] === 52) return true;
        var k = key();
        if (visited.has(k)) return false;
        visited.add(k);

        // Auto-play safe foundations first (deterministic, no branching needed)
        var changed = true;
        while (changed) {
          changed = false;
          if (wst.length) {
            var wc = wst[wst.length - 1];
            if (vv(wc) === fnd[sv(wc)] + 1) {
              wst.pop();
              fnd[sv(wc)]++;
              changed = true;
            }
          }
          for (var t = 0; t < 7; t++) {
            if (!tab[t].length) continue;
            var tc = tab[t][tab[t].length - 1];
            if (vv(tc) === fnd[sv(tc)] + 1) {
              tab[t].pop();
              fnd[sv(tc)]++;
              changed = true;
            }
          }
        }
        if (fnd[0] + fnd[1] + fnd[2] + fnd[3] === 52) return true;

        var mvs = [];

        // Tableau â†’ tableau
        for (var fr = 0; fr < 7; fr++) {
          if (!tab[fr].length) continue;
          var cs = tab[fr].length - 1;
          while (cs > 0) {
            var aa = tab[fr][cs - 1],
              bb = tab[fr][cs];
            if (vv(bb) === vv(aa) - 1 && rv(bb) !== rv(aa)) cs--;
            else break;
          }
          for (var ci2 = cs; ci2 < tab[fr].length; ci2++) {
            var card = tab[fr][ci2];
            for (var to2 = 0; to2 < 7; to2++) {
              if (fr === to2) continue;
              var ok = false;
              if (!tab[to2].length) ok = vv(card) === 13 && ci2 > 0;
              else {
                var tt2 = tab[to2][tab[to2].length - 1];
                ok = vv(card) === vv(tt2) - 1 && rv(card) !== rv(tt2);
              }
              if (ok) {
                var pr = (ci2 > 0 ? 40 : 15) + (tab[to2].length ? 10 : 0);
                mvs.push([pr, 2, fr, ci2, to2]);
              }
            }
          }
        }

        // Waste â†’ tableau
        if (wst.length) {
          var wc2 = wst[wst.length - 1];
          for (var to3 = 0; to3 < 7; to3++) {
            var ok = false;
            if (!tab[to3].length) ok = vv(wc2) === 13;
            else {
              var tt3 = tab[to3][tab[to3].length - 1];
              ok = vv(wc2) === vv(tt3) - 1 && rv(wc2) !== rv(tt3);
            }
            if (ok) mvs.push([tab[to3].length ? 25 : 4, 3, to3]);
          }
        }

        // Draw / recycle
        if (stk.length) mvs.push([2, 4]);
        else if (wst.length > 1) mvs.push([1, 5]);

        mvs.sort(function (a, b) {
          return b[0] - a[0];
        });

        for (var mi = 0; mi < mvs.length; mi++) {
          var mv = mvs[mi],
            type = mv[1];
          // Save/restore state for each branch
          var fndSnap = fnd.slice();
          var tabSnap = tab.map(function (p) {
            return p.slice();
          });
          var stkSnap = stk.slice();
          var wstSnap = wst.slice();

          if (type === 2) {
            var seq = tab[mv[2]].splice(mv[3]);
            tab[mv[4]] = tab[mv[4]].concat(seq);
          } else if (type === 3) {
            var c3 = wst.pop();
            tab[mv[2]].push(c3);
          } else if (type === 4) {
            wst.push(stk.pop());
          } else if (type === 5) {
            // recycle: wasteâ†’stock (draw-1: waste reversed becomes new stock)
            while (wst.length) stk.push(wst.pop());
          }

          if (dfs(depth + 1)) return true;

          // Restore
          fnd = fndSnap;
          tab = tabSnap;
          stk = stkSnap;
          wst = wstSnap;
        }
        return false;
      }
      return dfs(0);
    } catch (e) {
      return false;
    }
  }

  function deal() {
    // Try up to 50 shuffles; use first one the solver confirms is winnable
    var chosenTab = null,
      chosenStk = null;
    var deadline = Date.now() + 1800; // 1800 ms total budget
    for (var attempt = 0; attempt < 200; attempt++) {
      if (Date.now() > deadline) break;
      var deckD = buildDeck();
      var tabD = [[], [], [], [], [], [], []];
      var copyD = deckD.slice();
      for (var tD = 0; tD < 7; tD++)
        for (var cD = 0; cD <= tD; cD++) {
          var cardD = copyD.pop();
          cardD.faceUp = cD === tD;
          tabD[tD].push(cardD);
        }
      var stkD = copyD.slice();
      if (quickSolvable(tabD, stkD)) {
        chosenTab = tabD;
        chosenStk = stkD;
        break;
      }
    }
    if (!chosenTab) {
      var deckD = buildDeck();
      var tabD = [[], [], [], [], [], [], []];
      var copyD = deckD.slice();
      for (var tD = 0; tD < 7; tD++)
        for (var cD = 0; cD <= tD; cD++) {
          var cardD = copyD.pop();
          cardD.faceUp = cD === tD;
          tabD[tD].push(cardD);
        }
      chosenTab = tabD;
      chosenStk = copyD.slice();
    }
    stock = chosenStk;
    waste = [];
    foundations = [[], [], [], []];
    tableau = chosenTab;
    selected = null;
    selectedFrom = null;
    moves = 0;
    solSecs = 0;
    hintSeq = [];
    hintSeqIdx = 0;
    history = [];
    var nb = document.getElementById('solNoMovesBanner');
    if (nb) nb.style.display = 'none';
    document.getElementById('solMoves').textContent = '0';
    document.getElementById('solTime').textContent = '0:00';
    clearInterval(solTimer);
    solTimer = setInterval(function () {
      solSecs++;
      var m = Math.floor(solSecs / 60),
        s = solSecs % 60;
      document.getElementById('solTime').textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }, 1000);
  }

  // â”€â”€ Rules â”€â”€
  function canPlaceTab(card, pile) {
    if (!pile.length) return card.rank === 'K';
    var top = pile[pile.length - 1];
    return top.faceUp && card.value === top.value - 1 && isRed(card.suit) !== isRed(top.suit);
  }
  function canPlaceAnyFound(card) {
    for (var f = 0; f < 4; f++) if (canPlaceFound(card, foundations[f], f)) return f;
    return -1;
  }
  function canPlaceFound(card, pile, si) {
    if (card.suit !== SUITS[si]) return false;
    return pile.length === 0 ? card.rank === 'A' : card.value === pile[pile.length - 1].value + 1;
  }

  function checkWin() {
    if (
      foundations.every(function (f) {
        return f.length === 13;
      })
    ) {
      clearInterval(solTimer);
      history = [];
      updateUndoBtn();
      setTimeout(function () {
        _solWinOverlay(moves, 'window._klondikeNewGame');
      }, 300);
    }
  }

  // â”€â”€ Undo â”€â”€
  function cloneCard(c) {
    return { suit: c.suit, rank: c.rank, value: c.value, faceUp: c.faceUp };
  }
  function captureState() {
    return {
      stock: stock.map(cloneCard),
      waste: waste.map(cloneCard),
      foundations: foundations.map(function (f) {
        return f.map(cloneCard);
      }),
      tableau: tableau.map(function (p) {
        return p.map(cloneCard);
      }),
      moves: moves,
      solSecs: solSecs
    };
  }
  function saveHistory() {
    history.push(captureState());
    if (history.length > 200) history.shift();
    updateUndoBtn();
  }
  function updateUndoBtn() {
    var btn = document.getElementById('solitaireUndo');
    if (btn) {
      btn.disabled = !history.length;
      btn.style.opacity = history.length ? '1' : '.4';
    }
  }
  function undo() {
    if (!history.length) return;
    var prev = history.pop();
    stock = prev.stock;
    waste = prev.waste;
    foundations = prev.foundations;
    tableau = prev.tableau;
    moves = prev.moves;
    solSecs = prev.solSecs;
    selected = null;
    selectedFrom = null;
    document.getElementById('solMoves').textContent = moves;
    var m = Math.floor(solSecs / 60),
      s = solSecs % 60;
    document.getElementById('solTime').textContent = m + ':' + (s < 10 ? '0' : '') + s;
    updateUndoBtn();
    clearHints();
    render();
  }

  // â”€â”€ Auto-play safe cards to foundation â”€â”€
  // A card is "safe" when both opposite-color suits of value-1 are already on foundation
  // (meaning it can never be needed as a stepping stone on the tableau)
  function isSafeToFoundation(card) {
    if (card.value <= 2) return true; // Aces and 2s are always safe
    var needed = card.value - 1;
    var opposites = isRed(card.suit) ? ['\u2660', '\u2663'] : ['\u2665', '\u2666'];
    return opposites.every(function (os) {
      var fi = SUITS.indexOf(os);
      return fi >= 0 && foundations[fi].length >= needed;
    });
  }
  function autoPlaySafe() {
    var changed = true;
    while (changed) {
      changed = false;
      // Check waste
      if (waste.length && isSafeToFoundation(waste[waste.length - 1])) {
        var fi = canPlaceAnyFound(waste[waste.length - 1]);
        if (fi >= 0) {
          foundations[fi].push(waste.pop());
          moves++;
          changed = true;
          continue;
        }
      }
      // Check tableau tops
      for (var t = 0; t < 7; t++) {
        if (!tableau[t].length) continue;
        var top = tableau[t][tableau[t].length - 1];
        if (top.faceUp && isSafeToFoundation(top)) {
          var fi = canPlaceAnyFound(top);
          if (fi >= 0) {
            foundations[fi].push(tableau[t].pop());
            var tp = tableau[t];
            if (tp.length && !tp[tp.length - 1].faceUp) {
              tp[tp.length - 1].faceUp = true;
              playCardSound('flip');
            }
            moves++;
            changed = true;
            break;
          }
        }
      }
    }
  }

  // Auto-complete: when stock empty, waste empty, and all tableau face-up â†’ animate cards to foundations
  var _acRunning = false;
  function canAutoComplete() {
    if (_acRunning) return false;
    if (stock.length || waste.length) return false;
    var hasCard = false;
    for (var t = 0; t < 7; t++) {
      for (var c = 0; c < tableau[t].length; c++) {
        var card = tableau[t][c];
        if (!card.faceUp) return false; // hidden card â†’ not ready
        if (card.value < 10) return false; // card below 10 still on board â†’ not ready
        hasCard = true;
      }
    }
    return hasCard;
  }
  function tryAutoComplete() {
    if (_acRunning || !canAutoComplete()) return;
    _acRunning = true;
    function step() {
      // Find lowest-value moveable card across all tableau tops
      var best = null,
        bestT = -1,
        bestFi = -1;
      for (var t = 0; t < 7; t++) {
        if (!tableau[t].length) continue;
        var top = tableau[t][tableau[t].length - 1];
        var fi = canPlaceAnyFound(top);
        if (fi >= 0 && (!best || top.value < best.value)) {
          best = top;
          bestT = t;
          bestFi = fi;
        }
      }
      if (!best) {
        _acRunning = false;
        render();
        checkWin();
        return;
      }
      // Snap source card before removing
      var cols = document.querySelectorAll('#solTable .sol-tab-pile');
      var srcEl = cols[bestT]
        ? cols[bestT].querySelector('.sol-card:last-child') ||
          cols[bestT].querySelectorAll('.sol-card')[
            cols[bestT].querySelectorAll('.sol-card').length - 1
          ] ||
          null
        : null;
      var srcRect = srcEl ? srcEl.getBoundingClientRect() : null;
      // Move card to foundation
      foundations[bestFi].push(tableau[bestT].pop());
      moves++;
      document.getElementById('solMoves').textContent = moves;
      playCardSound('place');
      render();
      // Fly animation to foundation slot
      if (srcRect) {
        var fndEls = document.querySelectorAll('#solTable .sol-pile-foundation');
        var dstEl = fndEls[bestFi] || null;
        if (dstEl)
          _solFly(
            srcRect,
            best.rank + ' ' + best.suit,
            'sol-card ' + (isRed(best.suit) ? 'red' : 'black'),
            '#solTable .sol-pile-foundation[data-idx="' + bestFi + '"]',
            260
          );
      }
      setTimeout(step, 180);
    }
    setTimeout(step, 200);
  }

  function hasAnyMove() {
    // Any stock card to draw or waste to recycle?
    if (stock.length || waste.length > 1) return true;
    // Any wasteâ†’foundation or wasteâ†’tableau?
    if (waste.length) {
      var wc = waste[waste.length - 1];
      if (canPlaceAnyFound(wc) >= 0) return true;
      for (var t = 0; t < 7; t++) if (canPlaceTab(wc, tableau[t])) return true;
    }
    // Any tableau move?
    for (var ti = 0; ti < 7; ti++) {
      var pile = tableau[ti];
      if (!pile.length) continue;
      var top = pile[pile.length - 1];
      if (!top.faceUp) continue;
      if (canPlaceAnyFound(top) >= 0) return true;
      for (var ci = pile.length - 1; ci >= 0; ci--) {
        if (!pile[ci].faceUp) break;
        for (var tj = 0; tj < 7; tj++) {
          if (ti === tj) continue;
          if (canPlaceTab(pile[ci], tableau[tj])) return true;
        }
      }
    }
    return false;
  }

  function checkNoMoves() {
    if (
      foundations.every(function (f) {
        return f.length === 13;
      })
    )
      return; // already won
    if (hasAnyMove()) return;
    clearInterval(solTimer);
    var banner = document.getElementById('solNoMovesBanner');
    if (banner) banner.style.display = 'flex';
  }

  function afterMove() {
    document.getElementById('solMoves').textContent = moves;
    render();
    checkWin();
    checkNoMoves();
    tryAutoComplete();
  }

  function removeSelected() {
    if (!selectedFrom) return;
    if (selectedFrom.type === 'waste') waste.pop();
    else if (selectedFrom.type === 'tableau') {
      tableau[selectedFrom.idx].splice(selectedFrom.cardIdx);
      var tp = tableau[selectedFrom.idx];
      if (tp.length && !tp[tp.length - 1].faceUp) {
        tp[tp.length - 1].faceUp = true;
        playCardSound('flip');
      }
    }
  }

  function tryPlace(dstType, dstIdx) {
    if (!selected || !selected.length) return false;
    if (dstType === 'tableau') {
      if (canPlaceTab(selected[0], tableau[dstIdx])) {
        saveHistory();
        removeSelected();
        selected.forEach(function (c) {
          tableau[dstIdx].push(c);
        });
        moves++;
        playCardSound('place');
        selected = null;
        selectedFrom = null;
        afterMove();
        return true;
      }
    } else if (dstType === 'foundation' && selected.length === 1) {
      if (canPlaceFound(selected[0], foundations[dstIdx], dstIdx)) {
        saveHistory();
        removeSelected();
        foundations[dstIdx].push(selected[0]);
        moves++;
        playCardSound('place');
        selected = null;
        selectedFrom = null;
        afterMove();
        return true;
      }
    }
    return false;
  }

  // â”€â”€ Click handler â”€â”€
  function handleClick(type, idx, cardIdx) {
    clearHints();
    if (type === 'stock') {
      saveHistory();
      if (stock.length) {
        var c = stock.pop();
        c.faceUp = true;
        waste.push(c);
        playCardSound('place');
      } else {
        while (waste.length) {
          var wc = waste.pop();
          wc.faceUp = false;
          stock.push(wc);
        }
      }
      selected = null;
      selectedFrom = null;
      render();
      updateUndoBtn();
      return;
    }
    if (type === 'waste') {
      if (!waste.length) return;
      if (selected && selectedFrom && selectedFrom.type === 'waste') {
        selected = null;
        selectedFrom = null;
        render();
        return;
      }
      selected = [waste[waste.length - 1]];
      selectedFrom = { type: 'waste' };
      render();
      return;
    }
    if (type === 'foundation') {
      if (selected && selected.length === 1) {
        if (tryPlace('foundation', idx)) return;
      }
      selected = null;
      selectedFrom = null;
      render();
      return;
    }
    if (type === 'tableau') {
      var pile = tableau[idx];
      if (selected) {
        if (selectedFrom.type === 'tableau' && selectedFrom.idx === idx) {
          selected = null;
          selectedFrom = null;
          render();
          return;
        }
        if (tryPlace('tableau', idx)) return;
        if (cardIdx !== undefined && pile[cardIdx] && pile[cardIdx].faceUp) {
          selected = pile.slice(cardIdx);
          selectedFrom = { type: 'tableau', idx: idx, cardIdx: cardIdx };
          render();
          return;
        }
        selected = null;
        selectedFrom = null;
        render();
        return;
      }
      if (cardIdx === undefined || !pile[cardIdx] || !pile[cardIdx].faceUp) return;
      selected = pile.slice(cardIdx);
      selectedFrom = { type: 'tableau', idx: idx, cardIdx: cardIdx };
      render();
    }
  }

  // â”€â”€ Double-click: auto-move to foundation â”€â”€
  function handleDblClick(type, idx, cardIdx) {
    clearHints();
    var card = null;
    if (type === 'waste' && waste.length) card = waste[waste.length - 1];
    if (type === 'tableau' && tableau[idx].length) {
      var p = tableau[idx];
      if (cardIdx === p.length - 1 && p[cardIdx].faceUp) card = p[cardIdx];
    }
    if (!card) return;
    var fi = canPlaceAnyFound(card);
    if (fi < 0) return;
    saveHistory();
    if (type === 'waste') waste.pop();
    else {
      tableau[idx].pop();
      var tp = tableau[idx];
      if (tp.length && !tp[tp.length - 1].faceUp) tp[tp.length - 1].faceUp = true;
    }
    foundations[fi].push(card);
    moves++;
    playCardSound('place');
    selected = null;
    selectedFrom = null;
    afterMove();
  }

  // â”€â”€ Smart Hint System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns all playable moves from the current live state, scored by priority.
  // Scores:  foundation=100, reveals face-down=60+, tableau move=20, stock draw=5
  function getAllMoves(stk, wst, fnd, tab) {
    var moves = [];

    // Waste top card
    if (wst.length) {
      var wc = wst[wst.length - 1];
      var fi = canPlaceAnyFoundS(wc, fnd);
      if (fi >= 0)
        moves.push({
          type: 'move',
          srcType: 'waste',
          dstType: 'foundation',
          dstIdx: fi,
          score: 100
        });
      for (var t = 0; t < 7; t++)
        if (canPlaceTabS(wc, tab[t]))
          moves.push({ type: 'move', srcType: 'waste', dstType: 'tableau', dstIdx: t, score: 30 });
    }

    // Tableau
    for (var ti = 0; ti < 7; ti++) {
      var pile = tab[ti];
      if (!pile.length) continue;
      // Top card â†’ foundation
      var top = pile[pile.length - 1];
      if (top.faceUp) {
        var fi = canPlaceAnyFoundS(top, fnd);
        if (fi >= 0)
          moves.push({
            type: 'move',
            srcType: 'tableau',
            srcIdx: ti,
            srcCardIdx: pile.length - 1,
            dstType: 'foundation',
            dstIdx: fi,
            score: 100
          });
      }
      // Sequences â†’ other tableau piles
      for (var ci = 0; ci < pile.length; ci++) {
        if (!pile[ci].faceUp) continue;
        var seq = pile.slice(ci);
        for (var tj = 0; tj < 7; tj++) {
          if (ti === tj) continue;
          if (canPlaceTabS(seq[0], tab[tj])) {
            // Ignore moving a lone King to another empty pile â€” never helps
            if (seq[0].rank === 'K' && ci === 0 && !tab[tj].length) continue;
            // Bonus if this reveals a face-down card
            var revealsHidden = ci > 0 && !pile[ci - 1].faceUp ? 60 : 0;
            // Bonus if clearing the pile entirely (makes empty col)
            var clearsCol = ci === 0 && tab[tj].length > 0 ? 10 : 0;
            moves.push({
              type: 'move',
              srcType: 'tableau',
              srcIdx: ti,
              srcCardIdx: ci,
              dstType: 'tableau',
              dstIdx: tj,
              score: 20 + revealsHidden + clearsCol
            });
          }
        }
      }
    }

    // Sort best first
    moves.sort(function (a, b) {
      return b.score - a.score;
    });
    return moves;
  }

  function canPlaceTabS(card, pile) {
    if (!pile.length) return card.rank === 'K';
    var top = pile[pile.length - 1];
    return top.faceUp && card.value === top.value - 1 && isRed(card.suit) !== isRed(top.suit);
  }
  function canPlaceAnyFoundS(card, fnd) {
    for (var f = 0; f < 4; f++) {
      var p = fnd[f];
      if (card.suit !== SUITS[f]) continue;
      if (p.length === 0 ? card.rank === 'A' : card.value === p[p.length - 1].value + 1) return f;
    }
    return -1;
  }

  // Simulate cycling the stock to find the next playable card â€” returns draw-count or -1
  function stockSearchHint() {
    // Build a combined list: current waste (top=end) + stock (bottom-first)
    var combined = waste.slice().reverse().concat(stock.slice().reverse());
    // We'll simulate: each draw puts the top of combined into waste
    var simWaste = waste.slice(),
      simStock = stock.slice();
    var drawn = 0,
      maxDraws = combined.length + 1;
    while (drawn <= maxDraws) {
      // Check waste top
      if (simWaste.length) {
        var wc = simWaste[simWaste.length - 1];
        var fi = canPlaceAnyFoundS(wc, foundations);
        if (fi >= 0) return { draws: drawn, card: wc, targetType: 'foundation', targetIdx: fi };
        for (var t = 0; t < 7; t++)
          if (canPlaceTabS(wc, tableau[t]))
            return { draws: drawn, card: wc, targetType: 'tableau', targetIdx: t };
      }
      // Draw next from stock (or recycle)
      if (simStock.length) {
        var c = simStock.pop();
        c = Object.assign({}, c, { faceUp: true });
        simWaste.push(c);
        drawn++;
      } else if (simWaste.length) {
        simStock = simWaste
          .slice()
          .reverse()
          .map(function (x) {
            return Object.assign({}, x, { faceUp: false });
          });
        simWaste = [];
        drawn++;
      } else break;
    }
    return null; // truly no solution through stock
  }

  function clearHints() {
    clearTimeout(hintTimer);
    var table = document.getElementById('solTable');
    if (table)
      table.querySelectorAll('.sol-hint-src,.sol-hint-dst').forEach(function (x) {
        x.classList.remove('sol-hint-src', 'sol-hint-dst');
      });
  }

  function applyHintHighlight(hint) {
    if (!hint) return;
    var table = document.getElementById('solTable');
    if (!table) return;
    var srcEl = null,
      dstEl = null;
    if (hint.srcType === 'waste') srcEl = table.querySelector('[data-type="waste"] .sol-card');
    else if (hint.srcType === 'tableau')
      srcEl = table.querySelector(
        '[data-type="tableau"][data-idx="' + hint.srcIdx + '"][data-ci="' + hint.srcCardIdx + '"]'
      );
    if (hint.dstType === 'foundation')
      dstEl = table.querySelector('[data-type="foundation"][data-idx="' + hint.dstIdx + '"]');
    else if (hint.dstType === 'tableau') {
      var tp = tableau[hint.dstIdx];
      dstEl = tp.length
        ? table.querySelector(
            '[data-type="tableau"][data-idx="' +
              hint.dstIdx +
              '"][data-ci="' +
              (tp.length - 1) +
              '"]'
          )
        : table.querySelector('.sol-tab-pile[data-idx="' + hint.dstIdx + '"]');
    }
    if (srcEl) srcEl.classList.add('sol-hint-src');
    if (dstEl) dstEl.classList.add('sol-hint-dst');
    hintTimer = setTimeout(clearHints, 2500);
  }

  function showHint() {
    clearHints();
    var moves = getAllMoves(stock, waste, foundations, tableau);
    if (moves.length) {
      // Cycle through all available hints so repeated presses show different options
      var hint = moves[hintSeqIdx % moves.length];
      hintSeqIdx++;
      applyHintHighlight(hint);
      return;
    }
    // No direct moves â€” search through stock
    var stockHint = stockSearchHint();
    if (!stockHint) {
      // Truly stuck
      showToast('No moves left', 'No solution found \u2014 try a New Game');
      return;
    }
    if (stockHint.draws === 0) {
      // Waste top is playable â€” just highlight it
      var fi = canPlaceAnyFoundS(stockHint.card, foundations);
      var t = -1;
      if (fi < 0)
        for (var tj = 0; tj < 7; tj++)
          if (canPlaceTabS(stockHint.card, tableau[tj])) {
            t = tj;
            break;
          }
      applyHintHighlight({
        srcType: 'waste',
        dstType: fi >= 0 ? 'foundation' : 'tableau',
        dstIdx: fi >= 0 ? fi : t,
        srcIdx: 0,
        srcCardIdx: waste.length - 1
      });
      return;
    }
    // Need to draw from stock N times â€” auto-draw one step and re-highlight stock
    showToast(
      'Draw from stock',
      'Click the stock pile \u2014 ' +
        stockHint.draws +
        ' draw' +
        (stockHint.draws > 1 ? 's' : '') +
        ' needed'
    );
    var stockEl = document.querySelector('#solTable [data-type="stock"]');
    if (stockEl) {
      stockEl.classList.add('sol-hint-src');
      hintTimer = setTimeout(clearHints, 2500);
    }
  }

  // â”€â”€ HTML5 Drag & Drop â”€â”€
  function onDragStart(e) {
    var el = e.target.closest('[data-type]');
    if (!el) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0,
      ci = el.dataset.ci;
    var cardIdx = ci === 'empty' || ci === undefined ? undefined : parseInt(ci);
    if (type === 'waste' && waste.length) {
      selected = [waste[waste.length - 1]];
      selectedFrom = { type: 'waste' };
    } else if (type === 'tableau' && cardIdx !== undefined) {
      var pile = tableau[idx];
      if (!pile[cardIdx] || !pile[cardIdx].faceUp) {
        e.preventDefault();
        return;
      }
      selected = pile.slice(cardIdx);
      selectedFrom = { type: 'tableau', idx: idx, cardIdx: cardIdx };
    } else {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'sol');
    setTimeout(function () {
      el.style.opacity = '.4';
    }, 0);
  }

  function onDragOver(e) {
    e.preventDefault();
    var el = e.target.closest('[data-type]');
    if (!el || !selected) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0;
    var valid =
      (type === 'tableau' && canPlaceTab(selected[0], tableau[idx])) ||
      (type === 'foundation' &&
        selected.length === 1 &&
        canPlaceFound(selected[0], foundations[idx], idx));
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    if (valid) {
      el.classList.add('sol-drop-hover');
      e.dataTransfer.dropEffect = 'move';
    } else e.dataTransfer.dropEffect = 'none';
  }

  function onDragLeave(e) {
    var el = e.target.closest('[data-type]');
    if (el) el.classList.remove('sol-drop-hover');
  }

  function onDrop(e) {
    e.preventDefault();
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    var el = e.target.closest('[data-type]');
    if (!el || !selected) return;
    tryPlace(el.dataset.type, parseInt(el.dataset.idx) || 0);
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
  function removeTouchGhost() {
    if (touchGhost) {
      touchGhost.remove();
      touchGhost = null;
    }
  }

  function onTouchStart(e) {
    var el = e.target.closest('[data-type]');
    if (!el) return;
    var type = el.dataset.type,
      idx = parseInt(el.dataset.idx) || 0,
      ci = el.dataset.ci;
    var cardIdx = ci === 'empty' || ci === undefined ? undefined : parseInt(ci);
    if (type === 'stock') return;
    touchInfo = { type: type, idx: idx, cardIdx: cardIdx };
    touchDragging = false;
    var t = e.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;
  }

  function onTouchMove(e) {
    if (!touchInfo) return;
    var t = e.touches[0];
    var dx = t.clientX - touchStartX,
      dy = t.clientY - touchStartY;
    if (!touchDragging && Math.sqrt(dx * dx + dy * dy) < 10) return;
    if (!touchDragging) {
      touchDragging = true;
      var ti = touchInfo;
      if (ti.type === 'waste' && waste.length) {
        selected = [waste[waste.length - 1]];
        selectedFrom = { type: 'waste' };
      } else if (ti.type === 'tableau' && ti.cardIdx !== undefined) {
        var pile = tableau[ti.idx];
        if (!pile[ti.cardIdx] || !pile[ti.cardIdx].faceUp) {
          touchInfo = null;
          touchDragging = false;
          return;
        }
        selected = pile.slice(ti.cardIdx);
        selectedFrom = { type: 'tableau', idx: ti.idx, cardIdx: ti.cardIdx };
      } else {
        touchInfo = null;
        touchDragging = false;
        return;
      }
      var orig = e.target.closest('.sol-card');
      if (orig) {
        touchGhost = orig.cloneNode(true);
        touchGhost.style.cssText =
          'position:fixed;z-index:9999;pointer-events:none;opacity:.82;transform:rotate(4deg) scale(1.08);transition:none;width:62px;height:88px;border-radius:8px;';
        document.body.appendChild(touchGhost);
      }
      render();
    }
    e.preventDefault();
    if (touchGhost) {
      touchGhost.style.left = t.clientX - 31 + 'px';
      touchGhost.style.top = t.clientY - 50 + 'px';
    }
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    if (touchGhost) touchGhost.style.display = 'none';
    var under = document.elementFromPoint(t.clientX, t.clientY);
    if (touchGhost) touchGhost.style.display = '';
    if (under && selected) {
      var tEl = under.closest('[data-type]');
      if (tEl) {
        var tt = tEl.dataset.type,
          ti2 = parseInt(tEl.dataset.idx) || 0;
        var valid =
          (tt === 'tableau' && canPlaceTab(selected[0], tableau[ti2])) ||
          (tt === 'foundation' &&
            selected.length === 1 &&
            canPlaceFound(selected[0], foundations[ti2], ti2));
        if (valid) tEl.classList.add('sol-drop-hover');
      }
    }
  }

  function onTouchEnd(e) {
    document.querySelectorAll('.sol-drop-hover').forEach(function (x) {
      x.classList.remove('sol-drop-hover');
    });
    if (touchDragging) {
      var t = e.changedTouches[0];
      removeTouchGhost();
      var under = document.elementFromPoint(t.clientX, t.clientY);
      var placed = false;
      if (under && selected) {
        var tEl = under.closest('[data-type]');
        if (tEl) placed = tryPlace(tEl.dataset.type, parseInt(tEl.dataset.idx) || 0);
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
      handleClick(touchInfo.type, touchInfo.idx, touchInfo.cardIdx);
    }
    touchInfo = null;
    touchDragging = false;
  }

  // â”€â”€ Render â”€â”€
  function render(animate) {
    var table = document.getElementById('solTable');
    if (!table) return;
    table.innerHTML = '';
    var topRow = document.createElement('div');
    topRow.className = 'sol-top-row';

    // Stock
    var stockEl = makeEmpty();
    stockEl.style.cursor = 'pointer';
    stockEl.dataset.type = 'stock';
    stockEl.dataset.idx = '0';
    if (stock.length) {
      var fd = makeFaceDown();
      fd.dataset.type = 'stock';
      fd.dataset.idx = '0';
      stockEl.appendChild(fd);
    } else
      stockEl.innerHTML =
        '<div style="font-size:1.6rem;color:rgba(192,132,252,.35);line-height:88px;text-align:center">\u21BA</div>';
    topRow.appendChild(stockEl);

    // Waste
    var wasteEl = makeEmpty();
    wasteEl.dataset.type = 'waste';
    wasteEl.dataset.idx = '0';
    wasteEl.style.position = 'relative';
    var showCount = Math.min(3, waste.length);
    for (var wi = waste.length - showCount; wi < waste.length; wi++) {
      (function (wii, offset) {
        var wcard = waste[wii];
        var wel = makeCard(wcard);
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
          fEl.innerHTML = '';
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
        var klTop = 0;
        tableau[ti].forEach(function (card, ci) {
          var cel = card.faceUp ? makeCard(card) : makeFaceDown();
          cel.dataset.type = 'tableau';
          cel.dataset.idx = ti;
          cel.dataset.ci = ci;
          cel.style.position = 'absolute';
          cel.style.top = klTop + 'px';
          cel.style.zIndex = ci + 1;
          if (animate) {
            cel.style.animation = 'solDeal .25s ease both';
            cel.style.animationDelay = (ti * 3 + ci) * 0.04 + 's';
          }
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
          klTop += card.faceUp ? 28 : 14;
        });
        pileEl.style.height = Math.max(88, klTop + 62) + 'px';
        tabRow.appendChild(pileEl);
      })(t);
    table.appendChild(tabRow);
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
  function makeFaceDown() {
    var el = document.createElement('div');
    el.className = 'sol-card face-down';
    return el;
  }
  function makeEmpty() {
    var el = document.createElement('div');
    el.className = 'sol-pile-empty';
    return el;
  }

  function startWithShuffle() {
    deal();
    playCardSound('shuffle');
    var table = document.getElementById('solTable');
    if (table)
      table.innerHTML =
        '<div class="sol-shuffle-anim"><div class="sol-shuffle-deck"></div><div class="sol-shuffle-label">Shuffling\u2026</div></div>';
    setTimeout(function () {
      render(true);
    }, 700);
  }

  function klondikeTC() {
    removeTouchGhost();
    selected = null;
    selectedFrom = null;
    touchInfo = null;
    touchDragging = false;
    render();
  }
  window._klondikeCleanup = function () {
    var t = document.getElementById('solTable');
    if (!t) return;
    t.removeEventListener('dragstart', onDragStart);
    t.removeEventListener('dragover', onDragOver);
    t.removeEventListener('dragleave', onDragLeave);
    t.removeEventListener('drop', onDrop);
    t.removeEventListener('dragend', onDragEnd);
    t.removeEventListener('touchstart', onTouchStart);
    t.removeEventListener('touchmove', onTouchMove);
    t.removeEventListener('touchend', onTouchEnd);
    t.removeEventListener('touchcancel', klondikeTC);
  };
  window._klondikeHC = function (type, idx, ci) {
    if (!touchDragging) handleClick(type, idx, ci);
  };
  window._klondikeDC = function (type, idx, ci) {
    handleDblClick(type, idx, ci);
  };
  window._klondikeStart = function () {
    var table = document.getElementById('solTable');
    if (!table) return;
    document.getElementById('solGameTitle').textContent = 'Klondike';
    var hintBtn = document.getElementById('solitaireHint');
    if (hintBtn) hintBtn.style.display = '';
    window._klondikeCleanup();
    table.addEventListener('dragstart', onDragStart);
    table.addEventListener('dragover', onDragOver);
    table.addEventListener('dragleave', onDragLeave);
    table.addEventListener('drop', onDrop);
    table.addEventListener('dragend', onDragEnd);
    table.addEventListener('touchstart', onTouchStart, { passive: true });
    table.addEventListener('touchmove', onTouchMove, { passive: false });
    table.addEventListener('touchend', onTouchEnd, { passive: true });
    table.addEventListener('touchcancel', klondikeTC, { passive: true });
    startWithShuffle();
  };
  window._klondikeStop = function () {
    clearInterval(solTimer);
    removeTouchGhost();
  };
  window._klondikeUndo = undo;
  window._klondikeNewGame = function () {
    startWithShuffle();
  };
  window._klondikeHint = showHint;
})();

