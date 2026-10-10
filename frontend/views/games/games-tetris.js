// ── TETRIS ────────────────────────────────────────────────────────────────
(function () {
  var COLS = 10,
    ROWS = 20,
    SZ = 22;
  var COLORS = ['', '#3b82f6', '#0ea5e9', '#60a5fa', '#34d399', '#f87171', '#60a5fa', '#fb923c'];
  var BASE_SHAPES = [
    null,
    [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ],
    [
      [2, 2],
      [2, 2]
    ],
    [
      [0, 3, 0],
      [3, 3, 3],
      [0, 0, 0]
    ],
    [
      [0, 4, 4],
      [4, 4, 0],
      [0, 0, 0]
    ],
    [
      [5, 5, 0],
      [0, 5, 5],
      [0, 0, 0]
    ],
    [
      [6, 0, 0],
      [6, 6, 6],
      [0, 0, 0]
    ],
    [
      [0, 0, 7],
      [7, 7, 7],
      [0, 0, 0]
    ]
  ];
  var SHAPES;
  var canvas, ctx, nextCanvas, nextCtx;
  var board, piece, pieceX, pieceY, nextPiece, score, level, startLevel, lines, timer, running;

  function cloneShapes() {
    return BASE_SHAPES.map(function (s) {
      return s
        ? s.map(function (r) {
            return r.slice();
          })
        : null;
    });
  }
  function newBoard() {
    return Array.from({ length: ROWS }, function () {
      return new Array(COLS).fill(0);
    });
  }
  function rand() {
    return Math.floor(Math.random() * 7) + 1;
  }

  function initCanvas() {
    canvas = document.getElementById('tetrisCanvas');
    ctx = canvas ? canvas.getContext('2d') : null;
    nextCanvas = document.getElementById('tetrisNext');
    nextCtx = nextCanvas ? nextCanvas.getContext('2d') : null;
    // Responsive: shrink cell size on narrow screens
    var maxW = Math.min(window.innerWidth - 60, 220); // 60px for stats + next cols
    SZ = Math.floor(Math.min(22, maxW / COLS));
    if (canvas) {
      canvas.width = COLS * SZ;
      canvas.height = ROWS * SZ;
    }
    var nsz = Math.max(14, Math.round(SZ * 0.82));
    var nw = nsz * 4 + 4;
    if (nextCanvas) {
      nextCanvas.width = nw;
      nextCanvas.height = nw;
    }
  }

  function spawn() {
    piece = nextPiece || rand();
    nextPiece = rand();
    pieceX = Math.floor((COLS - SHAPES[piece][0].length) / 2);
    pieceY = 0;
    if (collide(piece, pieceX, pieceY)) {
      endGame();
      return;
    }
    drawNext();
  }

  function collide(p, px, py) {
    var s = SHAPES[p];
    for (var r = 0; r < s.length; r++)
      for (var c = 0; c < s[r].length; c++) {
        if (!s[r][c]) continue;
        var nx = px + c,
          ny = py + r;
        if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
        if (ny >= 0 && board[ny][nx]) return true;
      }
    return false;
  }

  function merge() {
    var s = SHAPES[piece];
    for (var r = 0; r < s.length; r++)
      for (var c = 0; c < s[r].length; c++)
        if (s[r][c] && pieceY + r >= 0) board[pieceY + r][pieceX + c] = piece;
  }

  function clearLines() {
    var cleared = 0;
    for (var r = ROWS - 1; r >= 0; ) {
      if (
        board[r].every(function (v) {
          return v !== 0;
        })
      ) {
        board.splice(r, 1);
        board.unshift(new Array(COLS).fill(0));
        cleared++;
      } else r--;
    }
    if (!cleared) return;
    var pts = [0, 100, 300, 500, 800];
    score += (pts[cleared] || 800) * level;
    lines += cleared;
    level = startLevel + Math.floor(lines / 10);
    updateStats();
    clearInterval(timer);
    timer = setInterval(drop, Math.max(50, 800 - level * 65));
  }

  function updateStats() {
    document.getElementById('tetrisScore').textContent = score;
    document.getElementById('tetrisLevel').textContent = level;
    document.getElementById('tetrisLines').textContent = lines;
    var best = parseInt(localStorage.getItem('ss_tetris_best') || '0');
    if (score > best) {
      best = score;
      localStorage.setItem('ss_tetris_best', score);
      localStorage.setItem('ss_tetris_best_level', level);
    }
    document.getElementById('tetrisBest').textContent = best;
  }

  function drawBoard() {
    if (!ctx) return;
    ctx.fillStyle = '#08060f';
    ctx.fillRect(0, 0, COLS * SZ, ROWS * SZ);
    ctx.strokeStyle = 'rgba(255,255,255,.03)';
    ctx.lineWidth = 0.5;
    for (var c = 0; c <= COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * SZ, 0);
      ctx.lineTo(c * SZ, ROWS * SZ);
      ctx.stroke();
    }
    for (var r = 0; r <= ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * SZ);
      ctx.lineTo(COLS * SZ, r * SZ);
      ctx.stroke();
    }
    for (var rr = 0; rr < ROWS; rr++)
      for (var cc = 0; cc < COLS; cc++)
        if (board[rr][cc]) drawCell(ctx, cc, rr, COLORS[board[rr][cc]], 1);
    if (piece) {
      var gy = pieceY;
      while (!collide(piece, pieceX, gy + 1)) gy++;
      var gs = SHAPES[piece];
      for (var gr = 0; gr < gs.length; gr++)
        for (var gc = 0; gc < gs[gr].length; gc++)
          if (gs[gr][gc]) drawCell(ctx, pieceX + gc, gy + gr, COLORS[piece], 0.18);
      for (var r2 = 0; r2 < gs.length; r2++)
        for (var c2 = 0; c2 < gs[r2].length; c2++)
          if (gs[r2][c2]) drawCell(ctx, pieceX + c2, pieceY + r2, COLORS[piece], 1);
    }
  }

  function drawCell(c, x, y, color, alpha) {
    if (y < 0) return;
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.fillRect(x * SZ + 1, y * SZ + 1, SZ - 2, SZ - 2);
    c.fillStyle = 'rgba(255,255,255,.22)';
    c.fillRect(x * SZ + 2, y * SZ + 2, SZ - 4, 5);
    c.fillStyle = 'rgba(0,0,0,.2)';
    c.fillRect(x * SZ + 1, y * SZ + SZ - 5, SZ - 2, 4);
    c.globalAlpha = 1;
  }

  function drawNext() {
    if (!nextCtx || !nextPiece) return;
    var nsz = Math.max(14, Math.round(SZ * 0.82));
    var nw = nextCanvas ? nextCanvas.width : 88;
    nextCtx.fillStyle = '#08060f';
    nextCtx.fillRect(0, 0, nw, nw);
    var s = SHAPES[nextPiece],
      ox = Math.floor((nw - s[0].length * nsz) / 2),
      oy = Math.floor((nw - s.length * nsz) / 2);
    for (var r = 0; r < s.length; r++)
      for (var c = 0; c < s[r].length; c++)
        if (s[r][c]) {
          nextCtx.fillStyle = COLORS[nextPiece];
          nextCtx.fillRect(ox + c * nsz + 1, oy + r * nsz + 1, nsz - 2, nsz - 2);
          nextCtx.fillStyle = 'rgba(255,255,255,.2)';
          nextCtx.fillRect(ox + c * nsz + 2, oy + r * nsz + 2, nsz - 4, 4);
        }
  }

  function tryRotate() {
    var old = SHAPES[piece].map(function (r) {
      return r.slice();
    });
    var n = old[0].length,
      m = old.length;
    var rot = Array.from({ length: n }, function () {
      return new Array(m).fill(0);
    });
    for (var r = 0; r < m; r++) for (var c = 0; c < n; c++) rot[c][m - 1 - r] = old[r][c];
    SHAPES[piece] = rot;
    if (!collide(piece, pieceX, pieceY)) {
      drawBoard();
      return;
    }
    var kicks = [1, -1, 2, -2];
    for (var i = 0; i < kicks.length; i++)
      if (!collide(piece, pieceX + kicks[i], pieceY)) {
        pieceX += kicks[i];
        drawBoard();
        return;
      }
    SHAPES[piece] = old;
  }

  function drop() {
    if (!running) return;
    if (!collide(piece, pieceX, pieceY + 1)) pieceY++;
    else {
      merge();
      clearLines();
      spawn();
    }
    drawBoard();
  }

  function hardDrop() {
    if (!running) return;
    while (!collide(piece, pieceX, pieceY + 1)) pieceY++;
    merge();
    clearLines();
    spawn();
    drawBoard();
  }

  function endGame() {
    running = false;
    clearInterval(timer);
    document.getElementById('tetrisOverlayTitle').textContent = 'Game Over';
    document.getElementById('tetrisOverlaySub').textContent =
      'Score: ' + score + ' — Level: ' + level;
    document.getElementById('tetrisStartBtn').textContent = 'Play Again';
    document.getElementById('tetrisOverlay').style.display = 'flex';
  }

  window._tetrisStart = function (lvl) {
    initCanvas();
    SHAPES = cloneShapes();
    startLevel = lvl || 1;
    level = startLevel;
    score = 0;
    lines = 0;
    running = true;
    board = newBoard();
    nextPiece = rand();
    spawn();
    updateStats();
    document.getElementById('tetrisOverlay').style.display = 'none';
    document.getElementById('tetrisLevelBadge').textContent = 'Level ' + startLevel;
    clearInterval(timer);
    timer = setInterval(drop, Math.max(50, 800 - level * 65));
  };
  window._tetrisStop = function () {
    clearInterval(timer);
    running = false;
  };

  function tw(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }
  tw('tetrisStartBtn', function () {
    _tetrisStart(startLevel || 1);
  });
  tw('tCtrlLeft', function () {
    if (running && !collide(piece, pieceX - 1, pieceY)) {
      pieceX--;
      drawBoard();
    }
  });
  tw('tCtrlRight', function () {
    if (running && !collide(piece, pieceX + 1, pieceY)) {
      pieceX++;
      drawBoard();
    }
  });
  tw('tCtrlDown', function () {
    drop();
  });
  tw('tCtrlUp', function () {
    if (running) tryRotate();
  });
  tw('tCtrlDrop', function () {
    hardDrop();
  });

  // Tetris key handling — DAS (Delayed Auto Shift) + ARR (Auto Repeat Rate).
  //
  // The OS auto-repeat fires `keydown` events at its own rate (~30 Hz on
  // some Windows defaults, ~80+ Hz with accessibility tweaks, faster on
  // some Linux desktops). When ArrowDown / ArrowLeft / ArrowRight were
  // wired straight to drop()/move, the piece sped across the board at
  // whatever rate the user's OS happened to be set to — that's the
  // "tetris is too fast on some PCs" report.
  //
  // We now IGNORE every OS-repeat keydown (e.repeat === true) and run
  // our own auto-repeat: the move fires once immediately, waits DAS_MS,
  // then repeats every ARR_MS until the key is released. Rotate and hard
  // drop intentionally don't auto-repeat — they're single-shot actions.
  var DAS_MS = 170;    // delay before auto-shift kicks in
  var ARR_MS = 55;     // interval between repeats once auto-shifting
  var SOFT_DROP_MS = 50;
  var _keyTimers = {}; // key → { das, arr } setTimeout/setInterval ids

  function _stopKey(key) {
    var t = _keyTimers[key];
    if (!t) return;
    if (t.das) clearTimeout(t.das);
    if (t.arr) clearInterval(t.arr);
    delete _keyTimers[key];
  }
  function _startKey(key, fn, repeatMs) {
    _stopKey(key);
    fn();
    var t = { das: 0, arr: 0 };
    t.das = setTimeout(function () {
      t.arr = setInterval(function () {
        if (!_keyTimers[key]) return; // released between ticks
        fn();
      }, repeatMs);
    }, DAS_MS);
    _keyTimers[key] = t;
  }

  function _tetrisVisible() {
    var screen = document.getElementById('gamesPlayTetris');
    return screen && screen.style.display !== 'none';
  }

  document.addEventListener('keydown', function (e) {
    if (!_tetrisVisible() || !running) return;
    // Ignore OS-driven repeats — we run our own.
    if (e.repeat) {
      // Still preventDefault on arrow/space so the page doesn't scroll.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ') {
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      _startKey('ArrowLeft', function () {
        if (running && !collide(piece, pieceX - 1, pieceY)) {
          pieceX--;
          drawBoard();
        }
      }, ARR_MS);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      _startKey('ArrowRight', function () {
        if (running && !collide(piece, pieceX + 1, pieceY)) {
          pieceX++;
          drawBoard();
        }
      }, ARR_MS);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      _startKey('ArrowDown', function () {
        if (running) drop();
      }, SOFT_DROP_MS);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (running) tryRotate();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (running) hardDrop();
    }
  });

  document.addEventListener('keyup', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      _stopKey(e.key);
    }
  });

  // If the window loses focus while a key is held, the keyup never fires.
  // Stop every active auto-repeat so the piece doesn't keep sliding when
  // the user comes back.
  window.addEventListener('blur', function () {
    Object.keys(_keyTimers).forEach(_stopKey);
  });
})();
