let _stRunning = false;
let _stPaused = false;
let _stVolume = (() => {
    try {
        const v = parseInt(localStorage.getItem('ss_st_volume') || '70', 10);
        return isNaN(v) ? 70 : Math.max(0, Math.min(100, v));
    } catch { return 70; }
})();
let _stMutedByUser = false;
let _stTimer = null;
let _stSecondsLeft = 0;
/* Wall-clock end time (ms since epoch). Source of truth while ticking; nulled
   on pause / stop. Survives tab-throttle (Chrome throttles setInterval to
   ~1/min on hidden tabs, which would cause drift) and full tab close (the
   value is also written to localStorage). */
let _stEndTime = null;
let _stPhase = 'focus';
let _stCycle = 0;
let _stSettings = { focus: 25, shortBreak: 5, longBreak: 15, cycles: 4 };
let _stTech = 'pomodoro';
let _stMusicEnabled = true;
let _stMusicMuted = false;
let _stMusicSrc = 'lofi';
const _ST_STORAGE_KEY = 'ss_focus_timer_v1';
const _stPresets = {
    pomodoro: { focus: 25, shortBreak: 5, longBreak: 15, cycles: 4 },
    5217: { focus: 52, shortBreak: 17, longBreak: 30, cycles: 3 },
    9020: { focus: 90, shortBreak: 20, longBreak: 30, cycles: 2 },
    custom: null,
};
let _ytPlayer = null;
let _ytPlayerReady = false;
let _ytPendingList = null;
let _ytProgressInterval = null;
function _stFmt(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
}
function _stLockGames(lock) {
    const g = document.getElementById('psbGames');
    if (!g)
        return;
    if (lock)
        g.classList.add('st-locked');
    else
        g.classList.remove('st-locked');
}
function _stEnsureYTApi(cb) {
    if (window.YT && window.YT.Player) {
        cb();
        return;
    }
    if (!window._ytCallbacks)
        window._ytCallbacks = [];
    window._ytCallbacks.push(cb);
    if (document.getElementById('ytApiScript'))
        return;
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
        if (prevReady)
            prevReady();
        const cbs = window._ytCallbacks || [];
        window._ytCallbacks = [];
        cbs.forEach((f) => {
            try {
                f();
            }
            catch {
                /* ignore */
            }
        });
    };
    const tag = document.createElement('script');
    tag.id = 'ytApiScript';
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
}
function _stCreatePlayer(customList) {
    const old = document.getElementById('stYTHolder');
    if (old)
        old.remove();
    _ytPlayer = null;
    _ytPlayerReady = false;
    const holder = document.createElement('div');
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
            '<div class="smc-volume-row">' +
            '<button class="smc-vol-btn" id="smcVolBtn" title="Mute / unmute">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
                '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
                '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' +
              '</svg>' +
            '</button>' +
            '<input type="range" id="smcVolume" class="smc-vol-range" min="0" max="100" value="70" step="1" aria-label="Volume">' +
            '</div>' +
            '</div>' +
            '<button class="st-music-pill" id="stMusicPill" title="Show music player" style="display:none">&#x266B;</button>';
    document.body.appendChild(holder);
    if (!document.getElementById('stBarKf')) {
        const s = document.createElement('style');
        s.id = 'stBarKf';
        s.textContent =
            '@keyframes smcIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}' +
                '@keyframes smcOut{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(12px)}}';
        document.head.appendChild(s);
    }
    document.getElementById('smcClose')?.addEventListener('click', () => {
        _stStopMusic();
    });
    document.getElementById('smcMinimise')?.addEventListener('click', () => {
        const card = document.getElementById('stMusicCard');
        const pill = document.getElementById('stMusicPill');
        if (card)
            card.style.display = 'none';
        if (pill)
            pill.style.display = 'flex';
    });
    document.getElementById('stMusicPill')?.addEventListener('click', () => {
        const card = document.getElementById('stMusicCard');
        const pill = document.getElementById('stMusicPill');
        if (pill)
            pill.style.display = 'none';
        if (card)
            card.style.display = 'flex';
    });
    const volRange = document.getElementById('smcVolume');
    const volBtn = document.getElementById('smcVolBtn');
    if (volRange) {
        volRange.value = String(_stVolume);
        _smcSetVolumeFill(_stVolume);
        volRange.addEventListener('input', () => {
            const v = Math.max(0, Math.min(100, parseInt(volRange.value, 10) || 0));
            _stVolume = v;
            _stMutedByUser = v === 0;
            try { localStorage.setItem('ss_st_volume', String(v)); } catch { /* quota */ }
            _smcSetVolumeFill(v);
            _smcSyncVolBtn();
            try { if (_ytPlayer) _ytPlayer.setVolume(v); } catch { /* ignore */ }
        });
    }
    if (volBtn) {
        volBtn.addEventListener('click', () => {
            _stMutedByUser = !_stMutedByUser;
            const target = _stMutedByUser ? 0 : (_stVolume || 70);
            if (!_stMutedByUser && _stVolume === 0) _stVolume = 70;
            try { if (_ytPlayer) _ytPlayer.setVolume(target); } catch { /* ignore */ }
            if (volRange) volRange.value = String(target);
            _smcSetVolumeFill(target);
            _smcSyncVolBtn();
        });
    }
    _smcSyncVolBtn();
    let _smcSeeking = false;
    const progressEl = document.getElementById('smcProgress');
    if (progressEl) {
        progressEl.addEventListener('mousedown', () => {
            _smcSeeking = true;
        });
        progressEl.addEventListener('touchstart', () => {
            _smcSeeking = true;
        }, { passive: true });
        progressEl.addEventListener('change', function () {
            _smcSeeking = false;
            try {
                if (!_ytPlayer)
                    return;
                const dur = _ytPlayer.getDuration();
                if (dur > 0)
                    _ytPlayer.seekTo(dur * (Number(this.value) / 100), true);
            }
            catch {
                /* ignore */
            }
        });
    }
    const playerVars = {
        autoplay: 1,
        controls: 0,
        modestbranding: 1,
        rel: 0,
        fs: 0,
        enablejsapi: 1,
        mute: 1,
        origin: window.location.origin,
    };
    const playerCfg = {
        height: '180',
        width: '320',
        host: 'https://www.youtube-nocookie.com',
        playerVars: playerVars,
    };
    if (customList) {
        playerVars.listType = 'playlist';
        playerVars.list = customList;
    }
    else {
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
                    startSeconds: 0,
                });
                _ytPendingList = null;
            }
            e.target.playVideo();
            setTimeout(() => {
                try {
                    e.target.unMute();
                    e.target.setVolume(_stMutedByUser ? 0 : _stVolume);
                }
                catch {
                    /* ignore */
                }
            }, 1500);
            _stShowMusicControls(true);
            if (_ytProgressInterval)
                clearInterval(_ytProgressInterval);
            _ytProgressInterval = setInterval(() => {
                if (!_ytPlayer || _smcSeeking)
                    return;
                try {
                    const cur = _ytPlayer.getCurrentTime() || 0;
                    const dur = _ytPlayer.getDuration() || 0;
                    const range = document.getElementById('smcProgress');
                    const curEl = document.getElementById('smcCurrent');
                    const durEl = document.getElementById('smcDuration');
                    if (range && dur > 0)
                        range.value = String((cur / dur) * 100);
                    const fmt = (s) => {
                        s = Math.floor(s);
                        return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
                    };
                    if (curEl)
                        curEl.textContent = fmt(cur);
                    if (durEl)
                        durEl.textContent = fmt(dur);
                    if (range && dur > 0)
                        range.style.setProperty('--pct', (cur / dur) * 100 + '%');
                }
                catch {
                    /* ignore */
                }
            }, 1000);
        },
        onStateChange: function (e) {
            const ppBtn = document.getElementById('stMiniPlayPause');
            if (ppBtn)
                ppBtn.innerHTML = e.data === 1 ? '&#x23F8;' : '&#x25B6;';
            if (e.data === 1) {
                try {
                    const vd = e.target.getVideoData();
                    const t = document.getElementById('smcTitle');
                    const a = document.getElementById('smcArtist');
                    if (t && vd.title)
                        t.textContent = vd.title;
                    if (a && vd.author)
                        a.textContent = vd.author;
                }
                catch {
                    /* ignore */
                }
            }
            if (e.data === 0) {
                try {
                    if (customList) {
                        const idx = e.target.getPlaylistIndex();
                        const total = (e.target.getPlaylist() || []).length;
                        if (total > 0 && idx >= total - 1)
                            e.target.playVideoAt(0);
                        else
                            e.target.nextVideo();
                    }
                    else {
                        e.target.playVideo();
                    }
                }
                catch {
                    /* ignore */
                }
            }
        },
        onError: function (e) {
            setTimeout(() => {
                try {
                    e.target.nextVideo();
                }
                catch {
                    /* ignore */
                }
            }, 500);
        },
    };
    _ytPlayer = new YT.Player('stYTDiv', playerCfg);
}
function _stPlayMusic() {
    if (!_stMusicEnabled || _stMusicMuted)
        return;
    if (_stMusicSrc === 'none')
        return;
    if (_stMusicSrc === 'spotify') {
        if (window._spIsConnected && window._spIsConnected()) {
            window.showToast?.('Spotify', 'Resuming your Spotify playback');
            if (window._spPlayResume)
                window._spPlayResume();
        }
        else {
            window.showToast?.('Spotify not connected', 'Connect Spotify in Settings → Music Services');
        }
        return;
    }
    const customList = _stMusicSrc === 'youtube' && window._getMusicPlaylistId ? window._getMusicPlaylistId() : null;
    if (_ytPlayer && _ytPlayerReady) {
        try {
            _ytPlayer.playVideo();
            _ytPlayer.unMute();
            _ytPlayer.setVolume(_stMutedByUser ? 0 : _stVolume);
            _stShowMusicControls(true);
            return;
        }
        catch {
            _stStopMusic();
        }
    }
    if (_ytPlayer && !_ytPlayerReady) {
        _ytPendingList = customList;
        return;
    }
    _ytPendingList = customList;
    _stEnsureYTApi(() => {
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
        }
        catch {
            /* ignore */
        }
        _ytPlayer = null;
        _ytPlayerReady = false;
        _ytPendingList = null;
    }
    const holder = document.getElementById('stYTHolder');
    if (holder)
        holder.remove();
}
function _smcSetVolumeFill(pct) {
    const r = document.getElementById('smcVolume');
    if (r) r.style.setProperty('--vol', Math.max(0, Math.min(100, pct)) + '%');
}
function _smcSyncVolBtn() {
    const btn = document.getElementById('smcVolBtn');
    if (!btn) return;
    btn.classList.toggle('smc-vol-muted', _stMutedByUser || _stVolume === 0);
}
function _stShowMusicControls(show) {
    const holder = document.getElementById('stYTHolder');
    if (!holder)
        return;
    if (show) {
        const pill = document.getElementById('stMusicPill');
        const card = document.getElementById('stMusicCard');
        if (pill && pill.style.display === 'flex') {
            /* already collapsed */
        }
        else if (card) {
            card.style.display = 'flex';
        }
    }
    else {
        const card2 = document.getElementById('stMusicCard');
        const pill2 = document.getElementById('stMusicPill');
        if (card2)
            card2.style.display = 'none';
        if (pill2)
            pill2.style.display = 'none';
    }
}
function _stUpdateMini() {
    const t = document.getElementById('stMiniTime');
    const l = document.getElementById('stMiniLabel');
    if (t)
        t.textContent = _stFmt(_stSecondsLeft);
    if (l)
        l.textContent =
            _stPhase === 'focus' ? 'Focus' : _stPhase === 'short' ? 'Short break' : 'Long break';
    _syncCourseStudyBtn();
}
/** Swap a Study button between "open the popup" and a live
 * Pause / timer / Stop cluster, depending on whether a session is running.
 * Runs for both the course-overview button and the PDF-header button so
 * the two stay in sync with the single global timer state. */
function _syncStudyBtnFor(wrapId, btnId, controlsId) {
    const wrap = document.getElementById(wrapId);
    if (!wrap)
        return;
    const btn = document.getElementById(btnId);
    let controls = document.getElementById(controlsId);
    if (!_stRunning) {
        if (controls)
            controls.remove();
        if (btn) {
            btn.style.display = '';
            btn.classList.remove('co-study-btn-compact', 'pdf-study-button-compact');
        }
        return;
    }
    /* Keep the Study button visible alongside the controls so the user can
     * re-open the Focus Session popup mid-session (e.g. to switch playlist).
     * Compact form: icon-only to save room for the controls cluster. */
    if (btn) {
        btn.style.display = '';
        btn.classList.add(btnId === 'pdfStudyBtn' ? 'pdf-study-button-compact' : 'co-study-btn-compact');
    }
    const timerText = _stFmt(_stSecondsLeft);
    const pauseGlyph = _stPaused ? '&#x25B6;' : '&#x23F8;';
    const pauseTitle = _stPaused ? 'Resume' : 'Pause';
    const pauseBtnId = controlsId + 'Pause';
    const stopBtnId = controlsId + 'Stop';
    if (!controls) {
        controls = document.createElement('div');
        controls.id = controlsId;
        controls.className = 'co-study-controls';
        wrap.appendChild(controls);
        controls.addEventListener('click', (e) => {
            const t = e.target?.closest('button');
            if (!t)
                return;
            e.stopPropagation();
            if (t.id === pauseBtnId) {
                const mini = document.getElementById('stMiniPause');
                if (mini)
                    mini.click();
                else
                    _syncCourseStudyBtn();
            }
            else if (t.id === stopBtnId) {
                _stStop();
            }
        });
    }
    controls.innerHTML =
        '<button id="' + pauseBtnId + '" class="co-study-ctrl" type="button" title="' + pauseTitle + '">' +
            pauseGlyph +
        '</button>' +
        '<span class="co-study-timer">' + timerText + '</span>' +
        '<button id="' + stopBtnId + '" class="co-study-ctrl co-study-ctrl-stop" type="button" title="Stop">' +
            '&#x25A0;' +
        '</button>';
}
function _syncCourseStudyBtn() {
    _syncStudyBtnFor('coStudyWrap', 'coStudyBtn', 'coStudyControls');
    _syncStudyBtnFor('pdfStudyWrap', 'pdfStudyBtn', 'pdfStudyControls');
}
window._syncCourseStudyBtn = _syncCourseStudyBtn;
function _stUpdatePauseBtn() {
    const btn = document.getElementById('stMiniPause');
    if (btn)
        btn.innerHTML = _stPaused ? '&#x25B6;' : '&#x23F8;';
}
function _stShowDonePopup(isBreakEnd) {
    if (_stTimer)
        clearInterval(_stTimer);
    const mini = document.getElementById('stMiniTimer');
    if (mini)
        mini.style.display = 'none';
    const existing = document.getElementById('stDoneOverlay');
    if (existing)
        existing.remove();
    const title = isBreakEnd ? 'Break over — ready to focus again?' : "You've done it! 🎉";
    const sub = isBreakEnd
        ? "Your break has ended. Start another focus session whenever you're ready."
        : 'Great work! Take a ' +
            (_stCycle + 1 >= _stSettings.cycles
                ? _stSettings.longBreak + ' min long break'
                : _stSettings.shortBreak + ' min short break') +
            '. Play some games, stretch, or just relax.';
    const breakLabel = isBreakEnd
        ? 'Start Focus'
        : 'Take a Break (' +
            (_stCycle + 1 >= _stSettings.cycles ? _stSettings.longBreak : _stSettings.shortBreak) +
            ' min)';
    const el = document.createElement('div');
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
    const breakBtn = document.getElementById('stDoneBreak');
    if (breakBtn) {
        breakBtn.onclick = function () {
            el.remove();
            if (isBreakEnd) {
                _stPhase = 'focus';
                _stSecondsLeft = _stSettings.focus * 60;
                _stLockGames(true);
                _stPlayMusic();
            }
            else {
                _stCycle++;
                if (_stCycle >= _stSettings.cycles) {
                    _stPhase = 'long';
                    _stSecondsLeft = _stSettings.longBreak * 60;
                    _stCycle = 0;
                }
                else {
                    _stPhase = 'short';
                    _stSecondsLeft = _stSettings.shortBreak * 60;
                }
                _stLockGames(false);
                _stStopMusic();
            }
            const m = document.getElementById('stMiniTimer');
            if (m)
                m.style.display = 'flex';
            _stUpdateMini();
            _stStartTimer();
        };
    }
    const restartBtn = document.getElementById('stDoneRestart');
    if (restartBtn) {
        restartBtn.onclick = function () {
            el.remove();
            _stPhase = 'focus';
            _stCycle = 0;
            _stSecondsLeft = _stSettings.focus * 60;
            _stLockGames(true);
            if (!(_ytPlayer && _ytPlayerReady)) {
                _stPlayMusic();
            }
            const m = document.getElementById('stMiniTimer');
            if (m)
                m.style.display = 'flex';
            _stUpdateMini();
            _stStartTimer();
        };
    }
}
function _stNextPhase() {
    if (_stTimer)
        clearInterval(_stTimer);
    const wasBreak = _stPhase !== 'focus';
    _stShowDonePopup(wasBreak);
}
/* Wall-clock derived remaining seconds. _stSecondsLeft is the "frozen" view
   used by the UI; _stEndTime is the real source of truth while ticking. */
function _stRemainingFromClock() {
    if (_stEndTime == null)
        return _stSecondsLeft;
    return Math.max(0, Math.ceil((_stEndTime - Date.now()) / 1000));
}
function _stPersist() {
    try {
        if (!_stRunning) {
            localStorage.removeItem(_ST_STORAGE_KEY);
            return;
        }
        const data = {
            v: 1,
            running: _stRunning,
            paused: _stPaused,
            phase: _stPhase,
            cycle: _stCycle,
            settings: _stSettings,
            tech: _stTech,
            musicSrc: _stMusicSrc,
            secondsLeft: _stSecondsLeft,
            endTime: _stEndTime,
        };
        localStorage.setItem(_ST_STORAGE_KEY, JSON.stringify(data));
    }
    catch {
        /* ignore — localStorage may be unavailable in private mode */
    }
}
function _stStartTimer() {
    if (_stTimer)
        clearInterval(_stTimer);
    /* Anchor the wall-clock end time from the current remaining seconds.
       Re-anchored on every (re)start including resume-from-pause. */
    _stEndTime = Date.now() + _stSecondsLeft * 1000;
    _stPersist();
    _stTimer = setInterval(() => {
        _stSecondsLeft = _stRemainingFromClock();
        _stUpdateMini();
        if (_stSecondsLeft <= 0) {
            _stEndTime = null;
            _stPersist();
            _stNextPhase();
        }
    }, 1000);
}
function _stStop() {
    if (_stTimer)
        clearInterval(_stTimer);
    _stRunning = false;
    _stPaused = false;
    _stEndTime = null;
    _stPhase = 'focus';
    _stCycle = 0;
    _stMusicMuted = false;
    _stStopMusic();
    _stLockGames(false);
    const mini = document.getElementById('stMiniTimer');
    if (mini)
        mini.style.display = 'none';
    _stUpdatePauseBtn();
    _stPersist();
    _syncCourseStudyBtn();
}
/* Restore a previously running timer from localStorage. Called once on init.
   If the saved endTime is already in the past, auto-advance to the done
   popup (matches the in-session "phase ended" flow). */
function _stRestore() {
    let raw = null;
    try {
        raw = localStorage.getItem(_ST_STORAGE_KEY);
    }
    catch {
        return;
    }
    if (!raw)
        return;
    let saved;
    try {
        saved = JSON.parse(raw);
    }
    catch {
        return;
    }
    if (!saved || saved.v !== 1 || !saved.running)
        return;
    _stRunning = true;
    _stPaused = saved.paused;
    _stPhase = saved.phase;
    _stCycle = saved.cycle;
    _stSettings = saved.settings;
    _stTech = saved.tech;
    _stMusicSrc = saved.musicSrc;
    _stMusicEnabled = _stMusicSrc !== 'none';
    _stEndTime = saved.endTime;
    _stSecondsLeft = saved.secondsLeft;
    const mini = document.getElementById('stMiniTimer');
    if (mini)
        mini.style.display = 'flex';
    _stLockGames(true);
    if (_stPaused) {
        /* Paused — show frozen value, do not resume ticking. */
        _stUpdateMini();
        _stUpdatePauseBtn();
        return;
    }
    /* Active. Did the phase end while we were away? */
    if (_stEndTime != null && Date.now() >= _stEndTime) {
        _stSecondsLeft = 0;
        _stEndTime = null;
        _stUpdateMini();
        _stNextPhase();
        return;
    }
    /* Still ticking — snap the displayed seconds to the wall-clock value and
       resume the interval (which re-anchors _stEndTime to the same instant). */
    _stSecondsLeft = _stRemainingFromClock();
    _stUpdateMini();
    _stUpdatePauseBtn();
    _stStartTimer();
}
/** Open the Study Techniques popup as a true dropdown anchored to the
 * Study button. The popup is re-parented INTO the .co-study-wrap (which
 * is `position: relative`) so it scrolls with the button automatically,
 * no JS reposition needed. */
export function openStudyPopup() {
    const overlay = document.getElementById('stOverlay');
    const popup = document.getElementById('stPopup');
    if (!popup)
        return;
    if (overlay)
        overlay.style.display = 'none';
    // Prefer the in-PDF Study trigger when the PDF view is open, then the
    // course-workspace wrapper, then the legacy topbar trigger.
    const pdfBtn = document.getElementById('pdfStudyBtn');
    const pdfVisible = !!pdfBtn && pdfBtn.offsetParent !== null;
    const wrap = (pdfVisible ? pdfBtn.parentElement : null) ||
        document.getElementById('coStudyWrap') ||
        document.getElementById('studyTechBtn')?.parentElement;
    if (wrap) {
        if (getComputedStyle(wrap).position === 'static') {
            wrap.style.position = 'relative';
        }
        if (popup.parentElement !== wrap)
            wrap.appendChild(popup);
    }
    popup.classList.remove('shrinking');
    // Position is relative to .co-study-wrap (or fallback parent). Top:100%
    // means just below the button; right:0 aligns to the button's right
    // edge. Scrolling the page scrolls the wrapper → popup follows.
    popup.style.cssText =
        'position:absolute;top:calc(100% + 8px);right:0;left:auto;' +
            'width:340px;max-height:80vh;' +
            'background:#1a1828;border:1px solid rgba(96,165,250,.32);border-radius:20px;' +
            'box-shadow:0 24px 60px rgba(0,0,0,.55);overflow-y:auto;overflow-x:hidden;' +
            'pointer-events:all;color:#e2e8f0;display:block;z-index:2000;';
    // Restart the CSS open animation by clearing and forcing reflow.
    popup.style.animation = 'none';
    void popup.offsetWidth;
    popup.style.animation = '';
    const startBtn = document.getElementById('stStart');
    if (startBtn)
        startBtn.textContent = _stRunning ? '▶ Apply & Restart' : '▶ Start';
    if (window._ytRenderSelect)
        window._ytRenderSelect();
    const sel = document.getElementById('stPlaylistSelector');
    if (sel)
        sel.style.display = _stMusicSrc === 'youtube' ? 'block' : 'none';
}
export function closeStudyPopup() {
    const popup = document.getElementById('stPopup');
    const overlay = document.getElementById('stOverlay');
    if (popup)
        popup.style.display = 'none';
    if (overlay)
        overlay.style.display = 'none';
}
// Publish at module-load time too, not only inside initStudyTimer, so the
// course-view Study button can find it even on very early clicks.
window.openStudyPopup = openStudyPopup;
window.closeStudyPopup = closeStudyPopup;
export function initStudyTimer() {
    window.openStudyPopup = openStudyPopup;
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!target)
            return;
        const btn = document.getElementById('studyTechBtn');
        const overlay = document.getElementById('stOverlay');
        const popup = document.getElementById('stPopup');
        if (!btn || !overlay || !popup)
            return;
        if (target.closest('#studyTechBtn')) {
            openStudyPopup();
            return;
        }
        const srcCard = target.closest('.st-music-src');
        if (srcCard) {
            document.querySelectorAll('.st-music-src').forEach((c) => {
                c.classList.remove('active');
            });
            srcCard.classList.add('active');
            const src = srcCard.dataset['src'];
            if (src === 'lofi' || src === 'youtube' || src === 'spotify' || src === 'none') {
                _stMusicSrc = src;
            }
            const hints = {
                lofi: 'Lofi Girl radio — always available',
                youtube: 'Choose a saved playlist below',
                spotify: 'Controls your Spotify playback',
                none: 'No music during session',
            };
            const hint = document.getElementById('stMusicHint');
            if (hint)
                hint.textContent = hints[_stMusicSrc] || '';
            const sel2 = document.getElementById('stPlaylistSelector');
            if (sel2) {
                sel2.style.display = _stMusicSrc === 'youtube' ? 'block' : 'none';
                if (_stMusicSrc === 'youtube' && window._ytRenderSelect)
                    window._ytRenderSelect();
            }
            if (_stRunning) {
                _stStopMusic();
                if (_stMusicSrc !== 'none' && _stPhase === 'focus')
                    _stPlayMusic();
            }
            return;
        }
        const popupOpen = popup.style.display === 'block';
        if (target.closest('#stClose') ||
            // Outside-click-to-close. Excludes the trigger button itself so the
            // toggle handler can decide what to do.
            (!target.closest('#stPopup') && !target.closest('#coStudyBtn') && !target.closest('#studyTechBtn') && !target.closest('#pdfStudyBtn') && popupOpen)) {
            closeStudyPopup();
            return;
        }
        if (target.closest('#stSaveDefault')) {
            // Persist current settings as the user's default (existing _stPersist
            // already writes everything to localStorage). Show a small toast.
            _stPersist();
            const t = window.showToast;
            if (typeof t === 'function')
                t('Default focus session saved', '');
            return;
        }
        const card = target.closest('.st-tech-card');
        if (card) {
            document.querySelectorAll('.st-tech-card').forEach((c) => {
                c.classList.remove('active');
            });
            card.classList.add('active');
            _stTech = card.dataset['tech'] || _stTech;
            const preset = _stPresets[_stTech];
            if (preset) {
                _stSettings = Object.assign({}, preset);
                const fv = document.getElementById('stFocusVal');
                if (fv)
                    fv.textContent = String(_stSettings.focus);
                const sv = document.getElementById('stShortVal');
                if (sv)
                    sv.textContent = String(_stSettings.shortBreak);
                const lv = document.getElementById('stLongVal');
                if (lv)
                    lv.textContent = String(_stSettings.longBreak);
                const cv = document.getElementById('stCyclesVal');
                if (cv)
                    cv.textContent = String(_stSettings.cycles);
            }
            return;
        }
        const stepBtn = target.closest('.st-step-btn');
        if (stepBtn) {
            const fieldRaw = stepBtn.dataset['field'];
            const dirRaw = stepBtn.dataset['dir'];
            if (!fieldRaw || !dirRaw)
                return;
            const field = fieldRaw;
            const dir = parseInt(dirRaw, 10);
            const minV = {
                focus: 1,
                shortBreak: 1,
                longBreak: 1,
                cycles: 1,
            };
            const maxV = {
                focus: 180,
                shortBreak: 60,
                longBreak: 60,
                cycles: 10,
            };
            _stSettings[field] = Math.min(maxV[field], Math.max(minV[field], (_stSettings[field] || 1) + dir));
            const ids = {
                focus: 'stFocusVal',
                shortBreak: 'stShortVal',
                longBreak: 'stLongVal',
                cycles: 'stCyclesVal',
            };
            const el2 = document.getElementById(ids[field]);
            if (el2)
                el2.textContent = String(_stSettings[field]);
            return;
        }
        if (target.closest('#stStart')) {
            if (_stTimer)
                clearInterval(_stTimer);
            _stStopMusic();
            _stRunning = true;
            _stPhase = 'focus';
            _stCycle = 0;
            _stSecondsLeft = _stSettings.focus * 60;
            _stMusicMuted = false;
            _stMusicEnabled = _stMusicSrc !== 'none';
            popup.classList.add('shrinking');
            setTimeout(() => {
                closeStudyPopup();
                popup.classList.remove('shrinking');
                const mini = document.getElementById('stMiniTimer');
                if (mini)
                    mini.style.display = 'flex';
                _stUpdateMini();
                _stStartTimer();
                _stLockGames(true);
                if (_stMusicEnabled)
                    _stPlayMusic();
            }, 350);
            return;
        }
        if (target.closest('#stMiniPrev')) {
            try {
                if (_ytPlayer)
                    _ytPlayer.previousVideo();
            }
            catch {
                /* ignore */
            }
            return;
        }
        if (target.closest('#stMiniNext')) {
            try {
                if (_ytPlayer)
                    _ytPlayer.nextVideo();
            }
            catch {
                /* ignore */
            }
            return;
        }
        if (target.closest('#stMiniPlayPause')) {
            try {
                if (_ytPlayer) {
                    const state = _ytPlayer.getPlayerState();
                    if (state === YT.PlayerState.PLAYING)
                        _ytPlayer.pauseVideo();
                    else
                        _ytPlayer.playVideo();
                }
            }
            catch {
                /* ignore */
            }
            return;
        }
        if (target.closest('#stMiniPause')) {
            if (!_stRunning)
                return;
            _stPaused = !_stPaused;
            if (_stPaused) {
                if (_stTimer)
                    clearInterval(_stTimer);
                /* Freeze: capture the live wall-clock value and drop the anchor so
                   the resumed interval re-anchors fresh from _stSecondsLeft. */
                _stSecondsLeft = _stRemainingFromClock();
                _stEndTime = null;
                _stPersist();
                try {
                    if (_ytPlayer)
                        _ytPlayer.pauseVideo();
                }
                catch {
                    /* ignore */
                }
            }
            else {
                _stStartTimer();
                if (_stMusicEnabled && !_stMusicMuted) {
                    try {
                        if (_ytPlayer)
                            _ytPlayer.playVideo();
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            _stUpdatePauseBtn();
            return;
        }
        if (target.closest('#stMiniStop')) {
            _stStop();
            return;
        }
    });
    Object.defineProperty(window, '_stRunning', {
        get: () => _stRunning,
        configurable: true,
    });
    Object.defineProperty(window, '_stMusicSrc', {
        get: () => _stMusicSrc,
        configurable: true,
    });
    window._stStopMusic = _stStopMusic;
    window._stPlayMusic = _stPlayMusic;
    /* When the tab becomes visible again, snap the display to the wall-clock
       value — covers both backgrounded throttle (setInterval drifts to ~1/min
       on hidden tabs) and OS sleep. If the phase already ended while away,
       auto-advance. */
    document.addEventListener('visibilitychange', () => {
        if (document.hidden)
            return;
        if (!_stRunning || _stPaused || _stEndTime == null)
            return;
        _stSecondsLeft = _stRemainingFromClock();
        _stUpdateMini();
        if (_stSecondsLeft <= 0) {
            if (_stTimer)
                clearInterval(_stTimer);
            _stEndTime = null;
            _stNextPhase();
        }
    });
    /* Resume a session that was running when the tab was closed/reloaded. */
    _stRestore();
}
//# sourceMappingURL=study-timer.js.map