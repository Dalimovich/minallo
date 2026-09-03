// -- SOLITAIRE VARIANT DISPATCHER -----------------------------------------
(function () {
  var currentVariant = null;
  var VARIANTS = {
    klondike: {
      start: function () {
        window._klondikeStart && _klondikeStart();
      },
      stop: function () {
        window._klondikeStop && _klondikeStop();
      },
      newGame: function () {
        window._klondikeNewGame && _klondikeNewGame();
      },
      undo: function () {
        window._klondikeUndo && _klondikeUndo();
      }
    },
    spider: {
      start: function () {
        window._spiderSetMode && _spiderSetMode(1);
        window._spiderStart && _spiderStart();
      },
      stop: function () {
        window._spiderStop && _spiderStop();
      },
      newGame: function () {
        window._spiderNewGame && _spiderNewGame();
      },
      undo: function () {
        window._spiderUndo && _spiderUndo();
      }
    },
    spider1: {
      start: function () {
        window._spiderSetMode && _spiderSetMode(1);
        window._spiderStart && _spiderStart();
      },
      stop: function () {
        window._spiderStop && _spiderStop();
      },
      newGame: function () {
        window._spiderNewGame && _spiderNewGame();
      },
      undo: function () {
        window._spiderUndo && _spiderUndo();
      }
    },
    spider2: {
      start: function () {
        window._spiderSetMode && _spiderSetMode(2);
        window._spiderStart && _spiderStart();
      },
      stop: function () {
        window._spiderStop && _spiderStop();
      },
      newGame: function () {
        window._spiderNewGame && _spiderNewGame();
      },
      undo: function () {
        window._spiderUndo && _spiderUndo();
      }
    },
    spider4: {
      start: function () {
        window._spiderSetMode && _spiderSetMode(4);
        window._spiderStart && _spiderStart();
      },
      stop: function () {
        window._spiderStop && _spiderStop();
      },
      newGame: function () {
        window._spiderNewGame && _spiderNewGame();
      },
      undo: function () {
        window._spiderUndo && _spiderUndo();
      }
    },
    scorpion: {
      start: function () {
        window._scorpionStart && _scorpionStart();
      },
      stop: function () {
        window._scorpionStop && _scorpionStop();
      },
      newGame: function () {
        window._scorpionNewGame && _scorpionNewGame();
      },
      undo: function () {
        window._scorpionUndo && _scorpionUndo();
      }
    },
    freecell: {
      start: function () {
        window._freecellStart && _freecellStart();
      },
      stop: function () {
        window._freecellStop && _freecellStop();
      },
      newGame: function () {
        window._freecellNewGame && _freecellNewGame();
      },
      undo: function () {
        window._freecellUndo && _freecellUndo();
      }
    },
    pyramid: {
      start: function () {
        window._pyramidStart && _pyramidStart();
      },
      stop: function () {
        window._pyramidStop && _pyramidStop();
      },
      newGame: function () {
        window._pyramidNewGame && _pyramidNewGame();
      },
      undo: function () {
        window._pyramidUndo && _pyramidUndo();
      }
    },
    tripeaks: {
      start: function () {
        window._tripeaksStart && _tripeaksStart();
      },
      stop: function () {
        window._tripeaksStop && _tripeaksStop();
      },
      newGame: function () {
        window._tripeaksNewGame && _tripeaksNewGame();
      },
      undo: function () {
        window._tripeaksUndo && _tripeaksUndo();
      }
    },
    vegas: {
      start: function () {
        window._vegasStart && _vegasStart();
      },
      stop: function () {
        window._vegasStop && _vegasStop();
      },
      newGame: function () {
        window._vegasNewGame && _vegasNewGame();
      },
      undo: function () {
        window._vegasUndo && _vegasUndo();
      }
    }
  };
  function stopCurrent() {
    if (currentVariant && VARIANTS[currentVariant]) VARIANTS[currentVariant].stop();
  }
  function hideAllPickers() {
    var ids = ['solVariantPicker', 'solSpiderPicker'];
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  }
  window._solShowPicker = function () {
    stopCurrent();
    currentVariant = null;
    hideAllPickers();
    var picker = document.getElementById('solVariantPicker'),
      area = document.getElementById('solGameArea');
    if (picker) picker.style.display = '';
    if (area) area.style.display = 'none';
    var table = document.getElementById('solTable');
    if (table) table.innerHTML = '';
  };
  window._solShowSpiderPicker = function () {
    hideAllPickers();
    var sp = document.getElementById('solSpiderPicker');
    if (sp) sp.style.display = '';
    var area = document.getElementById('solGameArea');
    if (area) area.style.display = 'none';
  };
  window._solStartVariant = function (v) {
    if (!VARIANTS[v]) return;
    stopCurrent();
    [
      window._klondikeCleanup,
      window._spiderCleanup,
      window._freecellCleanup,
      window._pyramidCleanup,
      window._tripeaksCleanup,
      window._scorpionCleanup,
      window._vegasCleanup
    ].forEach(function (fn) {
      if (typeof fn === 'function') fn();
    });
    currentVariant = v;
    hideAllPickers();
    var area = document.getElementById('solGameArea');
    if (area) area.style.display = '';
    VARIANTS[v].start();
  };
  window._solStart = function () {
    if (currentVariant) VARIANTS[currentVariant].start();
    else window._solShowPicker();
  };
  window._solStop = function () {
    stopCurrent();
  };
  // Picker/game-area UI wiring. Must run AFTER games.html has been injected
  // into #psec-games; games.js _init() calls this once the DOM is in place.
  // Idempotent: re-running it would double-bind listeners, so we guard with a flag.
  var _solUIWired = false;
  window._solInitUI = function () {
    if (_solUIWired) return;
    // Wire variant picker cards
    var grid = document.getElementById('solVariantPicker');
    if (grid) {
      grid.querySelectorAll('.sol-vc').forEach(function (el) {
        el.addEventListener('click', function () {
          if (el.id === 'solSpiderMenuBtn') {
            window._solShowSpiderPicker();
          } else {
            window._solStartVariant(el.dataset.variant);
          }
        });
      });
    }
    // Spider sub-picker
    var spGrid = document.getElementById('solSpiderPicker');
    if (spGrid) {
      spGrid.querySelectorAll('.sol-spc').forEach(function (el) {
        el.addEventListener('click', function () {
          window._solStartVariant(el.dataset.variant);
        });
      });
      var spBack = document.getElementById('solSpiderPickerBack');
      if (spBack)
        spBack.addEventListener('click', function () {
          window._solShowPicker();
        });
    }
    // Back button in picker → hub
    var pb = document.getElementById('solPickerBack');
    if (pb)
      pb.addEventListener('click', function () {
        var sga = document.getElementById('gamesPlaySolitaire');
        if (sga) sga.style.display = 'none';
        var hub = document.getElementById('gamesHub');
        if (hub) hub.style.display = '';
      });
    // Game area buttons
    var sng = document.getElementById('solitaireNewGame');
    if (sng)
      sng.addEventListener('click', function () {
        if (currentVariant && VARIANTS[currentVariant]) VARIANTS[currentVariant].newGame();
      });
    var snmb = document.getElementById('solNoMovesNewGame');
    if (snmb)
      snmb.addEventListener('click', function () {
        if (currentVariant && VARIANTS[currentVariant]) VARIANTS[currentVariant].newGame();
      });
    var sub = document.getElementById('solitaireUndo');
    if (sub) {
      sub.addEventListener('click', function () {
        if (currentVariant && VARIANTS[currentVariant]) VARIANTS[currentVariant].undo();
      });
      sub.disabled = true;
      sub.style.opacity = '.4';
    }
    var shb = document.getElementById('solitaireHint');
    if (shb)
      shb.addEventListener('click', function () {
        var hintFns = {
          klondike: window._klondikeHint,
          spider: window._spiderHint,
          spider1: window._spiderHint,
          spider2: window._spiderHint,
          spider4: window._spiderHint,
          scorpion: window._scorpionHint
        };
        var fn = hintFns[currentVariant];
        if (typeof fn === 'function') fn();
      });
    _solUIWired = true;
  };
  // Single capture-phase click dispatcher — fires before any element handlers, can't be double-called
  var _solLastClick = 0;
  document.addEventListener(
    'click',
    function (e) {
      if (!currentVariant) return;
      var now = Date.now();
      if (now - _solLastClick < 50) {
        return;
      }
      _solLastClick = now;
      var area = document.getElementById('solGameArea');
      if (!area || area.style.display === 'none') return;
      var table = document.getElementById('solTable');
      if (!table || !table.contains(e.target)) return;
      var el = e.target.closest('[data-type]');
      if (!el) return;
      var type = el.dataset.type,
        idx = parseInt(el.dataset.idx) || 0,
        ci = el.dataset.ci;
      var cardIdx = ci === undefined || ci === 'empty' ? undefined : parseInt(ci);
      var fn = {
        klondike: window._klondikeHC,
        spider: window._spiderHC,
        spider1: window._spiderHC,
        spider2: window._spiderHC,
        spider4: window._spiderHC,
        scorpion: window._scorpionHC,
        freecell: window._freecellHC,
        pyramid: window._pyramidHC,
        tripeaks: window._tripeaksHC,
        vegas: window._vegasHC
      }[currentVariant];
      if (fn) fn(type, idx, isNaN(cardIdx) ? undefined : cardIdx);
    },
    true
  );
  document.addEventListener(
    'dblclick',
    function (e) {
      if (!currentVariant) return;
      var area = document.getElementById('solGameArea');
      if (!area || area.style.display === 'none') return;
      var table = document.getElementById('solTable');
      if (!table || !table.contains(e.target)) return;
      var el = e.target.closest('[data-type]');
      if (!el) return;
      var type = el.dataset.type,
        idx = parseInt(el.dataset.idx) || 0;
      var fn = {
        klondike: window._klondikeDC,
        freecell: window._freecellDC,
        vegas: window._vegasDC
      }[currentVariant];
      if (fn) fn(type, idx);
    },
    true
  );
})();
