(function () {
  var feature = {
    sectionId: 'psec-settings',
    html: 'views/settings/settings.html',
    css: 'views/settings/settings.css'
  };
  if (window.Minallo) {
    window.Minallo.registerFeature('settings', feature);
  } else {
    window.MinalloFeatures = window.MinalloFeatures || {};
    window.MinalloFeatures.settings = feature;
  }

  var section = document.getElementById('psec-settings');
  if (section) section.dataset.feature = 'settings';
})();

var _autoOpenEnabled = true;
var _saveChatEnabled = true;
window._autoOpenEnabled = _autoOpenEnabled;
window._saveChatEnabled = _saveChatEnabled;

function applyRuntimeSettings(settings) {
  settings = settings || {};
  if (typeof settings.auto_open_ai === 'boolean') {
    _autoOpenEnabled = settings.auto_open_ai;
    window._autoOpenEnabled = _autoOpenEnabled;
    var autoOpen = document.getElementById('settingsAutoOpen');
    if (autoOpen) autoOpen.checked = _autoOpenEnabled;
  }
  if (typeof settings.save_chat_history === 'boolean') {
    _saveChatEnabled = settings.save_chat_history;
    window._saveChatEnabled = _saveChatEnabled;
    var saveChat = document.getElementById('settingsSaveChat');
    if (saveChat) saveChat.checked = _saveChatEnabled;
  }
}
window.addEventListener('ss-settings-applied', function (event) {
  applyRuntimeSettings(event.detail);
});

async function saveSettings(patch) {
  if (!_currentUser) return;
  var data = Object.assign({ id: _currentUser.id, updated_at: new Date().toISOString() }, patch);
  var result = await _sb.from('settings').upsert(data);
  if (result && result.error && Object.prototype.hasOwnProperty.call(data, 'dark_mode')) {
    var fallback = Object.assign({}, data);
    delete fallback.dark_mode;
    result = await _sb.from('settings').upsert(fallback);
  }
  if (result && result.error) console.error('saveSettings error:', result.error);
}

(function bindSettingsControls() {
  function _markDirty() {
    var el = document.getElementById('settingsSaveState');
    if (el) { el.textContent = 'Unsaved changes'; el.className = 'settings-save-state dirty'; }
  }

  var settingsLanguage = document.getElementById('settingsLanguage');
  if (settingsLanguage) {
    settingsLanguage.value = window._lang || localStorage.getItem('ss_lang') || 'en';
    settingsLanguage.addEventListener('change', function () {
      if (typeof window.applyLanguage === 'function') window.applyLanguage(this.value);
      _markDirty();
    });
  }

  if (typeof window.applyLanguage === 'function')
    window.applyLanguage(window._lang || localStorage.getItem('ss_lang') || 'en');

  var dmToggle = document.getElementById('settingsDarkMode');
  if (dmToggle) {
    dmToggle.checked =
      typeof window.nightOn !== 'undefined'
        ? window.nightOn
        : typeof nightOn !== 'undefined'
          ? !!nightOn
          : true;
    dmToggle.addEventListener('change', function () {
      if (typeof window._applyTheme === 'function') window._applyTheme(this.checked, this);
      else if (typeof _applyTheme === 'function') _applyTheme(this.checked, this);
      _markDirty();
    });
    var nightBtn = document.getElementById('nightBtn');
    if (nightBtn) {
      nightBtn.addEventListener('click', function () {
        setTimeout(function () {
          if (dmToggle)
            dmToggle.checked =
              typeof window.nightOn !== 'undefined'
                ? window.nightOn
                : typeof nightOn !== 'undefined'
                  ? !!nightOn
                  : true;
        }, 650);
      });
    }
  }

  var settingsAutoOpen = document.getElementById('settingsAutoOpen');
  if (settingsAutoOpen) {
    if (typeof window._autoOpenEnabled === 'boolean') settingsAutoOpen.checked = window._autoOpenEnabled;
    settingsAutoOpen.addEventListener('change', function () {
      _autoOpenEnabled = this.checked;
      window._autoOpenEnabled = _autoOpenEnabled;
      _markDirty();
    });
  }

  var pdfBody = document.getElementById('pdfBody');
  if (pdfBody) {
    pdfBody.addEventListener('mouseup', function () {
      if (!window._autoOpenEnabled) {
        setTimeout(function () {
          var banner =
            document.getElementById('aiMsgs') &&
            document.getElementById('aiMsgs').querySelector('.ai-sel-banner');
          if (banner) banner.remove();
          var _pinned = window._aiPanelBridge && typeof window._aiPanelBridge.getAiPinned === 'function'
            ? window._aiPanelBridge.getAiPinned() : false;
          if (!_pinned) forceCloseAI();
        }, 50);
      }
    });
  }

  var settingsSaveChat = document.getElementById('settingsSaveChat');
  if (settingsSaveChat) {
    if (typeof window._saveChatEnabled === 'boolean') settingsSaveChat.checked = window._saveChatEnabled;
    settingsSaveChat.addEventListener('change', function () {
      _saveChatEnabled = this.checked;
      window._saveChatEnabled = _saveChatEnabled;
      _markDirty();
    });
  }

  var _origDeferredSave = window.deferredSave;
  window.deferredSave = function () {
    if (window._saveChatEnabled && typeof _origDeferredSave === 'function') _origDeferredSave();
  };

  function _ssUnloadSave() {
    if (typeof window._ssPreUnloadHook === 'function') window._ssPreUnloadHook();
    saveState();
  }
  window.addEventListener('beforeunload', _ssUnloadSave);
  window.addEventListener('pagehide', _ssUnloadSave);

  var dangerBtn = document.getElementById('clearChatHistoryBtn');
  if (dangerBtn) {
    dangerBtn.addEventListener('click', function () {
      if (!confirm('Clear all AI chat history? This cannot be undone.')) return;
      Object.keys(localStorage)
        .filter(function (k) {
          return k.startsWith('ss_chat_');
        })
        .forEach(function (k) {
          localStorage.removeItem(k);
        });
      if (typeof aiMsgs !== 'undefined') aiMsgs.innerHTML = '';
      showToast(_t('toast_chat_cleared'), _t('toast_chat_cleared_sub'));
    });
  }

  var saveSettingsBtn = document.getElementById('saveSettingsBtn');
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async function () {
      var btn = this;
      var stateEl = document.getElementById('settingsSaveState');
      btn.disabled = true;
      if (stateEl) { stateEl.textContent = 'Saving…'; stateEl.className = 'settings-save-state dirty'; }
      var lang =
        (document.getElementById('settingsLanguage') || {}).value ||
        window._lang ||
        localStorage.getItem('ss_lang') ||
        'en';
      var autoOpen = !!(document.getElementById('settingsAutoOpen') || {}).checked;
      var saveChat = !!(document.getElementById('settingsSaveChat') || {}).checked;
      var darkMode = !!(document.getElementById('settingsDarkMode') || {}).checked;
      if (!saveChat) {
        Object.keys(localStorage)
          .filter(function (k) {
            return k.startsWith('ss_chat_');
          })
          .forEach(function (k) {
            localStorage.removeItem(k);
          });
      }
      try {
        await saveSettings({
          language: lang,
          auto_open_ai: autoOpen,
          save_chat_history: saveChat,
          dark_mode: darkMode
        });
        showToast(_t('toast_settings_saved'), _t('toast_settings_saved_sub'));
        if (stateEl) { stateEl.textContent = 'Saved ✓'; stateEl.className = 'settings-save-state saved'; }
        setTimeout(function () {
          btn.disabled = false;
          var el = document.getElementById('settingsSaveState');
          if (el) { el.textContent = ''; el.className = 'settings-save-state'; }
        }, 1500);
      } catch (err) {
        console.error('saveSettings click error:', err);
        btn.disabled = false;
        if (stateEl) { stateEl.textContent = 'Save failed'; stateEl.className = 'settings-save-state error'; }
      }
    });
  }

  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      localStorage.removeItem('sb_token');
      localStorage.removeItem('sb_refresh');
      sessionStorage.removeItem('sb_sess_refresh');
      localStorage.removeItem('ss_user_type');
      sessionStorage.removeItem('sb_sess_token');
      sessionStorage.removeItem('ss_last_active');
      sessionStorage.removeItem('ss_logged_in');
      window._userType = 'enrolled';
      window._germanTest = '';
      window._germanLevel = '';
      _applyUserTypeUI();
      _sbToken = null;
      _currentUser = null;
      var portal = document.getElementById('portal');
      if (portal) {
        portal.classList.remove('show');
        portal.style.display = 'none';
      }
      var ai = document.getElementById('authIndicator');
      if (ai) ai.style.display = 'none';
      if (typeof _setAuthMode === 'function') _setAuthMode('signin');
      var emailEl = document.getElementById('authEmail');
      var pwEl = document.getElementById('authPassword');
      if (emailEl) emailEl.value = '';
      if (pwEl) pwEl.value = '';
      var authModal = document.getElementById('authModal');
      if (authModal) authModal.style.display = 'flex';
      showToast(_t('toast_signed_out'), _t('toast_signed_out_sub'));
    });
  }

  var deleteAccountBtn = document.getElementById('deleteAccountBtn');
  if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener('click', function () {
      var modal = document.createElement('div');
      modal.style.cssText =
        'position:fixed;inset:0;z-index:9999;background:rgba(10,8,18,.88);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center';
      modal.innerHTML =
        '<div style="background:linear-gradient(135deg,#110d20,#0d0f1e);border:1px solid rgba(239,68,68,.3);border-radius:20px;padding:36px 32px;width:380px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;gap:16px;text-align:center">' +
        '<div style="font-size:2rem">!</div>' +
        '<div style="font-family:\'Fredoka One\',cursive;font-size:1.3rem;color:#f87171">Delete your account?</div>' +
        '<div style="font-size:.82rem;color:rgba(255,255,255,.5);font-weight:700;line-height:1.6">This will permanently delete your account and all associated data including notes, settings, and chat history. <strong style="color:rgba(239,68,68,.8)">This cannot be undone.</strong></div>' +
        '<div style="display:flex;gap:10px;margin-top:4px">' +
        '<button id="delAccCancel" style="flex:1;padding:12px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);border-radius:30px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.88rem;color:rgba(255,255,255,.7);cursor:pointer">Cancel</button>' +
        '<button id="delAccConfirm" style="flex:1;padding:12px;background:rgba(239,68,68,.2);border:1px solid rgba(239,68,68,.4);border-radius:30px;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.88rem;color:#f87171;cursor:pointer">Yes, delete</button>' +
        '</div></div>';
      document.body.appendChild(modal);

      document.getElementById('delAccCancel').addEventListener('click', function () {
        document.body.removeChild(modal);
      });

      document.getElementById('delAccConfirm').addEventListener('click', async function () {
        var btn = this;
        btn.textContent = 'Deleting...';
        btn.disabled = true;
        var token = _sbToken || sessionStorage.getItem('sb_sess_token');
        var uid = _currentUser && _currentUser.id;
        var h = {
          apikey: SUPA_KEY,
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        };
        if (uid) {
          var tables = [
            { name: 'lecture_notes', col: 'user_id' },
            { name: 'settings', col: 'id' },
            { name: 'subscriptions', col: 'user_id' },
            { name: 'room_members', col: 'user_id' },
            { name: 'friendships', col: 'user_id' },
            { name: 'friendships', col: 'friend_id' },
            { name: 'profiles', col: 'id' }
          ];
          for (var i = 0; i < tables.length; i++) {
            try {
              await fetch(
                SUPA_URL +
                  '/rest/v1/' +
                  tables[i].name +
                  '?' +
                  tables[i].col +
                  '=eq.' +
                  encodeURIComponent(uid),
                { method: 'DELETE', headers: h }
              );
            } catch (e) {}
          }
        }
        try {
          await fetch('/api/admin-users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ action: 'deleteself', token: token })
          });
        } catch (e) {}
        localStorage.clear();
        sessionStorage.clear();
        document.body.removeChild(modal);
        showToast('Account deleted', 'Your account has been permanently removed.');
        setTimeout(function () {
          window.location.reload();
        }, 1800);
      });
    });
  }
})();
