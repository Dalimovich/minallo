export function applySettings(s) {
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
