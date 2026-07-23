import { escapeHtml } from '../../utils/escape-html.js';

interface SupabaseUpsertResult {
  error?: { message?: string } | null;
}

interface SupabaseClient {
  from: (table: string) => {
    upsert: (row: Record<string, unknown>) => Promise<SupabaseUpsertResult>;
  };
}

interface CurrentUser {
  id?: string;
  sub?: string;
}

interface InitMusicServicesOptions {
  sb: SupabaseClient;
  getCurrentUser: () => CurrentUser | null | undefined;
  applyUserTypeUI: () => void;
  showToast?: (title: string, sub?: string) => void;
}

interface YtPlaylist {
  name: string;
  id: string;
}


declare global {
  interface Window {
    _getMusicPlaylistId?: () => string | null;
    _ytRenderSelect?: () => void;
    _ytRenderList?: () => void;
    _stMusicSrc?: string;
    _stStopMusic?: () => void;
    _stPlayMusic?: () => void;
  }
}

export function initMusicServices(options: InitMusicServicesOptions): void {
  const sb = options.sb;
  const getCurrentUser = options.getCurrentUser;
  const applyUserTypeUI = options.applyUserTypeUI;
  const showToast =
    options.showToast ||
    function (title: string, sub?: string): void {
      if (typeof window.showToast === 'function') window.showToast(title, sub);
    };

  let ytPlaylistsCache: YtPlaylist[] | null = null;

  function ytGetPlaylists(): YtPlaylist[] {
    if (ytPlaylistsCache) return ytPlaylistsCache;
    try {
      return JSON.parse(localStorage.getItem('ss_yt_playlists') || '[]') as YtPlaylist[];
    } catch {
      return [];
    }
  }

  async function ytSavePlaylists(arr: YtPlaylist[]): Promise<void> {
    ytPlaylistsCache = arr;
    localStorage.setItem('ss_yt_playlists', JSON.stringify(arr));
    const currentUser = getCurrentUser();
    const uid = currentUser && (currentUser.id || currentUser.sub);
    if (!uid) {
      console.warn('[Playlists] No user id - saved locally only');
      return;
    }
    try {
      const result = await sb
        .from('settings')
        .upsert({ id: uid, yt_playlists: arr, updated_at: new Date().toISOString() });
      if (result && result.error) {
        console.error('[Playlists] DB save error:', JSON.stringify(result.error));
        showToast('Playlist save failed', result.error.message || 'Check console for details');
      }
    } catch (e: unknown) {
      console.error('[Playlists] DB save exception:', e);
      showToast('Playlist save failed', 'Network error - saved locally only');
    }
  }

  let _ytEditingIdx: number | null = null;

  function ytRenderList(): void {
    const list = document.getElementById('ytPlaylistList');
    if (!list) return;
    list.innerHTML = '';
    const playlists = ytGetPlaylists();
    if (playlists.length === 0) {
      list.innerHTML = '<div class="yt-pl-empty">No playlists yet — add one below</div>';
    }
    playlists.forEach((pl, i) => {
      const row = document.createElement('div');
      row.className = 'yt-playlist-row';
      row.dataset['idx'] = String(i);
      if (_ytEditingIdx === i) {
        const url = 'https://www.youtube.com/playlist?list=' + pl.id;
        row.classList.add('yt-pl-editing');
        row.innerHTML =
          '<div class="yt-pl-edit-form">' +
            '<input class="yt-pl-edit-name" type="text" value="' + escapeHtml(pl.name) + '" placeholder="Name" />' +
            '<input class="yt-pl-edit-url" type="text" value="' + escapeHtml(url) + '" placeholder="YouTube playlist URL" />' +
          '</div>' +
          '<div class="yt-pl-actions">' +
            '<button class="yt-pl-btn yt-pl-save" data-idx="' + i + '" title="Save">&#x2713;</button>' +
            '<button class="yt-pl-btn yt-pl-cancel" data-idx="' + i + '" title="Cancel">&#x2715;</button>' +
          '</div>';
      } else {
        row.innerHTML =
          '<div class="yt-pl-info">' +
            '<div class="yt-pl-name">' + escapeHtml(pl.name) + '</div>' +
            '<div class="yt-pl-id">' + escapeHtml(pl.id) + '</div>' +
          '</div>' +
          '<div class="yt-pl-actions">' +
            '<button class="yt-pl-btn yt-pl-edit" data-idx="' + i + '" title="Edit">&#x270E;</button>' +
            '<button class="yt-pl-btn yt-pl-remove" data-idx="' + i + '" title="Remove">&#x2715;</button>' +
          '</div>';
      }
      list.appendChild(row);
    });
    const st = document.getElementById('youtubeStatus');
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

  function ytRenderSelect(): void {
    const sel = document.getElementById('stPlaylistSelect') as HTMLSelectElement | null;
    if (!sel) return;
    const playlists = ytGetPlaylists();
    const prev = sel.value;
    sel.innerHTML = '';
    playlists.forEach((pl) => {
      const opt = document.createElement('option');
      opt.value = pl.id;
      opt.textContent = pl.name;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  }

  function ytExtractId(url: string): string {
    try {
      const u = new URL(url);
      return u.searchParams.get('list') || '';
    } catch {
      return '';
    }
  }

  function ytAdd(): void {
    const nameEl = document.getElementById('ytPlaylistName') as HTMLInputElement | null;
    const urlEl = document.getElementById('ytPlaylistUrl') as HTMLInputElement | null;
    if (!nameEl || !urlEl) return;
    const name = nameEl.value.trim() || 'Playlist';
    const id = ytExtractId(urlEl.value.trim());
    if (!id) {
      showToast('Invalid URL', 'Paste a YouTube playlist URL with ?list=...');
      return;
    }
    const playlists = ytGetPlaylists();
    if (playlists.find((p) => p.id === id)) {
      showToast('Already saved', 'This playlist is already in your list');
      return;
    }
    playlists.unshift({ name: name, id: id });
    void ytSavePlaylists(playlists);
    nameEl.value = '';
    urlEl.value = '';
    ytRenderList();
    showToast('Playlist added', 'Saved: ' + name);
  }

  function ytRemove(idx: number): void {
    const playlists = ytGetPlaylists();
    playlists.splice(idx, 1);
    if (_ytEditingIdx === idx) _ytEditingIdx = null;
    void ytSavePlaylists(playlists);
    ytRenderList();
  }

  function ytStartEdit(idx: number): void {
    _ytEditingIdx = idx;
    ytRenderList();
    const row = document.querySelector('.yt-playlist-row.yt-pl-editing');
    const nameInput = row?.querySelector('.yt-pl-edit-name') as HTMLInputElement | null;
    if (nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  }

  function ytCancelEdit(): void {
    _ytEditingIdx = null;
    ytRenderList();
  }

  function ytSaveEdit(idx: number): void {
    const row = document.querySelector('.yt-playlist-row[data-idx="' + idx + '"]');
    if (!row) return;
    const nameInput = row.querySelector('.yt-pl-edit-name') as HTMLInputElement | null;
    const urlInput = row.querySelector('.yt-pl-edit-url') as HTMLInputElement | null;
    if (!nameInput || !urlInput) return;
    const newName = nameInput.value.trim() || 'Playlist';
    const newId = ytExtractId(urlInput.value.trim());
    if (!newId) {
      showToast('Invalid URL', 'Paste a YouTube playlist URL with ?list=...');
      return;
    }
    const playlists = ytGetPlaylists();
    const dup = playlists.findIndex((p, j) => p.id === newId && j !== idx);
    if (dup !== -1) {
      showToast('Already saved', 'Another entry already uses this playlist');
      return;
    }
    playlists[idx] = { name: newName, id: newId };
    _ytEditingIdx = null;
    void ytSavePlaylists(playlists);
    ytRenderList();
    showToast('Playlist updated', newName);
  }

  window._ytApplyFromDB = function (playlists: unknown): void {
    if (!Array.isArray(playlists)) return;
    const incoming = playlists as YtPlaylist[];
    // Guard against silent data loss. This runs on every login with the DB's
    // copy of the playlist list, overwriting localStorage. If the DB copy is
    // empty — a save that never synced, or another partial settings write that
    // reset this column — applying it would wipe playlists the user still has
    // locally. Never let an empty DB value clobber a populated local list;
    // instead keep local and push it back so the DB self-heals.
    const local = ytGetPlaylists();
    if (incoming.length === 0 && local.length > 0) {
      void ytSavePlaylists(local);
      return;
    }
    ytPlaylistsCache = incoming;
    localStorage.setItem('ss_yt_playlists', JSON.stringify(incoming));
    ytRenderList();
    ytRenderSelect();
  };

  // initMusicServices runs from main.ts via runDelayed (~20s after boot), which
  // is long after loader.ts dispatches 'ss-ready'. Registering only on ss-ready
  // would attach this handler too late and it would never fire — leaving the
  // YouTube add button unwired. So run immediately if boot
  // already finished; otherwise wait for ss-ready (same guard as app.ts).
  const _musicInitOnReady = (): void => {
    const currentUser = getCurrentUser();
    const earlyUid = (currentUser && currentUser.id) || '';
    if (earlyUid) {
      const earlyType = localStorage.getItem('ss_user_type_' + earlyUid);
      if (earlyType) {
        window._userType = earlyType;
        window._germanTest = localStorage.getItem('ss_german_test_' + earlyUid) || '';
        window._germanLevel = localStorage.getItem('ss_german_level_' + earlyUid) || '';
      }
    }
    applyUserTypeUI();

    ytRenderList();

    // Every control below lives in the lazily-injected settings.html, which is
    // normally NOT in the DOM when this init runs (~20s after boot, before the
    // user ever opens Settings). Binding directly with getElementById would
    // silently no-op and the buttons would stay dead — which is exactly why the
    // YouTube "Add playlist" button did nothing. Delegate from document so the
    // handlers fire no matter when the settings view is injected.
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target.closest('#ytSaveBtn')) { ytAdd(); return; }

      // Playlist row actions (rows are rendered into #ytPlaylistList).
      if (target.closest('#ytPlaylistList')) {
        const editBtn = target.closest('.yt-pl-edit') as HTMLElement | null;
        if (editBtn) {
          const idx = editBtn.dataset['idx'];
          if (idx !== undefined) ytStartEdit(parseInt(idx, 10));
          return;
        }
        const saveBtn = target.closest('.yt-pl-save') as HTMLElement | null;
        if (saveBtn) {
          const idx = saveBtn.dataset['idx'];
          if (idx !== undefined) ytSaveEdit(parseInt(idx, 10));
          return;
        }
        if (target.closest('.yt-pl-cancel')) { ytCancelEdit(); return; }
        const removeBtn = target.closest('.yt-pl-remove') as HTMLElement | null;
        if (removeBtn) {
          const idx = removeBtn.dataset['idx'];
          if (idx !== undefined) ytRemove(parseInt(idx, 10));
        }
      }
    });

    // Enter to save / Escape to cancel while editing a playlist row.
    document.addEventListener('keydown', (e) => {
      if (_ytEditingIdx === null) return;
      const target = e.target as HTMLElement | null;
      if (!target || !target.matches('.yt-pl-edit-name, .yt-pl-edit-url')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        ytSaveEdit(_ytEditingIdx);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        ytCancelEdit();
      }
    });
  };
  if (document.body && document.body.getAttribute('data-ss-ready') === '1') {
    _musicInitOnReady();
  } else {
    window.addEventListener('ss-ready', _musicInitOnReady, { once: true });
  }

  window._getMusicPlaylistId = function (): string | null {
    const sel = document.getElementById('stPlaylistSelect') as HTMLSelectElement | null;
    if (sel && sel.value) return sel.value;
    const playlists = ytGetPlaylists();
    return playlists.length && playlists[0] ? playlists[0].id : null;
  };
  window._ytRenderSelect = ytRenderSelect;
  // settings.html is injected lazily; this lets settings.js populate the
  // playlist list the first time the user opens Settings, regardless of whether
  // this module finished loading before or after that HTML appeared.
  window._ytRenderList = ytRenderList;
  document.addEventListener('change', (e) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      target.id === 'stPlaylistSelect' &&
      window._stRunning &&
      window._stMusicSrc === 'youtube'
    ) {
      if (typeof window._stStopMusic === 'function') window._stStopMusic();
      if (typeof window._stPlayMusic === 'function') window._stPlayMusic();
    }
  });
}
