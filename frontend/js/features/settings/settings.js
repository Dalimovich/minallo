export function applySettings(s) {
  s = s || {};
  // Theme: localStorage is the source of truth once the user has used the app
  // on this device. Only honour the DB value on a fresh device where ss_dark
  // has never been written — otherwise a stale row flips the theme on every
  // login and overrides what the user just toggled.
  if (typeof s.dark_mode === 'boolean' && localStorage.getItem('ss_dark') === null) {
    if (typeof window._applyTheme === 'function' && window.nightOn !== s.dark_mode) {
      window._applyTheme(s.dark_mode);
    } else {
      document.body.classList.toggle('night', s.dark_mode);
      localStorage.setItem('ss_dark', s.dark_mode ? '1' : '0');
    }
  }
  var dm = document.getElementById('settingsDarkMode');
  if (dm) dm.checked = window.nightOn;

  if (typeof s.auto_open_ai === 'boolean') {
    var ao = document.getElementById('settingsAutoOpen');
    if (ao) {
      ao.checked = s.auto_open_ai;
      window._autoOpenEnabled = s.auto_open_ai;
    }
  }
  if (typeof s.save_chat_history === 'boolean') {
    var sc = document.getElementById('settingsSaveChat');
    if (sc) {
      sc.checked = s.save_chat_history;
      window._saveChatEnabled = s.save_chat_history;
    }
  }
  if (s.language && typeof window.applyLanguage === 'function') window.applyLanguage(s.language);
  if (s.yt_playlists && typeof window._ytApplyFromDB === 'function')
    window._ytApplyFromDB(s.yt_playlists);
  window.dispatchEvent(new CustomEvent('ss-settings-applied', { detail: s }));
}
