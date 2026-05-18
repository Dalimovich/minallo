(function () {
  var container = document.getElementById('psec-games');
  if (!container) return;
  fetch('views/games/games.html')
    .then(function (r) {
      return r.text();
    })
    .then(function (html) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      while (tmp.firstChild) container.appendChild(tmp.firstChild);
      _init();
    });
  function _init() {
    // ════════════════════════════════════════════════════════════════
    // GAMES
    // ════════════════════════════════════════════════════════════════
    (function () {
      function showHub() {
        [
          'gamesHub',
          'gamesTetrisLevels',
          'gamesPlayTetris',
          'gamesPlaySolitaire',
          'gamesPlayBird',
          'gamesPlayChess'
        ].forEach(function (id, i) {
          var el = document.getElementById(id);
          if (el) el.style.display = i === 0 ? '' : 'none';
        });
      }
      function showLevels() {
        document.getElementById('gamesHub').style.display = 'none';
        document.getElementById('gamesTetrisLevels').style.display = '';
        buildLevelGrid();
      }
      function showTetris(lvl) {
        document.getElementById('gamesTetrisLevels').style.display = 'none';
        document.getElementById('gamesPlayTetris').style.display = '';
        _tetrisStart(lvl);
      }
      function showSolitaire() {
        document.getElementById('gamesHub').style.display = 'none';
        document.getElementById('gamesPlaySolitaire').style.display = '';
        if (typeof _solShowPicker === 'function') _solShowPicker();
      }
      function showBird() {
        document.getElementById('gamesHub').style.display = 'none';
        document.getElementById('gamesPlayBird').style.display = '';
        _birdInit();
      }
      function showChess() {
        document.getElementById('gamesHub').style.display = 'none';
        document.getElementById('gamesPlayChess').style.display = '';
        _chessInit();
      }
      function buildLevelGrid() {
        var grid = document.getElementById('tetrisLevelGrid');
        if (!grid || grid.dataset.built) return;
        grid.dataset.built = '1';

        // Update best stats
        var best = localStorage.getItem('ss_tetris_best') || '—';
        var bestLvl = localStorage.getItem('ss_tetris_best_level') || '—';
        var bs = document.getElementById('lvlBestScore');
        if (bs) bs.textContent = best !== '—' ? parseInt(best).toLocaleString() : '—';
        var bl = document.getElementById('lvlBestLevel');
        if (bl) bl.textContent = bestLvl !== '—' ? 'Lvl ' + bestLvl : '—';

        var tiers = [
          {
            label: '🟣 Casual',
            color: 'rgba(59,130,246,.7)',
            levels: [
              { n: 1, label: 'Beginner', speed: 'Relaxed' },
              { n: 2, label: 'Easy', speed: 'Slow' }
            ]
          },
          {
            label: '🔴 Challenging',
            color: 'rgba(14,165,233,.7)',
            levels: [
              { n: 3, label: 'Normal', speed: 'Medium' },
              { n: 4, label: 'Steady', speed: 'Picking up' },
              { n: 5, label: 'Hard', speed: 'Fast' }
            ]
          },
          {
            label: '🟠 Expert',
            color: 'rgba(251,146,60,.7)',
            levels: [
              { n: 6, label: 'Intense', speed: 'Very fast' },
              { n: 7, label: 'Brutal', speed: 'Blazing' },
              { n: 8, label: 'Merciless', speed: 'Extreme' }
            ]
          },
          {
            label: '💀 Insane',
            color: 'rgba(248,113,113,.7)',
            levels: [
              { n: 9, label: 'Nightmare', speed: 'Inhuman' },
              { n: 10, label: 'INSANE', speed: 'MAX SPEED' }
            ]
          }
        ];

        tiers.forEach(function (tier) {
          var tierEl = document.createElement('div');
          tierEl.className = 'lvl-tier';
          var labelEl = document.createElement('div');
          labelEl.className = 'lvl-tier-label';
          labelEl.style.color = tier.color;
          labelEl.textContent = tier.label;
          tierEl.appendChild(labelEl);
          var row = document.createElement('div');
          row.className = 'lvl-tier-row';
          tier.levels.forEach(function (lvl) {
            var btn = document.createElement('div');
            btn.className = 'level-btn lvl-btn-' + lvl.n;
            btn.innerHTML =
              '<div class="level-btn-shine"></div><div class="level-btn-num">' +
              lvl.n +
              '</div><div class="level-btn-label">' +
              lvl.label +
              '</div><div class="level-btn-speed">' +
              lvl.speed +
              '</div>';
            (function (l) {
              btn.addEventListener('click', function () {
                showTetris(l);
              });
            })(lvl.n);
            row.appendChild(btn);
          });
          tierEl.appendChild(row);
          grid.appendChild(tierEl);
        });
      }

      function wire(id, fn) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
        else console.warn('Games: missing #' + id);
      }
      function trackAndRun(fn) {
        return function () {
          if (typeof window._statsTrackGame === 'function') window._statsTrackGame();
          fn();
        };
      }
      wire('gameCardTetris', trackAndRun(showLevels));
      wire('gameCardSolitaire', trackAndRun(showSolitaire));
      wire('gameCardBird', trackAndRun(showBird));
      wire('gameCardChess', trackAndRun(showChess));
      wire('tetrisLevelBack', showHub);
      wire('tetrisBack', function () {
        if (typeof _tetrisStop === 'function') _tetrisStop();
        document.getElementById('gamesPlayTetris').style.display = 'none';
        var g = document.getElementById('tetrisLevelGrid');
        if (g) g.dataset.built = '';
        showLevels();
      });
      wire('solitaireBack', function () {
        if (typeof _solStop === 'function') _solStop();
        if (typeof _solShowPicker === 'function') _solShowPicker();
        else showHub();
      });
      wire('birdBack', function () {
        if (typeof _birdStop === 'function') _birdStop();
        showHub();
      });
      wire('chessBack', function () {
        if (typeof _chessStop === 'function') _chessStop();
        showHub();
      });
    })();
  } // end _init
})();
