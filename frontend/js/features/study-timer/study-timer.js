var _stRunning = false;
var _stPaused = false;
var _stTimer = null;
var _stSecondsLeft = 0;
var _stPhase = 'focus';
var _stCycle = 0;
var _stSettings = { focus: 25, shortBreak: 5, longBreak: 15, cycles: 4 };
var _stTech = 'pomodoro';
var _stMusicEnabled = true;
var _stMusicMuted = false;
var _stYT = null;
var _stMusicSrc = 'lofi';

var _stPresets = {
  pomodoro: { focus: 25, shortBreak: 5, longBreak: 15, cycles: 4 },
  5217: { focus: 52, shortBreak: 17, longBreak: 30, cycles: 3 },
  9020: { focus: 90, shortBreak: 20, longBreak: 30, cycles: 2 },
  custom: null
};

var _ytPlayer = null;
var _ytPlayerReady = false;
var _ytPendingList = null;
var _ytProgressInterval = null;

function _stFmt(s) {
  var m = Math.floor(s / 60),
    sec = s % 60;
  return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
}

function _stLockGames(lock) {
  var g = document.getElementById('psbGames');
  if (!g) return;
  if (lock) g.classList.add('st-locked');
  else g.classList.remove('st-locked');
}

function _stEnsureYTApi(cb) {
  if (window.YT && window.YT.Player) {
    cb();
    return;
  }
  if (!window._ytCallbacks) window._ytCallbacks = [];
  window._ytCallbacks.push(cb);
  if (document.getElementById('ytApiScript')) return;
  var prevReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function () {
    if (prevReady) prevReady();
    var cbs = window._ytCallbacks || [];
    window._ytCallbacks = [];
    cbs.forEach(function (f) {
      try {
        f();
      } catch (e) {}
    });
  };
  var tag = document.createElement('script');
  tag.id = 'ytApiScript';
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

function _stCreatePlayer(customList) {
  var old = document.getElementById('stYTHolder');
  if (old) old.remove();
  _ytPlayer = null;
  _ytPlayerReady = false;

  var holder = document.createElement('div');
  holder.id = 'stYTHolder';
  holder.innerHTML =
    '<div id="stYTDiv" style="position:fixed;bottom:-9999px;left:-9999px;width:320px;height:180px;opacity:0;pointer-events:none"></div>' +
    '<div id="stMusicCard" class="st-music-card" style="display:none">' +
    '<div class="smc-header">' +
    '<button class="smc-btn smc-close" id="smcClose" title="Close">&#x2715;</button>' +
    '<div class="smc-art">&#x266B;</div>' +
    '<button class="smc-btn smc-min" id="smcMinimise" title="Minimise">&#x2012;</button>' +
    '</div>' +
    '<div class="smc-track">' +
    '<div class="smc-title" id="smcTitle">Study Music</div>' +
    '<div class="smc-artist" id="smcArtist"></div>' +
    '</div>' +
    '<div class="smc-progress-wrap">' +
    '<input type="range" id="smcProgress" class="smc-progress-range" min="0" max="100" value="0" step="0.1">' +
    '<div class="smc-time-row"><span id="smcCurrent">0:00</span><span id="smcDuration">0:00</span></div>' +
    '</div>' +
    '<div class="smc-controls">' +
    '<button class="smc-ctrl" id="stMiniPrev" title="Previous">&#x23EE;</button>' +
    '<button class="smc-ctrl smc-play" id="stMiniPlayPause" title="Play/Pause">&#x25B6;</button>' +
    '<button class="smc-ctrl" id="stMiniNext" title="Next">&#x23ED;</button>' +
    '</div>' +
    '</div>' +
    '<button class="st-music-pill" id="stMusicPill" title="Show music player" style="display:none">&#x266B;</button>';
  document.body.appendChild(holder);

  if (!document.getElementById('stBarKf')) {
    var s = document.createElement('style');
    s.id = 'stBarKf';
    s.textContent =
      '@keyframes smcIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}' +
      '@keyframes smcOut{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(12px)}}';
    document.head.appendChild(s);
  }

  document.getElementById('smcClose').addEventListener('click', function () {
    _stStopMusic();
  });
  document.getElementById('smcMinimise').addEventListener('click', function () {
    document.getElementById('stMusicCard').style.display = 'none';
    document.getElementById('stMusicPill').style.display = 'flex';
  });
  document.getElementById('stMusicPill').addEventListener('click', function () {
    document.getElementById('stMusicPill').style.display = 'none';
    document.getElementById('stMusicCard').style.display = 'flex';
  });

  var _smcSeeking = false;
  document.getElementById('smcProgress').addEventListener('mousedown', function () {
    _smcSeeking = true;
  });
  document.getElementById('smcProgress').addEventListener(
    'touchstart',
    function () {
      _smcSeeking = true;
    },
    { passive: true }
  );
  document.getElementById('smcProgress').addEventListener('change', function () {
    _smcSeeking = false;
    try {
      var dur = _ytPlayer.getDuration();
      if (dur > 0) _ytPlayer.seekTo(dur * (this.value / 100), true);
    } catch (e) {}
  });

  var playerVars = {
    autoplay: 1,
    controls: 0,
    modestbranding: 1,
    rel: 0,
    fs: 0,
    enablejsapi: 1,
    mute: 1,
    origin: window.location.origin
  };
  var playerCfg = {
    height: '180',
    width: '320',
    host: 'https://www.youtube-nocookie.com',
    playerVars: playerVars
  };
  if (customList) {
    playerVars.listType = 'playlist';
    playerVars.list = customList;
  } else {
    playerVars.loop = 1;
    playerVars.playlist = 'jfKfPfyJRdk';
    playerCfg.videoId = 'jfKfPfyJRdk';
  }

  playerCfg.events = {
    onReady: function (e) {
      _ytPlayerReady = true;
      if (_ytPendingList) {
        e.target.loadPlaylist({
          listType: 'playlist',
          list: _ytPendingList,
          index: 0,
          startSeconds: 0
        });
        _ytPendingList = null;
      }
      e.target.playVideo();
      setTimeout(function () {
        try {
          e.target.unMute();
          e.target.setVolume(70);
        } catch (er) {}
      }, 1500);
      _stShowMusicControls(true);
      if (_ytProgressInterval) clearInterval(_ytProgressInterval);
      _ytProgressInterval = setInterval(function () {
        if (!_ytPlayer || _smcSeeking) return;
        try {
          var cur = _ytPlayer.getCurrentTime() || 0;
          var dur = _ytPlayer.getDuration() || 0;
          var range = document.getElementById('smcProgress');
          var curEl = document.getElementById('smcCurrent');
          var durEl = document.getElementById('smcDuration');
          if (range && dur > 0) range.value = (cur / dur) * 100;
          function fmt(s) {
            s = Math.floor(s);
            return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
          }
          if (curEl) curEl.textContent = fmt(cur);
          if (durEl) durEl.textContent = fmt(dur);
          if (range && dur > 0) range.style.setProperty('--pct', (cur / dur) * 100 + '%');
        } catch (er) {}
      }, 1000);
    },
    onStateChange: function (e) {
      var ppBtn = document.getElementById('stMiniPlayPause');
      if (ppBtn) ppBtn.innerHTML = e.data === 1 ? '&#x23F8;' : '&#x25B6;';
      if (e.data === 1) {
        try {
          var vd = e.target.getVideoData();
          var t = document.getElementById('smcTitle');
          var a = document.getElementById('smcArtist');
          if (t && vd.title) t.textContent = vd.title;
          if (a && vd.author) a.textContent = vd.author;
        } catch (er) {}
      }
      if (e.data === 0) {
        try {
          if (customList) {
            var idx = e.target.getPlaylistIndex();
            var total = (e.target.getPlaylist() || []).length;
            if (total > 0 && idx >= total - 1) e.target.playVideoAt(0);
            else e.target.nextVideo();
          } else {
            e.target.playVideo();
          }
        } catch (err) {}
      }
    },
    onError: function (e) {
      setTimeout(function () {
        try {
          e.target.nextVideo();
        } catch (err) {}
      }, 500);
    }
  };
  _ytPlayer = new YT.Player('stYTDiv', playerCfg);
}

function _stPlayMusic() {
  if (!_stMusicEnabled || _stMusicMuted) return;
  if (_stMusicSrc === 'none') return;
  if (_stMusicSrc === 'spotify') {
    if (window._spIsConnected && window._spIsConnected()) {
      window.showToast('Spotify', 'Resuming your Spotify playback');
      if (window._spPlayResume) window._spPlayResume();
    } else {
      window.showToast('Spotify not connected', 'Connect Spotify in Settings → Music Services');
    }
    return;
  }
  var customList =
    _stMusicSrc === 'youtube' && window._getMusicPlaylistId ? window._getMusicPlaylistId() : null;
  if (_ytPlayer && _ytPlayerReady) {
    try {
      _ytPlayer.playVideo();
      _ytPlayer.unMute();
      _ytPlayer.setVolume(70);
      _stShowMusicControls(true);
      return;
    } catch (e) {
      _stStopMusic();
    }
  }
  if (_ytPlayer && !_ytPlayerReady) {
    _ytPendingList = customList;
    return;
  }
  _ytPendingList = customList;
  _stEnsureYTApi(function () {
    _stCreatePlayer(customList);
  });
}

function _stStopMusic() {
  _stShowMusicControls(false);
  if (_ytProgressInterval) {
    clearInterval(_ytProgressInterval);
    _ytProgressInterval = null;
  }
  if (_ytPlayer) {
    try {
      _ytPlayer.stopVideo();
      _ytPlayer.destroy();
    } catch (e) {}
    _ytPlayer = null;
    _ytPlayerReady = false;
    _ytPendingList = null;
  }
  var holder = document.getElementById('stYTHolder');
  if (holder) holder.remove();
}

function _stShowMusicControls(show) {
  var holder = document.getElementById('stYTHolder');
  if (!holder) return;
  if (show) {
    var pill = document.getElementById('stMusicPill');
    var card = document.getElementById('stMusicCard');
    if (pill && pill.style.display === 'flex') {
      /* already collapsed */
    } else if (card) {
      card.style.display = 'flex';
    }
  } else {
    var card2 = document.getElementById('stMusicCard');
    var pill2 = document.getElementById('stMusicPill');
    if (card2) card2.style.display = 'none';
    if (pill2) pill2.style.display = 'none';
  }
}

function _stToggleMusic() {
  _stMusicMuted = !_stMusicMuted;
  if (_stMusicMuted) {
    try {
      if (_ytPlayer) _ytPlayer.pauseVideo();
    } catch (e) {}
    _stShowMusicControls(false);
  } else {
    _stPlayMusic();
  }
}

function _stUpdateMini() {
  var t = document.getElementById('stMiniTime');
  var l = document.getElementById('stMiniLabel');
  if (t) t.textContent = _stFmt(_stSecondsLeft);
  if (l)
    l.textContent =
      _stPhase === 'focus' ? 'Focus' : _stPhase === 'short' ? 'Short break' : 'Long break';
}

function _stUpdatePauseBtn() {
  var btn = document.getElementById('stMiniPause');
  if (btn) btn.innerHTML = _stPaused ? '&#x25B6;' : '&#x23F8;';
}

function _stShowDonePopup(isBreakEnd) {
  clearInterval(_stTimer);
  var mini = document.getElementById('stMiniTimer');
  if (mini) mini.style.display = 'none';
  var existing = document.getElementById('stDoneOverlay');
  if (existing) existing.remove();

  var nextBreakMin =
    _stCycle + 1 >= _stSettings.cycles ? _stSettings.longBreak : _stSettings.shortBreak;
  var title = isBreakEnd ? 'Break over — ready to focus again?' : "You've done it! 🎉";
  var sub = isBreakEnd
    ? "Your break has ended. Start another focus session whenever you're ready."
    : 'Great work! Take a ' +
      (_stCycle + 1 >= _stSettings.cycles
        ? _stSettings.longBreak + ' min long break'
        : _stSettings.shortBreak + ' min short break') +
      '. Play some games, stretch, or just relax.';
  var breakLabel = isBreakEnd
    ? 'Start Focus'
    : 'Take a Break (' +
      (_stCycle + 1 >= _stSettings.cycles ? _stSettings.longBreak : _stSettings.shortBreak) +
      ' min)';

  var el = document.createElement('div');
  el.id = 'stDoneOverlay';
  el.innerHTML =
    '<div class="st-done-popup" id="stDonePopup">' +
    '<div class="st-done-emoji">' +
    (isBreakEnd ? '⏰' : '🎉') +
    '</div>' +
    '<div class="st-done-title">' +
    title +
    '</div>' +
    '<div class="st-done-sub">' +
    sub +
    '</div>' +
    '<div class="st-done-actions">' +
    '<button class="st-done-btn st-done-primary" id="stDoneBreak">' +
    breakLabel +
    '</button>' +
    '<button class="st-done-btn st-done-secondary" id="stDoneRestart">Start Again</button>' +
    '</div>' +
    '</div>';
  el.style.cssText =
    'position:fixed;inset:0;z-index:4100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);backdrop-filter:blur(4px)';
  document.body.appendChild(el);

  document.getElementById('stDoneBreak').onclick = function () {
    el.remove();
    if (isBreakEnd) {
      _stPhase = 'focus';
      _stSecondsLeft = _stSettings.focus * 60;
      _stLockGames(true);
      _stPlayMusic();
    } else {
      _stCycle++;
      if (_stCycle >= _stSettings.cycles) {
        _stPhase = 'long';
        _stSecondsLeft = _stSettings.longBreak * 60;
        _stCycle = 0;
      } else {
        _stPhase = 'short';
        _stSecondsLeft = _stSettings.shortBreak * 60;
      }
      _stLockGames(false);
      _stStopMusic();
    }
    var m = document.getElementById('stMiniTimer');
    if (m) m.style.display = 'flex';
    _stUpdateMini();
    _stStartTimer();
  };
  document.getElementById('stDoneRestart').onclick = function () {
    el.remove();
    _stPhase = 'focus';
    _stCycle = 0;
    _stSecondsLeft = _stSettings.focus * 60;
    _stLockGames(true);
    if (!(_ytPlayer && _ytPlayerReady)) {
      _stPlayMusic();
    }
    var m = document.getElementById('stMiniTimer');
    if (m) m.style.display = 'flex';
    _stUpdateMini();
    _stStartTimer();
  };
}

function _stNextPhase() {
  clearInterval(_stTimer);
  var wasBreak = _stPhase !== 'focus';
  _stShowDonePopup(wasBreak);
}

function _stStartTimer() {
  clearInterval(_stTimer);
  _stTimer = setInterval(function () {
    _stSecondsLeft--;
    _stUpdateMini();
    if (_stSecondsLeft <= 0) _stNextPhase();
  }, 1000);
}

function _stStop() {
  clearInterval(_stTimer);
  _stRunning = false;
  _stPaused = false;
  _stPhase = 'focus';
  _stCycle = 0;
  _stMusicMuted = false;
  _stStopMusic();
  _stLockGames(false);
  var mini = document.getElementById('stMiniTimer');
  if (mini) mini.style.display = 'none';
  _stUpdatePauseBtn();
}

export function initStudyTimer() {
  document.addEventListener('click', function (e) {
    var btn = document.getElementById('studyTechBtn');
    var overlay = document.getElementById('stOverlay');
    var popup = document.getElementById('stPopup');
    if (!btn || !overlay || !popup) return;

    if (e.target.closest('#studyTechBtn')) {
      overlay.style.display = 'block';
      popup.classList.remove('shrinking');
      popup.style.transform = '';
      popup.style.opacity = '';
      var startBtn = document.getElementById('stStart');
      if (startBtn) startBtn.textContent = _stRunning ? '▶ Apply & Restart' : '▶ Start';
      if (window._ytRenderSelect) window._ytRenderSelect();
      var sel = document.getElementById('stPlaylistSelector');
      if (sel) sel.style.display = _stMusicSrc === 'youtube' ? 'block' : 'none';
      return;
    }

    var srcCard = e.target.closest('.st-music-src');
    if (srcCard) {
      document.querySelectorAll('.st-music-src').forEach(function (c) {
        c.classList.remove('active');
      });
      srcCard.classList.add('active');
      _stMusicSrc = srcCard.dataset.src;
      var hints = {
        lofi: 'Lofi Girl radio — always available',
        youtube: 'Choose a saved playlist below',
        spotify: 'Controls your Spotify playback',
        none: 'No music during session'
      };
      var hint = document.getElementById('stMusicHint');
      if (hint) hint.textContent = hints[_stMusicSrc] || '';
      var sel2 = document.getElementById('stPlaylistSelector');
      if (sel2) {
        sel2.style.display = _stMusicSrc === 'youtube' ? 'block' : 'none';
        if (_stMusicSrc === 'youtube' && window._ytRenderSelect) window._ytRenderSelect();
      }
      if (_stRunning) {
        _stStopMusic();
        if (_stMusicSrc !== 'none' && _stPhase === 'focus') _stPlayMusic();
      }
      return;
    }

    if (
      e.target.closest('#stClose') ||
      (!e.target.closest('#stPopup') && overlay.style.display === 'block')
    ) {
      overlay.style.display = 'none';
      return;
    }

    var card = e.target.closest('.st-tech-card');
    if (card) {
      document.querySelectorAll('.st-tech-card').forEach(function (c) {
        c.classList.remove('active');
      });
      card.classList.add('active');
      _stTech = card.dataset.tech;
      var preset = _stPresets[_stTech];
      if (preset) {
        _stSettings = Object.assign({}, preset);
        var fv = document.getElementById('stFocusVal');
        if (fv) fv.textContent = _stSettings.focus;
        var sv = document.getElementById('stShortVal');
        if (sv) sv.textContent = _stSettings.shortBreak;
        var lv = document.getElementById('stLongVal');
        if (lv) lv.textContent = _stSettings.longBreak;
        var cv = document.getElementById('stCyclesVal');
        if (cv) cv.textContent = _stSettings.cycles;
      }
      return;
    }

    var stepBtn = e.target.closest('.st-step-btn');
    if (stepBtn) {
      var field = stepBtn.dataset.field;
      var dir = parseInt(stepBtn.dataset.dir);
      var minV = { focus: 1, shortBreak: 1, longBreak: 1, cycles: 1 };
      var maxV = { focus: 180, shortBreak: 60, longBreak: 60, cycles: 10 };
      _stSettings[field] = Math.min(
        maxV[field],
        Math.max(minV[field], (_stSettings[field] || 1) + dir)
      );
      var ids = {
        focus: 'stFocusVal',
        shortBreak: 'stShortVal',
        longBreak: 'stLongVal',
        cycles: 'stCyclesVal'
      };
      var el2 = document.getElementById(ids[field]);
      if (el2) el2.textContent = _stSettings[field];
      return;
    }

    if (e.target.closest('#stStart')) {
      clearInterval(_stTimer);
      _stStopMusic();
      _stRunning = true;
      _stPhase = 'focus';
      _stCycle = 0;
      _stSecondsLeft = _stSettings.focus * 60;
      _stMusicMuted = false;
      _stMusicEnabled = _stMusicSrc !== 'none';
      popup.classList.add('shrinking');
      setTimeout(function () {
        overlay.style.display = 'none';
        popup.classList.remove('shrinking');
        var mini = document.getElementById('stMiniTimer');
        if (mini) mini.style.display = 'flex';
        _stUpdateMini();
        _stStartTimer();
        _stLockGames(true);
        if (_stMusicEnabled) _stPlayMusic();
      }, 350);
      return;
    }

    if (e.target.closest('#stMiniPrev')) {
      try {
        if (_ytPlayer) _ytPlayer.previousVideo();
      } catch (e2) {}
      return;
    }
    if (e.target.closest('#stMiniNext')) {
      try {
        if (_ytPlayer) _ytPlayer.nextVideo();
      } catch (e2) {}
      return;
    }
    if (e.target.closest('#stMiniPlayPause')) {
      try {
        if (_ytPlayer) {
          var state = _ytPlayer.getPlayerState();
          if (state === YT.PlayerState.PLAYING) _ytPlayer.pauseVideo();
          else _ytPlayer.playVideo();
        }
      } catch (e2) {}
      return;
    }

    if (e.target.closest('#stMiniPause')) {
      if (!_stRunning) return;
      _stPaused = !_stPaused;
      if (_stPaused) {
        clearInterval(_stTimer);
        try {
          if (_ytPlayer) _ytPlayer.pauseVideo();
        } catch (er) {}
      } else {
        _stStartTimer();
        if (_stMusicEnabled && !_stMusicMuted)
          try {
            if (_ytPlayer) _ytPlayer.playVideo();
          } catch (er) {}
      }
      _stUpdatePauseBtn();
      return;
    }

    if (e.target.closest('#stMiniStop')) {
      _stStop();
      return;
    }
  });

  // Expose running state for panels.js hideStudip check
  Object.defineProperty(window, '_stRunning', {
    get: function () {
      return _stRunning;
    },
    configurable: true
  });
  Object.defineProperty(window, '_stMusicSrc', {
    get: function () {
      return _stMusicSrc;
    },
    configurable: true
  });
  window._stStopMusic = _stStopMusic;
  window._stPlayMusic = _stPlayMusic;
}
