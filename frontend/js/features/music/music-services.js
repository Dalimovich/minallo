import { escapeHtml } from '../../utils/escape-html.js';

export function initMusicServices(options) {
  var sb = options.sb;
  var getCurrentUser = options.getCurrentUser;
  var applyUserTypeUI = options.applyUserTypeUI;
  var showToast =
    options.showToast ||
    function (title, sub) {
      if (typeof window.showToast === 'function') window.showToast(title, sub);
    };

  var SPOTIFY_CLIENT_ID = '';
  var SPOTIFY_SCOPES =
    'user-read-playback-state user-modify-playback-state user-read-currently-playing';
  var SPOTIFY_REDIRECT = window.location.origin + window.location.pathname;
  var spToken = null;
  var spRefresh = null;
  var spPollTimer = null;
  var ytPlaylistsCache = null;

  function spChallenge(verifier) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(function (buf) {
      return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    });
  }

  function spRandom(len) {
    var arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode.apply(null, arr))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
      .slice(0, len);
  }

  function spConnect() {
    var cid = localStorage.getItem('ss_spotify_cid') || SPOTIFY_CLIENT_ID;
    if (!cid) {
      cid = prompt('Enter your Spotify App Client ID (get one free at developer.spotify.com):');
      if (!cid) return;
      localStorage.setItem('ss_spotify_cid', cid.trim());
    }
    var verifier = spRandom(64);
    localStorage.setItem('ss_sp_verifier', verifier);
    spChallenge(verifier).then(function (challenge) {
      var params = new URLSearchParams({
        response_type: 'code',
        client_id: cid,
        scope: SPOTIFY_SCOPES,
        redirect_uri: SPOTIFY_REDIRECT,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state: 'spotify_pkce'
      });
      window.location.href = 'https://accounts.spotify.com/authorize?' + params.toString();
    });
  }

  function spExchangeCode(code, cid) {
    var verifier = localStorage.getItem('ss_sp_verifier') || '';
    fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: SPOTIFY_REDIRECT,
        client_id: cid,
        code_verifier: verifier
      })
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d.access_token) {
          spToken = d.access_token;
          localStorage.setItem('ss_sp_token', spToken);
          if (d.refresh_token) {
            spRefresh = d.refresh_token;
            localStorage.setItem('ss_sp_refresh', spRefresh);
          }
          localStorage.removeItem('ss_sp_verifier');
          history.replaceState(null, '', window.location.pathname);
          spUpdateUI(true);
          spPollPlayback();
        }
      })
      .catch(function (e) {
        console.error('Spotify token exchange failed', e);
      });
  }

  function spApi(path, method, body) {
    if (!spToken) return Promise.reject('no token');
    return fetch('https://api.spotify.com/v1/' + path, {
      method: method || 'GET',
      headers: { Authorization: 'Bearer ' + spToken, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) {
        spToken = null;
        localStorage.removeItem('ss_sp_token');
        spUpdateUI(false);
        return null;
      }
      if (r.status === 204 || r.status === 202) return null;
      return r.json();
    });
  }

  function spPollPlayback() {
    clearInterval(spPollTimer);
    spPollTimer = setInterval(function () {
      spApi('me/player/currently-playing').then(function (d) {
        if (!d || !d.item) return;
        var name = document.getElementById('spotifyTrackName');
        var artist = document.getElementById('spotifyArtist');
        var thumb = document.getElementById('spotifyThumb');
        var ppBtn = document.getElementById('spotifyPlayPause');
        if (name) name.textContent = d.item.name || '-';
        if (artist) {
          artist.textContent =
            (d.item.artists || [])
              .map(function (a) {
                return a.name;
              })
              .join(', ') || '-';
        }
        if (thumb && d.item.album && d.item.album.images && d.item.album.images[0]) {
          thumb.src = d.item.album.images[0].url;
        }
        if (ppBtn) ppBtn.textContent = d.is_playing ? '⏸' : '▶';
      });
    }, 5000);

    spApi('me/player/currently-playing').then(function (d) {
      if (!d || !d.item) return;
      var name = document.getElementById('spotifyTrackName');
      var artist = document.getElementById('spotifyArtist');
      var thumb = document.getElementById('spotifyThumb');
      if (name) name.textContent = d.item.name || '-';
      if (artist) {
        artist.textContent =
          (d.item.artists || [])
            .map(function (a) {
              return a.name;
            })
            .join(', ') || '-';
      }
      if (thumb && d.item.album && d.item.album.images && d.item.album.images[0]) {
        thumb.src = d.item.album.images[0].url;
      }
    });
  }

  function spUpdateUI(connected) {
    var statusEl = document.getElementById('spotifyStatus');
    var btn = document.getElementById('spotifyConnectBtn');
    var player = document.getElementById('spotifyPlayer');
    if (statusEl) statusEl.textContent = connected ? 'Connected ✓' : 'Not connected';
    if (statusEl) statusEl.className = 'music-service-status' + (connected ? ' connected' : '');
    if (btn) {
      btn.textContent = connected ? 'Reconnect' : 'Connect';
      btn.className = 'music-connect-btn' + (connected ? ' connected' : '');
    }
    if (player) player.style.display = connected ? 'flex' : 'none';
  }

  function spDisconnect() {
    clearInterval(spPollTimer);
    spToken = null;
    spRefresh = null;
    localStorage.removeItem('ss_sp_token');
    localStorage.removeItem('ss_sp_refresh');
    localStorage.removeItem('ss_spotify_cid');
    spUpdateUI(false);
  }

  function ytGetPlaylists() {
    if (ytPlaylistsCache) return ytPlaylistsCache;
    try {
      return JSON.parse(localStorage.getItem('ss_yt_playlists') || '[]');
    } catch (e) {
      return [];
    }
  }

  async function ytSavePlaylists(arr) {
    ytPlaylistsCache = arr;
    localStorage.setItem('ss_yt_playlists', JSON.stringify(arr));
    var currentUser = getCurrentUser();
    var uid = currentUser && (currentUser.id || currentUser.sub);
    if (!uid) {
      console.warn('[Playlists] No user id - saved locally only');
      return;
    }
    try {
      var result = await sb
        .from('settings')
        .upsert({ id: uid, yt_playlists: arr, updated_at: new Date().toISOString() });
      if (result && result.error) {
        console.error('[Playlists] DB save error:', JSON.stringify(result.error));
        showToast('Playlist save failed', result.error.message || 'Check console for details');
      }
    } catch (e) {
      console.error('[Playlists] DB save exception:', e);
      showToast('Playlist save failed', 'Network error - saved locally only');
    }
  }

  function ytRenderList() {
    var list = document.getElementById('youtubePlaylists');
    if (!list) return;
    list.innerHTML = '';
    var playlists = ytGetPlaylists();
    playlists.forEach(function (pl, i) {
      var row = document.createElement('div');
      row.className = 'yt-playlist-row';
      row.innerHTML =
        '<div><div class="yt-pl-name">' +
        escapeHtml(pl.name) +
        '</div>' +
        '<div class="yt-pl-id">' +
        escapeHtml(pl.id.slice(0, 20)) +
        '...</div></div>' +
        '<button class="yt-pl-remove" data-idx="' +
        i +
        '" title="Remove">x</button>';
      list.appendChild(row);
    });
    var st = document.getElementById('youtubeStatus');
    if (st) {
      if (playlists.length) {
        st.textContent =
          playlists.length + ' playlist' + (playlists.length > 1 ? 's' : '') + ' saved';
        st.className = 'music-service-status connected';
      } else {
        st.textContent = 'No playlists saved';
        st.className = 'music-service-status';
      }
    }
    ytRenderSelect();
  }

  function ytRenderSelect() {
    var sel = document.getElementById('stPlaylistSelect');
    if (!sel) return;
    var playlists = ytGetPlaylists();
    var prev = sel.value;
    sel.innerHTML = '';
    playlists.forEach(function (pl) {
      var opt = document.createElement('option');
      opt.value = pl.id;
      opt.textContent = pl.name;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  }

  function ytExtractId(url) {
    try {
      var u = new URL(url);
      return u.searchParams.get('list') || '';
    } catch (e) {
      return '';
    }
  }

  function ytAdd() {
    var nameEl = document.getElementById('ytPlaylistName');
    var urlEl = document.getElementById('ytPlaylistUrl');
    if (!nameEl || !urlEl) return;
    var name = nameEl.value.trim() || 'Playlist';
    var id = ytExtractId(urlEl.value.trim());
    if (!id) {
      showToast('Invalid URL', 'Paste a YouTube playlist URL with ?list=...');
      return;
    }
    var playlists = ytGetPlaylists();
    if (
      playlists.find(function (p) {
        return p.id === id;
      })
    ) {
      showToast('Already saved', 'This playlist is already in your list');
      return;
    }
    playlists.push({ name: name, id: id });
    ytSavePlaylists(playlists);
    nameEl.value = '';
    urlEl.value = '';
    ytRenderList();
    showToast('Playlist added', 'Saved: ' + name);
  }

  function ytRemove(idx) {
    var playlists = ytGetPlaylists();
    playlists.splice(idx, 1);
    ytSavePlaylists(playlists);
    ytRenderList();
  }

  window._ytApplyFromDB = function (playlists) {
    if (!Array.isArray(playlists)) return;
    ytPlaylistsCache = playlists;
    localStorage.setItem('ss_yt_playlists', JSON.stringify(playlists));
    ytRenderList();
    ytRenderSelect();
  };

  window.addEventListener('ss-ready', function () {
    var currentUser = getCurrentUser();
    var earlyUid = (currentUser && currentUser.id) || '';
    if (earlyUid) {
      var earlyType = localStorage.getItem('ss_user_type_' + earlyUid);
      if (earlyType) {
        window._userType = earlyType;
        window._germanTest = localStorage.getItem('ss_german_test_' + earlyUid) || '';
        window._germanLevel = localStorage.getItem('ss_german_level_' + earlyUid) || '';
      }
    }
    applyUserTypeUI();

    var storedToken = localStorage.getItem('ss_sp_token');
    if (storedToken) {
      spToken = storedToken;
      spRefresh = localStorage.getItem('ss_sp_refresh');
      spUpdateUI(true);
      spPollPlayback();
    }

    var params = new URLSearchParams(window.location.search);
    if (params.get('state') === 'spotify_pkce' && params.get('code')) {
      var cid = localStorage.getItem('ss_spotify_cid') || SPOTIFY_CLIENT_ID;
      if (cid) spExchangeCode(params.get('code'), cid);
    }

    ytRenderList();

    var spBtn = document.getElementById('spotifyConnectBtn');
    if (spBtn) spBtn.addEventListener('click', spConnect);
    var spDisc = document.getElementById('spotifyDisconnect');
    if (spDisc) spDisc.addEventListener('click', spDisconnect);
    var spPrev = document.getElementById('spotifyPrev');
    if (spPrev) {
      spPrev.addEventListener('click', function () {
        spApi('me/player/previous', 'POST');
        setTimeout(spPollPlayback, 500);
      });
    }
    var spNext = document.getElementById('spotifyNext');
    if (spNext) {
      spNext.addEventListener('click', function () {
        spApi('me/player/next', 'POST');
        setTimeout(spPollPlayback, 500);
      });
    }
    var spPP = document.getElementById('spotifyPlayPause');
    if (spPP) {
      spPP.addEventListener('click', function () {
        spApi('me/player').then(function (d) {
          if (d && d.is_playing) spApi('me/player/pause', 'PUT');
          else spApi('me/player/play', 'PUT');
          setTimeout(spPollPlayback, 600);
        });
      });
    }
    var ytAddBtn = document.getElementById('ytSaveBtn');
    if (ytAddBtn) ytAddBtn.addEventListener('click', ytAdd);
    var ytList = document.getElementById('ytPlaylistList');
    if (ytList) {
      ytList.addEventListener('click', function (e) {
        var btn = e.target.closest('.yt-pl-remove');
        if (btn) ytRemove(parseInt(btn.dataset.idx, 10));
      });
    }
  });

  window._getMusicPlaylistId = function () {
    var sel = document.getElementById('stPlaylistSelect');
    if (sel && sel.value) return sel.value;
    var playlists = ytGetPlaylists();
    return playlists.length ? playlists[0].id : null;
  };
  window._ytRenderSelect = ytRenderSelect;
  document.addEventListener('change', function (e) {
    if (
      e.target.id === 'stPlaylistSelect' &&
      window._stRunning &&
      window._stMusicSrc === 'youtube'
    ) {
      if (typeof window._stStopMusic === 'function') window._stStopMusic();
      if (typeof window._stPlayMusic === 'function') window._stPlayMusic();
    }
  });
  window._spIsConnected = function () {
    return !!spToken;
  };
  window._spPlayResume = function () {
    spApi('me/player/play', 'PUT').catch(function () {});
    setTimeout(spPollPlayback, 800);
  };
}
